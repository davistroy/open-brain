# Slack Bot & Cloudflare Tunnel Setup

Setup guide for the two optional-but-recommended services: the Slack bot and the Cloudflare tunnel (`brain.troy-davis.com`).

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

Try a capture (plain message in the channel, no @mention — the bot listens to all messages):
```
Decided to use Tailscale for remote access instead of a VPN
```
→ Bot replies confirming the capture was saved.

Try a search via @mention (`@Open Brain` mentions always route to the query handler):
```
@Open Brain what decisions have I made about infrastructure?
```
→ Bot replies with search results.

Try a command (plain message or DM — commands use `!` prefix without @mention):
```
!help
```
→ Full command list in a thread reply.

> **Note on @mention vs plain message**: `@Open Brain` mentions are always treated as queries/searches. For captures and commands, send plain messages in the channel (the bot listens to all channel messages) or use DMs. The bot won't double-respond to mentions.

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

Gives you `https://brain.troy-davis.com` — HTTPS, public internet, no port forwarding.

MCP access goes through LiteLLM at `https://llm.troy-davis.com/mcp` rather than directly through the tunnel. LiteLLM's MCP gateway is already live and tested — it just needs Open Brain registered as a source.

### Architecture

```
Claude Desktop ──▶ https://llm.troy-davis.com/mcp  (LiteLLM MCP gateway)
                        └─ proxies to ──▶ https://brain.troy-davis.com/mcp
                                              └─ cloudflared ──▶ web:80 (nginx)
                                                                    └─ /mcp ──▶ core-api:3000

Browser ──▶ https://brain.troy-davis.com
                └─ cloudflared ──▶ web:80 (nginx)
                                    ├─ /api/*  ──▶ core-api:3000
                                    ├─ /mcp    ──▶ core-api:3000
                                    └─ /*      ──▶ Vite React SPA
```

### 1. Create the Tunnel

Go to **Cloudflare Dashboard** (dash.cloudflare.com) → your account → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**.

- Connector: **Cloudflared**
- Tunnel name: `open-brain`
- Click **Save tunnel**

On the next screen (connector install), **ignore the install steps** — cloudflared runs in Docker. Copy the tunnel token — the long base64 string in the `--token` argument:

```
eyJhIjoiMGU5ZjI3...very long...
```

Click **Next**.

### 2. Configure Public Hostname

On the **Public Hostnames** tab you can skip adding routes here — the `config/cloudflare/tunnel.yaml` file already defines the routing and cloudflared reads it at startup. Dashboard-configured hostnames and YAML-configured ingress are two ways to do the same thing; the YAML file is what's active in this stack.

Click **Save tunnel** and proceed — you only need the token from this step.

### 3. Store the Token

On homeserver, update both files:

```bash
# /mnt/user/appdata/open-brain/.env.secrets
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoiMGU5ZjI3...

# /mnt/user/appdata/open-brain/.env  (change from "placeholder")
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
docker compose build web   # picks up the nginx /mcp proxy fix
docker compose up -d web cloudflared
docker logs open-brain-cloudflared --follow
# Expected:
#   Registered tunnel connection connIndex=0
#   Connection registered connIndex=0 location=...
```

### 5. Verify the Tunnel

From your dev machine:

```bash
# Web dashboard loads
curl -I https://brain.troy-davis.com
# Expected: HTTP/2 200, Content-Type: text/html

# API via tunnel — nginx proxies /api/* to core-api
curl https://brain.troy-davis.com/api/v1/captures?limit=1
# Expected: {"captures":[...],"total":...}

# MCP via tunnel — nginx proxies /mcp to core-api (use MCP_API_KEY from .env.secrets)
curl -X POST https://brain.troy-davis.com/mcp \
  -H "Authorization: Bearer <MCP_API_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# Expected: event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}
```

> `/health` is only served on the internal Docker network (`localhost:3002/health`). External health checks use `/api/v1/captures?limit=1` or the LiteLLM health endpoint directly.

### 6. Register Open Brain in LiteLLM's MCP Gateway

> **Why**: `llm.troy-davis.com/mcp` is already a working LiteLLM MCP gateway (tested). Adding Open Brain there means Claude Desktop connects to one endpoint that can aggregate multiple MCP servers over time.

On the machine running LiteLLM, edit the LiteLLM `config.yaml` — add an `mcp_servers` section:

```yaml
mcp_servers:
  open-brain:
    url: "https://brain.troy-davis.com/mcp"
    transport: "streamable_http"
    auth_type: "bearer_token"
    auth_value: "<MCP_API_KEY>"        # value from Open Brain's .env.secrets
```

Then restart LiteLLM to pick up the config.

Verify Open Brain's tools appear in the LiteLLM MCP server:

```bash
curl -X POST https://llm.troy-davis.com/mcp/ \
  -H "Authorization: Bearer <YOUR_LITELLM_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Expected: tools array containing search, get_capture, create_capture, etc.
```

### 7. Connect Claude Desktop

> **MCP_API_KEY** is in Open Brain's `.env.secrets` on the homeserver (`open-brain-mcp-dev-key`). Rotate it first with `openssl rand -hex 32` if you haven't.

Add to your Claude Desktop config:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "open-brain": {
      "url": "https://llm.troy-davis.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_LITELLM_KEY>"
      }
    }
  }
}
```

Note: you authenticate with your **LiteLLM key** here (not the Open Brain MCP key directly). LiteLLM holds the Open Brain MCP key in its server-side config and handles the downstream auth for you.

Restart Claude Desktop. You can then ask Claude things like:

> *"Search my brain for decisions about database architecture"*
> *"What was my last weekly brief?"*
> *"Create a capture: decided to standardize on pnpm workspaces for all projects"*

---

## Full Traffic Routing Summary

```
Internet — Browser
  └─ https://brain.troy-davis.com
       └─ cloudflared ──▶ web:80 (nginx)
                            ├─ /api/*  ──proxy──▶ core-api:3000
                            ├─ /mcp    ──proxy──▶ core-api:3000
                            └─ /*      ──serves──▶ Vite React SPA

Internet — Claude Desktop (MCP)
  └─ https://llm.troy-davis.com/mcp
       └─ LiteLLM MCP gateway
            └─ open-brain upstream ──▶ https://brain.troy-davis.com/mcp
                                          └─ cloudflared ──▶ core-api:3000

Slack workspace
  └─ @Open Brain <message>
       └─ Socket Mode ──▶ slack-bot container
                            └─ http://core-api:3000 (internal Docker network)
```
