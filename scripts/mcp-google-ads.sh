#!/usr/bin/env bash
# Launches Google's official, read-only Google Ads MCP server (googleads/google-ads-mcp)
# for Claude Code, reusing the fleet's own Google Ads credentials from .env.
#
# Replaces @samihalawa/google-ads-mcp-server, whose latest release (1.4.0) dies at
# startup with a SyntaxError in its own server.js, so every session reported
# "google-ads failed to connect".
#
# Credentials never touch disk: the launcher builds OAuth user credentials in memory
# from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN and hands them
# to the server by standing in for google.auth.default(), which is the only place the
# server looks for credentials in stdio mode. GOOGLE_ADS_TOKEN becomes the developer
# token, GOOGLE_ADS_LOGIN_CUSTOMER_ID the login-customer-id when set. Same variables
# lib/google-ads.js reads, so one reauth (scripts/reauth-google.js) fixes both.
#
# The server lives in a private venv, created on first run. stdout is the MCP
# channel, so everything here that could print goes to stderr.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIN="0.0.3"
VENV="${GOOGLE_ADS_MCP_VENV:-$HOME/.local/share/google-ads-mcp/venv}"

if [ ! -x "$VENV/bin/google-ads-mcp" ]; then
  python3 -m venv "$VENV" >&2
  "$VENV/bin/pip" install -q "google-ads-mcp==$PIN" >&2
fi

# Passed with -c, never a heredoc: a heredoc would take over stdin, which is the MCP channel.
exec "$VENV/bin/python" -c '
import os, sys

env = {}
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"\x27":
            v = v[1:-1]
        env[k.strip()] = v

missing = [k for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_ADS_TOKEN") if not env.get(k)]
if missing:
    sys.exit("mcp-google-ads: missing in .env: " + ", ".join(missing))

os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"] = env["GOOGLE_ADS_TOKEN"]
if env.get("GOOGLE_ADS_LOGIN_CUSTOMER_ID"):
    os.environ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"] = env["GOOGLE_ADS_LOGIN_CUSTOMER_ID"]

import google.auth
from google.oauth2.credentials import Credentials

creds = Credentials(
    token=None,
    refresh_token=env["GOOGLE_REFRESH_TOKEN"],
    client_id=env["GOOGLE_CLIENT_ID"],
    client_secret=env["GOOGLE_CLIENT_SECRET"],
    token_uri="https://oauth2.googleapis.com/token",
)
google.auth.default = lambda *a, **k: (creds, None)

from ads_mcp.server import run_server
run_server()
' "$ROOT/.env"
