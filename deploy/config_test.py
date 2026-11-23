"""Render real Compose configurations to check instance isolation without Docker."""

from itertools import combinations
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


def render(project, domain, tcp, udp, production=True, turn_host='', turn_secret_file=''):
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
        "FALKY_TURN_HOST": turn_host,
        "FALKY_TURN_SECRET_FILE": turn_secret_file,
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
        instances = [("falky", "falky.lunari.win", 7881, 7882),
                     ("falky-dev", "dev.falky.lunari.win", 7891, 7892),
                     ("falky-staging", "staging.falky.lunari.win", 7901, 7902)]
        resources = []
        for project, domain, tcp, udp in instances:
            config = render(project, domain, tcp, udp)
            self.assertEqual(config["name"], project)
            services = config["services"]
            self.assertFalse(services["caddy"].get("ports"))
            self.assertFalse(services["falky"].get("ports"))
            self.assertFalse(services["caddy"].get("volumes"))
            self.assertTrue(config["networks"]["default"]["external"])
            self.assertEqual(config["networks"]["default"]["name"], config["name"] + "_default")
            self.assertEqual(services["livekit"]["labels"]["win.lunari.falky.livekit-config"], "c" * 64)
            self.assertEqual(services["livekit"]["volumes"][0]["source"], "/srv/" + config["name"] + "/.deploy/livekit.yaml")
            self.assertEqual(services["caddy"]["networks"]["default"]["aliases"], [config["name"] + "-web"])
            self.assertEqual(services["falky"]["networks"]["default"]["aliases"],
                             [config["name"] + "-api", config["name"] + "-voice"])
            self.assertFalse((services["livekit"].get("networks", {}).get("default") or {}).get("aliases"))
            self.assertEqual(services["falky"]["environment"]["FALKY_SIGNALLING_ADDR"], ":7880")
            self.assertEqual(services["falky"]["environment"]["FALKY_LIVEKIT_API_URL"], "http://livekit:7880")
            for name, service in services.items():
                if name != "falky":
                    self.assertNotIn(config["name"] + "-voice", (service.get("networks", {}).get("default") or {}).get("aliases", []))
            self.assertEqual(services["falky"]["environment"]["FALKY_PUBLIC_ORIGIN"], "https://" + domain)
            livekit = services["livekit"]
            self.assertEqual({(p["target"], int(p["published"]), p["protocol"]) for p in livekit["ports"]},
                             {(tcp, tcp, "tcp"), (udp, udp, "udp")})
            for key, value in (("LIVEKIT_RTC_TCP_PORT", tcp),
                               ("LIVEKIT_RTC_UDP_PORT_START", udp), ("LIVEKIT_RTC_UDP_PORT_END", udp)):
                self.assertEqual(int(livekit["environment"][key]), value)
            self.assertEqual(services["falky"]["environment"]["FALKY_ATTACHMENT_ROOT"], "/data/attachments")
            self.assertEqual({m["target"]: m["source"] for m in services["falky"]["volumes"]},
                             {"/data": "falky_data", "/snapshots": "falky_snapshots"})
            volumes = {v["name"] for v in config["volumes"].values()}
            self.assertEqual(volumes, {project + "_falky_data", project + "_falky_snapshots"})
            resources.append((volumes, {config["networks"]["default"]["name"]},
                              {int(p["published"]) for p in livekit["ports"]}))
        for left, right in combinations(resources, 2):
            for left_names, right_names in zip(left, right):
                self.assertTrue(left_names.isdisjoint(right_names))

    def test_local_stack_still_serves_https_directly(self):
        config = render("falky", "localhost", 7881, 7882, production=False)
        self.assertEqual({int(p["published"]) for p in config["services"]["caddy"]["ports"]}, {80, 443})
        mounts = config["services"]["caddy"]["volumes"]
        self.assertTrue(any(m["target"] == "/etc/caddy/Caddyfile" and m["read_only"] for m in mounts))
        self.assertFalse(any(m["target"] == "/etc/caddy/web.caddy" for m in mounts))

    def test_livekit_turn_is_opt_in_and_uses_the_mounted_secret_for_both_transports(self):
        instance = ('falky-staging', 'staging.falky.lunari.win', 7901, 7902)
        disabled = render(*instance)['services']['livekit']
        self.assertEqual(disabled['environment']['FALKY_TURN_HOST'], '')
        self.assertEqual(disabled['volumes'][1]['source'], '/dev/null')
        with tempfile.TemporaryDirectory() as directory:
            secret_file = Path(directory) / 'turn.secret'
            host = 'turn.falky.lunari.win'
            enabled = render(*instance, turn_host=host, turn_secret_file=str(secret_file))['services']['livekit']
            secret_mount = enabled['volumes'][1]
            self.assertEqual(secret_mount['source'], str(secret_file))
            self.assertEqual(secret_mount['target'], '/run/secrets/falky-turn')
            self.assertTrue(secret_mount['read_only'])
            self.assertFalse(secret_mount.get('bind', {}).get('create_host_path', False))
            command = enabled['command'][0].replace('$$', '$').replace(
                '/etc/livekit.yaml', str(ROOT / 'livekit.yaml')).replace(
                '/run/secrets/falky-turn', str(secret_file)).replace(
                'exec /livekit-server --config ' + str(ROOT / 'livekit.yaml'), 'printf "%s" "$LIVEKIT_CONFIG"')
            args = enabled['entrypoint'] + [command]
            environment = enabled['environment']
            missing = subprocess.run(args, env=environment, capture_output=True, text=True)
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn('FALKY_TURN_SECRET_FILE', missing.stderr)
            secret_file.write_text('dummy-shared-secret')
            secret_file.chmod(0o644)
            exposed = subprocess.run(args, env=environment, capture_output=True, text=True)
            self.assertNotEqual(exposed.returncode, 0)
            self.assertIn('must have mode 0400 or 0600', exposed.stderr)
            secret_file.chmod(0o600)
            config = subprocess.check_output(args, env=environment, text=True)
            self.assertIn(f'    - host: "{host}"\n      port: 443\n      protocol: tls', config)
            self.assertIn(f'    - host: "{host}"\n      port: 3478\n      protocol: udp', config)
            self.assertEqual(config.count(f'      secret_file: {secret_file}'), 2)
            self.assertNotIn(secret_file.read_text(), config)
            self.assertIn('http://falky:9090/livekit/webhook', config)

    def test_attachment_defaults_use_the_existing_data_mount(self):
        for production in (False, True):
            config = render("falky", "localhost", 7881, 7882, production=production)
            server = config["services"]["falky"]
            self.assertEqual(server["environment"]["FALKY_ATTACHMENT_ROOT"], "/data/attachments")
            self.assertEqual(server["environment"]["FALKY_ATTACHMENT_POSTED_BYTES"], "5000000000")
            self.assertEqual({m["target"] for m in server["volumes"]}, {"/data", "/snapshots"})

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

if __name__ == "__main__":
    unittest.main()
