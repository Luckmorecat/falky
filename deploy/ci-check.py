"""Reuse backend validation only from a successful ancestor on master.

This is CI-only: it never reads or changes the VPS release record. Unknown
files invalidate backend checks; tags always run the full check suite.
"""

import json
import os
from pathlib import Path
import re
import subprocess


def git(*args):
    return subprocess.check_output(["git", *args])


def backend_input(path):
    return not (path.startswith((b"web/", b"docs/", b".agents/", b".claude/"))
                or path in (b"AGENTS.md", b"GLOSSARY.md", b"CHANGELOG.md", b"version.txt",
                            b".release-please-manifest.json"))


def decide(runs):
    for run in runs:
        if (run.get("event") != "push" or run.get("head_branch") != "master"
                or run.get("status") != "completed" or run.get("conclusion") != "success"):
            continue
        revision = run.get("head_sha", "")
        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            continue
        ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", revision, "HEAD"],
                                  capture_output=True)
        if ancestor.returncode != 0:
            continue
        # Compare the complete trees, not just the latest commit or PR diff.
        # --no-renames ensures moves out of server/ retain their deleted path.
        paths = git("diff", "--name-only", "--no-renames", "-z", revision, "HEAD").split(b"\0")
        if any(backend_input(path) for path in paths if path):
            return True, "Backend or shared inputs changed since successful master " + revision[:12]
        return False, "Backend inputs match successful master " + revision[:12]
    return True, "No successful master ancestor is available"


def plan(environment):
    if environment.get("GITHUB_REF_TYPE") == "tag":
        return True, "Version tags always run backend checks"
    if environment.get("GITHUB_EVENT_NAME") not in ("push", "pull_request"):
        return True, "Unknown event requires backend checks"
    try:
        repository = environment["GITHUB_REPOSITORY"]
        response = subprocess.check_output([
            "gh", "api", f"repos/{repository}/actions/workflows/deploy-vps.yml/runs"
            "?branch=master&event=push&status=success&per_page=30",
        ], text=True, stderr=subprocess.PIPE, timeout=30)
        return decide(json.loads(response)["workflow_runs"])
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, AttributeError):
        return True, "Could not verify a successful baseline; running backend checks"


def main():
    required, reason = plan(os.environ)
    message = f"Backend checks: {'required' if required else 'reused'}. {reason}."
    print(message)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"run={str(required).lower()}\n")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(summary).open("a") as output:
            output.write(message + "\n")


if __name__ == "__main__":
    main()
