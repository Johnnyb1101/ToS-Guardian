"""Verify approved OCI archives and shape requests inside their offline runtimes."""

import ctypes
import errno
import gzip
import hashlib
import json
import os
import platform
import re
import resource
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


MAX_LINE = 2_000_000
MAX_METADATA = 4_000_000
MAX_ARCHIVE = 1_000_000_000
MAX_UNCOMPRESSED = 8_000_000_000
HASH = re.compile(r"[0-9a-f]{64}")
EXEC_DIRECTORY = re.compile(r"/[A-Za-z0-9_./+-]+")
EOF = object()
BUILDER_MOUNT = "/.tos-observed-builder"
BUILDER_FILES = {
    "tools/maintenance-observed-runner.js",
    "tools/final-corpus-lib.js",
    "tools/maintenance-final-evidence.js",
    "tools/maintenance-openai-contract.js",
    "tools/maintenance-observed-budget.js",
    "tools/maintenance-local-path.js",
    "tools/maintenance-evaluation-lib.js",
    "tools/sites-lib.js",
    "tools/doctype.js",
    "vendor/tldts-7.4.8.umd.min.js",
}
ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
UNSHARE = ["/usr/bin/unshare", "--mount", "--propagation", "private", "--net",
           "--pid", "--fork", "--kill-child=SIGKILL", "--"]
NODE_SCRIPT = """
const fs = require('node:fs');
const path = require('node:path');
const { createImageRequestBuilder } =
  require('/.tos-observed-builder/tools/maintenance-observed-runner.js');
const build = createImageRequestBuilder('/app');
if (process.argv[1] === 'probe') {
  const npm = require(path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/package.json')).version;
  if (process.platform !== 'linux' || process.arch !== 'x64' ||
      !/^v[0-9]+\\.[0-9]+\\.[0-9]+$/.test(process.version) ||
      !/^[0-9]+\\.[0-9]+\\.[0-9]+$/.test(npm)) process.exit(1);
  process.stdout.write('true');
} else {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(build(input)));
}
"""


class InvalidImage(Exception):
    pass


def require(condition, message):
    if not condition:
        raise InvalidImage(message)


def exact(value, keys):
    return isinstance(value, dict) and value.keys() == set(keys)


def bare_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def manifest_hash(value):
    return isinstance(value, str) and bare_hash(value.removeprefix("sha256:"))


def reject_constant(_value):
    raise InvalidImage("Non-finite JSON value")


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def parse_json(data):
    return json.loads(data.decode("utf-8"), object_pairs_hook=unique_keys,
                      parse_constant=reject_constant)


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
        "utf-8", errors="backslashreplace")


def read_line():
    data = sys.stdin.buffer.readline(MAX_LINE + 1)
    if not data:
        return EOF
    require(len(data) <= MAX_LINE and data.endswith(b"\n"), "Invalid protocol line size")
    return parse_json(data)


def send(value):
    data = json_bytes(value)
    require(len(data) < MAX_LINE, "Protocol response exceeded its size bound")
    sys.stdout.buffer.write(data + b"\n")
    sys.stdout.buffer.flush()


def absolute_path(value):
    require(isinstance(value, str) and 1 <= len(value) <= 4096
            and value.startswith("/") and not any(ord(char) < 32 for char in value)
            and ".." not in PurePosixPath(value).parts, "Invalid absolute Linux path")
    return Path(value)


def open_regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), "Expected a regular file")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def digest_stream(source, bound, target=None):
    digest = hashlib.sha256()
    total = 0
    while block := source.read(1024 * 1024):
        total += len(block)
        require(total <= bound, "File exceeded its size bound")
        digest.update(block)
        if target is not None:
            target.write(block)
    return total, digest.hexdigest()


def verified_copy(source, target, limit, sha, size=None):
    with open_regular(source) as stream, target.open("xb") as copy:
        total, actual = digest_stream(stream, limit, copy)
    require(actual == sha and (size is None or total == size), "Approved file identity changed")


def metadata(path):
    with path.open("rb") as stream:
        data = stream.read(MAX_METADATA + 1)
    require(len(data) <= MAX_METADATA, "OCI metadata exceeded its size bound")
    return parse_json(data)


def unpack_layout(archive, layout):
    blobs = layout / "blobs" / "sha256"
    blobs.mkdir(parents=True)
    names = set()
    with tarfile.open(archive, "r:") as source:
        for entry in source:
            name = entry.name.removeprefix("./").rstrip("/")
            require(len(names) < 1024 and name not in names, "Unexpected OCI archive members")
            names.add(name)
            if entry.isdir():
                require(name in {"blobs", "blobs/sha256"}, "Unsafe OCI archive directory")
                continue
            is_blob = name.startswith("blobs/sha256/") and bare_hash(name.removeprefix("blobs/sha256/"))
            require(entry.isreg() and not entry.issparse() and (is_blob or name in {
                "index.json", "oci-layout", "manifest.json",
            }), "Unsafe OCI archive member")
            limit = MAX_ARCHIVE if is_blob else MAX_METADATA
            require(0 < entry.size <= limit, "Invalid OCI member size")
            with source.extractfile(entry) as original, (layout / name).open("xb") as target:
                total, actual = digest_stream(original, entry.size, target)
            require(total == entry.size and (not is_blob or actual == Path(name).name),
                    "OCI member content did not match its descriptor")
    require(metadata(layout / "oci-layout") == {"imageLayoutVersion": "1.0.0"}, "Unsupported OCI layout")
    return blobs


def require_blob(blobs, descriptor):
    digest = descriptor["digest"]
    require(isinstance(digest, str) and digest.startswith("sha256:") and manifest_hash(digest),
            "Invalid OCI blob digest")
    blob = blobs / digest.removeprefix("sha256:")
    require(type(descriptor["size"]) is int and blob.stat().st_size == descriptor["size"],
            "OCI descriptor size mismatch")
    return blob


def select_manifest(layout, blobs, expected):
    expected = "sha256:" + expected.removeprefix("sha256:")
    index = metadata(layout / "index.json")
    require(index["schemaVersion"] == 2, "Unsupported OCI index schema")
    entries = [item for item in index["manifests"] if item["digest"] == expected]
    require(len(entries) == 1, "Expected exactly one approved OCI manifest")
    selected = entries[0]
    manifest = metadata(require_blob(blobs, selected))
    require(manifest["schemaVersion"] == 2, "Unsupported OCI manifest schema")
    config = metadata(require_blob(blobs, manifest["config"]))
    require(config["os"] == "linux" and config["architecture"] == "amd64", "Expected linux/amd64 image")
    require(config["rootfs"]["type"] == "layers", "Unsupported OCI root filesystem")
    layers = manifest["layers"]
    diff_ids = config["rootfs"]["diff_ids"]
    require(0 < len(layers) == len(diff_ids) <= 128, "Unexpected OCI layer count")
    remaining = MAX_UNCOMPRESSED
    for layer, diff in zip(layers, diff_ids, strict=True):
        blob = require_blob(blobs, layer)
        media_type = layer["mediaType"]
        if media_type in {"application/vnd.oci.image.layer.v1.tar+gzip",
                          "application/vnd.docker.image.rootfs.diff.tar.gzip"}:
            opener = gzip.open
        else:
            require(media_type == "application/vnd.oci.image.layer.v1.tar", "Unsupported OCI layer format")
            opener = open
        with opener(blob, "rb") as original:
            total, actual = digest_stream(original, remaining)
        require(diff == "sha256:" + actual, "Uncompressed OCI layer digest mismatch")
        remaining -= total
    selected["annotations"] = {"org.opencontainers.image.ref.name": "approved"}
    index["manifests"] = [selected]
    (layout / "index.json").write_bytes(json_bytes(index))
    return config["config"]


def copy_builder(root, files, target):
    require(isinstance(files, list) and len(files) == len(BUILDER_FILES), "Invalid builder file inventory")
    remaining = set(BUILDER_FILES)
    resolved = root.resolve(strict=True)
    for entry in files:
        require(exact(entry, ("path", "sha256", "bytes")) and isinstance(entry["path"], str)
                and entry["path"] in remaining and bare_hash(entry["sha256"])
                and type(entry["bytes"]) is int and 0 < entry["bytes"] <= MAX_METADATA,
                "Invalid builder file descriptor")
        relative = entry["path"]
        remaining.remove(relative)
        original = root / relative
        require(original.resolve(strict=True) == resolved / relative, "Unexpected builder file link")
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        verified_copy(original, destination, entry["bytes"], entry["sha256"], entry["bytes"])


def image_paths(config):
    paths = [value[5:] for value in config["Env"] if value.startswith("PATH=")]
    require(len(paths) == 1 and len(paths[0]) <= 4096, "Missing or ambiguous image PATH")
    directories = paths[0].split(":")
    require(0 < len(directories) <= 32 and all(EXEC_DIRECTORY.fullmatch(directory)
            and ".." not in PurePosixPath(directory).parts for directory in directories),
            "Invalid image executable path")
    return paths[0]


def bounded_output():
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_LINE, MAX_LINE))


def image_process(rootfs, builder, node_path, mode, data=b""):
    command = [*UNSHARE, sys.executable, "-I", str(Path(__file__).resolve()), "--isolated",
               str(rootfs), str(builder), node_path, mode]
    with tempfile.TemporaryFile(dir=rootfs.parent) as output:
        result = subprocess.run(command, input=data, stdout=output, stderr=subprocess.DEVNULL,
                                env=ENV, timeout=30, check=False, preexec_fn=bounded_output)
        require(result.returncode == 0, "Offline image request builder failed")
        output.seek(0)
        raw = output.read(MAX_LINE)
    require(len(raw) < MAX_LINE, "Image output exceeded its size bound")
    return parse_json(raw)


def prepare_image(approved, scratch, builder, umoci):
    archive = scratch / "archive.tar"
    verified_copy(absolute_path(approved["archivePath"]), archive, approved["bytes"],
                  approved["sha256"], approved["bytes"])
    layout = scratch / "oci"
    blobs = unpack_layout(archive, layout)
    archive.unlink()
    node_path = image_paths(select_manifest(layout, blobs, approved["manifestDigest"]))
    bundle = scratch / "bundle"
    subprocess.run([*UNSHARE, str(umoci), "unpack", "--image", f"{layout}:approved", str(bundle)],
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   env=ENV, timeout=300, check=True)
    shutil.rmtree(layout)
    rootfs = bundle / "rootfs"
    require(rootfs.is_dir() and not rootfs.is_symlink() and (rootfs / "app").is_dir()
            and not (rootfs / "app").is_symlink(), "Missing image app filesystem")
    (rootfs / BUILDER_MOUNT.lstrip("/")).mkdir()
    require(image_process(rootfs, builder, node_path, "probe") is True, "Invalid image runtime")
    return rootfs, node_path


def enter_image(rootfs, builder, node_path, mode):
    target = rootfs + BUILDER_MOUNT
    for command in (["--bind", rootfs, rootfs], ["--bind", builder, target],
                    ["-o", "remount,bind,ro,nosuid,nodev,noexec", target],
                    ["-o", "remount,bind,ro,nosuid,nodev", rootfs]):
        subprocess.run(["/usr/bin/mount", *command], env=ENV, check=True)
    os.chroot(rootfs)
    os.chdir("/app")
    os.setgroups([])
    libc = ctypes.CDLL(None, use_errno=True)
    # Empty the capability bounding and ambient sets before exec, then lock privilege gains.
    for capability in range(64):
        if libc.prctl(24, capability, 0, 0, 0) != 0:  # PR_CAPBSET_DROP
            require(ctypes.get_errno() == errno.EINVAL, "Could not drop image process capability")
    require(libc.prctl(47, 4, 0, 0, 0) == 0  # PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL
            and libc.prctl(38, 1, 0, 0, 0) == 0, "Could not isolate image privileges")  # PR_SET_NO_NEW_PRIVS
    # Linux capability ABI v3 uses two effective/permitted/inheritable word triples.
    header = (ctypes.c_uint32 * 2)(0x20080522, 0)
    capabilities = (ctypes.c_uint32 * 6)()
    require(libc.capset(header, capabilities) == 0, "Could not clear image process privileges")
    env = {**ENV, "PATH": node_path, "HOME": "/nonexistent"}
    # The approved Railpack images put a mise shim first on PATH. Choose the
    # installed Node executable so the shim cannot resolve or download a tool.
    installs = Path("/mise/installs/node")
    candidates = [version / "bin/node" for version in installs.iterdir()
                  if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version.name)]
    require(len(candidates) == 1 and candidates[0].is_file()
            and candidates[0].resolve(strict=True) == candidates[0], "Expected one installed image Node executable")
    executable = str(candidates[0])
    os.execve(executable, [executable, "-e", NODE_SCRIPT, mode], env)


def serve():
    require(sys.platform == "linux" and platform.machine() == "x86_64" and os.geteuid() == 0,
            "Image helper requires Linux amd64 with mount and network namespace privileges")
    init = read_line()
    require(exact(init, ("images", "umociPath", "umociSha256", "builderRoot", "builderFiles"))
            and isinstance(init["images"], list) and 1 <= len(init["images"]) <= 3
            and bare_hash(init["umociSha256"]), "Invalid helper initialization")
    images = {}
    for entry in init["images"]:
        require(exact(entry, ("archivePath", "sha256", "bytes", "manifestDigest"))
                and bare_hash(entry["sha256"]) and entry["sha256"] not in images
                and type(entry["bytes"]) is int and 0 < entry["bytes"] <= MAX_ARCHIVE
                and manifest_hash(entry["manifestDigest"]), "Invalid approved image descriptor")
        images[entry["sha256"]] = entry
    with tempfile.TemporaryDirectory(prefix="tos-observed-image-", dir="/var/tmp") as private:
        scratch = Path(private)
        umoci = scratch / "umoci"
        verified_copy(absolute_path(init["umociPath"]), umoci, 64 * 1024 * 1024, init["umociSha256"])
        umoci.chmod(0o700)
        builder = scratch / "builder"
        copy_builder(absolute_path(init["builderRoot"]), init["builderFiles"], builder)
        prepared = {}
        ready = []
        for sha, entry in images.items():
            image_scratch = scratch / sha
            image_scratch.mkdir()
            prepared[sha] = prepare_image(entry, image_scratch, builder, umoci)
            ready.append({"sha256": sha, "manifestDigest": entry["manifestDigest"]})
        send({"ready": ready})
        while (message := read_line()) is not EOF:
            require(exact(message, ("archiveSha256", "input")) and bare_hash(message["archiveSha256"])
                    and message["archiveSha256"] in prepared, "Unapproved image request")
            sha = message["archiveSha256"]
            entry = images[sha]
            request_input = message["input"]
            require(exact(request_input, ("stage", "build", "buildHash", "sourceUrl", "sourceText",
                                          "sourceHash", "prior"))
                    and request_input["stage"] in ("analyzer", "critic", "judge")
                    and isinstance(request_input["build"], dict)
                    and request_input["build"].get("artifact") == {
                        "sha256": sha, "bytes": entry["bytes"],
                    }, "Request build identity did not match the approved image")
            rootfs, node_path = prepared[sha]
            request = image_process(rootfs, builder, node_path, "shape", json_bytes(request_input))
            require(exact(request, ("url", "body")), "Invalid shaped image request")
            send({"archiveSha256": sha, "manifestDigest": entry["manifestDigest"], "request": request})


if __name__ == "__main__":
    try:
        if len(sys.argv) == 6 and sys.argv[1] == "--isolated":
            enter_image(*sys.argv[2:])
        else:
            require(len(sys.argv) == 1, "Unexpected helper arguments")
            serve()
    except InvalidImage as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, AttributeError, KeyError, TypeError, RecursionError,
            tarfile.TarError, subprocess.SubprocessError):
        print("Could not verify or execute the approved image", file=sys.stderr)
        sys.exit(1)
