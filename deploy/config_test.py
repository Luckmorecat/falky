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
        "FALKY_INSTANCE_DIR": "/srv/" + project,
        "FALKY_LIVEKIT_CONFIG_SHA": "c" * 64,
    }
    # Never read a developer's private .env while testing configuration.
    with tempfile.NamedTemporaryFile() as env_file:
        command = ["docker", "compose", "--env-file", env_file.name,
                   "-f", str(ROOT / ("compose.production.yaml" if production else "compose.yaml"))]
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
            self.assertFalse(services["caddy"].get("volumes"))
            self.assertTrue(config["networks"]["default"]["external"])
            self.assertEqual(config["networks"]["default"]["name"], config["name"] + "_default")
            self.assertEqual(services["livekit"]["labels"]["win.lunari.falky.livekit-config"], "c" * 64)
            self.assertEqual(services["livekit"]["volumes"][0]["source"], "/srv/" + config["name"] + "/.deploy/livekit.yaml")
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
        self.assertTrue(any(m["target"] == "/etc/caddy/Caddyfile" and m["read_only"] for m in mounts))
        self.assertFalse(any(m["target"] == "/etc/caddy/web.caddy" for m in mounts))

    def test_livekit_compose_identity_changes_only_with_its_configuration(self):
        environment = os.environ | {
            'FALKY_PROJECT_NAME':'falky', 'FALKY_DOMAIN':'test.invalid',
            'FALKY_IMAGE':'ghcr.io/luckmorecat/falky@sha256:'+'a'*64,
            'FALKY_WEB_IMAGE':'ghcr.io/luckmorecat/falky-web@sha256:'+'b'*64,
            'FALKY_LIVEKIT_API_KEY':'test', 'FALKY_LIVEKIT_API_SECRET':'test'*8,
            'LIVEKIT_NODE_IP':'192.0.2.1', 'FALKY_INSTANCE_DIR':'/srv/falky',
            'FALKY_LIVEKIT_CONFIG_SHA':'c'*64,
        }
        with tempfile.TemporaryDirectory() as temporary:
            hashes=[]
            for index in range(3):
                package=Path(temporary)/str(index); package.mkdir()
                (package/'compose.production.yaml').write_bytes((ROOT/'compose.production.yaml').read_bytes())
                if index == 1:
                    environment['FALKY_IMAGE']='ghcr.io/luckmorecat/falky@sha256:'+'d'*64
                if index == 2:
                    environment['FALKY_LIVEKIT_CONFIG_SHA']='e'*64
                hashes.append(subprocess.check_output(['docker','compose','--env-file','/dev/null','-f',str(package/'compose.production.yaml'),'config','--hash','livekit'],env=environment,text=True))
            self.assertEqual(hashes[0],hashes[1], 'New package path or app image must not restart unchanged LiveKit')
            self.assertNotEqual(hashes[1],hashes[2], 'Changed mounted bytes must trigger Compose recreation')

    def test_runtime_package_does_not_own_host_resources(self):
        import release
        self.assertFalse(any(name.startswith(('edge/', 'systemd/')) for name in release.FILES))
        self.assertNotIn('Caddyfile', release.FILES)
        self.assertNotIn('WebCaddyfile', release.FILES)
        self.assertFalse((ROOT / 'edge').exists())
        self.assertFalse((ROOT / 'systemd').exists())


if __name__ == "__main__":
    unittest.main()
