"""Exercise deployments with Docker and external HTTPS verification replaced."""

import configparser
import fcntl
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import unittest


SERVER = "ghcr.io/luckmorecat/falky"
WEB = SERVER + "-web"
SERVER_DIGEST = SERVER + "@sha256:" + "a" * 64
WEB_DIGEST = WEB + "@sha256:" + "b" * 64
LOCAL_WEB = "sha256:" + "c" * 64

FAKE_DOCKER = r'''
import json, os, sqlite3, sys
from pathlib import Path

args = sys.argv[1:]
with open("calls.jsonl", "a") as log:
    log.write(json.dumps(args) + "\n")
server = "ghcr.io/luckmorecat/falky"
web = server + "-web"
if args[0] == "pull":
    sys.exit(1 if args[1] == os.environ.get("FAIL_PULL") else 0)
if args[:2] == ["image", "inspect"]:
    image = args[2]
    if image.endswith(":edge"):
        repository = image.removesuffix(":edge")
        digest = "b" * 64 if repository == web else "a" * 64
        # The requested repository need not be the first RepoDigests entry.
        references = ["ghcr.io/unrelated/image@sha256:" + "f" * 64]
        if repository != os.environ.get("MISSING_DIGEST"):
            references.append(repository + "@sha256:" + digest)
        print(json.dumps(references))
    sys.exit(0)
if args[:2] == ["volume", "ls"]:
    if os.environ.get("FAIL_VOLUME_LIST") == "1":
        sys.exit(1)
    if os.environ.get("RETAINED_VOLUME") == "1":
        print(os.environ.get("DATA_VOLUME_NAME", "falky_falky_data"))
    if os.environ.get("SIMILAR_VOLUME") == "1":
        print("falky_falky_data_other")
    sys.exit(0)
if args[0] == "inspect":
    template = args[2]
    if "State.Running" in template:
        print("true")
    elif "Config.Image" in template:
        print(server + "@sha256:" + "d" * 64)
    elif "revision" in template:
        print("e" * 40)
    else:
        print("sha256:" + "c" * 64)
    sys.exit(0)
if args[0] == "compose":
    command = args[7:]
    if command[0] == "config" and "--format" in command:
        env = dict(line.split("=", 1) for line in Path(".env").read_text().splitlines())
        print(json.dumps({"services": {
            "caddy": {
                "image": os.environ.get("FALKY_WEB_IMAGE", env["FALKY_WEB_IMAGE"]),
                "environment": {"FALKY_DOMAIN": "test.invalid"},
            },
            "falky": {
                "image": os.environ.get("FALKY_IMAGE", env["FALKY_IMAGE"]),
                "volumes": [{"type": "volume", "source": "falky_data", "target": "/data"}],
            },
        }, "volumes": {"falky_data": {"name": os.environ.get("DATA_VOLUME_NAME", "falky_falky_data")}}}))
    elif command[0] == "ps" and "--quiet" in command:
        if os.environ.get("FAIL_PS") == "1":
            sys.exit(1)
        if os.environ.get("EXISTING") == "1":
            print(command[-1] + "-container")
    elif command[0] == "exec":
        if command[-1] == "snapshot":
            if os.environ.get("FAIL_SNAPSHOT") == "1":
                sys.exit(1)
            print("/snapshots/falky-20261105T030000Z.db")
        else:
            print(json.dumps({"status": "ok", "components": {"database": "ok", "livekit": "ok"}}))
    elif command[0] == "cp":
        with sqlite3.connect(command[-1]) as db:
            db.execute("CREATE TABLE sample (value TEXT)")
    sys.exit(0)
raise SystemExit("Unexpected Docker call: " + repr(args))
'''


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        source = Path(__file__).parent
        for name in ("manage.sh", "compose.sh", "ci-deploy.sh", "compose.yaml", "compose.production.yaml", "Caddyfile", "livekit.yaml"):
            shutil.copy2(source / name, self.directory / name)
        self.initial = (
            f"FALKY_IMAGE={SERVER}@sha256:{'d' * 64}\n"
            f"FALKY_WEB_IMAGE={LOCAL_WEB}\n"
            "FALKY_DOMAIN=test.invalid\n"
            "FALKY_LIVEKIT_API_SECRET=test-secret-must-survive\n"
        )
        (self.directory / ".env").write_text(self.initial)
        binary = self.directory / "bin"
        binary.mkdir()
        self.write_program(binary / "docker", FAKE_DOCKER)
        self.write_program(binary / "curl", 'print("401")\n')
        # Test deployment selection separately from the network health probe.
        self.write_program(binary / "python3", f'''
import os, sys
if sys.argv[1:] == ["-", "test.invalid"]:
    sys.stdin.read()
    print("Mock external HTTPS verification passed")
else:
    os.execv({sys.executable!r}, [{sys.executable!r}] + sys.argv[1:])
''')
        self.environment = os.environ.copy()
        self.environment["PATH"] = str(binary) + os.pathsep + self.environment["PATH"]

    def write_program(self, path, content):
        path.write_text(f"#!{sys.executable}\n" + content)
        path.chmod(0o755)

    def run_deploy(self, *images, **environment):
        return subprocess.run(
            ["bash", "manage.sh", "deploy", *images],
            cwd=self.directory,
            env=self.environment | environment,
            text=True,
            capture_output=True,
            timeout=15,
        )

    def calls(self):
        path = self.directory / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_untouched(self):
        self.assertEqual((self.directory / ".env").read_text(), self.initial)
        self.assertFalse(any("up" in call or "snapshot" in call for call in self.calls()))

    def test_latest_pins_both_repositories_and_backs_up_before_start(self):
        result = self.run_deploy(EXISTING="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        env = (self.directory / ".env").read_text()
        self.assertIn("FALKY_IMAGE=" + SERVER_DIGEST, env)
        self.assertIn("FALKY_WEB_IMAGE=" + WEB_DIGEST, env)
        self.assertNotIn(":edge", env)
        self.assertIn("test-secret-must-survive", env)
        self.assertEqual((self.directory / ".env").stat().st_mode & 0o777, 0o600)
        calls = self.calls()
        snapshot = next(i for i, call in enumerate(calls) if "snapshot" in call)
        start = next(i for i, call in enumerate(calls) if "up" in call)
        self.assertLess(snapshot, start)
        self.assertEqual(len(list((self.directory / "backups").glob("*/complete"))), 1)

    def test_failed_web_pull_keeps_running_deployment(self):
        result = self.run_deploy(FAIL_PULL=WEB + ":edge", EXISTING="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_untouched()

    def test_failed_server_pull_never_uses_cached_edge(self):
        result = self.run_deploy(FAIL_PULL=SERVER + ":edge")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(call[:2] == ["image", "inspect"] for call in self.calls()))
        self.assert_untouched()

    def test_unrelated_digest_is_not_accepted(self):
        result = self.run_deploy(MISSING_DIGEST=WEB)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no digest for " + WEB, result.stderr)
        self.assert_untouched()

    def test_explicit_server_keeps_existing_frontend(self):
        result = self.run_deploy(SERVER_DIGEST)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("FALKY_WEB_IMAGE=" + LOCAL_WEB, (self.directory / ".env").read_text())
        self.assertFalse(any(":edge" in argument for call in self.calls() for argument in call))

    def test_explicit_frontend_digest_is_selected(self):
        result = self.run_deploy(SERVER_DIGEST, WEB_DIGEST)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("FALKY_WEB_IMAGE=" + WEB_DIGEST, (self.directory / ".env").read_text())

    def test_frontend_deploy_preserves_backend_without_pulling_or_starting_it(self):
        result = self.run_deploy("frontend", EXISTING="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        env = (self.directory / ".env").read_text()
        self.assertIn(f"FALKY_IMAGE={SERVER}@sha256:{'d' * 64}", env)
        self.assertIn("FALKY_WEB_IMAGE=" + WEB_DIGEST, env)
        calls = self.calls()
        self.assertFalse(any(call[0] == "pull" and (call[1] == SERVER + ":edge" or call[1].startswith(SERVER + "@")) for call in calls))
        compose_pulls = [call for call in calls if call[0] == "compose" and call[7] == "pull"]
        self.assertEqual(compose_pulls, [])
        starts = [call[7:] for call in calls if call[0] == "compose" and call[7] == "up"]
        self.assertEqual(len(starts), 1)
        self.assertIn("--no-deps", starts[0])
        self.assertEqual(starts[0][-1], "caddy")

    def test_backend_deploy_preserves_frontend_without_pulling_or_starting_it(self):
        self.initial = self.initial.replace(LOCAL_WEB, WEB_DIGEST)
        (self.directory / ".env").write_text(self.initial)
        result = self.run_deploy("backend")
        self.assertEqual(result.returncode, 0, result.stderr)
        env = (self.directory / ".env").read_text()
        self.assertIn("FALKY_IMAGE=" + SERVER_DIGEST, env)
        self.assertIn("FALKY_WEB_IMAGE=" + WEB_DIGEST, env)
        calls = self.calls()
        self.assertFalse(any(call[0] == "pull" and call[1].startswith(WEB) for call in calls))
        compose_pulls = [call[7:] for call in calls if call[0] == "compose" and call[7] == "pull"]
        self.assertEqual(compose_pulls, [["pull", "falky"]])
        starts = [call[7:] for call in calls if call[0] == "compose" and call[7] == "up"]
        self.assertEqual(len(starts), 1)
        self.assertIn("--no-deps", starts[0])
        self.assertEqual(starts[0][-1], "falky")

    def test_failed_frontend_update_keeps_both_deployed_versions(self):
        result = self.run_deploy("frontend", FAIL_PULL=WEB + ":edge", EXISTING="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_untouched()

    def test_mutable_explicit_image_is_rejected(self):
        result = self.run_deploy(SERVER + ":edge")
        self.assertEqual(result.returncode, 2)
        self.assert_untouched()

    def test_failed_snapshot_preserves_configuration_and_containers(self):
        result = self.run_deploy(EXISTING="1", FAIL_SNAPSHOT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.directory / ".env").read_text(), self.initial)
        self.assertFalse(any("up" in call for call in self.calls()))
        self.assertFalse(list((self.directory / "backups").glob("*/complete")))

    def test_retained_volume_without_container_blocks_every_deploy_mode(self):
        for images in ((), ("backend",), ("frontend",)):
            with self.subTest(images=images):
                result = self.run_deploy(*images, RETAINED_VOLUME="1")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("retained database volume", result.stderr)
                self.assert_untouched()

    def test_retained_volume_uses_configured_name(self):
        result = self.run_deploy("backend", RETAINED_VOLUME="1", DATA_VOLUME_NAME="production-chat-db")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("production-chat-db", result.stderr)
        self.assert_untouched()

    def test_unrelated_volume_does_not_block_fresh_installation(self):
        result = self.run_deploy(SERVER_DIGEST, SIMILAR_VOLUME="1")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_volume_listing_failure_cannot_be_treated_as_fresh_installation(self):
        result = self.run_deploy("backend", FAIL_VOLUME_LIST="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_untouched()

    def test_container_query_failure_cannot_skip_backup(self):
        result = self.run_deploy("backend", FAIL_PS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_untouched()

    def test_scheduled_backup_waits_for_busy_lock_then_takes_snapshot(self):
        unit = configparser.ConfigParser(interpolation=None)
        unit.read(Path(__file__).with_name("systemd") / "falky-backup.service")
        environment = dict(value.split("=", 1) for value in shlex.split(unit["Service"].get("Environment", "")))
        lock_wait = float(environment.get("FALKY_LOCK_WAIT_SECONDS", "0"))
        self.assertGreater(float(unit["Service"]["TimeoutStartSec"]), lock_wait)
        with (self.directory / ".operations.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            process = subprocess.Popen(
                ["bash", "manage.sh", "backup"], cwd=self.directory,
                env=self.environment | environment | {"EXISTING": "1"},
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )

            def stop_process():
                if process.poll() is None:
                    process.kill()
                process.communicate()

            self.addCleanup(stop_process)
            try:
                stdout, stderr = process.communicate(timeout=0.2)
            except subprocess.TimeoutExpired:
                self.assertEqual(self.calls(), [], "Backup touched Docker before acquiring the lock")
            else:
                self.fail(f"Scheduled backup exited before the lock was released: {stdout} {stderr}")
            fcntl.flock(lock, fcntl.LOCK_UN)
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(len(list((self.directory / "backups").glob("*/complete"))), 1)


class CICommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        shutil.copy2(Path(__file__).with_name("ci-deploy.sh"), self.directory / "ci-deploy.sh")
        management = self.directory / "manage.sh"
        management.write_text(
            '#!/bin/sh\nprintf "%s %s\\n" "$*" "$FALKY_LOCK_WAIT_SECONDS"\n'
        )
        management.chmod(0o755)

    def command(self, command):
        return subprocess.run(
            ["bash", "ci-deploy.sh"], cwd=self.directory,
            env=os.environ | {"SSH_ORIGINAL_COMMAND": command},
            text=True, capture_output=True, timeout=5,
        )

    def test_deploy_uses_management_script_and_waits_for_lock(self):
        result = self.command("deploy")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "deploy 900\n")

    def test_component_commands_are_forwarded_exactly(self):
        for component in ("backend", "frontend"):
            with self.subTest(component=component):
                result = self.command("deploy " + component)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "deploy " + component + " 900\n")

    def test_status_is_available_for_connection_checks(self):
        result = self.command("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "status 900\n")

    def test_arbitrary_shell_commands_and_file_transfers_are_rejected(self):
        for command in ("", "id", "deploy; id", "deploy\nid", "deploy extra", "deploy frontend; id", "deploy backend extra", "scp -t /srv/falky", "internal-sftp"):
            with self.subTest(command=command):
                result = self.command(command)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
