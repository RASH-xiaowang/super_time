#!/usr/bin/env python3
r"""No-WeChat SuperLanguage API regression driver.

Each case runs a copied build/SuperLanguage.exe from a fresh directory under
%TEMP%\supertime-tests. The process is placed on a private Windows desktop and
inside a one-process job object so it cannot see or launch WeChat windows.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import http.client
import ipaddress
import json
import logging
import os
import re
import secrets
import shutil
import socket
import sqlite3
import sys
import time
import traceback
import uuid
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple


EXPECTED_VERSION = "1.0.0"
EXPECTED_API_REVISION = 6
TEST_TARGET = "supertime-regression-no-send"
ATTEMPTED_FAILED_JOB_ID = "0123456789abcdef"
UNATTEMPTED_FAILED_JOB_ID = "fedcba9876543210"
ATTEMPTED_UNVERIFIED_JOB_ID = "1111111111111111"
ATTEMPTED_VERIFIED_JOB_ID = "2222222222222222"
HEALTH_TIMEOUT_SECONDS = 20.0
PROCESS_EXIT_TIMEOUT_SECONDS = 15.0
HTTP_TIMEOUT_SECONDS = 10.0
MAX_REQUEST_BODY_BYTES = 8192

WAIT_OBJECT_0 = 0x00000000
WAIT_TIMEOUT = 0x00000102
CREATE_SUSPENDED = 0x00000004
CREATE_UNICODE_ENVIRONMENT = 0x00000400
STARTF_USESHOWWINDOW = 0x00000001
SW_HIDE = 0
JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
DESKTOP_ALL_ACCESS = 0x000F01FF


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_ubyte)),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
kernel32.CreateJobObjectW.restype = wintypes.HANDLE
kernel32.SetInformationJobObject.argtypes = [
    wintypes.HANDLE,
    ctypes.c_int,
    ctypes.c_void_p,
    wintypes.DWORD,
]
kernel32.SetInformationJobObject.restype = wintypes.BOOL
kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
kernel32.CreateProcessW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.LPWSTR,
    ctypes.c_void_p,
    ctypes.c_void_p,
    wintypes.BOOL,
    wintypes.DWORD,
    ctypes.c_void_p,
    wintypes.LPCWSTR,
    ctypes.POINTER(STARTUPINFOW),
    ctypes.POINTER(PROCESS_INFORMATION),
]
kernel32.CreateProcessW.restype = wintypes.BOOL
kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
kernel32.ResumeThread.restype = wintypes.DWORD
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.WaitForSingleObject.restype = wintypes.DWORD
kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
kernel32.GetExitCodeProcess.restype = wintypes.BOOL
kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.TerminateProcess.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.GetTempPathW.argtypes = [wintypes.DWORD, wintypes.LPWSTR]
kernel32.GetTempPathW.restype = wintypes.DWORD
user32.CreateDesktopW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.LPCWSTR,
    ctypes.c_void_p,
    wintypes.DWORD,
    wintypes.DWORD,
    ctypes.c_void_p,
]
user32.CreateDesktopW.restype = wintypes.HANDLE
user32.CloseDesktop.argtypes = [wintypes.HANDLE]
user32.CloseDesktop.restype = wintypes.BOOL


def win_error(prefix: str) -> OSError:
    error = ctypes.get_last_error()
    return OSError(error, f"{prefix}: {ctypes.FormatError(error)}")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_text_crlf(path: Path, value: str) -> None:
    path.write_bytes(value.encode("ascii") + b"\r\n")


def windows_temp_path() -> Path:
    """Same directory as verify.ps1's [IO.Path]::GetTempPath() (TMP before TEMP)."""
    buffer = ctypes.create_unicode_buffer(32768)
    length = kernel32.GetTempPathW(len(buffer), buffer)
    if length == 0 or length >= len(buffer):
        raise win_error("GetTempPathW failed")
    return Path(buffer.value)


def local_non_loopback_ipv4() -> List[str]:
    candidates = set()
    hostname = socket.gethostname()
    try:
        candidates.update(socket.gethostbyname_ex(hostname)[2])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            candidates.add(str(info[4][0]))
    except OSError:
        pass
    addresses = []
    for text in sorted(candidates):
        address = ipaddress.ip_address(text)
        if address.is_loopback or address.is_link_local or address.is_unspecified:
            continue
        addresses.append(text)
    return addresses


class IsolatedProcess:
    """SuperLanguage process restricted to a private desktop and a one-process job."""

    def __init__(self, executable: Path, working_directory: Path, logger: logging.Logger):
        self.executable = executable
        self.working_directory = working_directory
        self.logger = logger
        self.desktop_name = "SuperLanguageTest_" + uuid.uuid4().hex
        self.desktop_handle: Optional[Any] = None
        self.job_handle: Optional[Any] = None
        self.process_handle: Optional[Any] = None
        self.pid: Optional[int] = None
        self.exit_code: Optional[int] = None
        self._started = False

    def start(self) -> None:
        if os.name != "nt":
            raise RuntimeError("This regression driver requires Windows.")

        self.desktop_handle = user32.CreateDesktopW(
            self.desktop_name, None, None, 0, DESKTOP_ALL_ACCESS, None)
        if not self.desktop_handle:
            raise win_error("CreateDesktopW failed")

        self.job_handle = kernel32.CreateJobObjectW(None, None)
        if not self.job_handle:
            raise win_error("CreateJobObjectW failed")

        limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = (
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
        limits.BasicLimitInformation.ActiveProcessLimit = 1
        if not kernel32.SetInformationJobObject(
                self.job_handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                ctypes.byref(limits),
                ctypes.sizeof(limits)):
            raise win_error("SetInformationJobObject failed")

        startup = STARTUPINFOW()
        startup.cb = ctypes.sizeof(startup)
        startup.dwFlags = STARTF_USESHOWWINDOW
        startup.wShowWindow = SW_HIDE
        startup.lpDesktop = self.desktop_name

        command_line = ctypes.create_unicode_buffer(
            f'"{self.executable}" --tray --test-skip-license')
        process_info = PROCESS_INFORMATION()
        created = kernel32.CreateProcessW(
            str(self.executable),
            command_line,
            None,
            None,
            False,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            None,
            str(self.working_directory),
            ctypes.byref(startup),
            ctypes.byref(process_info),
        )
        if not created:
            raise win_error("CreateProcessW failed")

        self.process_handle = process_info.hProcess
        self.pid = int(process_info.dwProcessId)

        try:
            if not kernel32.AssignProcessToJobObject(
                    self.job_handle, self.process_handle):
                raise win_error("AssignProcessToJobObject failed")
            if kernel32.ResumeThread(process_info.hThread) == 0xFFFFFFFF:
                raise win_error("ResumeThread failed")
        except Exception:
            self.terminate()
            raise
        finally:
            if process_info.hThread:
                kernel32.CloseHandle(process_info.hThread)

        self._started = True
        self.logger.info(
            "launched PID=%s desktop=%s job_active_process_limit=1",
            self.pid,
            self.desktop_name,
        )

    def is_alive(self) -> bool:
        if not self.process_handle:
            return False
        result = kernel32.WaitForSingleObject(self.process_handle, 0)
        if result == WAIT_TIMEOUT:
            return True
        if result == WAIT_OBJECT_0:
            return False
        raise win_error("WaitForSingleObject failed")

    def wait_for_exit(self, timeout_seconds: float) -> bool:
        if not self.process_handle:
            return True
        timeout_ms = int(timeout_seconds * 1000)
        result = kernel32.WaitForSingleObject(self.process_handle, timeout_ms)
        if result == WAIT_TIMEOUT:
            return False
        if result != WAIT_OBJECT_0:
            raise win_error("WaitForSingleObject failed")

        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(self.process_handle, ctypes.byref(code)):
            raise win_error("GetExitCodeProcess failed")
        self.exit_code = int(code.value)
        return True

    def terminate(self) -> None:
        if not self.process_handle:
            return
        try:
            if self.is_alive():
                self.logger.warning("terminating isolated SuperLanguage PID=%s", self.pid)
                if not kernel32.TerminateProcess(self.process_handle, 1):
                    self.logger.warning(
                        "TerminateProcess failed for PID=%s: %s",
                        self.pid,
                        ctypes.FormatError(ctypes.get_last_error()),
                    )
                self.wait_for_exit(5.0)
        except Exception:
            self.logger.exception("failed while terminating isolated SuperLanguage")

    def close(self) -> None:
        self.terminate()
        if self.process_handle:
            kernel32.CloseHandle(self.process_handle)
            self.process_handle = None
        if self.job_handle:
            kernel32.CloseHandle(self.job_handle)
            self.job_handle = None
        if self.desktop_handle:
            if not user32.CloseDesktop(self.desktop_handle):
                self.logger.warning(
                    "CloseDesktop failed for %s: %s",
                    self.desktop_name,
                    ctypes.FormatError(ctypes.get_last_error()),
                )
            self.desktop_handle = None


class ApiClient:
    def __init__(self, port: int, token: str, logger: logging.Logger,
                 host: str = "127.0.0.1"):
        self.port = port
        self.token = token
        self.logger = logger
        self.host = host

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[bytes] = None,
        headers: Optional[Dict[str, str]] = None,
        authenticate: bool = True,
        quiet: bool = False,
        body_delay_seconds: Optional[float] = None,
    ) -> Tuple[int, Dict[str, str], bytes]:
        request_headers = dict(headers or {})
        if authenticate:
            request_headers["Authorization"] = "Bearer " + self.token
        if body is not None:
            request_headers.setdefault("Content-Length", str(len(body)))
        elif method.upper() in {"POST", "PUT", "PATCH"}:
            request_headers.setdefault("Content-Length", "0")
        request_headers.setdefault("Connection", "close")

        safe_path = path.replace(self.token, "<token>")
        if not quiet:
            self.logger.info(
                "HTTP %s %s body_bytes=%d",
                method,
                safe_path,
                len(body) if body is not None else 0,
            )

        connection = http.client.HTTPConnection(
            self.host, self.port, timeout=HTTP_TIMEOUT_SECONDS)
        try:
            if body_delay_seconds is None:
                connection.request(
                    method, path, body=body, headers=request_headers)
            else:
                # Separate writes make the server read the body after headers.
                connection.putrequest(method, path, skip_accept_encoding=True)
                for name, value in request_headers.items():
                    connection.putheader(name, value)
                connection.endheaders()
                time.sleep(body_delay_seconds)
                if body:
                    connection.send(body)
            response = connection.getresponse()
            response_body = response.read()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
        finally:
            connection.close()

        if not quiet:
            self.logger.info(
                "HTTP %s %s -> %d response_bytes=%d",
                method,
                safe_path,
                response.status,
                len(response_body),
            )
        return response.status, response_headers, response_body

    def json_request(
        self,
        method: str,
        path: str,
        *,
        payload: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        authenticate: bool = True,
        quiet: bool = False,
    ) -> Tuple[int, Dict[str, Any]]:
        request_headers = dict(headers or {})
        body = None
        if payload is not None:
            body = json.dumps(
                payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
        status, _, response_body = self.request(
            method,
            path,
            body=body,
            headers=request_headers,
            authenticate=authenticate,
            quiet=quiet,
        )
        try:
            decoded = json.loads(response_body.decode("utf-8"))
        except Exception as exc:
            raise AssertionError(
                f"HTTP {status} response was not valid JSON: {response_body!r}"
            ) from exc
        if not isinstance(decoded, dict):
            raise AssertionError(f"HTTP {status} response was not a JSON object")
        return status, decoded


class CaseContext:
    def __init__(
        self,
        case_id: str,
        run_root: Path,
        build_exe: Path,
        build_sha256: str,
    ):
        self.case_id = case_id
        self.case_dir = run_root / case_id
        self.case_dir.mkdir(parents=True, exist_ok=False)
        self.log_path = self.case_dir / "case.log"
        self.logger = logging.getLogger("supertime." + case_id + "." + uuid.uuid4().hex)
        self.logger.setLevel(logging.DEBUG)
        self.logger.propagate = False
        formatter = logging.Formatter(
            "%(asctime)s %(levelname)s %(message)s", "%Y-%m-%dT%H:%M:%S")
        file_handler = logging.FileHandler(self.log_path, encoding="utf-8")
        file_handler.setFormatter(formatter)
        self.logger.addHandler(file_handler)
        stream_handler = logging.StreamHandler(sys.stdout)
        stream_handler.setFormatter(formatter)
        self.logger.addHandler(stream_handler)
        self._handlers = [file_handler, stream_handler]

        self.build_exe = build_exe
        self.build_sha256 = build_sha256
        self.token = secrets.token_hex(16)
        self.executable = self.case_dir / "SuperLanguage.exe"
        self.isolated_process = IsolatedProcess(
            self.executable, self.case_dir, self.logger)
        self.listen_mode = "lan"
        self.skipped_checks: List[str] = []
        self.api: Optional[ApiClient] = None
        self.port: Optional[int] = None
        self.stop_status: Optional[int] = None
        self.process_exit_verified = False
        self.process_exit_code: Optional[int] = None

    def setup(self) -> None:
        self.logger.info("CASE %s", self.case_id)
        self.logger.info(
            "source_build=%s sha256=%s size=%d",
            self.build_exe,
            self.build_sha256,
            self.build_exe.stat().st_size,
        )
        shutil.copy2(self.build_exe, self.executable)
        copied_hash = sha256_file(self.executable)
        require(
            copied_hash == self.build_sha256,
            "copied executable hash differs from build executable",
        )

        write_text_crlf(self.case_dir / "api-token.txt", self.token)
        write_text_crlf(self.case_dir / "api-enabled.txt", "1")
        write_text_crlf(self.case_dir / "api-listen.txt", self.listen_mode)
        write_text_crlf(self.case_dir / "shortcut-tip.txt", "1")

        self.isolated_process.start()
        self.port = self._wait_for_port()
        self.api = ApiClient(self.port, self.token, self.logger)
        self._wait_for_health()

    def _wait_for_port(self) -> int:
        port_path = self.case_dir / "api-port.txt"
        deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if not self.isolated_process.is_alive():
                code = self.isolated_process.exit_code
                raise AssertionError(
                    f"SuperLanguage exited before API readiness, exit_code={code}")
            try:
                text = port_path.read_text(encoding="ascii").strip()
                port = int(text)
                if 1 <= port <= 65535:
                    self.logger.info("API port file accepted: %d", port)
                    return port
            except (FileNotFoundError, OSError, ValueError):
                pass
            time.sleep(0.1)
        raise AssertionError("timed out waiting for api-port.txt")

    def _wait_for_health(self) -> None:
        require(self.api is not None, "API client was not initialized")
        deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
        last_error = "no response"
        while time.monotonic() < deadline:
            if not self.isolated_process.is_alive():
                raise AssertionError(
                    f"SuperLanguage exited before health check, "
                    f"exit_code={self.isolated_process.exit_code}")
            try:
                status, _, body = self.api.request(
                    "GET", "/api/health", quiet=True)
                if status == 200:
                    payload = json.loads(body.decode("utf-8"))
                    require(payload.get("ok") is True, "health ok flag is not true")
                    self.logger.info("health endpoint ready")
                    return
                last_error = f"HTTP {status}"
            except Exception as exc:
                last_error = str(exc)
            time.sleep(0.15)
        raise AssertionError(f"timed out waiting for health endpoint: {last_error}")

    def assert_queue_empty(self, reason: str) -> None:
        require(self.api is not None, "API client was not initialized")
        status, payload = self.api.json_request("GET", "/api/status")
        require(status == 200, f"/api/status returned {status}, expected 200")
        require(
            payload.get("service") == "supertime",
            f"/api/status service is {payload.get('service')!r}, "
            "expected 'supertime'",
        )
        queue = payload.get("queue")
        require(isinstance(queue, dict), "/api/status queue object missing")
        counts = {
            key: int(queue.get(key, -1))
            for key in ("queued", "running", "succeeded", "failed")
        }
        require(
            all(value == 0 for value in counts.values()),
            f"/api/status queue is not empty after {reason}: {counts}",
        )

        db_path = self.case_dir / "queue.db"
        db_count = wait_for_queue_count(db_path)
        require(
            db_count == 0,
            f"queue.db contains {db_count} jobs after {reason}",
        )
        self.logger.info(
            "PASS queue stayed empty after %s api_counts=%s db_count=%d",
            reason,
            counts,
            db_count,
        )

    def stop_and_verify_exit(self) -> None:
        require(self.api is not None, "API client was not initialized")
        status, payload = self.api.json_request("POST", "/api/stop")
        self.stop_status = status
        require(status == 202, f"/api/stop returned {status}, expected 202")
        require(payload.get("ok") is True, "/api/stop ok flag is not true")
        require(
            payload.get("state") == "stopping",
            "/api/stop state is not stopping",
        )

        exited = self.isolated_process.wait_for_exit(
            PROCESS_EXIT_TIMEOUT_SECONDS)
        require(exited, "SuperLanguage process did not exit after /api/stop 202")
        self.process_exit_verified = True
        self.process_exit_code = self.isolated_process.exit_code
        require(
            self.process_exit_code == 0,
            f"SuperLanguage exited with {self.process_exit_code}, expected 0",
        )
        self.logger.info(
            "PASS /api/stop 202 and process exited exit_code=%s",
            self.process_exit_code,
        )

    def close(self, attempt_stop: bool) -> None:
        try:
            if (attempt_stop and self.api is not None
                    and self.isolated_process.is_alive()):
                try:
                    self.api.request("POST", "/api/stop", quiet=True)
                    self.isolated_process.wait_for_exit(4.0)
                except Exception:
                    self.logger.exception("best-effort /api/stop failed")
        finally:
            self.isolated_process.close()
            for handler in self._handlers:
                handler.flush()
                handler.close()
                self.logger.removeHandler(handler)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def wait_for_queue_count(path: Path, timeout_seconds: float = 8.0) -> int:
    deadline = time.monotonic() + timeout_seconds
    last_error: Optional[Exception] = None
    uri = path.resolve().as_uri() + "?mode=ro"
    while time.monotonic() < deadline:
        try:
            connection = sqlite3.connect(uri, uri=True, timeout=2.0)
            try:
                row = connection.execute("SELECT COUNT(*) FROM jobs;").fetchone()
            finally:
                connection.close()
            return int(row[0])
        except Exception as exc:
            last_error = exc
            time.sleep(0.1)
    raise AssertionError(f"could not read temporary queue.db: {last_error}")


PreparationHook = Callable[[CaseContext], None]
CASE_FUNCTIONS: List[
    Tuple[str, Callable[[CaseContext], None], Optional[PreparationHook]]
] = []


def case(
    case_id: str, prepare: Optional[PreparationHook] = None
) -> Callable[[Callable[[CaseContext], None]], Callable[[CaseContext], None]]:
    def register(function: Callable[[CaseContext], None]) -> Callable[[CaseContext], None]:
        CASE_FUNCTIONS.append((case_id, function, prepare))
        return function
    return register


def prepare_failed_delivery_metadata_case(ctx: CaseContext) -> None:
    db_path = ctx.case_dir / "queue.db"
    require(not db_path.exists(), "queue metadata preparation found an existing queue.db")
    connection = sqlite3.connect(str(db_path))
    try:
        connection.execute(
            """
            CREATE TABLE jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                api_id TEXT NOT NULL UNIQUE,
                type TEXT NOT NULL,
                source TEXT NOT NULL,
                target TEXT NOT NULL,
                message TEXT NOT NULL DEFAULT '',
                mention TEXT NOT NULL DEFAULT '',
                mention_newline INTEGER NOT NULL DEFAULT 0,
                attachments TEXT NOT NULL DEFAULT '',
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                finished_at INTEGER NOT NULL DEFAULT 0,
                content_verified INTEGER NOT NULL DEFAULT 0,
                sent_count INTEGER NOT NULL DEFAULT 0,
                error INTEGER NOT NULL DEFAULT 0,
                delivery_attempted INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        connection.executemany(
            """
            INSERT INTO jobs (
                api_id, type, source, target, message, mention,
                mention_newline, attachments, state, created_at, finished_at,
                content_verified, sent_count, error, delivery_attempted
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """,
            [
                (
                    ATTEMPTED_FAILED_JOB_ID,
                    "message",
                    "regression",
                    TEST_TARGET,
                    "attempted failed job",
                    "",
                    0,
                    "",
                    "failed",
                    1,
                    1,
                    0,
                    0,
                    0,
                    1,
                ),
                (
                    UNATTEMPTED_FAILED_JOB_ID,
                    "message",
                    "regression",
                    TEST_TARGET,
                    "unattempted failed job",
                    "",
                    0,
                    "",
                    "failed",
                    2,
                    2,
                    0,
                    0,
                    0,
                    0,
                ),
                (
                    ATTEMPTED_UNVERIFIED_JOB_ID,
                    "message",
                    "regression",
                    TEST_TARGET,
                    "attempted succeeded but unverified job",
                    "",
                    0,
                    "",
                    "succeeded",
                    3,
                    3,
                    0,
                    1,
                    0,
                    1,
                ),
                (
                    ATTEMPTED_VERIFIED_JOB_ID,
                    "message",
                    "regression",
                    TEST_TARGET,
                    "attempted succeeded and verified job",
                    "",
                    0,
                    "",
                    "succeeded",
                    4,
                    4,
                    1,
                    1,
                    0,
                    1,
                ),
            ],
        )
        connection.commit()
    finally:
        connection.close()
    ctx.logger.info(
        "prepared queue.db attempted_job=%s unattempted_job=%s "
        "unverified_job=%s verified_job=%s",
        ATTEMPTED_FAILED_JOB_ID,
        UNATTEMPTED_FAILED_JOB_ID,
        ATTEMPTED_UNVERIFIED_JOB_ID,
        ATTEMPTED_VERIFIED_JOB_ID,
    )


@case("health_version_api6")
def test_health(ctx: CaseContext) -> None:
    require(ctx.api is not None, "API client missing")
    status, payload = ctx.api.json_request("GET", "/api/health")
    require(status == 200, f"/api/health returned {status}, expected 200")
    require(payload.get("ok") is True, "health ok flag is not true")
    require(
        payload.get("version") == EXPECTED_VERSION,
        f"health version is {payload.get('version')!r}, expected {EXPECTED_VERSION!r}",
    )
    require(
        payload.get("api") == EXPECTED_API_REVISION,
        f"health API is {payload.get('api')!r}, expected {EXPECTED_API_REVISION}",
    )
    require(payload.get("webhook") is True, "health webhook flag is not true")
    require(payload.get("port") == ctx.port, "health port differs from api-port.txt")
    require(
        payload.get("service") == "supertime",
        f"health service is {payload.get('service')!r}, expected 'supertime'",
    )
    ctx.logger.info(
        "PASS health version=%s api=%s webhook=true",
        EXPECTED_VERSION,
        EXPECTED_API_REVISION,
    )


@case(
    "failed_job_delivery_metadata_api_and_webhook",
    prepare_failed_delivery_metadata_case,
)
def test_failed_job_delivery_metadata(ctx: CaseContext) -> None:
    require(ctx.api is not None, "API client missing")
    jobs = (
        (ATTEMPTED_FAILED_JOB_ID, "failed", False, True, True),
        (UNATTEMPTED_FAILED_JOB_ID, "failed", False, False, False),
        (ATTEMPTED_UNVERIFIED_JOB_ID, "succeeded", False, True, True),
        (ATTEMPTED_VERIFIED_JOB_ID, "succeeded", True, True, False),
    )
    for job_id, expected_state, content_verified, attempted, uncertain in jobs:
        endpoints = (
            (
                "API",
                f"/api/jobs/{job_id}",
                True,
                None,
            ),
            (
                "Webhook",
                f"/webhook/{ctx.token}/jobs/{job_id}",
                False,
                True,
            ),
        )
        for label, path, authenticate, expected_ok in endpoints:
            status, payload = ctx.api.json_request(
                "GET", path, authenticate=authenticate)
            require(
                status == 200,
                f"{label} job {job_id} returned {status}, expected 200",
            )
            if expected_ok is not None:
                require(
                    payload.get("ok") is expected_ok,
                    f"{label} job {job_id} ok flag is not {expected_ok}",
                )
            require(
                payload.get("id") == job_id,
                f"{label} job endpoint returned wrong id",
            )
            require(
                payload.get("state") == expected_state,
                f"{label} job {job_id} returned state="
                f"{payload.get('state')!r}, expected {expected_state!r}",
            )
            require(
                payload.get("content_verified") is content_verified,
                f"{label} job {job_id} content_verified is "
                f"{payload.get('content_verified')!r}, expected {content_verified}",
            )
            require(
                payload.get("delivery_attempted") is attempted,
                f"{label} job {job_id} delivery_attempted is not {attempted}",
            )
            require(
                payload.get("delivery_uncertain") is uncertain,
                f"{label} job {job_id} delivery_uncertain is not {uncertain}",
            )
            ctx.logger.info(
                "PASS %s job=%s delivery_attempted=%s delivery_uncertain=%s",
                label,
                job_id,
                attempted,
                uncertain,
            )


def lan_api_client(ctx: CaseContext, check: str) -> Optional[ApiClient]:
    """Client whose peer address is non-loopback; local paths are loopback-only."""
    require(ctx.api is not None and ctx.port is not None, "API client missing")
    addresses = local_non_loopback_ipv4()
    if not addresses:
        note = f"{check} skipped: no non-loopback IPv4 address"
        ctx.skipped_checks.append(note)
        ctx.logger.warning("SKIP %s", note)
        return None
    return ApiClient(ctx.port, ctx.token, ctx.logger, host=addresses[0])


@case("lan_api_local_path_403")
def test_lan_api_local_path(ctx: CaseContext) -> None:
    client = lan_api_client(ctx, "LAN API local-path check")
    if client is None:
        return
    for attachments in (r"C:\Windows\win.ini", [r"C:\Windows\win.ini"]):
        status, payload = client.json_request(
            "POST",
            "/api/send-attachments",
            payload={
                "target": TEST_TARGET,
                "attachments": attachments,
            },
        )
        require(
            status == 403,
            f"LAN API local path {type(attachments).__name__} returned "
            f"{status}, expected 403",
        )
        require(
            payload.get("ok") is not True,
            "LAN API local path unexpectedly succeeded",
        )
    ctx.assert_queue_empty("LAN API local-path rejection")
    ctx.logger.info(
        "PASS LAN API local path (string and array) was rejected with 403")


@case("lan_webhook_local_path_403")
def test_lan_webhook_local_path(ctx: CaseContext) -> None:
    client = lan_api_client(ctx, "LAN webhook local-path check")
    if client is None:
        return
    status, payload = client.json_request(
        "POST",
        "/webhook/" + ctx.token,
        payload={
            "target": TEST_TARGET,
            "attachments": r"C:\Windows\win.ini",
        },
        authenticate=False,
    )
    require(
        status == 403,
        f"LAN webhook local path returned {status}, expected 403",
    )
    require(payload.get("ok") is False, "LAN webhook local path unexpectedly succeeded")
    ctx.assert_queue_empty("LAN webhook local-path rejection")
    ctx.logger.info("PASS LAN webhook local path was rejected with 403")


@case("missing_resource_404")
def test_missing_resource(ctx: CaseContext) -> None:
    require(ctx.api is not None, "API client missing")
    for resource_ids in ("a" * 40, ["a" * 40, "c" * 40]):
        status, payload = ctx.api.json_request(
            "POST",
            "/api/send-attachments",
            payload={
                "target": TEST_TARGET,
                "resource_ids": resource_ids,
            },
        )
        require(
            status == 404,
            f"missing resource {type(resource_ids).__name__} returned "
            f"{status}, expected 404",
        )
        require(
            payload.get("ok") is not True,
            "missing resource unexpectedly succeeded",
        )
    ctx.assert_queue_empty("missing-resource rejection")
    ctx.logger.info(
        "PASS missing resource (string and array) was rejected with 404")


@case("mutual_attachment_fields_400")
def test_mutual_attachment_fields(ctx: CaseContext) -> None:
    require(ctx.api is not None, "API client missing")
    status, payload = ctx.api.json_request(
        "POST",
        "/api/send-attachments",
        payload={
            "target": TEST_TARGET,
            "attachments": r"C:\Windows\win.ini",
            "resource_ids": "b" * 40,
        },
    )
    require(
        status == 400,
        f"attachments+resource_ids returned {status}, expected 400",
    )
    require(
        "mutually exclusive" in str(payload.get("message", "")),
        "mutual-exclusion error message is missing",
    )
    ctx.assert_queue_empty("mutual attachment-field rejection")
    ctx.logger.info("PASS attachments+resource_ids was rejected with 400")


@case("bad_content_type_415")
def test_bad_content_type(ctx: CaseContext) -> None:
    require(ctx.api is not None, "API client missing")
    status, _, body = ctx.api.request(
        "POST",
        "/api/send-message",
        body=b"{}",
        headers={"Content-Type": "text/plain"},
    )
    require(status == 415, f"bad Content-Type returned {status}, expected 415")
    payload = json.loads(body.decode("utf-8"))
    require(payload.get("ok") is not True, "bad Content-Type unexpectedly succeeded")
    ctx.assert_queue_empty("bad Content-Type rejection")
    ctx.logger.info("PASS bad Content-Type was rejected with 415")


@case("large_headers_small_body_not_413")
def test_large_headers_small_body(ctx: CaseContext) -> None:
    require(ctx.api is not None, "API client missing")
    body = json.dumps(
        {
            "target": TEST_TARGET,
            "attachments": r"C:\Windows\win.ini",
            "resource_ids": "b" * 40,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    padding = "p" * (MAX_REQUEST_BODY_BYTES + 1024)
    endpoints = (
        ("API", "/api/send-attachments", True),
        ("Webhook", "/webhook/" + ctx.token, False),
    )
    for label, path, authenticate in endpoints:
        status, _, response_body = ctx.api.request(
            "POST",
            path,
            body=body,
            headers={
                "Content-Type": "application/json",
                "X-Regression-Padding": padding,
            },
            authenticate=authenticate,
            body_delay_seconds=0.3,
        )
        require(
            status != 413,
            f"{label} large headers with a {len(body)}-byte body returned 413",
        )
        require(
            status == 400,
            f"{label} large-header mutual-exclusion request returned {status}, "
            "expected 400",
        )
        payload = json.loads(response_body.decode("utf-8"))
        require(
            "mutually exclusive" in str(payload.get("message", "")),
            f"{label} large-header request did not reach body validation",
        )
    ctx.assert_queue_empty("large-header mutual-exclusion rejection")
    ctx.logger.info(
        "PASS headers over %d bytes with a %d-byte body reached validation (400)",
        len(padding),
        len(body),
    )


def prepare_loopback_listen_case(ctx: CaseContext) -> None:
    ctx.listen_mode = "loopback"


@case("loopback_listen_binds_127_only", prepare_loopback_listen_case)
def test_loopback_listen(ctx: CaseContext) -> None:
    require(ctx.api is not None and ctx.port is not None, "API client missing")
    status, payload = ctx.api.json_request("GET", "/api/health")
    require(status == 200, f"loopback /api/health returned {status}, expected 200")
    require(payload.get("ok") is True, "loopback health ok flag is not true")

    addresses = local_non_loopback_ipv4()
    if not addresses:
        note = "non-loopback connect check skipped: no non-loopback IPv4 address"
        ctx.skipped_checks.append(note)
        ctx.logger.warning("SKIP %s", note)
        return
    for address in addresses:
        try:
            with socket.create_connection((address, ctx.port), timeout=5.0):
                pass
        except ConnectionRefusedError:
            ctx.logger.info(
                "PASS %s:%d refused while api-listen=loopback", address, ctx.port)
            continue
        except OSError as exc:
            raise AssertionError(
                f"connect to {address}:{ctx.port} failed with {exc!r}; "
                "expected connection refused") from exc
        raise AssertionError(
            f"api-listen=loopback accepted a connection on {address}:{ctx.port}")
    ctx.assert_queue_empty("loopback listen check")
    ctx.logger.info(
        "PASS api-listen=loopback served 127.0.0.1 only; refused on %s",
        ", ".join(addresses),
    )


@case("resource_upload_201")
def test_resource_upload(ctx: CaseContext) -> None:
    require(ctx.api is not None, "API client missing")
    filename = "baseline-resource.txt"
    payload = b"SuperLanguage safe regression resource\n"
    expected_sha = hashlib.sha256(payload).hexdigest()
    status, _, body = ctx.api.request(
        "POST",
        "/webhook/" + ctx.token + "/resources",
        body=payload,
        headers={
            "Content-Type": "application/octet-stream",
            "X-SuperTime-Filename": filename,
            "X-SuperTime-SHA256": expected_sha,
        },
        authenticate=False,
    )
    require(status == 201, f"resource upload returned {status}, expected 201")
    response = json.loads(body.decode("utf-8"))
    require(response.get("ok") is True, "resource upload ok flag is not true")
    resource_id = str(response.get("id", ""))
    require(
        re.fullmatch(r"[0-9a-f]{40}", resource_id) is not None,
        f"resource upload returned invalid id: {resource_id!r}",
    )
    require(response.get("name") == filename, "resource original filename changed")
    require(response.get("size") == len(payload), "resource response size changed")
    require(response.get("sha256") == expected_sha, "resource response SHA256 changed")

    spool = ctx.case_dir / "resource-spool"
    binary_path = spool / (resource_id + ".bin")
    metadata_path = spool / (resource_id + ".json")
    require(binary_path.is_file(), "uploaded resource .bin file is missing")
    require(binary_path.stat().st_size == len(payload), "uploaded .bin size differs")
    require(metadata_path.is_file(), "uploaded resource metadata file is missing")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    require(metadata.get("name") == filename, "metadata original filename changed")
    require(metadata.get("size") == len(payload), "metadata size differs")
    require(metadata.get("sha256") == expected_sha, "metadata SHA256 differs")

    legacy_status, _, legacy_body = ctx.api.request(
        "POST",
        "/webhook/" + ctx.token + "/resources",
        body=payload,
        headers={
            "Content-Type": "application/octet-stream",
            "X-Feather-Filename": "legacy-resource.txt",
            "X-Feather-SHA256": expected_sha,
        },
        authenticate=False,
    )
    require(
        legacy_status == 400,
        f"X-Feather-* upload headers returned {legacy_status}, expected 400",
    )
    legacy_response = json.loads(legacy_body.decode("utf-8"))
    require(
        legacy_response.get("ok") is False,
        "X-Feather-* upload headers unexpectedly succeeded",
    )
    spool_binaries = sorted(item.name for item in spool.glob("*.bin"))
    require(
        spool_binaries == [binary_path.name],
        f"rejected X-Feather-* upload changed the spool: {spool_binaries}",
    )

    ctx.assert_queue_empty("resource upload")
    ctx.logger.info(
        "PASS resource upload 201 id=%s name=%s size=%d; "
        "X-Feather-* headers rejected with 400",
        resource_id,
        filename,
        len(payload),
    )


def run_case(
    case_id: str,
    function: Callable[[CaseContext], None],
    run_root: Path,
    build_exe: Path,
    build_sha256: str,
    prepare: Optional[PreparationHook] = None,
) -> Dict[str, Any]:
    started = time.monotonic()
    context = CaseContext(case_id, run_root, build_exe, build_sha256)
    passed = False
    error_text: Optional[str] = None
    try:
        if prepare is not None:
            prepare(context)
        context.setup()
        function(context)
        context.stop_and_verify_exit()
        passed = True
    except Exception:
        error_text = traceback.format_exc()
        context.logger.error("CASE FAILED\n%s", error_text)
    finally:
        context.close(attempt_stop=not passed)

    duration = round(time.monotonic() - started, 3)
    result = {
        "case": case_id,
        "passed": passed,
        "duration_seconds": duration,
        "pid": context.isolated_process.pid,
        "stop_status": context.stop_status,
        "process_exit_verified": context.process_exit_verified,
        "process_exit_code": context.process_exit_code,
        "log": str(context.log_path),
    }
    if context.skipped_checks:
        result["skipped_checks"] = context.skipped_checks
    if error_text:
        result["error"] = error_text
    return result


def write_summary(run_root: Path, summary: Dict[str, Any]) -> None:
    path = run_root / "summary.json"
    path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-exe", required=True)
    parser.add_argument("--run-root", required=True)
    args = parser.parse_args(argv)

    if os.name != "nt":
        print("FAIL: Windows is required.", file=sys.stderr)
        return 1

    build_exe = Path(args.build_exe).resolve()
    run_root = Path(args.run_root).resolve()
    temp_base = (windows_temp_path() / "supertime-tests").resolve()
    if not str(run_root).lower().startswith(str(temp_base).lower() + os.sep):
        print(f"FAIL: unsafe run directory: {run_root}", file=sys.stderr)
        return 1
    if not build_exe.is_file() or build_exe.name.lower() != "superlanguage.exe":
        print(f"FAIL: build executable not found: {build_exe}", file=sys.stderr)
        return 1
    if run_root.exists():
        unexpected = [
            item for item in run_root.iterdir()
            if item.name != "verify.log"
        ]
        if unexpected:
            print(
                f"FAIL: run directory contains unexpected entries: {run_root}",
                file=sys.stderr,
            )
            return 1
    run_root.mkdir(parents=True, exist_ok=True)

    build_sha256 = sha256_file(build_exe)
    started = time.monotonic()
    summary: Dict[str, Any] = {
        "run_root": str(run_root),
        "build_exe": str(build_exe),
        "build_sha256": build_sha256,
        "build_size": build_exe.stat().st_size,
        "started_at": utc_now(),
        "policy": {
            "temporary_copy_only": "SuperLanguage.exe",
            "private_desktop": True,
            "job_active_process_limit": 1,
            "existing_superlanguage_required_absent": True,
            "valid_send_requests": 0,
            "wechat_send_calls": 0,
        },
        "cases": [],
    }

    print(
        f"RUN build={build_exe} sha256={build_sha256} size={summary['build_size']}")
    print(f"RUN root={run_root}")
    try:
        for case_id, function, prepare in CASE_FUNCTIONS:
            result = run_case(
                case_id, function, run_root, build_exe, build_sha256, prepare)
            summary["cases"].append(result)
            if not result["passed"]:
                raise RuntimeError(f"case failed: {case_id}")

        summary["passed"] = True
        summary["finished_at"] = utc_now()
        summary["duration_seconds"] = round(time.monotonic() - started, 3)
        write_summary(run_root, summary)
        stop_passes = sum(
            1 for item in summary["cases"]
            if item["stop_status"] == 202 and item["process_exit_verified"]
        )
        print(
            f"PASS cases={len(summary['cases'])}/{len(CASE_FUNCTIONS)} "
            f"stop_202_and_exit={stop_passes}/{len(summary['cases'])}")
        print(f"PASS summary={run_root / 'summary.json'}")
        return 0
    except Exception:
        summary["passed"] = False
        summary["finished_at"] = utc_now()
        summary["duration_seconds"] = round(time.monotonic() - started, 3)
        summary["error"] = traceback.format_exc()
        write_summary(run_root, summary)
        print(f"FAIL summary={run_root / 'summary.json'}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
