"""Backend check reuse against real Git trees and fixture Actions history."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("ci-check.py").resolve()
SPEC = importlib.util.spec_from_file_location("ci_check", SCRIPT)
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)


class BackendCheckTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        previous = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)
        self.git("init", "--quiet")
        self.git("config", "user.email", "check@example.invalid")
        self.git("config", "user.name", "Check Test")
        for name in ("server/app.go", "server/go.sum", "api/openapi.yaml", "web/app.ts",
                     "Makefile", "mise.toml", ".github/workflows/deploy-vps.yml"):
            self.write(name)
        self.baseline = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], stderr=subprocess.PIPE, text=True).strip()

    def write(self, name, content="original\n"):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "fixture")
        return self.git("rev-parse", "HEAD")

    def run_record(self, revision=None, **fields):
        return {"head_sha": revision or self.baseline, "head_branch": "master", "event": "push",
                "status": "completed", "conclusion": "success"} | fields

    def test_frontend_and_documentation_only_changes_reuse_success(self):
        for name in ("web/app.ts", "docs/guide.md", ".agents/guide.md", ".claude/guide.md", "GLOSSARY.md"):
            self.write(name, "changed\n")
        self.commit()
        required, reason = check.decide([self.run_record()])
        self.assertFalse(required)
        self.assertIn(self.baseline[:12], reason)

    def test_release_metadata_only_changes_reuse_success(self):
        for content in ("first release\n", "next release\n"):
            with self.subTest(content=content):
                baseline = self.run_record(self.git("rev-parse", "HEAD"))
                for name in ("CHANGELOG.md", "version.txt", ".release-please-manifest.json"):
                    self.write(name, content)
                self.commit()
                self.assertFalse(check.decide([baseline])[0])

    def test_backend_shared_and_unknown_inputs_require_checks(self):
        for name in ("server/app.go", "server/go.sum", "api/openapi.yaml", "Makefile", "mise.toml",
                     ".github/workflows/deploy-vps.yml", "deploy/ci-check.py", "unknown-input",
                     "release-please-config.json", "release/policy.mjs", "release/package-lock.json",
                     "server/CHANGELOG.md", "release/version.txt", "version.txt.backup"):
            with self.subTest(name=name):
                baseline = self.run_record(self.git("rev-parse", "HEAD"))
                self.write(name, "changed\n")
                self.commit()
                self.assertTrue(check.decide([baseline])[0])

    def test_deletions_renames_and_executable_mode_changes_require_checks(self):
        self.git("mv", "server/app.go", "web/moved.go")
        self.commit()
        self.assertTrue(check.decide([self.run_record()])[0])
        baseline = self.run_record(self.git("rev-parse", "HEAD"))
        (self.root / "server/go.sum").unlink()
        self.commit()
        self.assertTrue(check.decide([baseline])[0])
        baseline = self.run_record(self.git("rev-parse", "HEAD"))
        (self.root / "Makefile").chmod(0o755)
        self.commit()
        self.assertTrue(check.decide([baseline])[0])

    def test_frontend_commit_cannot_hide_an_earlier_failed_backend_change(self):
        self.write("server/app.go", "broken\n")
        failed = self.commit()
        self.write("web/app.ts", "new frontend\n")
        self.commit()
        for conclusion in ("failure", "cancelled", "skipped"):
            with self.subTest(conclusion=conclusion):
                history = [self.run_record(failed, conclusion=conclusion), self.run_record()]
                self.assertTrue(check.decide(history)[0])

    def test_release_metadata_cannot_hide_an_earlier_failed_backend_change(self):
        self.write("server/app.go", "broken\n")
        failed = self.commit()
        for name in ("CHANGELOG.md", "version.txt", ".release-please-manifest.json"):
            self.write(name, "release\n")
        self.commit()
        history = [self.run_record(failed, conclusion="failure"), self.run_record()]
        self.assertTrue(check.decide(history)[0])

    def test_only_successful_completed_master_pushes_can_be_baselines(self):
        for fields in ({"event": "pull_request"}, {"head_branch": "feature"},
                       {"status": "in_progress"}, {"conclusion": "failure"},
                       {"head_sha": "--help"}, {"head_sha": "f" * 40}):
            with self.subTest(fields=fields):
                self.assertTrue(check.decide([self.run_record(**fields)])[0])
        self.assertTrue(check.decide([])[0])

    def test_successful_nonancestor_cannot_skip_checks(self):
        self.write("web/app.ts", "future\n")
        future = self.commit()
        self.git("checkout", "--quiet", self.baseline)
        self.assertTrue(check.decide([self.run_record(future)])[0])
        self.assertFalse(check.decide([self.run_record(future), self.run_record()])[0])

    def test_successful_frontend_release_can_reuse_validated_backend_again(self):
        self.write("web/app.ts", "first\n")
        intermediate = self.commit()
        self.assertFalse(check.decide([self.run_record()])[0])
        self.write("web/app.ts", "second\n")
        self.commit()
        self.assertFalse(check.decide([self.run_record(intermediate)])[0])

    def test_tags_and_unknown_events_always_run_without_querying_history(self):
        with patch.object(check.subprocess, "check_output", side_effect=AssertionError("API not expected")):
            for environment in ({"GITHUB_REF_TYPE": "tag", "GITHUB_EVENT_NAME": "push"},
                                {"GITHUB_EVENT_NAME": "workflow_dispatch"}):
                self.assertTrue(check.plan(environment)[0])

    def test_history_failure_or_malformed_response_runs_full_suite(self):
        environment = {"GITHUB_EVENT_NAME": "push", "GITHUB_REPOSITORY": "example/repo"}
        for response in ("not json", "{}", '{"workflow_runs":null}', '{"workflow_runs":[null]}'):
            with self.subTest(response=response), patch.object(check.subprocess, "check_output", return_value=response):
                self.assertTrue(check.plan(environment)[0])
        for error in (FileNotFoundError(), subprocess.CalledProcessError(1, "gh"),
                      subprocess.TimeoutExpired("gh", 30)):
            with self.subTest(error=error), patch.object(check.subprocess, "check_output", side_effect=error):
                self.assertTrue(check.plan(environment)[0])

    def test_cli_emits_explicit_decision_and_explanation_for_pr_and_push(self):
        self.write("web/app.ts", "changed\n")
        for name in ("CHANGELOG.md", "version.txt", ".release-please-manifest.json"):
            self.write(name, "release\n")
        self.commit()
        binary = self.root / "bin/gh"
        self.write("bin/gh", "#!" + sys.executable + "\nprint(" + repr(json.dumps(
            {"workflow_runs": [self.run_record()]})) + ")\n")
        binary.chmod(0o755)
        for event, ref_type, required in (("pull_request", "branch", False), ("push", "branch", False),
                                          ("push", "tag", True)):
            with self.subTest(event=event, ref_type=ref_type):
                output = self.root / "outputs"
                summary = self.root / "summary"
                output.write_text("")
                summary.write_text("")
                result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True,
                    env=os.environ | {"PATH": str(binary.parent) + os.pathsep + os.environ["PATH"],
                        "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary),
                        "GITHUB_EVENT_NAME": event, "GITHUB_REF_TYPE": ref_type,
                        "GITHUB_REPOSITORY": "example/repo"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(output.read_text(), f"run={str(required).lower()}\n")
                self.assertIn("Backend checks:", summary.read_text())
                self.assertIn("required" if required else "reused", result.stdout)


if __name__ == "__main__":
    unittest.main()
