#!/usr/bin/env bash
# Instala un servidor WireGuard en un VPS Debian/Ubuntu y genera un perfil de cliente.
# Uso (en el VPS, como root):  ./wireguard-server.sh <pais-ciudad>   p.ej. de-frankfurt
# Luego copia el .conf generado a ~/.config/freevpn/wireguard/ en tu equipo.
set -euo pipefail
NAME="${1:?uso: $0 <pais-ciudad>}"
PORT="${WG_PORT:-51820}"
SUBNET="10.66.66"
IFACE="$(ip -4 route show default | awk '{print $5; exit}')"
ENDPOINT="${WG_ENDPOINT:-$(curl -fsS https://api.ipify.org)}"

apt-get update -qq && apt-get install -y -qq wireguard qrencode >/dev/null
umask 077
cd /etc/wireguard
[ -f server.key ] || wg genkey | tee server.key | wg pubkey > server.pub
wg genkey | tee "client-$NAME.key" | wg pubkey > "client-$NAME.pub"
wg genpsk > "client-$NAME.psk"

cat > wg0.conf <<CONF
[Interface]
Address = $SUBNET.1/24
ListenPort = $PORT
PrivateKey = $(cat server.key)
PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o $IFACE -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o $IFACE -j MASQUERADE

[Peer]
PublicKey = $(cat "client-$NAME.pub")
PresharedKey = $(cat "client-$NAME.psk")
AllowedIPs = $SUBNET.2/32
CONF

cat > "$NAME.conf" <<CONF
[Interface]
PrivateKey = $(cat "client-$NAME.key")
Address = $SUBNET.2/24
DNS = 1.1.1.1, 9.9.9.9

[Peer]
PublicKey = $(cat server.pub)
PresharedKey = $(cat "client-$NAME.psk")
Endpoint = $ENDPOINT:$PORT
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
CONF

systemctl enable --now wg-quick@wg0
echo "Servidor listo (abre UDP $PORT en el firewall del proveedor)."
echo "Perfil de cliente: /etc/wireguard/$NAME.conf  -> cópialo a ~/.config/freevpn/wireguard/"
