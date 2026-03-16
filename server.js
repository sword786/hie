/**
 * LabControl Pro - WebSocket Relay Server v2.0
 * Audio streaming through relay — works from anywhere on internet
 */

const WebSocket = require('ws');
const http = require('http');

const PORT           = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'labcontrol123';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    service: 'LabControl Pro Relay',
    status:  'online',
    agents:  Object.keys(agents).length,
    admins:  admins.size,
    uptime:  Math.floor(process.uptime()),
    time:    new Date().toISOString()
  }));
});

const wss    = new WebSocket.Server({ server, maxPayload: 50 * 1024 * 1024 });
const agents = {};
const admins = new Set();

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch(e) {}
  }
}
function broadcastAdmins(data) {
  admins.forEach(ws => safeSend(ws, data));
}

// For audio: send to the admin who requested it, not all admins
// Track which admin requested audio for which agent
const audioSessions = {}; // agentId → admin ws

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws.isAlive = true;
  ws.role    = null;
  ws.agentId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── AUTH ─────────────────────────────────────────────────────────────────
    if (msg.type === 'auth') {
      if (msg.role === 'admin') {
        if (msg.password !== ADMIN_PASSWORD) {
          safeSend(ws, { type: 'auth_error', message: 'Wrong password' });
          ws.close(1008, 'Auth failed');
          return;
        }
        ws.role = 'admin';
        admins.add(ws);
        safeSend(ws, { type: 'auth_ok', role: 'admin' });
        safeSend(ws, { type: 'agent_list', agents: Object.values(agents).map(a => ({ ...a.info })) });
        console.log(`[ADMIN] connected from ${ip} (${admins.size} total)`);

      } else if (msg.role === 'agent') {
        const id  = msg.id || `agent_${Date.now()}`;
        ws.role    = 'agent';
        ws.agentId = id;
        agents[id] = {
          ws,
          info: {
            id, name: msg.name || id, user: msg.user || 'Unknown',
            ip: msg.localIp || ip, os: msg.os || 'Unknown',
            cpu: 0, ram: 0, status: 'online',
            connectedAt: new Date().toISOString()
          }
        };
        safeSend(ws, { type: 'auth_ok', id });
        broadcastAdmins({ type: 'agent_connected', ...agents[id].info });
        console.log(`[AGENT] ${id} connected from ${ip} — total: ${Object.keys(agents).length}`);
      }
      return;
    }

    // ── PING/PONG ─────────────────────────────────────────────────────────────
    if (msg.type === 'ping') { safeSend(ws, { type: 'pong', ts: Date.now() }); return; }
    if (msg.type === 'pong') { return; }

    // ── ADMIN → AGENT COMMANDS ────────────────────────────────────────────────
    if (ws.role === 'admin' && msg.type === 'command') {
      const targets = (msg.targets && msg.targets.length) ? msg.targets : Object.keys(agents);
      let delivered = 0;
      targets.forEach(id => {
        if (agents[id]) {
          // Track audio session so we know which admin wants audio from which agent
          if (msg.cmd === 'start_audio_stream') {
            audioSessions[id] = ws;
            console.log(`[AUDIO] session started: admin → agent ${id}`);
          }
          if (msg.cmd === 'stop_audio_stream') {
            delete audioSessions[id];
          }
          safeSend(agents[id].ws, { type: 'command', ...msg });
          delivered++;
        }
      });
      safeSend(ws, { type: 'delivery_report', cmd: msg.cmd, delivered, total: targets.length });
      console.log(`[CMD] ${msg.cmd} → ${delivered}/${targets.length}`);
      return;
    }

    // ── ADMIN → AGENT WEBRTC SIGNALING ────────────────────────────────────────
    if (ws.role === 'admin' && (msg.type === 'webrtc_answer' || msg.type === 'webrtc_ice')) {
      const targets = msg.targets || [];
      targets.forEach(id => {
        if (agents[id]) safeSend(agents[id].ws, msg);
      });
      return;
    }

    // ── AGENT → ADMIN MESSAGES ────────────────────────────────────────────────
    if (ws.role === 'agent') {
      const id = ws.agentId;

      switch (msg.type) {
        case 'screenshot':
          broadcastAdmins({ type: 'screenshot', id, data: msg.data });
          break;

        case 'stats':
          if (agents[id]) { agents[id].info.cpu = msg.cpu ?? 0; agents[id].info.ram = msg.ram ?? 0; }
          broadcastAdmins({ type: 'stats_update', id, cpu: msg.cpu, ram: msg.ram });
          break;

        case 'cmd_result':
          broadcastAdmins({ type: 'cmd_result', id, ...msg });
          break;

        case 'idle':
          if (agents[id]) agents[id].info.status = msg.idle ? 'idle' : 'online';
          broadcastAdmins({ type: 'idle_update', id, idle: msg.idle });
          break;

        case 'process_list':
          broadcastAdmins({ type: 'process_list', id, list: msg.list });
          break;

        case 'sysinfo':
          broadcastAdmins({ type: 'sysinfo', id, data: msg.data });
          break;

        case 'chat_reply':
          broadcastAdmins({ type: 'chat_reply', id, from: msg.from, text: msg.text });
          break;

        // ── AUDIO — stream through relay so it works from anywhere ──────────
        // Agent sends audio_chunk with base64 WAV data.
        // Server forwards ONLY to the admin who requested audio for this agent.
        // This avoids flooding all admins with audio data.
        case 'audio_chunk': {
          const adminWs = audioSessions[id];
          if (adminWs && adminWs.readyState === WebSocket.OPEN) {
            safeSend(adminWs, { type: 'audio_chunk', id, data: msg.data });
          }
          break;
        }

        case 'audio_info':
          broadcastAdmins({ type: 'audio_info', id,
            format: msg.format, channels: msg.channels, rate: msg.rate, mode: msg.mode });
          break;

        case 'audio_stream_url':
          broadcastAdmins({ type: 'audio_stream_url', id,
            url: msg.url, ip: msg.ip, port: msg.port, mode: msg.mode });
          break;

        case 'audio_error':
          broadcastAdmins({ type: 'audio_error', id, error: msg.error });
          break;

        // WebRTC signaling
        case 'webrtc_offer':
          broadcastAdmins({ type: 'webrtc_offer', id,
            sdp: msg.sdp, sdp_type: msg.sdp_type, audio_mode: msg.audio_mode });
          break;

        case 'webrtc_ice':
          broadcastAdmins({ type: 'webrtc_ice', id, candidate: msg.candidate });
          break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.role === 'admin') {
      admins.delete(ws);
      // Clean up audio sessions for this admin
      Object.keys(audioSessions).forEach(agentId => {
        if (audioSessions[agentId] === ws) delete audioSessions[agentId];
      });
    } else if (ws.role === 'agent' && ws.agentId) {
      delete agents[ws.agentId];
      delete audioSessions[ws.agentId];
      broadcastAdmins({ type: 'agent_disconnected', id: ws.agentId });
      console.log(`[AGENT] ${ws.agentId} disconnected — total: ${Object.keys(agents).length}`);
    }
  });

  ws.on('error', () => {});
});

// Heartbeat
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

// Self-ping to prevent Render sleep
if (process.env.SELF_URL) {
  setInterval(() => {
    const url = process.env.SELF_URL;
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, res => {
      console.log(`[KEEPALIVE] ping → ${res.statusCode}`);
    }).on('error', () => {});
  }, 10 * 60 * 1000);
}

server.listen(PORT, () => {
  console.log(`LabControl Pro Relay v2.0 on port ${PORT}`);
  console.log(`Password: ${ADMIN_PASSWORD.slice(0,2)}****`);
});
