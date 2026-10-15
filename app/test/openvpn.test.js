'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VpnManager, findOpenVpn, buildArgs } = require('../src/openvpn');

const FAKE = path.join(__dirname, 'fake-openvpn.js');
const srv = (ip) => ({ ip, host: ip, cc: 'XX', config: `client\nproto tcp\nremote ${ip} 443\n` });
const mk = (opts = {}) => new VpnManager({
  runDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fvpn-run-')), openvpnPath: FAKE, attemptTimeoutMs: 1500, ...opts,
});
const states = (m) => { const l = []; m.on('state', (s) => l.push(s.state)); return l; };

test('conecta al primer servidor y reporta la IP pública', async () => {
  const m = mk({ ipLookup: async () => '203.0.113.7' });
  const l = states(m);
  assert.strictEqual(await m.connect([srv('1.1.1.1')]), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(m.state.state, 'connected');
  assert.strictEqual(m.state.ip, '203.0.113.7');
  assert.ok(!('config' in m.state.server), 'la config no debe salir del gestor');
  await m.disconnect();
  assert.deepStrictEqual(l.slice(0, 2), ['connecting', 'connected']);
  assert.strictEqual(m.state.state, 'idle');
});

test('failover: AUTH_FAILED y timeout pasan al siguiente servidor', async () => {
  const m = mk();
  assert.strictEqual(await m.connect([srv('9.9.9.9'), srv('8.8.8.8'), srv('2.2.2.2')]), true);
  assert.strictEqual(m.state.server.ip, '2.2.2.2');
  assert.strictEqual(m.state.attempt, 3);
  await m.disconnect();
});

test('error si todos fallan, y permite reintentar', async () => {
  const m = mk();
  assert.strictEqual(await m.connect([srv('9.9.9.9'), srv('9.9.9.9')]), false);
  assert.strictEqual(m.state.state, 'error');
  assert.strictEqual(await m.connect([srv('1.1.1.1')]), true);
  await m.disconnect();
});

test('desconexión limpia vía interfaz de gestión (no kill) y borra la config', async () => {
  const marker = path.join(os.tmpdir(), `fvpn-marker-${process.pid}`);
  process.env.FAKE_OVPN_MARKER = marker;
  fs.rmSync(marker, { force: true });
  const m = mk();
  await m.connect([srv('1.1.1.1')]);
  await m.disconnect();
  assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'clean');
  assert.ok(!fs.existsSync(path.join(m.runDir, 'current.ovpn')));
  delete process.env.FAKE_OVPN_MARKER;
});

test('cancelar durante el intento detiene la cola', async () => {
  const m = mk({ attemptTimeoutMs: 5000 });
  const p = m.connect([srv('8.8.8.8'), srv('1.1.1.1')]);
  await new Promise((r) => setTimeout(r, 300));
  await m.disconnect();
  assert.strictEqual(await p, false);
  assert.strictEqual(m.state.state, 'idle');
});

test('sin OpenVPN instalado -> error claro', async () => {
  const m = new VpnManager({ runDir: os.tmpdir(), openvpnPath: undefined });
  const prev = process.env.FREEVPN_OPENVPN;
  process.env.FREEVPN_OPENVPN = '/no/existe';
  assert.strictEqual(await m.connect([srv('1.1.1.1')]), false);
  assert.match(m.state.message, /OpenVPN/);
  if (prev) process.env.FREEVPN_OPENVPN = prev; else delete process.env.FREEVPN_OPENVPN;
});

test('findOpenVpn y buildArgs', () => {
  assert.strictEqual(findOpenVpn({ FREEVPN_OPENVPN: '/x' }, () => true), '/x');
  assert.strictEqual(findOpenVpn({ FREEVPN_OPENVPN: '/x' }, () => false), null);
  const a = buildArgs({ ovpn: 'c.ovpn', mgmtPort: 1234, pwFile: 'pw' });
  assert.deepStrictEqual(a.slice(-4), ['--management', '127.0.0.1', '1234', 'pw']);
});
