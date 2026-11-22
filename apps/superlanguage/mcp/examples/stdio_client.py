#!/usr/bin/env python3
"""Minimal stdio MCP client example for supertime_mcp.py.

By default this only performs initialize, tools/list, and ping. With --health
it also performs the read-only health call. It never calls a send tool.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict


def encode(message: Dict[str, Any]) -> bytes:
    return (
        json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        + b"\n"
    )


class Client:
    def __init__(self, server_script: Path):
        self.process = subprocess.Popen(
            [sys.executable, str(server_script)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            env=os.environ.copy(),
        )
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        self._next_id = 1

    def request(self, method: str, params: Dict[str, Any] | None = None) -> Dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        message: Dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
        }
        if params is not None:
            message["params"] = params
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        self.process.stdin.write(encode(message))
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("MCP server closed stdout unexpectedly")
        response = json.loads(line.decode("utf-8"))
        if response.get("id") != request_id:
            raise RuntimeError(f"Unexpected response id: {response.get('id')!r}")
        if "error" in response:
            raise RuntimeError(json.dumps(response["error"], ensure_ascii=False))
        return response["result"]

    def notify(self, method: str, params: Dict[str, Any] | None = None) -> None:
        message: Dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        assert self.process.stdin is not None
        self.process.stdin.write(encode(message))
        self.process.stdin.flush()

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        self.process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--health", action="store_true", help="Call the read-only health tool")
    parser.add_argument(
        "--server",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "supertime_mcp.py",
    )
    args = parser.parse_args()

    client = Client(args.server)
    try:
        initialized = client.request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "supertime-example", "version": "1.0"},
            },
        )
        client.notify("notifications/initialized")
        print("initialize:", json.dumps(initialized, ensure_ascii=False, indent=2))

        tools = client.request("tools/list", {})
        print(
            "tools:",
            ", ".join(tool["name"] for tool in tools["tools"]),
        )
        print("ping:", json.dumps(client.request("ping"), ensure_ascii=False))

        if args.health:
            health = client.request(
                "tools/call", {"name": "health", "arguments": {}}
            )
            print("health:", json.dumps(health, ensure_ascii=False, indent=2))
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
