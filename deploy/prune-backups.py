"""Keep ten completed backup bundles and ten original database snapshots."""

import json
from pathlib import Path
import re
import shutil
import subprocess
import sys


KEEP = 10
BUNDLE_NAME = re.compile(r"[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]{6}")
SNAPSHOT_PATH = re.compile(r"/snapshots/falky-[0-9]{8}T[0-9]{6}Z\.db")


def completed_bundle(path):
    if path.is_symlink() or not path.is_dir() or not BUNDLE_NAME.fullmatch(path.name):
        return False
    return all(
        not (path / name).is_symlink() and (path / name).is_file()
        for name in ("complete", "database.db", "snapshot.txt")
    )


def docker_json(template, container):
    output = subprocess.check_output(["docker", "inspect", "--format", template, container])
    return json.loads(output)


def prune(current, backend, image):
    root = Path("backups").resolve()
    current = current.resolve()
    # Only a freshly completed, verified backup can initiate deletion.
    if current.parent != root or not completed_bundle(current):
        raise ValueError("Retention requires a completed backup in backups/")
    snapshot = (current / "snapshot.txt").read_text().strip()
    if not SNAPSHOT_PATH.fullmatch(snapshot):
        raise ValueError("Unexpected current snapshot path")
    bundles = sorted(path for path in root.iterdir() if completed_bundle(path) and path != current)
    pending_path = Path('.deploy/state.json')
    pending = json.loads(pending_path.read_text()).get('pending') if pending_path.exists() else None
    pinned = (Path(pending['backup']).resolve() if pending and pending.get('backup') else None)
    old_bundles = [path for path in bundles[:max(0, len(bundles) - (KEEP - 1))] if path != pinned]

    mounts = docker_json("{{json .Mounts}}", backend)
    mounts = [mount for mount in mounts if mount["Destination"] == "/snapshots"]
    if len(mounts) != 1 or mounts[0]["Type"] != "volume":
        raise ValueError("Cannot identify the running snapshot volume")
    volume = mounts[0]["Name"]
    # Docker must not create a replacement volume for a missing source.
    subprocess.run(["docker", "volume", "inspect", volume], check=True, stdout=subprocess.DEVNULL)
    if not re.fullmatch(r"caddy:[0-9.]+@sha256:[a-f0-9]{64}", image):
        raise ValueError("Retention requires a pinned helper image")
    subprocess.run(["docker", "image", "inspect", image], check=True, stdout=subprocess.DEVNULL)

    helper = [
        "docker", "run", "--rm", "--pull", "never", "--network", "none",
        "--read-only", "--cap-drop", "ALL", "--user", "65532:65532",
    ]
    listing = subprocess.check_output(helper + [
        "--mount", f"type=volume,source={volume},target=/snapshots,readonly",
        "--entrypoint", "find", image,
        "/snapshots", "-mindepth", "1", "-maxdepth", "1", "-type", "f", "-print0",
    ])
    snapshots = sorted(
        path for path in listing.decode(errors="surrogateescape").split("\0") if SNAPSHOT_PATH.fullmatch(path)
    )
    if snapshot not in snapshots:
        raise ValueError("Current snapshot is absent; refusing retention cleanup")
    others = [path for path in snapshots if path != snapshot]
    old_snapshots = others[:max(0, len(others) - (KEEP - 1))]
    # Finish Docker cleanup before deleting any complete backup bundles.
    if old_snapshots:
        subprocess.run(helper + [
            "--mount", f"type=volume,source={volume},target=/snapshots",
            "--entrypoint", "rm", image, "--", *old_snapshots,
        ], check=True)
    for directory in old_bundles:
        shutil.rmtree(directory)
    print(f"Retention: removed {len(old_bundles)} old backups and {len(old_snapshots)} old snapshots")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: prune-backups.py completed-backup backend-container immutable-helper-image")
    prune(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
