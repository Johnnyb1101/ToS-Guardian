"""Measure dependency files without running the image or extracting npm tarballs."""

import gzip
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import types
from pathlib import Path


MAX_PACKAGE = 128 * 1024 * 1024
MAX_MANIFEST = 4 * 1024 * 1024
MAX_ENTRIES = 20_000
LIFECYCLE = ("preinstall", "install", "postinstall")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def json_object(data):
    def unique(pairs):
        result = dict(pairs)
        require(len(result) == len(pairs), "Duplicate JSON key")
        return result

    def reject(_value):
        raise ValueError("Non-finite JSON value")

    return json.loads(data.decode("utf-8"), object_pairs_hook=unique, parse_constant=reject)


def relative_parts(name):
    parts = name.split("/")
    require(all(part not in ("", ".", "..") for part in parts) and "\\" not in name
            and all(ord(char) >= 32 for char in name), "Unsafe package member path")
    return parts


def fingerprint(files):
    rows = [[name, *files[name]] for name in sorted(files)]
    encoded = json.dumps(rows, ensure_ascii=True, separators=(",", ":")).encode()
    return {"fileCount": len(rows), "fileTreeSha256": hashlib.sha256(encoded).hexdigest()}


def digest_file(source, size):
    require(0 <= size <= MAX_PACKAGE, "Package file exceeded its size bound")
    digest = hashlib.sha256()
    remaining = size
    while remaining:
        block = source.read(min(remaining, 1024 * 1024))
        require(bool(block), "Truncated package file")
        digest.update(block)
        remaining -= len(block)
    require(not source.read(1), "Package file exceeded its declared size")
    return [size, digest.hexdigest()]


def installed_files(package, helper):
    files = {}

    def fail(error):
        raise error

    for root, dirs, names in os.walk(package, followlinks=False, onerror=fail):
        parent = Path(root)
        for directory in dirs:
            require(not (parent / directory).is_symlink(), "Linked package directory")
        if parent == package and "node_modules" in dirs:
            dirs.remove("node_modules")
        for name in names:
            file = parent / name
            relative = file.relative_to(package).as_posix()
            relative_parts(relative)
            with helper.open_regular(file) as source:
                files[relative] = digest_file(source, os.fstat(source.fileno()).st_size)
        require(len(files) <= MAX_ENTRIES, "Too many installed package files")
    return fingerprint(files)


def declare_bins(package, identity, commands):
    declared = identity.get("bin", {})
    if isinstance(declared, str):
        declared = {identity["name"].split("/")[-1]: declared}
    require(isinstance(declared, dict), "Invalid package bin declaration")
    for command, target in declared.items():
        require(isinstance(target, str) and len(relative_parts(command)) == 1, "Invalid package bin declaration")
        destination = package.joinpath(*relative_parts(target.removeprefix("./")))
        commands.setdefault(command, set()).add(destination)


def image_packages(modules, helper):
    require(modules.is_dir() and not modules.is_symlink(), "Missing regular image node_modules")
    commands = {}
    generated = None
    for entry in sorted(modules.iterdir()):
        if entry.name == ".package-lock.json":
            require(stat.S_ISREG(entry.lstat().st_mode), "Unexpected installed npm lock type")
            continue
        if entry.name == ".cache":
            require(entry.is_dir() and not entry.is_symlink() and not any(entry.iterdir()),
                    "Unexpected content in generated npm cache")
            continue
        if entry.name == ".bin":
            require(entry.is_dir() and not entry.is_symlink(), "Unexpected npm bin directory type")
            generated = entry
            continue
        require(not entry.name.startswith(".") and entry.is_dir() and not entry.is_symlink(),
                "Unexpected installed dependency entry")
        for package in sorted(entry.iterdir()) if entry.name.startswith("@") else (entry,):
            require(package.is_dir() and not package.is_symlink(), "Linked or invalid installed package")
            with helper.open_regular(package / "package.json") as file:
                manifest = file.read(MAX_MANIFEST + 1)
            require(len(manifest) <= MAX_MANIFEST, "Installed manifest exceeded its size bound")
            identity = json_object(manifest)
            declare_bins(package, identity, commands)
            yield package, identity, installed_files(package, helper)
            nested = package / "node_modules"
            if nested.exists() or nested.is_symlink():
                yield from image_packages(nested, helper)
    if generated is not None:
        for link in generated.iterdir():
            require(link.is_symlink() and not os.path.isabs(os.readlink(link)), "Invalid generated npm bin link")
            target = link.resolve(strict=True)
            require(target in commands.get(link.name, ()) and target.is_file(), "npm bin link differs from package manifest")


def inspect_image(entry, directory, helper, umoci):
    archive = directory / "archive.tar"
    helper.verified_copy(helper.absolute_path(entry["archivePath"]), archive, helper.MAX_ARCHIVE,
                         entry["sha256"], entry["bytes"])
    layout = directory / "oci"
    blobs = helper.unpack_layout(archive, layout)
    archive.unlink()
    helper.select_manifest(layout, blobs, entry["manifestDigest"])
    bundle = directory / "bundle"
    subprocess.run([*helper.UNSHARE, str(umoci), "unpack", "--image", f"{layout}:approved",
                    str(bundle)], env=helper.ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=True, timeout=300)
    rootfs = bundle / "rootfs"
    app = rootfs / "app"
    require(all(item.is_dir() and not item.is_symlink() for item in (rootfs, app)),
            "Missing image application directory")
    with helper.open_regular(app / "package-lock.json") as file:
        raw_lock = file.read(MAX_MANIFEST + 1)
    require(len(raw_lock) <= MAX_MANIFEST, "Image lockfile exceeded its size bound")
    installed = [{"path": package.relative_to(app).as_posix(), "name": identity["name"],
                  "version": identity["version"], **measured}
                 for package, identity, measured in image_packages(app / "node_modules", helper)]
    return {"lockfile": json_object(raw_lock), "lockfileSha256": hashlib.sha256(raw_lock).hexdigest(),
            "installed": installed}


def inspect_images(input_data, helper_path):
    require(sys.platform == "linux" and os.geteuid() == 0, "OCI inspection requires isolated Linux unpacking")
    source = helper_path.read_bytes()
    require(hashlib.sha256(source).hexdigest() == input_data["imageLauncherSha256"],
            "Pinned OCI launcher identity changed")
    helper = types.ModuleType("image_helper")
    exec(compile(source, str(helper_path), "exec"), helper.__dict__)
    with tempfile.TemporaryDirectory(prefix="tos-dependency-review-", dir="/var/tmp") as directory:
        scratch = Path(directory)
        umoci = scratch / "umoci"
        helper.verified_copy(helper.absolute_path(input_data["umociPath"]), umoci,
                             64 * 1024 * 1024, input_data["umociSha256"])
        umoci.chmod(0o700)
        measured = []
        for index, image in enumerate(input_data["images"]):
            with tempfile.TemporaryDirectory(prefix=f"image-{index}-", dir=scratch) as image_directory:
                measured.append(inspect_image(image, Path(image_directory), helper, umoci))
        return measured


class BoundedStream:
    def __init__(self, stream):
        self.stream = stream
        self.remaining = MAX_PACKAGE

    def read(self, size):
        require(0 <= size <= MAX_PACKAGE, "Invalid tarball read size")
        block = self.stream.read(min(size, self.remaining + 1))
        self.remaining -= len(block)
        require(self.remaining >= 0, "Expanded registry tarball exceeded its size bound")
        return block


def inspect_tarball(path, expected):
    with path.open("rb") as file:
        raw = file.read(MAX_PACKAGE + 1)
    require(len(raw) <= MAX_PACKAGE and hashlib.sha256(raw).hexdigest() == expected,
            "Registry tarball attachment changed")
    files = {}
    entries = set()
    manifest = None
    # Members are streamed and hashed. No paths supplied by the tarball are written.
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as expanded:
        stream = BoundedStream(expanded)
        with tarfile.open(fileobj=stream, mode="r|", errorlevel=2) as bundle:
            for member in bundle:
                name = member.name.removesuffix("/") if member.isdir() else member.name
                parts = relative_parts(name)
                require(parts[0] == "package" and (member.isdir() or member.isfile())
                        and member.type != tarfile.GNUTYPE_SPARSE and not member.sparse,
                        "Unsupported registry tarball entry")
                require(name not in entries and len(entries) < MAX_ENTRIES, "Duplicate or excessive tar entries")
                entries.add(name)
                if member.isdir():
                    continue
                require(len(parts) > 1 and parts[1] != "node_modules", "Unsupported bundled dependency")
                relative = "/".join(parts[1:])
                with bundle.extractfile(member) as source:
                    if relative == "package.json":
                        require(member.size <= MAX_MANIFEST, "Registry manifest exceeded its size bound")
                        data = source.read()
                        require(len(data) == member.size, "Truncated registry manifest")
                        manifest = json_object(data)
                        files[relative] = [len(data), hashlib.sha256(data).hexdigest()]
                    else:
                        files[relative] = digest_file(source, member.size)
        # Drain through the gzip footer, including any trailing tar padding.
        while stream.read(64 * 1024):
            pass
    require(isinstance(manifest, dict), "Missing registry package manifest")
    scripts = manifest.get("scripts", {})
    require(isinstance(scripts, dict), "Invalid package lifecycle scripts")
    lifecycle = {name: scripts[name] for name in LIFECYCLE if name in scripts}
    require(all(isinstance(command, str) for command in lifecycle.values()), "Invalid lifecycle command")
    if "binding.gyp" in files and not ({"install", "preinstall"} & lifecycle.keys()):
        lifecycle["implicitInstall"] = "node-gyp rebuild"
    return {"name": manifest["name"], "version": manifest["version"],
            "scripts": lifecycle, **fingerprint(files)}


def main():
    raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    require(len(raw) <= 4 * 1024 * 1024, "Dependency helper input exceeded its size bound")
    data = json_object(raw)
    if sys.argv[1:] == ["images"]:
        result = inspect_images(data, Path(__file__).with_name("maintenance-observed-image.py"))
    elif sys.argv[1:] == ["tarballs"]:
        result = [inspect_tarball(Path(entry["path"]), entry["sha256"]) for entry in data]
    else:
        raise ValueError("Expected images or tarballs mode")
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, tarfile.TarError) as error:
        sys.exit(str(error))
