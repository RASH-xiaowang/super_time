#!/usr/bin/env python3
"""Offline tests for the SuperLanguage MCP server.

All HTTP traffic is handled by a local fake SuperLanguage server. No WeChat
message or real SuperLanguage instance is used.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional


MCP_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = MCP_DIR.parent
SCRIPT = MCP_DIR / "supertime_mcp.py"
sys.path.insert(0, str(MCP_DIR))

import supertime_mcp  # noqa: E402


TOKEN = "0123456789abcdef0123456789abcdef"
OTHER_TOKEN = "fedcba9876543210fedcba9876543210"


class FakeSuperLanguageHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    @property
    def app(self) -> "FakeSuperLanguageServer":
        return self.server.app  # type: ignore[attr-defined,no-any-return]

    def _send_json(self, status: int, payload: Dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        if self.headers.get("Authorization") == f"Bearer {self.app.token}":
            return True
        self._send_json(401, {"message": "unauthorized"})
        return False

    def do_GET(self) -> None:
        self.app.requests.append(
            {"method": "GET", "path": self.path, "body": None}
        )
        if not self._authorized():
            return
        if self.path == "/api/health":
            if self.app.health_malformed:
                raw = b"not-json"
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(raw)
                return
            self._send_json(
                200,
                {
                    "ok": True,
                    "port": self.app.server_port,
                    "version": "1.0.0-test",
                    "api": 6,
                    "webhook": True,
                },
            )
            return
        if self.path == "/api/status":
            self._send_json(
                200,
                {
                    "version": "1.0.0-test",
                    "api": 6,
                    "queue": {
                        "queued": 1,
                        "running": 0,
                        "succeeded": 2,
                        "failed": 0,
                    },
                    "mouse_guard": {
                        "active": False,
                        "aborted": False,
                        "timeout_ms": 45000,
                    },
                    "wechat": {
                        "running": True,
                        "logged_in": True,
                        "window_visible": True,
                    },
                },
            )
            return
        if self.path.startswith("/api/jobs/"):
            job_id = self.path.rsplit("/", 1)[-1]
            if job_id in self.app.jobs:
                self._send_json(200, self.app.jobs[job_id])
            else:
                self._send_json(404, {"message": "job not found"})
            return
        self._send_json(404, {"message": "not found"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            body = None
        self.app.requests.append(
            {"method": "POST", "path": self.path, "body": body}
        )
        if not self._authorized():
            return

        if self.path == "/api/send-message":
            if self.app.send_status != 202:
                self._send_json(
                    self.app.send_status,
                    {"message": self.app.send_error_message},
                )
                return
            self._send_json(
                self.app.send_status,
                {"id": "abc123", "state": "queued"},
            )
            return
        if self.path == "/api/send-attachments":
            if self.app.attachments_status != 202:
                self._send_json(
                    self.app.attachments_status,
                    {"message": self.app.attachments_error_message},
                )
                return
            self._send_json(
                self.app.attachments_status,
                {"id": "def456", "state": "queued"},
            )
            return
        self._send_json(404, {"message": "not found"})


class FakeSuperLanguageServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), FakeSuperLanguageHandler)
        self.app = self
        self.token = TOKEN
        self.requests: List[Dict[str, Any]] = []
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self.health_malformed = False
        self.send_status = 202
        self.send_error_message = "send failed"
        self.attachments_status = 202
        self.attachments_error_message = "attachments failed"
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server_port}"

    def reset(self) -> None:
        self.requests = []
        self.jobs = {
            "abc123": {
                "id": "abc123",
                "type": "message",
                "state": "succeeded",
                "content_verified": True,
                "sent_count": 1,
                "mention_newline": False,
                "error": 0,
                "delivery_attempted": True,
                "delivery_uncertain": False,
            },
            "badc0ffee": {
                "id": "badc0ffee",
                "type": "message",
                "state": "failed",
                "content_verified": False,
                "sent_count": 0,
                "mention_newline": False,
                "error": 5,
                "delivery_attempted": True,
                "delivery_uncertain": True,
            },
            "cafe1234": {
                "id": "cafe1234",
                "type": "message",
                "state": "queued",
                "content_verified": False,
                "sent_count": 0,
                "mention_newline": False,
                "error": 0,
                "delivery_attempted": False,
                "delivery_uncertain": False,
            },
        }
        self.health_malformed = False
        self.send_status = 202
        self.attachments_status = 202

    def stop(self) -> None:
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=5)


class RaisingOpener:
    def open(self, request: Any, timeout: float) -> Any:
        raise urllib.error.URLError("connection refused")


class RecordingOpener:
    def __init__(self, fail_with: Optional[BaseException] = None) -> None:
        self.timeouts: List[float] = []
        self.fail_with = fail_with
        self._inner = supertime_mcp._default_opener()

    def open(self, request: Any, timeout: float) -> Any:
        self.timeouts.append(timeout)
        if self.fail_with is not None:
            raise self.fail_with
        return self._inner.open(request, timeout=timeout)


def make_server(
    base_url: str,
    token: str = TOKEN,
    *,
    opener: Optional[Any] = None,
    extra_env: Optional[Dict[str, str]] = None,
) -> supertime_mcp.SuperTimeMCPServer:
    env = {"SUPERTIME_API_URL": base_url, "SUPERTIME_API_TOKEN": token}
    env.update(extra_env or {})
    resolver = supertime_mcp.ConfigResolver(
        env=env,
        server_dir=MCP_DIR,
        cwd=MCP_DIR,
    )
    client = supertime_mcp.SuperTimeClient(resolver=resolver, opener=opener)
    return supertime_mcp.SuperTimeMCPServer(client=client)


def rpc(
    server: supertime_mcp.SuperTimeMCPServer,
    request_id: Any,
    method: str,
    params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    message: Dict[str, Any] = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
    }
    if params is not None:
        message["params"] = params
    response = server.handle(message)
    assert isinstance(response, dict)
    return response


def call_tool(
    server: supertime_mcp.SuperTimeMCPServer,
    name: str,
    arguments: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    response = rpc(
        server,
        99,
        "tools/call",
        {"name": name, "arguments": arguments if arguments is not None else {}},
    )
    return response["result"]


class FakeAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fake = FakeSuperLanguageServer()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fake.stop()

    def setUp(self) -> None:
        self.fake.reset()

    def test_health_and_status_read_only(self) -> None:
        server = make_server(self.fake.base_url)
        health = call_tool(server, "health")
        self.assertFalse(health["isError"])
        self.assertTrue(health["structuredContent"]["ok"])
        self.assertEqual(
            health["structuredContent"]["data"]["version"], "1.0.0-test"
        )

        status = call_tool(server, "status")
        self.assertFalse(status["isError"])
        self.assertEqual(
            status["structuredContent"]["data"]["queue"]["queued"], 1
        )
        self.assertEqual(
            [request["path"] for request in self.fake.requests],
            ["/api/health", "/api/status"],
        )

    def test_send_message_queues_and_warns_not_delivered(self) -> None:
        server = make_server(self.fake.base_url)
        result = call_tool(
            server,
            "send_message",
            {
                "target": "测试群",
                "message": "hello",
                "mention": "alice",
                "mention_separator": "newline",
            },
        )
        payload = result["structuredContent"]
        self.assertFalse(result["isError"])
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["job_id"], "abc123")
        self.assertEqual(payload["delivery_status"], "queued_not_delivered")
        self.assertFalse(payload["delivery_confirmed"])
        self.assertFalse(payload["safe_to_retry"])
        self.assertIn("delivery_uncertain", payload["warning"])
        self.assertEqual(len(self.fake.requests), 1)
        self.assertEqual(self.fake.requests[0]["path"], "/api/send-message")
        self.assertEqual(
            self.fake.requests[0]["body"],
            {
                "target": "测试群",
                "message": "hello",
                "mention": "alice",
                "mention_separator": "newline",
            },
        )

    def test_send_attachments_resource_ids_are_joined(self) -> None:
        server = make_server(self.fake.base_url)
        resource_a = "a" * 40
        resource_b = "b" * 40
        result = call_tool(
            server,
            "send_attachments",
            {"target": "alice", "resource_ids": [resource_a, resource_b]},
        )
        self.assertFalse(result["isError"])
        self.assertEqual(
            self.fake.requests[0]["body"],
            {
                "target": "alice",
                "resource_ids": f"{resource_a};{resource_b}",
            },
        )

    def test_send_attachments_local_paths_require_absolute_join(self) -> None:
        server = make_server(self.fake.base_url)
        result = call_tool(
            server,
            "send_attachments",
            {
                "target": "alice",
                "attachments": [r"C:\work\a.txt", r"D:\work\b.txt"],
            },
        )
        self.assertFalse(result["isError"])
        self.assertEqual(
            self.fake.requests[0]["body"],
            {
                "target": "alice",
                "attachments": r"C:\work\a.txt;D:\work\b.txt",
            },
        )

        relative = call_tool(
            server,
            "send_attachments",
            {"target": "alice", "attachments": ["relative.txt"]},
        )
        self.assertTrue(relative["isError"])
        self.assertIn(
            "attachments", relative["structuredContent"]["error"]["fields"]
        )

    def test_get_job_success_and_uncertain_blocks_retry(self) -> None:
        server = make_server(self.fake.base_url)
        success = call_tool(server, "get_job", {"job_id": "abc123"})
        self.assertFalse(success["isError"])
        self.assertFalse(success["structuredContent"]["delivery_uncertain"])
        self.assertFalse(success["structuredContent"]["safe_to_retry"])

        uncertain = call_tool(server, "get_job", {"job_id": "badc0ffee"})
        payload = uncertain["structuredContent"]
        self.assertFalse(uncertain["isError"])
        self.assertTrue(payload["delivery_uncertain"])
        self.assertFalse(payload["safe_to_retry"])
        self.assertEqual(payload["retry_policy"], "do_not_automatically_retry")
        self.assertIn("Do NOT resend", payload["warning"])

    def test_wait_job_terminal_uncertain_and_timeout(self) -> None:
        server = make_server(self.fake.base_url)
        success = call_tool(
            server, "wait_job", {"job_id": "abc123", "timeout_seconds": 0}
        )
        success_payload = success["structuredContent"]
        self.assertFalse(success["isError"])
        self.assertEqual(success_payload["tool"], "wait_job")
        self.assertTrue(success_payload["completed"])
        self.assertFalse(success_payload["timed_out"])
        self.assertEqual(success_payload["polls"], 1)

        uncertain = call_tool(
            server, "wait_job", {"job_id": "badc0ffee", "timeout_seconds": 1}
        )
        uncertain_payload = uncertain["structuredContent"]
        self.assertTrue(uncertain_payload["completed"])
        self.assertTrue(uncertain_payload["delivery_uncertain"])
        self.assertFalse(uncertain_payload["safe_to_retry"])
        self.assertIn("Do NOT resend", uncertain_payload["warning"])

        timed_out = call_tool(
            server,
            "wait_job",
            {
                "job_id": "cafe1234",
                "timeout_seconds": 0,
                "poll_interval_seconds": 0.05,
            },
        )
        timeout_payload = timed_out["structuredContent"]
        self.assertFalse(timed_out["isError"])
        self.assertFalse(timeout_payload["completed"])
        self.assertTrue(timeout_payload["timed_out"])
        self.assertEqual(timeout_payload["retry_policy"], "wait_and_poll")
        self.assertFalse(timeout_payload["safe_to_retry"])

    def test_wait_job_http_timeout_is_capped_by_remaining_wait(self) -> None:
        opener = RecordingOpener()
        server = make_server(
            self.fake.base_url,
            opener=opener,
            extra_env={"SUPERTIME_API_TIMEOUT_SECONDS": "300"},
        )
        result = call_tool(
            server,
            "wait_job",
            {
                "job_id": "cafe1234",
                "timeout_seconds": 1.5,
                "poll_interval_seconds": 0.5,
            },
        )
        self.assertTrue(result["structuredContent"]["timed_out"])
        self.assertGreaterEqual(len(opener.timeouts), 2)
        self.assertLessEqual(opener.timeouts[0], 1.5)
        for timeout in opener.timeouts:
            self.assertGreaterEqual(
                timeout, supertime_mcp.WAIT_JOB_MIN_HTTP_TIMEOUT_SECONDS
            )
            self.assertLessEqual(timeout, 1.5)
        self.assertLess(opener.timeouts[-1], opener.timeouts[0])

    def test_wait_job_zero_timeout_uses_bounded_single_poll(self) -> None:
        opener = RecordingOpener(fail_with=TimeoutError("timed out"))
        server = make_server(
            self.fake.base_url,
            opener=opener,
            extra_env={"SUPERTIME_API_TIMEOUT_SECONDS": "300"},
        )
        result = call_tool(
            server, "wait_job", {"job_id": "cafe1234", "timeout_seconds": 0}
        )
        self.assertTrue(result["isError"])
        error = result["structuredContent"]["error"]
        self.assertEqual(error["kind"], "transport_error")
        self.assertFalse(error["delivery_uncertain"])
        self.assertEqual(
            opener.timeouts, [supertime_mcp.WAIT_JOB_MIN_HTTP_TIMEOUT_SECONDS]
        )

        short = RecordingOpener(fail_with=TimeoutError("timed out"))
        short_server = make_server(
            self.fake.base_url,
            opener=short,
            extra_env={"SUPERTIME_API_TIMEOUT_SECONDS": "0.5"},
        )
        call_tool(
            short_server,
            "wait_job",
            {"job_id": "cafe1234", "timeout_seconds": 0},
        )
        self.assertEqual(short.timeouts, [0.5])

    def test_validation_errors_never_hit_http(self) -> None:
        server = make_server(self.fake.base_url)
        cases = [
            ("send_message", {"target": "", "message": "hello"}, "target"),
            ("send_message", {"target": "alice", "message": ""}, "message"),
            (
                "send_message",
                {"target": "alice", "message": "hello", "mention": "   "},
                "mention",
            ),
            (
                "send_message",
                {
                    "target": "alice",
                    "message": "hello",
                    "mention_separator": "space",
                    "mention_newline": True,
                },
                "mention_newline",
            ),
            ("send_message", {"target": "alice", "message": "x", "extra": 1}, "extra"),
            (
                "send_attachments",
                {
                    "target": "alice",
                    "attachments": ["C:\\a.txt"],
                    "resource_ids": ["a" * 40],
                },
                "attachments",
            ),
            (
                "send_attachments",
                {"target": "alice", "resource_ids": ["A" * 40]},
                "resource_ids",
            ),
            ("send_attachments", {"target": "alice"}, "attachments"),
            (
                "send_message",
                {"target": "alice", "message": "lone \ud800 surrogate"},
                "message",
            ),
            (
                "send_attachments",
                {"target": "alice", "attachments": ["C:\\a\udc00.txt"]},
                "attachments",
            ),
            ("get_job", {"job_id": "not-a-job"}, "job_id"),
            ("wait_job", {"job_id": "not-a-job"}, "job_id"),
            ("health", {"unexpected": True}, "unexpected"),
        ]
        for tool_name, arguments, expected_field in cases:
            with self.subTest(tool=tool_name, arguments=arguments):
                result = call_tool(server, tool_name, arguments)
                self.assertTrue(result["isError"])
                error = result["structuredContent"]["error"]
                self.assertEqual(error["kind"], "validation_error")
                self.assertIn(expected_field, error["fields"])
                self.assertFalse(error["delivery_uncertain"])
        self.assertEqual(self.fake.requests, [])

    def test_api_404_is_mapped_without_retry(self) -> None:
        server = make_server(self.fake.base_url)
        result = call_tool(server, "get_job", {"job_id": "deadbeef"})
        self.assertTrue(result["isError"])
        error = result["structuredContent"]["error"]
        self.assertEqual(error["kind"], "not_found")
        self.assertEqual(error["http_status"], 404)
        self.assertFalse(error["delivery_uncertain"])

    def test_auth_error_does_not_leak_token(self) -> None:
        server = make_server(self.fake.base_url, token=OTHER_TOKEN)
        result = call_tool(server, "health")
        self.assertTrue(result["isError"])
        error = result["structuredContent"]["error"]
        self.assertEqual(error["kind"], "auth_error")
        self.assertEqual(error["http_status"], 401)
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn(OTHER_TOKEN, serialized)
        self.assertNotIn(TOKEN, serialized)

    def test_send_5xx_is_delivery_uncertain(self) -> None:
        self.fake.send_status = 503
        self.fake.send_error_message = "job queue full"
        server = make_server(self.fake.base_url)
        result = call_tool(
            server,
            "send_message",
            {"target": "alice", "message": "hello"},
        )
        self.assertTrue(result["isError"])
        payload = result["structuredContent"]
        self.assertEqual(payload["error"]["kind"], "service_unavailable")
        self.assertTrue(payload["error"]["delivery_uncertain"])
        self.assertFalse(payload["error"]["safe_to_retry"])
        self.assertEqual(payload["retry_policy"], "do_not_automatically_retry")
        self.assertIn("Do NOT resend", payload["warning"])

    def test_send_transport_error_is_delivery_uncertain(self) -> None:
        server = make_server(self.fake.base_url, opener=RaisingOpener())
        result = call_tool(
            server,
            "send_attachments",
            {"target": "alice", "resource_ids": ["a" * 40]},
        )
        payload = result["structuredContent"]
        self.assertTrue(result["isError"])
        self.assertEqual(payload["error"]["kind"], "transport_error")
        self.assertTrue(payload["error"]["delivery_uncertain"])
        self.assertFalse(payload["error"]["safe_to_retry"])
        self.assertIn("Do NOT resend", payload["warning"])

    def test_malformed_api_response_is_mapped(self) -> None:
        self.fake.health_malformed = True
        server = make_server(self.fake.base_url)
        result = call_tool(server, "health")
        self.assertTrue(result["isError"])
        self.assertEqual(
            result["structuredContent"]["error"]["kind"], "invalid_response"
        )


class ConfigDiscoveryTests(unittest.TestCase):
    def test_legacy_feather_environment_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            legacy_config = repo / "legacy-config"
            mcp_dir = repo / "mcp"
            legacy_config.mkdir()
            mcp_dir.mkdir()
            (legacy_config / "api-token.txt").write_text(TOKEN, encoding="ascii")
            (legacy_config / "api-port.txt").write_text("23456", encoding="ascii")
            legacy_env = {
                "FEATHER_API_URL": "http://127.0.0.1:11111",
                "FEATHER_API_PORT": "11111",
                "FEATHER_API_TOKEN": OTHER_TOKEN,
                "FEATHER_CONFIG_DIR": str(legacy_config),
                "FEATHER_HOME": str(legacy_config),
            }
            with self.assertRaises(supertime_mcp.ConfigError):
                supertime_mcp.ConfigResolver(
                    env=legacy_env, server_dir=mcp_dir, cwd=repo
                ).resolve()

            config = supertime_mcp.ConfigResolver(
                env={
                    **legacy_env,
                    "SUPERTIME_API_URL": "http://127.0.0.1:22222",
                    "SUPERTIME_API_TOKEN": TOKEN,
                    "FEATHER_API_TIMEOUT_SECONDS": "not-a-number",
                },
                server_dir=mcp_dir,
                cwd=repo,
            ).resolve()
            self.assertEqual(config.base_url, "http://127.0.0.1:22222")
            self.assertEqual(config.token, TOKEN)
            self.assertEqual(config.token_source, "SUPERTIME_API_TOKEN")
            self.assertEqual(config.port_source, "SUPERTIME_API_URL")
            self.assertEqual(
                config.timeout_seconds, supertime_mcp.DEFAULT_TIMEOUT_SECONDS
            )

    def test_legacy_feather_remote_opt_in_is_ignored(self) -> None:
        resolver = supertime_mcp.ConfigResolver(
            env={
                "SUPERTIME_API_URL": "http://192.0.2.10:17890",
                "SUPERTIME_API_TOKEN": TOKEN,
                "FEATHER_ALLOW_REMOTE_API": "1",
            },
            server_dir=MCP_DIR,
            cwd=MCP_DIR,
        )
        with self.assertRaises(supertime_mcp.ConfigError):
            resolver.resolve()

    def test_build_files_are_discovered(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            build = repo / "build"
            mcp_dir = repo / "mcp"
            build.mkdir()
            mcp_dir.mkdir()
            (build / "api-token.txt").write_text(TOKEN + "\r\n", encoding="ascii")
            (build / "api-port.txt").write_text("23456\r\n", encoding="ascii")
            resolver = supertime_mcp.ConfigResolver(
                env={}, server_dir=mcp_dir, cwd=repo
            )
            config = resolver.resolve()
            self.assertEqual(config.base_url, "http://127.0.0.1:23456")
            self.assertEqual(config.token, TOKEN)
            self.assertEqual(Path(config.token_source), build / "api-token.txt")
            self.assertEqual(Path(config.port_source), build / "api-port.txt")

    def test_environment_overrides_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            build = repo / "build"
            mcp_dir = repo / "mcp"
            build.mkdir()
            mcp_dir.mkdir()
            (build / "api-token.txt").write_text(TOKEN, encoding="ascii")
            (build / "api-port.txt").write_text("11111", encoding="ascii")
            resolver = supertime_mcp.ConfigResolver(
                env={
                    "SUPERTIME_API_URL": "http://127.0.0.1:22222",
                    "SUPERTIME_API_TOKEN": OTHER_TOKEN,
                },
                server_dir=mcp_dir,
                cwd=repo,
            )
            config = resolver.resolve()
            self.assertEqual(config.base_url, "http://127.0.0.1:22222")
            self.assertEqual(config.token, OTHER_TOKEN)
            self.assertEqual(config.token_source, "SUPERTIME_API_TOKEN")
            self.assertEqual(config.port_source, "SUPERTIME_API_URL")

    def test_missing_port_is_a_config_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            build = repo / "build"
            mcp_dir = repo / "mcp"
            build.mkdir()
            mcp_dir.mkdir()
            (build / "api-token.txt").write_text(TOKEN, encoding="ascii")
            resolver = supertime_mcp.ConfigResolver(
                env={}, server_dir=mcp_dir, cwd=repo
            )
            with self.assertRaises(supertime_mcp.ConfigError):
                resolver.resolve()

    def test_remote_api_host_requires_explicit_opt_in(self) -> None:
        resolver = supertime_mcp.ConfigResolver(
            env={
                "SUPERTIME_API_URL": "http://192.0.2.10:17890",
                "SUPERTIME_API_TOKEN": TOKEN,
            },
            server_dir=MCP_DIR,
            cwd=MCP_DIR,
        )
        with self.assertRaises(supertime_mcp.ConfigError):
            resolver.resolve()

        allowed = supertime_mcp.ConfigResolver(
            env={
                "SUPERTIME_API_URL": "http://supertime.internal:17890",
                "SUPERTIME_API_TOKEN": TOKEN,
                "SUPERTIME_ALLOW_REMOTE_API": "1",
            },
            server_dir=MCP_DIR,
            cwd=MCP_DIR,
        )
        self.assertEqual(
            allowed.resolve().base_url, "http://supertime.internal:17890"
        )

    def test_public_provenance_does_not_expose_token_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            build = repo / "build"
            mcp_dir = repo / "mcp"
            build.mkdir()
            mcp_dir.mkdir()
            (build / "api-token.txt").write_text(TOKEN, encoding="ascii")
            (build / "api-port.txt").write_text("23456", encoding="ascii")
            config = supertime_mcp.ConfigResolver(
                env={}, server_dir=mcp_dir, cwd=repo
            ).resolve()
            provenance = config.public_provenance()
            self.assertEqual(provenance["token_source"], "file")
            self.assertEqual(provenance["port_source"], "file")
            self.assertNotIn(str(build), json.dumps(provenance))

    def test_oversized_body_is_reported_before_config_errors(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            mcp_dir = repo / "mcp"
            mcp_dir.mkdir()
            client = supertime_mcp.SuperTimeClient(
                resolver=supertime_mcp.ConfigResolver(
                    env={}, server_dir=mcp_dir, cwd=repo
                ),
                opener=RaisingOpener(),
            )
            with self.assertRaises(supertime_mcp.ConfigError):
                client.status()
            with self.assertRaises(supertime_mcp.ToolArgumentError) as caught:
                client.send_message(
                    {
                        "target": "alice",
                        "message": "x" * (supertime_mcp.MAX_TOOL_BODY_BYTES + 1),
                    }
                )
            self.assertIn("arguments", caught.exception.fields)


class BatchProtocolTests(unittest.TestCase):
    BATCH = [
        {"jsonrpc": "2.0", "id": 1, "method": "ping"},
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "health", "arguments": {}},
        },
    ]

    def make(self) -> tuple[supertime_mcp.SuperTimeMCPServer, RecordingOpener]:
        opener = RecordingOpener(
            fail_with=urllib.error.URLError("connection refused")
        )
        return make_server("http://127.0.0.1:9", opener=opener), opener

    def test_batch_rejected_for_2025_06_18_and_before_initialize(self) -> None:
        server, opener = self.make()
        before = server.handle(self.BATCH)
        assert isinstance(before, dict)
        self.assertIsNone(before["id"])
        self.assertEqual(before["error"]["code"], -32600)

        rpc(server, 1, "initialize", {"protocolVersion": "2025-06-18"})
        after = server.handle(self.BATCH)
        assert isinstance(after, dict)
        self.assertEqual(after["error"]["code"], -32600)
        self.assertIn("2025-06-18", after["error"]["message"])
        self.assertEqual(opener.timeouts, [])

    def test_batch_supported_for_older_protocols(self) -> None:
        for version in ("2024-11-05", "2025-03-26"):
            with self.subTest(protocol=version):
                server, opener = self.make()
                rpc(server, 1, "initialize", {"protocolVersion": version})
                responses = server.handle(self.BATCH)
                assert isinstance(responses, list)
                self.assertEqual([item["id"] for item in responses], [1, 2])
                self.assertEqual(responses[0]["result"], {})
                self.assertTrue(responses[1]["result"]["isError"])
                self.assertEqual(len(opener.timeouts), 1)


class StdioProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fake = FakeSuperLanguageServer()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.fake.stop()

    def run_session(
        self,
        messages: List[Dict[str, Any]],
        *,
        protocol_version: str = "2025-06-18",
        extra_env: Optional[Dict[str, str]] = None,
    ) -> List[Dict[str, Any]]:
        env = os.environ.copy()
        env.update(
            {
                "SUPERTIME_API_URL": self.fake.base_url,
                "SUPERTIME_API_TOKEN": TOKEN,
                "SUPERTIME_MCP_LOG": "CRITICAL",
            }
        )
        if extra_env:
            env.update(extra_env)
        wire = "\n".join(
            json.dumps(message, ensure_ascii=False) for message in messages
        ) + "\n"
        process = subprocess.run(
            [sys.executable, str(SCRIPT)],
            input=wire.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            env=env,
            cwd=str(REPO_DIR),
        )
        self.assertEqual(
            process.returncode,
            0,
            process.stderr.decode("utf-8", errors="replace"),
        )
        lines = [
            line
            for line in process.stdout.decode("utf-8").splitlines()
            if line.strip()
        ]
        responses = [json.loads(line) for line in lines]
        for response in responses:
            self.assertEqual(response.get("jsonrpc"), "2.0")
        return responses

    def test_handshake_tools_list_and_ping_over_stdio_all_versions(self) -> None:
        for version in supertime_mcp.SUPPORTED_PROTOCOLS:
            with self.subTest(protocol=version):
                responses = self.run_session(
                    [
                        {
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "initialize",
                            "params": {
                                "protocolVersion": version,
                                "capabilities": {},
                                "clientInfo": {"name": "offline-test", "version": "1"},
                            },
                        },
                        {
                            "jsonrpc": "2.0",
                            "method": "notifications/initialized",
                        },
                        {
                            "jsonrpc": "2.0",
                            "id": 2,
                            "method": "ping",
                        },
                        {
                            "jsonrpc": "2.0",
                            "id": 3,
                            "method": "tools/list",
                            "params": {},
                        },
                    ],
                    protocol_version=version,
                )
                self.assertEqual(len(responses), 3)
                initialize = responses[0]["result"]
                self.assertEqual(initialize["protocolVersion"], version)
                self.assertEqual(
                    initialize["serverInfo"]["name"], "supertime-mcp"
                )
                self.assertIn("tools", initialize["capabilities"])
                self.assertEqual(responses[1]["result"], {})
                tools = responses[2]["result"]["tools"]
                self.assertEqual(
                    {tool["name"] for tool in tools},
                    {
                        "health",
                        "status",
                        "send_message",
                        "send_attachments",
                        "get_job",
                        "wait_job",
                    },
                )
                send_tool = next(tool for tool in tools if tool["name"] == "send_message")
                self.assertFalse(send_tool["annotations"]["idempotentHint"])
                self.assertTrue(send_tool["annotations"]["destructiveHint"])

    def test_stdio_tool_call_health_and_validation(self) -> None:
        responses = self.run_session(
            [
                {
                    "jsonrpc": "2.0",
                    "id": "init",
                    "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18"},
                },
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized",
                },
                {
                    "jsonrpc": "2.0",
                    "id": "health",
                    "method": "tools/call",
                    "params": {"name": "health", "arguments": {}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": "bad",
                    "method": "tools/call",
                    "params": {
                        "name": "send_message",
                        "arguments": {"target": "alice", "message": ""},
                    },
                },
            ]
        )
        self.assertEqual(len(responses), 3)
        health = responses[1]["result"]
        self.assertFalse(health["isError"])
        self.assertTrue(health["structuredContent"]["data"]["ok"])
        bad = responses[2]["result"]
        self.assertTrue(bad["isError"])
        self.assertEqual(
            bad["structuredContent"]["error"]["kind"], "validation_error"
        )
        # Only health reached the fake API; the invalid send never did.
        send_paths = [
            item["path"]
            for item in self.fake.requests
            if item["path"].startswith("/api/send")
        ]
        self.assertEqual(send_paths, [])

    def test_unknown_protocol_falls_back_to_latest(self) -> None:
        responses = self.run_session(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {"protocolVersion": "2099-01-01"},
                }
            ]
        )
        self.assertEqual(
            responses[0]["result"]["protocolVersion"],
            supertime_mcp.LATEST_PROTOCOL,
        )

    def test_parse_error_and_unknown_method(self) -> None:
        env = os.environ.copy()
        env.update(
            {
                "SUPERTIME_API_URL": self.fake.base_url,
                "SUPERTIME_API_TOKEN": TOKEN,
                "SUPERTIME_MCP_LOG": "CRITICAL",
            }
        )
        wire = b'{"jsonrpc":"2.0","id":\n' + (
            json.dumps(
                {"jsonrpc": "2.0", "id": 2, "method": "not/a/method"}
            ).encode("utf-8")
            + b"\n"
        )
        process = subprocess.run(
            [sys.executable, str(SCRIPT)],
            input=wire,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            env=env,
            cwd=str(REPO_DIR),
        )
        self.assertEqual(process.returncode, 0)
        responses = [
            json.loads(line)
            for line in process.stdout.decode("utf-8").splitlines()
            if line.strip()
        ]
        self.assertEqual(responses[0]["error"]["code"], -32700)
        self.assertEqual(responses[1]["error"]["code"], -32601)


if __name__ == "__main__":
    unittest.main(verbosity=2)
