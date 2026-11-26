import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import shutil
import statistics
import subprocess
import tempfile
import time

DESKTOP = Path(__file__).resolve().parent.parent
PERF = DESKTOP / ".perf"
RESULT = re.compile(r"falky-(perf|golden|backend) (\S+)(?: (\S+))?\s*$")
WORKSPACE_TESTS = {"falky-core": "core-scoreboard", "falky-desktop": "desktop-scoreboard"}


def build(destination):
    destination.mkdir(parents=True, exist_ok=True)
    command = [
        "cargo", "+stable", "test", "--release", "--workspace", "--locked",
        "--no-run", "--message-format=json",
    ]
    artifacts = {}
    with (destination / "build.log").open("w") as log:
        with subprocess.Popen(command, cwd=DESKTOP, stdout=subprocess.PIPE, text=True) as cargo:
            for line in cargo.stdout:
                log.write(line)
                item = json.loads(line)
                target = item.get("target", {})
                binary = item.get("executable")
                if binary and target.get("kind") == ["lib"] and item["profile"]["test"]:
                    artifacts[target["name"].replace("_", "-")] = Path(binary)
                rendered = item.get("message", {}).get("rendered")
                if rendered:
                    print(rendered, end="", flush=True)
            if cargo.wait():
                raise RuntimeError(f"scoreboard compile failed, see {log.name}")
    for package, stem in WORKSPACE_TESTS.items():
        copy_binary(artifacts[package], destination / stem)
    subprocess.run(
        ["cargo", "+stable", "build", "--release", "--workspace", "--locked"],
        cwd=DESKTOP,
        check=True,
    )
    app = DESKTOP / "target" / "release" / "falky-desktop"
    copy_binary(app, destination / "falky-desktop")


def copy_binary(source, dest):
    if dest.exists():
        dest.unlink()
    shutil.copy2(source, dest)


def capture_run(binaries, export, process_tier):
    export.mkdir(parents=True, exist_ok=False)
    environment = dict(
        os.environ, LP_NUM_THREADS="2", WGPU_BACKEND="vulkan", TZ="UTC",
        FALKY_PERF_GOLDENS=str(export), MESA_SHADER_CACHE_DISABLE="true",
    )
    metrics, hashes = {}, {}
    backend = None
    for binary in WORKSPACE_TESTS.values():
        with (export / f"{binary}.log").open("w") as log:
            result = subprocess.run(
                [binaries / binary, "scoreboard_", "--ignored", "--nocapture", "--test-threads=1"],
                cwd=DESKTOP, env=environment, stdout=log, stderr=subprocess.STDOUT,
                timeout=120,
            )
            if result.returncode:
                raise RuntimeError(f"scoreboard test failed, see {log.name}")
        for line in (export / f"{binary}.log").read_text().splitlines():
            match = RESULT.search(line)
            if not match:
                continue
            kind, name, value = match.groups()
            if kind == "perf":
                assert name not in metrics, name
                metrics[name] = float(value)
            elif kind == "golden":
                assert name not in hashes, name
                hashes[name] = value
            else:
                backend = name
    assert backend and metrics and hashes
    if process_tier:
        values, screenshot = signin_process(binaries / "falky-desktop", environment, export)
        metrics.update(values)
        hashes["process.signin"] = hashlib.sha256(screenshot).hexdigest()
    output = {"backend": backend, "metrics": metrics, "goldens": hashes}
    (export / "metrics.json").write_text(json.dumps(output, indent=2, sort_keys=True) + "\n")
    return output


def signin_process(executable, environment, export):
    with tempfile.TemporaryDirectory(prefix="falky-scoreboard-") as temp:
        scratch = Path(temp)
        for directory in ["home", "config", "data", "cache", "state", "run"]:
            (scratch / directory).mkdir(mode=0o700)
        process_env = dict(environment)
        process_env.pop("WAYLAND_DISPLAY", None)
        process_env.pop("DBUS_SESSION_BUS_ADDRESS", None)
        process_env.update({
            "HOME": str(scratch / "home"),
            "XDG_CONFIG_HOME": str(scratch / "config"),
            "XDG_DATA_HOME": str(scratch / "data"),
            "XDG_CACHE_HOME": str(scratch / "cache"),
            "XDG_STATE_HOME": str(scratch / "state"),
            "XDG_RUNTIME_DIR": str(scratch / "run"),
        })
        with (export / "xvfb.log").open("wb") as log:
            with subprocess.Popen(
                ["Xvfb", "-displayfd", "1", "-screen", "0", "1400x900x24", "-nolisten", "tcp"],
                stdout=subprocess.PIPE, stderr=log, env=process_env,
            ) as xvfb:
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(xvfb.stdout, selectors.EVENT_READ)
                        if not selector.select(timeout=5):
                            raise RuntimeError("Xvfb failed to start")
                    process_env["DISPLAY"] = ":" + xvfb.stdout.readline().decode().strip()
                    return observe_signin(executable, process_env, export)
                finally:
                    terminate(xvfb)


def observe_signin(executable, environment, export):
    def x11(*command):
        return subprocess.check_output(command, env=environment, stderr=subprocess.PIPE, timeout=5)

    def pixels(window, *options):
        return x11("import", "-silent", "-window", window, *options, "-depth", "8", "rgb:-")

    with (export / "signin.log").open("wb") as log:
        began = time.monotonic()
        with subprocess.Popen([executable], stdout=log, stderr=log, env=environment) as app:
            try:
                drew = None
                while time.monotonic() - began < 10 and app.poll() is None:
                    found = re.search(rb'(0x[0-9a-f]+) "Falky":', x11("xwininfo", "-root", "-tree"))
                    if found:
                        window = found.group(1).decode()
                        try:
                            part = pixels(window, "-crop", "180x180+420+220")
                        except subprocess.CalledProcessError:
                            time.sleep(0.01)
                            continue
                        colors = set(zip(part[0::3], part[1::3], part[2::3]))
                        if len(colors) > 1:
                            drew = time.monotonic()
                            break
                    time.sleep(0.01)
                if drew is None:
                    raise RuntimeError(f"sign-in first frame not observed, see {log.name}")
                time.sleep(0.5)
                screenshot = pixels(window)
                (export / "signin.rgb").write_bytes(screenshot)
                time.sleep(0.5)
                began_window = time.monotonic()
                start = cpu_ticks(app.pid)
                time.sleep(2)
                end = cpu_ticks(app.pid)
                elapsed = time.monotonic() - began_window
                return {
                    "process.signin.cold_start_ms": (drew - began) * 1_000,
                    "process.signin.cpu_pct": ((end - start) / os.sysconf("SC_CLK_TCK")) / elapsed * 100,
                    "process.signin.pss_kib": pss(app.pid),
                }, screenshot
            finally:
                terminate(app)


def cpu_ticks(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return int(fields[11]) + int(fields[12])


def pss(pid):
    data = Path(f"/proc/{pid}/smaps_rollup").read_text()
    return int(re.search(r"^Pss:\s+(\d+) kB", data, re.MULTILINE).group(1))


def terminate(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def delta(before, after):
    if before:
        return (after - before) / before
    return math.inf if after else 0.0


def aggregate(pairs, a_against_a):
    first = pairs[0][0]
    metrics = first["metrics"]
    goldens = first["goldens"]
    mismatches = set()
    for pair in pairs:
        for run in pair:
            assert run["backend"] == first["backend"], "renderer changed"
            assert run["metrics"].keys() == metrics.keys(), "metric set changed"
            assert run["goldens"].keys() == goldens.keys(), "golden set changed"
            mismatches.update(key for key in goldens if run["goldens"][key] != goldens[key])
    table = {}
    for name in sorted(metrics):
        left = [run_a["metrics"][name] for run_a, _ in pairs]
        right = [run_b["metrics"][name] for _, run_b in pairs]
        paired = [delta(a, b) for a, b in zip(left, right)]
        values = {
            "a": statistics.median(left),
            "b": statistics.median(right),
            "paired_delta_pct": statistics.median(paired) * 100,
        }
        if a_against_a:
            values["noise_floor_pct"] = max(map(abs, paired)) * 100
        table[name] = values
    return {"metrics": table, "golden_mismatches": sorted(mismatches), "goldens": goldens}


def main():
    cli = argparse.ArgumentParser()
    sub = cli.add_subparsers(dest="action", required=True)
    sub.add_parser("build").add_argument("output", type=Path)
    sub.add_parser("signin").add_argument("binary", type=Path)
    run = sub.add_parser("run")
    run.add_argument("a", type=Path)
    run.add_argument("b", type=Path)
    run.add_argument("output", type=Path)
    run.add_argument("--count", type=int, default=5)
    run.add_argument("--process", action="store_true")
    args = cli.parse_args()
    if args.action == "build":
        build(args.output.resolve())
    elif args.action == "signin":
        with tempfile.TemporaryDirectory(prefix="falky-signin-", dir=PERF) as scratch:
            results, _ = signin_process(args.binary.resolve(), os.environ, Path(scratch))
            print(results)
    else:
        run_a, run_b, output = args.a.resolve(), args.b.resolve(), args.output.resolve()
        output.mkdir(parents=True, exist_ok=False)
        pairs = []
        for i in range(args.count):
            pairs.append((
                capture_run(run_a, output / f"{i + 1:02}-A", args.process),
                capture_run(run_b, output / f"{i + 1:02}-B", args.process),
            ))
            print(f"pair {i + 1} of {args.count}", flush=True)
        summary = aggregate(pairs, run_a == run_b)
        (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(f"{len(summary['metrics'])} metrics and {len(summary['goldens'])} goldens")
        if summary["golden_mismatches"]:
            print("Golden differences:", ", ".join(summary["golden_mismatches"]))


if __name__ == "__main__":
    main()
