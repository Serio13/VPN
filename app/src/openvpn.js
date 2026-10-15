'use strict';
// Gestor de la conexión OpenVPN: lanza openvpn, sigue su registro, reintenta con el siguiente
// servidor si uno falla y lo apaga limpiamente por la interfaz de gestión.
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const WIN_PATHS = [
  'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe',
  'C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe',
];

function findOpenVpn(env = process.env, exists = fs.existsSync) {
  if (env.FREEVPN_OPENVPN) return exists(env.FREEVPN_OPENVPN) ? env.FREEVPN_OPENVPN : null;
  if (process.platform === 'win32') return WIN_PATHS.find((p) => exists(p)) || null;
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'openvpn');
    if (dir && exists(p)) return p;
  }
  return null;
}

function installOpenVpn() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, message: 'La instalación automática solo existe en Windows (winget).' });
    execFile('winget', ['install', '-e', '--id', 'OpenVPNTechnologies.OpenVPN', '--silent',
      '--accept-package-agreements', '--accept-source-agreements'], { windowsHide: true, timeout: 300000 },
    (err, stdout, stderr) => resolve(err ? { ok: false, message: (stderr || stdout || err.message).trim() } : { ok: true }));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function buildArgs({ ovpn, mgmtPort, pwFile, authFile }) {
  return [
    '--config', ovpn,
    '--script-security', '0', // nunca ejecutar programas externos aunque la config lo pida
    ...(authFile ? ['--auth-user-pass', authFile] : []),
    '--auth-nocache',
    '--data-ciphers', 'AES-256-GCM:AES-128-GCM:AES-128-CBC',
    '--connect-timeout', '10',
    '--connect-retry-max', '1',
    '--verb', '3',
    '--management', '127.0.0.1', String(mgmtPort), pwFile,
  ];
}

const FATAL = /AUTH_FAILED|Exiting due to fatal error|Options error|Cannot open TUN|All TAP-Windows adapters|There are no TAP-Windows|wintun/i;

class VpnManager extends EventEmitter {
  constructor({ runDir, ipLookup, attemptTimeoutMs = 25000, openvpnPath } = {}) {
    super();
    this.runDir = runDir || path.join(os.tmpdir(), 'freevpn');
    this.ipLookup = ipLookup || (async () => null);
    this.attemptTimeoutMs = attemptTimeoutMs;
    this.openvpnPath = openvpnPath;
    this.state = { state: 'idle' };
    this.log = [];
    this.child = null;
    this.mgmt = null;
    this.cancelled = false;
    this.run = 0;
  }

  _set(s) { this.state = s; this.emit('state', s); }
  _log(line) { this.log.push(line); if (this.log.length > 300) this.log.shift(); }

  /** candidates: servidores (con .config) a probar en orden. */
  async connect(candidates) {
    if (!['idle', 'error'].includes(this.state.state)) throw new Error('Ya hay una conexión en curso');
    const bin = this.openvpnPath || findOpenVpn();
    if (!bin) { this._set({ state: 'error', message: 'OpenVPN no está instalado' }); return false; }
    if (!candidates.length) { this._set({ state: 'error', message: 'No hay servidores disponibles' }); return false; }
    this.cancelled = false;
    const run = ++this.run;
    fs.mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < candidates.length; i++) {
      if (this.cancelled || run !== this.run) return false;
      const server = candidates[i];
      this._set({ state: 'connecting', server: pub(server), attempt: i + 1, total: candidates.length });
      const ok = await this._attempt(bin, server);
      if (ok) {
        this._set({ state: 'connected', server: pub(server), attempt: i + 1, total: candidates.length, since: Date.now() });
        this.ipLookup().then((ip) => {
          if (this.state.state === 'connected') this._set({ ...this.state, ip });
        }).catch(() => {});
        return true;
      }
      if (this.cancelled) return false;
    }
    this._set({ state: 'error', message: `Ninguno de los ${candidates.length} servidores respondió. Prueba otro país.` });
    return false;
  }

  async _attempt(bin, server) {
    const ovpn = path.join(this.runDir, 'current.ovpn');
    const pwFile = path.join(this.runDir, 'mgmt.pw');
    this.mgmtPw = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(ovpn, server.config, { mode: 0o600 });
    fs.writeFileSync(pwFile, this.mgmtPw + '\n', { mode: 0o600 });
    let authFile;
    if (server.needsAuth) { // credenciales públicas de VPN Gate
      authFile = path.join(this.runDir, 'auth.txt');
      fs.writeFileSync(authFile, 'vpn\nvpn\n', { mode: 0o600 });
    }
    const mgmtPort = await freePort();
    this.mgmtPort = mgmtPort;
    this.log = [];
    const child = spawn(bin, buildArgs({ ovpn, mgmtPort, pwFile, authFile }), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    return new Promise((resolve) => {
      let settled = false;
      let buf = '';
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) this._kill(child);
        resolve(ok);
      };
      const onData = (d) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) {
          this._log(line);
          if (line.includes('Initialization Sequence Completed')) finish(true);
          else if (FATAL.test(line)) finish(false);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => { this._log(`spawn error: ${e.message}`); finish(false); });
      child.on('exit', (code) => {
        this._log(`openvpn terminó (código ${code})`);
        if (!settled) return finish(false);
        if (this.child === child) {
          this.child = null;
          if (this.state.state === 'connected') this._set({ state: 'error', message: 'La conexión se interrumpió' });
        }
      });
      const timer = setTimeout(() => finish(false), this.attemptTimeoutMs);
    });
  }

  _kill(child) {
    if (!child || child.exitCode !== null) return;
    try { child.kill(); } catch { /* ya terminó */ }
  }

  /** Apagado limpio por la interfaz de gestión; si no responde en 5 s se fuerza. */
  async disconnect() {
    this.cancelled = true;
    this.run++;
    const child = this.child;
    if (!child || child.exitCode !== null) { this._set({ state: 'idle' }); return; }
    this._set({ state: 'disconnecting' });
    const exited = new Promise((r) => child.once('exit', r));
    this._sendSigterm().catch(() => {});
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 5000));
    if ((await Promise.race([exited, timeout])) === 'timeout') this._kill(child);
    this.child = null;
    for (const f of ['current.ovpn', 'mgmt.pw', 'auth.txt']) fs.rmSync(path.join(this.runDir, f), { force: true });
    this._set({ state: 'idle' });
  }

  _sendSigterm() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.mgmtPort }, () => {
        sock.write(this.mgmtPw + '\n');
        sock.write('signal SIGTERM\n');
        setTimeout(() => { sock.destroy(); resolve(); }, 500);
      });
      sock.on('error', reject);
    });
  }
}

function pub(s) {
  const { config, ...rest } = s; // eslint-disable-line no-unused-vars
  return rest;
}

module.exports = { VpnManager, findOpenVpn, installOpenVpn, buildArgs };
