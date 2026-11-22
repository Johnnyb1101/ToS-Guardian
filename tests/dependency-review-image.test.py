"""Offline checks for the registry tarball file measurement."""

import hashlib
import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


HELPER = Path(__file__).resolve().parents[1] / "tools" / "dependency-review-image.py"
SPEC = importlib.util.spec_from_file_location("dependency_review_image", HELPER)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
MANIFEST = b'{"name":"fixture","version":"1.2.3","scripts":{"test":"never run"}}'


class RegistryFiles(unittest.TestCase):
    def measure(self, entries):
        with tempfile.TemporaryDirectory() as scratch:
            archive = Path(scratch) / "fixture.tgz"
            with tarfile.open(archive, mode="w:gz") as tar:
                for name, contents in entries:
                    entry = tarfile.TarInfo(name)
                    if contents is None:
                        entry.type = tarfile.SYMTYPE
                        entry.linkname = "package.json"
                        tar.addfile(entry)
                    else:
                        entry.size = len(contents)
                        tar.addfile(entry, io.BytesIO(contents))
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            return MODULE.inspect_tarball(archive, digest)

    def test_orders_files_and_reports_implicit_install(self):
        entries = [("package/package.json", MANIFEST), ("package/binding.gyp", b"{}")]
        result = self.measure(entries)
        self.assertEqual(result, self.measure(list(reversed(entries))))
        self.assertEqual(result["scripts"], {"implicitInstall": "node-gyp rebuild"})
        self.assertEqual(result["fileCount"], 2)
        changed = self.measure([entries[0], ("package/binding.gyp", b"changed")])
        self.assertNotEqual(changed["fileTreeSha256"], result["fileTreeSha256"])

    def test_rejects_links_duplicates_and_unsafe_paths(self):
        initial = [("package/package.json", MANIFEST)]
        for entry in [("package/link", None), ("package/package.json", b"{}"),
                      ("package/../escape", b""), ("package/node_modules/bundled", b"")]:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                self.measure([*initial, entry])

    def test_generated_bin_matches_its_package_manifest(self):
        helper = SimpleNamespace(open_regular=lambda path: path.open("rb"))
        with tempfile.TemporaryDirectory() as scratch:
            modules = Path(scratch) / "node_modules"
            package = modules / "fixture"
            package.mkdir(parents=True)
            (package / "package.json").write_text('{"name":"fixture","version":"1.2.3","bin":"./bin.js"}')
            (package / "bin.js").write_text("fixture")
            (modules / ".bin").mkdir()
            link = modules / ".bin" / "fixture"
            link.symlink_to("../fixture/bin.js")
            self.assertEqual(len(list(MODULE.image_packages(modules, helper))), 1)
            link.unlink()
            link.symlink_to("../fixture/package.json")
            with self.assertRaisesRegex(ValueError, "differs from package manifest"):
                list(MODULE.image_packages(modules, helper))


if __name__ == "__main__":
    unittest.main()
