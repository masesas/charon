// Charon dashboard — minimal node:http server. Server-rendered shell + JSON API.
// Binds 127.0.0.1 by default; exposure is via Cloudflare Tunnel / reverse proxy.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

import { DASHBOARD_PORT, DASHBOARD_HOST, validateDashboardConfig } from './config.js';
import { closeDb, ensureDashboardCommands } from './db.js';
import { isAuthed, tokenMatches, loginCookie, logoutCookie, rateLimited, recordFailure } from './auth.js';
import { shell, loginPage } from './views/layout.js';

import { getOverview } from './queries/overview.js';
import { listPositions, getPosition } from './queries/positions.js';
import { getFunnel, listDecisions } from './queries/funnel.js';
import { getSignalVolume, getSourcePerformance } from './queries/signals.js';
import { getLearning } from './queries/learning.js';
import { toggleAgent, setActiveStrategy, enqueueForceClose, getCommand } from './actions/controls.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

validateDashboardConfig();
ensureDashboardCommands();

const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json' });
}
const ok = (res, data, meta) => sendJson(res, 200, { success: true, data, ...(meta ? { meta } : {}) });
const fail = (res, status, error) => sendJson(res, status, { success: false, error });

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(); // 1MB cap
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

async function serveStatic(res, pathname) {
  const safe = pathname.replace(/\.\.+/g, '').replace(/^\/+/, '');
  try {
    const buf = await readFile(join(PUBLIC_DIR, safe));
    send(res, 200, buf, { 'Content-Type': MIME[extname(safe)] || 'application/octet-stream' });
  } catch {
    fail(res, 404, 'not found');
  }
}

async function handleApi(req, res, url) {
  const p = url.pathname.slice('/api'.length);
  const method = req.method;

  // ── reads ──
  if (method === 'GET' && p === '/overview') return ok(res, getOverview());
  if (method === 'GET' && p === '/positions') {
    const status = url.searchParams.get('status') || 'open';
    const limit = url.searchParams.get('limit');
    const offset = url.searchParams.get('offset') || 0;
    const r = listPositions({ status, limit, offset });
    return ok(res, { rows: r.rows }, { total: r.total });
  }
  if (method === 'GET' && /^\/positions\/\d+$/.test(p)) {
    const id = Number(p.split('/')[2]);
    const pos = getPosition(id);
    return pos ? ok(res, pos) : fail(res, 404, 'position not found');
  }
  if (method === 'GET' && p === '/funnel') return ok(res, getFunnel(url.searchParams.get('window') || '24h'));
  if (method === 'GET' && p === '/decisions') {
    const r = listDecisions({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') || 0 });
    return ok(res, { rows: r.rows }, { total: r.total });
  }
  if (method === 'GET' && p === '/signals') return ok(res, getSignalVolume(url.searchParams.get('window') || '24h'));
  if (method === 'GET' && p === '/sources') return ok(res, getSourcePerformance());
  if (method === 'GET' && p === '/learning') return ok(res, getLearning());
  if (method === 'GET' && /^\/commands\/\d+$/.test(p)) {
    const c = getCommand(Number(p.split('/')[2]));
    return c ? ok(res, c) : fail(res, 404, 'command not found');
  }

  // ── writes ──
  if (method === 'POST' && p === '/agent/toggle') {
    const body = JSON.parse((await readBody(req)) || '{}');
    return ok(res, toggleAgent(Boolean(body.enabled)));
  }
  if (method === 'POST' && p === '/strategy/active') {
    const body = JSON.parse((await readBody(req)) || '{}');
    try { return ok(res, setActiveStrategy(body.id)); } catch (e) { return fail(res, 400, e.message); }
  }
  if (method === 'POST' && /^\/positions\/\d+\/close$/.test(p)) {
    const id = Number(p.split('/')[2]);
    try { return sendJson(res, 202, { success: true, data: enqueueForceClose(id) }); }
    catch (e) { return fail(res, 400, e.message); }
  }

  return fail(res, 404, 'unknown endpoint');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    // Public routes
    if (pathname === '/login' && req.method === 'GET') return send(res, 200, loginPage(), { 'Content-Type': 'text/html' });
    if (pathname === '/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (rateLimited(ip)) return send(res, 429, loginPage('Too many attempts. Wait a minute.'), { 'Content-Type': 'text/html' });
      const body = await readBody(req);
      const token = new URLSearchParams(body).get('token') || '';
      if (tokenMatches(token)) {
        return send(res, 302, '', { 'Set-Cookie': loginCookie(token), Location: '/' });
      }
      recordFailure(ip);
      return send(res, 401, loginPage('Invalid token.'), { 'Content-Type': 'text/html' });
    }
    if (pathname === '/logout') return send(res, 302, '', { 'Set-Cookie': logoutCookie(), Location: '/login' });
    if (pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    // Static assets are public (no secrets in them)
    if (pathname === '/app.css' || pathname === '/app.js') return serveStatic(res, pathname);

    // Everything else requires auth
    if (!isAuthed(req)) {
      if (pathname.startsWith('/api')) return fail(res, 401, 'unauthorized');
      return send(res, 302, '', { Location: '/login' });
    }

    if (pathname.startsWith('/api')) return handleApi(req, res, url);
    if (pathname === '/') return send(res, 200, shell(), { 'Content-Type': 'text/html' });
    return fail(res, 404, 'not found');
  } catch (err) {
    console.error('[dashboard] request error:', err.message);
    if (!res.headersSent) fail(res, 500, 'internal error');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[dashboard] port ${DASHBOARD_PORT} already in use`);
  else console.error('[dashboard] server error:', err.message);
  process.exit(1);
});

server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
  console.log(`[dashboard] listening on http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
});

function shutdown() {
  console.log('[dashboard] shutting down…');
  server.close(() => { closeDb(); process.exit(0); });
  setTimeout(() => { closeDb(); process.exit(0); }, 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
