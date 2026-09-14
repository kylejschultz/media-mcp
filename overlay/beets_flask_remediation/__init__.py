from __future__ import annotations

from quart import Quart

from beets_flask.server.app import create_app as create_upstream_app

from .remediation import create_remediation_blueprint


def create_app() -> Quart:
    """Create the pinned upstream app with the remediation routes overlaid."""
    app = create_upstream_app()
    app.register_blueprint(create_remediation_blueprint())
    return app
