"""Render real Compose configurations to check instance isolation without Docker."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


def render(project, domain, tcp, udp, production=True):
    environment = os.environ | {
        "FALKY_PROJECT_NAME": project,
        "FALKY_DOMAIN": domain,
        "FALKY_IMAGE": "ghcr.io/luckmorecat/falky@sha256:" + "a" * 64,
        "FALKY_WEB_IMAGE": "ghcr.io/luckmorecat/falky-web@sha256:" + "b" * 64,
        "FALKY_LIVEKIT_API_KEY": "test",
        "FALKY_LIVEKIT_API_SECRET": "test" * 8,
        "LIVEKIT_NODE_IP": "192.0.2.1",
        "LIVEKIT_TCP_PORT": str(tcp),
        "LIVEKIT_UDP_PORT": str(udp),
    }
    # Never read a developer's private .env while testing configuration.
    with tempfile.NamedTemporaryFile() as env_file:
        command = ["docker", "compose", "--env-file", env_file.name,
                   "-f", str(ROOT / "compose.yaml")]
        if production:
            command += ["-f", str(ROOT / "compose.production.yaml")]
        result = subprocess.run(command + ["config", "--format", "json"],
                                env=environment, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


class IsolationTests(unittest.TestCase):
    def test_instances_have_separate_volumes_networks_origins_and_media_ports(self):
        configs = [render("falky", "falky.lunari.win", 7881, 7882),
                   render("falky-dev", "dev.falky.lunari.win", 7891, 7892)]
        volume_names = []
        for config, domain, tcp, udp in zip(configs,
                ("falky.lunari.win", "dev.falky.lunari.win"), (7881, 7891), (7882, 7892)):
            services = config["services"]
            self.assertFalse(services["caddy"].get("ports"))
            self.assertFalse(services["falky"].get("ports"))
            mounts = services["caddy"]["volumes"]
            self.assertEqual({(Path(m["source"]).name, m["target"], m["read_only"]) for m in mounts},
                             {("WebCaddyfile", "/etc/caddy/Caddyfile", True),
                              ("web.caddy", "/etc/caddy/web.caddy", True)})
            for service, alias in (("caddy", "web"), ("falky", "api"), ("livekit", "voice")):
                self.assertEqual(services[service]["networks"]["default"]["aliases"],
                                 [config["name"] + "-" + alias])
            self.assertEqual(services["falky"]["environment"]["FALKY_PUBLIC_ORIGIN"], "https://" + domain)
            livekit = services["livekit"]
            self.assertEqual({(p["target"], int(p["published"]), p["protocol"]) for p in livekit["ports"]},
                             {(tcp, tcp, "tcp"), (udp, udp, "udp")})
            for key, value in (("LIVEKIT_RTC_TCP_PORT", tcp),
                               ("LIVEKIT_RTC_UDP_PORT_START", udp), ("LIVEKIT_RTC_UDP_PORT_END", udp)):
                self.assertEqual(int(livekit["environment"][key]), value)
            volume_names.append({v["name"] for v in config["volumes"].values()})
        self.assertTrue(volume_names[0].isdisjoint(volume_names[1]))
        self.assertIn("falky_falky_data", volume_names[0])
        self.assertIn("falky-dev_falky_data", volume_names[1])
        self.assertNotEqual(configs[0]["networks"]["default"]["name"], configs[1]["networks"]["default"]["name"])

    def test_local_stack_still_serves_https_directly(self):
        config = render("falky", "localhost", 7881, 7882, production=False)
        self.assertEqual({int(p["published"]) for p in config["services"]["caddy"]["ports"]}, {80, 443})
        mounts = config["services"]["caddy"]["volumes"]
        self.assertTrue(any(m["target"] == "/etc/caddy/web.caddy" and m["read_only"] for m in mounts))

    def test_edge_joins_only_the_two_instance_networks_and_reuses_certificates(self):
        result = subprocess.run(["docker", "compose", "-f", str(ROOT / "edge/compose.yaml"),
                                 "config", "--format", "json"],
                                text=True, capture_output=True, check=True)
        config = json.loads(result.stdout)
        self.assertEqual({v["name"] for v in config["networks"].values()},
                         {"falky_default", "falky-dev_default"})
        self.assertTrue(all(v["external"] for v in config["networks"].values()))
        self.assertEqual(config["volumes"]["certificates"]["name"], "falky_caddy_data")
        self.assertTrue(config["volumes"]["certificates"]["external"])


if __name__ == "__main__":
    unittest.main()
