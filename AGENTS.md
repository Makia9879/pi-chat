# pi-chat

Pi extension bridging Discord, Telegram and Feishu/Lark to pi sessions via Gondolin micro-VMs or explicit unsandboxed local execution.

## Architecture

```
Discord/Telegram/Feishu ←→ Live Adapter ←→ Runtime (log, jobs, slices) ←→ pi agent
                                        ↕
                                   Gondolin VM (Alpine + bash)
                                   /workspace  /shared
```

- **One VM per connection.** Started on `/chat-connect`, closed on `/chat-disconnect`. `/chat-spawn-all` launches one detached tmux/pi worker per configured channel using the `--chat-conversation <account/channel>` extension flag. `/chat-workers`, `/chat-open-all`, and `/chat-kill-all` manage those workers through tmux. Workers write status JSON to `~/.pi/agent/chat/worker-status/`; the `chat_workers` tool reads it.
- **One JSONL log per channel.** Append-only event stream: inbound, outbound, job lifecycle.
- **Trigger-based dispatch.** Mentions in channels, every message in DMs. Triggers queue jobs; jobs produce slices of inbound records for the agent.
- **Selectable tool backend.** `read`, `write`, `edit`, `bash` use Gondolin by default or host operations for `runtime.mode: "local"`. `runtime.workspaceDir` selects the host workspace (local default `/workspace`; VM guest stays `/workspace`). `chat_history` and `chat_attach` run on the host. `--chat-local` starts standalone local tools without a channel.
- **Feishu events.** New accounts use the official SDK WebSocket long connection (`eventMode: "websocket"`) and do not need a public callback URL. Accounts without `eventMode` keep HTTP callbacks with token verification and optional AES/signature checks. One active channel per Feishu app; HTTP workers also need distinct ports.

## Entry point

`index.ts` — Extension factory. Registers tools, commands, event handlers, connection lifecycle, and tmux spawning.

## Key files

### Core types
- `src/core/config-types.ts` — Config, account, channel, secret, and resolved conversation types.
- `src/core/runtime-types.ts` — Log record types, job types, dispatch types.
- `src/core/discovery-types.ts` — Discovery snapshot types (channels, users, roles).
- `src/core/keys.ts` — Channel key derivation.

### Config & storage
- `src/config.ts` — Load/save config, resolve conversations, storage paths. Everything under `~/.pi/agent/chat/`.
- `src/discovery-store.ts` — Read/write discovery snapshots (cached channel/user/role lists).
- `src/log.ts` — JSONL log read/write, locking, attachment materialization, directory setup.

### Runtime
- `src/runtime.ts` — `ConversationRuntime`: log state machine, job queue, slice construction, prompt building, checkpoint management. Owns trigger logic, access policy, control command parsing.

### Execution backends
- `src/execution.ts` — Backend interface, lazy factory (local mode never loads Gondolin), display paths.
- `src/local.ts` — Unsandboxed host tools, minimal bash environment, timeout/abort/shutdown process cleanup.
- `src/gondolin.ts` — `ConversationSandbox`: VM lifecycle, secret environment setup, tool operation factories (read/write/edit/ls/find/grep/bash), guest/host path translation.

### Secrets
- `src/secrets.ts` — Encrypted secret exchange: RSA keypair generation, widget URL construction, hybrid RSA-OAEP + AES-256-GCM decryption.

### Live adapters
- `src/live/types.ts` — `LiveConnection` and `LiveConnectionHandlers` interfaces.
- `src/live/index.ts` — Adapter router (Discord vs Telegram).
- `src/live/discord.ts` — Discord adapter: discord.js gateway, catch-up pagination, REST message sending with chunking and formatting, reply-to, auto-reconnect on disconnect.
- `src/live/telegram.ts` — Telegram adapter: long-polling, media group debounce, initial catch-up, chunked sending with Markdown formatting.
- `src/live/common.ts` — Shared: attachment download/storage, MIME detection, bot mention detection.
- `src/live/feishu.ts` — HTTP callbacks and official-SDK WebSocket long connection, deduplication, text/post conversion, chunked replies and outbound file uploads.

### Rendering
- `src/render/format.ts` — Service-specific markdown normalization and message length limits.
- `src/render/chunking.ts` — Text chunking for service message limits.
- `src/render/streaming.ts` — `StreamingPreview`: chunked preview transport (currently unused, kept for potential future streaming).
- `src/render/streaming-markdown.ts` — Streaming markdown renderer (currently unused).

### Services (setup/discovery)
- `src/services/index.ts` — Account snapshot refresh, identity update.
- `src/services/discord.ts` — Discord bot validation, server listing, channel/role/user discovery.
- `src/services/telegram.ts` — Telegram bot validation, identity fetch.
- `src/services/types.ts` — Shared service types.
- `src/services/feishu.ts` — Tenant token cache/refresh, Feishu/Lark REST client and bot identity.

### TUI
- `src/tui/chat-config.ts` — `/chat-config` UI: account/channel management, access policy, secrets config.
- `src/tui/dialogs.ts` — Shared dialog helpers: select, notice, loader, toggle.
- `src/tui/discord-setup.ts` — Guided Discord account setup (token, server selection, invite flow).
- `src/tui/telegram-setup.ts` — Guided Telegram account setup (token, DM/group observation).
- `src/tui/feishu-setup.ts` — Guided app credentials, event mode (WebSocket default for new accounts), and chat ID setup.

## Storage layout

```
~/.pi/agent/chat/
├── config.json
├── cache/
└── accounts/<account>/
    ├── shared/                    → /shared in VM
    │   ├── memory.md
    │   └── skills/
    └── channels/<channel>/
        ├── channel.jsonl
        ├── .lock
        ├── workspace/             → /workspace in VM
        │   ├── memory.md
        │   ├── skills/
        │   ├── incoming/
        │   ├── .secrets/
        │   └── SYSTEM.md
        └── gondolin/
            └── session.json
```

## Log record types

`checkpoint`, `inbound`, `job_queued`, `outbound`, `job_completed`, `job_failed`, `error`.

## Job/slice semantics

- `job_queued` records a trigger. `sliceStartRecordId` is derived at dispatch time from the last `job_completed.triggerRecordId`.
- Failed jobs do not advance the consumption boundary.
- The prompt slice includes all inbound records between the last completed boundary and the trigger.
- On reconnect, catch-up messages are logged but do not trigger until a new trigger arrives after arming.

## Remote control commands

Parsed before normal ingest. Built-in chat commands include `stop`, `new`, `compact`, `status`, `model`, plus slash commands in `src/slash-dispatch.ts`. Extension commands come from `pi.getCommands()` and are not forwarded when they are pi-chat admin commands (`/chat-kill-all`, `/chat-config`, and the other `/chat-*` management commands).

## Secret exchange flow

1. Agent calls `chat_request_secret` tool → RSA keypair generated, widget URL sent to chat.
2. User opens `pi.dev/secret#<base64>`, pastes secret, gets encrypted blob.
3. User pastes `!secret:<id>:<payload>` back into chat.
4. pi-chat intercepts (before trigger check), decrypts, writes to `/workspace/.secrets/<name>`, notifies agent.

## Conventions

- `npm run check` = biome + tsc (including tests); `npm test` = tsx/Node tests, no QEMU or platform credentials required.
- No ambient host env leaks into VM.
- VM paths shown to the model use guest paths (`/workspace/...`, `/shared/...`); local mode uses actual host workspace/shared paths.
- Transcript lines include `[uid:ID]` for tamper-resistant user identification.
