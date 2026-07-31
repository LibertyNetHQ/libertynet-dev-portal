"""HTTP transport.

Small on purpose: one request helper, one error mapping, one retry rule. Built on
``urllib`` so the core SDK has no third-party dependencies — installing a package
should not be a prerequisite for reading a public network.
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from typing import Any

from .errors import ApiError, AuthError, LibertyNetError, TransportError

__all__ = ["Http", "DEFAULT_BASE_URL"]

DEFAULT_BASE_URL = "https://registry.libertynet.ai"

#: Retried. Everything else is not — replaying a rejected signature just gets it
#: rejected again, more expensively.
_RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})


class Http:
    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 15.0,
        retries: int = 2,
        headers: dict[str, str] | None = None,
        opener: Any = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self._extra_headers = headers or {}
        # Injectable for tests; falls back to the module-level urlopen.
        self._opener = opener or urllib.request.urlopen
        # Bearer token, in memory only. A token on disk is a token in a backup,
        # a crash dump and a log shipper.
        self._bearer: str | None = None

    # -- session ----------------------------------------------------------

    def set_bearer(self, token: str | None) -> None:
        self._bearer = token

    def has_bearer(self) -> bool:
        return self._bearer is not None

    # -- verbs ------------------------------------------------------------

    def get(self, path: str, *, auth: bool = False) -> Any:
        return self._request("GET", path, None, auth)

    def post(self, path: str, body: Any = None, *, auth: bool = False) -> Any:
        return self._request("POST", path, body, auth)

    def get_text(self, path: str) -> str:
        return self._raw("GET", path, None, False)[1]

    # -- machinery --------------------------------------------------------

    def _request(self, method: str, path: str, body: Any, auth: bool) -> Any:
        if auth and self._bearer is None:
            raise AuthError(
                "NO_SESSION", "This call needs an operator session. Call `auth.login()` first."
            )

        status, text = self._raw(method, path, body, auth)

        parsed: Any = None
        if text:
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                if 200 <= status < 300:
                    raise ApiError(status, "BAD_RESPONSE", f"Expected JSON from {path}", text)

        if not (200 <= status < 300):
            raise _to_api_error(status, parsed, path)
        return parsed

    def _raw(self, method: str, path: str, body: Any, auth: bool) -> tuple[int, str]:
        url = f"{self.base_url}{path}"
        headers = {"accept": "application/json", **self._extra_headers}
        data = None

        if body is not None:
            data = json.dumps(body).encode()
            headers["content-type"] = "application/json"
        if auth and self._bearer:
            headers["authorization"] = f"Bearer {self._bearer}"

        last_error: object = None

        for attempt in range(self.retries + 1):
            if attempt:
                # Exponential backoff with jitter, so a fleet recovering from an
                # outage does not re-create the outage by retrying in lockstep.
                base = 0.25 * 2 ** (attempt - 1)
                time.sleep(base + random.random() * base)

            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with self._opener(req, timeout=self.timeout) as res:
                    return res.status, res.read().decode()
            except urllib.error.HTTPError as e:
                status = e.code
                text = e.read().decode(errors="replace")
                if status in _RETRYABLE_STATUS and attempt < self.retries:
                    last_error = e
                    continue
                return status, text
            except Exception as e:  # URLError, socket.timeout, ssl errors
                last_error = e
                if attempt == self.retries:
                    break

        raise TransportError(
            f"{method} {_redact(url)} failed after {self.retries + 1} attempt(s)", last_error
        )


def _redact(url: str) -> str:
    """Strip anything query-shaped before a URL reaches a log line."""
    q = url.find("?")
    return url if q == -1 else f"{url[:q]}?<redacted>"


def _to_api_error(status: int, body: Any, path: str) -> LibertyNetError:
    b = body if isinstance(body, dict) else {}
    code = b.get("code") or f"HTTP_{status}"
    message = b.get("error") or f"{path} returned HTTP {status}"

    if status == 401 and code in ("NO_SESSION", "SESSION_EXPIRED"):
        return AuthError(code, message)
    return ApiError(status, code, message, body)
