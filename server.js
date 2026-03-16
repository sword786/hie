/**
 * LabControl Pro - WebSocket Relay Server v1.1
 *
 * ══════════════════════════════════════════════════════
 *  FREE HOSTING OPTIONS (pick any):
 * ══════════════════════════════════════════════════════
 *
 *  🥇 KOYEB (BEST - always free, no sleep, no card)
 *     1. koyeb.com → Sign up free (email only)
 *     2. New App → GitHub → select repo with this file
 *     3. Set env var: ADMIN_PASSWORD=yourpassword
 *     4. Deploy → get URL like: your-app.koyeb.app
 *     5. Use: wss://your-app.koyeb.app in dashboard
 *
 *  🥈 RENDER (free, sleeps 15min - agents auto-reconnect OK)
 *     1. render.com → New → Web Service → connect GitHub
 *     2. Build cmd: npm install  |  Start: node server.js
 *     3. Set env vars: ADMIN_PASSWORD + SELF_URL (your render URL)
 *     4. Deploy → URL like: your-app.onrender.com
 *
 *  🥉 FLY.IO (free allowance, needs fly CLI)
 *     fly launch && fly deploy
 *
 * ══════════════════════════════════════════════════════
 *  GitHub repo needs only: server.js + package.json
 * ══════════════════════════════════════════════════════
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'labcontrol123';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    service: 'LabControl Pro Relay',
    status: 'online',
    agents: Object.keys(agents).length,
    admins: admins.size,
    uptime: Math.floor(process.uptime()),
    time: new Date().toISOString()
  }));
});

const wss = new WebSocket.Server({ server });
const agents = {};
const admins = new Set();

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch(e) {}
  }
}

function broadcastAdmins(data) {
  admins.forEach(ws => safeSend(ws, data));
}

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws.isAlive = true;
  ws.role = null;
  ws.agentId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

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
        const id = msg.id || `agent_${Date.now()}`;
        ws.role = 'agent';
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
        console.log(`[AGENT] ${id} (${msg.name}) from ${ip} — total: ${Object.keys(agents).length}`);
      }
      return;
    }

    // Ping/pong — keeps dashboard alive through Render's silent timeouts
    if (msg.type === 'ping') {
      safeSend(ws, { type: 'pong', ts: Date.now() });
      return;
    }
    if (msg.type === 'pong') { return; }

    if (ws.role === 'admin' && msg.type === 'command') {
      const targets = (msg.targets && msg.targets.length) ? msg.targets : Object.keys(agents);
      let delivered = 0;
      targets.forEach(id => {
        if (agents[id]) { safeSend(agents[id].ws, { type: 'command', ...msg }); delivered++; }
      });
      safeSend(ws, { type: 'delivery_report', cmd: msg.cmd, delivered, total: targets.length });
      console.log(`[CMD] ${msg.cmd} → ${delivered}/${targets.length}`);
      return;
    }

    if (ws.role === 'agent') {
      switch (msg.type) {
        case 'screenshot':
          broadcastAdmins({ type: 'screenshot', id: ws.agentId, data: msg.data });
          break;
        case 'stats':
          if (agents[ws.agentId]) {
            agents[ws.agentId].info.cpu = msg.cpu ?? 0;
            agents[ws.agentId].info.ram = msg.ram ?? 0;
          }
          broadcastAdmins({ type: 'stats_update', id: ws.agentId, cpu: msg.cpu, ram: msg.ram });
          break;
        case 'cmd_result':
          broadcastAdmins({ type: 'cmd_result', id: ws.agentId, ...msg });
          break;
        case 'idle':
          if (agents[ws.agentId]) agents[ws.agentId].info.status = msg.idle ? 'idle' : 'online';
          broadcastAdmins({ type: 'idle_update', id: ws.agentId, idle: msg.idle });
          break;
        case 'process_list':
          broadcastAdmins({ type: 'process_list', id: ws.agentId, list: msg.list });
          break;
        case 'sysinfo':
          broadcastAdmins({ type: 'sysinfo', id: ws.agentId, data: msg.data });
          break;
        case 'chat_reply':
          broadcastAdmins({ type: 'chat_reply', id: ws.agentId, from: msg.from, text: msg.text });
          break;
        // Audio streaming — forward URL to requesting admin
        case 'audio_stream_url':
          broadcastAdmins({ type: 'audio_stream_url', id: ws.agentId,
            url: msg.url, ip: msg.ip, port: msg.port, mode: msg.mode });
          break;
        case 'audio_info':
          broadcastAdmins({ type: 'audio_info', id: ws.agentId,
            format: msg.format, channels: msg.channels, rate: msg.rate, mode: msg.mode });
          break;
        case 'audio_chunk':
          broadcastAdmins({ type: 'audio_chunk', id: ws.agentId, data: msg.data });
          break;
        case 'audio_error':
          broadcastAdmins({ type: 'audio_error', id: ws.agentId, error: msg.error });
          break;
        // WebRTC signaling
        case 'webrtc_offer':
          broadcastAdmins({ type: 'webrtc_offer', id: ws.agentId,
            sdp: msg.sdp, sdp_type: msg.sdp_type, audio_mode: msg.audio_mode });
          break;
        case 'webrtc_ice':
          broadcastAdmins({ type: 'webrtc_ice', id: ws.agentId, candidate: msg.candidate });
          break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.role === 'admin') {
      admins.delete(ws);
    } else if (ws.role === 'agent' && ws.agentId) {
      delete agents[ws.agentId];
      broadcastAdmins({ type: 'agent_disconnected', id: ws.agentId });
      console.log(`[AGENT] ${ws.agentId} disconnected — total: ${Object.keys(agents).length}`);
    }
  });

  ws.on('error', () => {});
});

// Heartbeat to kill dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

// Self-ping to prevent Render free tier from sleeping
// Set env var SELF_URL=https://your-app.onrender.com to enable
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
  console.log(`LabControl Pro Relay v1.1 running on port ${PORT}`);
  console.log(`Password hint: ${ADMIN_PASSWORD.slice(0,2)}****`);
  console.log(`Agents: 0 | Admins: 0`);
});
