#!/usr/bin/env python3
"""SuperLanguage MCP server.

Zero-third-party-dependency MCP stdio server for the local SuperLanguage HTTP API.
The server only queues work in SuperLanguage. It never drives WeChat directly.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Dict, Iterable, Mapping, Optional


SERVER_NAME = "supertime-mcp"
SERVER_VERSION = "1.0.0"
SUPPORTED_PROTOCOLS = ("2024-11-05", "2025-03-26", "2025-06-18")
LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[-1]
# 2025-06-18 removed JSON-RPC batching from MCP.
BATCH_PROTOCOLS = frozenset({"2024-11-05", "2025-03-26"})
MAX_TOOL_BODY_BYTES = 8192
MAX_STDIO_MESSAGE_BYTES = 4 * 1024 * 1024
MAX_HTTP_RESPONSE_BYTES = 1024 * 1024
MAX_TARGET_UTF16_UNITS = 127
MAX_MESSAGE_UTF16_UNITS = 511
MAX_MENTION_UTF16_UNITS = 127
MAX_ATTACHMENTS = 9
MAX_ATTACHMENT_PATHS_UTF16_UNITS = 1023
MAX_RESOURCE_IDS_UTF16_UNITS = 1199
DEFAULT_TIMEOUT_SECONDS = 15.0
WAIT_JOB_MIN_HTTP_TIMEOUT_SECONDS = 1.0
JOB_ID_RE = re.compile(r"^[0-9A-Fa-f]{1,16}$")
TOKEN_RE = re.compile(r"^[0-9A-Fa-f]{32}$")
RESOURCE_ID_RE = re.compile(r"^[0-9a-f]{40}$")

LOGGER = logging.getLogger(SERVER_NAME)

QUEUED_WARNING = (
    "QUEUED, NOT DELIVERED: SuperLanguage accepted this job into its local queue. "
    "Poll get_job with the returned job_id. If the queue result reports "
    "delivery_uncertain=true, or the enqueue response was lost, do NOT resend "
    "automatically: verify the target conversation manually and ask the user first."
)

UNCERTAIN_WARNING = (
    "DELIVERY UNCERTAIN: The request may already have reached SuperLanguage and "
    "been queued. Do NOT resend automatically. Inspect SuperLanguage status and "
    "the target "
    "WeChat conversation, then ask the user before submitting another message. "
    "Use get_job only when a job_id is known."
)


class ConfigError(Exception):
    """Raised when the SuperLanguage API endpoint or token cannot be resolved."""


class ToolArgumentError(Exception):
    """Raised when tools/call arguments fail local validation."""

    def __init__(self, fields: Dict[str, str], message: str = "Invalid tool arguments"):
        super().__init__(message)
        self.fields = fields


class SuperTimeAPIError(Exception):
    """A normalized HTTP, transport, or response error from SuperLanguage."""

    def __init__(
        self,
        kind: str,
        message: str,
        *,
        http_status: Optional[int] = None,
        retryable: bool = False,
        safe_to_retry: bool = False,
        delivery_uncertain: bool = False,
        hint: Optional[str] = None,
        provenance: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.http_status = http_status
        self.retryable = retryable
        self.safe_to_retry = safe_to_retry
        self.delivery_uncertain = delivery_uncertain
        self.hint = hint
        self.provenance = provenance


@dataclass(frozen=True)
class SuperTimeConfig:
    base_url: str
    token: str
    token_source: str
    port_source: str
    timeout_seconds: float

    def public_provenance(self) -> Dict[str, Any]:
        token_source = (
            "environment"
            if self.token_source == "SUPERTIME_API_TOKEN"
            else "file"
        )
        port_source = (
            "environment"
            if self.port_source in {"SUPERTIME_API_PORT", "SUPERTIME_API_URL"}
            else "file"
        )
        return {
            "base_url": self.base_url,
            "token_source": token_source,
            "port_source": port_source,
            "timeout_seconds": self.timeout_seconds,
        }


def _utf16_units(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _is_encodable(value: str) -> bool:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _read_first_line(path: Path) -> str:
    text = path.read_text(encoding="utf-8-sig")
    for line in text.splitlines():
        value = line.strip()
        if value:
            return value
    return ""


def _dedupe_paths(paths: Iterable[Path]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        try:
            key = str(path.expanduser().resolve())
        except OSError:
            key = str(path)
        normalized = key.casefold() if os.name == "nt" else key
        if normalized not in seen:
            seen.add(normalized)
            result.append(path)
    return result


class ConfigResolver:
    """Resolve endpoint/token from environment first, then config files.

    Resolution happens for each request so a rotated SuperLanguage token or a
    changed runtime port is picked up without restarting the MCP process.
    """

    def __init__(
        self,
        env: Optional[Mapping[str, str]] = None,
        server_dir: Optional[Path] = None,
        cwd: Optional[Path] = None,
    ):
        self.env = dict(os.environ if env is None else env)
        self.server_dir = Path(server_dir or Path(__file__).resolve().parent)
        self.cwd = Path(cwd or Path.cwd())

    def _first_env(self, suffix: str) -> tuple[str, Optional[str]]:
        name = f"SUPERTIME_{suffix}"
        value = self.env.get(name, "").strip()
        if value:
            return value, name
        return "", None

    def _config_dirs(self) -> list[Path]:
        candidates: list[Path] = []
        for suffix in ("CONFIG_DIR", "HOME"):
            configured = self.env.get(f"SUPERTIME_{suffix}", "").strip()
            if configured:
                path = Path(configured).expanduser()
                if not path.is_absolute():
                    path = self.cwd / path
                candidates.append(path)

        repo_root = self.server_dir.parent
        candidates.extend(
            [
                repo_root / "build",
                self.cwd / "build",
                repo_root,
                self.cwd,
                self.server_dir,
                self.server_dir / "build",
            ]
        )
        return _dedupe_paths(candidates)

    def _explicit_file(self, suffix: str) -> Optional[Path]:
        raw, env_name = self._first_env(suffix)
        if not raw:
            return None
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = self.cwd / path
        if not path.is_file():
            raise ConfigError(f"{env_name} points to a missing file: {path}")
        return path

    def _find_value_file(
        self,
        filename: str,
        explicit_suffix: str,
    ) -> tuple[Optional[str], Optional[Path]]:
        explicit = self._explicit_file(explicit_suffix)
        if explicit is not None:
            try:
                return _read_first_line(explicit), explicit
            except OSError as exc:
                raise ConfigError(
                    f"Cannot read {explicit_suffix}: {explicit}: {exc}"
                ) from exc

        for directory in self._config_dirs():
            candidate = directory / filename
            if not candidate.is_file():
                continue
            try:
                value = _read_first_line(candidate)
            except OSError:
                continue
            if value:
                return value, candidate
        return None, None

    def _timeout(self) -> float:
        raw, _ = self._first_env("API_TIMEOUT_SECONDS")
        if not raw:
            return DEFAULT_TIMEOUT_SECONDS
        try:
            value = float(raw)
        except ValueError as exc:
            raise ConfigError(
                "SUPERTIME_API_TIMEOUT_SECONDS must be a number"
            ) from exc
        if not 0.1 <= value <= 300.0:
            raise ConfigError(
                "API timeout must be between 0.1 and 300 seconds"
            )
        return value

    def _base_url(self) -> tuple[str, str]:
        raw_url, url_source = self._first_env("API_URL")
        if raw_url:
            parsed = urllib.parse.urlsplit(raw_url)
            if parsed.scheme not in {"http", "https"}:
                raise ConfigError(
                    f"{url_source} must use http:// or https://"
                )
            if not parsed.hostname:
                raise ConfigError(f"{url_source} must include a host")
            if parsed.username is not None or parsed.password is not None:
                raise ConfigError(f"{url_source} must not embed credentials")
            if parsed.query or parsed.fragment:
                raise ConfigError(
                    f"{url_source} must not include query or fragment"
                )
            self._require_allowed_host(parsed.hostname)
            path = parsed.path.rstrip("/")
            if path == "/":
                path = ""
            base = urllib.parse.urlunsplit(
                (parsed.scheme, parsed.netloc, path, "", "")
            )
            return base, str(url_source)

        host, host_source = self._first_env("API_HOST")
        host = host or "127.0.0.1"
        if "://" in host or "/" in host or "\\" in host:
            label = host_source or "SUPERTIME_API_HOST"
            raise ConfigError(f"{label} must be a host name or IP address")
        self._require_allowed_host(host)
        if host.startswith("[") and host.endswith("]"):
            formatted_host = host
        elif ":" in host:
            formatted_host = f"[{host}]"
        else:
            formatted_host = host

        port_text, port_source_name = self._first_env("API_PORT")
        if port_text:
            port_source = str(port_source_name)
            port_path: Optional[Path] = None
        else:
            port_text, port_path = self._find_value_file(
                "api-port.txt", "API_PORT_FILE"
            )
            port_source = str(port_path) if port_path else ""

        if not port_text:
            searched = ", ".join(str(path) for path in self._config_dirs())
            raise ConfigError(
                "SuperLanguage API port not found. Set SUPERTIME_API_PORT or "
                "SUPERTIME_API_URL, or "
                "start SuperLanguage so api-port.txt is written. "
                f"Searched: {searched}"
            )
        try:
            port = int(port_text)
        except ValueError as exc:
            raise ConfigError(f"Invalid SuperLanguage API port: {port_text!r}") from exc
        if not 1 <= port <= 65535:
            raise ConfigError(f"SuperLanguage API port out of range: {port}")
        return f"http://{formatted_host}:{port}", port_source

    def _require_allowed_host(self, host: Optional[str]) -> None:
        if not host:
            raise ConfigError("SuperLanguage API host is missing")
        normalized = host.strip("[]").casefold()
        allow_remote, _ = self._first_env("ALLOW_REMOTE_API")
        allow_remote = allow_remote == "1"
        if normalized == "localhost":
            return
        try:
            address = ipaddress.ip_address(normalized)
        except ValueError as exc:
            if allow_remote:
                return
            raise ConfigError(
                "SuperLanguage API host must be a loopback IP address or localhost"
            ) from exc
        if address.is_loopback:
            return
        if allow_remote:
            return
        raise ConfigError(
            "Refusing a non-loopback SuperLanguage API host because the bearer "
            "token travels in the Authorization header. Set "
            "SUPERTIME_ALLOW_REMOTE_API=1 only when the network path is trusted."
        )

    def _token(self) -> tuple[str, str]:
        env_token, token_source = self._first_env("API_TOKEN")
        if env_token:
            if not TOKEN_RE.fullmatch(env_token):
                raise ConfigError(
                    f"{token_source} must be 32 hexadecimal characters"
                )
            return env_token, str(token_source)

        token_text, token_path = self._find_value_file(
            "api-token.txt", "API_TOKEN_FILE"
        )
        if not token_text or not TOKEN_RE.fullmatch(token_text):
            searched = ", ".join(str(path) for path in self._config_dirs())
            raise ConfigError(
                "SuperLanguage API token not found or invalid. Set "
                "SUPERTIME_API_TOKEN, or "
                "provide build/api-token.txt (32 hexadecimal characters). "
                f"Searched: {searched}"
            )
        return token_text, str(token_path)

    def resolve(self) -> SuperTimeConfig:
        base_url, port_source = self._base_url()
        token, token_source = self._token()
        return SuperTimeConfig(
            base_url=base_url,
            token=token,
            token_source=token_source,
            port_source=port_source,
            timeout_seconds=self._timeout(),
        )


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _default_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _NoRedirectHandler(),
    )


class SuperTimeClient:
    """Small JSON-over-HTTP client for SuperLanguage's authenticated /api routes."""

    def __init__(
        self,
        resolver: Optional[ConfigResolver] = None,
        opener: Optional[Any] = None,
    ):
        self.resolver = resolver or ConfigResolver()
        self._opener = opener or _default_opener()

    @staticmethod
    def _error_message(raw: bytes) -> str:
        if not raw:
            return ""
        try:
            parsed = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return ""
        if isinstance(parsed, dict) and isinstance(parsed.get("message"), str):
            return parsed["message"]
        return ""

    @staticmethod
    def _http_hint(status: int, sending: bool) -> str:
        if status == 401:
            return (
                "Verify SUPERTIME_API_TOKEN or "
                "build/api-token.txt. SuperLanguage may "
                "have rotated its token; reload the token before retrying."
            )
        if status == 403:
            return (
                "SuperLanguage rejected the request. If this was a local attachment "
                "path, use resource_ids instead; local paths are only accepted "
                "when SuperLanguage is bound to loopback."
            )
        if status == 404:
            return (
                "Check the job id or confirm that this SuperLanguage version "
                "supports the endpoint."
            )
        if status in {411, 413}:
            return "The request is too large or lacked a required Content-Length header."
        if status == 415:
            return "SuperLanguage requires Content-Type: application/json for this request."
        if status == 503:
            return (
                "SuperLanguage may be stopping or its job queue may be full. "
                "Inspect status before retrying."
            )
        if sending and status >= 500:
            return (
                "The request may have reached SuperLanguage before the server failed. "
                "Do not resend automatically."
            )
        return (
            "Inspect the SuperLanguage API response and correct the request or "
            "configuration."
        )

    def _http_error(
        self,
        status: int,
        api_message: str,
        *,
        sending: bool,
        provenance: Dict[str, Any],
    ) -> SuperTimeAPIError:
        if status == 400:
            kind = "invalid_request"
        elif status == 401:
            kind = "auth_error"
        elif status == 403:
            kind = "permission_error"
        elif status == 404:
            kind = "not_found"
        elif status == 405:
            kind = "method_not_allowed"
        elif status == 429:
            kind = "rate_limited"
        elif status == 503:
            kind = "service_unavailable"
        elif 500 <= status <= 599:
            kind = "server_error"
        else:
            kind = "http_error"

        detail = api_message.strip() or "SuperLanguage returned no error message"
        message = f"SuperLanguage API HTTP {status}: {detail}"
        delivery_uncertain = sending and status >= 500
        safe_to_retry = not delivery_uncertain and status < 500
        retryable = status in {429, 500, 502, 503, 504} and not sending
        return SuperTimeAPIError(
            kind,
            message,
            http_status=status,
            retryable=retryable,
            safe_to_retry=safe_to_retry,
            delivery_uncertain=delivery_uncertain,
            hint=self._http_hint(status, sending),
            provenance=provenance,
        )

    def _transport_error(
        self,
        exc: BaseException,
        *,
        sending: bool,
        provenance: Dict[str, Any],
    ) -> SuperTimeAPIError:
        label = "timed out" if isinstance(exc, TimeoutError) else "failed"
        if sending:
            message = (
                f"HTTP request to SuperLanguage {label} before a response was "
                "received. "
                "The job may have been queued."
            )
            return SuperTimeAPIError(
                "transport_error",
                message,
                retryable=False,
                safe_to_retry=False,
                delivery_uncertain=True,
                hint=UNCERTAIN_WARNING,
                provenance=provenance,
            )
        return SuperTimeAPIError(
            "transport_error",
            f"HTTP request to SuperLanguage {label}: {exc}",
            retryable=True,
            safe_to_retry=True,
            delivery_uncertain=False,
            hint="Confirm SuperLanguage is running and its API port/token are current.",
            provenance=provenance,
        )

    def _invalid_response(
        self,
        message: str,
        *,
        sending: bool,
        provenance: Dict[str, Any],
    ) -> SuperTimeAPIError:
        return SuperTimeAPIError(
            "invalid_response",
            message,
            retryable=not sending,
            safe_to_retry=not sending,
            delivery_uncertain=sending,
            hint=(
                "Do not resend automatically after an ambiguous send response."
                if sending
                else "Check that the configured URL points to the SuperLanguage API."
            ),
            provenance=provenance,
        )

    def request_json(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        *,
        sending: bool = False,
        max_timeout_seconds: Optional[float] = None,
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        body: Optional[bytes] = None
        if payload is not None:
            body = json.dumps(
                payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            if len(body) > MAX_TOOL_BODY_BYTES:
                raise ToolArgumentError(
                    {
                        "arguments": (
                            f"JSON request body is {len(body)} bytes; SuperLanguage "
                            f"accepts at most {MAX_TOOL_BODY_BYTES}"
                        )
                    }
                )

        config = self.resolver.resolve()
        provenance = config.public_provenance()
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {config.token}",
            "Connection": "close",
            "User-Agent": f"{SERVER_NAME}/{SERVER_VERSION}",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(body))

        timeout_seconds = config.timeout_seconds
        if max_timeout_seconds is not None:
            timeout_seconds = min(timeout_seconds, max_timeout_seconds)

        request = urllib.request.Request(
            config.base_url + path,
            data=body,
            headers=headers,
            method=method,
        )

        try:
            response = self._opener.open(request, timeout=timeout_seconds)
        except urllib.error.HTTPError as exc:
            try:
                raw_error = exc.read(MAX_HTTP_RESPONSE_BYTES + 1)
            except OSError:
                raw_error = b""
            finally:
                exc.close()
            raise self._http_error(
                int(exc.code),
                self._error_message(raw_error),
                sending=sending,
                provenance=provenance,
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise self._transport_error(
                exc, sending=sending, provenance=provenance
            ) from exc

        try:
            status = int(getattr(response, "status", 0))
            raw = response.read(MAX_HTTP_RESPONSE_BYTES + 1)
        except (TimeoutError, OSError) as exc:
            raise self._transport_error(
                exc, sending=sending, provenance=provenance
            ) from exc
        finally:
            response.close()

        if status < 200 or status >= 300:
            raise self._http_error(
                status,
                self._error_message(raw),
                sending=sending,
                provenance=provenance,
            )
        if len(raw) > MAX_HTTP_RESPONSE_BYTES:
            raise self._invalid_response(
                "SuperLanguage response exceeded the 1 MiB safety limit",
                sending=sending,
                provenance=provenance,
            )
        try:
            decoded = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise self._invalid_response(
                "SuperLanguage returned a non-JSON response",
                sending=sending,
                provenance=provenance,
            ) from exc
        if not isinstance(decoded, dict):
            raise self._invalid_response(
                "SuperLanguage returned JSON that is not an object",
                sending=sending,
                provenance=provenance,
            )
        return decoded, provenance

    def health(self) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self.request_json("GET", "/api/health")

    def status(self) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self.request_json("GET", "/api/status")

    def get_job(
        self, job_id: str, *, max_timeout_seconds: Optional[float] = None
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self.request_json(
            "GET",
            f"/api/jobs/{urllib.parse.quote(job_id, safe='')}",
            max_timeout_seconds=max_timeout_seconds,
        )

    def send_message(
        self, payload: Dict[str, Any]
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self.request_json(
            "POST", "/api/send-message", payload, sending=True
        )

    def send_attachments(
        self, payload: Dict[str, Any]
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self.request_json(
            "POST", "/api/send-attachments", payload, sending=True
        )


def _reject_unknown(arguments: Mapping[str, Any], allowed: set[str]) -> None:
    unknown = sorted(set(arguments) - allowed)
    if unknown:
        raise ToolArgumentError(
            {name: "Unexpected argument" for name in unknown},
            "Unknown tool argument(s): " + ", ".join(unknown),
        )


def _string_argument(
    arguments: Mapping[str, Any],
    name: str,
    *,
    required: bool,
    max_units: Optional[int] = None,
    allow_empty: bool = False,
) -> Optional[str]:
    if name not in arguments:
        if required:
            raise ToolArgumentError({name: "Required argument is missing"})
        return None
    value = arguments[name]
    if not isinstance(value, str):
        raise ToolArgumentError({name: "Must be a string"})
    if not allow_empty and not value.strip():
        raise ToolArgumentError({name: "Must not be empty or whitespace-only"})
    if "\x00" in value:
        raise ToolArgumentError({name: "Must not contain NUL characters"})
    if not _is_encodable(value):
        raise ToolArgumentError({name: "Must not contain unpaired surrogates"})
    if max_units is not None and _utf16_units(value) > max_units:
        raise ToolArgumentError(
            {name: f"Must be at most {max_units} UTF-16 code units"}
        )
    return value


def _validate_target(arguments: Mapping[str, Any]) -> str:
    target = _string_argument(
        arguments, "target", required=True, max_units=MAX_TARGET_UTF16_UNITS
    )
    assert target is not None
    if any(ord(char) < 0x20 for char in target):
        raise ToolArgumentError(
            {"target": "Must not contain control characters or newlines"}
        )
    return target


def _validate_send_message(arguments: Mapping[str, Any]) -> Dict[str, Any]:
    allowed = {
        "target",
        "message",
        "mention",
        "mention_separator",
        "mention_newline",
    }
    _reject_unknown(arguments, allowed)
    target = _validate_target(arguments)
    message = _string_argument(
        arguments, "message", required=True, max_units=MAX_MESSAGE_UTF16_UNITS
    )
    assert message is not None
    if any(ord(char) < 0x20 and char not in "\n\r\t" for char in message):
        raise ToolArgumentError(
            {"message": "May contain tabs/newlines but no other control characters"}
        )

    mention = _string_argument(
        arguments,
        "mention",
        required=False,
        max_units=MAX_MENTION_UTF16_UNITS,
        allow_empty=True,
    )
    if mention is not None and mention and not mention.strip():
        raise ToolArgumentError(
            {"mention": "Must be empty or contain a visible member name"}
        )
    separator = _string_argument(
        arguments, "mention_separator", required=False, allow_empty=False
    )
    if separator is not None and separator not in {"space", "newline"}:
        raise ToolArgumentError(
            {"mention_separator": "Must be 'space' or 'newline'"}
        )

    mention_newline: Optional[bool] = None
    if "mention_newline" in arguments:
        raw_newline = arguments["mention_newline"]
        if not isinstance(raw_newline, bool):
            raise ToolArgumentError({"mention_newline": "Must be a boolean"})
        mention_newline = raw_newline

    if separator is not None and mention_newline is not None:
        separator_newline = separator == "newline"
        if separator_newline != mention_newline:
            raise ToolArgumentError(
                {
                    "mention_newline": (
                        "Conflicts with mention_separator; provide only one "
                        "or make them agree"
                    )
                }
            )

    payload: Dict[str, Any] = {"target": target, "message": message}
    if mention not in (None, ""):
        payload["mention"] = mention
    if separator is not None:
        payload["mention_separator"] = separator
    if mention_newline is not None:
        payload["mention_newline"] = mention_newline
    return payload


def _string_list(
    arguments: Mapping[str, Any],
    name: str,
    *,
    validator,
    item_hint: str,
) -> list[str]:
    if name not in arguments:
        return []
    raw = arguments[name]
    if not isinstance(raw, list):
        raise ToolArgumentError({name: "Must be an array of strings"})
    if not 1 <= len(raw) <= MAX_ATTACHMENTS:
        raise ToolArgumentError(
            {name: f"Must contain between 1 and {MAX_ATTACHMENTS} items"}
        )
    result: list[str] = []
    for index, value in enumerate(raw):
        if not isinstance(value, str) or not value.strip():
            raise ToolArgumentError(
                {name: f"Item {index} must be a non-empty string ({item_hint})"}
            )
        if "\x00" in value:
            raise ToolArgumentError({name: f"Item {index} contains a NUL character"})
        if not _is_encodable(value):
            raise ToolArgumentError(
                {name: f"Item {index} contains an unpaired surrogate"}
            )
        if not validator(value):
            raise ToolArgumentError({name: f"Item {index} {item_hint}"})
        result.append(value)
    return result


def _valid_local_path(value: str) -> bool:
    if ";" in value:
        return False
    if any(ord(char) < 0x20 for char in value):
        return False
    return bool(re.match(r"^(?:[A-Za-z]:[\\/]|\\\\)", value))


def _valid_resource_id(value: str) -> bool:
    return RESOURCE_ID_RE.fullmatch(value) is not None


def _validate_send_attachments(arguments: Mapping[str, Any]) -> Dict[str, Any]:
    allowed = {"target", "attachments", "resource_ids", "resources"}
    _reject_unknown(arguments, allowed)
    target = _validate_target(arguments)

    has_attachments = "attachments" in arguments
    has_resource_ids = "resource_ids" in arguments
    has_resources = "resources" in arguments
    if has_resource_ids and has_resources:
        raise ToolArgumentError(
            {"resources": "Use either resource_ids or resources, not both"}
        )
    if has_attachments and (has_resource_ids or has_resources):
        raise ToolArgumentError(
            {
                "attachments": (
                    "attachments and resource_ids/resources are mutually exclusive"
                )
            }
        )
    if not has_attachments and not has_resource_ids and not has_resources:
        raise ToolArgumentError(
            {
                "attachments": (
                    "Provide attachments, resource_ids, or resources"
                )
            }
        )

    payload: Dict[str, Any] = {"target": target}
    if has_attachments:
        paths = _string_list(
            arguments,
            "attachments",
            validator=_valid_local_path,
            item_hint="must be a path without ';' or control characters",
        )
        joined = ";".join(paths)
        if _utf16_units(joined) > MAX_ATTACHMENT_PATHS_UTF16_UNITS:
            raise ToolArgumentError(
                {
                    "attachments": (
                        "Joined paths are too long for SuperLanguage "
                        f"(max {MAX_ATTACHMENT_PATHS_UTF16_UNITS} UTF-16 code units)"
                    )
                }
            )
        payload["attachments"] = joined
        return payload

    key = "resource_ids" if has_resource_ids else "resources"
    resource_ids = _string_list(
        arguments,
        key,
        validator=_valid_resource_id,
        item_hint="must be a 40-character lowercase hexadecimal resource id",
    )
    joined = ";".join(resource_ids)
    if _utf16_units(joined) > MAX_RESOURCE_IDS_UTF16_UNITS:
        raise ToolArgumentError({key: "Joined resource ids are too long"})
    payload["resource_ids"] = joined
    return payload


def _validate_get_job(arguments: Mapping[str, Any]) -> Dict[str, Any]:
    _reject_unknown(arguments, {"job_id"})
    job_id = _string_argument(
        arguments, "job_id", required=True, max_units=16
    )
    assert job_id is not None
    if not JOB_ID_RE.fullmatch(job_id):
        raise ToolArgumentError(
            {"job_id": "Must be 1-16 hexadecimal characters"}
        )
    return {"job_id": job_id}


def _number_argument(
    arguments: Mapping[str, Any],
    name: str,
    *,
    default: float,
    minimum: float,
    maximum: float,
) -> float:
    if name not in arguments:
        return default
    value = arguments[name]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ToolArgumentError({name: "Must be a number"})
    number = float(value)
    if not minimum <= number <= maximum:
        raise ToolArgumentError(
            {name: f"Must be between {minimum:g} and {maximum:g}"}
        )
    return number


def _validate_wait_job(
    arguments: Mapping[str, Any],
) -> tuple[str, float, float]:
    _reject_unknown(
        arguments, {"job_id", "timeout_seconds", "poll_interval_seconds"}
    )
    job_id = _string_argument(
        arguments, "job_id", required=True, max_units=16
    )
    assert job_id is not None
    if not JOB_ID_RE.fullmatch(job_id):
        raise ToolArgumentError(
            {"job_id": "Must be 1-16 hexadecimal characters"}
        )
    timeout_seconds = _number_argument(
        arguments,
        "timeout_seconds",
        default=30.0,
        minimum=0.0,
        maximum=120.0,
    )
    poll_interval_seconds = _number_argument(
        arguments,
        "poll_interval_seconds",
        default=1.0,
        minimum=0.05,
        maximum=10.0,
    )
    return job_id, timeout_seconds, poll_interval_seconds


def _validate_no_arguments(arguments: Mapping[str, Any]) -> Dict[str, Any]:
    _reject_unknown(arguments, set())
    return {}


TOOLS = [
    {
        "name": "health",
        "title": "SuperLanguage API Health",
        "description": (
            "Read SuperLanguage's API health, version, API revision, and active port. "
            "This is read-only and does not send a message."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "status",
        "title": "SuperLanguage Queue and WeChat Status",
        "description": (
            "Read SuperLanguage queue counts, mouse guard state, and WeChat running/"
            "login/window state. This is read-only."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "send_message",
        "title": "Queue WeChat Text Message",
        "description": (
            "Queue a text message in SuperLanguage for eventual delivery to a WeChat "
            "contact/group. This can result in a real, irreversible WeChat "
            "message. The response only confirms queueing, not delivery. Never "
            "retry after a timeout or delivery_uncertain=true; inspect the "
            "conversation and ask the user first."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MAX_TARGET_UTF16_UNITS,
                    "description": "WeChat contact or group name to search for.",
                },
                "message": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MAX_MESSAGE_UTF16_UNITS,
                    "description": "Message text to queue.",
                },
                "mention": {
                    "type": "string",
                    "maxLength": MAX_MENTION_UTF16_UNITS,
                    "description": "Optional group member to @-mention.",
                },
                "mention_separator": {
                    "type": "string",
                    "enum": ["space", "newline"],
                    "description": "Separator between the @-mention and message.",
                },
                "mention_newline": {
                    "type": "boolean",
                    "description": (
                        "Alias for mention_separator: true = newline, false = space."
                    ),
                },
            },
            "required": ["target", "message"],
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": False,
            "destructiveHint": True,
            "idempotentHint": False,
            "openWorldHint": True,
        },
    },
    {
        "name": "send_attachments",
        "title": "Queue WeChat Attachments",
        "description": (
            "Queue up to 9 local file paths or SuperLanguage resource IDs for "
            "eventual "
            "delivery to a WeChat contact/group. This can result in real, "
            "irreversible WeChat activity. Prefer resource_ids; local paths only "
            "work when SuperLanguage is bound to loopback and are resolved on the "
            "SuperLanguage host. The response only confirms queueing, not delivery."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": MAX_TARGET_UTF16_UNITS,
                    "description": "WeChat contact or group name to search for.",
                },
                "attachments": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_ATTACHMENTS,
                    "items": {"type": "string", "minLength": 1},
                    "description": (
                        "Absolute Windows or UNC paths on the SuperLanguage host. "
                        "Mutually exclusive with resource_ids/resources. "
                        "Paths must not contain ';'."
                    ),
                },
                "resource_ids": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_ATTACHMENTS,
                    "items": {
                        "type": "string",
                        "pattern": "^[0-9a-f]{40}$",
                    },
                    "description": (
                        "Uploaded SuperLanguage resource IDs. Mutually exclusive with "
                        "attachments and resources."
                    ),
                },
                "resources": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_ATTACHMENTS,
                    "items": {
                        "type": "string",
                        "pattern": "^[0-9a-f]{40}$",
                    },
                    "description": "Alias for resource_ids; provide only one.",
                },
            },
            "required": ["target"],
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": False,
            "destructiveHint": True,
            "idempotentHint": False,
            "openWorldHint": True,
        },
    },
    {
        "name": "get_job",
        "title": "Inspect SuperLanguage Job",
        "description": (
            "Read one queued/sent job by id. If delivery_uncertain=true, the "
            "send may already have happened: do NOT automatically resend. "
            "Verify the target conversation and ask the user first."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": {
                    "type": "string",
                    "pattern": "^[0-9A-Fa-f]{1,16}$",
                    "description": "Job id returned by a send tool.",
                }
            },
            "required": ["job_id"],
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "wait_job",
        "title": "Wait for SuperLanguage Job",
        "description": (
            "Poll one SuperLanguage job until it reaches succeeded/failed, becomes "
            "delivery_uncertain, or a short timeout expires. Read-only. If "
            "delivery_uncertain=true, do NOT automatically resend."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": {
                    "type": "string",
                    "pattern": "^[0-9A-Fa-f]{1,16}$",
                    "description": "Job id returned by a send tool.",
                },
                "timeout_seconds": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 120,
                    "default": 30,
                    "description": "Maximum time to wait; 0 performs one poll.",
                },
                "poll_interval_seconds": {
                    "type": "number",
                    "minimum": 0.05,
                    "maximum": 10,
                    "default": 1,
                    "description": "Delay between job queries.",
                },
            },
            "required": ["job_id"],
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
]

TOOL_BY_NAME = {tool["name"]: tool for tool in TOOLS}
SEND_TOOLS = {"send_message", "send_attachments"}


def _json_text(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False)


def _tool_result(payload: Dict[str, Any], *, is_error: bool) -> Dict[str, Any]:
    return {
        "content": [{"type": "text", "text": _json_text(payload)}],
        "structuredContent": payload,
        "isError": is_error,
    }


def _validation_payload(error: ToolArgumentError) -> Dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "kind": "validation_error",
            "message": str(error),
            "fields": error.fields,
            "http_status": None,
            "delivery_uncertain": False,
            "safe_to_retry": True,
            "retryable": True,
        },
        "retry_policy": "fix_arguments_then_retry",
        "hint": "No HTTP request was sent to SuperLanguage.",
    }


def _config_error_payload(error: ConfigError) -> Dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "kind": "config_error",
            "message": str(error),
            "http_status": None,
            "delivery_uncertain": False,
            "safe_to_retry": True,
            "retryable": True,
        },
        "retry_policy": "fix_configuration_then_retry",
        "hint": "No HTTP request was sent to SuperLanguage.",
    }


def _api_error_payload(error: SuperTimeAPIError, tool: str) -> Dict[str, Any]:
    error_object: Dict[str, Any] = {
        "kind": error.kind,
        "message": error.message,
        "http_status": error.http_status,
        "delivery_uncertain": error.delivery_uncertain,
        "safe_to_retry": error.safe_to_retry,
        "retryable": error.retryable,
    }
    if error.hint:
        error_object["hint"] = error.hint
    payload: Dict[str, Any] = {
        "ok": False,
        "tool": tool,
        "error": error_object,
        "retry_policy": (
            "do_not_automatically_retry"
            if error.delivery_uncertain
            else "follow_error_guidance"
        ),
    }
    if error.delivery_uncertain:
        payload["warning"] = UNCERTAIN_WARNING
    if error.provenance:
        payload["provenance"] = error.provenance
    return payload


def _queued_success(
    tool: str,
    response: Dict[str, Any],
    provenance: Dict[str, Any],
) -> Dict[str, Any]:
    job_id = response.get("id")
    state = response.get("state")
    if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
        error = SuperTimeAPIError(
            "invalid_response",
            "SuperLanguage returned a 2xx send response without a valid job id",
            retryable=False,
            safe_to_retry=False,
            delivery_uncertain=True,
            hint=UNCERTAIN_WARNING,
            provenance=provenance,
        )
        raise error
    if state != "queued":
        LOGGER.warning("Unexpected send state from SuperLanguage: %r", state)

    return {
        "ok": True,
        "tool": tool,
        "job_id": job_id,
        "state": state if isinstance(state, str) else "unknown",
        "delivery_status": "queued_not_delivered",
        "delivery_confirmed": False,
        "delivery_uncertain": False,
        "safe_to_retry": False,
        "retry_policy": "do_not_automatically_retry",
        "warning": QUEUED_WARNING,
        "next_step": (
            f"Call get_job with job_id {job_id}. If delivery_uncertain becomes "
            "true, stop and ask the user after checking the conversation."
        ),
        "supertime_response": response,
        "provenance": provenance,
    }


def _job_success(
    response: Dict[str, Any],
    provenance: Dict[str, Any],
) -> Dict[str, Any]:
    state = response.get("state")
    attempted = response.get("delivery_attempted")
    uncertain = response.get("delivery_uncertain")
    if isinstance(uncertain, bool):
        observed_uncertain: Optional[bool] = uncertain
    else:
        observed_uncertain = None

    safe_to_retry = (
        state == "failed"
        and attempted is False
        and observed_uncertain is False
    )
    if observed_uncertain is True:
        warning = UNCERTAIN_WARNING
        retry_policy = "do_not_automatically_retry"
    elif observed_uncertain is None:
        warning = (
            "SuperLanguage did not report delivery_uncertain. Do not automatically "
            "retry; inspect the target conversation first."
        )
        retry_policy = "do_not_retry_without_manual_check"
    elif state in {"queued", "running"}:
        warning = (
            "The job is still queued or running. Do not submit a duplicate; "
            "poll again with get_job."
        )
        retry_policy = "wait_and_poll"
    elif safe_to_retry:
        warning = (
            "SuperLanguage reports that delivery was not attempted and the job failed. "
            "A manual resubmission may be possible after fixing the cause, but "
            "do not retry automatically."
        )
        retry_policy = "manual_retry_after_fixing_cause"
    else:
        warning = (
            "Do not automatically resend this job. Inspect the SuperLanguage state and "
            "the target conversation before deciding whether to submit again."
        )
        retry_policy = "do_not_automatically_retry"

    return {
        "ok": True,
        "tool": "get_job",
        "job": response,
        "delivery_uncertain": observed_uncertain,
        "safe_to_retry": safe_to_retry,
        "retry_policy": retry_policy,
        "warning": warning,
        "provenance": provenance,
    }


def _wait_job_success(
    response: Dict[str, Any],
    provenance: Dict[str, Any],
    *,
    timeout_seconds: float,
    poll_interval_seconds: float,
    polls: int,
    elapsed_seconds: float,
) -> Dict[str, Any]:
    payload = _job_success(response, provenance)
    payload["tool"] = "wait_job"
    state = response.get("state")
    uncertain = response.get("delivery_uncertain")
    terminal = state in {"succeeded", "failed"} or uncertain is True
    payload["completed"] = terminal
    payload["timed_out"] = not terminal
    payload["polls"] = polls
    payload["waited_seconds"] = round(elapsed_seconds, 3)
    payload["timeout_seconds"] = timeout_seconds
    payload["poll_interval_seconds"] = poll_interval_seconds
    if not terminal:
        payload["retry_policy"] = "wait_and_poll"
        payload["safe_to_retry"] = False
        payload["warning"] = (
            f"wait_job timed out after {elapsed_seconds:.2f}s while the job "
            f"remained in state {state!r}. The job may still be running; do NOT "
            "submit a duplicate. Call get_job or wait_job again. If "
            "delivery_uncertain becomes true, stop and ask the user."
        )
    return payload


class SuperTimeMCPServer:
    """JSON-RPC 2.0 / MCP stdio server."""

    def __init__(self, client: Optional[SuperTimeClient] = None):
        self.client = client or SuperTimeClient()
        self.negotiated_protocol = LATEST_PROTOCOL
        self.initialized = False

    @staticmethod
    def _response(request_id: Any, result: Dict[str, Any]) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    @staticmethod
    def _error(
        request_id: Any,
        code: int,
        message: str,
        data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        error: Dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        return {"jsonrpc": "2.0", "id": request_id, "error": error}

    def _execute_tool(
        self, name: str, arguments: Dict[str, Any]
    ) -> Dict[str, Any]:
        is_error = False
        try:
            if name == "health":
                _validate_no_arguments(arguments)
                data, provenance = self.client.health()
                payload = {
                    "ok": True,
                    "tool": name,
                    "data": data,
                    "provenance": provenance,
                }
            elif name == "status":
                _validate_no_arguments(arguments)
                data, provenance = self.client.status()
                payload = {
                    "ok": True,
                    "tool": name,
                    "data": data,
                    "provenance": provenance,
                }
            elif name == "send_message":
                body = _validate_send_message(arguments)
                data, provenance = self.client.send_message(body)
                payload = _queued_success(name, data, provenance)
            elif name == "send_attachments":
                body = _validate_send_attachments(arguments)
                data, provenance = self.client.send_attachments(body)
                payload = _queued_success(name, data, provenance)
            elif name == "get_job":
                body = _validate_get_job(arguments)
                data, provenance = self.client.get_job(body["job_id"])
                payload = _job_success(data, provenance)
            elif name == "wait_job":
                job_id, timeout_seconds, poll_interval_seconds = _validate_wait_job(
                    arguments
                )
                started = time.monotonic()
                deadline = started + timeout_seconds
                polls = 0
                while True:
                    remaining = max(0.0, deadline - time.monotonic())
                    data, provenance = self.client.get_job(
                        job_id,
                        max_timeout_seconds=max(
                            WAIT_JOB_MIN_HTTP_TIMEOUT_SECONDS, remaining
                        ),
                    )
                    polls += 1
                    state = data.get("state")
                    uncertain = data.get("delivery_uncertain")
                    terminal = state in {"succeeded", "failed"} or uncertain is True
                    elapsed = time.monotonic() - started
                    if terminal or elapsed >= timeout_seconds:
                        payload = _wait_job_success(
                            data,
                            provenance,
                            timeout_seconds=timeout_seconds,
                            poll_interval_seconds=poll_interval_seconds,
                            polls=polls,
                            elapsed_seconds=elapsed,
                        )
                        break
                    time.sleep(
                        min(
                            poll_interval_seconds,
                            max(0.0, deadline - time.monotonic()),
                        )
                    )
            else:
                raise AssertionError(f"unreachable tool: {name}")
        except ToolArgumentError as exc:
            payload = _validation_payload(exc)
            is_error = True
        except ConfigError as exc:
            payload = _config_error_payload(exc)
            is_error = True
        except SuperTimeAPIError as exc:
            payload = _api_error_payload(exc, name)
            is_error = True
        except Exception:
            LOGGER.exception("Unexpected tool execution failure for %s", name)
            uncertain = name in SEND_TOOLS
            payload = {
                "ok": False,
                "tool": name,
                "error": {
                    "kind": "internal_error",
                    "message": "Internal MCP server error",
                    "http_status": None,
                    "delivery_uncertain": uncertain,
                    "safe_to_retry": not uncertain,
                    "retryable": False,
                },
                "retry_policy": (
                    "do_not_automatically_retry"
                    if uncertain
                    else "investigate_internal_error"
                ),
            }
            if uncertain:
                payload["warning"] = UNCERTAIN_WARNING
            is_error = True
        return _tool_result(payload, is_error=is_error)

    def _handle_initialize(
        self, request_id: Any, params: Dict[str, Any]
    ) -> Dict[str, Any]:
        requested = params.get("protocolVersion")
        if not isinstance(requested, str):
            return self._error(
                request_id,
                -32602,
                "initialize requires a string protocolVersion",
            )
        self.negotiated_protocol = (
            requested if requested in SUPPORTED_PROTOCOLS else LATEST_PROTOCOL
        )
        return self._response(
            request_id,
            {
                "protocolVersion": self.negotiated_protocol,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {
                    "name": SERVER_NAME,
                    "title": "SuperLanguage WeChat MCP",
                    "version": SERVER_VERSION,
                },
                "instructions": (
                    "SuperLanguage queues Windows WeChat automation jobs. Sending is "
                    "irreversible. A queued response is not proof of delivery. "
                    "Poll get_job and never automatically resend when "
                    "delivery_uncertain=true or an enqueue response is ambiguous."
                ),
            },
        )

    def _handle_request(
        self, message: Dict[str, Any], *, notification: bool
    ) -> Optional[Dict[str, Any]]:
        request_id = message.get("id")
        method = message.get("method")
        if not isinstance(method, str) or not method:
            if notification:
                return None
            return self._error(request_id, -32600, "Invalid Request: method is required")

        if method == "notifications/initialized":
            self.initialized = True
            if notification:
                return None
            return self._response(request_id, {})
        if method == "ping":
            if notification:
                return None
            return self._response(request_id, {})
        if method == "initialize":
            if notification:
                return None
            params = message.get("params", {})
            if not isinstance(params, dict):
                return self._error(request_id, -32602, "initialize params must be an object")
            return self._handle_initialize(request_id, params)
        if method == "tools/list":
            if notification:
                return None
            params = message.get("params", {})
            if not isinstance(params, dict):
                return self._error(request_id, -32602, "tools/list params must be an object")
            return self._response(
                request_id,
                {"tools": TOOLS},
            )
        if method == "tools/call":
            if notification:
                return None
            params = message.get("params")
            if not isinstance(params, dict):
                return self._error(request_id, -32602, "tools/call params must be an object")
            name = params.get("name")
            if not isinstance(name, str) or not name:
                return self._error(
                    request_id, -32602, "tools/call requires a non-empty tool name"
                )
            if name not in TOOL_BY_NAME:
                return self._error(
                    request_id,
                    -32602,
                    f"Unknown tool: {name}",
                    {"tool": name},
                )
            arguments = params.get("arguments", {})
            if arguments is None:
                arguments = {}
            if not isinstance(arguments, dict):
                return self._error(
                    request_id, -32602, "tools/call arguments must be an object"
                )
            return self._response(
                request_id,
                self._execute_tool(name, arguments),
            )

        if notification:
            return None
        return self._error(
            request_id,
            -32601,
            f"Method not found: {method}",
            {"method": method},
        )

    def handle(self, payload: Any) -> Optional[Any]:
        if isinstance(payload, list):
            if self.negotiated_protocol not in BATCH_PROTOCOLS:
                return self._error(
                    None,
                    -32600,
                    "Invalid Request: JSON-RPC batches are not supported in "
                    f"protocol {self.negotiated_protocol}",
                )
            if not payload:
                return self._error(None, -32600, "Invalid Request: empty batch")
            responses = []
            for item in payload:
                if not isinstance(item, dict):
                    responses.append(self._error(None, -32600, "Invalid Request"))
                    continue
                if item.get("jsonrpc") != "2.0":
                    responses.append(
                        self._error(
                            item.get("id"),
                            -32600,
                            "Invalid Request: jsonrpc must be '2.0'",
                        )
                    )
                    continue
                notification = "id" not in item
                response = self._handle_request(item, notification=notification)
                if response is not None:
                    responses.append(response)
            return responses or None

        if not isinstance(payload, dict):
            return self._error(None, -32600, "Invalid Request")
        if payload.get("jsonrpc") != "2.0":
            return self._error(
                payload.get("id"),
                -32600,
                "Invalid Request: jsonrpc must be '2.0'",
            )
        notification = "id" not in payload
        return self._handle_request(payload, notification=notification)

    def serve(
        self,
        stdin: Optional[BinaryIO] = None,
        stdout: Optional[BinaryIO] = None,
    ) -> None:
        input_stream = stdin or sys.stdin.buffer
        output_stream = stdout or sys.stdout.buffer

        while True:
            try:
                raw_line = input_stream.readline(MAX_STDIO_MESSAGE_BYTES + 1)
            except KeyboardInterrupt:
                raise
            except OSError:
                LOGGER.exception("Failed to read MCP stdio input")
                break
            if not raw_line:
                break
            if len(raw_line) > MAX_STDIO_MESSAGE_BYTES and not raw_line.endswith(b"\n"):
                # Drain the remainder. Returning one parse error is enough.
                while True:
                    remainder = input_stream.readline(MAX_STDIO_MESSAGE_BYTES + 1)
                    if not remainder or remainder.endswith(b"\n"):
                        break
                response: Any = self._error(
                    None,
                    -32700,
                    "Parse error: message exceeds 4 MiB",
                )
            else:
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                try:
                    decoded = raw_line.decode("utf-8")
                    payload = json.loads(decoded)
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    response = self._error(
                        None,
                        -32700,
                        "Parse error",
                        {"detail": str(exc)},
                    )
                else:
                    try:
                        response = self.handle(payload)
                    except Exception:
                        LOGGER.exception("Unhandled MCP request failure")
                        request_id = payload.get("id") if isinstance(payload, dict) else None
                        response = self._error(
                            request_id,
                            -32603,
                            "Internal error",
                        )

            if response is None:
                continue
            try:
                encoded = json.dumps(
                    response,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode("utf-8")
                output_stream.write(encoded + b"\n")
                output_stream.flush()
            except (BrokenPipeError, OSError):
                break


def _configure_logging() -> None:
    level_name = (os.environ.get("SUPERTIME_MCP_LOG") or "WARNING").upper()
    level = getattr(logging, level_name, logging.WARNING)
    logging.basicConfig(
        stream=sys.stderr,
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def main() -> int:
    _configure_logging()
    server = SuperTimeMCPServer()
    try:
        server.serve()
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
