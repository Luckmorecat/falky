"""Exercise deployments with Docker and external HTTPS verification replaced."""

import configparser
from contextlib import closing
import fcntl
import json
import os
from pathlib import Path
import shutil
import shlex
import sqlite3
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
from contextlib import closing
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
    sys.exit(0)
if args[:2] == ["volume", "ls"]:
    if os.environ.get("FAIL_VOLUME_LIST") == "1":
        sys.exit(1)
    if os.environ.get("RETAINED_VOLUME") == "1":
        print(os.environ.get("DATA_VOLUME_NAME", "falky_falky_data"))
    if os.environ.get("SIMILAR_VOLUME") == "1":
        print("falky_falky_data_other")
    sys.exit(0)
if args[:2] == ["volume", "inspect"]:
    sys.exit(1 if os.environ.get("MISSING_SNAPSHOT_VOLUME") == "1" else 0)
if args[0] == "inspect":
    template = args[2]
    if ".Mounts" in template:
        print(json.dumps([{"Destination": "/snapshots", "Type": "volume", "Name": "falky_falky_snapshots"}]))
    elif "json .Image" in template:
        print(json.dumps("sha256:" + "c" * 64))
    elif "State.Running" in template:
        print("true")
    elif "Config.Image" in template:
        print(server + "@sha256:" + "d" * 64)
    elif "revision" in template:
        print("e" * 40)
    else:
        print("sha256:" + "c" * 64)
    sys.exit(0)
if args[0] == "run":
    index = args.index("--entrypoint")
    entrypoint = args[index + 1]
    operands = args[index + 3:]
    root = Path("snapshot-volume")
    if entrypoint == "find":
        for path in sorted(root.iterdir()):
            if path.is_file() and not path.is_symlink():
                sys.stdout.write("/snapshots/" + path.name + "\0")
    elif entrypoint == "rm":
        if os.environ.get("FAIL_PRUNE") == "1":
            sys.exit(1)
        assert operands[0] == "--"
        for path in operands[1:]:
            assert Path(path).parent == Path("/snapshots")
            (root / Path(path).name).unlink()
    else:
        raise SystemExit("Unexpected retention helper: " + entrypoint)
    sys.exit(0)
if args[0] == "compose":
    command = args[7:]
    if command[0] == "pull" and os.environ.get("FAIL_SERVER_PULL") == "1":
        sys.exit(1)
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
            root = Path("snapshot-volume")
            root.mkdir(exist_ok=True)
            (root / "falky-20261105T030000Z.db").write_bytes(b"snapshot")
            print("/snapshots/falky-20261105T030000Z.db")
        else:
            print(json.dumps({"status": "ok", "components": {"database": "ok", "livekit": "ok"}}))
    elif command[0] == "cp":
        if os.environ.get("CORRUPT_COPY") == "1":
            Path(command[-1]).write_bytes(b"not a SQLite snapshot")
        else:
            with closing(sqlite3.connect(command[-1])) as db:
                db.execute("CREATE TABLE sample (value TEXT)")
                db.commit()
    sys.exit(0)
raise SystemExit("Unexpected Docker call: " + repr(args))
'''


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        source = Path(__file__).parent
        for name in ("manage.sh", "compose.sh", "ci-deploy.sh", "prune-backups.py", "compose.yaml", "compose.production.yaml", "Caddyfile", "WebCaddyfile", "livekit.yaml"):
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
            ["bash", "manage.sh", "deploy", *(images or (SERVER_DIGEST, WEB_DIGEST))],
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

    def test_release_pins_both_repositories_and_backs_up_before_start(self):
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

    def seed_backups(self, count, day="20261104"):
        root = self.directory / "backups"
        snapshots = self.directory / "snapshot-volume"
        root.mkdir(exist_ok=True)
        snapshots.mkdir(exist_ok=True)
        directories = []
        for index in range(count):
            timestamp = f"{day}T{index:06d}Z"
            path = root / f"{timestamp}-{index:06d}"
            path.mkdir()
            with closing(sqlite3.connect(path / "database.db")) as db:
                db.execute("CREATE TABLE sample (value TEXT)")
                db.commit()
            name = f"falky-{timestamp}.db"
            (path / "snapshot.txt").write_text("/snapshots/" + name + "\n")
            (path / "complete").touch()
            (snapshots / name).write_bytes((path / "database.db").read_bytes())
            directories.append(path)
        return directories

    def test_successful_backup_keeps_ten_newest_bundles_and_original_snapshots(self):
        older = self.seed_backups(15)
        result = self.run_deploy(EXISTING="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(not path.exists() for path in older[:6]))
        self.assertTrue(all(path.is_dir() for path in older[6:]))
        self.assertEqual(len(list((self.directory / "backups").glob("*/complete"))), 10)
        self.assertEqual(len(list((self.directory / "snapshot-volume").glob("*.db"))), 10)
        snapshots = {path.name for path in (self.directory / "snapshot-volume").iterdir()}
        self.assertIn("falky-20261105T030000Z.db", snapshots)
        self.assertNotIn("falky-20261104T000000Z.db", snapshots)

    def test_retention_preserves_incomplete_backups_unrelated_files_and_symlinks(self):
        older = self.seed_backups(10)
        root = self.directory / "backups"
        incomplete = root / "20261101T000000Z-abcdef"
        incomplete.mkdir()
        (incomplete / "database.db").write_bytes(b"incomplete")
        outside = self.directory / "outside"
        outside.mkdir()
        (outside / "database.db").write_bytes(b"keep")
        link = root / "20261101T000001Z-abcdef"
        link.symlink_to(outside, target_is_directory=True)
        unrelated = self.directory / "snapshot-volume" / "keep.txt"
        unrelated.write_text("keep")
        result = self.run_deploy(EXISTING="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(older[0].exists())
        self.assertTrue(incomplete.is_dir())
        self.assertTrue(link.is_symlink())
        self.assertEqual((outside / "database.db").read_bytes(), b"keep")
        self.assertEqual(unrelated.read_text(), "keep")

    def test_failed_snapshot_or_integrity_check_never_prunes_older_backups(self):
        older = self.seed_backups(15)
        for failure in ("FAIL_SNAPSHOT", "CORRUPT_COPY"):
            with self.subTest(failure=failure):
                result = self.run_deploy(EXISTING="1", **{failure: "1"})
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(all(path.is_dir() for path in older))
                self.assertEqual(len(list((self.directory / "backups").glob("*/complete"))), 15)
                self.assertFalse(any("rm" in call for call in self.calls()))

    def test_snapshot_cleanup_failure_keeps_all_backup_bundles_and_blocks_deploy(self):
        older = self.seed_backups(15)
        result = self.run_deploy(EXISTING="1", FAIL_PRUNE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(all(path.is_dir() for path in older))
        self.assertEqual(len(list((self.directory / "backups").glob("*/complete"))), 16)
        self.assertEqual((self.directory / ".env").read_text(), self.initial)
        self.assertFalse(any("up" in call for call in self.calls()))

    def test_missing_snapshot_volume_does_not_create_replacement_or_remove_bundles(self):
        older = self.seed_backups(15)
        result = self.run_deploy(EXISTING="1", MISSING_SNAPSHOT_VOLUME="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(all(path.is_dir() for path in older))
        self.assertFalse(any(call[0] == "run" for call in self.calls()))

    def test_retention_always_preserves_new_backup_even_after_clock_moves_back(self):
        self.seed_backups(15, day="20991104")
        result = self.run_deploy(EXISTING="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        backups = list((self.directory / "backups").glob("*/complete"))
        self.assertEqual(len(backups), 10)
        self.assertTrue(any("20991104" not in path.parent.name for path in backups))
        self.assertTrue((self.directory / "snapshot-volume" / "falky-20261105T030000Z.db").is_file())

    def test_failed_pull_keeps_running_deployment(self):
        result = self.run_deploy(FAIL_PULL=WEB_DIGEST, EXISTING="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_untouched()

    def test_failed_server_pull_keeps_running_deployment(self):
        result = self.run_deploy(FAIL_SERVER_PULL="1", EXISTING="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_untouched()

    def test_release_never_resolves_mutable_tags(self):
        result = self.run_deploy(SERVER_DIGEST, WEB_DIGEST)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(":edge" in argument for call in self.calls() for argument in call))

    def test_mutable_or_partial_release_is_rejected(self):
        for images in ((SERVER + ":edge", WEB_DIGEST), (SERVER_DIGEST,), ("backend",), ("frontend",)):
            with self.subTest(images=images):
                result = self.run_deploy(*images)
                self.assertEqual(result.returncode, 2)
                self.assert_untouched()

    def test_no_argument_deploy_is_rejected(self):
        result = subprocess.run(["bash", "manage.sh", "deploy"], cwd=self.directory,
                                env=self.environment, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assert_untouched()

    def test_failed_snapshot_preserves_configuration_and_containers(self):
        result = self.run_deploy(EXISTING="1", FAIL_SNAPSHOT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.directory / ".env").read_text(), self.initial)
        self.assertFalse(any("up" in call for call in self.calls()))
        self.assertFalse(list((self.directory / "backups").glob("*/complete")))

    def test_retained_volume_without_container_blocks_release(self):
        result = self.run_deploy(RETAINED_VOLUME="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("retained database volume", result.stderr)
        self.assert_untouched()

    def test_retained_volume_uses_configured_name(self):
        result = self.run_deploy(RETAINED_VOLUME="1", DATA_VOLUME_NAME="production-chat-db")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("production-chat-db", result.stderr)
        self.assert_untouched()

    def test_unrelated_volume_does_not_block_fresh_installation(self):
        result = self.run_deploy(SERVER_DIGEST, WEB_DIGEST, SIMILAR_VOLUME="1")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_volume_listing_failure_cannot_be_treated_as_fresh_installation(self):
        result = self.run_deploy(FAIL_VOLUME_LIST="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_untouched()

    def test_container_query_failure_cannot_skip_backup(self):
        result = self.run_deploy(FAIL_PS="1")
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

    def test_deploy_forwards_exact_digests_and_waits_for_lock(self):
        command = f"deploy {SERVER_DIGEST} {WEB_DIGEST}"
        result = self.command(command)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, command + " 900\n")

    def test_tags_partial_releases_and_injected_commands_are_rejected(self):
        for command in ("deploy", "deploy backend", "deploy frontend",
                        f"deploy {SERVER}:edge {WEB_DIGEST}",
                        f"deploy {SERVER_DIGEST}",
                        f"deploy {SERVER_DIGEST} {WEB_DIGEST}; id",
                        f"deploy {SERVER_DIGEST} {WEB_DIGEST}\nstatus",
                        f"deploy {WEB_DIGEST} {SERVER_DIGEST}"):
            with self.subTest(command=command):
                self.assertEqual(self.command(command).returncode, 2)

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
