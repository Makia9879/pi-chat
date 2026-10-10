# pi-chat

A pi extension that bridges Discord, Telegram, and Feishu/Lark chats to a pi session. Tools run either in a per-channel [Gondolin](https://github.com/earendil-works/gondolin) micro-VM (default) or directly on the host in explicit **local mode**, with configurable workspaces, persistent storage, memory, and skills.

> **About this fork** — This fork of [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat) adds:
>
> - **Feishu / Lark channel** — long-connection (WebSocket, no public URL needed, default) or HTTP callback mode; DMs and @-mention group chats.
> - **Status reactions on Feishu** — a `Typing` reaction while the agent works, removed on completion, plus `CrossMark` on failure (disable with `reactions: false` or `FEISHU_REACTIONS=false`).
> - **Local mode** — `runtime.mode: "local"` runs read/write/edit/bash directly on the host without the Gondolin micro-VM / QEMU.
> - **Configurable workspace** — `runtime.workspaceDir` at global/account/channel level (local default `/workspace`), plus standalone `--chat-local --chat-workspace`.
> - **`/model` chat command** — list available models or switch the worker's model from chat.
>
> 本 fork 增加了飞书/Lark 通道（默认长连接，无需公网回调地址）、飞书状态表情、不依赖 microVM 的本地运行模式、可配置工作空间（默认 `/workspace`）以及聊天内 `/model` 切换模型。配置说明见 [docs/configuration.md](docs/configuration.md)，开发文档见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## Quick Start

```bash
# Install from source (local Pi packages do not install their own dependencies)
git clone https://github.com/Makia9879/pi-chat.git
cd pi-chat
npm ci
pi install "$(pwd)"
# or
pi -e /path/to/pi-chat

# Configure accounts and channels
/chat-config

# Connect
/chat-connect
```

### Requirements

- Node.js and pi; local mode requires `/bin/bash` on Linux/macOS (tested with Node 22)
- **Gondolin mode only:** Node ≥23.6, [QEMU](https://www.qemu.org/) (`brew install qemu` on macOS), and a guest image (downloaded on first connect)
- A Discord/Telegram bot token, or a Feishu/Lark self-built app with Bot capability
- `tmux` only for multi-channel worker orchestration
- Feishu: outbound access to the Open Platform for WebSocket long connection, or an HTTPS callback URL if `eventMode` is `http`

---

## Features

- **Discord server channels**, **Telegram DMs/groups**, and **Feishu/Lark chats**
- **Selectable execution mode** — isolated Gondolin micro-VM, or unsandboxed local host processes
- **Configurable host workspace** — local mode defaults to `/workspace`; VM guest path stays `/workspace`
- **Persistent workspace** and **shared storage** across sessions
- **Streamed preview** responses with edit-in-place
- **Reply-to-trigger** — bot replies are attached to the triggering message
- **Durable memory** — account-wide and channel-specific memory files
- **Skills** — agent-created reusable tools, auto-discovered and injected into the prompt
- **Encrypted secret exchange** — securely pass credentials via browser-based encryption
- **Remote control** — stop, compact, new session, and status via chat commands
- **Chat history** tool for searching older messages
- **File attachments** — send and receive files between chat and the VM

---

## Setup

### Discord

1. Create a bot at [Discord Developer Portal](https://discord.com/developers/applications)
2. Enable **Message Content Intent** under Bot settings
3. Run `/chat-config` → Create account → Discord
4. Enter your bot token
5. Invite the bot to a server (the setup flow provides the invite URL)
6. Select a server and configure channels

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Run `/chat-config` → Create account → Telegram
3. Enter your bot token
4. Add DMs or groups through the guided setup

### Feishu / Lark

1. Create a **self-built app** at [Feishu Open Platform](https://open.feishu.cn/) or [Lark Developer](https://open.larksuite.com/). Enable **Bot**, grant the required permissions, and publish a version available to the intended users.
2. Grant `im:message:send_as_bot`, permission to receive group @mentions (`im:message.group_at_msg:readonly`) and/or direct messages (`im:message.p2p_msg:readonly`). Receiving every group message additionally needs `im:message.group_msg`; outbound file uploads need the platform's image/file resource permission (`im:resource`). Status reactions need `im:message.reactions:write_only`. Permissions and event subscriptions must be included in the published version.
3. Run `/chat-config` → Create account → **Feishu / Lark**. New accounts default to **WebSocket long connection**: choose the region and enter **App ID** and **App Secret**. No public callback URL, verification token, or local port is required. Credentials are stored in `~/.pi/agent/chat/config.json` with mode `0600`; keep this file private. Choose **HTTP callback** instead if you already have a public request URL; that path still asks for Verification Token, optional Encrypt Key, and a local port. When editing an HTTP account, an empty Encrypt Key keeps the current value and `-` disables encryption.
4. Add a channel by **chat_id** (`oc_...`), available via the platform API/debug console. For direct messages, set `dm: true`. For access restrictions use user **open_id** (`ou_...`), not display names or union IDs. Invite the bot to the group.
5. In the Feishu/Lark console open **Events & Callbacks**. For WebSocket, set the subscription mode to **Receive events through persistent connection** (长连接) and do not configure a request URL. For HTTP, choose developer-server callbacks and point the public HTTPS URL at the local listener (default `127.0.0.1:3000/feishu/events`), preserving the raw body and `X-Lark-*` headers. Subscribe to **`im.message.receive_v1`** and publish the app version. This is **not** a custom incoming-webhook bot URL.
6. Connect with `/chat-connect <account/channel>` (or `pi --chat-conversation <account/channel>`). WebSocket mode waits for the official SDK handshake. Accounts that omit `eventMode` stay on HTTP so old configs keep working.
7. Send a DM or @mention the bot. Text and rich-text posts are received; pi's replies are sent as chunked plain text, replying to the trigger message. `chat_attach` uploads outbound files. Inbound images/files currently appear as unsupported-message markers, not downloaded attachments. While a turn runs, the triggering message gets a `Typing` reaction; failures get `CrossMark` only after that reaction is removed. Set `reactions: false` or `FEISHU_REACTIONS=false` to disable. Previews are not provided for Feishu.

HTTP mode requires a Verification Token. When Encrypt Key is set, callbacks are AES-decrypted and event signatures/timestamps are checked (five-minute tolerance). WebSocket events are authenticated when the SDK connects and then arrive as plaintext; token and encrypt key are optional and unused for receive. Duplicate message IDs are suppressed; recent logged IDs are loaded on reconnect, and a long-connection rebuild keeps that set so a redelivery is not processed twice. A health watchdog recreates the WebSocket client if the socket closes or no inbound frame arrives within the stale window; thresholds and `/status` fields are in [docs/configuration.md](docs/configuration.md). There is no offline history backfill: delivery while disconnected relies on Feishu's retry window.

**Deployment scope:** one active Feishu channel per app. Long connection is cluster delivery, so a second client of the same app does not reliably receive events. HTTP workers also need distinct listener ports and public URLs. `/chat-spawn-all` rejects a repeated app id, and repeated HTTP ports, instead of silently losing messages. Discord/Telegram worker behavior is unchanged.

See [configuration examples](docs/configuration.md) for a complete JSON example and local-mode startup commands.

---

## Commands

| Command | Description |
|---------|-------------|
| `/chat-config` | Configure accounts, channels, and secrets |
| `/chat-connect` | Connect to a configured channel |
| `/chat-disconnect` | Disconnect the current channel |
| `/chat-status` | Show connection status, model, usage, context |
| `/chat-list` | List configured channels |
| `/chat-spawn-all` | Spawn every configured channel in detached tmux/pi sessions |
| `/chat-spawn-all --restart` | Restart those tmux/pi sessions |
| `/chat-workers` | Show managed tmux/pi worker status |
| `/chat-open-all` | Open running workers in a tiled tmux dashboard |
| `/chat-kill-all` | Kill all managed tmux/pi workers |
| `/chat-new` | Start a new pi session, keeping the chat connection |
| `/chat-send <account/channel> [--file path]... [--image path]... [text]` | Push text, files, or images to a configured channel without connecting or locking it |

Workers also write status snapshots every 15 seconds under `~/.pi/agent/chat/worker-status/`. The `chat_workers` tool exposes the same status to an orchestrating pi agent.

---

## Remote Control

Users in the connected chat can send these commands (with or without a leading `/`, and with or without mentioning the bot). `/model` only lists providers that already have credentials. An unknown pattern returns nearby suggestions instead of switching. The change applies to this pi session, not the global default; a turn already in flight finishes on the previous model.

Slash commands run in the worker's pi session. If `access.allowedUserIds` is set, only those users can run them. If it is empty, only read-only commands work: `/help`, `/status`, `/session`, `/changelog`, and `/hotkeys`. `/help` also lists installed extension commands, skills, and prompt templates. Host management commands such as `/chat-config`, `/chat-kill-all`, `/chat-spawn-all`, and `/chat-disconnect` are not forwarded. `/login`, `/logout`, `/quit`, `/settings`, `/scoped-models`, `/trust`, `/share`, `/copy`, `/import`, `/bug`, and `/llama` are rejected with a reason.

| Command | Effect |
|---------|--------|
| `stop` | Abort the current turn |
| `status` | Show model, usage, context stats |
| `model` | List the current model and authenticated models |
| `model <pattern>` | Switch this worker's session model. Examples: `grok-4.7`, `xai/grok-4.7:high` |
| `thinking [level]` | Show or set the thinking level |
| `compact [note]` | Compact context, optionally with instructions |
| `new` | Start a new pi session |
| `name [text]` | Show or set the session name |
| `session` | Session info plus the status/cost summary |
| `resume` / `fork` / `tree` | Numbered picker (Feishu also sends a button card) |
| `clone` / `reload` | Confirm with `1`/`2` or a card button |
| `export` | Send the session JSONL back as an attachment |
| `skill:<name> [args]` | Expand a skill and send it as the next prompt |
| `help` | List chat, builtin, skill, template, and extension commands |

---

## Storage Layout

Everything lives under `~/.pi/agent/chat/`:

```
~/.pi/agent/chat/
├── config.json                          # Accounts, channels, secrets
├── cache/                               # Discovery cache
└── accounts/<account>/
    ├── shared/                          # Mounted as /shared in VM
    │   ├── memory.md                    # Account-wide persistent memory
    │   └── skills/                      # Account-wide skills
    └── channels/<channel>/
        ├── channel.jsonl                # Chat log
        ├── .lock                        # Runtime lock
        ├── workspace/                   # Mounted as /workspace in VM
        │   ├── memory.md                # Channel-specific persistent memory
        │   ├── skills/                  # Channel-specific skills
        │   ├── incoming/                # Downloaded attachments
        │   ├── .secrets/                # Encrypted secrets
        │   └── SYSTEM.md                # Environment modification log
        └── gondolin/                    # VM state
            └── session.json
```

---

## Execution Mode and Workspace

Use `/chat-config` → **Runtime / workspace** globally, per account, or per configured channel. You can also edit `~/.pi/agent/chat/config.json`:

```json
{
  "runtime": { "mode": "local", "workspaceDir": "/workspace" },
  "accounts": {}
}
```

Each field inherits independently: **channel → account → global → default**. Reconnect after changes. `workspaceDir` must be an absolute host path and is created if missing; it must be writable by the pi user. Local mode defaults to `/workspace`. Gondolin mode defaults to the existing per-channel stored workspace; a configured host directory is mounted at the unchanged guest path `/workspace`. Memory, incoming files, skills, secrets, tool cwd, and prompt paths follow the resolved workspace. Existing data is **not migrated** when you change the directory.

Workers created by `/chat-spawn-all` start pi in the resolved host workspace, rather than the orchestrator's cwd. When connecting an already-running interactive pi, tools use the selected workspace, but pi's own project-resource discovery still uses its original process cwd. Start pi from the desired directory to align both. Use different workspaces for different channels unless you intentionally want them to share files, memory, and runtime secrets. Deleting a channel does not delete an external configured workspace.

**Local mode is not a sandbox.** Remote users can execute commands with the host user's filesystem/network permissions. Only enable it for trusted users, configure `allowedUserIds`, and preferably run a dedicated unprivileged OS account. Bash receives a minimal environment (PATH, workspace HOME, LANG), not the pi process's API keys; this does **not** prevent host files from being accessed. Gondolin HTTP-hook secrets are rejected in local mode because their host-scoped substitution cannot be enforced. Runtime secret exchange remains supported and writes plaintext files in the workspace.

There is no automatic fallback from Gondolin to local: select local explicitly if QEMU/VM assets are unavailable. Local mode neither imports Gondolin nor checks/downloads VM assets. If `--chat-local` fails to start, file and bash tools stay unavailable instead of silently using pi's original directory.

### Standalone local session (no chat credentials needed)

After installing the source package:

```bash
cd /workspace
pi --chat-local --chat-workspace /workspace --model openai/gpt-6-luna:low

# One-shot smoke test; uses the same local tool backend without a messaging service
pi --chat-local --chat-workspace /workspace --model openai/gpt-6-luna:low \
  --no-session -p 'Use bash to run pwd, then reply with LOCAL_OK and the directory.'
```

`--chat-local` cannot be combined with `--chat-conversation`. `--chat-workspace` applies only to standalone local sessions; without it, global `runtime.workspaceDir` is used, then `/workspace`. Standalone sessions do not connect channels or inject channel memory. Model credentials are configured in pi separately (`/login` or the relevant provider API key).

### Gondolin VM Environment

In the default `gondolin` mode, each connection starts a micro-VM with:

- **Alpine Linux** with bash pre-installed
- `/workspace` → channel workspace directory
- `/shared` → account shared directory
- Tools: `read`, `write`, `edit`, `bash`
- All outbound HTTP/TLS open by default

The agent sees `/workspace` as its working directory.

---

## Memory

Two persistent memory files, injected into the system prompt on every turn:

| File | VM Path | Scope |
|------|---------|-------|
| Account memory | `/shared/memory.md` | Shared across all channels for this account |
| Channel memory | `/workspace/memory.md` | Specific to this channel |

The agent is instructed to write durable facts and preferences to these files when asked to remember something. Account-wide goes to `/shared/memory.md`, channel-specific to `/workspace/memory.md`.

---

## Skills

The agent can create reusable tools as skills, following the [Agent Skills standard](https://agentskills.io):

- **Account-wide:** `/shared/skills/`
- **Channel-specific:** `/workspace/skills/`

A skill is either a single `.md` file (e.g. `skills/foo.md`) or a directory with `SKILL.md` plus supporting files (e.g. `skills/foo/SKILL.md`, `skills/foo/run.sh`).

Each skill needs YAML frontmatter:

```yaml
---
name: skill-name
description: Short description of what this skill does
---
```

Skills are automatically discovered and listed in the system prompt. The agent reads the full skill file before using it.

---

## Secrets

### Config Secrets (Gondolin HTTP hooks)

Configure secrets at three levels via `/chat-config`:

- **Global** — shared across all accounts
- **Per account** — shared across channels of that account
- **Per channel** — specific to one channel

Each secret has a value and allowed host patterns. Gondolin replaces placeholder env vars with real values only for outbound HTTP requests to allowed hosts. The agent never sees the real secret value.

### Runtime Secrets (encrypted exchange)

For credentials the agent needs at runtime (API keys for skills, OAuth files, etc.):

1. Agent calls the `chat_request_secret` tool
2. A link to `pi.dev/secret` is sent to the chat with an embedded public key
3. User clicks, pastes the secret, and gets an encrypted blob
4. User pastes the blob back into chat
5. pi-chat decrypts it (RSA-OAEP + AES-256-GCM) and stores it at `/workspace/.secrets/<name>`
6. Agent is notified and can use the file

The encrypted blob is useless without the ephemeral private key held in pi-chat's memory.

---

## Tools

| Tool | Description |
|------|-------------|
| `read` | Read files (selected VM or local backend) |
| `write` | Create/overwrite files |
| `edit` | Precise in-place edits |
| `bash` | Execute `/bin/bash` in the selected backend |
| `chat_history` | Search older messages from the chat log |
| `chat_attach` | Queue files to send with the next reply |
| `chat_request_secret` | Request a secret from the user via encrypted exchange |
| `chat_send` | Push text, files, or images to a configured channel without connecting |

`/chat-send` and `chat_send` talk to the platform REST API from the current pi process. They do not open a Feishu websocket and do not take the channel lock, so they can be used from a local session while a worker is running. Print mode works without an interactive UI:

```bash
pi --no-extensions -e /path/to/pi-chat/index.ts --no-session \
  -p "/chat-send feishu/dm --file /tmp/a.pdf 'hello'"
```

Stdout prints `message_id:` lines. A bad token fails on stderr and is not sent.

---

## Development checks

```bash
npm ci
npm run check   # Biome + TypeScript, including tests
npm test        # Node test runner via tsx; no real chat credentials or QEMU needed
```

Tests cover runtime config inheritance, legacy trigger/job behavior, local filesystem and bash operations, cancellation/shutdown, mocked Feishu authentication, HTTP callback, WebSocket dispatcher, reconnect, and `chat-send` REST delivery. They do not open a real Feishu WebSocket or send a real chat message. Real app permissions, subscription mode, and delivery should be verified manually.

## Credits

pi-chat includes vendored/adapted logic inspired by [Vercel Chat SDK](https://github.com/vercel/ai) (MIT):

- `src/render/format.ts`
- `src/render/streaming-markdown.ts`
- `src/render/streaming.ts`

---

## License

MIT
