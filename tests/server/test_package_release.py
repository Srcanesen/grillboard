"""Release packaging through its real CLI, using only stdlib."""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]


class PackageReleaseTests(unittest.TestCase):
    def test_failed_rebuild_preserves_complete_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            skill = root / "skills/grillboard"
            skill.mkdir(parents=True)
            source = skill / "server.py"
            source.write_text("# complete release\n", encoding="utf-8")
            (root / "tools").mkdir()
            script = root / "tools/package_release.py"
            shutil.copyfile(ROOT / "tools/package_release.py", script)
            subprocess.run(["git", "init", "-q", str(root)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(root), "add", "skills"], check=True,
                           capture_output=True)
            output = root / "release"
            command = [sys.executable, str(script), "0.2.0", str(output)]
            target = output / "grillboard-0.2.0.zip"
            for _ in range(2):
                result = subprocess.run(command, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                with zipfile.ZipFile(target) as archive:
                    self.assertEqual(archive.read("grillboard-0.2.0/grillboard/server.py"),
                                     b"# complete release\n")
                self.assertEqual(list(output.iterdir()), [target])
            before = target.read_bytes()
            source.unlink()
            for _ in range(2):
                result = subprocess.run(command, capture_output=True)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(b"FileNotFoundError", result.stderr)
                self.assertEqual(target.read_bytes(), before)
                self.assertEqual(list(output.iterdir()), [target])
