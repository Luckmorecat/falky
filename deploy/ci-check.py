"""Reuse component validation only from a successful ancestor on master.

This is CI-only: it never reads or changes the VPS release record. Unknown
files invalidate checks; tags always run the full check suite.
"""

import argparse
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
                            b".release-please-manifest.json", b"deploy/ci-check_test.py",
                            b"deploy/ci-plan_test.py", b"deploy/manage_test.py",
                            b"deploy/release_test.py", b"deploy/config_test.py"))


def deployment_input(path):
    # These suites use fixture Git trees and fake applications, not app sources.
    # Deployment/release code, workflows, tools and unknown paths remain inputs.
    return not (path.startswith((b"server/", b"web/", b"api/", b"docs/", b".agents/", b".claude/"))
                or path in (b"AGENTS.md", b"GLOSSARY.md", b"README.md", b"CHANGELOG.md",
                            b"version.txt", b".release-please-manifest.json"))


def decide(runs, component="server"):
    is_input = {"server": backend_input, "deploy": deployment_input}[component]
    label = "Backend" if component == "server" else "Deployment"
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
        # --no-renames keeps a deleted input visible when moved to an ignored path.
        paths = git("diff", "--name-only", "--no-renames", "-z", revision, "HEAD").split(b"\0")
        if any(is_input(path) for path in paths if path):
            return True, label + " or shared inputs changed since successful master " + revision[:12]
        return False, label + " inputs match successful master " + revision[:12]
    return True, "No successful master ancestor is available"


def plan(environment, component="server"):
    label = "backend" if component == "server" else "deployment"
    if environment.get("GITHUB_REF_TYPE") == "tag":
        return True, "Version tags always run " + label + " checks"
    if environment.get("GITHUB_EVENT_NAME") not in ("push", "pull_request"):
        return True, "Unknown event requires " + label + " checks"
    try:
        repository = environment["GITHUB_REPOSITORY"]
        response = subprocess.check_output([
            "gh", "api", f"repos/{repository}/actions/workflows/deploy-vps.yml/runs"
            "?branch=master&event=push&status=success&per_page=30",
        ], text=True, stderr=subprocess.PIPE, timeout=30)
        return decide(json.loads(response)["workflow_runs"], component)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, AttributeError):
        return True, "Could not verify a successful baseline; running " + label + " checks"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", nargs="?", choices=("server", "deploy"), default="server")
    component = parser.parse_args().component
    required, reason = plan(os.environ, component)
    label = "Backend" if component == "server" else "Deployment"
    message = f"{label} checks: {'required' if required else 'reused'}. {reason}."
    print(message)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"run={str(required).lower()}\n")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(summary).open("a") as output:
            output.write(message + "\n")


if __name__ == "__main__":
    main()
