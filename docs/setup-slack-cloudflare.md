# Slack Bot & Cloudflare Tunnel Setup

Setup guide for the two optional-but-recommended services: the Slack bot and the Cloudflare tunnel (`brain.k4jda.net`).

---

## Slack Bot Setup

### 1. Create the Slack App

Go to **https://api.slack.com/apps** → **Create New App** → **From scratch**

- App Name: `Open Brain`
- Workspace: your workspace

### 2. Configure OAuth Scopes

Under **OAuth & Permissions** → **Bot Token Scopes**, add:

| Scope | Why |
|-------|-----|
| `app_mentions:read` | Receive `@Open Brain` mentions |
| `chat:write` | Post messages and replies |
| `channels:history` | Read message history for context |
| `groups:history` | Same for private channels |
| `im:history` | DM history |
| `im:write` | Start DMs |
| `reactions:write` | Add emoji reactions as acknowledgments |
| `channels:read` | List channels |
| `users:read` | Resolve user IDs to names |

### 3. Enable Socket Mode

Under **Socket Mode** → toggle **Enable Socket Mode** ON.

Click **Generate an App-Level Token**:
- Token Name: `open-brain-socket`
- Scope: `connections:write`
- Click **Generate**
- **Copy the `xapp-...` token** — this is `SLACK_APP_TOKEN`

### 4. Enable Event Subscriptions

Under **Event Subscriptions** → toggle **Enable Events** ON.

Under **Subscribe to bot events**, add:
- `app_mention` — fires when someone `@Open Brain`s the bot
- `message.im` — DMs to the bot

No Request URL needed — Socket Mode handles delivery without a public endpoint.

### 5. Create Slash Commands (optional)

Under **Slash Commands** → **Create New Command** for each:

| Command | Short Description |
|---------|-------------------|
| `/brief` | Generate or show weekly brief |
| `/bet` | Track a prediction/bet |

Leave Request URL blank (Socket Mode handles it).

### 6. Install to Your Workspace

Under **OAuth & Permissions** → **Install to Workspace** → Allow.

After install, copy the **Bot User OAuth Token** (`xoxb-...`) — this is `SLACK_BOT_TOKEN`.

### 7. Store Tokens

On homeserver, add to `/mnt/user/appdata/open-brain/.env.secrets`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Optionally store in Bitwarden for safekeeping:

```bash
~/bin/bws.exe secret create SLACK_BOT_TOKEN "xoxb-..." --project-id <ai-work-project-id>
~/bin/bws.exe secret create SLACK_APP_TOKEN "xapp-..." --project-id <ai-work-project-id>
```

### 8. Build and Start

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain
git pull
docker compose build slack-bot
docker compose up -d slack-bot
docker logs open-brain-slack-bot --follow
# Expected: "⚡️ Bolt app is running! Connected via Socket Mode"
```

### 9. Invite and Test

In your Slack workspace, invite the bot to a channel:

```
/invite @Open Brain
```

Try a capture:
```
@Open Brain Decided to use Tailscale for remote access instead of a VPN
```
→ Bot replies confirming the capture was saved.

Try a search:
```
@Open Brain ? what decisions have I made about infrastructure
```
→ Bot replies with search results.

Try a command:
```
@Open Brain !help
```
→ Full command list.

---

### Bot Interaction Reference

The bot understands three interaction styles in any channel it's in:

**Natural language capture** — anything that reads like a statement:
```
@Open Brain Realized that ACT-R temporal decay needs tuning once search history builds
```

**Natural language query** — anything that reads like a question (or prefix with `?`):
```
@Open Brain What did I decide about the database schema?
@Open Brain ? embedding model choices
```

**Explicit commands** — prefix with `!`:

| Command | Description |
|---------|-------------|
| `!stats` | Brain statistics (counts, pipeline health) |
| `!recent [N]` | Last N captures (default 5, max 20) |
| `!retry <id>` | Retry a failed capture pipeline |
| `!brief` | Generate weekly brief now |
| `!brief last` | Show last generated brief |
| `!entities` | List all known entities |
| `!entity <name>` | Entity detail + linked captures |
| `!entity merge <n1> <n2>` | Merge n1 into n2 |
| `!entity split <name> <alias>` | Split alias out of entity |
| `!trigger add "text"` | Create a semantic trigger |
| `!trigger list` | List all triggers with status |
| `!trigger delete <n>` | Deactivate a trigger by name/id |
| `!trigger test "text"` | Test query against existing captures |
| `!pipeline status` | Pipeline queue health |
| `!board quick` | Start quick board check (reply in thread to continue) |
| `!board quarterly` | Start quarterly review (reply in thread to continue) |
| `!board resume <id>` | Resume a paused session |
| `!board status` | List active/paused sessions |
| `!board pause` | _(in session thread)_ Pause session |
| `!board done` | _(in session thread)_ Complete + generate summary |
| `!board abandon` | _(in session thread)_ Abandon session |
| `!bet list [status]` | List bets (pending/correct/incorrect/ambiguous) |
| `!bet add <conf> <statement>` | Create bet (conf = 0.0–1.0) |
| `!bet expiring [N]` | Bets expiring in next N days (default 7) |
| `!bet resolve <id> <outcome>` | Resolve: correct \| incorrect \| ambiguous |
| `!help` | This command list |

---

## Cloudflare Tunnel Setup

Gives you `https://brain.k4jda.net` — HTTPS, public internet, no port forwarding needed.

### 1. Create the Tunnel

Go to **Cloudflare Dashboard** (dash.cloudflare.com) → your account → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**.

- Connector: **Cloudflared**
- Tunnel name: `brain-k4jda-net`
- Click **Save tunnel**

On the next screen (connector install), **ignore the install steps** — cloudflared runs in Docker. Copy the tunnel token — it's the long base64 string shown in the `--token` argument:

```
eyJhIjoiMGU5ZjI3...very long...
```

Click **Next**.

### 2. Configure Public Hostnames

On the **Public Hostnames** tab, add two routes:

**Route 1 — Web Dashboard (catch-all):**

| Field | Value |
|-------|-------|
| Subdomain | `brain` |
| Domain | `k4jda.net` |
| Path | _(leave blank)_ |
| Type | `HTTP` |
| URL | `web:80` |

**Route 2 — MCP Endpoint:**

| Field | Value |
|-------|-------|
| Subdomain | `brain` |
| Domain | `k4jda.net` |
| Path | `/mcp` |
| Type | `HTTP` |
| URL | `core-api:3000` |

> The config file at `config/cloudflare/tunnel.yaml` defines these same routes for the Docker container. Dashboard routes and YAML routes both work — dashboard takes precedence if both are set.

Click **Save tunnel**.

### 3. Store the Token

On homeserver, update `.env.secrets`:

```
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiMGU5ZjI3...
```

And update `.env` (docker-compose variable substitution — change from `placeholder`):

```
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiMGU5ZjI3...
```

Store in Bitwarden:

```bash
~/bin/bws.exe secret create CLOUDFLARE_TUNNEL_TOKEN "eyJhIjoiMGU5ZjI3..." --project-id <ai-work-project-id>
```

### 4. Start cloudflared

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain
git pull
docker compose up -d cloudflared
docker logs open-brain-cloudflared --follow
# Expected:
#   Registered tunnel connection connIndex=0
#   Connection registered connIndex=0 location=...
```

### 5. Verify

From your dev machine (not the homeserver):

```bash
# Web dashboard
curl -I https://brain.k4jda.net
# Expected: HTTP/2 200

# Core API health (via nginx proxy)
curl https://brain.k4jda.net/health
# Expected: {"status":"healthy",...}

# MCP endpoint (use MCP_API_KEY from .env.secrets)
curl -H "Authorization: Bearer <MCP_API_KEY>" https://brain.k4jda.net/mcp
# Expected: MCP capabilities response (JSON)
```

### 6. Connect Claude Desktop to MCP

Add to your Claude Desktop config:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "open-brain": {
      "url": "https://brain.k4jda.net/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>"
      }
    }
  }
}
```

`MCP_API_KEY` is the value in `.env.secrets` on the homeserver (currently `open-brain-mcp-dev-key`). Rotate it before connecting external clients:

```bash
# On homeserver — generate a strong key and update .env.secrets
openssl rand -hex 32
```

Restart Claude Desktop. The `open-brain` MCP server will appear in the tools list. You can then ask Claude things like:

> *"Search my brain for decisions about database architecture"*
> *"What was my last weekly brief?"*
> *"Create a capture: decided to standardize on pnpm workspaces for all projects"*

---

## Traffic Routing Summary

```
Internet
  └─ https://brain.k4jda.net
       └─ cloudflared ──▶ web:80 (nginx)
                            ├─ /api/*  ──proxy──▶ core-api:3000
                            ├─ /mcp   ──direct──▶ core-api:3000
                            └─ /*     ──serves──▶ Vite React SPA

Slack workspace
  └─ @Open Brain <message>
       └─ Socket Mode ──▶ slack-bot container
                            └─ http://core-api:3000 (internal Docker network)

Claude Desktop
  └─ MCP tool call
       └─ https://brain.k4jda.net/mcp ──▶ cloudflared ──▶ core-api:3000
```
