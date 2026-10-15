'use strict';
// Cliente de la API pública de VPN Gate (https://www.vpngate.net/api/iphone/).
// Formato: '*vpn_servers', cabecera '#HostName,IP,...', filas CSV y '*' final.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { sanitize } = require('./ovpn-sanitize');

const API_URLS = ['https://www.vpngate.net/api/iphone/', 'http://www.vpngate.net/api/iphone/'];
const CACHE_TTL_MS = 10 * 60 * 1000;

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function remoteOf(config) {
  let proto = 'tcp';
  let port = 443;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('proto ')) proto = line.split(/\s+/)[1].slice(0, 3);
    else if (line.startsWith('remote ')) {
      const p = line.split(/\s+/);
      if (p[2] && /^\d+$/.test(p[2])) port = Number(p[2]);
    }
  }
  return { port, proto };
}

function parse(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('*'));
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0].replace(/^#/, ''));
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const need = ['HostName', 'IP', 'Score', 'Ping', 'Speed', 'CountryShort', 'OpenVPN_ConfigData_Base64'];
  if (need.some((n) => !(n in col))) return [];
  const servers = [];
  let rejected = 0;
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const b64 = f[col.OpenVPN_ConfigData_Base64];
    const score = Number(f[col.Score]);
    if (!b64 || !Number.isFinite(score) || !f[col.CountryShort]) continue;
    const safe = sanitize(Buffer.from(b64, 'base64').toString('utf8'));
    if (!safe.ok) { rejected++; continue; } // config con directivas de ejecución: servidor descartado
    const config = safe.config;
    const { port, proto } = remoteOf(config);
    servers.push({
      host: f[col.HostName],
      ip: f[col.IP],
      score,
      ping: Number(f[col.Ping]) || 0,
      mbps: (Number(f[col.Speed]) || 0) / 1e6,
      country: f[col.CountryLong],
      cc: f[col.CountryShort].toUpperCase(),
      sessions: Number(f[col.NumVpnSessions]) || 0,
      uptimeDays: (Number(f[col.Uptime]) || 0) / 86400000,
      logs: f[col.LogType] || '',
      operator: f[col.Operator] || '',
      port,
      proto,
      config,
      needsAuth: safe.needsAuth,
    });
  }
  servers.rejected = rejected;
  return servers;
}

async function download(urls = API_URLS, fetchImpl = fetch) {
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'FreeVPN/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`No se pudo contactar con VPN Gate (${lastErr && lastErr.message})`);
}

/** Devuelve { servers, fetchedAt, stale }. Usa caché en disco; si no hay red usa la caché aunque esté vieja. */
async function loadServers({ cacheDir, refresh = false, urls, fetchImpl, now = Date.now() } = {}) {
  const file = cacheDir && path.join(cacheDir, 'vpngate.csv');
  const cached = () => {
    try {
      const st = fs.statSync(file);
      return { text: fs.readFileSync(file, 'utf8'), at: st.mtimeMs };
    } catch { return null; }
  };
  const c = file && cached();
  if (c && !refresh && now - c.at < CACHE_TTL_MS) return { servers: parse(c.text), fetchedAt: c.at, stale: false };
  try {
    const text = await download(urls, fetchImpl);
    const servers = parse(text);
    if (!servers.length) throw new Error('La respuesta de VPN Gate no contiene servidores');
    if (file) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, text); }
    return { servers, fetchedAt: now, stale: false };
  } catch (e) {
    if (c) return { servers: parse(c.text), fetchedAt: c.at, stale: true, warning: e.message };
    throw e;
  }
}

/** Resumen por país para pintar el mapa y la lista. */
function summarize(servers) {
  const by = new Map();
  for (const s of servers) {
    const e = by.get(s.cc) || { cc: s.cc, name: s.country, count: 0, bestMbps: 0, bestScore: 0 };
    e.count++;
    e.bestMbps = Math.max(e.bestMbps, s.mbps);
    e.bestScore = Math.max(e.bestScore, s.score);
    by.set(s.cc, e);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

/** Servidor visible para la UI (sin la config .ovpn, que pesa). */
function publicView(s) {
  const { config, ...rest } = s; // eslint-disable-line no-unused-vars
  return rest;
}

function tcpProbe(server, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (server.proto !== 'tcp') return resolve(null);
    const t0 = process.hrtime.bigint();
    const sock = net.connect({ host: server.ip, port: server.port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('error', () => done(false));
    sock.once('connect', () => done(Number(process.hrtime.bigint() - t0) / 1e6));
  });
}

/** Ordena candidatos por score, descartando servidores TCP que no responden (UDP no se puede sondear). */
async function rank(servers, { limit = 5, probe = tcpProbe } = {}) {
  const top = [...servers].sort((a, b) => b.score - a.score).slice(0, Math.max(limit * 3, 12));
  const results = await Promise.all(top.map((s) => probe(s)));
  return top.filter((_, i) => results[i] !== false).slice(0, limit);
}

module.exports = { parse, loadServers, summarize, publicView, rank, tcpProbe, remoteOf, CACHE_TTL_MS };
