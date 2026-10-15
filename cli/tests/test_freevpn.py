import base64
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import freevpn  # noqa: E402

OVPN = "client\ndev tun\nproto {proto}\nremote {ip} {port}\ncipher AES-128-CBC\n"


def row(host, ip, score, ping, speed, country, cc, proto="tcp", port=443):
    cfg = base64.b64encode(OVPN.format(proto=proto, ip=ip, port=port).encode()).decode()
    return f"{host},{ip},{score},{ping},{speed},{country},{cc},5,86400000,10,999,2weeks,op,msg,{cfg}"


CSV = "\n".join([
    "*vpn_servers",
    "#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,"
    "TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64",
    row("a", "1.1.1.1", 1000, 20, 50_000_000, "Japan", "JP"),
    row("b", "2.2.2.2", 3000, 90, 10_000_000, "United States", "US", "udp", 1194),
    row("c", "3.3.3.3", 2000, 15, 90_000_000, "Japan", "JP", "udp", 1195),
    "broken,row",
    "*",
])


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.servers = freevpn.parse_vpngate(CSV)

    def test_parses_and_skips_bad_rows(self):
        self.assertEqual(len(self.servers), 3)

    def test_remote_extracted_from_config(self):
        by_ip = {s.ip: s for s in self.servers}
        self.assertEqual(by_ip["2.2.2.2"].remote, ("2.2.2.2", 1194, "udp"))
        self.assertEqual(by_ip["1.1.1.1"].remote, ("1.1.1.1", 443, "tcp"))

    def test_units(self):
        s = self.servers[0]
        self.assertAlmostEqual(s.speed_mbps, 50.0)
        self.assertAlmostEqual(s.uptime_days, 1.0)

    def test_filters_and_sort(self):
        jp = freevpn.filter_servers(self.servers, country="jp")
        self.assertEqual([s.ip for s in jp], ["3.3.3.3", "1.1.1.1"])  # por score desc
        self.assertEqual(len(freevpn.filter_servers(self.servers, country="United States")), 1)
        self.assertEqual(len(freevpn.filter_servers(self.servers, proto="udp")), 2)
        self.assertEqual(len(freevpn.filter_servers(self.servers, max_ping=20)), 2)
        self.assertEqual(len(freevpn.filter_servers(self.servers, min_speed=60)), 1)

    def test_empty_input(self):
        self.assertEqual(freevpn.parse_vpngate(""), [])
        self.assertEqual(freevpn.parse_vpngate("*vpn_servers\n*"), [])


if __name__ == "__main__":
    unittest.main()
