#!/usr/bin/env python3
"""Primary offline test entry point for the SuperLanguage MCP server."""

from __future__ import annotations

import unittest

from tests import test_supertime_mcp as suite


if __name__ == "__main__":
    unittest.main(module=suite, verbosity=2)
