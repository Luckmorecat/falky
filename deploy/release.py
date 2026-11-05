"""Plan immutable releases in CI and verify their baseline under the VPS lock.

Host commands are called only by manage.sh while holding .operations.lock.
No state or image is selected from a registry tag or a previous workflow run.
"""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


INSTALLED = (
    "compose.yaml", "compose.production.yaml", "compose.sh", "manage.sh",
    "ci-deploy.sh", "release.py", "prune-backups.py", "Caddyfile",
    "WebCaddyfile", "web.caddy", "livekit.yaml",
)
HOST_CONFIG = (
    "edge/Caddyfile", "edge/compose.yaml", "systemd/falky-backup.service",
    "systemd/falky-backup.timer", "systemd/falky-dev-backup.service",
    "systemd/falky-dev-backup.timer",
)
SERVICES = {"server": "falky", "web": "caddy"}
REPOSITORIES = {"server": "ghcr.io/luckmorecat/falky", "web": "ghcr.io/luckmorecat/falky-web"}
STATE = Path(".release.json")
PENDING = Path(".release-pending.json")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def encode(value):
    return base64.urlsafe_b64encode(canonical(value).encode()).decode()


def decode(value):
    require(len(value) <= 16000 and re.fullmatch(r"[A-Za-z0-9_=-]+", value), "Invalid release encoding")
    return json.loads(base64.b64decode(value, altchars=b"-_", validate=True))


def run(*args):
    # Do not echo captured Compose output: it contains application secrets.
    return subprocess.check_output(args, text=True)


def host_config_path(directory, name):
    if name.startswith("edge/"):
        return directory.resolve().parent / "falky-edge" / Path(name).name
    unit = Path(name).name
    properties = dict(line.split("=", 1) for line in run(
        "systemctl", "show", "--property=FragmentPath", "--property=NeedDaemonReload",
        "--property=DropInPaths", "--", unit).splitlines())
    require(properties["NeedDaemonReload"] == "no", unit + " needs systemctl daemon-reload")
    require(not properties["DropInPaths"], unit + " has untracked systemd overrides")
    path = Path(properties["FragmentPath"])
    require(path.is_absolute() and path.is_file(), unit + " is not installed")
    return path


def file_hashes(directory, *, installed=False):
    hashes = {}
    for name in INSTALLED + HOST_CONFIG:
        path = host_config_path(directory, name) if installed and name in HOST_CONFIG else directory / name
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return digest(hashes)


def source_inputs():
    """Hash tracked build inputs, including deletions, modes and shared policy.

    Only known documentation paths are ignored. Unknown inputs invalidate both
    images. Hashing the complete input tree also covers missed/failed releases.
    """
    entries = {key: [] for key in SERVICES}
    for entry in run("git", "ls-tree", "-r", "-z", "HEAD").split("\0"):
        if not entry:
            continue
        _, name = entry.split("\t", 1)
        if name.startswith(("deploy/edge/", "deploy/systemd/")):
            require(name.removeprefix("deploy/") in HOST_CONFIG,
                    "Unrecognized host configuration; add installed-file verification before releasing: " + name)
        if name.startswith(("docs/", ".agents/", ".claude/")) or name == "GLOSSARY.md":
            continue
        if name.startswith("server/") or name == ".github/workflows/publish-image.yml":
            keys = ["server"]
        elif name.startswith("web/") or name == ".github/workflows/publish-web-image.yml":
            keys = ["web"]
        else:
            keys = SERVICES  # Includes api/, shared tooling and deployment policy.
        for key in keys:
            entries[key].append(entry)
    installed = {}
    for name in INSTALLED + HOST_CONFIG:
        content = subprocess.check_output(["git", "show", "HEAD:deploy/" + name])
        installed[name] = hashlib.sha256(content).hexdigest()
    return {
        "revision": run("git", "rev-parse", "HEAD").strip(),
        "inputs": {key: digest(value) for key, value in entries.items()},
        "installed": digest(installed),
    }


def valid_release(release):
    require(set(release) == {"revision", "installed", "images"}, "Invalid release fields")
    require(re.fullmatch(r"[a-f0-9]{40}", release["revision"]), "Invalid source revision")
    require(re.fullmatch(r"[a-f0-9]{64}", release["installed"]), "Invalid installed-file hash")
    require(set(release["images"]) == set(SERVICES), "Both images are required")
    for key, image in release["images"].items():
        require(set(image) == {"digest", "input", "revision"}, "Invalid image fields")
        require(re.fullmatch(re.escape(REPOSITORIES[key]) + r"@sha256:[a-f0-9]{64}", image["digest"]), "Invalid image digest")
        require(re.fullmatch(r"[a-f0-9]{64}", image["input"]), "Invalid image input hash")
        require(re.fullmatch(r"[a-f0-9]{40}", image["revision"]), "Invalid image revision")


def plan(snapshot, source):
    require(snapshot["installed"] == source["installed"],
            "VPS deployment files differ from this revision; install and reconcile configuration first")
    baseline = snapshot["release"]
    if baseline is not None:
        valid_release(baseline)
    builds = {key: baseline is None or baseline["images"][key]["input"] != source["inputs"][key]
              for key in SERVICES}
    return {"baseline": snapshot, "source": source, "builds": builds}


def check_ancestry(snapshot, source):
    if snapshot["release"] is not None:
        previous = snapshot["release"]["revision"]
        # Full checkout history is required. A rerun of an old push/tag must not
        # silently undo a newer release; rollback is an operator operation.
        result = subprocess.run(["git", "merge-base", "--is-ancestor", previous, source["revision"]],
                                capture_output=True)
        require(result.returncode == 0, "Target does not descend from the deployed release; use explicit recovery")


def resolve(plan_value, results, digests):
    images = {}
    for key, build in plan_value["builds"].items():
        require(results[key] == ("success" if build else "skipped"),
                "Requested builds must succeed; only planned skips may reuse images")
        if build:
            images[key] = {"digest": REPOSITORIES[key] + "@" + digests[key],
                           "input": plan_value["source"]["inputs"][key],
                           "revision": plan_value["source"]["revision"]}
        else:
            images[key] = plan_value["baseline"]["release"]["images"][key]
    release = {"revision": plan_value["source"]["revision"],
               "installed": plan_value["source"]["installed"], "images": images}
    valid_release(release)
    return {"baseline": plan_value["baseline"]["token"], "release": release}


def runtime():
    config = json.loads(run("./compose.sh", "config", "--format", "json"))
    hashes = dict(line.split() for line in run("./compose.sh", "config", "--hash", "*").splitlines())
    containers = {}
    for service in ("falky", "caddy", "livekit"):
        container_id = run("./compose.sh", "ps", "--all", "--quiet", service).strip()
        require(container_id and "\n" not in container_id, "Expected one running " + service + " container")
        container = json.loads(run("docker", "inspect", container_id))[0]
        require(container["State"]["Running"], service + " is not running")
        require(container["Config"]["Image"] == config["services"][service]["image"],
                service + " image differs from persisted configuration")
        require(container["Config"]["Labels"].get("com.docker.compose.config-hash") == hashes[service],
                service + " configuration drift; reconcile it before selective deployment")
        containers[service] = {"id": container["Id"], "image": container["Image"],
                               "started": container["State"]["StartedAt"]}
    installed = file_hashes(Path('.'), installed=True)
    return {"fingerprint": digest({"config": config, "containers": containers, "installed": installed}),
            "installed": installed,
            "images": {key: config["services"][service]["image"] for key, service in SERVICES.items()}}


def snapshot():
    require(not PENDING.exists(), "Unresolved deployment attempt; recover before deploying again")
    current = runtime()
    state = json.loads(STATE.read_text()) if STATE.exists() else None
    if state is not None:
        valid_release(state["release"])
        require(current["fingerprint"] == state["runtime"],
                "VPS differs from its successful release; reconcile before deploying again")
        require(current["images"] == {key: image["digest"] for key, image in state["release"]["images"].items()},
                "Running images differ from the successful release")
    return {"token": digest({"state": state, "runtime": current}),
            "installed": current["installed"], "release": state["release"] if state else None}


def verify(request):
    require(set(request) == {"baseline", "release"}, "Invalid deployment request")
    valid_release(request["release"])
    current = snapshot()
    require(request["baseline"] == current["token"], "Stale release plan; run planning again")
    require(request["release"]["installed"] == current["installed"], "Deployment configuration does not match the release")
    previous = current["release"]
    changed = []
    for key, image in request["release"]["images"].items():
        old = previous["images"][key] if previous else None
        if old is None or image["digest"] != old["digest"]:
            changed.append(SERVICES[key])
        elif image != old:
            raise ValueError("Reused digest must retain its original input hash and build revision")
    # No baseline means a full reconciliation, never a partial first deployment.
    return list(SERVICES.values()) if previous is None else changed


def atomic_write(path, value):
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(canonical(value) + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def finish(request):
    require(json.loads(PENDING.read_text()) == request, "Deployment attempt changed")
    current = runtime()
    require(current["installed"] == request["release"]["installed"],
            "Host configuration changed during deployment; reconcile before recording success")
    require(current["images"] == {key: image["digest"] for key, image in request["release"]["images"].items()},
            "Started images do not match the requested release")
    atomic_write(STATE, {"release": request["release"], "runtime": current["fingerprint"]})
    PENDING.unlink()


def main():
    command = sys.argv[1]
    if command == "plan":
        baseline = json.loads(Path(sys.argv[2]).read_text())
        source = source_inputs()
        value = plan(baseline, source)
        check_ancestry(baseline, source)
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for key, build in value["builds"].items():
                output.write(f"{key}={str(build).lower()}\n")
            output.write(f"changed={str(any(value['builds'].values())).lower()}\nplan={encode(value)}\n")
    elif command == "resolve":
        value = resolve(decode(os.environ["RELEASE_PLAN"]),
                        {key: os.environ[key.upper() + "_RESULT"] for key in SERVICES},
                        {key: os.environ.get(key.upper() + "_DIGEST", "") for key in SERVICES})
        print("deploy-release " + encode(value))
    elif command == "snapshot":
        print(canonical(snapshot()))
    elif command in ("verify", "begin", "finish"):
        request = decode(sys.argv[2])
        if command == "finish":
            finish(request)
        else:
            services = verify(request)
            if command == "begin":
                atomic_write(PENDING, request)
            else:
                for key in SERVICES:
                    print(request["release"]["images"][key]["digest"])
                print(" ".join(services))
    elif command == "manual-begin":
        atomic_write(PENDING, {"manual": True})
    elif command == "manual-finish":
        STATE.unlink(missing_ok=True)
        PENDING.unlink(missing_ok=True)
    else:
        raise ValueError("Unknown release operation")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        print("Release refused: " + str(error), file=sys.stderr)
        sys.exit(1)
