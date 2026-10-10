# Feishu/Lark, local execution and workspace configuration

Configuration lives at `~/.pi/agent/chat/config.json`. Use `/chat-config` or edit the JSON while disconnected. Merge the fields below into your existing config; do not replace existing accounts accidentally. App credentials, callback tokens, and config secrets are sensitive.

## Complete Feishu + local example (WebSocket, recommended for new accounts)

```json
{
  "botName": "pi",
  "runtime": {
    "mode": "local",
    "workspaceDir": "/workspace"
  },
  "accounts": {
    "feishu-team": {
      "service": "feishu",
      "name": "Team bot",
      "domain": "feishu",
      "eventMode": "websocket",
      "appId": "cli_REPLACE_ME",
      "appSecret": "REPLACE_ME",
      "access": {
        "ignoreBots": true,
        "allowedUserIds": ["ou_REPLACE_WITH_YOUR_OPEN_ID"]
      },
      "channels": {
        "general": {
          "id": "oc_REPLACE_WITH_CHAT_ID",
          "name": "General",
          "dm": false,
          "access": { "trigger": "mention" }
        }
      }
    }
  }
}
```

`/chat-config` writes `eventMode: "websocket"` for new Feishu accounts. **A saved account that omits `eventMode` stays on HTTP callbacks** so existing deployments keep working. Do not delete the field from an old HTTP account unless you also switch that app's console subscription to long connection.

For Lark international, set `domain` to `lark` (API host `open.larksuite.com`). `feishu` uses `open.feishu.cn`. App IDs, secrets and chat/user IDs must belong to that region/app. `botUserId` is resolved from the bot-info API at connect time. There is no role discovery; use `allowedUserIds`.

WebSocket mode does not use `verificationToken`, `encryptKey`, or `webhook`. The process only needs outbound access to the region's Open Platform host. No public callback URL or local listener port is required. The App ID must look like `cli_` plus 16 hex characters; that is what the official SDK accepts.

### Feishu / Lark console (WebSocket)

1. Create a self-built app, enable **Bot**, and publish a version available to the intended users. A group custom incoming-webhook bot is not sufficient.
2. Grant and publish `im:message:send_as_bot`, plus `im:message.group_at_msg:readonly` and/or `im:message.p2p_msg:readonly`. Receiving every group message also needs `im:message.group_msg`. Outbound file uploads need `im:resource`. Status reactions need `im:message.reactions:write_only`.
3. Open **Events & Callbacks**. Set the subscription mode to **Receive events through persistent connection** (长连接 / WebSocket). Do not configure an HTTP request URL for this app.
4. Subscribe to the event `im.message.receive_v1`. Long connection supports event subscriptions only, not card callback subscriptions. This project does not use card callbacks.
5. Publish the version so the permissions and subscription take effect. Invite the bot to the group. The channel `id` is the chat's `oc_...` id.

Long connection is cluster delivery: if several clients for the same app are online, only one of them receives each event. Use a separate app per simultaneous pi worker. The host must be able to reach `open.feishu.cn` or `open.larksuite.com`; it does not need a public IP.

Start from the source checkout:

```bash
cd /path/to/pi-chat
npm ci
npm run check
npm test
pi install /path/to/pi-chat

cd /workspace
pi --model openai/gpt-6-luna:low --chat-conversation feishu-team/general
```

Alternatively launch pi and run `/chat-connect feishu-team/general`. WebSocket connect waits for the first SDK handshake (30 seconds) and does not open a local callback port.

## HTTP callback example (existing deployments)

Keep this shape for apps already subscribed by request URL. Omitting `eventMode` is equivalent to `"http"`.

```json
{
  "service": "feishu",
  "domain": "feishu",
  "eventMode": "http",
  "appId": "cli_REPLACE_ME",
  "appSecret": "REPLACE_ME",
  "verificationToken": "REPLACE_ME",
  "encryptKey": "REPLACE_ME_OR_REMOVE_THIS_FIELD",
  "webhook": {
    "host": "127.0.0.1",
    "port": 3000,
    "path": "/feishu/events"
  }
}
```

`verificationToken` is required in HTTP mode. Omit `encryptKey` if callback encryption is not enabled. If set, it must match the platform **Encrypt Key**. In the setup UI, leaving Encrypt Key empty keeps the saved value; enter `-` to disable it. This key is unrelated to Gondolin config secrets or the `chat_request_secret` tool.

In the console choose **Send events to the developer server**, set the public HTTPS URL (for example `https://bot.example.com/feishu/events`), complete URL verification, and subscribe to `im.message.receive_v1`. The proxy must forward to `http://127.0.0.1:3000/feishu/events` without changing the body or dropping `X-Lark-*` headers. Extra query parameters on the local path are ignored. HTTP workers for different apps need distinct local ports. Switching an app between HTTP and WebSocket is a console subscription-mode change; the pi `eventMode` must match it.

## Feishu status reactions

While a turn is running, pi-chat puts a `Typing` reaction on the triggering user message and removes it when the turn ends. A failed turn adds `CrossMark` only after that `Typing` reaction was deleted. Abort/cancel only removes `Typing`. Success adds no badge; the reply itself is the success signal. Tool calls do not change the reaction.

Reactions are on by default. Turn them off for one account:

```json
{ "reactions": false }
```

or `{ "reactions": { "enabled": false, "inProgress": "Typing", "failure": "CrossMark" } }`. `inProgress` and `failure` override the emoji names.

Turn them off for the whole process, regardless of account config:

```bash
FEISHU_REACTIONS=false
```

`0`, `no`, and `off` also disable. Any other value, including an unset variable, leaves the account setting in effect. Reaction API errors are logged and do not fail the reply. Publish `im:message.reactions:write_only` with the app version or the add call is rejected and ignored.

## Runtime inheritance

The same `runtime` object is accepted at the root, account, and channel levels. Each property uses the most specific defined value. For example:

```json
{
  "runtime": { "mode": "gondolin" },
  "accounts": {
    "telegram-example": {
      "service": "telegram",
      "botToken": "REPLACE_ME",
      "runtime": { "mode": "local", "workspaceDir": "/workspace/team" },
      "channels": {
        "private": {
          "id": "123456789",
          "dm": true,
          "runtime": { "workspaceDir": "/workspace/private" },
          "access": { "allowedUserIds": ["123456789"] }
        }
      }
    }
  }
}
```

The `private` channel runs locally in `/workspace/private`. Changing the channel mode to `gondolin` mounts that same host directory into the VM at `/workspace`; `/shared` remains the account-wide mount. With no runtime configuration, all existing accounts continue to use Gondolin and their original per-channel storage directories.

Local processes use `/bin/bash --noprofile --norc`, with cwd at the chosen workspace. Bash timeout, turn cancellation, and disconnect terminate the child process group. `read`, `write` and `edit` use pi's native host operations. Outbound attachments must be in the workspace or account shared directory. These attachment checks do not isolate the other tools from the host filesystem.

Memory files, `skills/`, `incoming/`, `.secrets/` and `SYSTEM.md` are under the chosen workspace. Channel logs, locks and worker/session metadata stay under `~/.pi/agent/chat/`. A configured external workspace is not removed when its channel is deleted. No automatic copy/migration occurs on a directory change. Sharing a workspace between channels also shares their channel memory and secrets; use per-channel directories for isolation.

Local mode is opt-in and unsandboxed. Do not expose it to untrusted users. Gondolin HTTP-hook secrets, including inherited ones, cause local startup to fail rather than being silently injected without host restrictions. Run under a dedicated OS user and protect the plaintext credential/config/runtime-secret files with filesystem permissions.

## Standalone local smoke test

No messaging account or webhook is needed:

```bash
cd /workspace
pi --chat-local --chat-workspace /workspace \
  --model openai/gpt-6-luna:low --no-session \
  -p 'Use bash to run pwd. Then reply with LOCAL_OK and the directory.'
```

This loads the installed pi-chat extension, starts its local execution backend, asks the selected model to call the backend's bash tool, prints the reply and exits cleanly. For a long-lived interactive session omit `--no-session -p ...`. To run the checkout without installation, add `--no-extensions -e /path/to/pi-chat/index.ts`.

`--chat-local` uses the global `runtime.workspaceDir` when `--chat-workspace` is omitted (default `/workspace`). It does not connect a chat or load channel-specific memory. The model/provider must be available in your pi installation; check `pi --list-models gpt-6-luna` and `pi auth check --provider openai` without printing credentials.

## Manual Feishu acceptance checklist

WebSocket (no public URL):

- Bot info validates App ID/Secret in the correct region, and connect reaches the long-connection handshake.
- The console subscription mode is persistent connection, not an HTTP request URL, and `im.message.receive_v1` is published.
- A permitted user mentioning the bot in the configured chat receives a pi reply.
- Other chats, disallowed users and bot self-messages do not trigger replies.
- DMs configured with `dm: true` trigger without @mentions.
- Duplicate deliveries do not create duplicate jobs; long replies are chunked.
- `status`/`stop` work with the bot mention; `chat_attach` uploads a generated file.
- Disconnect closes the socket; reconnect accepts new events. A second client of the same app does not reliably receive events.

HTTP callback:

- URL verification succeeds; wrong token/signature is rejected.
- The same message, access, chunking, upload, and reconnect checks above, against the public callback URL.
- Disconnect releases the listener port.

No real Feishu traffic is required by `npm test`. HTTP tests use a local listener and mocked REST. WebSocket tests drive the official `EventDispatcher` through an injected session and never open a platform socket.
