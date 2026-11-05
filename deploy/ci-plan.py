"""CI publishing policy; the installed VPS release protocol stays unchanged."""

import json
import os
from pathlib import Path
import sys

import release


def main():
    baseline = json.loads(Path(sys.argv[1]).read_text())
    source = release.source_inputs()
    value = release.plan(baseline, source)
    release.check_ancestry(baseline, source)
    # Version tags always publish both images, even for identical build inputs.
    # The baseline still protects deployment against drift and stale plans.
    if os.environ["GITHUB_REF_TYPE"] == "tag":
        value["builds"] = dict.fromkeys(release.SERVICES, True)
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for key, build in value["builds"].items():
            output.write(f"{key}={str(build).lower()}\n")
        output.write(f"changed={str(any(value['builds'].values())).lower()}\nplan={release.encode(value)}\n")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        sys.exit(str(error))
