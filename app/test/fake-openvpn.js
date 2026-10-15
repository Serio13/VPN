#!/usr/bin/env node
// OpenVPN falso para tests. Comportamiento según la IP del 'remote' del .ovpn:
//   9.9.9.9 -> AUTH_FAILED y sale;  8.8.8.8 -> se queda mudo (timeout);  otra -> conecta.
const fs = require('fs');
const net = require('net');
const a = process.argv.slice(2);
const val = (flag, n = 1) => a.slice(a.indexOf(flag) + 1, a.indexOf(flag) + 1 + n);
const cfg = fs.readFileSync(val('--config')[0], 'utf8');
const [, mport, pwfile] = val('--management', 3);
const pw = fs.readFileSync(pwfile, 'utf8').trim();
const marker = process.env.FAKE_OVPN_MARKER;
if (cfg.includes('remote 9.9.9.9')) { console.log('AUTH_FAILED'); process.exit(1); }
const srv = net.createServer((s) => {
  let authed = false;
  s.on('data', (d) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      if (!authed) { authed = line === pw; if (!authed) s.destroy(); continue; }
      if (line === 'signal SIGTERM') { if (marker) fs.writeFileSync(marker, 'clean'); process.exit(0); }
    }
  });
});
srv.listen(Number(mport), '127.0.0.1', () => {
  if (cfg.includes('remote 8.8.8.8')) return;
  setTimeout(() => console.log('Initialization Sequence Completed'), 100);
});
setInterval(() => {}, 1000);
