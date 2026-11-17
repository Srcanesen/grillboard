#!/usr/bin/env python3
"""Write release/grillboard-<version>.zip: the skill folder plus INSTALL.txt.

Usage: python3 tools/package_release.py [version] [output-folder]
The version defaults to the newest git tag without its leading "v".
"""

from pathlib import Path
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SKILL = "skills/grillboard"
INSTALL = """\
GrillBoard {version} - install

GrillBoard is an agent skill. It needs Python 3 and a browser.

1. Copy the "grillboard" folder next to this file into your skills folder.

   For every Claude Code project:

       mkdir -p ~/.claude/skills
       cp -R grillboard ~/.claude/skills/

   For one project only, use that project's .claude/skills/ folder instead.
   Other agents: copy it into the folder your agent reads skills from.

2. Start a new agent session and ask for GrillBoard, for example:
   "Use GrillBoard to grill me about my plan."

To update, delete the old "grillboard" folder and copy the new one.

More: https://github.com/Srcanesen/grillboard
"""


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], check=True,
                          capture_output=True, text=True).stdout


def package(version, out_dir):
    name = f"grillboard-{version}"
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{name}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{name}/INSTALL.txt", INSTALL.format(version=version))
        for path in git("ls-files", "-z", SKILL).split("\0"):
            if path:
                archive.write(ROOT / path, f"{name}/{Path(path).relative_to('skills')}")
    return target


if __name__ == "__main__":
    version = sys.argv[1] if len(sys.argv) > 1 else git("describe", "--tags", "--abbrev=0").strip()
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "release"
    print(package(version.lstrip("v"), out_dir))
