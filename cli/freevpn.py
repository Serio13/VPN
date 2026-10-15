#!/usr/bin/env python3
"""freevpn - cliente VPN personal con selección de servidores de todo el mundo.

Proveedores:
  vpngate    Servidores públicos gratuitos (proyecto académico VPN Gate, Univ. de Tsukuba)
             a través de su API pública. Usa OpenVPN.
  wireguard  Tus propios servidores WireGuard (ver deploy/wireguard-server.sh).
             Perfiles .conf en ~/.config/freevpn/wireguard/<pais>-<ciudad>.conf

Solo biblioteca estándar de Python. Conectar/desconectar requiere root.
"""
from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

VPNGATE_API = "https://www.vpngate.net/api/iphone/"
IP_CHECK_URL = "https://api.ipify.org"
CACHE_TTL = 600  # segundos

CONFIG_DIR = Path(os.environ.get("FREEVPN_HOME", Path.home() / ".config" / "freevpn"))
CACHE_DIR = Path(os.environ.get("FREEVPN_CACHE", Path.home() / ".cache" / "freevpn"))
RUN_DIR = Path(os.environ.get("FREEVPN_RUN", "/tmp/freevpn"))
WG_DIR = CONFIG_DIR / "wireguard"
STATE_FILE = RUN_DIR / "state.json"


# ---------------------------------------------------------------- VPN Gate ---
@dataclass
class Server:
    host: str
    ip: str
    score: int
    ping: int
    speed_mbps: float
    country: str
    cc: str
    sessions: int
    uptime_days: float
    log_policy: str
    operator: str
    config_b64: str

    @property
    def config(self) -> str:
        return base64.b64decode(self.config_b64).decode("utf-8", "replace")

    @property
    def remote(self) -> tuple[str, int, str]:
        """(ip, puerto, protocolo) leídos del .ovpn del servidor."""
        proto, port = "tcp", 443
        for raw in self.config.splitlines():
            line = raw.strip()
            if line.startswith("proto "):
                proto = line.split()[1][:3]
            elif line.startswith("remote "):
                parts = line.split()
                if len(parts) >= 3 and parts[2].isdigit():
                    port = int(parts[2])
        return self.ip, port, proto


def parse_vpngate(text: str) -> list[Server]:
    """Parsea el CSV de la API: '*vpn_servers', cabecera '#...', filas, '*'."""
    lines = [l for l in text.splitlines() if l.strip() and not l.startswith("*")]
    if not lines:
        return []
    lines[0] = lines[0].lstrip("#")
    servers = []
    for row in csv.DictReader(io.StringIO("\n".join(lines))):
        try:
            if not row.get("OpenVPN_ConfigData_Base64"):
                continue
            servers.append(Server(
                host=row["HostName"], ip=row["IP"], score=int(row["Score"]),
                ping=int(row["Ping"] or 0), speed_mbps=int(row["Speed"] or 0) / 1e6,
                country=row["CountryLong"], cc=row["CountryShort"].upper(),
                sessions=int(row["NumVpnSessions"] or 0),
                uptime_days=int(row["Uptime"] or 0) / 86_400_000,
                log_policy=row["LogType"], operator=row["Operator"],
                config_b64=row["OpenVPN_ConfigData_Base64"],
            ))
        except (KeyError, ValueError):
            continue  # fila corrupta: se ignora
    return servers


def fetch_vpngate(url: str = VPNGATE_API, refresh: bool = False) -> list[Server]:
    cache = CACHE_DIR / "vpngate.csv"
    if not refresh and cache.exists() and time.time() - cache.stat().st_mtime < CACHE_TTL:
        return parse_vpngate(cache.read_text(errors="replace"))
    req = urllib.request.Request(url, headers={"User-Agent": "freevpn/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode("utf-8", "replace")
    except OSError as e:
        if cache.exists():  # sin red: usa la caché aunque esté vieja
            print(f"aviso: no se pudo contactar la API ({e}); usando caché", file=sys.stderr)
            return parse_vpngate(cache.read_text(errors="replace"))
        raise SystemExit(f"error: no se pudo obtener la lista de servidores: {e}")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(text)
    return parse_vpngate(text)


def filter_servers(servers, country=None, proto=None, max_ping=None, min_speed=None):
    out = []
    for s in servers:
        if country and country.lower() not in (s.cc.lower(), s.country.lower()):
            continue
        if proto and s.remote[2] != proto:
            continue
        if max_ping is not None and s.ping > max_ping:
            continue
        if min_speed is not None and s.speed_mbps < min_speed:
            continue
        out.append(s)
    return sorted(out, key=lambda s: s.score, reverse=True)


def tcp_probe(server: Server, timeout: float = 3.0) -> float | None:
    """Latencia (ms) de un connect TCP real, o None si el servidor no responde.
    Para servidores solo-UDP no es concluyente, por eso solo se usa como ranking."""
    ip, port, proto = server.remote
    if proto != "tcp":
        return None
    t0 = time.perf_counter()
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return (time.perf_counter() - t0) * 1000
    except OSError:
        return None


# ------------------------------------------------------------------ estado ---
def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state))


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def require_root() -> None:
    if os.geteuid() != 0:
        raise SystemExit("error: conectar/desconectar requiere root (usa sudo)")


def require_bin(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise SystemExit(f"error: falta '{name}'. Instálalo (p.ej. apt install {name if name != 'wg-quick' else 'wireguard-tools'})")
    return path


def public_ip() -> str:
    try:
        with urllib.request.urlopen(IP_CHECK_URL, timeout=8) as r:
            return r.read().decode().strip()
    except OSError:
        return "?"


# ---------------------------------------------------------------- comandos ---
def cmd_countries(args) -> None:
    servers = fetch_vpngate(args.url, args.refresh)
    by: dict[str, list[Server]] = {}
    for s in servers:
        by.setdefault(s.cc, []).append(s)
    print(f"{'CC':<4}{'PAÍS':<28}{'SERVIDORES':>10}{'MEJOR Mbps':>12}")
    for cc, group in sorted(by.items(), key=lambda kv: -len(kv[1])):
        print(f"{cc:<4}{group[0].country:<28}{len(group):>10}{max(s.speed_mbps for s in group):>12.1f}")


def cmd_list(args) -> None:
    servers = filter_servers(fetch_vpngate(args.url, args.refresh), args.country,
                             args.proto, args.max_ping, args.min_speed)[: args.limit]
    if not servers:
        raise SystemExit("ningún servidor coincide con los filtros")
    if args.probe:
        with ThreadPoolExecutor(16) as ex:
            lat = list(ex.map(tcp_probe, servers))
    else:
        lat = [None] * len(servers)
    print(f"{'#':>3} {'CC':<3} {'IP':<16}{'SCORE':>9}{'PING':>6}{'Mbps':>8}{'PROTO':>6}{'LOGS':>8}  PROBE")
    for i, (s, l) in enumerate(zip(servers, lat), 1):
        probe = "-" if l is None else f"{l:.0f} ms"
        print(f"{i:>3} {s.cc:<3} {s.ip:<16}{s.score:>9}{s.ping:>6}{s.speed_mbps:>8.1f}"
              f"{s.remote[2]:>6}{s.log_policy[:7]:>8}  {probe}")


def pick_vpngate(args) -> Server:
    servers = filter_servers(fetch_vpngate(args.url, args.refresh), args.country,
                             args.proto, args.max_ping, args.min_speed)
    if args.ip:
        servers = [s for s in servers if s.ip == args.ip]
    if not servers:
        raise SystemExit("ningún servidor coincide con los filtros")
    if args.country or args.ip:
        # entre los 8 mejores por score, el que responda más rápido al probe
        top = servers[:8]
        with ThreadPoolExecutor(8) as ex:
            lat = list(ex.map(tcp_probe, top))
        alive = [(l, s) for l, s in zip(lat, top) if l is not None]
        if alive:
            return min(alive, key=lambda x: x[0])[1]
    return servers[0]


def cmd_connect(args) -> None:
    require_root()
    if load_state().get("pid") and pid_alive(load_state()["pid"]):
        raise SystemExit("ya hay una conexión activa; usa 'disconnect' primero")
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    if args.provider == "wireguard":
        return connect_wireguard(args)
    require_bin("openvpn")
    server = pick_vpngate(args)
    ip, port, proto = server.remote
    print(f"Conectando a {server.country} ({server.ip}:{port}/{proto}, "
          f"{server.speed_mbps:.0f} Mbps, logs: {server.log_policy})")
    ovpn = RUN_DIR / "current.ovpn"
    ovpn.write_text(server.config)
    os.chmod(ovpn, 0o600)
    log, pidfile = RUN_DIR / "openvpn.log", RUN_DIR / "openvpn.pid"
    log.write_text("")
    subprocess.run([
        "openvpn", "--config", str(ovpn), "--daemon", "freevpn",
        "--writepid", str(pidfile), "--log", str(log), "--auth-nocache",
        "--data-ciphers", "AES-256-GCM:AES-128-GCM:AES-128-CBC",
        "--connect-retry-max", "2", "--connect-timeout", "10",
    ], check=True)
    for _ in range(args.timeout):
        time.sleep(1)
        if "Initialization Sequence Completed" in log.read_text(errors="replace"):
            pid = int(pidfile.read_text())
            save_state({"provider": "vpngate", "pid": pid, "server": server.ip,
                        "country": server.country})
            print(f"Conectado. IP pública: {public_ip()}")
            return
    subprocess.run(["pkill", "-F", str(pidfile)], check=False)
    raise SystemExit(f"no se pudo conectar en {args.timeout}s (mira {log}); prueba con otro servidor")


def connect_wireguard(args) -> None:
    require_bin("wg-quick")
    profiles = sorted(WG_DIR.glob("*.conf"))
    want = (args.country or "").lower()
    match = [p for p in profiles if want and p.stem.lower().startswith(want)] or \
            ([profiles[0]] if profiles and not want else [])
    if not match:
        raise SystemExit(f"sin perfil WireGuard para '{want}' en {WG_DIR} (ver 'wg-list')")
    prof = match[0]
    subprocess.run(["wg-quick", "up", str(prof)], check=True)
    save_state({"provider": "wireguard", "profile": str(prof), "pid": 0})
    print(f"Conectado vía WireGuard ({prof.stem}). IP pública: {public_ip()}")


def cmd_wg_list(_args) -> None:
    profiles = sorted(WG_DIR.glob("*.conf"))
    if not profiles:
        print(f"No hay perfiles en {WG_DIR}. Cada servidor = un archivo <pais>-<ciudad>.conf")
    for p in profiles:
        print(p.stem)


def cmd_disconnect(_args) -> None:
    require_root()
    st = load_state()
    if st.get("provider") == "wireguard":
        subprocess.run(["wg-quick", "down", st["profile"]], check=False)
    elif st.get("pid") and pid_alive(st["pid"]):
        os.kill(st["pid"], signal.SIGTERM)
    else:
        print("No hay conexión activa")
        return
    STATE_FILE.unlink(missing_ok=True)
    (RUN_DIR / "current.ovpn").unlink(missing_ok=True)  # contiene credenciales de sesión
    print("Desconectado")


def cmd_status(_args) -> None:
    st = load_state()
    active = st.get("provider") == "wireguard" or (st.get("pid") and pid_alive(st["pid"]))
    if not active:
        print("Desconectado")
        return
    print(f"Conectado ({st['provider']}): {st.get('country') or st.get('profile')} "
          f"- IP pública {public_ip()}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="freevpn", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("-c", "--country", help="código (JP, US) o nombre del país")
        sp.add_argument("--proto", choices=["tcp", "udp"])
        sp.add_argument("--max-ping", type=int, help="ping máximo (ms) reportado")
        sp.add_argument("--min-speed", type=float, help="velocidad mínima (Mbps)")
        sp.add_argument("--refresh", action="store_true", help="ignora la caché")
        sp.add_argument("--url", default=VPNGATE_API, help="URL/mirror de la API")

    sp = sub.add_parser("countries", help="países disponibles")
    common(sp)
    sp.set_defaults(fn=cmd_countries)
    sp = sub.add_parser("list", help="lista servidores")
    common(sp)
    sp.add_argument("-n", "--limit", type=int, default=20)
    sp.add_argument("--probe", action="store_true", help="mide latencia TCP real")
    sp.set_defaults(fn=cmd_list)
    sp = sub.add_parser("connect", help="conecta (sudo)")
    common(sp)
    sp.add_argument("--provider", choices=["vpngate", "wireguard"], default="vpngate")
    sp.add_argument("--ip", help="servidor concreto por IP")
    sp.add_argument("--timeout", type=int, default=30)
    sp.set_defaults(fn=cmd_connect)
    sub.add_parser("disconnect", help="desconecta (sudo)").set_defaults(fn=cmd_disconnect)
    sub.add_parser("status", help="estado").set_defaults(fn=cmd_status)
    sub.add_parser("wg-list", help="perfiles WireGuard propios").set_defaults(fn=cmd_wg_list)
    return p


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
