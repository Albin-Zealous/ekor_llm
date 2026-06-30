"""Backport of Odoo 18 bearer authentication for Odoo 17.

The MCP controller authenticates requests with ``Authorization: Bearer <key>``
through ``ir.http._auth_method_bearer()``. That auth method only exists in
Odoo 18+, so this re-implements it on top of Odoo 17's API-key infrastructure:
the bearer token is validated as an rpc-scoped API key and, on success, the
request environment is switched to the key's owner (so record rules apply).
"""

import werkzeug.exceptions

from odoo import models
from odoo.exceptions import AccessError
from odoo.http import request

_BEARER_PREFIX = "Bearer "


class IrHttp(models.AbstractModel):
    _inherit = "ir.http"

    @classmethod
    def _auth_method_bearer(cls):
        """Authenticate the request from an ``Authorization: Bearer`` header.

        Raises ``Unauthorized`` when the header is missing/empty or the key is
        invalid; otherwise switches ``request.env`` to the key's user.
        """
        authorization = request.httprequest.headers.get("Authorization", "")
        if not authorization.startswith(_BEARER_PREFIX):
            raise werkzeug.exceptions.Unauthorized("Missing bearer token")

        api_key = authorization[len(_BEARER_PREFIX):].strip()
        if not api_key:
            raise werkzeug.exceptions.Unauthorized("Empty bearer token")

        try:
            user_id = (
                request.env["res.users.apikeys"]
                .sudo()
                ._check_credentials(scope="rpc", key=api_key)
            )
        except AccessError:
            user_id = False

        if not user_id:
            raise werkzeug.exceptions.Unauthorized("Invalid bearer token")

        request.update_env(user=user_id)