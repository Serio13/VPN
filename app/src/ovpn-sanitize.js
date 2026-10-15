'use strict';
// Las configuraciones .ovpn las publican voluntarios anónimos y OpenVPN se ejecuta como administrador.
// Una config maliciosa puede ejecutar comandos (up/down/plugin/...) o incluir otros archivos, así que:
//  - se descarta el servidor entero si usa directivas de ejecución/inclusión;
//  - del resto solo se conserva una lista blanca de directivas inocuas.
const DANGEROUS = new Set([
  'up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'learn-address', 'client-connect',
  'client-disconnect', 'tls-verify', 'auth-user-pass-verify', 'plugin', 'script-security',
  'up-restart', 'down-pre', 'config', 'management', 'management-client', 'management-hold',
  'management-query-passwords', 'setenv', 'setenv-safe', 'cd', 'chroot', 'setuid', 'setgid',
  'engine', 'log', 'log-append', 'writepid', 'daemon', 'pkcs11-providers', 'cryptoapicert',
  'http-proxy-user-pass', 'ifconfig-noexec', 'iproute', 'ca-file',
]);

const ALLOWED = new Set([
  'client', 'dev', 'dev-type', 'proto', 'remote', 'remote-random', 'resolv-retry', 'nobind',
  'persist-key', 'persist-tun', 'persist-remote-ip', 'cipher', 'auth', 'verb', 'mute',
  'mute-replay-warnings', 'remote-cert-tls', 'ns-cert-type', 'tls-client', 'key-direction',
  'keepalive', 'ping', 'ping-restart', 'ping-exit', 'comp-lzo', 'compress', 'route-delay',
  'redirect-gateway', 'tun-mtu', 'mssfix', 'fragment', 'sndbuf', 'rcvbuf', 'reneg-sec',
  'tls-version-min', 'tls-cipher', 'link-mtu', 'float', 'connect-retry', 'connect-retry-max',
  'connect-timeout', 'tls-timeout', 'hand-window', 'explicit-exit-notify', 'pull',
  'block-outside-dns', 'auth-nocache', 'data-ciphers', 'data-ciphers-fallback', 'lport', 'rport',
  'dhcp-option', 'auth-user-pass', 'tls-groups', 'key-direction', 'allow-compression',
]);
const BLOCKS = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'dh', 'extra-certs']);

/**
 * @returns {{ok:boolean, config?:string, needsAuth?:boolean, dropped:string[], reason?:string}}
 */
function sanitize(text) {
  const out = [];
  const dropped = [];
  let needsAuth = false;
  let block = null; // etiqueta del bloque <tag> abierto
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (block) {
      if (line === `</${block}>`) { out.push(line); block = null; } else out.push(raw);
      continue;
    }
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const open = /^<([a-z0-9-]+)>$/.exec(line);
    if (open) {
      if (!BLOCKS.has(open[1])) return { ok: false, dropped, reason: `bloque no permitido <${open[1]}>` };
      block = open[1];
      out.push(line);
      continue;
    }
    const name = line.split(/\s+/)[0].toLowerCase();
    if (DANGEROUS.has(name)) return { ok: false, dropped, reason: `directiva peligrosa '${name}'` };
    if (!ALLOWED.has(name)) { dropped.push(name); continue; }
    if (name === 'auth-user-pass') { needsAuth = true; continue; } // sin ruta: las credenciales públicas las damos nosotros
    out.push(line);
  }
  if (block) return { ok: false, dropped, reason: `bloque <${block}> sin cerrar` };
  if (!out.some((l) => l.startsWith('remote '))) return { ok: false, dropped, reason: 'sin directiva remote' };
  return { ok: true, config: out.join('\n') + '\n', needsAuth, dropped };
}

module.exports = { sanitize, DANGEROUS, ALLOWED };
