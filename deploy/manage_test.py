"""Exercise deployments with Docker and external HTTPS verification replaced."""

import json
import os
from pathlib import Path
import shutil
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
        print(json.dumps({"services": {"caddy": {
            "image": os.environ.get("FALKY_WEB_IMAGE", env["FALKY_WEB_IMAGE"]),
            "environment": {"FALKY_DOMAIN": "test.invalid"},
        }}}))
    elif command[0] == "ps" and "--quiet" in command:
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


class CICommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        shutil.copy2(Path(__file__).with_name("ci-deploy.sh"), self.directory / "ci-deploy.sh")
        management = self.directory / "manage.sh"
        management.write_text(
            '#!/bin/sh\nprintf "%s %s\\n" "$1" "$FALKY_LOCK_WAIT_SECONDS"\n'
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
        self.assertEqual(result.stdout, "deploy 300\n")

    def test_status_is_available_for_connection_checks(self):
        result = self.command("status")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "status 300\n")

    def test_arbitrary_shell_commands_and_file_transfers_are_rejected(self):
        for command in ("", "id", "deploy; id", "deploy\nid", "deploy extra", "scp -t /srv/falky", "internal-sftp"):
            with self.subTest(command=command):
                result = self.command(command)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
