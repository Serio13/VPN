# Análisis: cómo funciona un VPN comercial (tipo NordVPN) y qué se puede replicar

Análisis basado en documentación pública, protocolos abiertos y la API pública de listado
de servidores. No se ha evadido ninguna autenticación ni se usa infraestructura ajena sin permiso.

## 1. Anatomía de un VPN comercial

| Capa | Qué hace | Equivalente aquí |
|------|----------|------------------|
| App cliente | Lista países/servidores, conecta, kill switch | `freevpn.py` |
| API de control | Lista servidores con carga, credenciales/claves por usuario | VPN Gate API / tu propio inventario |
| Protocolo | WireGuard (NordLynx es WireGuard + doble NAT para no guardar IP fija), OpenVPN | OpenVPN (VPN Gate) y WireGuard (propio) |
| Flota de servidores | Miles de servidores bare-metal en ~100 países | Voluntarios (VPN Gate) + tus VPS |
| Cuentas/facturación | Autoriza qué claves entran | No necesario: uso personal |

## 2. Por qué no se "clona" NordVPN
Su API pública de listado de servidores es consultable, pero las **credenciales y claves
WireGuard son por cuenta de pago**. Usar sus servidores sin suscripción implicaría saltarse
la autenticación: viola sus términos, no es fiable (revocan) y no lo implemento.
Lo que sí es replicable es la arquitectura, con infraestructura propia o abierta.

## 3. Opciones gratuitas reales

1. **VPN Gate** (Univ. de Tsukuba): API pública `https://www.vpngate.net/api/iphone/`
   (CSV: IP, país, ping, velocidad, score, política de logs y el `.ovpn` en base64).
   Servidores de voluntarios en todo el mundo. **Gratis, pero**: el operador puede ver
   tu tráfico no cifrado y muchos guardan logs ~2 semanas. Úsalo para saltar geobloqueos,
   NO para privacidad fuerte.
2. **WireGuard propio** en VPS gratuitos/baratos de varias regiones (Oracle Cloud Always Free,
   Google Cloud e2-micro en EE. UU., AWS/Azure con créditos). Máxima privacidad y velocidad;
   "todo el mundo" = tantas regiones como cuentas free-tier tengas. `cli/deploy/wireguard-server.sh`.
3. **Cloudflare WARP** (cliente oficial gratuito): cifrado a Cloudflare, sin elegir país.

## 4. Datos reales del formato VPN Gate
Primera línea `*vpn_servers`, segunda cabecera `#HostName,IP,Score,Ping,Speed,CountryLong,
CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,
OpenVPN_ConfigData_Base64`, última línea `*`. Speed en bps, Uptime en ms.
Los `.ovpn` usan `cipher AES-128-CBC`, por eso el cliente añade `--data-ciphers` para
OpenVPN ≥ 2.6.

## 5. Limitaciones conocidas
- Sin kill switch (siguiente paso: reglas nftables que bloqueen tráfico fuera de `tun0`).
- No se verifica DNS leak; el servidor VPN Gate empuja su DNS.
- VPN Gate está bloqueado en algunos países (usa `--url` con un mirror).
- No he podido probar contra la API real desde el sandbox de desarrollo (proxy sin acceso);
  el parser está probado con datos en el formato documentado.
