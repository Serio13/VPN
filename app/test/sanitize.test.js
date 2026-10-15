'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sanitize } = require('../src/ovpn-sanitize');
const v = require('../src/vpngate');

const GOOD = 'client\ndev tun\nproto tcp\nremote 1.2.3.4 443\ncipher AES-128-CBC\nauth SHA1\n<ca>\n-----BEGIN-----\nup /bin/evil\n-----END-----\n</ca>\n';

test('config normal: se conserva, y el contenido de bloques no se interpreta', () => {
  const r = sanitize(GOOD);
  assert.ok(r.ok);
  assert.match(r.config, /remote 1\.2\.3\.4 443/);
  assert.match(r.config, /<ca>[\s\S]*up \/bin\/evil[\s\S]*<\/ca>/); // texto dentro del certificado
});

for (const bad of ['up "cmd.exe /c calc"', 'script-security 2', 'plugin evil.dll', 'down x', 'route-up x',
  'tls-verify x', 'client-connect x', 'config other.ovpn', 'management 127.0.0.1 1', 'setenv A B',
  'learn-address x', 'cryptoapicert SUBJ:x', 'log /tmp/x', 'daemon']) {
  test(`descarta el servidor con: ${bad}`, () => {
    const r = sanitize(GOOD + bad + '\n');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /peligrosa/);
  });
}

test('directivas desconocidas se eliminan; mayúsculas no evaden', () => {
  assert.ok(sanitize(GOOD + 'frobnicate 1\n').dropped.includes('frobnicate'));
  assert.strictEqual(sanitize(GOOD + 'UP x\n').ok, false);
  assert.strictEqual(sanitize(GOOD + '   Plugin x\n').ok, false);
});

test('bloques desconocidos o sin cerrar, y sin remote, se rechazan', () => {
  assert.strictEqual(sanitize(GOOD + '<script>\nx\n</script>\n').ok, false);
  assert.strictEqual(sanitize('client\nremote 1.1.1.1 1\n<ca>\nabc').ok, false);
  assert.strictEqual(sanitize('client\ndev tun\n').ok, false);
});

test('auth-user-pass: se marca y se quita la ruta', () => {
  const r = sanitize(GOOD + 'auth-user-pass /etc/passwd\n');
  assert.ok(r.needsAuth);
  assert.ok(!r.config.includes('/etc/passwd'));
});

test('parse descarta servidores maliciosos y cuenta cuántos', () => {
  const b64 = (t) => Buffer.from(t).toString('base64');
  const H = '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64';
  const row = (ip, cfg) => `h,${ip},100,1,1000000,Japan,JP,1,1,1,1,2weeks,o,m,${b64(cfg)}`;
  const s = v.parse(['*vpn_servers', H, row('1.1.1.1', 'client\nremote 1.1.1.1 443\n'),
    row('6.6.6.6', 'client\nremote 6.6.6.6 443\nup "calc.exe"\n'), '*'].join('\n'));
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].ip, '1.1.1.1');
  assert.strictEqual(s.rejected, 1);
});
