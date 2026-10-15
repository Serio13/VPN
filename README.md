# freevpn

VPN personal gratuita con selección de servidores de todo el mundo. Sin dependencias de Python.

## Requisitos
`python3 ≥ 3.9`, `openvpn` (VPN Gate) y/o `wireguard-tools` (servidores propios). Linux/macOS.

## Uso
```bash
./freevpn.py countries                       # países y nº de servidores
./freevpn.py list -c JP --proto udp --probe  # servidores de Japón con latencia real
sudo ./freevpn.py connect -c US              # mejor servidor de EE. UU. disponible
sudo ./freevpn.py connect --ip 1.2.3.4       # servidor concreto
./freevpn.py status
sudo ./freevpn.py disconnect
```
### Servidores propios (WireGuard)
1. En cada VPS: `sudo deploy/wireguard-server.sh de-frankfurt`
2. Copia el `.conf` a `~/.config/freevpn/wireguard/`
3. `sudo ./freevpn.py connect --provider wireguard -c de`

## Tests
`python3 -m unittest discover -s tests`

## Advertencia
Los servidores de VPN Gate son de voluntarios: úsalos para geodesbloqueo, no para
privacidad. Para privacidad real usa tus servidores WireGuard. Ver `docs/ANALISIS.md`.
