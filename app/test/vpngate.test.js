'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const v = require('../src/vpngate');

const ovpn = (ip, port = 443, proto = 'tcp') => Buffer.from(`client\ndev tun\nproto ${proto}\nremote ${ip} ${port}\n`).toString('base64');
const row = (host, ip, score, ping, speed, country, cc, proto, port) =>
  `${host},${ip},${score},${ping},${speed},${country},${cc},5,86400000,10,999,2weeks,op,msg,${ovpn(ip, port, proto)}`;
const HEADER = '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64';
const CSV = ['*vpn_servers', HEADER,
  row('a', '1.1.1.1', 1000, 20, 50e6, 'Japan', 'JP', 'tcp', 443),
  row('b', '2.2.2.2', 3000, 90, 10e6, 'United States', 'US', 'udp', 1194),
  row('c', '3.3.3.3', 2000, 15, 90e6, 'Japan', 'JP', 'udp', 1195),
  'broken,row', '*'].join('\n');

test('parse: filas válidas, descarta corruptas, extrae remote', () => {
  const s = v.parse(CSV);
  assert.strictEqual(s.length, 3);
  const us = s.find((x) => x.ip === '2.2.2.2');
  assert.deepStrictEqual([us.port, us.proto, us.cc, us.mbps], [1194, 'udp', 'US', 10]);
  assert.ok(us.config.includes('remote 2.2.2.2 1194'));
});

test('parse: entradas vacías o sin cabecera esperada', () => {
  assert.deepStrictEqual(v.parse(''), []);
  assert.deepStrictEqual(v.parse('*vpn_servers\n#a,b\n1,2\n*'), []);
});

test('summarize y publicView', () => {
  const s = v.parse(CSV);
  const sum = v.summarize(s);
  assert.deepStrictEqual(sum.map((c) => [c.cc, c.count]), [['JP', 2], ['US', 1]]);
  assert.strictEqual(sum[0].bestMbps, 90);
  assert.ok(!('config' in v.publicView(s[0])));
});

test('loadServers: descarga, cachea y usa caché vieja si no hay red', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fvpn-'));
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, text: async () => CSV }; };
  const r1 = await v.loadServers({ cacheDir: dir, fetchImpl: ok, now: 1000 });
  assert.strictEqual(r1.servers.length, 3);
  await v.loadServers({ cacheDir: dir, fetchImpl: ok });            // dentro del TTL: no llama a la red
  assert.strictEqual(calls, 1);
  const down = async () => { throw new Error('sin red'); };
  const r3 = await v.loadServers({ cacheDir: dir, fetchImpl: down, refresh: true });
  assert.strictEqual(r3.stale, true);
  assert.strictEqual(r3.servers.length, 3);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fvpn-'));
  await assert.rejects(v.loadServers({ cacheDir: empty, fetchImpl: down }), /VPN Gate/);
});

test('rank: ordena por score y descarta TCP caídos', async () => {
  const s = v.parse(CSV);
  const probe = async (x) => (x.ip === '1.1.1.1' ? false : null);
  const r = await v.rank(s, { limit: 5, probe });
  assert.deepStrictEqual(r.map((x) => x.ip), ['2.2.2.2', '3.3.3.3']);
});
