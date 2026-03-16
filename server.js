/**
 * LabControl Pro — WebSocket Relay Server v2.0
 * - Audio chunk relay (for listen/talk feature)
 * - All message types properly forwarded
 * - Self-ping to prevent Render.com sleep
 * - Deploy on Render.com free tier
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'labcontrol123';
const SELF_URL = process.env.SELF_URL || ''; // e.g. https://hie-z3rp.onrender.com

// ── HTTP server (health check + status) ──────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    service: 'LabControl Pro Relay v2',
    status: 'ok',
    agents: Object.keys(agents).length,
    admins: admins.size,
    uptime: Math.round(process.uptime()),
    audioSessions: audioSessions.size,
  }));
});

const wss = new WebSocket.Server({
  server,
  maxPayload: 25 * 1024 * 1024  // 25MB for screenshots/audio
});

// ── State ─────────────────────────────────────────────────────────────────────
const agents = {};      // agentId → { ws, info }
const admins = new Set();
const audioSessions = new Set();
// Debounce disconnect notifications: if agent reconnects within 2s, suppress the disconnect event
const disconnectTimers = {};
const DISCONNECT_DEBOUNCE_MS = 2000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch (e) {}
  }
}

function broadcastToAdmins(data) {
  const msg = JSON.stringify(data);
  admins.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (e) {}
    }
  });
}

function broadcastToAgents(data, targetIds = null) {
  const msg = JSON.stringify(data);
  const targets = targetIds
    ? targetIds.filter(id => agents[id]).map(id => agents[id].ws)
    : Object.values(agents).map(a => a.ws);
  targets.forEach(ws => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (e) {}
    }
  });
}

// ── Connection handler ────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const remoteIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket.remoteAddress;

  ws.isAlive = true;
  ws.role = null;
  ws.agentId = null;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (e) => { console.error('WS error:', e.message); });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return; // ignore bad JSON
    }

    // ── AUTH ──────────────────────────────────────────────────────────────────
    if (msg.type === 'auth') {
      if (msg.role === 'admin') {
        if (msg.password !== ADMIN_PASSWORD) {
          send(ws, { type: 'auth_error', message: 'Wrong password' });
          ws.close();
          return;
        }
        ws.role = 'admin';
        admins.add(ws);
        send(ws, { type: 'auth_ok', role: 'admin' });

        // Send full agent list
        const agentList = Object.values(agents).map(a => ({ ...a.info }));
        send(ws, { type: 'agent_list', agents: agentList });
        console.log(`[ADMIN] connected from ${remoteIp} (${admins.size} admins)`);

      } else if (msg.role === 'agent') {
        ws.role = 'agent';
        ws.agentId = msg.id || msg.name || `agent_${Date.now()}`;

        // Prevent duplicate IDs
        if (agents[ws.agentId]) {
          try { agents[ws.agentId].ws.terminate(); } catch (e) {}
        }

        agents[ws.agentId] = {
          ws,
          info: {
            id: ws.agentId,
            name: msg.name || ws.agentId,
            user: msg.user || 'Unknown',
            ip: msg.localIp || remoteIp,
            os: msg.os || 'Unknown',
            cpu: 0, ram: 0,
            status: 'online',
            connectedAt: new Date().toISOString(),
          }
        };

        // Cancel any pending disconnect notification for this agent (debounce reconnect)
        if (disconnectTimers[ws.agentId]) {
          clearTimeout(disconnectTimers[ws.agentId]);
          delete disconnectTimers[ws.agentId];
          // Agent reconnected quickly — just send an update, not a full disconnect+connect
          broadcastToAdmins({ type: 'agent_reconnected', ...agents[ws.agentId].info });
        } else {
          broadcastToAdmins({ type: 'agent_connected', ...agents[ws.agentId].info });
        }
        send(ws, { type: 'auth_ok', id: ws.agentId });
        console.log(`[AGENT] ${ws.agentId} (${msg.name}) connected from ${remoteIp}`);
      }
      return;
    }

    // ── ADMIN → AGENTS: forward commands ─────────────────────────────────────
    if (ws.role === 'admin' && msg.type === 'command') {
      const targetIds = msg.targets || Object.keys(agents);
      let delivered = 0;

      targetIds.forEach(id => {
        const agent = agents[id];
        if (agent && agent.ws.readyState === WebSocket.OPEN) {
          send(agent.ws, msg);
          delivered++;
        }
      });

      send(ws, {
        type: 'delivery_report',
        cmd: msg.cmd,
        delivered,
        total: targetIds.length
      });
      return;
    }

    // ── AGENT → ADMINS: forward all agent messages ────────────────────────────
    if (ws.role === 'agent') {
      const id = ws.agentId;

      switch (msg.type) {

        // Screenshot frames
        case 'screenshot':
          broadcastToAdmins({ type: 'screenshot', id, data: msg.data });
          break;

        // CPU/RAM stats
        case 'stats':
          if (agents[id]) {
            agents[id].info.cpu = msg.cpu || 0;
            agents[id].info.ram = msg.ram || 0;
          }
          broadcastToAdmins({ type: 'stats_update', id, cpu: msg.cpu, ram: msg.ram });
          break;

        // Command result
        case 'cmd_result':
          broadcastToAdmins({ type: 'cmd_result', id, ...msg });
          break;

        // Idle state change
        case 'idle':
          if (agents[id]) {
            agents[id].info.status = msg.idle ? 'idle' : 'online';
          }
          broadcastToAdmins({ type: 'idle_update', id, idle: msg.idle });
          break;

        // System info
        case 'sysinfo':
          broadcastToAdmins({ type: 'sysinfo', id, data: msg.data });
          break;

        // Process list
        case 'process_list':
          broadcastToAdmins({ type: 'process_list', id, list: msg.list });
          break;

        // Chat / message reply
        case 'chat_reply':
          broadcastToAdmins({ type: 'chat_reply', id, from: msg.from || agents[id]?.info?.name, text: msg.text });
          break;

        // ── AUDIO: stream PCM chunks from agent to admins ──────────────────
        // This is the key feature: agent sends raw audio, server relays to dashboard
        case 'audio_chunk':
          audioSessions.add(id);
          broadcastToAdmins({ type: 'audio_chunk', id, data: msg.data });
          break;

        // Audio metadata (sample rate, channels, etc.)
        case 'audio_info':
          broadcastToAdmins({ type: 'audio_info', id, ...msg });
          break;

        // Audio error
        case 'audio_error':
          audioSessions.delete(id);
          broadcastToAdmins({ type: 'audio_error', id, error: msg.error });
          break;

        // Agent stopped audio stream
        case 'audio_stopped':
          audioSessions.delete(id);
          broadcastToAdmins({ type: 'audio_stopped', id });
          break;

        default:
          // Forward any unknown message type to admins with agent id
          broadcastToAdmins({ ...msg, id });
          break;
      }
      return;
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  ws.on('close', () => {
    if (ws.role === 'admin') {
      admins.delete(ws);
      console.log(`[ADMIN] disconnected (${admins.size} remain)`);

    } else if (ws.role === 'agent' && ws.agentId) {
      const id = ws.agentId;
      audioSessions.delete(id);
      // Debounce the disconnect — wait 2s before notifying dashboard
      // This prevents rapid connect/disconnect spam when agent reconnects immediately
      disconnectTimers[id] = setTimeout(() => {
        delete disconnectTimers[id];
        // Only fire disconnect if agent hasn't reconnected with a new ws
        if (!agents[id] || agents[id].ws === ws) {
          delete agents[id];
          broadcastToAdmins({ type: 'agent_disconnected', id });
        }
        console.log(`[AGENT] ${id} disconnected (confirmed)`);
      }, DISCONNECT_DEBOUNCE_MS);
      console.log(`[AGENT] ${id} disconnected (debouncing ${DISCONNECT_DEBOUNCE_MS}ms)`);
    }
  });
});

// ── Heartbeat: kill dead connections every 30s ────────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// ── Self-ping to prevent Render.com free tier sleep ───────────────────────────
if (SELF_URL) {
  const https = require('https');
  const urlMod = require('url');
  setInterval(() => {
    try {
      const parsed = urlMod.parse(SELF_URL);
      const lib = parsed.protocol === 'https:' ? https : require('http');
      lib.get(SELF_URL, res => {
        console.log(`[PING] Self-ping ${res.statusCode}`);
      }).on('error', () => {});
    } catch (e) {}
  }, 10 * 60 * 1000); // every 10 minutes
  console.log(`[PING] Self-ping enabled → ${SELF_URL}`);
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`LabControl Pro Relay v2 running on port ${PORT}`);
  console.log(`Password: ${ADMIN_PASSWORD}`);
  console.log(`Max payload: 25MB`);
});
