from __future__ import annotations

import asyncio
import fcntl
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import stat
import subprocess
import tempfile
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

import requests
from beets.dbcore.query import MatchQuery
from beets.ui import _open_library
from beets.util import bytestring_path
from mediafile import Image as MediaImage
from mediafile import ImageType, MediaFile
from PIL import Image as PillowImage
from PIL import UnidentifiedImageError
from quart import Blueprint, Response, jsonify, request

from beets_flask.config import get_config

logger = logging.getLogger(__name__)

MAX_REQUEST_BYTES = 1024 * 1024
MAX_ALBUMS = 10
MAX_TRACKS = 250
MAX_TRACKS_PER_ALBUM = 50
MAX_IMAGES_PER_TRACK = 8
MAX_ART_BYTES = 15 * 1024 * 1024
MAX_ART_PIXELS = 40_000_000
SUPPORTED_AUDIO_EXTENSIONS = {".flac", ".mp3", ".m4a"}
KNOWN_AUDIO_EXTENSIONS = SUPPORTED_AUDIO_EXTENSIONS | {".aac", ".aif", ".aiff", ".ape", ".m4b", ".mp4", ".ogg", ".opus", ".wav", ".wma"}
KNOWN_IMAGE_EXTENSIONS = {".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"}
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
ALBUM_ID_RE = re.compile(r"^alb_[a-f0-9]{24}$")
UUID_RE = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", re.I)
TX_RE = re.compile(r"^[a-f0-9]{32}$")
MANIFEST_ID_RE = re.compile(r"^mrm_[a-f0-9]{24}$")
CAA_RE = re.compile(
    r"^https://coverartarchive\.org/release/([a-f0-9-]{36})/([0-9]+)\.(jpg|png)$",
    re.I,
)
CAA_ARCHIVE_HOST_RE = re.compile(r"^dn[0-9]+\.ca\.archive\.org$", re.I)


class RemediationError(ValueError):
    pass


class RequestTooLargeError(RemediationError):
    pass


@dataclass(frozen=True)
class Settings:
    enabled: bool
    writes_enabled: bool
    maintenance: bool
    token: str | None
    manifest_hmac_key: str | None
    library_root: Path
    backup_root: Path
    approved_scan_id: str | None
    genres: frozenset[str]
    ffmpeg: str

    @classmethod
    def from_env(cls) -> "Settings":
        enabled = os.getenv("BEETS_REMEDIATION_ENABLED", "false").lower() == "true"
        writes_enabled = os.getenv("BEETS_REMEDIATION_WRITES_ENABLED", "false").lower() == "true"
        maintenance = os.getenv("BEETS_REMEDIATION_MAINTENANCE", "false").lower() == "true"
        token = os.getenv("BEETS_REMEDIATION_TOKEN") or None
        manifest_hmac_key = os.getenv("BEETS_REMEDIATION_MANIFEST_HMAC_KEY") or None
        scan_id = os.getenv("BEETS_REMEDIATION_APPROVED_SCAN_ID") or None
        raw_genres = os.getenv("BEETS_REMEDIATION_GENRES_JSON", "")
        try:
            genre_values = json.loads(raw_genres) if raw_genres else []
        except json.JSONDecodeError as error:
            raise RuntimeError("BEETS_REMEDIATION_GENRES_JSON must be a JSON string array") from error
        if not isinstance(genre_values, list) or any(not isinstance(value, str) or not value.strip() for value in genre_values):
            raise RuntimeError("BEETS_REMEDIATION_GENRES_JSON must be a JSON string array")
        settings = cls(
            enabled=enabled,
            writes_enabled=writes_enabled,
            maintenance=maintenance,
            token=token,
            manifest_hmac_key=manifest_hmac_key,
            library_root=Path(os.getenv("BEETS_REMEDIATION_LIBRARY_ROOT", "/music/imported")).absolute(),
            backup_root=Path(os.getenv("BEETS_REMEDIATION_BACKUP_ROOT", "/remediation-backup")).absolute(),
            approved_scan_id=scan_id,
            genres=frozenset(genre_values),
            ffmpeg=os.getenv("BEETS_REMEDIATION_FFMPEG", "/usr/bin/ffmpeg"),
        )
        if enabled:
            if not token or len(token) < 32:
                raise RuntimeError("BEETS_REMEDIATION_TOKEN must contain at least 32 characters when remediation is enabled")
            if not manifest_hmac_key or len(manifest_hmac_key) < 32:
                raise RuntimeError("BEETS_REMEDIATION_MANIFEST_HMAC_KEY must contain at least 32 characters when remediation is enabled")
            if not scan_id or not UUID_RE.fullmatch(scan_id):
                raise RuntimeError("BEETS_REMEDIATION_APPROVED_SCAN_ID must be a UUID when remediation is enabled")
            if not settings.genres:
                raise RuntimeError("BEETS_REMEDIATION_GENRES_JSON must contain the approved genre allowlist")
        return settings

    def _validate_roots(self) -> None:
        for label, root in (("library", self.library_root), ("backup", self.backup_root)):
            current = Path(root.anchor)
            has_symlink = False
            for component in root.parts[1:]:
                current /= component
                has_symlink = has_symlink or current.is_symlink()
            if not root.is_dir() or has_symlink:
                raise RuntimeError(f"Configured {label} root must be an existing path without symlink components")
        if self.library_root == self.backup_root or self.library_root in self.backup_root.parents or self.backup_root in self.library_root.parents:
            raise RuntimeError("Library and backup roots must not contain each other")
        if self.library_root.stat().st_dev != self.backup_root.stat().st_dev:
            raise RuntimeError("Library and backup roots must be on the same filesystem for atomic replacement")
        if not Path(self.ffmpeg).is_file() or not os.access(self.ffmpeg, os.X_OK):
            raise RuntimeError("BEETS_REMEDIATION_FFMPEG must be an existing executable")


class RemediationService:
    def __init__(
        self,
        settings: Settings,
        library_factory: Callable[[], Any] | None = None,
        maintenance_checker: Callable[[], bool] | None = None,
    ):
        self.settings = settings
        self.library_factory = library_factory or (lambda: _open_library(get_config()))
        self.maintenance_checker = maintenance_checker or self._default_maintenance_idle
        if settings.enabled:
            settings._validate_roots()
        self.transactions = settings.backup_root / "transactions"
        self.journals = settings.backup_root / "journals"
        self.lock_path = settings.backup_root / ".writer.lock"
        if settings.enabled:
            self._ensure_directory(self.transactions)
            self._ensure_directory(self.journals)
            self._reject_symlink_path(self.transactions, settings.backup_root)
            self._reject_symlink_path(self.journals, settings.backup_root)
            if settings.writes_enabled and settings.maintenance:
                with self._writer_lock(blocking=True):
                    self._reconcile_finalizing()

    def authorize(self, header: str | None) -> None:
        if not self.settings.enabled or not self.settings.token:
            raise RemediationError("Remediation is disabled")
        prefix = "Bearer "
        supplied = header[len(prefix) :] if header and header.startswith(prefix) else ""
        if not hmac.compare_digest(supplied.encode(), self.settings.token.encode()):
            raise PermissionError("Unauthorized")

    def _require_mutations_enabled(self) -> None:
        if not self.settings.writes_enabled:
            raise RemediationError("Remediation writes are disabled by BEETS_REMEDIATION_WRITES_ENABLED")
        if not self.settings.maintenance:
            raise RemediationError("Remediation mutations require BEETS_REMEDIATION_MAINTENANCE=true")
        self._assert_maintenance_idle()

    @staticmethod
    def _default_maintenance_idle() -> bool:
        try:
            from beets_flask.redis import queues

            return all(
                queue.count == 0
                and queue.started_job_registry.count == 0
                and queue.scheduled_job_registry.count == 0
                for queue in queues
            )
        except Exception as error:
            raise RemediationError("Could not verify beets queue maintenance state") from error

    def _assert_maintenance_idle(self) -> None:
        if not self.maintenance_checker():
            raise RemediationError("Beets queues or jobs are active; maintenance lock is not idle")

    def art_digest(self, musicbrainz_release_id: Any, url: Any) -> dict[str, Any]:
        release_id = self._uuid(musicbrainz_release_id, "musicbrainz_release_id")
        if not isinstance(url, str):
            raise RemediationError("CAA URL is required")
        match = CAA_RE.fullmatch(url)
        if not match or match.group(1).lower() != release_id:
            raise RemediationError("CAA URL must match the exact MusicBrainz release")
        data = self._download_caa(url)
        extension = ".png" if url.lower().endswith(".png") else ".jpg"
        width, height, image_format = self._validate_image(data, extension)
        return {
            "schema": "beets-flask-remediation.art-digest.v1",
            "musicbrainz_release_id": release_id,
            "url": url,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "width": width,
            "height": height,
            "format": image_format.lower(),
        }

    def preview(self, envelope: Any) -> dict[str, Any]:
        parsed, manifest_digest = self._verify_manifest_envelope(envelope)
        library = self.library_factory()
        albums = []
        for album in parsed["albums"]:
            current = self._validate_album(album, library)
            art, art_sha = self._canonical_art(album)
            albums.append(self._diff_summary(album, current, art, art_sha))
        return {
            "schema": "beets-flask-remediation.preview.v1",
            "manifest_digest": manifest_digest,
            "snapshot_id": parsed["snapshot_id"],
            "album_count": len(albums),
            "track_count": sum(len(album["tracks"]) for album in parsed["albums"]),
            "albums": albums,
            "checks": {
                "approved_scan": True,
                "canonical_containment": True,
                "symlink_components": False,
                "track_sets_and_hashes": "exact",
                "sidecar_hashes": "exact",
                "musicbrainz_release_ids": "exact",
                "artwork_decoded": True,
                "writes_performed": False,
            },
        }

    def apply(self, envelope: Any, operation_id: Any) -> dict[str, Any]:
        self._require_mutations_enabled()
        parsed, manifest_digest = self._verify_manifest_envelope(envelope)
        tx_id = self._validate_transaction_id(operation_id)
        with self._writer_lock():
            existing_path = self.journals / f"{tx_id}.json"
            if existing_path.exists():
                existing = self._read_journal(tx_id)
                if existing.get("manifest_digest") != manifest_digest:
                    raise RemediationError("Operation ID is already bound to a different manifest")
                if existing.get("status") in {"applied", "rolling_back", "rolled_back", "failed_restored"} and not (self.transactions / tx_id).is_dir():
                    existing["status"] = "corrupt_missing_backup"
                    self._write_journal(existing)
                if existing.get("status") in {"applying", "applied", "rolling_back", "failed_restored", "failed_conflict", "rolled_back", "finalizing", "finalized", "corrupt_missing_backup"}:
                    return self._apply_result(existing)
                raise RemediationError(f"Operation already exists in {existing.get('status')!r} state; inspect transaction status")
            self._require_no_active_transaction()
            library = self.library_factory()
            prepared = []
            for album in parsed["albums"]:
                current = self._validate_album(album, library)
                art, art_sha = self._canonical_art(album)
                prepared.append((album, art, art_sha, current))

            tx_dir = self.transactions / tx_id
            self._ensure_directory(tx_dir)
            journal = {
                "schema": "beets-flask-remediation.journal.v1",
                "transaction_id": tx_id,
                "manifest_digest": manifest_digest,
                "status": "applying",
                "manifest": parsed,
                "completed_albums": [],
                "install_files": [],
                "original_state": [self._original_state(album, current) for album, _, _, current in prepared],
                "post_state": [],
            }
            self._write_journal(journal)
            try:
                for album, art, art_sha, current in prepared:
                    post_state = self._apply_album(tx_dir, album, art, art_sha, current, library, journal)
                    journal["completed_albums"].append(album["album_id"])
                    journal["post_state"].append(post_state)
                    journal.pop("inflight_post_state", None)
                    self._write_journal(journal)
                journal["status"] = "applied"
                self._write_journal(journal)
            except Exception:
                try:
                    self._restore_manifest(tx_dir, journal, internal=True)
                    self._restore_db_manifest(library, journal)
                    journal["status"] = "failed_restored"
                    self._write_journal(journal)
                except Exception:
                    journal["status"] = "failed_conflict"
                    self._write_journal(journal)
                raise
            return self._apply_result(journal)

    @staticmethod
    def _apply_result(journal: dict[str, Any]) -> dict[str, Any]:
        return {
            "schema": "beets-flask-remediation.apply.v1",
            "transaction_id": journal["transaction_id"],
            "manifest_digest": journal["manifest_digest"],
            "snapshot_id": journal["manifest"]["snapshot_id"],
            "status": journal["status"],
            "post_state": journal["post_state"],
        }

    def rollback(self, transaction_id: Any) -> dict[str, Any]:
        self._require_mutations_enabled()
        tx_id = self._validate_transaction_id(transaction_id)
        with self._writer_lock():
            journal = self._read_journal(tx_id)
            if journal["status"] != "applied":
                raise RemediationError("Rollback is allowed only for an applied transaction")
            self._verify_audit_state(journal["post_state"])
            self._verify_db_manifest(self.library_factory(), journal["manifest"], journal["post_state"])
            self._transaction_dir(tx_id)
            journal["status"] = "rolling_back"
            self._write_journal(journal)
            self._resume_rollback(journal)
            return {
                "schema": "beets-flask-remediation.rollback.v1",
                "transaction_id": tx_id,
                "status": "rolled_back",
            }

    def _resume_rollback(self, journal: dict[str, Any]) -> None:
        if journal.get("status") != "rolling_back":
            raise RemediationError("Transaction is not in a recoverable rollback state")
        tx_dir = self._transaction_dir(journal["transaction_id"])
        self._restore_manifest(tx_dir, journal, internal=False)
        self._restore_db_manifest(self.library_factory(), journal)
        journal["status"] = "rolled_back"
        self._write_journal(journal)

    def finalize_state(self, transaction_id: Any) -> dict[str, Any]:
        tx_id = self._validate_transaction_id(transaction_id)
        with self._writer_lock():
            journal = self._read_journal(tx_id)
            status = journal["status"]
            if status == "applied":
                expected_state = journal["post_state"]
            elif status in {"rolled_back", "failed_restored"}:
                expected_state = journal["original_state"]
            elif status == "finalizing":
                expected_state = journal.get("finalize_state")
            elif status == "finalized":
                expected_state = journal["post_state"] or journal["original_state"]
            else:
                raise RemediationError(f"Transaction in {status!r} state is not ready to finalize")
            if not isinstance(expected_state, list):
                raise RemediationError("Transaction finalize state is invalid")
            return {
                "schema": "beets-flask-remediation.finalize-state.v1",
                "transaction_id": tx_id,
                "status": status,
                "manifest_snapshot_id": journal["manifest"]["snapshot_id"],
                "expected_state": self._proof_albums(expected_state),
            }

    def finalize(self, transaction_id: Any, attestation: Any = None, signature: Any = None) -> dict[str, Any]:
        self._require_mutations_enabled()
        tx_id = self._validate_transaction_id(transaction_id)
        with self._writer_lock():
            journal = self._read_journal(tx_id)
            status = journal["status"]
            if status == "finalizing":
                return self._finish_finalize(journal)
            if status == "finalized":
                return self._finalize_result(journal)
            if status == "applied":
                expected_state = journal["post_state"]
            elif status in {"rolled_back", "failed_restored"}:
                expected_state = journal["original_state"]
            else:
                raise RemediationError(f"Transaction in {status!r} state must be rolled back before finalize")
            proof = self._validate_finalize_attestation(attestation, signature, journal, expected_state)
            self._verify_audit_state(expected_state)
            self._verify_db_manifest(self.library_factory(), journal["manifest"], expected_state)
            self._transaction_dir(tx_id)
            journal["status"] = "finalizing"
            journal["finalize_state"] = expected_state
            journal["post_audit_scan_id"] = proof["post_audit_scan_id"]
            self._write_journal(journal)
            self._before_backup_delete(tx_id)
            return self._finish_finalize(journal)

    def _finish_finalize(self, journal: dict[str, Any]) -> dict[str, Any]:
        expected_state = journal.get("finalize_state")
        if journal.get("status") != "finalizing" or not isinstance(expected_state, list):
            raise RemediationError("Transaction is not in a recoverable finalizing state")
        self._verify_audit_state(expected_state)
        self._verify_db_manifest(self.library_factory(), journal["manifest"], expected_state)
        tx_dir = self.transactions / journal["transaction_id"]
        self._reject_symlink_path(tx_dir, self.settings.backup_root)
        if tx_dir.exists():
            shutil.rmtree(tx_dir)
            self._fsync_directory(self.transactions)
        self._after_backup_delete(journal["transaction_id"])
        journal["status"] = "finalized"
        journal["post_state"] = journal["post_state"] if expected_state == journal["post_state"] else []
        journal.pop("finalize_state", None)
        self._write_journal(journal)
        return self._finalize_result(journal)

    def _reconcile_finalizing(self) -> None:
        for path in sorted(self.journals.glob("*.json")):
            journal = self._read_journal(path.stem)
            if journal.get("status") == "finalizing":
                self._finish_finalize(journal)
            elif journal.get("status") in {"applied", "rolling_back", "rolled_back", "failed_restored"} and not (self.transactions / journal["transaction_id"]).is_dir():
                journal["status"] = "corrupt_missing_backup"
                self._write_journal(journal)

    @staticmethod
    def _finalize_result(journal: dict[str, Any]) -> dict[str, Any]:
        return {
            "schema": "beets-flask-remediation.finalize.v1",
            "transaction_id": journal["transaction_id"],
            "status": "finalized",
            "post_audit_scan_id": journal["post_audit_scan_id"],
        }

    def _before_backup_delete(self, transaction_id: str) -> None:
        del transaction_id

    def _after_backup_delete(self, transaction_id: str) -> None:
        del transaction_id

    def transaction(self, transaction_id: Any = None, recover: bool = False) -> dict[str, Any]:
        with self._writer_lock():
            if transaction_id is not None:
                journal = self._read_journal(self._validate_transaction_id(transaction_id))
            else:
                journals = [self._read_journal(path.stem) for path in self.journals.glob("*.json")]
                journals = [item for item in journals if item.get("status") != "finalized"]
                if len(journals) > 1:
                    raise RemediationError("Multiple non-finalized transactions require operator inspection")
                if not journals:
                    return {"schema": "beets-flask-remediation.transaction.v1", "active": None}
                journal = journals[0]
            tx_dir = self.transactions / journal["transaction_id"]
            if journal["status"] in {"applied", "rolling_back", "rolled_back", "failed_restored"} and not tx_dir.is_dir():
                journal["status"] = "corrupt_missing_backup"
                self._write_journal(journal)
            if recover:
                self._require_mutations_enabled()
                if journal["status"] in {"applying", "failed_conflict"}:
                    tx_dir = self._transaction_dir(journal["transaction_id"])
                    self._restore_manifest(tx_dir, journal, internal=True)
                    self._restore_db_manifest(self.library_factory(), journal)
                    journal["status"] = "failed_restored"
                    self._write_journal(journal)
                elif journal["status"] == "rolling_back":
                    self._resume_rollback(journal)
                else:
                    raise RemediationError("Recovery is allowed only for an interrupted apply or rollback")
            counts: dict[str, int] = {}
            for item in journal.get("install_files", []):
                counts[item["state"]] = counts.get(item["state"], 0) + 1
            summary = {
                "transaction_id": journal["transaction_id"],
                "status": journal["status"],
                "manifest_digest": journal.get("manifest_digest"),
                "snapshot_id": journal["manifest"]["snapshot_id"],
                "album_count": len(journal["manifest"]["albums"]),
                "install_counts": counts,
            }
            return {
                "schema": "beets-flask-remediation.transaction.v1",
                "transaction": summary,
                "active": summary if journal["status"] != "finalized" else None,
            }

    def _validate_manifest(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or set(raw) != {"schema", "snapshot_id", "albums"}:
            raise RemediationError("Manifest must contain only schema, snapshot_id, and albums")
        if raw["schema"] != "music-remediation-manifest.v1":
            raise RemediationError("Unsupported manifest schema")
        scan_id = self._uuid(raw["snapshot_id"], "snapshot_id")
        if scan_id != self.settings.approved_scan_id:
            raise RemediationError("Manifest snapshot is not the configured approved scan")
        albums = raw["albums"]
        if not isinstance(albums, list) or not 1 <= len(albums) <= MAX_ALBUMS:
            raise RemediationError(f"Manifest must contain 1-{MAX_ALBUMS} albums")
        parsed_albums = [self._validate_album_schema(album) for album in albums]
        album_ids = [album["album_id"] for album in parsed_albums]
        if len(album_ids) != len(set(album_ids)):
            raise RemediationError("Album IDs must be unique")
        paths = [track["path"] for album in parsed_albums for track in album["tracks"]]
        if len(paths) > MAX_TRACKS or len(paths) != len(set(paths)):
            raise RemediationError(f"Manifest track paths must be unique and total at most {MAX_TRACKS}")
        return {"schema": raw["schema"], "snapshot_id": scan_id, "albums": parsed_albums}

    def _verify_manifest_envelope(self, raw: Any) -> tuple[dict[str, Any], str]:
        required = {"schema", "manifest_id", "digest", "signature", "manifest"}
        if not isinstance(raw, dict) or set(raw) != required:
            raise RemediationError("Signed manifest envelope is required")
        if raw["schema"] != "music-remediation-stored-manifest.v1":
            raise RemediationError("Unsupported signed manifest envelope")
        manifest_id = raw["manifest_id"]
        digest = raw["digest"]
        signature = raw["signature"]
        if not isinstance(manifest_id, str) or not MANIFEST_ID_RE.fullmatch(manifest_id):
            raise RemediationError("Invalid manifest ID")
        digest = self._hash(digest, "manifest digest")
        signature = self._hash(signature, "manifest signature")
        canonical = self._canonical_json(raw["manifest"])
        actual_digest = hashlib.sha256(canonical).hexdigest()
        if not hmac.compare_digest(digest, actual_digest) or manifest_id != f"mrm_{actual_digest[:24]}":
            raise RemediationError("Manifest digest or ID is invalid")
        if not self.settings.manifest_hmac_key:
            raise RemediationError("Manifest signing key is unavailable")
        actual_signature = hmac.new(self.settings.manifest_hmac_key.encode(), canonical, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, actual_signature):
            raise RemediationError("Manifest signature is invalid")
        return self._validate_manifest(raw["manifest"]), actual_digest

    @staticmethod
    def _canonical_json(value: Any) -> bytes:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()

    def _validate_album_schema(self, raw: Any) -> dict[str, Any]:
        required = {"album_id", "album_path", "musicbrainz_release_id", "tracks", "sidecar", "genres", "art"}
        if not isinstance(raw, dict) or set(raw) != required:
            raise RemediationError(f"Album must contain only {', '.join(sorted(required))}")
        album_id = raw["album_id"]
        if not isinstance(album_id, str) or not ALBUM_ID_RE.fullmatch(album_id):
            raise RemediationError("Invalid opaque album ID")
        album_path = self._relative(raw["album_path"], "album_path")
        release_id = self._uuid(raw["musicbrainz_release_id"], "musicbrainz_release_id")
        expected_album_id = f"alb_{hashlib.sha256(f'mb:{release_id}'.encode()).hexdigest()[:24]}"
        if album_id != expected_album_id:
            raise RemediationError("Opaque album ID does not match the MusicBrainz release")
        genres = raw["genres"]
        if not isinstance(genres, list) or not 1 <= len(genres) <= 2 or len(genres) != len(set(genres)):
            raise RemediationError("genres must contain one or two unique ordered values")
        if any(not isinstance(value, str) or value not in self.settings.genres for value in genres):
            raise RemediationError("Genre is not in the configured canonical allowlist")
        tracks = raw["tracks"]
        if not isinstance(tracks, list) or not 1 <= len(tracks) <= MAX_TRACKS_PER_ALBUM:
            raise RemediationError(f"Album must contain 1-{MAX_TRACKS_PER_ALBUM} tracks")
        parsed_tracks = [self._validate_track(track, album_path) for track in tracks]
        track_paths = [track["path"] for track in parsed_tracks]
        if len(track_paths) != len(set(track_paths)):
            raise RemediationError("Album track paths must be unique")
        sidecar = self._validate_sidecar(raw["sidecar"], album_path)
        art = self._validate_art(raw["art"], album_path, release_id, sidecar)
        return {
            "album_id": album_id,
            "album_path": album_path,
            "musicbrainz_release_id": release_id,
            "tracks": parsed_tracks,
            "sidecar": sidecar,
            "genres": list(genres),
            "art": art,
        }

    def _validate_track(self, raw: Any, album_path: str) -> dict[str, Any]:
        required = {"path", "expected_file_sha256", "expected_embedded_sha256"}
        if not isinstance(raw, dict) or set(raw) != required:
            raise RemediationError("Track must contain only path, expected_file_sha256, and expected_embedded_sha256")
        track_path = self._relative(raw["path"], "track path")
        self._require_under_album(track_path, album_path)
        if PurePosixPath(track_path).suffix.lower() not in SUPPORTED_AUDIO_EXTENSIONS:
            raise RemediationError("Only FLAC, MP3, and M4A tracks are supported")
        embedded = raw["expected_embedded_sha256"]
        if not isinstance(embedded, list) or len(embedded) > MAX_IMAGES_PER_TRACK:
            raise RemediationError(f"expected_embedded_sha256 must contain at most {MAX_IMAGES_PER_TRACK} hashes")
        return {
            "path": track_path,
            "expected_file_sha256": self._hash(raw["expected_file_sha256"], "track file hash"),
            "expected_embedded_sha256": [self._hash(value, "embedded artwork hash") for value in embedded],
        }

    def _validate_sidecar(self, raw: Any, album_path: str) -> dict[str, str]:
        if not isinstance(raw, dict) or set(raw) != {"path", "expected_sha256"}:
            raise RemediationError("sidecar must contain only path and expected_sha256")
        sidecar_path = self._relative(raw["path"], "sidecar path")
        self._require_under_album(sidecar_path, album_path)
        if PurePosixPath(sidecar_path).suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            raise RemediationError("Sidecar must be JPEG or PNG")
        return {"path": sidecar_path, "expected_sha256": self._hash(raw["expected_sha256"], "sidecar hash")}

    def _validate_art(self, raw: Any, album_path: str, release_id: str, sidecar: dict[str, str]) -> dict[str, str]:
        if not isinstance(raw, dict) or raw.get("source") not in {"caa", "sidecar"}:
            raise RemediationError("art.source must be caa or sidecar")
        if raw["source"] == "caa":
            if set(raw) != {"source", "url", "expected_sha256"} or not isinstance(raw.get("url"), str):
                raise RemediationError("CAA art must contain only source, url, and expected_sha256")
            match = CAA_RE.fullmatch(raw["url"])
            if not match or match.group(1).lower() != release_id:
                raise RemediationError("CAA URL must be the exact HTTPS release URL for the same MusicBrainz release")
            return {
                "source": "caa",
                "url": raw["url"],
                "expected_sha256": self._hash(raw["expected_sha256"], "CAA artwork hash"),
            }
        if set(raw) != {"source", "path", "expected_sha256"}:
            raise RemediationError("Local art must contain only source, path, and expected_sha256")
        art_path = self._relative(raw["path"], "local art path")
        self._require_under_album(art_path, album_path)
        expected = self._hash(raw["expected_sha256"], "local art hash")
        if art_path != sidecar["path"] or expected != sidecar["expected_sha256"]:
            raise RemediationError("Local art must be the exact reviewed sidecar")
        return {"source": "sidecar", "path": art_path, "expected_sha256": expected}

    def _validate_album(self, album: dict[str, Any], library: Any) -> dict[str, Any]:
        album_dir = self._library_path(album["album_path"])
        if not album_dir.is_dir():
            raise RemediationError("Album directory does not exist")
        actual_tracks = {
            child.relative_to(self.settings.library_root).as_posix()
            for child in album_dir.rglob("*")
            if child.is_file() and child.suffix.lower() in KNOWN_AUDIO_EXTENSIONS
        }
        expected_tracks = {track["path"] for track in album["tracks"]}
        if actual_tracks != expected_tracks:
            raise RemediationError("Current album track set does not exactly match the manifest")
        actual_sidecars = {
            child.relative_to(self.settings.library_root).as_posix()
            for child in album_dir.rglob("*")
            if child.is_file() and child.suffix.lower() in KNOWN_IMAGE_EXTENSIONS
        }
        if actual_sidecars != {album["sidecar"]["path"]}:
            raise RemediationError("Current album sidecar set does not exactly match the manifest")

        db_items, db_album = self._db_album(library, album)
        current_tracks = []
        for track in album["tracks"]:
            path = self._library_path(track["path"])
            identity = self._file_identity(path, track["expected_file_sha256"])
            media = MediaFile(str(path))
            if media.type not in {"flac", "mp3", "aac", "alac"}:
                raise RemediationError("Track media format is unsupported")
            embedded = [hashlib.sha256(image.data).hexdigest() for image in (media.images or [])]
            if embedded != track["expected_embedded_sha256"]:
                raise RemediationError("Current embedded artwork hashes do not match the manifest")
            if (media.mb_albumid or "").lower() != album["musicbrainz_release_id"]:
                raise RemediationError("Track MusicBrainz release ID does not match the manifest")
            current_tracks.append({
                "path": track["path"],
                "file_sha256": track["expected_file_sha256"],
                "genres": list(media.genres or []),
                "embedded_sha256": embedded,
                "identity": identity,
                "parent_identity": self._parent_identity(path),
            })

        sidecar_path = self._library_path(album["sidecar"]["path"])
        sidecar_identity = self._file_identity(sidecar_path, album["sidecar"]["expected_sha256"])
        return {
            "tracks": current_tracks,
            "sidecar": {
                "path": album["sidecar"]["path"],
                "sha256": album["sidecar"]["expected_sha256"],
                "identity": sidecar_identity,
                "parent_identity": self._parent_identity(sidecar_path),
            },
            "db_items": db_items,
            "db_album": db_album,
        }

    def _db_album(self, library: Any, album: dict[str, Any]) -> tuple[dict[str, Any], Any]:
        items = list(library.items(MatchQuery("mb_albumid", album["musicbrainz_release_id"])))
        expected = {str(self._library_path(track["path"])) for track in album["tracks"]}
        by_path = {str(Path(os.fsdecode(item.path)).absolute()): item for item in items}
        if set(by_path) != expected or len(items) != len(by_path):
            raise RemediationError("beets database track set does not exactly match the manifest")
        album_ids = {item.album_id for item in items}
        if len(album_ids) != 1 or None in album_ids:
            raise RemediationError("beets database album identity is ambiguous")
        db_album = library.get_album(album_ids.pop())
        if db_album is None:
            raise RemediationError("beets database album is missing")
        relative_items = {
            Path(path).relative_to(self.settings.library_root).as_posix(): item
            for path, item in by_path.items()
        }
        return relative_items, db_album

    def _canonical_art(self, album: dict[str, Any]) -> tuple[bytes, str]:
        art = album["art"]
        if art["source"] == "sidecar":
            path = self._library_path(art["path"])
            data = self._read_bounded(path, MAX_ART_BYTES)
            if hashlib.sha256(data).hexdigest() != art["expected_sha256"]:
                raise RemediationError("Reviewed local artwork hash is stale")
        else:
            data = self._download_caa(art["url"])
        self._validate_image(data, PurePosixPath(album["sidecar"]["path"]).suffix.lower())
        digest = hashlib.sha256(data).hexdigest()
        if digest != art["expected_sha256"]:
            raise RemediationError("Canonical artwork bytes do not match the reviewed SHA-256")
        return data, digest

    def _download_caa(self, url: str) -> bytes:
        match = CAA_RE.fullmatch(url)
        if not match:
            raise RemediationError("Invalid Cover Art Archive URL")
        release_id, art_id, extension = match.groups()
        self._validate_public_host("coverartarchive.org")
        session = requests.Session()
        session.trust_env = False
        try:
            requested_url = url
            response = self._http_get(session, requested_url)
            if response.status_code in {301, 302, 307, 308}:
                location = response.headers.get("Location", "")
                response.close()
                target, target_kind = self._validate_caa_redirect(location, release_id.lower(), art_id, extension.lower())
                self._validate_public_host(urlsplit(target).hostname or "")
                requested_url = target
                response = self._http_get(session, requested_url)
                if target_kind == "download" and response.status_code in {301, 302, 307, 308}:
                    location = response.headers.get("Location", "")
                    response.close()
                    target, target_kind = self._validate_caa_redirect(
                        location,
                        release_id.lower(),
                        art_id,
                        extension.lower(),
                        archive_download_allowed=False,
                    )
                    if target_kind != "object":
                        raise RemediationError("Internet Archive handoff did not resolve to the bound object host")
                    self._validate_public_host(urlsplit(target).hostname or "")
                    requested_url = target
                    response = self._http_get(session, requested_url)
            try:
                if response.status_code != 200 or response.is_redirect or response.url != requested_url:
                    raise RemediationError("Cover Art Archive returned a non-200 or multi-hop redirect response")
                return self._read_response(response)
            finally:
                response.close()
        finally:
            session.close()

    @staticmethod
    def _http_get(session: requests.Session, url: str) -> requests.Response:
        return session.get(
            url,
            allow_redirects=False,
            stream=True,
            timeout=(5, 30),
            headers={"Accept": "image/jpeg,image/png"},
        )

    @staticmethod
    def _validate_caa_redirect(
        location: str,
        release_id: str,
        art_id: str,
        extension: str,
        archive_download_allowed: bool = True,
    ) -> tuple[str, str]:
        try:
            parsed = urlsplit(location)
            port = parsed.port
        except ValueError as error:
            raise RemediationError("Invalid Cover Art Archive redirect") from error
        object_path = f"/0/items/mbid-{release_id}/mbid-{release_id}-{art_id}.{extension}"
        download_path = f"/download/mbid-{release_id}/mbid-{release_id}-{art_id}.{extension}"
        is_object = bool(parsed.hostname and CAA_ARCHIVE_HOST_RE.fullmatch(parsed.hostname) and parsed.path == object_path)
        is_download = parsed.hostname == "archive.org" and parsed.path == download_path and archive_download_allowed
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or port is not None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or not (is_object or is_download)
        ):
            raise RemediationError("Cover Art Archive redirect target is not the bound archive object")
        return location, "object" if is_object else "download"

    @staticmethod
    def _validate_public_host(host: str) -> None:
        try:
            addresses = {entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        except socket.gaierror as error:
            raise RemediationError("Artwork host DNS resolution failed") from error
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise RemediationError("Artwork host resolved to a non-public address")

    @staticmethod
    def _read_response(response: requests.Response) -> bytes:
        length = response.headers.get("Content-Length")
        if length and (not length.isdigit() or int(length) > MAX_ART_BYTES):
            raise RemediationError("Artwork exceeds the byte limit")
        data = bytearray()
        for chunk in response.iter_content(64 * 1024):
            data.extend(chunk)
            if len(data) > MAX_ART_BYTES:
                raise RemediationError("Artwork exceeds the byte limit")
        return bytes(data)

    @staticmethod
    def _validate_image(data: bytes, sidecar_extension: str) -> tuple[int, int, str]:
        if not data or len(data) > MAX_ART_BYTES:
            raise RemediationError("Artwork is empty or exceeds the byte limit")
        try:
            with PillowImage.open(BytesIO(data)) as image:
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > MAX_ART_PIXELS:
                    raise RemediationError("Artwork exceeds the pixel limit")
                image_format = image.format
                image.verify()
            with PillowImage.open(BytesIO(data)) as image:
                image.load()
            expected = "PNG" if sidecar_extension == ".png" else "JPEG"
            if image_format != expected:
                raise RemediationError("Artwork format does not match the reviewed sidecar extension")
            return width, height, image_format
        except (UnidentifiedImageError, OSError, PillowImage.DecompressionBombError) as error:
            raise RemediationError("Artwork could not be safely decoded") from error

    def _diff_summary(self, album: dict[str, Any], current: dict[str, Any], art: bytes, art_sha: str) -> dict[str, Any]:
        return {
            "album_id": album["album_id"],
            "album_path": album["album_path"],
            "musicbrainz_release_id": album["musicbrainz_release_id"],
            "canonical_art_sha256": art_sha,
            "canonical_art_bytes": len(art),
            "genres": album["genres"],
            "sidecar": {"path": album["sidecar"]["path"], "from_sha256": album["sidecar"]["expected_sha256"], "to_sha256": art_sha},
            "tracks": [
                {
                    "path": item["path"],
                    "genres": {"from": item["genres"], "to": album["genres"]},
                    "embedded_sha256": {"from": item["embedded_sha256"], "to": [art_sha]},
                }
                for item in current["tracks"]
            ],
            "beets_database": {
                "album_id": current["db_album"].id,
                "genre_to": album["genres"][0],
                "artpath_to": str(self._library_path(album["sidecar"]["path"])),
            },
        }

    @staticmethod
    def _original_state(album: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
        return {
            "album_id": album["album_id"],
            "tracks": [
                {
                    "path": track["path"],
                    "file_sha256": track["file_sha256"],
                    "embedded_sha256": track["embedded_sha256"],
                    "genres": track["genres"],
                }
                for track in current["tracks"]
            ],
            "sidecar": {"path": current["sidecar"]["path"], "sha256": current["sidecar"]["sha256"]},
            "db": RemediationService._capture_db_state(current["db_items"], current["db_album"]),
        }

    @staticmethod
    def _capture_db_state(items: dict[str, Any], db_album: Any) -> dict[str, Any]:
        if db_album is None:
            raise RemediationError("beets database album disappeared")
        return {
            "items": {
                relative: {"genre": item.genre or "", "mtime": item.mtime, "size": item.try_filesize()}
                for relative, item in items.items()
            },
            "album": {
                "genre": db_album.genre or "",
                "artpath": os.fsdecode(db_album.artpath) if db_album.artpath else "",
            },
        }

    def _apply_album(
        self,
        tx_dir: Path,
        album: dict[str, Any],
        art: bytes,
        art_sha: str,
        current: dict[str, Any],
        library: Any,
        journal: dict[str, Any],
    ) -> dict[str, Any]:
        backup_dir = tx_dir / "original"
        stage_dir = tx_dir / "stage"
        post_tracks = []
        install_pairs: list[tuple[Path, Path, str, dict[str, Any], dict[str, int], str, str]] = []
        current_tracks = {track["path"]: track for track in current["tracks"]}
        for track in album["tracks"]:
            live = self._library_path(track["path"])
            backup = backup_dir / track["path"]
            stage = stage_dir / track["path"]
            identity = current_tracks[track["path"]]["identity"]
            self._register_and_backup(journal, album["album_id"], track["path"], live, backup, identity)
            self._copy_with_parents(backup, stage)
            essence_before = self._audio_essence(stage)
            media = MediaFile(str(stage))
            media.genres = album["genres"]
            media.images = [MediaImage(data=art, type=ImageType.front)]
            media.save()
            self._fsync_file(stage)
            if self._audio_essence(stage) != essence_before:
                raise RemediationError("Audio essence changed while updating metadata")
            verified = MediaFile(str(stage))
            if list(verified.genres or []) != album["genres"]:
                raise RemediationError("Staged genre verification failed")
            verified_art = [hashlib.sha256(image.data).hexdigest() for image in (verified.images or [])]
            if verified_art != [art_sha]:
                raise RemediationError("Staged embedded artwork verification failed")
            post_tracks.append({
                "path": track["path"],
                "file_sha256": self._file_hash(stage),
                "audio_essence_sha256": essence_before,
                "embedded_sha256": [art_sha],
                "genres": album["genres"],
            })
            install_pairs.append((
                stage,
                live,
                track["path"],
                identity,
                current_tracks[track["path"]]["parent_identity"],
                track["expected_file_sha256"],
                post_tracks[-1]["file_sha256"],
            ))

        sidecar_live = self._library_path(album["sidecar"]["path"])
        sidecar_backup = backup_dir / album["sidecar"]["path"]
        sidecar_stage = stage_dir / album["sidecar"]["path"]
        self._register_and_backup(
            journal, album["album_id"], album["sidecar"]["path"], sidecar_live,
            sidecar_backup, current["sidecar"]["identity"],
        )
        self._copy_with_parents(sidecar_backup, sidecar_stage)
        sidecar_stage.write_bytes(art)
        self._fsync_file(sidecar_stage)
        install_pairs.append((
            sidecar_stage,
            sidecar_live,
            album["sidecar"]["path"],
            current["sidecar"]["identity"],
            current["sidecar"]["parent_identity"],
            album["sidecar"]["expected_sha256"],
            art_sha,
        ))

        for _, _, relative, _, _, original_sha, post_sha in install_pairs:
            entry = next(item for item in journal["install_files"] if item["path"] == relative)
            if not entry.get("backup_committed") or entry.get("backup_sha256") != original_sha:
                raise RemediationError("Backup was not durably committed before replacement preparation")
            entry["post_sha256"] = post_sha
            entry["state"] = "prepared"
        self._write_journal(journal)
        for stage, live, relative, identity, parent_identity, _, _ in install_pairs:
            entry = next(item for item in journal["install_files"] if item["path"] == relative)
            entry["state"] = "replacing"
            self._write_journal(journal)
            self._assert_file_identity(live, identity)
            self._replace_file(stage, live, parent_identity)
            self._after_replace(relative)
            entry["state"] = "installed"
            self._write_journal(journal)
        post_state = {
            "album_id": album["album_id"],
            "tracks": post_tracks,
            "sidecar": {"path": album["sidecar"]["path"], "sha256": art_sha},
        }
        self._verify_post_state([post_state])
        post_state["db"] = self._expected_post_db(album, current["db_items"])
        journal["inflight_post_state"] = post_state
        self._write_journal(journal)
        self._sync_db_album(library, album, current["db_items"], current["db_album"])
        self._verify_db_manifest(library, {"albums": [album]}, [post_state])
        return post_state

    def _after_replace(self, relative: str) -> None:
        del relative

    def _after_backup_temp_written(self, temporary: Path, destination: Path) -> None:
        del temporary, destination

    def _register_and_backup(
        self, journal: dict[str, Any], album_id: str, relative: str,
        live: Path, backup: Path, identity: dict[str, Any],
    ) -> None:
        entry = {
            "album_id": album_id,
            "path": relative,
            "original_sha256": identity["sha256"],
            "post_sha256": None,
            "backup_committed": False,
            "state": "pending_backup",
        }
        journal["install_files"].append(entry)
        self._write_journal(journal)
        self._copy_live_file(live, backup, identity)
        entry["backup_sha256"] = identity["sha256"]
        entry["backup_committed"] = True
        entry["state"] = "backup_committed"
        self._write_journal(journal)

    def _restore_manifest(self, tx_dir: Path, journal: dict[str, Any], internal: bool) -> None:
        backup_dir = tx_dir / "original"
        restore_dir = tx_dir / "restore"
        allowed = {"pending_backup", "backup_committed", "prepared", "replacing", "installed", "restored"}
        for entry in journal.get("install_files", []):
            state = entry.get("state")
            if state not in allowed or (not internal and state not in {"installed", "restored"}):
                raise RemediationError("Journal contains an unsafe install state for restoration")
            relative = entry["path"]
            live = self._library_path(relative)
            live_hash = self._file_hash(live)
            original_hash = entry["original_sha256"]
            post_hash = entry.get("post_sha256")
            if live_hash not in {original_hash, post_hash}:
                raise RemediationError("Live file conflicts with the known transaction states")
            if live_hash == original_hash:
                entry["state"] = "restored"
                self._write_journal(journal)
                continue
            if not entry.get("backup_committed") or entry.get("backup_sha256") != original_hash:
                raise RemediationError("No journal-committed backup is available for restoration")
            backup = self._transaction_child(backup_dir, relative)
            self._reject_symlink_path(backup, tx_dir)
            try:
                self._file_identity(backup, original_hash)
            except RemediationError as error:
                raise RemediationError("Committed backup hash revalidation failed") from error
            stage = self._transaction_child(restore_dir, relative)
            self._copy_with_parents(backup, stage)
            self._replace_file(stage, live, self._parent_identity(live))
            if self._file_hash(live) != original_hash:
                raise RemediationError("Original restoration verification failed")
            self._after_rollback_replace(relative)
            entry["state"] = "restored"
            self._write_journal(journal)
        self._verify_original_state(journal["manifest"])

    def _after_rollback_replace(self, relative: str) -> None:
        del relative

    def _expected_post_db(self, album: dict[str, Any], items: dict[str, Any]) -> dict[str, Any]:
        return {
            "items": {
                relative: {
                    "genre": album["genres"][0],
                    "mtime": item.current_mtime(),
                    "size": self._library_path(relative).stat().st_size,
                }
                for relative, item in items.items()
            },
            "album": {
                "genre": album["genres"][0],
                "artpath": str(self._library_path(album["sidecar"]["path"])),
            },
        }

    def _restore_db_manifest(self, library: Any, journal: dict[str, Any]) -> None:
        self._assert_maintenance_idle()
        post_states = list(journal.get("post_state", []))
        if isinstance(journal.get("inflight_post_state"), dict):
            post_states.append(journal["inflight_post_state"])
        for album in journal["manifest"]["albums"]:
            items, db_album = self._db_album(library, album)
            expected = next(item for item in journal["original_state"] if item["album_id"] == album["album_id"])["db"]
            post = next(
                (item.get("db") for item in post_states if item["album_id"] == album["album_id"]),
                None,
            )
            actual = self._capture_db_state(items, db_album)
            for relative, row in actual["items"].items():
                allowed = [expected["items"][relative]]
                if post:
                    allowed.append(post["items"][relative])
                if row not in allowed:
                    raise RemediationError("Beets database item conflicts with the known transaction states")
            allowed_album = [expected["album"]]
            if post:
                allowed_album.append(post["album"])
            if actual["album"] not in allowed_album:
                raise RemediationError("Beets database album conflicts with the known transaction states")
            for relative in sorted(items):
                item = items[relative]
                row = expected["items"][relative]
                item.genre = row["genre"]
                item.mtime = row["mtime"]
                item.filesize = row["size"]
                item.store()
                self._during_db_restore(relative)
            refreshed = library.get_album(db_album.id)
            if refreshed is None:
                raise RemediationError("beets database album disappeared during restoration")
            refreshed.genre = expected["album"]["genre"]
            refreshed.artpath = bytestring_path(expected["album"]["artpath"]) if expected["album"]["artpath"] else None
            refreshed.store(inherit=False)
        self._verify_db_manifest(library, journal["manifest"], journal["original_state"])

    def _during_db_restore(self, relative: str) -> None:
        del relative

    def _sync_db_album(self, library: Any, album: dict[str, Any], items: dict[str, Any], db_album: Any) -> None:
        self._assert_maintenance_idle()
        for relative in sorted(items):
            item = items[relative]
            item.read()
            live = self._library_path(relative)
            item.mtime = item.current_mtime()
            item.filesize = live.stat().st_size
            item.store()
            if item.mtime != item.current_mtime() or item.try_filesize() != live.stat().st_size:
                raise RemediationError("beets database item mtime or computed size is stale")
        refreshed = library.get_album(db_album.id)
        if refreshed is None:
            raise RemediationError("beets database album disappeared during synchronization")
        first = items[sorted(items)[0]]
        refreshed.genre = first.genre
        refreshed.artpath = bytestring_path(str(self._library_path(album["sidecar"]["path"])))
        refreshed.store(inherit=False)

    def _verify_db_manifest(self, library: Any, manifest: dict[str, Any], state: list[dict[str, Any]]) -> None:
        state_by_album = {album["album_id"]: album for album in state}
        for album in manifest["albums"]:
            items, db_album = self._db_album(library, album)
            expected = {track["path"]: track for track in state_by_album[album["album_id"]]["tracks"]}
            expected_db = state_by_album[album["album_id"]].get("db")
            for relative, item in items.items():
                genres = expected[relative]["genres"]
                live = self._library_path(relative)
                if item.genre != (genres[0] if genres else ""):
                    raise RemediationError("beets database genre does not match audited file state")
                if expected_db:
                    row = expected_db["items"][relative]
                    if item.genre != row["genre"] or item.mtime != row["mtime"] or item.try_filesize() != row["size"]:
                        raise RemediationError("beets database item genre, mtime, or size does not match transaction state")
                elif item.mtime != item.current_mtime() or item.try_filesize() != live.stat().st_size:
                    raise RemediationError("beets database item mtime or computed size is stale")
            expected_art = bytestring_path(str(self._library_path(album["sidecar"]["path"])))
            if expected_db:
                if db_album.genre != expected_db["album"]["genre"]:
                    raise RemediationError("beets database album genre does not match transaction state")
                expected_art = bytestring_path(expected_db["album"]["artpath"]) if expected_db["album"]["artpath"] else None
            if db_album.artpath != expected_art:
                raise RemediationError("beets database artwork path does not match audited sidecar")

    def _validate_finalize_attestation(
        self,
        raw: Any,
        signature: Any,
        journal: dict[str, Any],
        expected_state: list[dict[str, Any]],
    ) -> dict[str, Any]:
        required = {"schema", "transaction_id", "manifest_snapshot_id", "post_audit_scan_id", "albums"}
        if not isinstance(raw, dict) or set(raw) != required:
            raise RemediationError("A complete media-mcp finalize attestation is required")
        if raw["schema"] != "music-remediation-finalize-attestation.v1":
            raise RemediationError("Unsupported finalize attestation schema")
        if raw["transaction_id"] != journal["transaction_id"]:
            raise RemediationError("Finalize attestation transaction does not match")
        pre_write_scan_id = journal["manifest"]["snapshot_id"]
        if self._uuid(raw["manifest_snapshot_id"], "manifest snapshot ID") != pre_write_scan_id:
            raise RemediationError("Finalize attestation snapshot does not match the transaction")
        scan_id = self._uuid(raw["post_audit_scan_id"], "post-audit scan ID")
        if scan_id == pre_write_scan_id:
            raise RemediationError("Post-audit scan ID must differ from the pre-write scan")
        expected_albums = self._proof_albums(expected_state)
        if raw["albums"] != expected_albums:
            raise RemediationError("Finalize attestation does not exactly match the transaction state")
        if not isinstance(signature, str) or not HASH_RE.fullmatch(signature):
            raise RemediationError("A valid finalize attestation HMAC is required")
        key = self.settings.manifest_hmac_key
        if not key:
            raise RemediationError("Finalize attestation verification is unavailable")
        expected_signature = hmac.new(key.encode(), self._canonical_json(raw), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature.encode(), expected_signature.encode()):
            raise RemediationError("Finalize attestation HMAC is invalid")
        return {
            "schema": raw["schema"],
            "transaction_id": journal["transaction_id"],
            "manifest_snapshot_id": pre_write_scan_id,
            "post_audit_scan_id": scan_id,
            "albums": expected_albums,
        }

    @staticmethod
    def _proof_albums(state: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "album_id": album["album_id"],
                "tracks": [
                    {
                        "path": track["path"],
                        "file_sha256": track["file_sha256"],
                        "embedded_sha256": track["embedded_sha256"],
                        "genres": track["genres"],
                    }
                    for track in album["tracks"]
                ],
                "sidecar": album["sidecar"],
            }
            for album in state
        ]

    def _verify_audit_state(self, state: list[dict[str, Any]]) -> None:
        for album in state:
            for track in album["tracks"]:
                path = self._library_path(track["path"])
                self._file_identity(path, track["file_sha256"])
                media = MediaFile(str(path))
                embedded = [hashlib.sha256(image.data).hexdigest() for image in (media.images or [])]
                if embedded != track["embedded_sha256"] or list(media.genres or []) != track["genres"]:
                    raise RemediationError("Current metadata does not match the post-audit proof")
            self._file_identity(
                self._library_path(album["sidecar"]["path"]),
                album["sidecar"]["sha256"],
            )

    def _verify_original_state(self, manifest: dict[str, Any]) -> None:
        for album in manifest["albums"]:
            for track in album["tracks"]:
                if self._file_hash(self._library_path(track["path"])) != track["expected_file_sha256"]:
                    raise RemediationError("Original track restoration verification failed")
            if self._file_hash(self._library_path(album["sidecar"]["path"])) != album["sidecar"]["expected_sha256"]:
                raise RemediationError("Original sidecar restoration verification failed")

    def _verify_post_state(self, post_state: list[dict[str, Any]]) -> None:
        for album in post_state:
            for track in album["tracks"]:
                if self._file_hash(self._library_path(track["path"])) != track["file_sha256"]:
                    raise RemediationError("Current track no longer matches the applied transaction")
            sidecar = album["sidecar"]
            if self._file_hash(self._library_path(sidecar["path"])) != sidecar["sha256"]:
                raise RemediationError("Current sidecar no longer matches the applied transaction")

    def _audio_essence(self, path: Path) -> str:
        command = [
            self.settings.ffmpeg,
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-c:a",
            "copy",
            "-f",
            "hash",
            "-hash",
            "sha256",
            "-",
        ]
        try:
            result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=300)
        except (OSError, subprocess.SubprocessError) as error:
            raise RemediationError("Audio essence verification failed") from error
        match = re.fullmatch(r"SHA256=([A-Fa-f0-9]{64})\n?", result.stdout)
        if not match:
            raise RemediationError("Audio essence verifier returned an unexpected result")
        return match.group(1).lower()

    @contextmanager
    def _writer_lock(self, blocking: bool = False) -> Iterator[None]:
        with self.lock_path.open("a+b") as lock:
            try:
                flags = fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB
                fcntl.flock(lock, flags)
            except BlockingIOError as error:
                raise RemediationError("Another remediation operation is in progress") from error
            yield

    def _require_no_active_transaction(self) -> None:
        active = []
        for path in self.journals.glob("*.json"):
            self._reject_symlink_path(path, self.settings.backup_root)
            journal = json.loads(path.read_text())
            if journal.get("status") != "finalized":
                active.append(journal.get("transaction_id"))
        if active:
            raise RemediationError("A non-finalized remediation transaction already exists")

    def _write_journal(self, journal: dict[str, Any]) -> None:
        tx_id = self._validate_transaction_id(journal["transaction_id"])
        destination = self.journals / f"{tx_id}.json"
        fd, temp_name = tempfile.mkstemp(prefix=f".{tx_id}.", dir=self.journals)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(journal, handle, separators=(",", ":"), sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, destination)
            self._fsync_directory(self.journals)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    def _read_journal(self, tx_id: str) -> dict[str, Any]:
        path = self.journals / f"{tx_id}.json"
        self._reject_symlink_path(path, self.settings.backup_root)
        try:
            journal = json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError) as error:
            raise RemediationError("Unknown transaction ID") from error
        if journal.get("transaction_id") != tx_id or journal.get("schema") != "beets-flask-remediation.journal.v1":
            raise RemediationError("Invalid transaction journal")
        return journal

    def _transaction_dir(self, tx_id: str) -> Path:
        path = self.transactions / tx_id
        self._reject_symlink_path(path, self.settings.backup_root)
        if not path.is_dir():
            raise RemediationError("Transaction backup is missing")
        return path

    def _library_path(self, relative: str) -> Path:
        path = self.settings.library_root.joinpath(*PurePosixPath(relative).parts)
        self._reject_symlink_path(path, self.settings.library_root)
        try:
            if os.path.commonpath((self.settings.library_root, path)) != str(self.settings.library_root):
                raise RemediationError("Path escapes the configured library root")
        except ValueError as error:
            raise RemediationError("Path escapes the configured library root") from error
        return path

    def _transaction_child(self, root: Path, relative: str) -> Path:
        path = root.joinpath(*PurePosixPath(relative).parts)
        if os.path.commonpath((root, path)) != str(root):
            raise RemediationError("Transaction path escaped its root")
        return path

    @staticmethod
    def _reject_symlink_path(path: Path, root: Path) -> None:
        try:
            relative = path.relative_to(root)
        except ValueError as error:
            raise RemediationError("Path escapes its configured root") from error
        current = root
        if current.is_symlink():
            raise RemediationError("Symlink roots are rejected")
        for component in relative.parts:
            current /= component
            if current.is_symlink():
                raise RemediationError("Every symlink path component is rejected")
            if not current.exists():
                break

    @staticmethod
    def _ensure_directory(directory: Path) -> None:
        missing = []
        current = directory
        while not current.exists():
            missing.append(current)
            current = current.parent
        for child in reversed(missing):
            child.mkdir(mode=0o700)
            RemediationService._fsync_directory(child)
            RemediationService._fsync_directory(child.parent)

    @staticmethod
    def _copy_with_parents(source: Path, destination: Path) -> None:
        RemediationService._ensure_directory(destination.parent)
        shutil.copy2(source, destination)
        RemediationService._fsync_file(destination)
        RemediationService._fsync_directory(destination.parent)

    @staticmethod
    def _read_bounded(path: Path, maximum: int) -> bytes:
        with path.open("rb") as handle:
            data = handle.read(maximum + 1)
        if len(data) > maximum:
            raise RemediationError("File exceeds the byte limit")
        return data

    @staticmethod
    def _file_identity(path: Path, expected_hash: str) -> dict[str, Any]:
        try:
            before = path.lstat()
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise RemediationError("Live files must be regular, non-hardlinked files")
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except (FileNotFoundError, OSError) as error:
            raise RemediationError("Expected file is missing or unsafe") from error
        digest = hashlib.sha256()
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino) or opened.st_nlink != 1:
                raise RemediationError("File identity changed while opening")
            while chunk := os.read(descriptor, 1024 * 1024):
                digest.update(chunk)
            after = os.fstat(descriptor)
            identity = {
                "dev": after.st_dev,
                "ino": after.st_ino,
                "size": after.st_size,
                "mtime_ns": after.st_mtime_ns,
                "mode": stat.S_IMODE(after.st_mode),
            }
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
            ):
                raise RemediationError("File identity changed while hashing")
        finally:
            os.close(descriptor)
        actual_hash = digest.hexdigest()
        if actual_hash != expected_hash:
            raise RemediationError("Current file hash does not match the manifest")
        return {**identity, "sha256": actual_hash}

    @staticmethod
    def _assert_file_identity(path: Path, expected: dict[str, Any]) -> None:
        current = RemediationService._file_identity(path, expected["sha256"])
        if current != expected:
            raise RemediationError("Live file identity changed before replacement")

    def _parent_identity(self, path: Path) -> dict[str, int]:
        self._reject_symlink_path(path.parent, self.settings.library_root)
        parent = path.parent.stat()
        if not stat.S_ISDIR(parent.st_mode):
            raise RemediationError("Live parent is not a directory")
        return {"dev": parent.st_dev, "ino": parent.st_ino, "mode": stat.S_IMODE(parent.st_mode)}

    def _assert_parent_identity(self, path: Path, expected: dict[str, int]) -> None:
        if self._parent_identity(path) != expected:
            raise RemediationError("Live parent directory identity changed before replacement")

    def _replace_file(self, source: Path, destination: Path, expected_parent: dict[str, int]) -> None:
        self._assert_maintenance_idle()
        self._assert_parent_identity(destination, expected_parent)
        source_fd = os.open(source.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        destination_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(destination_fd)
            if {"dev": opened.st_dev, "ino": opened.st_ino, "mode": stat.S_IMODE(opened.st_mode)} != expected_parent:
                raise RemediationError("Live parent directory identity changed before replacement")
            self._assert_parent_identity(destination, expected_parent)
            os.replace(source.name, destination.name, src_dir_fd=source_fd, dst_dir_fd=destination_fd)
            os.fsync(destination_fd)
        finally:
            os.close(source_fd)
            os.close(destination_fd)

    def _copy_live_file(self, source: Path, destination: Path, expected: dict[str, Any]) -> None:
        self._ensure_directory(destination.parent)
        temporary = destination.parent / f".{destination.name}.{uuid.uuid4().hex}.tmp"
        source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(source_fd)
            current = {
                "dev": opened.st_dev,
                "ino": opened.st_ino,
                "size": opened.st_size,
                "mtime_ns": opened.st_mtime_ns,
                "mode": stat.S_IMODE(opened.st_mode),
            }
            if opened.st_nlink != 1 or any(current[key] != expected[key] for key in current):
                raise RemediationError("Live file identity changed before backup")
            with os.fdopen(os.dup(source_fd), "rb") as input_file, temporary.open("xb") as output_file:
                shutil.copyfileobj(input_file, output_file, 1024 * 1024)
                output_file.flush()
                os.fsync(output_file.fileno())
            after = os.fstat(source_fd)
            if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_nlink) != (
                opened.st_dev,
                opened.st_ino,
                opened.st_size,
                opened.st_mtime_ns,
                1,
            ):
                raise RemediationError("Live file changed while backing it up")
            os.chmod(temporary, expected["mode"])
            os.utime(temporary, ns=(opened.st_atime_ns, opened.st_mtime_ns))
            self._fsync_file(temporary)
            self._after_backup_temp_written(temporary, destination)
            if self._file_hash(temporary) != expected["sha256"]:
                raise RemediationError("Backup hash verification failed")
            parent_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.replace(temporary.name, destination.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
            if self._file_hash(destination) != expected["sha256"]:
                raise RemediationError("Committed backup hash verification failed")
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        finally:
            os.close(source_fd)

    @staticmethod
    def _file_hash(path: Path) -> str:
        digest = hashlib.sha256()
        try:
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        except (FileNotFoundError, IsADirectoryError) as error:
            raise RemediationError("Expected file is missing") from error
        return digest.hexdigest()

    @staticmethod
    def _fsync_file(path: Path) -> None:
        with path.open("rb") as handle:
            os.fsync(handle.fileno())

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _relative(value: Any, label: str) -> str:
        if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
            raise RemediationError(f"Invalid {label}")
        pure = PurePosixPath(value)
        if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts) or pure.as_posix() != value:
            raise RemediationError(f"Invalid {label}")
        return value

    @staticmethod
    def _require_under_album(value: str, album_path: str) -> None:
        album = PurePosixPath(album_path)
        candidate = PurePosixPath(value)
        if candidate == album or album not in candidate.parents:
            raise RemediationError("Track and sidecar paths must be contained by album_path")

    @staticmethod
    def _hash(value: Any, label: str) -> str:
        if not isinstance(value, str) or not HASH_RE.fullmatch(value):
            raise RemediationError(f"Invalid {label}")
        return value

    @staticmethod
    def _uuid(value: Any, label: str) -> str:
        if not isinstance(value, str) or not UUID_RE.fullmatch(value):
            raise RemediationError(f"Invalid {label}")
        return str(uuid.UUID(value))

    @staticmethod
    def _validate_transaction_id(value: Any) -> str:
        if not isinstance(value, str) or not TX_RE.fullmatch(value):
            raise RemediationError("Invalid transaction ID")
        return value


def create_remediation_blueprint(settings: Settings | None = None, service: RemediationService | None = None) -> Blueprint:
    settings = settings or Settings.from_env()
    service = service or RemediationService(settings)
    blueprint = Blueprint("remediation", __name__, url_prefix="/api_v1/remediation")

    @blueprint.before_request
    async def authenticate() -> Response | None:
        if request.content_length is not None and request.content_length > MAX_REQUEST_BYTES:
            return jsonify({"ok": False, "error": "Request exceeds the byte limit"}), 413
        try:
            service.authorize(request.headers.get("Authorization"))
        except PermissionError:
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        except RemediationError as error:
            return jsonify({"ok": False, "error": str(error)}), 503
        return None

    async def body() -> dict[str, Any]:
        raw = await request.get_data(cache=True)
        if len(raw) > MAX_REQUEST_BYTES:
            raise RequestTooLargeError("Request exceeds the byte limit")
        parsed = await request.get_json(force=False, silent=False)
        if not isinstance(parsed, dict):
            raise RemediationError("JSON object required")
        return parsed

    async def run(operation: str) -> tuple[Response, int] | Response:
        try:
            payload = await body()
            if operation == "art-digest":
                if set(payload) != {"musicbrainz_release_id", "url"}:
                    raise RemediationError("Art digest requires only musicbrainz_release_id and url")
                result = await asyncio.to_thread(service.art_digest, payload["musicbrainz_release_id"], payload["url"])
            elif operation == "preview":
                if set(payload) != {"manifest"}:
                    raise RemediationError("Preview must contain only the signed manifest envelope")
                result = await asyncio.to_thread(service.preview, payload["manifest"])
            elif operation == "apply":
                if set(payload) != {"manifest", "operation_id"}:
                    raise RemediationError("Apply must contain only manifest and operation_id")
                result = await asyncio.to_thread(service.apply, payload["manifest"], payload["operation_id"])
            elif operation == "rollback":
                if set(payload) != {"transaction_id"}:
                    raise RemediationError("Rollback must contain only transaction_id")
                result = await asyncio.to_thread(service.rollback, payload["transaction_id"])
            elif operation == "finalize-state":
                if set(payload) != {"transaction_id"}:
                    raise RemediationError("Finalize state requires only transaction_id")
                result = await asyncio.to_thread(service.finalize_state, payload["transaction_id"])
            elif operation == "finalize":
                if set(payload) != {"transaction_id", "attestation", "signature"}:
                    raise RemediationError("Finalize requires transaction_id and a signed media-mcp attestation")
                result = await asyncio.to_thread(service.finalize, payload["transaction_id"], payload["attestation"], payload["signature"])
            elif operation == "status":
                if not set(payload).issubset({"transaction_id"}):
                    raise RemediationError("Status accepts only an optional transaction_id")
                result = await asyncio.to_thread(service.transaction, payload.get("transaction_id"), False)
            else:
                if set(payload) != {"transaction_id"}:
                    raise RemediationError("Recovery requires only transaction_id")
                result = await asyncio.to_thread(service.transaction, payload["transaction_id"], True)
            return jsonify({"ok": True, **result})
        except RequestTooLargeError as error:
            return jsonify({"ok": False, "error": str(error)}), 413
        except RemediationError as error:
            return jsonify({"ok": False, "error": str(error)}), 409
        except Exception:
            logger.exception("Remediation operation failed closed")
            return jsonify({"ok": False, "error": "Remediation operation failed closed"}), 500

    @blueprint.post("/art-digest")
    async def art_digest() -> tuple[Response, int] | Response:
        return await run("art-digest")

    @blueprint.post("/preview")
    async def preview() -> tuple[Response, int] | Response:
        return await run("preview")

    @blueprint.post("/apply")
    async def apply() -> tuple[Response, int] | Response:
        return await run("apply")

    @blueprint.post("/rollback")
    async def rollback() -> tuple[Response, int] | Response:
        return await run("rollback")

    @blueprint.post("/finalize-state")
    async def finalize_state() -> tuple[Response, int] | Response:
        return await run("finalize-state")

    @blueprint.post("/finalize")
    async def finalize() -> tuple[Response, int] | Response:
        return await run("finalize")

    @blueprint.post("/status")
    async def status() -> tuple[Response, int] | Response:
        return await run("status")

    @blueprint.post("/recover")
    async def recover() -> tuple[Response, int] | Response:
        return await run("recover")

    return blueprint
