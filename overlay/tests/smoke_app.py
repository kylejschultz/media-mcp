from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path


def main() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        (root / "library").mkdir()
        (root / "backup").mkdir()
        os.environ.update(
            {
                "BEETS_REMEDIATION_ENABLED": "true",
                "BEETS_REMEDIATION_TOKEN": "x" * 32,
                "BEETS_REMEDIATION_MANIFEST_HMAC_KEY": "h" * 32,
                "BEETS_REMEDIATION_APPROVED_SCAN_ID": "b652dc32-62d7-49a8-8f57-a63c002cb72f",
                "BEETS_REMEDIATION_GENRES_JSON": '["Rock"]',
                "BEETS_REMEDIATION_LIBRARY_ROOT": str(root / "library"),
                "BEETS_REMEDIATION_BACKUP_ROOT": str(root / "backup"),
            }
        )
        from beets_flask_remediation import create_app

        app = create_app()
        routes = {rule.rule for rule in app.url_map.iter_rules()}
        for route in ("art-digest", "preview", "apply", "rollback", "finalize-state", "finalize", "status", "recover"):
            assert f"/api_v1/remediation/{route}" in routes

        async def check_auth() -> None:
            response = await app.test_client().post("/api_v1/remediation/preview", json={})
            assert response.status_code == 401

        asyncio.run(check_auth())


if __name__ == "__main__":
    main()
