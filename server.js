/**
 * LabControl Pro - WebSocket Relay Server
 * Deploy FREE on Railway.app (no credit card needed)
 *
 * HOW TO DEPLOY:
 * 1. Go to railway.app → New Project → Deploy from GitHub
 * 2. Upload this file as a repo (or use Railway CLI)
 * 3. Railway will auto-detect Node.js and give you a URL
 * 4. Paste that URL in the dashboard's Server Config
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'labcontrol123';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    service: 'LabControl Pro Relay',
    agents: Object.keys(agents).length,
    admins: admins.size,
    uptime: process.uptime()
  }));
});

const wss = new WebSocket.Server({ server });

const agents = {};   // id → { ws, info }
const admins = new Set();

function broadcastToAdmins(data) {
  const msg = JSON.stringify(data);
  admins.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch(e) {}
  }
}

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  ws.isAlive = true;
  ws.role = null;
  ws.agentId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    // AUTH
    if (msg.type === 'auth') {
      if (msg.role === 'admin') {
        if (msg.password !== ADMIN_PASSWORD) {
          send(ws, { type: 'auth_error', message: 'Wrong password' });
          ws.close();
          return;
        }
        ws.role = 'admin';
        admins.add(ws);
        // Send current agent list
        const agentList = Object.values(agents).map(a => ({ ...a.info }));
        send(ws, { type: 'agent_list', agents: agentList });
        console.log(`[ADMIN] Connected from ${ip}`);

      } else if (msg.role === 'agent') {
        ws.role = 'agent';
        ws.agentId = msg.id || `agent_${Date.now()}`;
        agents[ws.agentId] = {
          ws,
          info: {
            id: ws.agentId,
            name: msg.name || ws.agentId,
            user: msg.user || 'Unknown',
            ip: msg.localIp || ip,
            os: msg.os || 'Unknown',
            cpu: 0,
            ram: 0,
            status: 'online'
          }
        };
        broadcastToAdmins({ type: 'agent_connected', ...agents[ws.agentId].info });
        send(ws, { type: 'auth_ok', id: ws.agentId });
        console.log(`[AGENT] ${ws.agentId} (${msg.name}) connected from ${ip}`);
      }
      return;
    }

    // ADMIN → SERVER: forward command to agents
    if (ws.role === 'admin' && msg.type === 'command') {
      const targets = msg.targets || Object.keys(agents);
      let delivered = 0;
      targets.forEach(id => {
        if (agents[id]) {
          send(agents[id].ws, { type: 'command', cmd: msg.cmd, ...msg });
          delivered++;
        }
      });
      send(ws, { type: 'delivery_report', cmd: msg.cmd, delivered, total: targets.length });
      return;
    }

    // AGENT → SERVER: forward results/events to admins
    if (ws.role === 'agent') {
      switch(msg.type) {
        case 'screenshot':
          broadcastToAdmins({ type: 'screenshot', id: ws.agentId, data: msg.data });
          break;

        case 'stats':
          if (agents[ws.agentId]) {
            agents[ws.agentId].info.cpu = msg.cpu || 0;
            agents[ws.agentId].info.ram = msg.ram || 0;
          }
          broadcastToAdmins({ type: 'stats_update', id: ws.agentId, cpu: msg.cpu, ram: msg.ram });
          break;

        case 'cmd_result':
          broadcastToAdmins({ type: 'cmd_result', id: ws.agentId, ...msg });
          break;

        case 'idle':
          if (agents[ws.agentId]) agents[ws.agentId].info.status = msg.idle ? 'idle' : 'online';
          broadcastToAdmins({ type: 'idle_update', id: ws.agentId, idle: msg.idle });
          break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.role === 'admin') {
      admins.delete(ws);
    } else if (ws.role === 'agent' && ws.agentId) {
      broadcastToAdmins({ type: 'agent_disconnected', id: ws.agentId });
      delete agents[ws.agentId];
      console.log(`[AGENT] ${ws.agentId} disconnected`);
    }
  });

  ws.on('error', (e) => { console.error('WS error:', e.message); });
});

// Heartbeat to detect dead connections
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`LabControl Pro Relay running on port ${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
