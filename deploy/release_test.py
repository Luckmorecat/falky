"""Release decisions and the locked deployment interface, without a real VPS."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import manage_test
import release


def source():
    return {"revision": "a" * 40, "installed": "f" * 64,
            "inputs": {"server": "1" * 64, "web": "2" * 64}}


def initial_plan():
    return release.plan({"token": "0" * 64, "installed": "f" * 64, "release": None}, source())


def built(plan):
    return release.resolve(plan, {key: "success" if build else "skipped" for key, build in plan["builds"].items()},
                           {"server": "sha256:" + "a" * 64, "web": "sha256:" + "b" * 64})


class PlanningTests(unittest.TestCase):
    def baseline(self):
        return {"token": "0" * 64, "installed": "f" * 64, "release": built(initial_plan())["release"]}

    def test_missing_baseline_builds_both(self):
        self.assertEqual(initial_plan()["builds"], {"server": True, "web": True})

    def test_frontend_and_backend_changes_reuse_the_other_digest_and_provenance(self):
        for changed in release.SERVICES:
            with self.subTest(changed=changed):
                target = source()
                target["revision"] = "c" * 40
                target["inputs"][changed] = "3" * 64
                baseline = self.baseline()
                plan = release.plan(baseline, target)
                other = "web" if changed == "server" else "server"
                self.assertEqual(plan["builds"], {changed: True, other: False})
                request = built(plan)
                self.assertEqual(request["release"]["images"][other], baseline["release"]["images"][other])
                self.assertEqual(request["release"]["images"][changed]["revision"], target["revision"])

    def test_docs_only_revision_skips_both(self):
        target = source() | {"revision": "c" * 40}
        self.assertEqual(release.plan(self.baseline(), target)["builds"], {"server": False, "web": False})

    def test_failed_backend_release_followed_by_frontend_change_builds_both(self):
        target = source()
        target["inputs"] = {"server": "3" * 64, "web": "4" * 64}
        # A failed intermediate run never replaces the successful baseline.
        self.assertEqual(release.plan(self.baseline(), target)["builds"], {"server": True, "web": True})

    def test_environments_use_their_own_baselines(self):
        target = source()
        target["inputs"]["web"] = "3" * 64
        production = self.baseline()
        development = production | {"release": built(release.plan(production, target))["release"]}
        self.assertTrue(release.plan(production, target)["builds"]["web"])
        self.assertFalse(release.plan(development, target)["builds"]["web"])

    def test_installed_configuration_mismatch_blocks_planning(self):
        with self.assertRaisesRegex(ValueError, "install and reconcile"):
            release.plan(self.baseline(), source() | {"installed": "e" * 64})

    def test_failed_cancelled_or_unexpectedly_skipped_build_cannot_deploy(self):
        for result in ("failure", "cancelled", "skipped", ""):
            with self.subTest(result=result), self.assertRaises(ValueError):
                release.resolve(initial_plan(), {"server": result, "web": "success"},
                                {"server": "sha256:" + "a" * 64, "web": "sha256:" + "b" * 64})

    def test_unexpected_success_cannot_be_substituted_for_planned_reuse(self):
        plan = release.plan(self.baseline(), source())
        with self.assertRaises(ValueError):
            release.resolve(plan, {"server": "success", "web": "skipped"}, {})

    def test_missing_digest_mutable_tag_and_wrong_repository_are_rejected(self):
        for value in ("", "latest", "ghcr.io/other/repo@sha256:" + "a" * 64):
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.resolve(initial_plan(), {"server": "success", "web": "success"},
                                {"server": value, "web": "sha256:" + "b" * 64})


class InputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "--quiet")
        self.git("config", "user.name", "Release Test")
        self.git("config", "user.email", "release-test@example.invalid")
        for name in release.INSTALLED:
            self.write("deploy/" + name, "installed\n")
        for folder in ("edge", "systemd"):
            for path in (Path(__file__).parent / folder).iterdir():
                self.write("deploy/" + folder + "/" + path.name, "installed\n")
        for name in ("server/app.go", "web/app.ts", "api/openapi.yaml", "docs/guide.md"):
            self.write(name, "original\n")
        self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True, stderr=subprocess.PIPE)

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "fixture")

    def inputs(self):
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            return release.source_inputs()
        finally:
            os.chdir(previous)

    def test_real_git_trees_classify_changes_and_deletions(self):
        for name, expected in (("web/app.ts", {"web"}), ("server/app.go", {"server"}),
                               ("api/openapi.yaml", {"web", "server"}),
                               ("Makefile", {"web", "server"}),
                               ("unknown-input", {"web", "server"}),
                               ("docs/guide.md", set())):
            with self.subTest(name=name):
                before = self.inputs()
                self.write(name, "changed\n")
                self.commit()
                after = self.inputs()
                self.assertEqual({key for key in release.SERVICES if before["inputs"][key] != after["inputs"][key]}, expected)
        before = self.inputs()
        (self.root / "server/app.go").unlink()
        self.commit()
        after = self.inputs()
        self.assertNotEqual(before["inputs"]["server"], after["inputs"]["server"])
        self.assertEqual(before["inputs"]["web"], after["inputs"]["web"])

    def test_host_file_hash_agrees_with_committed_files_and_detects_drift(self):
        self.assertEqual(self.inputs()["installed"], release.file_hashes(self.root / "deploy"))
        self.write("deploy/web.caddy", "drift\n")
        self.assertNotEqual(self.inputs()["installed"], release.file_hashes(self.root / "deploy"))

    def test_external_host_configuration_cannot_take_application_only_path(self):
        for name in ("edge/Caddyfile", "edge/compose.yaml", "systemd/falky-backup.service",
                     "systemd/falky-backup.timer", "systemd/falky-dev-backup.service",
                     "systemd/falky-dev-backup.timer"):
            with self.subTest(name=name):
                before = self.inputs()
                baseline = {"token": "0" * 64, "installed": before["installed"], "release": None}
                self.write("deploy/" + name, "updated host configuration\n")
                self.commit()
                with self.assertRaisesRegex(ValueError, "install and reconcile"):
                    release.plan(baseline, self.inputs())

    def test_new_host_configuration_requires_an_explicit_verification_mapping(self):
        self.write("deploy/systemd/new-backup.timer", "new unit\n")
        self.commit()
        with self.assertRaisesRegex(ValueError, "Unrecognized host configuration"):
            self.inputs()

    def test_old_reruns_and_unavailable_history_cannot_roll_back_a_release(self):
        old = self.inputs()
        self.write("web/app.ts", "new\n")
        self.commit()
        new = self.inputs()
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            release.check_ancestry({"release": {"revision": old["revision"]}}, new)
            for revision in (new["revision"], "f" * 40):
                with self.subTest(revision=revision), self.assertRaisesRegex(ValueError, "does not descend"):
                    release.check_ancestry({"release": {"revision": revision}}, old)
        finally:
            os.chdir(previous)

    def test_ci_plan_outputs_and_resolver_round_trip(self):
        inputs = self.inputs()
        snapshot = {"token": "0" * 64, "installed": inputs["installed"], "release": None}
        baseline_path = self.root / "baseline.json"
        baseline_path.write_text(json.dumps(snapshot))
        output = self.root / "outputs"
        script = str(Path(release.__file__).resolve())
        planned = subprocess.run([sys.executable, script, "plan", str(baseline_path)], cwd=self.root,
                                 env=os.environ | {"GITHUB_OUTPUT": str(output)}, capture_output=True, text=True)
        self.assertEqual(planned.returncode, 0, planned.stderr)
        values = dict(line.split("=", 1) for line in output.read_text().splitlines())
        self.assertEqual([values[key] for key in ("server", "web", "changed")], ["true"] * 3)
        resolved = subprocess.run([sys.executable, script, "resolve"], cwd=self.root, capture_output=True, text=True,
                                  env=os.environ | {"RELEASE_PLAN": values["plan"],
                                      "SERVER_RESULT": "success", "WEB_RESULT": "success",
                                      "SERVER_DIGEST": "sha256:" + "a" * 64, "WEB_DIGEST": "sha256:" + "b" * 64})
        self.assertEqual(resolved.returncode, 0, resolved.stderr)
        command, encoded = resolved.stdout.strip().split()
        self.assertEqual(command, "deploy-release")
        request = release.decode(encoded)
        self.assertEqual(request["baseline"], snapshot["token"])
        release.valid_release(request["release"])

    def ci_plan(self, snapshot, ref_type):
        script = str(Path(release.__file__).with_name("ci-plan.py").resolve())
        with tempfile.TemporaryDirectory() as directory:
            baseline = Path(directory) / "baseline.json"
            baseline.write_text(json.dumps(snapshot))
            output = Path(directory) / "outputs"
            result = subprocess.run([sys.executable, script, str(baseline)], cwd=self.root,
                                    env=os.environ | {"GITHUB_OUTPUT": str(output), "GITHUB_REF_TYPE": ref_type},
                                    capture_output=True, text=True)
            values = dict(line.split("=", 1) for line in output.read_text().splitlines()) if output.exists() else {}
        return result, values

    def successful_baseline(self):
        inputs = self.inputs()
        snapshot = {"token": "0" * 64, "installed": inputs["installed"], "release": None}
        return snapshot | {"release": built(release.plan(snapshot, inputs))["release"]}

    def test_tags_always_publish_both_while_branches_remain_selective(self):
        for paths, expected in (((), set()), (("docs/guide.md",), set()),
                                (("web/app.ts",), {"web"}), (("server/app.go",), {"server"}),
                                (("web/app.ts", "server/app.go"), {"server", "web"})):
            with self.subTest(paths=paths):
                baseline = self.successful_baseline()
                for path in paths:
                    self.write(path, self.git("rev-parse", "HEAD"))
                if paths:
                    self.commit()
                for ref_type in ("branch", "tag"):
                    with self.subTest(ref_type=ref_type):
                        result, values = self.ci_plan(baseline, ref_type)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        builds = set(release.SERVICES) if ref_type == "tag" else expected
                        self.assertEqual({key for key in release.SERVICES if values[key] == "true"}, builds)
                        self.assertEqual(values["changed"], str(bool(builds)).lower())
                        plan = release.decode(values["plan"])
                        request = release.resolve(plan,
                            {key: "success" if key in builds else "skipped" for key in release.SERVICES},
                            {"server": "sha256:" + "c" * 64, "web": "sha256:" + "d" * 64})
                        self.assertEqual(request["baseline"], baseline["token"])
                        if ref_type == "tag":
                            for key, image in request["release"]["images"].items():
                                self.assertNotEqual(image["digest"], baseline["release"]["images"][key]["digest"])
                                self.assertEqual(image["revision"], self.inputs()["revision"])
                                for failure in ("failure", "cancelled", "skipped"):
                                    results = dict.fromkeys(release.SERVICES, "success") | {key: failure}
                                    with self.assertRaisesRegex(ValueError, "Requested builds must succeed"):
                                        release.resolve(plan, results,
                                            {"server": "sha256:" + "c" * 64, "web": "sha256:" + "d" * 64})

    def test_tag_plan_without_baseline_publishes_both(self):
        inputs = self.inputs()
        result, values = self.ci_plan({"token": "0" * 64, "installed": inputs["installed"], "release": None}, "tag")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([values[key] for key in ("server", "web", "changed")], ["true"] * 3)

    def test_tag_planning_still_blocks_host_mismatch_and_rollback(self):
        baseline = self.successful_baseline()
        result, values = self.ci_plan(baseline | {"installed": "e" * 64}, "tag")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("install and reconcile", result.stderr)
        self.assertEqual(values, {})
        old = self.git("rev-parse", "HEAD").strip()
        self.write("web/app.ts", "new version\n")
        self.commit()
        baseline = self.successful_baseline()
        self.git("checkout", "--quiet", old)
        result, values = self.ci_plan(baseline, "tag")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not descend", result.stderr)
        self.assertEqual(values, {})


class DeploymentTests(unittest.TestCase):
    setUp = manage_test.DeploymentTests.setUp
    write_program = manage_test.DeploymentTests.write_program
    calls = manage_test.DeploymentTests.calls
    run_deploy = manage_test.DeploymentTests.run_deploy

    def command(self, *args, **environment):
        return subprocess.run(["bash", "manage.sh", *args], cwd=self.directory,
                              env=self.environment | {"EXISTING": "1"} | environment,
                              text=True, capture_output=True, timeout=30)

    def snapshot(self):
        result = self.command("release")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("test-secret-must-survive", result.stdout)
        return json.loads(result.stdout)

    def request(self, snapshot, changed=None):
        target = source() | {"installed": snapshot["installed"]}
        if changed:
            target["revision"] = "c" * 40
            target["inputs"][changed] = "3" * 64
        plan = release.plan(snapshot, target)
        digests = {key: "sha256:" + ("9" if key == changed else ("a" if key == "server" else "b")) * 64
                   for key in release.SERVICES}
        return release.resolve(plan, {key: "success" if build else "skipped" for key, build in plan["builds"].items()}, digests)

    def apply(self, request, **environment):
        return self.command("deploy-release", release.encode(request), **environment)

    def bootstrap(self):
        result = self.apply(self.request(self.snapshot()))
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.snapshot()

    def state(self):
        return (self.directory / ".release.json").read_bytes()

    def test_each_single_image_release_leaves_other_container_and_livekit_unchanged(self):
        self.bootstrap()
        for changed in ("web", "server"):
            with self.subTest(changed=changed):
                before = json.loads((self.directory / "running.json").read_text())
                request = self.request(self.snapshot(), changed)
                # Preserve the already-deployed other image's input fingerprint.
                other = "server" if changed == "web" else "web"
                request["release"]["images"][other] = json.loads(self.state())["release"]["images"][other]
                offset = len(self.calls())
                result = self.apply(request)
                self.assertEqual(result.returncode, 0, result.stderr)
                after = json.loads((self.directory / "running.json").read_text())
                self.assertEqual(before[release.SERVICES[other]], after[release.SERVICES[other]])
                self.assertEqual(before["livekit"], after["livekit"])
                self.assertNotEqual(before[release.SERVICES[changed]]["Id"], after[release.SERVICES[changed]]["Id"])
                starts = [call for call in self.calls()[offset:] if "up" in call]
                self.assertEqual(len(starts), 1)
                self.assertIn("--no-deps", starts[0])
                self.assertEqual(starts[0][-1], release.SERVICES[changed])
                self.assertEqual((self.directory / ".release.json").stat().st_mode & 0o777, 0o600)

    def test_first_release_builds_and_updates_both(self):
        self.bootstrap()
        start = next(call for call in self.calls() if "up" in call)
        self.assertEqual(start[-2:], ["falky", "caddy"])

    def test_stale_plan_is_rejected_without_pull_backup_or_restart(self):
        baseline = self.bootstrap()
        stale = self.request(baseline, "server")
        self.assertEqual(self.apply(self.request(baseline, "web")).returncode, 0)
        state = self.state()
        offset = len(self.calls())
        result = self.apply(stale)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Stale release plan", result.stderr)
        self.assertEqual(self.state(), state)
        self.assertFalse(any("up" in call or "snapshot" in call or "pull" in call for call in self.calls()[offset:]))

    def test_pull_and_backup_failures_preserve_baseline_and_do_not_leave_pending_attempt(self):
        baseline = self.bootstrap()
        request = self.request(baseline, "web")
        state = self.state()
        for failure in ({"FAIL_PULL": request["release"]["images"]["web"]["digest"]}, {"FAIL_SNAPSHOT": "1"}):
            with self.subTest(failure=failure):
                result = self.apply(request, **failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.state(), state)
                self.assertFalse((self.directory / ".release-pending.json").exists())
                self.assertEqual(self.snapshot(), baseline)

    def test_start_failure_preserves_success_record_and_blocks_next_release(self):
        baseline = self.bootstrap()
        state = self.state()
        result = self.apply(self.request(baseline, "web"), FAIL_UP="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state(), state)
        self.assertTrue((self.directory / ".release-pending.json").exists())
        blocked = self.command("release")
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn("Unresolved deployment attempt", blocked.stderr)

    def test_health_failure_preserves_success_record_and_pending_attempt(self):
        baseline = self.bootstrap()
        state = self.state()
        self.write_program(self.directory / "bin/sleep", "pass\n")
        result = self.apply(self.request(baseline, "web"), FAIL_HEALTH_AFTER_UP="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state(), state)
        self.assertTrue((self.directory / ".release-pending.json").exists())

    def test_manual_recovery_clears_baseline_only_after_success(self):
        baseline = self.bootstrap()
        self.apply(self.request(baseline, "web"), FAIL_UP="1")
        result = self.run_deploy(EXISTING="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.directory / ".release-pending.json").exists())
        self.assertIsNone(self.snapshot()["release"])

    def test_configuration_and_container_drift_block_reuse(self):
        self.bootstrap()
        path = self.directory / "web.caddy"
        original = path.read_bytes()
        path.write_text("changed on host")
        result = self.command("release")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs from its successful release", result.stderr)
        path.write_bytes(original)
        state = json.loads((self.directory / "running.json").read_text())
        state["falky"]["Config"]["Image"] = manage_test.SERVER + ":latest"
        (self.directory / "running.json").write_text(json.dumps(state))
        result = self.command("release")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("image differs", result.stderr)

    def test_external_host_file_drift_blocks_release_before_pull_or_backup(self):
        baseline = self.bootstrap()
        request = self.request(baseline, "web")
        for relative in ("falky-edge/Caddyfile", "falky-edge/compose.yaml",
                         "systemd/falky-backup.service", "systemd/falky-backup.timer",
                         "systemd/falky-dev-backup.service", "systemd/falky-dev-backup.timer"):
            with self.subTest(path=relative):
                path = self.directory.parent / relative
                original = path.read_bytes()
                path.write_bytes(original + b"\n# local drift\n")
                offset = len(self.calls())
                result = self.apply(request)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("differs from its successful release", result.stderr)
                self.assertFalse(any("up" in call or "snapshot" in call or "pull" in call
                                     for call in self.calls()[offset:]))
                path.write_bytes(original)
        self.assertEqual(self.snapshot(), baseline)

    def test_missing_host_files_unloaded_units_and_overrides_block_snapshot(self):
        # This must fail even at bootstrap, when there is no successful record.
        for relative in ("falky-edge/Caddyfile", "systemd/falky-backup.timer"):
            with self.subTest(path=relative):
                path = self.directory.parent / relative
                original = path.read_bytes()
                path.unlink()
                result = self.command("release")
                self.assertNotEqual(result.returncode, 0)
                path.write_bytes(original)
        for environment, message in (({"SYSTEMD_NEEDS_RELOAD": "yes"}, "daemon-reload"),
                                     ({"SYSTEMD_OVERRIDES": "/untracked/override.conf"}, "untracked systemd overrides")):
            with self.subTest(environment=environment):
                result = self.command("release", **environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
        self.assertIsNone(self.snapshot()["release"])

    def test_host_configuration_change_during_deployment_cannot_record_success(self):
        baseline = self.bootstrap()
        previous = self.state()
        result = self.apply(self.request(baseline, "web"), DRIFT_HOST_CONFIG_ON_UP="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Host configuration changed during deployment", result.stderr)
        self.assertEqual(self.state(), previous)
        self.assertTrue((self.directory / ".release-pending.json").exists())

    def test_reused_digest_cannot_claim_different_build_inputs(self):
        baseline = self.bootstrap()
        request = self.request(baseline, "web")
        request["release"]["images"]["server"]["input"] = "8" * 64
        result = self.apply(request)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Reused digest", result.stderr)

    def test_noop_request_does_not_backup_or_restart(self):
        baseline = self.bootstrap()
        offset = len(self.calls())
        result = self.apply(self.request(baseline))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no changed images", result.stderr)
        self.assertFalse(any("up" in call or "snapshot" in call for call in self.calls()[offset:]))

    def test_env_drift_and_unhealthy_unchanged_container_block_selective_deploy(self):
        baseline = self.bootstrap()
        request = self.request(baseline, "web")
        env_path = self.directory / ".env"
        original = env_path.read_text()
        env_path.write_text(original.replace("test-secret-must-survive", "changed-secret"))
        result = self.apply(request)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("configuration drift", result.stderr)
        env_path.write_text(original)
        state = json.loads((self.directory / "running.json").read_text())
        state["livekit"]["State"]["Running"] = False
        (self.directory / "running.json").write_text(json.dumps(state))
        result = self.apply(request)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("livekit is not running", result.stderr)

    def test_invalid_payload_cannot_execute_commands(self):
        for value in ("!", release.encode({"baseline": "x", "release": {}}),
                      release.encode({"baseline": "x", "release": "$(touch hacked)"})):
            result = self.command("deploy-release", value)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.directory / "hacked").exists())


if __name__ == "__main__":
    unittest.main()
