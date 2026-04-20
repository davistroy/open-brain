#!/usr/bin/env python3
"""
Plaid Link Server — One-time bank account linking tool.

Serves a minimal web UI with the Plaid Link drop-in component. Troy runs this
in a browser to authenticate with each bank. After linking, the server prints
the access_token to the console with instructions to store in Bitwarden.

This is NOT a permanent service. Run it, link accounts, stop it.

Usage:
    python plaid-link-server.py                 # start server on port 8484
    python plaid-link-server.py --port 9090     # custom port

Prerequisites:
    pip install plaid-python flask pyyaml

Secrets:
    Plaid client_id and secret retrieved from Bitwarden Secrets Manager
    via bws CLI at startup. BWS_ACCESS_TOKEN must be set.
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import plaid  # type: ignore[import-untyped]
import yaml  # type: ignore[import-untyped]
from flask import Flask, Response, jsonify, request  # type: ignore[import-untyped]
from plaid.api import plaid_api  # type: ignore[import-untyped]
from plaid.model.country_code import CountryCode  # type: ignore[import-untyped]
from plaid.model.item_public_token_exchange_request import (  # type: ignore[import-untyped]
    ItemPublicTokenExchangeRequest,
)
from plaid.model.link_token_create_request import (
    LinkTokenCreateRequest,  # type: ignore[import-untyped]
)
from plaid.model.link_token_create_request_user import (  # type: ignore[import-untyped]
    LinkTokenCreateRequestUser,
)
from plaid.model.products import Products  # type: ignore[import-untyped]

sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("plaid-link-server")

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "financial" / "plaid-config.yaml"

# Track linked accounts during this session
linked_accounts: list[dict[str, Any]] = []


# ── Secrets ─────────────────────────────────────────────────────────────────


def get_bws_secret(secret_name: str) -> str:
    """Retrieve a secret value from Bitwarden Secrets Manager via bws CLI."""
    try:
        result = subprocess.run(
            ["bws", "secret", "list"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            log.error(f"bws failed: {result.stderr.strip()}")
            sys.exit(1)
        secrets: list[dict[str, Any]] = json.loads(result.stdout)
        for s in secrets:
            if s.get("key") == secret_name:
                return str(s["value"])
        log.error(f"Secret '{secret_name}' not found in Bitwarden Secrets Manager")
        sys.exit(1)
    except FileNotFoundError:
        log.error("bws CLI not found. Install it or check PATH.")
        sys.exit(1)
    except subprocess.TimeoutExpired:
        log.error("bws timed out — is BWS_ACCESS_TOKEN set?")
        sys.exit(1)


# ── Config & Plaid Client ──────────────────────────────────────────────────


def load_config() -> dict[str, Any]:
    """Load plaid-config.yaml."""
    if not CONFIG_PATH.exists():
        sys.exit(f"Config not found: {CONFIG_PATH}")
    result: dict[str, Any] = yaml.safe_load(CONFIG_PATH.read_text())
    return result


def create_plaid_client(cfg: dict[str, Any], client_id: str, secret: str) -> plaid_api.PlaidApi:
    """Create Plaid API client for the configured environment."""
    env_map: dict[str, Any] = {
        "sandbox": plaid.Environment.Sandbox,
        "development": plaid.Environment.Development,
        "production": plaid.Environment.Production,
    }
    env: str = cfg.get("environment", "development")
    if env not in env_map:
        sys.exit(f"Invalid Plaid environment: {env}")

    configuration = plaid.Configuration(
        host=env_map[env],
        api_key={
            "clientId": client_id,
            "secret": secret,
        },
    )
    api_client = plaid.ApiClient(configuration)
    return plaid_api.PlaidApi(api_client)


# ── HTML UI ─────────────────────────────────────────────────────────────────

LINK_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Brain — Plaid Account Linking</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e; color: #e0e0e0; padding: 2rem;
      max-width: 700px; margin: 0 auto;
    }
    h1 { color: #00d4aa; margin-bottom: 0.5rem; }
    .subtitle { color: #888; margin-bottom: 2rem; font-size: 0.9rem; }
    .accounts {
      display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;
      margin-bottom: 2rem;
    }
    .account-card {
      background: #16213e; border: 1px solid #333; border-radius: 8px;
      padding: 1rem; cursor: pointer; transition: all 0.2s;
    }
    .account-card:hover { border-color: #00d4aa; transform: translateY(-2px); }
    .account-card.linked {
      border-color: #00d4aa; background: #1a2e3e;
      cursor: default; opacity: 0.7;
    }
    .account-card .name { font-weight: 600; font-size: 1.1rem; }
    .account-card .type { color: #888; font-size: 0.85rem; margin-top: 0.25rem; }
    .account-card .status {
      margin-top: 0.5rem; font-size: 0.8rem;
      color: #666;
    }
    .account-card.linked .status { color: #00d4aa; }
    .log {
      background: #0d1117; border: 1px solid #333; border-radius: 8px;
      padding: 1rem; font-family: 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.85rem; max-height: 300px; overflow-y: auto;
      white-space: pre-wrap;
    }
    .log .success { color: #00d4aa; }
    .log .error { color: #ff6b6b; }
    .log .info { color: #64b5f6; }
    .instructions {
      background: #16213e; border: 1px solid #333; border-radius: 8px;
      padding: 1rem; margin-bottom: 2rem; font-size: 0.9rem; line-height: 1.6;
    }
    .instructions code {
      background: #0d1117; padding: 0.15rem 0.4rem; border-radius: 4px;
      font-size: 0.85rem;
    }
  </style>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
</head>
<body>
  <h1>Open Brain — Plaid Account Linking</h1>
  <p class="subtitle">Click an account card to open Plaid Link and authenticate.</p>

  <div class="instructions">
    <strong>Instructions:</strong><br>
    1. Click an account card below to open the Plaid Link UI.<br>
    2. Search for and authenticate with each bank.<br>
    3. The access token will be printed in the <strong>server console</strong>.<br>
    4. After linking all accounts, store tokens in Bitwarden as
       <code>dev/open-brain/plaid-tokens</code>.<br>
    5. Stop this server — it is not needed after linking.
  </div>

  <div class="accounts" id="accounts"></div>
  <div class="log" id="log">Waiting for account linking...</div>

  <script>
    const ACCOUNTS = __ACCOUNTS_JSON__;
    const accountsDiv = document.getElementById('accounts');
    const logDiv = document.getElementById('log');
    const linkedSet = new Set();

    function appendLog(msg, cls) {
      const span = document.createElement('span');
      span.className = cls || '';
      span.textContent = msg + '\\n';
      logDiv.appendChild(span);
      logDiv.scrollTop = logDiv.scrollHeight;
    }

    function renderAccounts() {
      accountsDiv.innerHTML = '';
      for (const [key, acct] of Object.entries(ACCOUNTS)) {
        const card = document.createElement('div');
        card.className = 'account-card' + (linkedSet.has(key) ? ' linked' : '');
        card.innerHTML = `
          <div class="name">${acct.name}</div>
          <div class="type">${acct.type} — ${acct.institution}</div>
          <div class="status">${linkedSet.has(key) ? 'Linked' : 'Click to link'}</div>
        `;
        if (!linkedSet.has(key)) {
          card.addEventListener('click', () => startLink(key, acct));
        }
        accountsDiv.appendChild(card);
      }
    }

    async function startLink(key, acct) {
      appendLog(`Starting Plaid Link for ${acct.name}...`, 'info');
      try {
        const resp = await fetch('/api/create_link_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_key: key, institution: acct.institution }),
        });
        const data = await resp.json();
        if (data.error) {
          appendLog(`Error: ${data.error}`, 'error');
          return;
        }

        const handler = Plaid.create({
          token: data.link_token,
          onSuccess: async (public_token, metadata) => {
            appendLog(`Plaid Link success for ${acct.name}. Exchanging token...`, 'info');
            try {
              const exResp = await fetch('/api/exchange_public_token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  public_token: public_token,
                  account_key: key,
                  institution: metadata.institution?.name || acct.institution,
                }),
              });
              const exData = await exResp.json();
              if (exData.error) {
                appendLog(`Exchange error: ${exData.error}`, 'error');
              } else {
                linkedSet.add(key);
                renderAccounts();
                appendLog(`${acct.name} linked successfully! Access token printed to server console.`, 'success');
                appendLog(`Linked: ${linkedSet.size}/${Object.keys(ACCOUNTS).length}`, 'info');
              }
            } catch (e) {
              appendLog(`Exchange failed: ${e.message}`, 'error');
            }
          },
          onExit: (err) => {
            if (err) appendLog(`Plaid Link exited with error: ${err.error_message || err.error_code}`, 'error');
            else appendLog(`Plaid Link closed for ${acct.name}.`, 'info');
          },
        });
        handler.open();
      } catch (e) {
        appendLog(`Failed to start Link: ${e.message}`, 'error');
      }
    }

    renderAccounts();
  </script>
</body>
</html>"""


# ── Flask App ───────────────────────────────────────────────────────────────


def create_app(cfg: dict[str, Any], client: plaid_api.PlaidApi) -> Flask:
    """Create and configure the Flask app."""
    app = Flask(__name__)

    product_map: dict[str, Any] = {
        "transactions": Products("transactions"),
        "balance": Products("balance"),
        "investments": Products("investments"),
    }
    products: list[Any] = [
        product_map[p] for p in cfg.get("products", ["transactions"]) if p in product_map
    ]

    country_map: dict[str, Any] = {"US": CountryCode("US")}
    country_codes: list[Any] = [
        country_map[c] for c in cfg.get("country_codes", ["US"]) if c in country_map
    ]

    @app.route("/")
    def index() -> str:
        accounts_json = json.dumps(cfg.get("accounts", {}))
        html = LINK_HTML.replace("__ACCOUNTS_JSON__", accounts_json)
        return html

    @app.route("/api/create_link_token", methods=["POST"])
    def create_link_token() -> tuple[Response, int] | Response:
        try:
            body: dict[str, Any] = request.get_json(silent=True) or {}
            account_key: str = body.get("account_key", "unknown")

            req = LinkTokenCreateRequest(
                user=LinkTokenCreateRequestUser(client_user_id=f"open-brain-{account_key}"),
                client_name="Open Brain",
                products=products,
                country_codes=country_codes,
                language="en",
            )
            resp = client.link_token_create(req)
            log.info(f"Link token created for account: {account_key}")
            return jsonify({"link_token": resp.link_token})
        except plaid.ApiException as e:
            err: dict[str, Any] = json.loads(e.body)
            log.error(f"Plaid error creating link token: {err}")
            return jsonify({"error": err.get("error_message", str(e))}), 400
        except Exception as e:
            log.error(f"Error creating link token: {e}")
            return jsonify({"error": str(e)}), 500

    @app.route("/api/exchange_public_token", methods=["POST"])
    def exchange_public_token() -> tuple[Response, int] | Response:
        try:
            body = request.get_json(silent=True) or {}
            public_token: str | None = body.get("public_token")
            account_key: str = body.get("account_key", "unknown")
            institution: str = body.get("institution", "unknown")

            if not public_token:
                return jsonify({"error": "public_token required"}), 400

            req = ItemPublicTokenExchangeRequest(public_token=public_token)
            resp = client.item_public_token_exchange(req)
            access_token: str = resp.access_token
            item_id: str = resp.item_id

            # Store in session list
            linked_accounts.append(
                {
                    "account_key": account_key,
                    "institution": institution,
                    "access_token": access_token,
                    "item_id": item_id,
                    "linked_at": datetime.now().isoformat(),
                }
            )

            # Print to console for manual Bitwarden storage
            print("\n" + "=" * 70)
            print(f"  ACCOUNT LINKED: {account_key} ({institution})")
            print(f"  Item ID:       {item_id}")
            print(f"  Access Token:  {access_token}")
            print("=" * 70)
            print("\n  Store in Bitwarden as: dev/open-brain/plaid-tokens")
            print(f"  Field name: {account_key}_access_token")
            print(f"  Field value: {access_token}")
            print(f"\n  Linked so far: {len(linked_accounts)}/{len(cfg.get('accounts', {}))}")

            if len(linked_accounts) == len(cfg.get("accounts", {})):
                print("\n" + "=" * 70)
                print("  ALL ACCOUNTS LINKED!")
                print("  Store all tokens in Bitwarden, then stop this server (Ctrl+C).")
                print("=" * 70)
                print("\n  Summary of all access tokens:")
                for acct in linked_accounts:
                    print(f"    {acct['account_key']}: {acct['access_token']}")
                print()

            log.info(f"Token exchanged for {account_key} ({institution})")
            return jsonify({"success": True, "account_key": account_key, "item_id": item_id})

        except plaid.ApiException as e:
            err = json.loads(e.body)
            log.error(f"Plaid error exchanging token: {err}")
            return jsonify({"error": err.get("error_message", str(e))}), 400
        except Exception as e:
            log.error(f"Error exchanging token: {e}")
            return jsonify({"error": str(e)}), 500

    return app


# ── Main ────────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description="Plaid Link Server — one-time bank account linking")
    ap.add_argument("--port", type=int, default=8484, help="Port to serve on (default: 8484)")
    args = ap.parse_args()

    log.info("Loading configuration...")
    cfg = load_config()

    log.info("Retrieving Plaid credentials from Bitwarden...")
    bw_keys: dict[str, Any] = cfg.get("bitwarden_keys", {})
    client_id = get_bws_secret(bw_keys.get("client_id_key", "plaid-client-id"))
    secret = get_bws_secret(bw_keys.get("secret_key", "plaid-secret"))
    log.info(f"Plaid credentials loaded (environment: {cfg.get('environment', 'development')})")

    log.info("Creating Plaid client...")
    client = create_plaid_client(cfg, client_id, secret)

    app = create_app(cfg, client)

    accounts: dict[str, Any] = cfg.get("accounts", {})
    print("\n" + "=" * 70)
    print("  PLAID LINK SERVER")
    print(f"  Environment: {cfg.get('environment', 'development')}")
    print(f"  Products:    {', '.join(cfg.get('products', []))}")
    print(f"  Accounts:    {len(accounts)} configured")
    for key, acct in accounts.items():
        print(f"    - {key}: {acct['name']} ({acct['type']})")
    print(f"\n  Open in browser: http://localhost:{args.port}")
    print("  Stop with Ctrl+C after all accounts are linked.")
    print("=" * 70 + "\n")

    app.run(host="0.0.0.0", port=args.port, debug=False)


if __name__ == "__main__":
    main()
