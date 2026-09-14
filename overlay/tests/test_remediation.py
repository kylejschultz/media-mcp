from __future__ import annotations

import copy
import hashlib
import hmac
import json
import shutil
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock, patch

from beets.dbcore.query import MatchQuery
from beets.library import Item, Library
from beets.util import bytestring_path, syspath
from mediafile import Image as MediaImage
from mediafile import ImageType, MediaFile
from PIL import Image as PillowImage
from quart import Quart

from beets_flask_remediation.remediation import (
    MAX_ART_BYTES,
    RemediationError,
    RemediationService,
    Settings,
    create_remediation_blueprint,
)

FIXTURES = Path(__file__).parent / "fixtures"
SCAN_ID = "b652dc32-62d7-49a8-8f57-a63c002cb72f"
RELEASE_ID = "51f1f007-ea77-483e-9560-220e4c30cf8d"
TOKEN = "x" * 32
HMAC_KEY = "h" * 32


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png(color: str = "red", size: tuple[int, int] = (24, 24)) -> bytes:
    output = BytesIO()
    PillowImage.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


class FakeCaaService(RemediationService):
    def __init__(self, settings: Settings, artwork: bytes, library_factory):
        super().__init__(settings, library_factory, lambda: True)
        self.artwork = artwork
        self.operation = 0

    def _download_caa(self, url: str) -> bytes:
        del url
        return self.artwork

    def sign_for_test(self, manifest: dict) -> dict:
        canonical = self._canonical_json(manifest)
        digest = hashlib.sha256(canonical).hexdigest()
        key = HMAC_KEY.encode()
        return {
            "schema": "music-remediation-stored-manifest.v1",
            "manifest_id": f"mrm_{digest[:24]}",
            "digest": digest,
            "signature": hmac.new(key, canonical, hashlib.sha256).hexdigest(),
            "manifest": manifest,
        }

    def preview(self, value: dict) -> dict:
        return super().preview(self.sign_for_test(value) if value.get("schema") == "music-remediation-manifest.v1" else value)

    def apply(self, value: dict, operation_id: str | None = None) -> dict:
        self.operation += 1
        envelope = self.sign_for_test(value) if value.get("schema") == "music-remediation-manifest.v1" else value
        return super().apply(envelope, operation_id or f"{self.operation:032x}")


class FailingSecondAlbumService(FakeCaaService):
    calls = 0

    def _apply_album(self, *args, **kwargs):
        self.calls += 1
        if self.calls == 2:
            raise RemediationError("injected album failure")
        return super()._apply_album(*args, **kwargs)


class SimulatedProcessDeath(BaseException):
    pass


class CrashAfterReplaceService(FakeCaaService):
    def _after_replace(self, relative: str) -> None:
        del relative
        raise SimulatedProcessDeath()


class TruncateBackupService(FakeCaaService):
    def _after_backup_temp_written(self, temporary: Path, destination: Path) -> None:
        del destination
        temporary.write_bytes(b"truncated")


class InterruptBackupService(FakeCaaService):
    def _after_backup_temp_written(self, temporary: Path, destination: Path) -> None:
        del temporary, destination
        raise SimulatedProcessDeath()


class ChangeBeforeReplaceService(FakeCaaService):
    changed = False

    def _write_journal(self, journal: dict) -> None:
        super()._write_journal(journal)
        if not self.changed and journal.get("install_files") and all(entry["state"] == "prepared" for entry in journal["install_files"]):
            self.changed = True
            path = self.settings.library_root / journal["install_files"][0]["path"]
            path.write_bytes(path.read_bytes() + b"changed-between-validation-and-replace")


class CrashAfterBackupDeleteService(FakeCaaService):
    def _after_backup_delete(self, transaction_id: str) -> None:
        del transaction_id
        raise SimulatedProcessDeath()


class CrashBeforeBackupDeleteService(FakeCaaService):
    def _before_backup_delete(self, transaction_id: str) -> None:
        del transaction_id
        raise SimulatedProcessDeath()


class CrashAfterRollbackReplaceService(FakeCaaService):
    crashed = False

    def _after_rollback_replace(self, relative: str) -> None:
        del relative
        if not self.crashed:
            self.crashed = True
            raise SimulatedProcessDeath()


class CrashDuringRollbackDatabaseService(FakeCaaService):
    crashed = False

    def _during_db_restore(self, relative: str) -> None:
        del relative
        if not self.crashed:
            self.crashed = True
            raise SimulatedProcessDeath()


class SwapParentBeforeReplaceService(FakeCaaService):
    moved_parent: Path | None = None
    linked_parent: Path | None = None

    def _replace_file(self, source: Path, destination: Path, expected_parent: dict[str, int]) -> None:
        if self.moved_parent is None:
            self.linked_parent = destination.parent
            self.moved_parent = destination.parent.with_name(f"{destination.parent.name}.moved")
            destination.parent.rename(self.moved_parent)
            destination.parent.symlink_to(self.moved_parent.name, target_is_directory=True)
        super()._replace_file(source, destination, expected_parent)


class FailDatabaseOnceService(FakeCaaService):
    failed = False

    def _sync_db_album(self, *args, **kwargs) -> None:
        super()._sync_db_album(*args, **kwargs)
        if not self.failed:
            self.failed = True
            raise RemediationError("injected database failure")


class RemediationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.library = root / "library"
        self.backup = root / "backup"
        self.library.mkdir()
        self.backup.mkdir()
        self.settings = Settings(True, True, True, TOKEN, HMAC_KEY, self.library, self.backup, SCAN_ID, frozenset({"Hip-Hop & Rap", "Rock", "Electronic & Dance"}), "/usr/bin/ffmpeg")
        self.target_art = png("blue")
        self.db = Library(str(root / "library.db"), directory=str(self.library))
        self.service = FakeCaaService(self.settings, self.target_art, lambda: self.db)
        self.manifest = self.make_album("Artist/Album", "alb_ceb0175f3fb6d87a79c41606")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def make_album(self, album_path: str, album_id: str, release_id: str = RELEASE_ID) -> dict:
        directory = self.library / album_path
        directory.mkdir(parents=True)
        old_art = (FIXTURES / "cover.png").read_bytes()
        tracks = []
        for filename, fixture in (("01 Test.flac", "test.flac"), ("02 Test.mp3", "test.mp3")):
            path = directory / filename
            shutil.copyfile(FIXTURES / fixture, path)
            media = MediaFile(str(path))
            media.mb_albumid = release_id
            media.genres = ["Rock"]
            media.images = [MediaImage(data=old_art, type=ImageType.front)]
            media.save()
            tracks.append({
                "path": f"{album_path}/{filename}",
                "expected_file_sha256": sha(path),
                "expected_embedded_sha256": [hashlib.sha256(old_art).hexdigest()],
            })
        sidecar = directory / "cover.png"
        sidecar.write_bytes(old_art)
        db_album = self.db.add_album([Item.from_path(str(directory / filename)) for filename in ("01 Test.flac", "02 Test.mp3")])
        db_album.artpath = bytestring_path(str(sidecar))
        db_album.store(inherit=False)
        return {
            "schema": "music-remediation-manifest.v1",
            "snapshot_id": SCAN_ID,
            "albums": [{
                "album_id": album_id,
                "album_path": album_path,
                "musicbrainz_release_id": release_id,
                "tracks": tracks,
                "sidecar": {"path": f"{album_path}/cover.png", "expected_sha256": sha(sidecar)},
                "genres": ["Hip-Hop & Rap", "Electronic & Dance"],
                "art": {
                    "source": "caa",
                    "url": f"https://coverartarchive.org/release/{release_id}/30550660152.png",
                    "expected_sha256": hashlib.sha256(self.target_art).hexdigest(),
                },
            }],
        }

    def original_bytes(self, manifest: dict | None = None) -> dict[str, bytes]:
        manifest = manifest or self.manifest
        paths = []
        for album in manifest["albums"]:
            paths.extend(track["path"] for track in album["tracks"])
            paths.append(album["sidecar"]["path"])
        return {path: (self.library / path).read_bytes() for path in paths}

    def attestation(self, transaction_id: str, state: list[dict], scan_id: str = "11111111-1111-4111-8111-111111111111") -> tuple[dict, str]:
        value = {
            "schema": "music-remediation-finalize-attestation.v1",
            "transaction_id": transaction_id,
            "manifest_snapshot_id": SCAN_ID,
            "post_audit_scan_id": scan_id,
            "albums": self.service._proof_albums(state),
        }
        signature = hmac.new(HMAC_KEY.encode(), self.service._canonical_json(value), hashlib.sha256).hexdigest()
        return value, signature

    def finalize_tx(self, service: RemediationService, transaction_id: str, state: list[dict], scan_id: str = "11111111-1111-4111-8111-111111111111") -> dict:
        attestation, signature = self.attestation(transaction_id, state, scan_id)
        return service.finalize(transaction_id, attestation, signature)

    def journal(self, transaction_id: str) -> dict:
        return json.loads((self.backup / "journals" / f"{transaction_id}.json").read_text())

    def signed(self, manifest: dict) -> dict:
        return self.service.sign_for_test(manifest)

    def test_preview_is_a_no_write_exact_diff(self) -> None:
        before = self.original_bytes()
        result = self.service.preview(self.manifest)
        self.assertEqual(result["checks"]["writes_performed"], False)
        self.assertEqual(result["track_count"], 2)
        self.assertEqual(result["albums"][0]["canonical_art_sha256"], hashlib.sha256(self.target_art).hexdigest())
        self.assertEqual(self.original_bytes(), before)
        self.assertFalse(any((self.backup / "transactions").iterdir()))

    def test_signed_manifest_and_reviewed_caa_hash_are_required(self) -> None:
        envelope = self.signed(self.manifest)
        envelope["manifest"]["albums"][0]["genres"] = ["Rock"]
        with self.assertRaisesRegex(RemediationError, "digest|signature"):
            self.service.preview(envelope)
        stale = copy.deepcopy(self.manifest)
        stale["albums"][0]["art"]["expected_sha256"] = "0" * 64
        with self.assertRaisesRegex(RemediationError, "reviewed SHA"):
            self.service.preview(stale)

    def test_art_digest_returns_only_review_metadata(self) -> None:
        url = self.manifest["albums"][0]["art"]["url"]
        result = self.service.art_digest(RELEASE_ID, url)
        self.assertEqual(result["sha256"], hashlib.sha256(self.target_art).hexdigest())
        self.assertEqual(result["format"], "png")
        self.assertNotIn("data", result)

    def test_mutation_refuses_active_beets_queues(self) -> None:
        service = RemediationService(self.settings, lambda: self.db, lambda: False)
        with self.assertRaisesRegex(RemediationError, "queues or jobs are active"):
            service.apply(self.signed(self.manifest), "a" * 32)

    def test_happy_path_preserves_audio_and_rolls_back_byte_identically(self) -> None:
        before = self.original_bytes()
        original_db_mtimes = {}
        for item in self.db.items(MatchQuery("mb_albumid", RELEASE_ID)):
            item.mtime -= 5
            item.store()
            original_db_mtimes[item.id] = item.mtime
        essence = {track["path"]: self.service._audio_essence(self.library / track["path"]) for track in self.manifest["albums"][0]["tracks"]}
        result = self.service.apply(self.manifest)
        self.assertRegex(result["transaction_id"], r"^[a-f0-9]{32}$")
        for track in result["post_state"][0]["tracks"]:
            media = MediaFile(str(self.library / track["path"]))
            self.assertEqual(list(media.genres), ["Hip-Hop & Rap", "Electronic & Dance"])
            self.assertEqual([hashlib.sha256(image.data).hexdigest() for image in media.images], [hashlib.sha256(self.target_art).hexdigest()])
            self.assertEqual(self.service._audio_essence(self.library / track["path"]), essence[track["path"]])
        sidecar = self.library / self.manifest["albums"][0]["sidecar"]["path"]
        db_items = list(self.db.items(MatchQuery("mb_albumid", RELEASE_ID)))
        self.assertTrue(db_items)
        self.assertTrue(all(item.genre == "Hip-Hop & Rap" for item in db_items))
        self.assertTrue(all(item.mtime == item.current_mtime() for item in db_items))
        self.assertTrue(all(item.try_filesize() == Path(item.filepath).stat().st_size for item in db_items))
        self.assertEqual(self.db.get_album(db_items[0]).genre, "Hip-Hop & Rap")
        self.assertEqual(self.db.get_album(db_items[0]).artpath, bytestring_path(str(sidecar)))
        self.assertEqual(sidecar.read_bytes(), self.target_art)
        self.service.rollback(result["transaction_id"])
        self.assertEqual(self.original_bytes(), before)
        rolled_back_items = list(self.db.items(MatchQuery("mb_albumid", RELEASE_ID)))
        self.assertTrue(all(item.genre == "Rock" for item in rolled_back_items))
        self.assertTrue(all(item.mtime == original_db_mtimes[item.id] for item in rolled_back_items))
        self.assertTrue(all(item.try_filesize() == Path(item.filepath).stat().st_size for item in rolled_back_items))
        self.finalize_tx(self.service, result["transaction_id"], self.journal(result["transaction_id"])["original_state"])
        self.assertFalse((self.backup / "transactions" / result["transaction_id"]).exists())
        journal = json.loads((self.backup / "journals" / f"{result['transaction_id']}.json").read_text())
        self.assertEqual(journal["status"], "finalized")

    def test_active_transaction_blocks_concurrent_apply(self) -> None:
        result = self.service.apply(self.manifest)
        repeated = self.service.apply(self.manifest, result["transaction_id"])
        self.assertEqual(repeated["transaction_id"], result["transaction_id"])
        self.assertEqual(repeated["status"], "applied")
        with self.assertRaisesRegex(RemediationError, "non-finalized"):
            self.service.apply(self.manifest)
        self.service.rollback(result["transaction_id"])
        with self.assertRaisesRegex(RemediationError, "only for an applied"):
            self.service.rollback(result["transaction_id"])
        self.finalize_tx(self.service, result["transaction_id"], self.journal(result["transaction_id"])["original_state"])

    def test_manual_rollback_refuses_unknown_and_non_applied_states(self) -> None:
        with self.assertRaisesRegex(RemediationError, "Unknown transaction"):
            self.service.rollback("f" * 32)
        result = self.service.apply(self.manifest)
        journal = self.journal(result["transaction_id"])
        for status in ("applying", "rolling_back", "failed_restored", "failed_conflict", "finalizing"):
            journal["status"] = status
            self.service._write_journal(journal)
            with self.assertRaisesRegex(RemediationError, "only for an applied"):
                self.service.rollback(result["transaction_id"])
        journal["status"] = "applied"
        self.service._write_journal(journal)
        self.service.rollback(result["transaction_id"])
        self.finalize_tx(self.service, result["transaction_id"], self.journal(result["transaction_id"])["original_state"])

    def test_partial_batch_failure_restores_prior_album(self) -> None:
        second_release = "11111111-1111-4111-8111-111111111111"
        second_id = f"alb_{hashlib.sha256(f'mb:{second_release}'.encode()).hexdigest()[:24]}"
        second = self.make_album("Artist/Second", second_id, second_release)["albums"][0]
        manifest = copy.deepcopy(self.manifest)
        manifest["albums"].append(second)
        before = self.original_bytes(manifest)
        service = FailingSecondAlbumService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaisesRegex(RemediationError, "injected"):
            service.apply(manifest)
        self.assertEqual(self.original_bytes(manifest), before)
        self.assertTrue(all(item.genre == "Rock" for item in self.db.items()))
        journal_path = next((self.backup / "journals").glob("*.json"))
        journal = json.loads(journal_path.read_text())
        self.assertEqual(journal["status"], "failed_restored")
        self.finalize_tx(service, journal["transaction_id"], journal["original_state"])

    def test_restart_recovery_after_replace_before_progress_update(self) -> None:
        before = self.original_bytes()
        crashing = CrashAfterReplaceService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaises(SimulatedProcessDeath):
            crashing.apply(self.manifest)
        journal_path = next((self.backup / "journals").glob("*.json"))
        journal = json.loads(journal_path.read_text())
        self.assertEqual(journal["status"], "applying")
        replacing = next(entry for entry in journal["install_files"] if entry["state"] == "replacing")
        self.assertTrue(replacing["backup_committed"])
        self.assertEqual(replacing["backup_sha256"], replacing["original_sha256"])
        recovered = FakeCaaService(self.settings, self.target_art, lambda: self.db)
        status = recovered.transaction()
        self.assertEqual(status["active"]["transaction_id"], journal["transaction_id"])
        self.assertNotIn("path", json.dumps(status))
        with self.assertRaisesRegex(RemediationError, "non-finalized"):
            recovered.apply(self.manifest, "f" * 32)
        recovered.transaction(journal["transaction_id"], recover=True)
        self.assertEqual(self.original_bytes(), before)
        self.finalize_tx(recovered, journal["transaction_id"], journal["original_state"])

    def test_truncated_backup_is_not_committed_or_used(self) -> None:
        before = self.original_bytes()
        service = TruncateBackupService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaisesRegex(RemediationError, "Backup hash"):
            service.apply(self.manifest)
        self.assertEqual(self.original_bytes(), before)
        journal = json.loads(next((self.backup / "journals").glob("*.json")).read_text())
        self.assertEqual(journal["status"], "failed_restored")
        self.assertFalse(journal["install_files"][0]["backup_committed"])
        self.assertFalse((self.backup / "transactions" / journal["transaction_id"] / "original" / journal["install_files"][0]["path"]).exists())
        self.finalize_tx(service, journal["transaction_id"], journal["original_state"])

    def test_interruption_during_backup_never_replaces_live_file(self) -> None:
        before = self.original_bytes()
        service = InterruptBackupService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaises(SimulatedProcessDeath):
            service.apply(self.manifest)
        self.assertEqual(self.original_bytes(), before)
        journal = json.loads(next((self.backup / "journals").glob("*.json")).read_text())
        self.assertEqual(journal["status"], "applying")
        self.assertFalse(journal["install_files"][0]["backup_committed"])
        recovered = FakeCaaService(self.settings, self.target_art, lambda: self.db)
        recovered.transaction(journal["transaction_id"], recover=True)
        journal = self.journal(journal["transaction_id"])
        self.finalize_tx(recovered, journal["transaction_id"], journal["original_state"])

    def test_identity_recheck_detects_conflict_without_overwriting_it(self) -> None:
        before = self.original_bytes()
        service = ChangeBeforeReplaceService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaisesRegex(RemediationError, "hash does not match"):
            service.apply(self.manifest)
        after = self.original_bytes()
        changed_path = self.manifest["albums"][0]["tracks"][0]["path"]
        self.assertNotEqual(after[changed_path], before[changed_path])
        self.assertTrue(after[changed_path].endswith(b"changed-between-validation-and-replace"))
        journal = json.loads(next((self.backup / "journals").glob("*.json")).read_text())
        self.assertEqual(journal["status"], "failed_conflict")

    def test_parent_symlink_swap_is_detected_before_replace(self) -> None:
        before = self.original_bytes()
        service = SwapParentBeforeReplaceService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaisesRegex(RemediationError, "symlink"):
            service.apply(self.manifest)
        assert service.linked_parent is not None and service.moved_parent is not None
        service.linked_parent.unlink()
        service.moved_parent.rename(service.linked_parent)
        self.assertEqual(self.original_bytes(), before)

    def test_database_failure_restores_files_and_database(self) -> None:
        before = self.original_bytes()
        service = FailDatabaseOnceService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaisesRegex(RemediationError, "database failure"):
            service.apply(self.manifest)
        self.assertEqual(self.original_bytes(), before)
        self.assertTrue(all(item.genre == "Rock" for item in self.db.items()))

    def test_recovers_legacy_failed_conflict_without_overwriting_rescanned_mtimes(self) -> None:
        before = self.original_bytes()
        for item in self.db.items(MatchQuery("mb_albumid", RELEASE_ID)):
            item.mtime -= 5
            item.store()
        service = FailDatabaseOnceService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaisesRegex(RemediationError, "database failure"):
            service.apply(self.manifest)
        journal = json.loads(next((self.backup / "journals").glob("*.json")).read_text())
        journal["status"] = "failed_conflict"
        journal.pop("inflight_post_state", None)
        service._write_journal(journal)
        rescanned_mtimes = {}
        for item in self.db.items(MatchQuery("mb_albumid", RELEASE_ID)):
            item.read()
            item.genre = "Rock"
            item.store()
            rescanned_mtimes[item.id] = item.mtime
        recovered = FakeCaaService(self.settings, self.target_art, lambda: self.db)
        recovered.transaction(journal["transaction_id"], recover=True)
        self.assertEqual(self.original_bytes(), before)
        stored = self.journal(journal["transaction_id"])
        self.assertEqual(stored["status"], "failed_restored")
        items = list(self.db.items(MatchQuery("mb_albumid", RELEASE_ID)))
        self.assertTrue(all(item.mtime == rescanned_mtimes[item.id] for item in items))
        expected = stored["original_state"][0]["db"]["items"]
        self.assertTrue(all(expected[str(Path(syspath(item.path)).relative_to(self.library))]["mtime"] == item.mtime for item in items))

    def test_two_ordered_genres_and_database_state_round_trip(self) -> None:
        before = self.original_bytes()
        self.manifest["albums"][0]["genres"] = ["Electronic & Dance", "Hip-Hop & Rap"]
        result = self.service.apply(self.manifest)
        for track in result["post_state"][0]["tracks"]:
            self.assertEqual(list(MediaFile(str(self.library / track["path"])).genres), self.manifest["albums"][0]["genres"])
        self.assertEqual(result["post_state"][0]["db"]["album"]["genre"], "Electronic & Dance")
        self.service.rollback(result["transaction_id"])
        self.assertEqual(self.original_bytes(), before)
        original = self.journal(result["transaction_id"])["original_state"][0]
        self.assertEqual(original["db"]["album"]["genre"], "Rock")
        self.finalize_tx(self.service, result["transaction_id"], [original])

    def test_rollback_refuses_to_overwrite_later_edits(self) -> None:
        result = self.service.apply(self.manifest)
        path = self.library / self.manifest["albums"][0]["tracks"][0]["path"]
        path.write_bytes(path.read_bytes() + b"later-edit")
        with self.assertRaisesRegex(RemediationError, "hash does not match"):
            self.service.rollback(result["transaction_id"])

    def test_rollback_recovery_resumes_after_one_replacement(self) -> None:
        before = self.original_bytes()
        service = CrashAfterRollbackReplaceService(self.settings, self.target_art, lambda: self.db)
        result = service.apply(self.manifest)
        with self.assertRaises(SimulatedProcessDeath):
            service.rollback(result["transaction_id"])
        journal = self.journal(result["transaction_id"])
        self.assertEqual(journal["status"], "rolling_back")
        self.assertEqual([entry["state"] for entry in journal["install_files"]].count("installed"), 3)
        hashes = {path: sha(self.library / path) for path in before}
        self.assertEqual(sum(hashes[path] == hashlib.sha256(original).hexdigest() for path, original in before.items()), 1)
        recovered = FakeCaaService(self.settings, self.target_art, lambda: self.db)
        recovered.transaction(result["transaction_id"], recover=True)
        self.assertEqual(self.original_bytes(), before)
        self.assertEqual(self.journal(result["transaction_id"])["status"], "rolled_back")
        self.assertTrue(all(item.genre == "Rock" for item in self.db.items()))

    def test_rollback_recovery_resumes_during_database_restoration(self) -> None:
        before = self.original_bytes()
        service = CrashDuringRollbackDatabaseService(self.settings, self.target_art, lambda: self.db)
        result = service.apply(self.manifest)
        with self.assertRaises(SimulatedProcessDeath):
            service.rollback(result["transaction_id"])
        self.assertEqual(self.journal(result["transaction_id"])["status"], "rolling_back")
        self.assertEqual(self.original_bytes(), before)
        recovered = FakeCaaService(self.settings, self.target_art, lambda: self.db)
        recovered.transaction(result["transaction_id"], recover=True)
        self.assertEqual(self.original_bytes(), before)
        self.assertEqual(self.journal(result["transaction_id"])["status"], "rolled_back")
        self.assertTrue(all(item.genre == "Rock" for item in self.db.items()))

    def test_rolling_back_recovery_does_not_overwrite_a_conflict(self) -> None:
        service = CrashAfterRollbackReplaceService(self.settings, self.target_art, lambda: self.db)
        result = service.apply(self.manifest)
        with self.assertRaises(SimulatedProcessDeath):
            service.rollback(result["transaction_id"])
        conflict = self.library / self.manifest["albums"][0]["tracks"][1]["path"]
        conflict.write_bytes(conflict.read_bytes() + b"operator-change")
        recovered = FakeCaaService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaisesRegex(RemediationError, "conflicts"):
            recovered.transaction(result["transaction_id"], recover=True)
        self.assertTrue(conflict.read_bytes().endswith(b"operator-change"))
        self.assertEqual(self.journal(result["transaction_id"])["status"], "rolling_back")

    def test_rolling_back_recovery_does_not_overwrite_a_database_conflict(self) -> None:
        service = CrashDuringRollbackDatabaseService(self.settings, self.target_art, lambda: self.db)
        result = service.apply(self.manifest)
        with self.assertRaises(SimulatedProcessDeath):
            service.rollback(result["transaction_id"])
        conflict = list(self.db.items(MatchQuery("mb_albumid", RELEASE_ID)))[-1]
        conflict.genre = "External Edit"
        conflict.store()
        recovered = FakeCaaService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaisesRegex(RemediationError, "database item conflicts"):
            recovered.transaction(result["transaction_id"], recover=True)
        self.assertEqual(self.db.get_item(conflict.id).genre, "External Edit")
        self.assertEqual(self.journal(result["transaction_id"])["status"], "rolling_back")

    def test_finalize_requires_exact_signed_distinct_attestation_and_is_retryable(self) -> None:
        with self.assertRaisesRegex(RemediationError, "Invalid transaction"):
            self.service.finalize("../bad", {})
        result = self.service.apply(self.manifest)
        transaction_id = result["transaction_id"]
        stale, stale_signature = self.attestation(transaction_id, result["post_state"], SCAN_ID)
        with self.assertRaisesRegex(RemediationError, "must differ"):
            self.service.finalize(transaction_id, stale, stale_signature)
        wrong, signature = self.attestation(transaction_id, result["post_state"])
        wrong["albums"][0]["tracks"][0]["file_sha256"] = "0" * 64
        with self.assertRaisesRegex(RemediationError, "does not exactly match"):
            self.service.finalize(transaction_id, wrong, signature)
        valid, signature = self.attestation(transaction_id, result["post_state"])
        tampered = copy.deepcopy(valid)
        tampered["post_audit_scan_id"] = "22222222-2222-4222-8222-222222222222"
        with self.assertRaisesRegex(RemediationError, "HMAC"):
            self.service.finalize(transaction_id, tampered, signature)
        with self.assertRaisesRegex(RemediationError, "HMAC"):
            self.service.finalize(transaction_id, valid, "0" * 64)
        with self.assertRaisesRegex(RemediationError, "HMAC"):
            self.service.finalize(transaction_id, valid, None)
        finalized = self.service.finalize(transaction_id, valid, signature)
        retried = self.service.finalize(transaction_id)
        self.assertEqual(retried, finalized)

    def test_status_reconciles_finalizing_after_backup_deletion_crash(self) -> None:
        service = CrashAfterBackupDeleteService(self.settings, self.target_art, lambda: self.db)
        result = service.apply(self.manifest)
        with self.assertRaises(SimulatedProcessDeath):
            self.finalize_tx(service, result["transaction_id"], result["post_state"])
        journal = self.journal(result["transaction_id"])
        self.assertEqual(journal["status"], "finalizing")
        self.assertFalse((self.backup / "transactions" / result["transaction_id"]).exists())
        recovered = FakeCaaService(self.settings, self.target_art, lambda: self.db)
        self.assertIsNone(recovered.transaction()["active"])
        self.assertEqual(self.journal(result["transaction_id"])["status"], "finalized")

    def test_status_never_reports_applied_when_backup_is_missing(self) -> None:
        result = self.service.apply(self.manifest)
        shutil.rmtree(self.backup / "transactions" / result["transaction_id"])
        status = self.service.transaction(result["transaction_id"])
        self.assertEqual(status["active"]["status"], "corrupt_missing_backup")
        self.assertEqual(self.journal(result["transaction_id"])["status"], "corrupt_missing_backup")

    def test_startup_reconciles_finalizing_before_backup_deletion(self) -> None:
        result = self.service.apply(self.manifest)
        crashing = CrashBeforeBackupDeleteService(self.settings, self.target_art, lambda: self.db)
        with self.assertRaises(SimulatedProcessDeath):
            self.finalize_tx(crashing, result["transaction_id"], result["post_state"])
        self.assertEqual(self.journal(result["transaction_id"])["status"], "finalizing")
        self.assertTrue((self.backup / "transactions" / result["transaction_id"]).exists())
        FakeCaaService(self.settings, self.target_art, lambda: self.db)
        self.assertEqual(self.journal(result["transaction_id"])["status"], "finalized")
        self.assertFalse((self.backup / "transactions" / result["transaction_id"]).exists())

    def test_rejects_stale_scan_hash_track_set_release_and_genre(self) -> None:
        cases = []
        stale_scan = copy.deepcopy(self.manifest)
        stale_scan["snapshot_id"] = "11111111-1111-4111-8111-111111111111"
        cases.append(stale_scan)
        stale_hash = copy.deepcopy(self.manifest)
        stale_hash["albums"][0]["tracks"][0]["expected_file_sha256"] = "0" * 64
        cases.append(stale_hash)
        stale_sidecar = copy.deepcopy(self.manifest)
        stale_sidecar["albums"][0]["sidecar"]["expected_sha256"] = "0" * 64
        cases.append(stale_sidecar)
        bad_genre = copy.deepcopy(self.manifest)
        bad_genre["albums"][0]["genres"] = ["Not Approved"]
        cases.append(bad_genre)
        for manifest in cases:
            with self.subTest(manifest=manifest):
                with self.assertRaises(RemediationError):
                    self.service.preview(manifest)
        extra = self.library / "Artist/Album/03 Extra.flac"
        shutil.copyfile(FIXTURES / "test.flac", extra)
        with self.assertRaisesRegex(RemediationError, "track set"):
            self.service.preview(self.manifest)
        extra.unlink()
        track_path = self.library / self.manifest["albums"][0]["tracks"][0]["path"]
        media = MediaFile(str(track_path))
        media.mb_albumid = "11111111-1111-4111-8111-111111111111"
        media.save()
        self.manifest["albums"][0]["tracks"][0]["expected_file_sha256"] = sha(track_path)
        with self.assertRaisesRegex(RemediationError, "MusicBrainz"):
            self.service.preview(self.manifest)

    def test_rejects_traversal_symlink_unsupported_and_schema_bounds(self) -> None:
        traversal = copy.deepcopy(self.manifest)
        traversal["albums"][0]["tracks"][0]["path"] = "Artist/Album/../escape.flac"
        with self.assertRaises(RemediationError):
            self.service.preview(traversal)
        unsupported = copy.deepcopy(self.manifest)
        unsupported["albums"][0]["tracks"][0]["path"] = "Artist/Album/file.mp4"
        with self.assertRaisesRegex(RemediationError, "Only FLAC"):
            self.service.preview(unsupported)
        oversized = copy.deepcopy(self.manifest)
        oversized["albums"] = oversized["albums"] * 11
        with self.assertRaises(RemediationError):
            self.service.preview(oversized)
        track = self.library / self.manifest["albums"][0]["tracks"][0]["path"]
        hardlink = track.with_suffix(".hardlink")
        hardlink.hardlink_to(track)
        with self.assertRaisesRegex(RemediationError, "hardlinked"):
            self.service.preview(self.manifest)
        hardlink.unlink()
        target = track.with_suffix(".real")
        track.rename(target)
        track.symlink_to(target.name)
        with self.assertRaisesRegex(RemediationError, "symlink"):
            self.service.preview(self.manifest)

    def test_rejects_corrupt_oversized_and_wrong_format_art(self) -> None:
        for artwork in (b"not an image", b"x" * (MAX_ART_BYTES + 1)):
            with self.subTest(size=len(artwork)):
                with self.assertRaises(RemediationError):
                    FakeCaaService(self.settings, artwork, lambda: self.db).preview(self.manifest)
        with patch("beets_flask_remediation.remediation.MAX_ART_PIXELS", 100):
            with self.assertRaises(RemediationError):
                FakeCaaService(self.settings, png(size=(11, 11)), lambda: self.db).preview(self.manifest)
        jpeg = BytesIO()
        PillowImage.new("RGB", (10, 10), "red").save(jpeg, "JPEG")
        with self.assertRaisesRegex(RemediationError, "format"):
            FakeCaaService(self.settings, jpeg.getvalue(), lambda: self.db).preview(self.manifest)

    def test_local_sidecar_source_and_caa_url_are_exactly_bound(self) -> None:
        local = copy.deepcopy(self.manifest)
        sidecar = local["albums"][0]["sidecar"]
        local["albums"][0]["art"] = {"source": "sidecar", "path": sidecar["path"], "expected_sha256": sidecar["expected_sha256"]}
        self.assertEqual(self.service.preview(local)["album_count"], 1)
        for url in (
            f"http://coverartarchive.org/release/{RELEASE_ID}/1.png",
            f"https://example.com/release/{RELEASE_ID}/1.png",
            "file:///tmp/cover.png",
            f"https://coverartarchive.org/release/11111111-1111-4111-8111-111111111111/1.png",
        ):
            invalid = copy.deepcopy(self.manifest)
            invalid["albums"][0]["art"]["url"] = url
            with self.assertRaises(RemediationError):
                self.service.preview(invalid)

    def test_archive_redirect_rejects_credentials_ports_queries_and_wrong_objects(self) -> None:
        base = f"dn711107.ca.archive.org/0/items/mbid-{RELEASE_ID}/mbid-{RELEASE_ID}-30550660152.png"
        for location in (
            f"https://user@{base}",
            f"https://dn711107.ca.archive.org:443/0/items/mbid-{RELEASE_ID}/mbid-{RELEASE_ID}-30550660152.png",
            f"https://{base}?download=1",
            f"https://{base}#fragment",
            f"https://dn711107.ca.archive.org/0/items/mbid-{RELEASE_ID}/other.png",
        ):
            with self.subTest(location=location):
                with self.assertRaises(RemediationError):
                    self.service._validate_caa_redirect(location, RELEASE_ID, "30550660152", "png")

    @patch("beets_flask_remediation.remediation.socket.getaddrinfo")
    @patch("beets_flask_remediation.remediation.requests.Session")
    def test_network_accepts_bound_archive_handoffs(self, session_class: Mock, getaddrinfo: Mock) -> None:
        url = self.manifest["albums"][0]["art"]["url"]
        getaddrinfo.return_value = [(None, None, None, None, ("8.8.8.8", 443))]
        target = f"https://dn711107.ca.archive.org/0/items/mbid-{RELEASE_ID}/mbid-{RELEASE_ID}-30550660152.png"
        redirect = Mock(status_code=307, is_redirect=True, url=url, headers={"Location": target})
        response = Mock(status_code=200, is_redirect=False, url=target, headers={})
        response.iter_content.return_value = [self.target_art]
        session = session_class.return_value
        session.get.side_effect = [redirect, response]
        network_service = RemediationService(self.settings, lambda: self.db, lambda: True)
        self.assertEqual(network_service._download_caa(url), self.target_art)
        self.assertEqual(session.get.call_count, 2)

        download = f"https://archive.org/download/mbid-{RELEASE_ID}/mbid-{RELEASE_ID}-30550660152.png"
        first = Mock(status_code=307, is_redirect=True, url=url, headers={"Location": download})
        second = Mock(status_code=302, is_redirect=True, url=download, headers={"Location": target})
        final = Mock(status_code=200, is_redirect=False, url=target, headers={})
        final.iter_content.return_value = [self.target_art]
        session.get.side_effect = [first, second, final]
        session.get.reset_mock()
        self.assertEqual(network_service._download_caa(url), self.target_art)
        self.assertEqual(session.get.call_count, 3)

    @patch("beets_flask_remediation.remediation.socket.getaddrinfo")
    @patch("beets_flask_remediation.remediation.requests.Session")
    def test_network_rejects_arbitrary_private_and_multihop_redirects(self, session_class: Mock, getaddrinfo: Mock) -> None:
        url = self.manifest["albums"][0]["art"]["url"]
        valid = f"https://dn711107.ca.archive.org/0/items/mbid-{RELEASE_ID}/mbid-{RELEASE_ID}-30550660152.png"
        session = session_class.return_value
        network_service = RemediationService(self.settings, lambda: self.db, lambda: True)
        getaddrinfo.return_value = [(None, None, None, None, ("8.8.8.8", 443))]
        arbitrary = Mock(status_code=302, is_redirect=True, url=url, headers={"Location": "https://example.com/file.png"})
        session.get.side_effect = [arbitrary]
        with self.assertRaisesRegex(RemediationError, "not the bound"):
            network_service._download_caa(url)

        getaddrinfo.side_effect = [
            [(None, None, None, None, ("8.8.8.8", 443))],
            [(None, None, None, None, ("127.0.0.1", 443))],
        ]
        private = Mock(status_code=302, is_redirect=True, url=url, headers={"Location": valid})
        session.get.side_effect = [private]
        with self.assertRaisesRegex(RemediationError, "non-public"):
            network_service._download_caa(url)

        getaddrinfo.side_effect = None
        getaddrinfo.return_value = [(None, None, None, None, ("8.8.8.8", 443))]
        first = Mock(status_code=302, is_redirect=True, url=url, headers={"Location": valid})
        second = Mock(status_code=302, is_redirect=True, url=valid, headers={"Location": valid})
        session.get.side_effect = [first, second]
        with self.assertRaisesRegex(RemediationError, "multi-hop"):
            network_service._download_caa(url)

    def test_enabled_startup_requires_token_scan_and_allowlist(self) -> None:
        with patch.dict("os.environ", {"BEETS_REMEDIATION_ENABLED": "true"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "TOKEN"):
                Settings.from_env()

    def test_route_authorization_request_bound_and_closed_disabled_state(self) -> None:
        app = Quart(__name__)
        app.register_blueprint(create_remediation_blueprint(self.settings, self.service))
        routes = {rule.rule for rule in app.url_map.iter_rules()}
        for route in ("art-digest", "preview", "apply", "rollback", "finalize-state", "finalize", "status", "recover"):
            self.assertIn(f"/api_v1/remediation/{route}", routes)
        client = app.test_client()

        async def checks() -> None:
            response = await client.post("/api_v1/remediation/preview", json={"manifest": self.manifest})
            self.assertEqual(response.status_code, 401)
            response = await client.post("/api_v1/remediation/preview", headers={"Authorization": f"Bearer {TOKEN}"}, json={"manifest": self.signed(self.manifest)})
            self.assertEqual(response.status_code, 200)
            applied = self.service.apply(self.manifest)
            response = await client.post(
                "/api_v1/remediation/finalize-state",
                headers={"Authorization": f"Bearer {TOKEN}"},
                json={"transaction_id": applied["transaction_id"]},
            )
            self.assertEqual(response.status_code, 200)
            finalize_state = await response.get_json()
            self.assertEqual(finalize_state["expected_state"], self.service._proof_albums(applied["post_state"]))
            fabricated, _ = self.attestation(applied["transaction_id"], applied["post_state"])
            response = await client.post(
                "/api_v1/remediation/finalize",
                headers={"Authorization": f"Bearer {TOKEN}"},
                json={"transaction_id": applied["transaction_id"], "attestation": fabricated, "signature": "0" * 64},
            )
            self.assertEqual(response.status_code, 409)
            self.assertIn("HMAC", (await response.get_json())["error"])
            blocked_settings = Settings(True, False, True, TOKEN, HMAC_KEY, self.library, self.backup, SCAN_ID, self.settings.genres, "/usr/bin/ffmpeg")
            blocked = Quart("blocked")
            blocked_service = FakeCaaService(blocked_settings, self.target_art, lambda: self.db)
            blocked.register_blueprint(create_remediation_blueprint(blocked_settings, blocked_service))
            response = await blocked.test_client().post(
                "/api_v1/remediation/apply",
                headers={"Authorization": f"Bearer {TOKEN}"},
                json={"manifest": self.signed(self.manifest), "operation_id": "f" * 32},
            )
            self.assertEqual(response.status_code, 409)
            self.assertIn("WRITES_ENABLED", (await response.get_json())["error"])
            maintenance_settings = Settings(True, True, False, TOKEN, HMAC_KEY, self.library, self.backup, SCAN_ID, self.settings.genres, "/usr/bin/ffmpeg")
            maintenance = Quart("maintenance")
            maintenance_service = FakeCaaService(maintenance_settings, self.target_art, lambda: self.db)
            maintenance.register_blueprint(create_remediation_blueprint(maintenance_settings, maintenance_service))
            response = await maintenance.test_client().post(
                "/api_v1/remediation/apply",
                headers={"Authorization": f"Bearer {TOKEN}"},
                json={"manifest": self.signed(self.manifest), "operation_id": "e" * 32},
            )
            self.assertEqual(response.status_code, 409)
            self.assertIn("MAINTENANCE", (await response.get_json())["error"])
            response = await client.post(
                "/api_v1/remediation/preview",
                headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
                data=b" " * (1024 * 1024 + 1),
            )
            self.assertEqual(response.status_code, 413)

            disabled_settings = Settings(False, False, False, None, None, self.library, self.backup, None, frozenset(), "/missing")
            disabled = Quart("disabled")
            disabled.register_blueprint(create_remediation_blueprint(disabled_settings, RemediationService(disabled_settings)))
            response = await disabled.test_client().post("/api_v1/remediation/preview", json={})
            self.assertEqual(response.status_code, 503)

        import asyncio
        asyncio.run(checks())


if __name__ == "__main__":
    unittest.main()
