const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Basic health check for Render.com to keep service alive
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'JoyCall - JoyFlix Live Sync & WebRTC Voice Service',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeRooms: rooms.size });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 30000,
  pingInterval: 15000
});

// Room Code Generator (e.g. JOY-7294)
function generateRoomCode() {
  const code = Math.floor(1000 + Math.random() * 9000);
  const roomId = `JOY-${code}`;
  if (rooms.has(roomId)) {
    return generateRoomCode();
  }
  return roomId;
}

/**
 * In-Memory Rooms State
 * Map<roomId, {
 *   roomId: string,
 *   hostId: string,
 *   hostName: string,
 *   title: string,
 *   poster: string,
 *   episodeIndex: number,
 *   season: number,
 *   episode: number,
 *   playback: { isPlaying: boolean, position: number, updatedAt: number },
 *   members: Map<socketId, { userId: string, name: string, isHost: boolean, voiceActive: boolean }>,
 *   messages: Array<{ id: string, senderId: string, senderName: string, text: string, timestamp: number }>,
 *   voiceUsers: Set<socketId>
 * }>
 */
const rooms = new Map();
const socketToRoom = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket Connected]: ${socket.id}`);

  // 1. Host creates a Watch Together room
  socket.on('create-room', (payload, callback) => {
    try {
      leaveCurrentRoom(socket);

      const roomId = generateRoomCode();
      const nickname = payload?.nickname?.trim() || 'Host';
      const userId = payload?.userId || socket.id;

      const newRoom = {
        roomId,
        hostId: socket.id,
        hostName: nickname,
        title: payload?.title || 'Unknown Title',
        poster: payload?.poster || '',
        mediaUrl: payload?.mediaUrl || '',
        episodeIndex: typeof payload?.episodeIndex === 'number' ? payload.episodeIndex : 0,
        season: payload?.season || 1,
        episode: payload?.episode || 1,
        playback: {
          isPlaying: !!payload?.isPlaying,
          position: Number(payload?.position) || 0,
          updatedAt: Date.now()
        },
        members: new Map([
          [socket.id, { socketId: socket.id, userId, name: nickname, isHost: true, voiceActive: false }]
        ]),
        messages: [],
        voiceUsers: new Set()
      };

      rooms.set(roomId, newRoom);
      socketToRoom.set(socket.id, roomId);
      socket.join(roomId);

      console.log(`[Room Created]: ${roomId} by ${nickname} (${socket.id})`);

      const response = {
        success: true,
        roomId,
        room: serializeRoom(newRoom)
      };

      if (typeof callback === 'function') callback(response);
      socket.emit('room-created', response);
    } catch (err) {
      console.error('create-room error:', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 2. Member joins an existing room
  socket.on('join-room', (payload, callback) => {
    try {
      const targetRoomId = (payload?.roomId || '').trim().toUpperCase();
      const nickname = payload?.nickname?.trim() || 'Guest';
      const userId = payload?.userId || socket.id;

      if (!rooms.has(targetRoomId)) {
        const errResp = { success: false, error: 'Room not found. Check the room code!' };
        if (typeof callback === 'function') callback(errResp);
        return socket.emit('join-error', errResp);
      }

      leaveCurrentRoom(socket);

      const room = rooms.get(targetRoomId);
      socket.join(targetRoomId);
      socketToRoom.set(socket.id, targetRoomId);

      room.members.set(socket.id, {
        socketId: socket.id,
        userId,
        name: nickname,
        isHost: false,
        voiceActive: false
      });

      console.log(`[Room Joined]: ${nickname} (${socket.id}) joined ${targetRoomId}`);

      const serialized = serializeRoom(room);
      const resp = { success: true, roomId: targetRoomId, room: serialized };

      if (typeof callback === 'function') callback(resp);
      socket.emit('room-joined', resp);

      // Notify others in the room
      socket.to(targetRoomId).emit('member-joined', {
        member: { socketId: socket.id, userId, name: nickname, isHost: false, voiceActive: false },
        members: serialized.members
      });
    } catch (err) {
      console.error('join-room error:', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 3. Playback Synchronization (Play/Pause & Seek)
  socket.on('sync-playback', ({ isPlaying, position }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.playback.isPlaying = !!isPlaying;
    room.playback.position = Number(position) || 0;
    room.playback.updatedAt = Date.now();

    // Broadcast sync to other members in the room
    socket.to(roomId).emit('sync-playback', {
      isPlaying: room.playback.isPlaying,
      position: room.playback.position,
      updatedAt: room.playback.updatedAt,
      senderId: socket.id
    });
  });

  // 4. Host Changes Episode
  socket.on('change-episode', ({ episodeIndex, season, episode, title }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    // Verify host
    if (socket.id !== room.hostId) {
      return socket.emit('error-notice', { message: 'Only host can change episodes!' });
    }

    room.episodeIndex = episodeIndex;
    if (season !== undefined) room.season = season;
    if (episode !== undefined) room.episode = episode;
    if (title) room.title = title;
    room.playback.isPlaying = false;
    room.playback.position = 0;
    room.playback.updatedAt = Date.now();

    console.log(`[Episode Changed]: ${roomId} -> Episode index ${episodeIndex}`);

    // Broadcast episode switch to everyone in the room
    io.to(roomId).emit('episode-changed', {
      episodeIndex,
      season: room.season,
      episode: room.episode,
      title: room.title
    });
  });

  // 5. Send Chat Message & Save to History
  socket.on('send-message', (payload) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const member = room.members.get(socket.id);

    const message = {
      id: payload?.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      senderId: member?.userId || socket.id,
      senderSocketId: socket.id,
      senderName: member?.name || payload?.senderName || 'User',
      text: (payload?.text || '').trim(),
      timestamp: Date.now()
    };

    if (!message.text) return;

    // Keep up to 100 recent messages in memory
    room.messages.push(message);
    if (room.messages.length > 100) {
      room.messages.shift();
    }

    // Broadcast new message to everyone in the room
    io.to(roomId).emit('new-message', message);
  });

  // 6. Request Chat History
  socket.on('get-chat-history', (callback) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId || !rooms.has(roomId)) {
      if (typeof callback === 'function') callback([]);
      return;
    }
    const room = rooms.get(roomId);
    if (typeof callback === 'function') {
      callback(room.messages);
    } else {
      socket.emit('chat-history', room.messages);
    }
  });

  // ========================================================
  // WEBRTC LIVE VOICE CALL SIGNALING (DISCORD-STYLE)
  // ========================================================

  // User toggles Live Voice Call ON
  socket.on('voice-join', () => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.voiceUsers.add(socket.id);
    const member = room.members.get(socket.id);
    if (member) member.voiceActive = true;

    console.log(`[Voice Joined]: ${member?.name || socket.id} in ${roomId}`);

    // Return other active voice callers in this room to the joining user
    const existingVoiceUsers = Array.from(room.voiceUsers).filter(id => id !== socket.id);
    socket.emit('voice-peers', existingVoiceUsers);

    // Notify other voice users that a new peer joined
    socket.to(roomId).emit('voice-user-joined', { socketId: socket.id, name: member?.name || 'User' });
    io.to(roomId).emit('members-updated', Array.from(room.members.values()));
  });

  // WebRTC Offer
  socket.on('voice-offer', ({ target, sdp }) => {
    const roomId = socketToRoom.get(socket.id);
    const targetRoom = socketToRoom.get(target);

    // Strict Room Isolation Check
    if (roomId && roomId === targetRoom) {
      io.to(target).emit('voice-offer', { callerId: socket.id, sdp });
    }
  });

  // WebRTC Answer
  socket.on('voice-answer', ({ target, sdp }) => {
    const roomId = socketToRoom.get(socket.id);
    const targetRoom = socketToRoom.get(target);

    if (roomId && roomId === targetRoom) {
      io.to(target).emit('voice-answer', { responderId: socket.id, sdp });
    }
  });

  // ICE Candidate exchange
  socket.on('voice-ice', ({ target, candidate }) => {
    const roomId = socketToRoom.get(socket.id);
    const targetRoom = socketToRoom.get(target);

    if (roomId && roomId === targetRoom) {
      io.to(target).emit('voice-ice', { from: socket.id, candidate });
    }
  });

  // User turns Voice Call OFF
  socket.on('voice-leave', () => {
    handleVoiceLeave(socket);
  });

  // Disconnect or Leave Room
  const handleExit = () => {
    handleVoiceLeave(socket);
    leaveCurrentRoom(socket);
  };

  socket.on('leave-room', handleExit);
  socket.on('disconnect', handleExit);
});

function handleVoiceLeave(socket) {
  const roomId = socketToRoom.get(socket.id);
  if (!roomId || !rooms.has(roomId)) return;

  const room = rooms.get(roomId);
  if (room.voiceUsers.has(socket.id)) {
    room.voiceUsers.delete(socket.id);
    const member = room.members.get(socket.id);
    if (member) member.voiceActive = false;

    socket.to(roomId).emit('voice-user-left', socket.id);
    io.to(roomId).emit('members-updated', Array.from(room.members.values()));
    console.log(`[Voice Left]: ${socket.id} from ${roomId}`);
  }
}

function leaveCurrentRoom(socket) {
  const roomId = socketToRoom.get(socket.id);
  if (!roomId) return;

  socket.leave(roomId);
  socketToRoom.delete(socket.id);

  if (rooms.has(roomId)) {
    const room = rooms.get(roomId);
    room.members.delete(socket.id);

    // If host leaves, reassign host if members remain
    if (socket.id === room.hostId && room.members.size > 0) {
      const nextHostSocketId = room.members.keys().next().value;
      const nextHost = room.members.get(nextHostSocketId);
      room.hostId = nextHostSocketId;
      room.hostName = nextHost.name;
      nextHost.isHost = true;
      io.to(roomId).emit('host-transferred', { newHostId: nextHostSocketId, newHostName: nextHost.name });
    }

    socket.to(roomId).emit('member-left', socket.id);
    io.to(roomId).emit('members-updated', Array.from(room.members.values()));

    if (room.members.size === 0) {
      rooms.delete(roomId);
      console.log(`[Room Deleted]: ${roomId} (no active members)`);
    }
  }
}

function serializeRoom(room) {
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    hostName: room.hostName,
    title: room.title,
    poster: room.poster,
    episodeIndex: room.episodeIndex,
    season: room.season,
    episode: room.episode,
    playback: room.playback,
    members: Array.from(room.members.values()),
    messages: room.messages,
    voiceUsers: Array.from(room.voiceUsers)
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 JoyCall Server running on port ${PORT}`);
});
