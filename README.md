# joycall

🚀 **JoyCall** - Real-time Watch Together Sync, Chat History & WebRTC Live Voice Calling Backend for JoyFlix.

Hosted seamlessly on **Render.com** (Free tier ready, 0 bandwidth cost for audio, Discord-like instant low latency).

### Features
- 🎬 **Watch Together Sync**: Synchronize video playback (play/pause/seek) across all room members.
- 🔀 **Episode Sync**: When the Host switches episodes, all members are instantly switched.
- 💬 **Live Chat with History**: Full message history (old messages preserved upon joining).
- 🎙️ **WebRTC Live Voice Calling**: Ultra-low latency (<100ms) peer-to-peer audio mesh with strict room isolation.
- 🔒 **Zero Cross-Room Leak**: Room A and Room B audio and chat channels are strictly separated.

### Deploy on Render.com
1. Connect this GitHub repository (`jehadjoy15-stack/joycall`) to Render as a **Web Service**.
2. **Environment**: `Node`
3. **Build Command**: `npm install`
4. **Start Command**: `node server.js`
5. **Plan**: Free
