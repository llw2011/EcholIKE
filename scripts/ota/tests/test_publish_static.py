from __future__ import annotations

import base64
import copy
import errno
import hashlib
import json
import os
import signal
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import publish_static as publisher  # noqa: E402


class StaticPublisherTests(unittest.TestCase):
    def setUp(self) -> None:
        repository_root = Path(__file__).resolve().parents[3]
        test_root = repository_root / "src-tauri" / "target-codex-check" / "ota-static-tests"
        test_root.mkdir(parents=True, exist_ok=True)
        self.temporary_directory = tempfile.TemporaryDirectory(dir=test_root)
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name).resolve()
        self.source = self.root / "source"
        self.target = self.root / "target"
        self.source.mkdir()
        self.target.mkdir()
        self.target.chmod(0o755)
        self.assertNotEqual(str(self.target), publisher.PRODUCTION_TARGET)
        self.real_validate_target_permissions = publisher._validate_target_permissions
        permission_patch = mock.patch.object(
            publisher, "_validate_target_permissions", return_value=None
        )
        permission_patch.start()
        self.addCleanup(permission_patch.stop)

        self.version = "0.2.16"
        self.artifact_name = f"EcholIKE_{self.version}_x64-setup.exe"
        self.signature_name = self.artifact_name + ".sig"
        self.artifact_bytes = b"MZ\x00test-online-nsis-artifact\n" * 257
        self.signature_bytes = base64.b64encode(b"test-minisign-envelope")
        self.artifact_path = self.source / self.artifact_name
        self.signature_path = self.source / self.signature_name
        self.artifact_path.write_bytes(self.artifact_bytes)
        self.signature_path.write_bytes(self.signature_bytes)

        self.manifest_mapping = {
            "schemaVersion": 1,
            "sourceCommit": "a" * 40,
            "publicApiBaseUrl": "https://updates.example.test/echo-api",
            "baselineVersion": "0.2.15",
            "version": self.version,
            "buildMode": "online-nsis",
            "releaseNotes": "测试静态发布器。",
            "artifact": {
                "fileName": self.artifact_name,
                "sourcePath": str(self.artifact_path),
                "bytes": len(self.artifact_bytes),
                "sha256": hashlib.sha256(self.artifact_bytes).hexdigest(),
                "signature": {
                    "fileName": self.signature_name,
                    "sourcePath": str(self.signature_path),
                    "bytes": len(self.signature_bytes),
                    "sha256": hashlib.sha256(self.signature_bytes).hexdigest(),
                    "value": self.signature_bytes.decode("ascii"),
                },
            },
        }
        self.manifest = publisher.parse_manifest_object(self.manifest_mapping)
        self.policy = publisher.TargetPolicy(
            str(self.target), os.getuid(), os.getgid(), file_mode=0o777
        )

    def _target_names(self) -> set[str]:
        return {entry.name for entry in self.target.iterdir()}

    def _assert_no_publisher_temporaries(self) -> None:
        self.assertFalse(
            any(name.startswith(".ota-publish-") for name in self._target_names())
        )

    def test_success_publishes_exact_files_and_permissions(self) -> None:
        preflight = publisher.preflight(self.manifest, self.policy)
        self.assertEqual(preflight.status, "ready")
        self.assertEqual(self._target_names(), set())

        result = publisher._publish_to_target(self.manifest, self.policy)

        self.assertEqual(result.status, "published")
        artifact_final = self.target / self.artifact_name
        signature_final = self.target / self.signature_name
        self.assertEqual(artifact_final.read_bytes(), self.artifact_bytes)
        self.assertEqual(signature_final.read_bytes(), self.signature_bytes)
        for final_path in (artifact_final, signature_final):
            final_stat = final_path.stat()
            self.assertEqual(stat.S_IMODE(final_stat.st_mode), self.policy.file_mode)
            self.assertEqual(final_stat.st_uid, os.getuid())
            self.assertEqual(final_stat.st_gid, os.getgid())
        self._assert_no_publisher_temporaries()

    def test_exact_existing_pair_resumes_as_already_published(self) -> None:
        first = publisher._publish_to_target(self.manifest, self.policy)
        before = {
            name: (self.target / name).stat().st_ino
            for name in (self.artifact_name, self.signature_name)
        }

        second = publisher._publish_to_target(self.manifest, self.policy)
        preflight = publisher.preflight(self.manifest, self.policy)

        self.assertEqual(first.status, "published")
        self.assertEqual(second.status, "already-published")
        self.assertEqual(preflight.status, "already-published")
        after = {
            name: (self.target / name).stat().st_ino
            for name in (self.artifact_name, self.signature_name)
        }
        self.assertEqual(after, before)
        self._assert_no_publisher_temporaries()

    def test_target_collision_fails_closed_without_mutation(self) -> None:
        collision = self.target / self.artifact_name
        collision.write_bytes(b"foreign-existing-file")
        collision.chmod(0o644)

        with self.assertRaisesRegex(publisher.PublisherError, "partial"):
            publisher._publish_to_target(self.manifest, self.policy)

        self.assertEqual(collision.read_bytes(), b"foreign-existing-file")
        self.assertFalse((self.target / self.signature_name).exists())
        self._assert_no_publisher_temporaries()

    def test_existing_pair_with_wrong_mode_fails_closed(self) -> None:
        artifact_final = self.target / self.artifact_name
        signature_final = self.target / self.signature_name
        artifact_final.write_bytes(self.artifact_bytes)
        signature_final.write_bytes(self.signature_bytes)
        real_stat_at = publisher._stat_at

        def wrong_artifact_mode(directory_fd: int, name: str) -> os.stat_result | None:
            result = real_stat_at(directory_fd, name)
            if result is None or name != self.artifact_name:
                return result
            values = list(result)
            values[0] = (result.st_mode & ~0o777) | 0o600
            return os.stat_result(values)

        with mock.patch.object(publisher, "_stat_at", side_effect=wrong_artifact_mode):
            with self.assertRaisesRegex(publisher.PublisherError, "mode mismatch"):
                publisher._publish_to_target(self.manifest, self.policy)

        self.assertEqual(stat.S_IMODE(artifact_final.stat().st_mode), self.policy.file_mode)
        self.assertEqual(signature_final.read_bytes(), self.signature_bytes)
        self._assert_no_publisher_temporaries()

    def test_source_symlink_is_rejected(self) -> None:
        symlink_path = self.source / "artifact-link.exe"
        symlink_path.symlink_to(self.artifact_path)
        mapping = copy.deepcopy(self.manifest_mapping)
        mapping["artifact"]["sourcePath"] = str(symlink_path)
        manifest = publisher.parse_manifest_object(mapping)

        with self.assertRaisesRegex(publisher.PublisherError, "symlinks"):
            publisher.preflight(manifest, self.policy)

        self.assertEqual(self._target_names(), set())

    def test_source_size_mismatch_is_rejected_before_hashing(self) -> None:
        self.artifact_path.write_bytes(self.artifact_bytes + b"unexpected")

        with mock.patch.object(
            publisher,
            "_hash_fd",
            side_effect=AssertionError("unexpected hash"),
        ) as hash_fd:
            with self.assertRaisesRegex(publisher.PublisherError, "length mismatch"):
                publisher.preflight(self.manifest, self.policy)

        hash_fd.assert_not_called()

    def test_special_source_and_manifest_are_rejected_without_blocking(self) -> None:
        mapping = copy.deepcopy(self.manifest_mapping)
        mapping["artifact"]["sourcePath"] = "/dev/null"
        special_manifest = publisher.parse_manifest_object(mapping)
        with self.assertRaisesRegex(publisher.PublisherError, "regular file"):
            publisher.preflight(special_manifest, self.policy)
        with self.assertRaisesRegex(publisher.ManifestError, "regular file"):
            publisher.load_manifest("/dev/null")

    def test_second_link_failure_rolls_back_every_owned_path(self) -> None:
        real_link = os.link
        link_calls = 0

        def fail_second_link(*args: object, **kwargs: object) -> None:
            nonlocal link_calls
            link_calls += 1
            if link_calls == 2:
                raise OSError(errno.EIO, "injected second-link failure")
            real_link(*args, **kwargs)

        with mock.patch.object(publisher.os, "link", side_effect=fail_second_link):
            with self.assertRaisesRegex(publisher.PublisherError, "publication failed"):
                publisher._publish_to_target(self.manifest, self.policy)

        self.assertEqual(link_calls, 2)
        self.assertFalse((self.target / self.artifact_name).exists())
        self.assertFalse((self.target / self.signature_name).exists())
        self._assert_no_publisher_temporaries()

    def test_copy_failure_rolls_back_registered_temporary(self) -> None:
        with mock.patch.object(
            publisher,
            "_copy_source",
            side_effect=OSError(errno.EIO, "injected copy failure"),
        ):
            with self.assertRaisesRegex(publisher.PublisherError, "publication failed"):
                publisher._publish_to_target(self.manifest, self.policy)

        self.assertEqual(self._target_names(), set())
        self._assert_no_publisher_temporaries()

    def test_target_inode_revalidation_failure_rolls_back_published_links(self) -> None:
        real_revalidate = publisher._assert_target_path_matches_fd
        calls = 0

        def fail_after_links(path: str, directory_fd: int) -> os.stat_result:
            nonlocal calls
            calls += 1
            if calls == 3:
                raise publisher.PublisherError("injected target inode replacement")
            return real_revalidate(path, directory_fd)

        with mock.patch.object(
            publisher,
            "_assert_target_path_matches_fd",
            side_effect=fail_after_links,
        ):
            with self.assertRaisesRegex(publisher.PublisherError, "inode replacement"):
                publisher._publish_to_target(self.manifest, self.policy)

        self.assertGreaterEqual(calls, 4)
        self.assertEqual(self._target_names(), set())

    def test_mutation_signal_mask_is_restored(self) -> None:
        before = signal.pthread_sigmask(signal.SIG_BLOCK, set())
        try:
            with publisher._blocked_mutation_signals():
                during = signal.pthread_sigmask(signal.SIG_BLOCK, set())
                self.assertTrue(publisher.BLOCKED_SIGNALS.issubset(during))
            after = signal.pthread_sigmask(signal.SIG_BLOCK, set())
            self.assertEqual(after, before)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, before)

    def test_rollback_never_unlinks_replaced_foreign_inode(self) -> None:
        real_link = os.link
        first_final = self.target / self.artifact_name
        foreign_bytes = b"foreign-replacement-must-survive"
        link_calls = 0

        def replace_then_fail(*args: object, **kwargs: object) -> None:
            nonlocal link_calls
            link_calls += 1
            if link_calls == 1:
                real_link(*args, **kwargs)
                return

            destination_fd = int(kwargs["dst_dir_fd"])
            os.unlink(self.artifact_name, dir_fd=destination_fd)
            foreign_fd = os.open(
                self.artifact_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o644,
                dir_fd=destination_fd,
            )
            try:
                os.write(foreign_fd, foreign_bytes)
                os.fsync(foreign_fd)
            finally:
                os.close(foreign_fd)
            raise OSError(errno.EIO, "injected failure after inode replacement")

        with mock.patch.object(publisher.os, "link", side_effect=replace_then_fail):
            with self.assertRaisesRegex(
                publisher.PublisherError, "foreign inode left untouched"
            ):
                publisher._publish_to_target(self.manifest, self.policy)

        self.assertEqual(link_calls, 2)
        self.assertTrue(first_final.exists())
        self.assertEqual(first_final.read_bytes(), foreign_bytes)
        self.assertFalse((self.target / self.signature_name).exists())
        self._assert_no_publisher_temporaries()

    def test_manifest_schema_rejects_unknown_fields(self) -> None:
        mapping = copy.deepcopy(self.manifest_mapping)
        mapping["unexpected"] = True

        with self.assertRaisesRegex(publisher.ManifestError, "unexpected"):
            publisher.parse_manifest_object(mapping)

    def test_manifest_rejects_nonincreasing_version_and_oversized_artifact(self) -> None:
        nonincreasing = copy.deepcopy(self.manifest_mapping)
        nonincreasing["baselineVersion"] = self.version
        with self.assertRaisesRegex(publisher.ManifestError, "lower"):
            publisher.parse_manifest_object(nonincreasing)

        oversized = copy.deepcopy(self.manifest_mapping)
        oversized["artifact"]["bytes"] = publisher.MAX_ONLINE_NSIS_BYTES + 1
        with self.assertRaisesRegex(publisher.ManifestError, "online NSIS"):
            publisher.parse_manifest_object(oversized)

    def test_manifest_loader_rejects_a_symlinked_manifest(self) -> None:
        manifest_path = self.root / "manifest.json"
        manifest_path.write_text(json.dumps(self.manifest_mapping), encoding="utf-8")
        manifest_link = self.root / "manifest-link.json"
        manifest_link.symlink_to(manifest_path)

        with self.assertRaisesRegex(publisher.ManifestError, "symlink-free"):
            publisher.load_manifest(str(manifest_link))

    def test_incompatible_target_lock_fails_fast(self) -> None:
        with publisher._locked_target(self.policy, exclusive=True):
            with self.assertRaisesRegex(publisher.PublisherError, "incompatible"):
                publisher.preflight(self.manifest, self.policy)

    def test_production_target_permission_policy_rejects_unsafe_modes(self) -> None:
        safe = os.stat(self.target)
        safe_values = list(safe)
        safe_values[0] = (safe.st_mode & ~0o777) | 0o755
        safe_stat = os.stat_result(safe_values)
        self.real_validate_target_permissions(safe_stat, self.policy)

        unsafe_values = list(safe_stat)
        unsafe_values[0] = (safe_stat.st_mode & ~0o777) | 0o775
        with self.assertRaisesRegex(publisher.PublisherError, "group- or other-writable"):
            self.real_validate_target_permissions(
                os.stat_result(unsafe_values), self.policy
            )


if __name__ == "__main__":
    unittest.main()
