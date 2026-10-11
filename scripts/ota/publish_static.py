#!/usr/bin/env python3
"""Atomically publish a verified EcholIKE OTA installer and signature.

The command-line interface is intentionally production-only.  Tests exercise
the same core with a temporary target owned by the current user.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import dataclasses
import errno
import hashlib
import json
import os
import posixpath
import re
import secrets
import signal
import stat
import sys
import urllib.parse
from collections.abc import Iterator, Mapping, Sequence
from typing import Any, Final

try:
    import fcntl
except ImportError:  # pragma: no cover - the production command is Linux/WSL-only
    fcntl = None  # type: ignore[assignment]


PRODUCTION_TARGET: Final = "/srv/echolike/ota"
MAX_SAFE_INTEGER: Final = (1 << 53) - 1
MAX_MANIFEST_BYTES: Final = 1 << 20
COPY_CHUNK_BYTES: Final = 1 << 20
FINAL_FILE_MODE: Final = 0o644
MAX_RELEASE_NOTES_CHARS: Final = 4000
MAX_ONLINE_NSIS_BYTES: Final = 512 * 1024 * 1024
MAX_SIGNATURE_BYTES: Final = 16 * 1024
BLOCKED_SIGNALS: Final = frozenset(
    (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT)
)

_LOWER_HEX_40 = re.compile(r"[0-9a-f]{40}\Z")
_LOWER_HEX_64 = re.compile(r"[0-9a-f]{64}\Z")
_STABLE_VERSION = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z"
)


class PublisherError(RuntimeError):
    """A fail-closed manifest or publication error."""


class ManifestError(PublisherError):
    """The input manifest is not the exact supported schema."""


@dataclasses.dataclass(frozen=True)
class FileSpec:
    file_name: str
    source_path: str
    byte_count: int
    sha256: str
    exact_content: bytes | None = None


@dataclasses.dataclass(frozen=True)
class PublishManifest:
    source_commit: str
    public_api_base_url: str
    baseline_version: str
    version: str
    release_notes: str
    artifact: FileSpec
    signature: FileSpec

    @property
    def files(self) -> tuple[FileSpec, FileSpec]:
        return (self.artifact, self.signature)


@dataclasses.dataclass(frozen=True)
class TargetPolicy:
    path: str
    owner_uid: int
    owner_gid: int
    file_mode: int = FINAL_FILE_MODE


PRODUCTION_POLICY: Final = TargetPolicy(PRODUCTION_TARGET, 0, 0)


@dataclasses.dataclass(frozen=True)
class FileFacts:
    device: int
    inode: int
    byte_count: int
    sha256: str


@dataclasses.dataclass(frozen=True)
class OwnedPath:
    name: str
    device: int
    inode: int


@dataclasses.dataclass(frozen=True)
class PublishResult:
    status: str
    target: str
    files: tuple[str, str]

    def as_json(self, action: str) -> dict[str, Any]:
        return {
            "action": action,
            "files": list(self.files),
            "status": self.status,
            "target": self.target,
        }


def _reject_json_constant(value: str) -> None:
    raise ManifestError(f"manifest contains unsupported JSON constant {value!r}")


def _strict_object(pairs: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ManifestError(f"manifest contains duplicate key {key!r}")
        result[key] = value
    return result


def _require_object(value: Any, where: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ManifestError(f"{where} must be a JSON object")
    return value


def _require_exact_keys(
    value: Mapping[str, Any], expected: frozenset[str], where: str
) -> None:
    actual = frozenset(value)
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    details: list[str] = []
    if missing:
        details.append(f"missing {missing!r}")
    if extra:
        details.append(f"unexpected {extra!r}")
    if details:
        raise ManifestError(f"{where} has invalid fields: {', '.join(details)}")


def _require_string(value: Any, where: str, *, nonempty: bool = False) -> str:
    if not isinstance(value, str):
        raise ManifestError(f"{where} must be a string")
    if "\x00" in value:
        raise ManifestError(f"{where} must not contain NUL")
    if nonempty and not value.strip():
        raise ManifestError(f"{where} must be nonempty")
    return value


def _require_positive_safe_integer(value: Any, where: str) -> int:
    if type(value) is not int or value <= 0 or value > MAX_SAFE_INTEGER:
        raise ManifestError(
            f"{where} must be a positive integer no greater than {MAX_SAFE_INTEGER}"
        )
    return value


def _require_source_path(value: Any, where: str) -> str:
    path = _require_string(value, where, nonempty=True)
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in path):
        raise ManifestError(f"{where} must not contain control characters")
    if not posixpath.isabs(path) or path.startswith("//"):
        raise ManifestError(f"{where} must be an absolute WSL path")
    if posixpath.normpath(path) != path:
        raise ManifestError(f"{where} must be a normalized absolute WSL path")
    return path


def _require_sha256(value: Any, where: str) -> str:
    digest = _require_string(value, where)
    if _LOWER_HEX_64.fullmatch(digest) is None:
        raise ManifestError(f"{where} must be 64 lowercase hexadecimal characters")
    return digest


def _decode_signature_value(value: Any) -> tuple[str, bytes]:
    encoded = _require_string(value, "artifact.signature.value", nonempty=True)
    try:
        ascii_bytes = encoded.encode("ascii")
        decoded = base64.b64decode(ascii_bytes, validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ManifestError(
            "artifact.signature.value must be canonical base64 text"
        ) from exc
    if not decoded or base64.b64encode(decoded) != ascii_bytes:
        raise ManifestError(
            "artifact.signature.value must be nonempty canonical base64 text"
        )
    return encoded, ascii_bytes


def parse_manifest_json(text: str) -> PublishManifest:
    """Parse an exact schema-v1 manifest, rejecting duplicate and extra fields."""

    try:
        raw = json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
        )
    except ManifestError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise ManifestError(f"manifest is not strict JSON: {exc}") from exc
    return parse_manifest_object(raw)


def parse_manifest_object(raw: Any) -> PublishManifest:
    root = _require_object(raw, "manifest")
    _require_exact_keys(
        root,
        frozenset(
            {
                "schemaVersion",
                "sourceCommit",
                "publicApiBaseUrl",
                "baselineVersion",
                "version",
                "buildMode",
                "releaseNotes",
                "artifact",
            }
        ),
        "manifest",
    )
    if type(root["schemaVersion"]) is not int or root["schemaVersion"] != 1:
        raise ManifestError("schemaVersion must be the integer 1")

    source_commit = _require_string(root["sourceCommit"], "sourceCommit")
    if _LOWER_HEX_40.fullmatch(source_commit) is None:
        raise ManifestError("sourceCommit must be 40 lowercase hexadecimal characters")

    public_api_base_url = _require_string(
        root["publicApiBaseUrl"], "publicApiBaseUrl", nonempty=True
    )
    public_api = urllib.parse.urlsplit(public_api_base_url)
    if (
        public_api.scheme != "https"
        or not public_api.hostname
        or public_api.username is not None
        or public_api.password is not None
        or public_api.path != "/echo-api"
        or public_api.query
        or public_api.fragment
        or public_api.geturl() != public_api_base_url
    ):
        raise ManifestError("publicApiBaseUrl must be a canonical HTTPS /echo-api URL")

    baseline_version = _require_string(root["baselineVersion"], "baselineVersion")
    if _STABLE_VERSION.fullmatch(baseline_version) is None:
        raise ManifestError("baselineVersion must be a canonical x.y.z version")

    version = _require_string(root["version"], "version")
    if _STABLE_VERSION.fullmatch(version) is None:
        raise ManifestError("version must be a canonical x.y.z version")
    if tuple(map(int, baseline_version.split("."))) >= tuple(
        map(int, version.split("."))
    ):
        raise ManifestError("baselineVersion must be lower than version")
    if root["buildMode"] != "online-nsis":
        raise ManifestError("buildMode must be exactly 'online-nsis'")
    release_notes = _require_string(
        root["releaseNotes"], "releaseNotes", nonempty=True
    )
    release_notes_utf16_units = len(release_notes.encode("utf-16-le")) // 2
    if (
        release_notes.strip() != release_notes
        or release_notes_utf16_units > MAX_RELEASE_NOTES_CHARS
    ):
        raise ManifestError(
            "releaseNotes must contain at most 4000 characters without outer whitespace"
        )

    artifact_raw = _require_object(root["artifact"], "artifact")
    _require_exact_keys(
        artifact_raw,
        frozenset({"fileName", "sourcePath", "bytes", "sha256", "signature"}),
        "artifact",
    )
    expected_artifact_name = f"EcholIKE_{version}_x64-setup.exe"
    artifact_name = _require_string(artifact_raw["fileName"], "artifact.fileName")
    if artifact_name != expected_artifact_name:
        raise ManifestError(
            f"artifact.fileName must be exactly {expected_artifact_name!r}"
        )

    signature_raw = _require_object(
        artifact_raw["signature"], "artifact.signature"
    )
    _require_exact_keys(
        signature_raw,
        frozenset({"fileName", "sourcePath", "bytes", "sha256", "value"}),
        "artifact.signature",
    )
    expected_signature_name = expected_artifact_name + ".sig"
    signature_name = _require_string(
        signature_raw["fileName"], "artifact.signature.fileName"
    )
    if signature_name != expected_signature_name:
        raise ManifestError(
            f"artifact.signature.fileName must be exactly {expected_signature_name!r}"
        )

    _, signature_content = _decode_signature_value(signature_raw["value"])
    signature_bytes = _require_positive_safe_integer(
        signature_raw["bytes"], "artifact.signature.bytes"
    )
    if signature_bytes > MAX_SIGNATURE_BYTES:
        raise ManifestError("artifact.signature.bytes exceeds the online OTA limit")
    signature_sha256 = _require_sha256(
        signature_raw["sha256"], "artifact.signature.sha256"
    )
    if signature_bytes != len(signature_content):
        raise ManifestError(
            "artifact.signature.value byte length does not match artifact.signature.bytes"
        )
    if hashlib.sha256(signature_content).hexdigest() != signature_sha256:
        raise ManifestError(
            "artifact.signature.value digest does not match artifact.signature.sha256"
        )

    artifact = FileSpec(
        file_name=artifact_name,
        source_path=_require_source_path(
            artifact_raw["sourcePath"], "artifact.sourcePath"
        ),
        byte_count=_require_positive_safe_integer(
            artifact_raw["bytes"], "artifact.bytes"
        ),
        sha256=_require_sha256(artifact_raw["sha256"], "artifact.sha256"),
    )
    if artifact.byte_count > MAX_ONLINE_NSIS_BYTES:
        raise ManifestError("artifact.bytes exceeds the online NSIS limit")
    signature = FileSpec(
        file_name=signature_name,
        source_path=_require_source_path(
            signature_raw["sourcePath"], "artifact.signature.sourcePath"
        ),
        byte_count=signature_bytes,
        sha256=signature_sha256,
        exact_content=signature_content,
    )
    if artifact.source_path == signature.source_path:
        raise ManifestError("artifact and signature sourcePath values must be distinct")

    return PublishManifest(
        source_commit=source_commit,
        public_api_base_url=public_api_base_url,
        baseline_version=baseline_version,
        version=version,
        release_notes=release_notes,
        artifact=artifact,
        signature=signature,
    )


def load_manifest(path: str) -> PublishManifest:
    if not path:
        raise ManifestError("--manifest requires a path")
    _require_linux_primitives()
    if (
        not posixpath.isabs(path)
        or posixpath.normpath(path) != path
        or os.path.realpath(path) != path
    ):
        raise ManifestError("manifest path must be normalized, absolute, and symlink-free")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        manifest_fd = os.open(path, flags)
    except OSError as exc:
        raise ManifestError(f"cannot read manifest: {exc.strerror or exc}") from exc
    try:
        before = os.fstat(manifest_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_MANIFEST_BYTES:
            raise ManifestError("manifest must be a bounded regular file")
        chunks: list[bytes] = []
        total = 0
        while total <= MAX_MANIFEST_BYTES:
            chunk = os.read(
                manifest_fd, min(COPY_CHUNK_BYTES, MAX_MANIFEST_BYTES + 1 - total)
            )
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > MAX_MANIFEST_BYTES:
            raise ManifestError(
                f"manifest exceeds the {MAX_MANIFEST_BYTES}-byte safety limit"
            )
        after = os.fstat(manifest_fd)
        path_stat = os.stat(path, follow_symlinks=False)
        stable_before = (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        stable_after = (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if stable_before != stable_after or (after.st_dev, after.st_ino) != (
            path_stat.st_dev,
            path_stat.st_ino,
        ):
            raise ManifestError("manifest changed while being read")
        payload = b"".join(chunks)
    except OSError as exc:
        raise ManifestError(f"cannot read manifest: {exc.strerror or exc}") from exc
    finally:
        os.close(manifest_fd)
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ManifestError("manifest must be UTF-8 without a byte-order mark") from exc
    return parse_manifest_json(text)


def _require_linux_primitives() -> None:
    required_os_names = (
        "O_CLOEXEC",
        "O_DIRECTORY",
        "O_NOFOLLOW",
        "O_NONBLOCK",
        "O_RDONLY",
    )
    if os.name != "posix" or fcntl is None:
        raise PublisherError("static OTA publishing requires Linux/WSL")
    missing = [name for name in required_os_names if not hasattr(os, name)]
    if missing or not hasattr(signal, "pthread_sigmask"):
        raise PublisherError("required Linux no-follow/signal primitives are unavailable")


def _normalize_target(policy: TargetPolicy) -> str:
    if not posixpath.isabs(policy.path) or posixpath.normpath(policy.path) != policy.path:
        raise PublisherError("target policy path must be a normalized absolute path")
    resolved = os.path.realpath(policy.path)
    if resolved != policy.path:
        raise PublisherError("target path must already be its own realpath")
    return resolved


def _assert_target_path_matches_fd(path: str, directory_fd: int) -> os.stat_result:
    try:
        path_stat = os.stat(path, follow_symlinks=False)
        fd_stat = os.fstat(directory_fd)
    except OSError as exc:
        raise PublisherError(f"cannot revalidate target directory: {exc}") from exc
    if not stat.S_ISDIR(path_stat.st_mode) or not stat.S_ISDIR(fd_stat.st_mode):
        raise PublisherError("target path/fd is no longer a directory")
    if (path_stat.st_dev, path_stat.st_ino) != (fd_stat.st_dev, fd_stat.st_ino):
        raise PublisherError("target path no longer refers to the locked directory inode")
    if os.path.realpath(path) != path:
        raise PublisherError("target path no longer resolves to its canonical directory")
    return fd_stat


def _validate_target_permissions(target_stat: os.stat_result, policy: TargetPolicy) -> None:
    if (target_stat.st_uid, target_stat.st_gid) != (
        policy.owner_uid,
        policy.owner_gid,
    ):
        raise PublisherError(
            "target directory owner does not match the required uid/gid"
        )
    if target_stat.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise PublisherError("target directory must not be group- or other-writable")


@contextlib.contextmanager
def _locked_target(
    policy: TargetPolicy, *, exclusive: bool
) -> Iterator[tuple[str, int]]:
    _require_linux_primitives()
    target = _normalize_target(policy)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        directory_fd = os.open(target, flags)
    except OSError as exc:
        raise PublisherError(f"cannot open fixed target directory: {exc}") from exc
    locked = False
    try:
        try:
            lock_kind = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            fcntl.flock(directory_fd, lock_kind | fcntl.LOCK_NB)
            locked = True
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EAGAIN):
                raise PublisherError(
                    "another static OTA operation holds an incompatible target lock"
                )
            raise PublisherError(f"cannot lock target directory: {exc}") from exc
        target_stat = _assert_target_path_matches_fd(target, directory_fd)
        _validate_target_permissions(target_stat, policy)
        yield target, directory_fd
    finally:
        if locked:
            with contextlib.suppress(OSError):
                fcntl.flock(directory_fd, fcntl.LOCK_UN)
        os.close(directory_fd)


def _hash_fd(file_fd: int) -> tuple[int, str]:
    os.lseek(file_fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = os.read(file_fd, COPY_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        digest.update(chunk)
    return total, digest.hexdigest()


def _inspect_fd(file_fd: int) -> FileFacts:
    before = os.fstat(file_fd)
    if not stat.S_ISREG(before.st_mode):
        raise PublisherError("artifact input/output must be a regular file")
    byte_count, digest = _hash_fd(file_fd)
    after = os.fstat(file_fd)
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise PublisherError("file inode changed while hashing")
    if before.st_size != after.st_size or after.st_size != byte_count:
        raise PublisherError("file length changed while hashing")
    return FileFacts(after.st_dev, after.st_ino, byte_count, digest)


def _inspect_declared_fd(file_fd: int, spec: FileSpec, where: str) -> FileFacts:
    before = os.fstat(file_fd)
    if not stat.S_ISREG(before.st_mode):
        raise PublisherError(f"{where} must be a regular file: {spec.file_name}")
    if before.st_size != spec.byte_count:
        raise PublisherError(
            f"{where} length mismatch for {spec.file_name}: "
            f"expected {spec.byte_count}, got {before.st_size}"
        )
    facts = _inspect_fd(file_fd)
    _assert_declared_facts(facts, spec, where)
    return facts


def _assert_declared_facts(facts: FileFacts, spec: FileSpec, where: str) -> None:
    if facts.byte_count != spec.byte_count:
        raise PublisherError(
            f"{where} length mismatch for {spec.file_name}: "
            f"expected {spec.byte_count}, got {facts.byte_count}"
        )
    if facts.sha256 != spec.sha256:
        raise PublisherError(f"{where} SHA-256 mismatch for {spec.file_name}")


def _assert_path_inode(path: str, file_fd: int, expected: FileFacts) -> None:
    if os.path.realpath(path) != path:
        raise PublisherError("source path gained a symlink while being verified")
    try:
        path_stat = os.stat(path, follow_symlinks=False)
        fd_stat = os.fstat(file_fd)
    except OSError as exc:
        raise PublisherError("source path changed while being verified") from exc
    expected_inode = (expected.device, expected.inode)
    if (path_stat.st_dev, path_stat.st_ino) != expected_inode:
        raise PublisherError("source path no longer refers to the verified inode")
    if (fd_stat.st_dev, fd_stat.st_ino) != expected_inode:
        raise PublisherError("source fd no longer refers to the verified inode")


@contextlib.contextmanager
def _open_verified_source(spec: FileSpec) -> Iterator[tuple[int, FileFacts]]:
    if os.path.realpath(spec.source_path) != spec.source_path:
        raise PublisherError(f"source path must not contain symlinks: {spec.file_name}")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        source_fd = os.open(spec.source_path, flags)
    except OSError as exc:
        raise PublisherError(f"cannot open source for {spec.file_name}: {exc}") from exc
    try:
        facts = _inspect_declared_fd(source_fd, spec, "source")
        _assert_path_inode(spec.source_path, source_fd, facts)
        yield source_fd, facts
    finally:
        os.close(source_fd)


def _stat_at(directory_fd: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            return None
        raise


def _inspect_final(directory_fd: int, spec: FileSpec, policy: TargetPolicy) -> FileFacts:
    path_stat = _stat_at(directory_fd, spec.file_name)
    if path_stat is None:
        raise PublisherError(f"final file is missing: {spec.file_name}")
    if not stat.S_ISREG(path_stat.st_mode):
        raise PublisherError(f"final path is not a regular file: {spec.file_name}")
    if path_stat.st_size != spec.byte_count:
        raise PublisherError(f"final length mismatch: {spec.file_name}")
    if (path_stat.st_uid, path_stat.st_gid) != (policy.owner_uid, policy.owner_gid):
        raise PublisherError(f"final owner mismatch: {spec.file_name}")
    if stat.S_IMODE(path_stat.st_mode) != policy.file_mode:
        raise PublisherError(f"final mode mismatch: {spec.file_name}")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        final_fd = os.open(spec.file_name, flags, dir_fd=directory_fd)
    except OSError as exc:
        raise PublisherError(f"cannot open final file {spec.file_name}: {exc}") from exc
    try:
        facts = _inspect_declared_fd(final_fd, spec, "final")
        if (facts.device, facts.inode) != (path_stat.st_dev, path_stat.st_ino):
            raise PublisherError(f"final inode changed while opening: {spec.file_name}")
        _assert_declared_facts(facts, spec, "final")
        after = _stat_at(directory_fd, spec.file_name)
        if after is None or (after.st_dev, after.st_ino) != (
            facts.device,
            facts.inode,
        ):
            raise PublisherError(f"final path changed while hashing: {spec.file_name}")
        return facts
    finally:
        os.close(final_fd)


def _classify_final_state(
    directory_fd: int, manifest: PublishManifest, policy: TargetPolicy
) -> str:
    existence = [
        _stat_at(directory_fd, spec.file_name) is not None for spec in manifest.files
    ]
    if not any(existence):
        return "absent"
    if not all(existence):
        raise PublisherError(
            "publication is partial: installer and signature must both be absent or exact"
        )
    for spec in manifest.files:
        _inspect_final(directory_fd, spec, policy)
    return "already-published"


def _verify_sources(manifest: PublishManifest) -> None:
    for spec in manifest.files:
        with _open_verified_source(spec):
            pass


@contextlib.contextmanager
def _blocked_mutation_signals() -> Iterator[None]:
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, BLOCKED_SIGNALS)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def _write_all(file_fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(file_fd, view)
        if written <= 0:
            raise PublisherError("short write while copying OTA artifact")
        view = view[written:]


def _copy_source(source_fd: int, temporary_fd: int) -> tuple[int, str]:
    os.lseek(source_fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = os.read(source_fd, COPY_CHUNK_BYTES)
        if not chunk:
            break
        _write_all(temporary_fd, chunk)
        total += len(chunk)
        digest.update(chunk)
    return total, digest.hexdigest()


def _new_temporary(directory_fd: int) -> tuple[int, OwnedPath]:
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
    for _ in range(8):
        name = f".ota-publish-{secrets.token_hex(32)}"
        try:
            temporary_fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
        except FileExistsError:
            continue
        temporary_stat = os.fstat(temporary_fd)
        if not stat.S_ISREG(temporary_stat.st_mode):  # defensive; O_EXCL created it
            os.close(temporary_fd)
            raise PublisherError("new temporary path is not a regular file")
        return temporary_fd, OwnedPath(
            name, temporary_stat.st_dev, temporary_stat.st_ino
        )
    raise PublisherError("could not allocate a unique high-entropy temporary file")


def _assert_owned_path(directory_fd: int, owned: OwnedPath) -> os.stat_result:
    current = _stat_at(directory_fd, owned.name)
    if current is None:
        raise PublisherError(f"owned path disappeared: {owned.name}")
    if (current.st_dev, current.st_ino) != (owned.device, owned.inode):
        raise PublisherError(f"owned path inode changed: {owned.name}")
    if not stat.S_ISREG(current.st_mode):
        raise PublisherError(f"owned path is no longer a regular file: {owned.name}")
    return current


def _prepare_temporary(
    directory_fd: int,
    spec: FileSpec,
    policy: TargetPolicy,
    owned_temporaries: list[OwnedPath],
) -> OwnedPath:
    with _open_verified_source(spec) as (source_fd, source_facts):
        temporary_fd, owned = _new_temporary(directory_fd)
        # Register the inode before any copy/metadata operation can fail so the
        # outer rollback always owns every temporary created in this attempt.
        owned_temporaries.append(owned)
        try:
            copied_count, copied_sha256 = _copy_source(source_fd, temporary_fd)
            if copied_count != spec.byte_count or copied_sha256 != spec.sha256:
                raise PublisherError(f"copied bytes do not match manifest: {spec.file_name}")
            os.fchmod(temporary_fd, policy.file_mode)
            temporary_stat = os.fstat(temporary_fd)
            if (temporary_stat.st_uid, temporary_stat.st_gid) != (
                policy.owner_uid,
                policy.owner_gid,
            ):
                os.fchown(temporary_fd, policy.owner_uid, policy.owner_gid)
            os.fsync(temporary_fd)

            copied_facts = _inspect_declared_fd(
                temporary_fd, spec, "temporary copy"
            )
            if (copied_facts.device, copied_facts.inode) != (
                owned.device,
                owned.inode,
            ):
                raise PublisherError(f"temporary inode changed: {spec.file_name}")
            source_after = _inspect_declared_fd(
                source_fd, spec, "source after copy"
            )
            if (source_after.device, source_after.inode) != (
                source_facts.device,
                source_facts.inode,
            ):
                raise PublisherError(f"source inode changed: {spec.file_name}")
            _assert_path_inode(spec.source_path, source_fd, source_after)
            final_temp_stat = _assert_owned_path(directory_fd, owned)
            if stat.S_IMODE(final_temp_stat.st_mode) != policy.file_mode:
                raise PublisherError(f"temporary mode mismatch: {spec.file_name}")
            if (final_temp_stat.st_uid, final_temp_stat.st_gid) != (
                policy.owner_uid,
                policy.owner_gid,
            ):
                raise PublisherError(f"temporary owner mismatch: {spec.file_name}")
            return owned
        finally:
            os.close(temporary_fd)


def _unlink_owned(
    directory_fd: int, owned: OwnedPath, *, missing_is_error: bool
) -> str | None:
    try:
        current = _stat_at(directory_fd, owned.name)
    except OSError as exc:
        return f"cannot inspect {owned.name}: {exc}"
    if current is None:
        if missing_is_error:
            return f"owned path disappeared before cleanup: {owned.name}"
        return None
    if (current.st_dev, current.st_ino) != (owned.device, owned.inode):
        return f"foreign inode left untouched at {owned.name}"
    try:
        os.unlink(owned.name, dir_fd=directory_fd)
    except OSError as exc:
        return f"cannot unlink owned path {owned.name}: {exc}"
    return None


def _rollback(
    directory_fd: int,
    finals: Sequence[OwnedPath],
    temporaries: Sequence[OwnedPath],
) -> list[str]:
    issues: list[str] = []
    for owned in reversed(finals):
        issue = _unlink_owned(directory_fd, owned, missing_is_error=False)
        if issue:
            issues.append(issue)
    for owned in reversed(temporaries):
        issue = _unlink_owned(directory_fd, owned, missing_is_error=False)
        if issue:
            issues.append(issue)
    try:
        os.fsync(directory_fd)
    except OSError as exc:
        issues.append(f"cannot fsync target directory after rollback: {exc}")
    return issues


def _raise_with_rollback(
    cause: BaseException, rollback_issues: Sequence[str]
) -> None:
    if rollback_issues:
        details = "; ".join(rollback_issues)
        raise PublisherError(
            f"publication failed and rollback was incomplete: {details}"
        ) from cause
    if isinstance(cause, PublisherError):
        raise cause
    if isinstance(cause, OSError):
        raise PublisherError(f"publication failed: {cause}") from cause
    raise cause


def preflight(
    manifest: PublishManifest, policy: TargetPolicy = PRODUCTION_POLICY
) -> PublishResult:
    """Read-only verification of target state and source artifact facts."""

    with _locked_target(policy, exclusive=False) as (target, directory_fd):
        state = _classify_final_state(directory_fd, manifest, policy)
        if state == "absent":
            _verify_sources(manifest)
            status = "ready"
        else:
            status = state
        _assert_target_path_matches_fd(target, directory_fd)
        return PublishResult(
            status=status,
            target=target,
            files=tuple(spec.file_name for spec in manifest.files),  # type: ignore[arg-type]
        )


def _publish_to_target(
    manifest: PublishManifest, policy: TargetPolicy
) -> PublishResult:
    """Testable publication core; callers must supply their security policy."""

    with _locked_target(policy, exclusive=True) as (target, directory_fd):
        state = _classify_final_state(directory_fd, manifest, policy)
        if state == "already-published":
            _assert_target_path_matches_fd(target, directory_fd)
            return PublishResult(
                status=state,
                target=target,
                files=tuple(spec.file_name for spec in manifest.files),  # type: ignore[arg-type]
            )

        temporaries: list[OwnedPath] = []
        finals: list[OwnedPath] = []
        with _blocked_mutation_signals():
            try:
                _assert_target_path_matches_fd(target, directory_fd)
                # Re-check immediately before the first target mutation.
                if _classify_final_state(directory_fd, manifest, policy) != "absent":
                    raise PublisherError("target state changed before publication")

                for spec in manifest.files:
                    _prepare_temporary(
                        directory_fd, spec, policy, temporaries
                    )

                for spec, temporary in zip(manifest.files, temporaries, strict=True):
                    _assert_owned_path(directory_fd, temporary)
                    os.link(
                        temporary.name,
                        spec.file_name,
                        src_dir_fd=directory_fd,
                        dst_dir_fd=directory_fd,
                        follow_symlinks=False,
                    )
                    final_owned = OwnedPath(
                        spec.file_name, temporary.device, temporary.inode
                    )
                    # Record ownership before verification so rollback remains safe
                    # even if the destination is replaced immediately after linkat.
                    finals.append(final_owned)
                    _assert_owned_path(directory_fd, final_owned)

                for spec in manifest.files:
                    _inspect_final(directory_fd, spec, policy)

                cleanup_issues: list[str] = []
                for temporary in temporaries:
                    issue = _unlink_owned(
                        directory_fd, temporary, missing_is_error=True
                    )
                    if issue:
                        cleanup_issues.append(issue)
                if cleanup_issues:
                    raise PublisherError(
                        "temporary cleanup failed: " + "; ".join(cleanup_issues)
                    )
                os.fsync(directory_fd)
                _assert_target_path_matches_fd(target, directory_fd)
                for spec in manifest.files:
                    _inspect_final(directory_fd, spec, policy)
            except BaseException as cause:
                rollback_issues = _rollback(directory_fd, finals, temporaries)
                try:
                    _assert_target_path_matches_fd(target, directory_fd)
                except PublisherError as path_error:
                    rollback_issues.append(str(path_error))
                _raise_with_rollback(cause, rollback_issues)

        return PublishResult(
            status="published",
            target=target,
            files=tuple(spec.file_name for spec in manifest.files),  # type: ignore[arg-type]
        )


def publish_production(manifest: PublishManifest) -> PublishResult:
    """Publish only to the fixed production target, as effective root."""

    _require_linux_primitives()
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise PublisherError("--publish requires effective uid 0")
    return _publish_to_target(manifest, PRODUCTION_POLICY)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Preflight or atomically publish EcholIKE public OTA static files."
    )
    parser.add_argument("--manifest", required=True, help="strict schema-v1 JSON path")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--preflight", action="store_true", help="read-only validation")
    action.add_argument("--publish", action="store_true", help="publish as root")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    action = "publish" if args.publish else "preflight"
    try:
        manifest = load_manifest(args.manifest)
        result = publish_production(manifest) if args.publish else preflight(manifest)
    except (PublisherError, OSError) as exc:
        print(f"publish_static: {exc}", file=sys.stderr)
        print(
            json.dumps(
                {"action": action, "status": "error"},
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        return 1
    print(
        json.dumps(
            result.as_json(action),
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
