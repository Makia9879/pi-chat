# pi-chat 开发与交接文档

本文面向接手源码开发、测试、部署和排障的工程师，描述**当前工作树中的实际实现**，而不是最终产品规划。阅读顺序建议：本文件 → [配置示例](configuration.md) → [README](../README.md) → 对应源码。

> 飞书基础适配、本地工具执行后端和可配置工作目录已在工作树中实现。后续已补上无飞书/无 QEMU 环境能验证的失败闭合、凭据权限、secret 回包授权和回调健壮性修复，以及飞书 WebSocket 长连接接收。飞书真实平台联调和真实 Gondolin VM 回归仍未执行。第 6 节未勾选项仍是未完成事项，不要把它们读成已交付能力。

## 1. 当前状态摘要

| 项目 | 当前状态 |
| --- | --- |
| Discord / Telegram | 保留原适配器及原运行模式；增加共享运行后端和工作目录选择能力 |
| Feishu / Lark | HTTP 事件回调与 WebSocket 长连接；身份、文本/富文本接收、文本回复和出站文件上传 |
| 飞书接入方式 | 自建应用 Bot。新配置显式 `eventMode: "websocket"`（官方 SDK 长连接，无需公网回调）。没有该字段的旧配置保持 HTTP 回调。不是自定义机器人 incoming webhook。长连接有健康看门狗：关闭或入站活动超时后重建 `WSClient` |
| 飞书并发频道范围 | 一个 App 一个活动频道。HTTP worker 还需要不同端口；WebSocket 不占 webhook 端口，但同一 App 多个长连接只有一个会收到事件 |
| 默认执行模式 | `gondolin`，旧配置无需修改 |
| 本地模式 | 显式 `runtime.mode: "local"`；宿主机文件工具和 bash，不启动 microVM |
| 默认本地工作目录 | `/workspace` |
| 自定义工作目录 | 全局、账号、频道三级 `runtime.workspaceDir`，逐字段继承 |
| 无消息平台会话 | `--chat-local`，可配合 `--chat-workspace /workspace` |
| 检查 | `npm run check` 与 `npm test` 在补丁后复跑通过；提交前再跑 `git diff --check` |
| 自动化测试 | 46 个测试通过，入口为 `tests/*.test.ts`。不连接真实飞书、模型供应商或 pi 斜杠运行时 |
| 真实模型测试 | `openai/gpt-6-luna:low` 已启动、调用本地 bash 并正常回复，退出码 0 |
| 本地安装 | 已执行 `pi install /workspace/pi-chat`，`pi list` 可见源码目录 |
| Git | 改动位于工作树；本轮未执行 git push |

**不要混淆两个“运行位置”：**pi 的模型会话原本就在宿主机 pi 进程中；Gondolin 隔离的是工具执行。新增 local 模式让 `read/write/edit/bash` 不再经过 VM，不是把模型客户端或整个 pi 程序从 VM 搬到宿主机。

## 2. 仓库架构

### 2.1 总体关系

```text
Discord Gateway / Telegram polling / Feishu HTTP callbacks or WebSocket
                         │
                         ▼
                 src/live/* 适配器
                         │ InboundMessageInput + checkpoint
                         ▼
             index.ts：连接生命周期、控制命令、secret 截获
                         │
                         ▼
             ConversationRuntime（src/runtime.ts）
               ├─ channel.jsonl：追加式日志
               ├─ access policy：访问/触发检查
               ├─ pendingJobs / activeJob
               └─ prompt slice：从消费边界到本次 trigger
                         │ pi.sendUserMessage()
                         ▼
                 宿主机 pi / 模型 API
                         │ read / write / edit / bash
                         ▼
          ConversationExecution（src/execution.ts）
               ├─ ConversationSandbox → Gondolin VM
               └─ LocalExecution → 宿主机文件系统和子进程
                         │
                agent_end 最终回复 / chat_attach 队列
                         ▼
                LiveConnection.send()
                         │
                  远端平台 / 完成日志
```

`index.ts` 仍是较大的集成入口，不要假设所有会话逻辑已经抽成独立服务。修改某一后端时，要同时核对入口里的工具代理、提示词、连接清理和附件路径。

### 2.2 模块地图

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 扩展 factory；注册工具、命令、CLI flags、事件；连接/断开；调度模型；tmux worker 管理 |
| `src/core/config-types.ts` | 配置类型、账号联合类型、运行配置、解析后的 conversation |
| `src/core/runtime-types.ts` | 入站消息、附件、日志记录、job、状态类型 |
| `src/core/discovery-types.ts` | 账号身份、频道/用户/角色 discovery snapshot |
| `src/core/keys.ts` | 账号和频道 key 的派生 |
| `src/config.ts` | 配置读写、继承、存储路径、conversation 解析、worker 冲突预检 |
| `src/discovery-store.ts` | discovery snapshot 缓存读写 |
| `src/log.ts` | 目录初始化、JSONL、PID lock、附件落盘和消息规范化 |
| `src/runtime.ts` | 访问策略、trigger、内存队列、日志边界、prompt slice、控制命令解析 |
| `src/execution.ts` | 后端接口、惰性创建工厂、显示路径转换 |
| `src/execution-prompt.ts` | 不同 pi 版本的工作目录提示兼容和执行环境说明 |
| `src/gondolin.ts` | VM 生命周期、挂载、HTTP secrets、VM 工具 operations、路径安全检查 |
| `src/local.ts` | 非隔离本地工具、最小 bash 环境、终止/超时、出站附件 staging |
| `src/live/types.ts` | 适配器共同的 `LiveConnection` / handlers 契约 |
| `src/live/index.ts` | 按 service 路由，未知 service 明确报错 |
| `src/live/discord.ts` | discord.js gateway、catch-up、发送、附件、连接异常处理 |
| `src/live/telegram.ts` | long polling、offset、媒体组、发送、附件 |
| `src/live/feishu.ts` | HTTP callback、安全验证、消息转换、去重、回复和上传；WebSocket 会话交给看门狗 |
| `src/live/feishu-ws.ts` | 长连接健康看门狗、活动时间、指数退避和状态文本 |
| `src/chat-send.ts` | 不连接、不加频道锁的本地推送；飞书/Discord/Telegram REST |
| `src/live/common.ts` | 附件读写、MIME 和 mention 辅助函数 |
| `src/services/*` | 设置阶段的身份验证和 discovery；飞书文件同时提供 REST client |
| `src/tui/*` | `/chat-config` 和 guided setup |
| `src/render/*` | 平台格式化、消息分片、preview 支持代码 |
| `src/secrets.ts` | 用户主动提供 runtime secret 的 RSA/AES 加密交换 |
| `types.ts` | 核心类型的集中导出 |

`src/render/streaming.ts` 和 `streaming-markdown.ts` 保留，但当前主回复路径没有启用实时流式 preview。不要仅根据 README 中历史 feature 描述认定它已经工作。

### 2.3 连接生命周期

入口：`/chat-connect <account/channel>`，或进程启动参数 `--chat-conversation <account/channel>`。

1. `loadChatConfig()` 读取配置。
2. `resolveConversation()` 合并 access、secrets、runtime，计算所有目录和模型可见路径。
3. 断开已有连接，释放现有 adapter、后端和 conversation lock。
4. **仅 Gondolin 模式**执行 QEMU 检查及 guest assets 准备。
5. `ConversationRuntime.connect()` 创建目录、获取 `.lock`、读取 JSONL，确定下一个 record ID。
6. `createConversationExecution()` 惰性加载选定后端并 `start()`。
7. `connectLive()` 启动平台适配器；适配器通过 `onCaughtUp()` 让 runtime arming。
8. 保存 conversation ID 到 pi session custom entry，写 worker status，尝试调度任务。
9. 断开或 `session_shutdown` 时清理资源。失败路径也会尝试关闭 adapter、后端和锁。

原来变量名 `sandbox` 被保留，但它现在的类型是 `ConversationExecution`，**不代表一定具有安全隔离**。

### 2.4 入站消息、job 与消费边界

平台适配器把远端消息转换成：

```ts
interface InboundMessageInput {
  messageId?: string;
  userId: string;
  userName?: string;
  roleIds?: string[];
  text: string;
  mentionedBot?: boolean;
  isBot?: boolean;
  attachments?: AttachmentInput[];
}
```

处理顺序的重要细节：

1. `index.ts` 的 `onMessage` 首先尝试识别 runtime secret 回包。只有已 arming、通过 access policy，且 request 绑定到当前 conversation 的回包才会写入 `.secrets/`。
2. runtime 已 arming 后解析聊天斜杠命令，包括 `stop/new/compact/status/model` 以及 `/thinking`、`/resume`、`/skill:` 和 `pi.getCommands()` 里的扩展命令。`/model` 与不带斜杠的 `model` 同样处理。
3. 对控制命令有 checkpoint 时，入口现在会记录 checkpoint，帮助重连去重。
4. 普通消息进入 `ingestInbound()`：规范化 → 附件 materialize → 写 inbound → checkpoint → trigger 判断 → 必要时写 `job_queued`。
5. `tryDispatch()` 在 pi 空闲且没有远端 turn 时调用 `beginNextJob()`，通过 `pi.sendUserMessage()` 启动模型。
6. `before_agent_start` 注入当前环境、频道说明、memory、skills、SYSTEM.md。
7. `agent_end` 获取最终 assistant 输出；发送成功后记录 outbound 和 `job_completed`，失败则记录 `job_failed`。

保持以下语义不变：

- 群默认 mention 触发，`access.trigger: "message"` 可改成每条匹配消息触发。
- `channel.dm: true` 时每条被允许的消息触发，不要求 mention。
- `ignoreBots` 默认 true；`allowedUserIds` 和 `allowedRoleIds` 决定触发/控制权限。
- catch-up 阶段可以写日志，但不创建新 job；arming 后的新 trigger 才驱动模型。
- slice 的起点取最后一个成功 `job_completed.triggerRecordId`，终点是当前 trigger。
- 失败不推进消费边界；下一个新 trigger 仍可看到此前失败任务的上下文。
- transcript 使用 `[uid:ID]`。用户显示名不可信，不能用它做权限判断。

**现有边界：**访问策略控制触发/控制命令，并不意味着所有未授权消息都被从上下文删除；普通入站消息可能先被写入日志，再判断能否触发。当前也没有完整的崩溃后 pending job 重建机制：日志持久化不等于内存队列会自动恢复。这些语义需在生产使用前理解。

### 2.5 出站、附件与远程控制

- 主回复只在 `agent_end` 发送最终文本，不逐 token 调用适配器。
- `chat_attach` 在后端中检查/暂存文件，把 host staged paths 加入待发送列表。
- 发完回复才推进 job 消费边界；发送失败会留下失败记录。
- `stop` 中止当前 turn；`compact` 可以先 abort 再 compact；`new` 通过 `/chat-new` 建立新 pi session；`status` 报告模型、用量、队列和环境。
- `/model` 不创建 job。无参数时回复当前模型和 `modelRegistry.getAvailable()` 里已配置认证的模型；带 pattern 时调用 `pi.setModel()`，显式 `:thinking` 再 `setThinkingLevel()`。未知 pattern 只回复错误和相近建议。会话若配置了 `scopedModels`，列表和切换都限制在该范围内。
- 其他斜杠命令由 `src/slash-dispatch.ts` 分发。可用 API：`setThinkingLevel`、`compact`、`setSessionName`、`sendUserMessage({ expandPromptTemplates: true })`、`getCommands()`、`SessionManager.list`、命令上下文的 `newSession`/`switchSession`/`fork`/`navigateTree`/`reload`。没有单独的 clone API，`/clone` 用 `fork(leaf)`。`/export` 复制会话 JSONL 并作为附件发送；HTML 导出函数没有公开给扩展。`/hotkeys` 和 `/changelog` 不能读 TUI 渲染器，分别返回默认键位说明和 CHANGELOG 摘录（文件不存在时说明原因）。
- 飞书选择卡片照抄 Hermes `plugins/platforms/feishu/adapter.py` 的 `_card` / `_card_button`，token 去重 15 分钟（同文件 `_FEISHU_CARD_ACTION_DEDUP_TTL_SECONDS`）。长连接不一定投递卡片回调，因此编号回复始终可用。其他 service 只发编号文本。
- `allowedUserIds` 非空时，只有名单内用户可执行命令。名单为空时只允许 `/help /status /session /changelog /hotkeys`。`/login /logout /quit /settings /scoped-models /trust /share /copy /import /bug /llama` 以及 `/chat-*` 管理命令直接拒绝。扩展命令通过 `getCommands()` 透传，排除 pi-chat 自己的管理命令。
- 有远端 turn 时，`tool_call` 只允许 `read/write/edit/bash/chat_history/chat_attach/chat_request_secret`。独立本地模式没有远端 turn，不把这项限制当作宿主机安全边界。

## 3. 存储、工作目录与路径约定

### 3.1 默认布局

```text
~/.pi/agent/chat/
├── config.json
├── cache/
├── local/                          # --chat-local 的非频道级 metadata 根
│   └── shared/                     # 独立模式共享目录
├── worker-status/                  # 每 15 秒更新的 worker JSON
├── tmux-sessions/                  # worker pi session 数据
└── accounts/<account>/
    ├── shared/
    │   ├── memory.md
    │   └── skills/
    └── channels/<channel>/
        ├── channel.jsonl
        ├── .lock
        ├── workspace/              # 旧配置/Gondolin 默认 host workspace
        ├── outgoing/               # local 后端出站附件 staging
        └── gondolin/
            ├── session.json        # 仅 VM 启动时写入 VM 元数据
            └── outgoing/           # Gondolin 后端 staging
```

配置 `runtime.workspaceDir: "/workspace"` 后，工作文件位于：

```text
/workspace/
├── memory.md
├── skills/
├── incoming/
├── .secrets/
└── SYSTEM.md
```

`skills/`、`.secrets/`、`SYSTEM.md` 不保证在第一次连接时全部预先创建；它们按使用需要产生。独立 `--chat-local` 不创建完整频道 runtime，也不自动加载频道 memory。

### 3.2 三个容易混淆的目录概念

| 字段/概念 | Gondolin | local |
| --- | --- | --- |
| `workspaceDir` | 挂载源的宿主机绝对路径 | 工具实际运行的宿主机绝对路径 |
| `workspacePath` | `/workspace` | 等于解析后的 `workspaceDir` |
| `sharedPath` | `/shared` | 账号 shared 的真实宿主机路径 |
| pi 进程 `ctx.cwd` | pi 自己启动时的 cwd | pi 自己启动时的 cwd，可能与工具 cwd 不同 |

- 工具代理必须用后端的 `workspacePath`，不要继续硬编码 `/workspace`。
- VM 必须避免把 host private storage path 暴露成工具可读路径；用 guest path。
- local 模式不能伪装成有 `/shared` 挂载；提示词、skills 路径和附件 transcript 应使用真实 host path。
- `displayPath()` 用于日志附件和技能展示；Gondolin 自己还有带 realpath 检查的 host/guest 转换，不能把纯展示函数当作文件安全检查。
- `executionSystemPrompt()` 兼容旧版 `Current working directory: ...` 和新版 `<cwd>...</cwd>`，并附加明确的工具环境说明。

`/chat-connect` 不对已有 pi 进程执行 `process.chdir()`：那会影响 pi 自己的 project discovery 和其他扩展。已运行的 pi 连接频道后，工具切到选定 workspace，pi 自己最初发现的项目资源仍来自原 cwd。希望两者一致时，先 `cd /workspace` 再启动 pi。

### 3.3 继承规则与兼容性

以下结构可放在根、账号、频道三个层级：

```json
{
  "runtime": {
    "mode": "local",
    "workspaceDir": "/workspace"
  }
}
```

逐字段优先级：

```text
channel.runtime.<field>
    ?? account.runtime.<field>
    ?? config.runtime.<field>
    ?? default
```

默认值：

- `mode` 缺省为 `gondolin`。
- local 的 `workspaceDir` 缺省为 `/workspace`。
- Gondolin 的 host `workspaceDir` 缺省为原来的每频道存储目录。
- Gondolin guest 工作目录始终为 `/workspace`，本次没有引入可配置 guest mount point。

目录必须是绝对路径；不会把 `~` 自动扩展为 home。修改目录不会迁移旧文件。多个频道共用同一 workspace 会共享 `memory.md`、skills、输入附件和 runtime secrets；日志锁仍按频道分开，不能阻止跨频道修改相同工作文件。

删除频道/账号沿用原 storage 删除逻辑。位于 storage 根以外的自定义 workspace 不会被删除；不要把“不会删 external workspace”误解为位于账号存储目录内部的自定义路径也会被保护。

## 4. 三项需求的设计与实现

### 4.1 Feishu / Lark channel

#### 配置和设置流程

`ChatService` 新增 `feishu`。使用单一 service 类型，通过 `domain` 区分中国区和国际区：

```ts
interface FeishuAccountConfig {
  service: "feishu";
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  eventMode?: "websocket" | "http"; // 缺省 = http，兼容旧配置
  verificationToken?: string;          // HTTP 必填；WebSocket 可省略
  encryptKey?: string;
  webhook?: { host?: string; port?: number; path?: string };
  botUserId?: string;
  botUsername?: string;
  // 继承 name/access/runtime/gondolin/channels 等公共字段
}
```

`resolveFeishuEventMode()` 只在字段缺失时返回 `http`。`/chat-config` 新建账号会把 `eventMode` 写成 `websocket`，不会靠缺省值悄悄改掉已有 HTTP 部署。设置 UI 先选区域和订阅方式：WebSocket 只收集 App ID/Secret；HTTP 仍收集 Verification Token、Encrypt Key 和端口。`webhook.host/path` 可直接在 JSON 中修改。频道通过 `oc_...` chat ID 配置；允许用户用 `ou_...` open ID。

HTTP 默认 listener 是 `127.0.0.1:3000/feishu/events`。WebSocket 不监听本地端口。

`src/services/feishu.ts` 的 `FeishuClient`：

- `POST /auth/v3/tenant_access_token/internal` 获取 tenant token。
- 缓存 token，按 expiry 提前 60 秒失效；并发刷新共用一个 Promise。
- `GET /bot/v3/info` 获取 bot open ID 和名称。
- token 错误码 `99991663/99991664/99991665` 时清缓存并重试一次。
- 授权请求有 15 秒 timeout，普通 API 请求有 30 秒 timeout。
- API host 固定由 region 选择，不允许任意 base URL 配置。
- 当前只处理自建 app 的 tenant credentials，没有 marketplace app 安装授权流程。

Bot ID 在 connect 时刷新，不依赖用户手动填对。snapshot 暂不枚举飞书用户和角色；UI 中的频道来自已有配置。

#### 回调认证

核心函数：`decodeFeishuEvent(raw, headers, account)`。

1. 解析原始 JSON；若有 `encrypt`，用 `SHA-256(encryptKey)` 得到 AES-256 key。
2. base64 解码后的前 16 字节是 IV；剩余部分按 AES-256-CBC 解密并解析 JSON。
3. 从 `header.token` 或顶层 `token` 校验 Verification Token。
4. 若存在 `header.app_id`，必须匹配已配置 App ID。
5. 配有 Encrypt Key 的普通事件还检查：
   - `X-Lark-Request-Timestamp`、`X-Lark-Request-Nonce`、`X-Lark-Signature`；
   - timestamp 与本机相差不超过 300 秒；
   - 签名为 `SHA256(timestamp + nonce + encryptKey + rawBody)` 的 hex。
6. `url_verification` 通过 token 认证返回 challenge；此分支允许平台不发送签名 headers。
7. 配有 Encrypt Key 的普通事件在签名通过后，还会把 `timestamp+nonce` 记入当前连接的内存集合；同一连接内重放返回 403。这不是跨进程持久化 nonce 库。

比较 token/signature 用 `timingSafeEqual`。原始 body 上限 1 MiB；只有配置路径上的 POST 被接收。错误认证返回 403，路径/方法不匹配返回 404，过大请求返回 413。

代理必须保留原始 body 和签名 headers。不要先 parse JSON 再重新序列化转发，否则签名可能失效。

#### 消息转换和幂等

`feishuMessageToInput()` 只处理 `im.message.receive_v1`：

- 按配置 chat ID 过滤。
- 从 `sender.sender_id.open_id` 取稳定用户身份。
- 忽略 bot 自己的 open ID。
- 支持 `text` 和 `post`，支持常见直出及 `zh_cn/en_us` 富文本结构。
- 使用 metadata 中的 mention 和富文本 at 节点判断 bot mention，不仅靠用户自由文本。
- bot mention 规范化为 `<@BOT_OPEN_ID>`，复用 runtime 的控制命令清理逻辑。
- 其他消息类型生成明确的 unsupported marker，不下载其资源。

callback 串行进入 Promise queue。已处理 message ID 保存在最多 10,000 项的内存 Set；连接时从最近日志里的 inbound/checkpoint ID 初始化。HTTP 在 `onMessage()` 返回后应答，不等待模型最终回复。

这不是端到端 exactly-once：日志写入、控制命令副作用和远端 API 发送之间没有事务，也没有持久化事件 inbox。不要向用户承诺重启/网络失败下完全无重复或永不丢失。

#### 出站

- 普通发送：`POST /im/v1/messages?receive_id_type=chat_id`。
- 回复触发消息：`POST /im/v1/messages/<message_id>/reply`。
- 文本按最多 2,000 UTF-16 code units 分片，为平台 JSON/字节限制保留余量。
- 第一条优先 reply-to；后续分片普通发送。
- reply 接口返回飞书 IM 业务码 `230000`–`239999`（不含鉴权、限流或 5xx）时，改为普通发送一次。其他失败仍让 job 失败，避免把可能已投递的请求再发一遍。
- `chat_attach` 使用 multipart `POST /im/v1/files`，`file_type=stream`，拿到 `file_key` 后发送 file message。
- pi Markdown 作为 plain text 发送，未实现 card/富文本渲染。
- `setReplyTo` 记录要加表情的用户消息。preview 仍是 no-op。最终 send 仍显式收到 reply ID。

#### 状态表情（第一阶段）

处理中在触发消息上加 `Typing`，结束时删除。失败仅在删除成功后再加 `CrossMark`；删除失败则保留 reaction_id，不再叠加失败徽章。中止只删除。成功不加表情。工具调用不换表情。`startTyping` 对同一 message id 幂等，供 4 秒 typing loop 重复调用。

- API：`POST /im/v1/messages/:message_id/reactions`，body `{ reaction_type: { emoji_type } }`，保存 `data.reaction_id`；`DELETE /im/v1/messages/:message_id/reactions/:reaction_id`。
- 失败只 `console.warn`，不抛到 job/发送路径。`index.ts` 在 dispatch 失败、agent error/length、发送失败时 `markOutcome(..., "failure")`；abort 用 `"cancelled"`。
- 账号字段 `reactions: false` 或 `{ enabled: false, inProgress, failure }`。进程环境变量 `FEISHU_REACTIONS=false|0|no|off` 强制关闭。默认开启。
- 权限 `im:message.reactions:write_only`。未授权时添加失败并忽略。不订阅用户点表情事件，因此不会回环。
- 缓存上限 1024。崩溃后残留的 Typing 不在启动时清理。

#### 长连接（WebSocket）

`eventMode: "websocket"` 时不启动 HTTP listener。`connectFeishuLive()` 使用官方 `@larksuiteoapi/node-sdk` 的 `WSClient` + `EventDispatcher`（依赖 `^1.74.0`，长连接自 SDK 1.24 起可用）：

- `domain: "lark"` 映射 `Domain.Lark`，否则 `Domain.Feishu`。建连只用 App ID/Secret；`verificationToken`、`encryptKey`、`webhook` 可省略。
- App ID 必须匹配 SDK 的 `cli_` + 16 位十六进制，否则 `WSClient.start()` 会直接返回且不连。连接前抛出明确错误，不发网络请求。
- 生产路径等待首次 `onReady`，超时 30 秒后 `close({ force: true })`。握手超时 15 秒。自动化测试注入 session factory，驱动真实 `EventDispatcher.invoke(..., { needCheck: false })`，**不会**打开飞书 WebSocket。
- SDK 把 schema 2.0 信封展平后交给 `im.message.receive_v1` handler。适配器还原成 `FeishuEvent` 再走 `feishuMessageToInput()`。`app_id` 不匹配则直接 ack 丢弃，避免 500 重试风暴。
- 只等待日志写入，不等待模型，以落在平台约 3 秒的处理窗口内。串行队列和 message ID 去重与 HTTP 相同。看门狗重建客户端时不新建 runtime，内存里的 seen set 继续有效，因此平台重推不会再入队。
- 长连接是集群投递，不是广播。同一 App 多个在线客户端只有一个会收到事件。预检仍要求一个 App 一个频道。WebSocket worker 不占用 webhook 端口；HTTP worker 仍要求端口互斥。
- 长连接只支持事件订阅，不支持卡片回调。本项目本来不用卡片回调。
- 首次握手失败仍然让 `connectFeishuLive()` 抛出，由现有连接失败路径清理。握手成功之后的关闭、SDK 错误和活动超时由看门狗销毁并新建 `WSClient`，**不再**调用 `onDisconnect`。那条路径会拆掉整个 adapter 再 `connectConversation()`，会和看门狗抢同一条连接。
- 正常 disconnect 先尝试发送 WebSocket CLOSE，再 `close({ force: true })`，并停掉看门狗。退避 sleep 不 `unref`，否则半开连接被拆掉后进程可能在重连前退出；健康检查 interval 会 `unref`。

HTTP 回调继续用自有 `decodeFeishuEvent()`，不改走 SDK dispatcher：SDK 在未配置 Encrypt Key 时不校验 Verification Token，签名也比较重新序列化后的 JSON，而不是 raw body。

控制台必须把订阅方式设成「使用长连接接收事件」，并订阅 `im.message.receive_v1`，然后发布版本。不要同时配置请求地址 URL。出站仍要能访问 `open.feishu.cn` 或 `open.larksuite.com`。

#### 本地推送（`/chat-send` / `chat_send`）

这不是频道 worker。调用方可以是另一个本地 pi 会话，甚至 `pi -p "/chat-send ..."`。它只读配置、校验 `account/channel` 存在，然后直接打平台 REST：

- 飞书：`tenant_access_token`，文本走 `im/v1/messages`，文件先 `im/v1/files` 再发 `file`，图片先 `im/v1/images` 再发 `image`。不创建 `WSClient`，不加 conversation `.lock`。
- Discord / Telegram：同样只发 REST。错误文本会删掉 bot token 和 App Secret。
- 成功时 stdout / 工具结果打印每个 `message_id`。失败抛出 `chat-send failed: ...`。
- 日志：发送成功后，在 `${logPath}.append.lock` 下读取最大 `recordId` 再追加 `outbound`（`jobId: "chat-send"`）。这把锁不是 worker 的频道锁。worker 的 `appendConversationRecord()` 也走同一把锁，避免两行 JSONL 交错或复用 id。锁在超时内拿不到时，发送结果仍然返回，并标明 `logged: no`。
- 聊天里的 `/chat-send` 被当成 `/chat-*` 管理命令拒绝转发。远程 turn 的工具白名单也不包含 `chat_send`。

##### SDK 静默断线（`@larksuiteoapi/node-sdk` 1.74.0）

现象：worker 进程还在，但从某一时刻起收不到任何事件，stderr 也没有错误。这和 SDK 的默认状态机一致，不是进程崩溃。

`WSClient` 构造时的默认值（服务器随后会覆盖）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `pingInterval` | 120s | 应用层 protobuf ping，不是 WebSocket 协议 ping |
| `reconnectCount` | `-1` | 无限重试，直到 `pullConnectConfig` 或 pong 写入服务器给的次数 |
| `reconnectInterval` | 120s | 第一次随机等待之后，每次失败的固定间隔 |
| `reconnectNonce` | 30s | 进入重连循环后的随机等待上限 |
| `autoReconnect` | `true` | pi-chat 现在显式关掉，避免和自己的重建抢连接 |

服务器在 `POST /callback/ws/endpoint` 的 `ClientConfig` 里下发 `PingInterval`、`ReconnectCount`、`ReconnectInterval`、`ReconnectNonce`，单位是秒，SDK 乘 1000。之后每次 pong 再覆盖一次。这些值不是客户端能在 `WSConfigOverrides` 里改的。

静默窗口的直接原因：

1. **半开 TCP 不产生 `close`/`error`。** NAT、防火墙或服务端丢掉路径时，`ws` 的 `readyState` 可以一直是 `OPEN`。`send()` 把 ping 放进内核缓冲区就算成功。Linux TCP keepalive/重传常常要十几分钟到两小时才宣告死亡。worker 活着、没有异常、事件全停，和这种窗口一致。
2. **SDK 的 pong 看门狗默认关闭。** `armLiveness()` 只在构造参数 `wsConfig.pingTimeout`（秒）大于 0 时工作。未设置时 `pingTimeoutSec` 为 0，看门狗是空操作。注释写明这是为了保留“只等 socket 错误”的旧行为。旧的 pi-chat 没有传这个参数。
3. **`pingTimeout` 还必须短于 ping 间隔。** 每次 ping 都会清掉并重装看门狗。若 `pingTimeout >= pingInterval`，下一次 ping 会在定时器触发前重置它，缺 pong 也永远不会拆连接。因此这里固定传 45 秒，只作为 120 秒默认 ping 下的加速器；真正的阈值是看门狗的 `staleTimeoutMs`。
4. **`error` 不重连，`close` 几乎不打日志。** `error` 回调只记 `'ws error'`，不带错误对象，也不调用 `reConnect()`。`close` 才调用 `reConnect()`，但日志级别是 `debug`。pi-chat 以前把 SDK logger 设在 `info`，所以即便真的关闭也看不见。ping/pong 是 `trace`。默认 logger 的 `error` 走 `console.log`（stdout），不走 stderr。
5. **发送失败不会拆 socket。** `send` 回调失败只记 `'send data failed'`。
6. **SDK 自己的重连不可靠，不能当唯一手段。** `autoReconnect: false` 且曾经连上过时，`reConnect()` 直接返回，不触发 `onError`/`onReconnecting`。`isConnecting` 会丢掉并发的 `reConnect()`。服务器若把 `ReconnectCount` 推成很小的数，循环耗尽后进入 `failed` 并不再试。`exceed_conn_limit`（1000040350）在 `pullConnectConfig` 里被当成不可重试，SDK 会放弃；新连接和旧端点短暂并存时可能踩到这个码。
7. **关连接时如果不发 CLOSE，服务端会继续把事件路由到旧端点。** Hermes 在 #10202 里记录过：不先发 CLOSE 就拆线程，飞书会把消息送到已经死掉的连接，静默可持续到服务端 CLOSE-WAIT 超时（数分钟到数小时）。

Hermes `plugins/platforms/feishu/adapter.py` 的做法是：给 Python SDK 注入 ping timeout，监听 `on_reconnecting` 写运行状态，用 supervisor 在接收线程退出后按指数退避重建客户端（上限 60 秒），拆线前关掉 SDK auto reconnect 并发送 CLOSE。Node SDK 的失败形态不同：线程不会死，半开的 client 对象还活着。所以这里不依赖 SDK 的重连阶梯，而是在关闭或活动超时后销毁整个 `WSClient` 再新建一个。退避公式和上限与 Hermes 的“有上限的指数退避”同一类，抖动被限制在当前档位的 75%–100%，不会超过 `reconnectMaxDelayMs`。

活动时间只记录入站帧（含应用层 pong）、WebSocket 协议 pong、dispatcher 事件和握手成功。出站 ping 的 `send` 成功不算活动，否则半开连接会一直被刷新。健康检查还读 SDK `getConnectionStatus()`：状态不再是 `connected` 时立刻重建。若服务器 ping 间隔大于等于 `staleTimeoutMs`，stderr 告警一次，避免把健康空闲连接拆掉；阈值本身不被悄悄放大，否则用户配的超时不会生效。

连接、断开、过期、重连和关闭都 `console.error` 到 stderr，前缀 `[pi-chat feishu]`。同一事件经 `onConnectionEvent` 写入频道日志 `error` 记录（`feishu-ws <type>: ...`），因为现有日志类型里没有单独的链路事件。worker status 的 `feishuWs` 和 `/status` 展示当前状态、最近活动时间和重连次数。配置项见 [configuration.md](configuration.md)。

#### 部署限制

每个 pi worker 自己接收事件，没有账号级共享 dispatcher。因此：

- 当前每个 App 同时连接一个频道。长连接下第二个客户端不能可靠收到事件。
- HTTP 多 worker 应使用不同 App、不同端口和不同公网 URL。WebSocket 多 worker 使用不同 App，不需要端口或公网 URL。
- `validateWorkerConversations()` 在 `/chat-spawn-all` 前检查重复 App ID；只对 HTTP 模式检查端口。未知 `eventMode` 直接失败。
- 手动启动冲突的 HTTP 进程仍会收到 `EADDRINUSE`；预检不是跨进程锁。
- 无离线历史补拉，仅依赖平台重试窗口。
- HTTP 回调 path 比较会忽略 query string，避免反向代理附加参数时误返 404。方法仍必须是 POST。
- 只读 GET 遇到一次 429/5xx 会立即重试；消息发送不自动重试。

### 4.2 本地非 microVM 后端

新增 `ConversationExecution`，仅暴露入口目前需要的最小共同 API：

```ts
interface ConversationExecution {
  readonly workspacePath: string;
  readonly sharedPath: string;
  readonly mode: "gondolin" | "local";
  start(): Promise<unknown>;
  close(): Promise<void>;
  stageAttachment(path: string): Promise<string>;
  createReadOperations(): Promise<ReadOperations | undefined>;
  createWriteOperations(): Promise<WriteOperations | undefined>;
  createEditOperations(): Promise<EditOperations | undefined>;
  createBashOperations(): Promise<BashOperations>;
}
```

关键设计：

- `createConversationExecution()` 对后端做动态 import。
- `index.ts` 不再顶层 import Gondolin，也不在 local 模式调用 guest preparation。
- 原来的 `ConversationSandbox` 保留实现，新增 mode/path 属性满足接口。
- 本地 `read/write/edit` operations 返回 `undefined`，让 pi 原生工具以传入 cwd 执行。
- 本地 bash 使用 `spawn("/bin/bash", ["--noprofile", "--norc", "-c", command])`。
- 子进程环境只显式给 PATH、workspace HOME 和 LANG；不会直接复制 `process.env`。
- POSIX 子进程建立独立进程组；超时、abort、close 对已跟踪的进程组发送 SIGKILL，并等待 close 清理。
- 出站附件必须 realpath 落在 workspace 或 shared 内，必须为普通文件，再复制到 staging。

**安全边界：**这是宿主机直接执行，不是“弱化 VM”。native read/write/edit/bash 都拥有 pi OS 用户的权限。最小环境不阻止读取宿主机可访问的凭据文件，PATH 也仍来自宿主机。会自行 daemonize/脱离进程组的程序不具备强隔离保证。

`--chat-local` 启动失败时不会把工具回退到 pi 进程的原始 cwd。失败原因保留在状态栏，后续 `read/write/edit/bash` 直接报错。独立模式只把这四个工具交给模型；频道工具仍注册在扩展中，但不会进入独立会话的 active set。连接频道失败仍清掉后端，不会把远程会话标记为已连接。

Gondolin HTTP-hook secrets 的 host 限制不能在本地复现，所以 local startup 遇到任何合并后的此类 secret 会报错，不注入 plaintext env，也不静默忽略。runtime secret exchange 是另一套机制，仍写 workspace 下的 `.secrets/<name>`。

没有自动 fallback。QEMU 不可用时要显式选择 local，避免无提示地丢掉隔离。

### 4.3 工作空间配置和 worker 启动

`buildResolvedConversation()` 是路径真源，新增：

- `runtimeMode`
- `workspacePath`
- `sharedPath`

调整 `workspaceDir` 后，`channelMemoryPath` 和 `filesDir` 随之变化；log/lock 仍在 conversation storage 下。

`index.ts` 的 read/write/edit/bash delegate 使用后端 cwd，提示词和 runtime secret 路径不再假设本地一定是 `/workspace`。memory、SYSTEM.md、skill path、transcript attachment display 同样跟随解析结果。

`spawnConversationTmux()`：

1. 创建 resolved host workspace。
2. `SessionManager.continueRecent()` 使用该 host cwd。
3. `tmux new-session -c <workspaceDir>` 从该目录启动 pi。
4. 转发显式 `-e/--extension` 参数时，把相对文件路径先变为绝对路径，避免 worker 换目录后找不到扩展。

它目前没有额外转发 orchestrator 的 `--model` 参数；worker 使用 pi 自己的会话/默认模型选择。要精确指定本次模型，直接运行下文的 pi 命令，不要假定 `/chat-spawn-all` 会继承当前 CLI model。

### 4.4 独立本地会话 flags

```text
--chat-local
--chat-workspace <absolute-host-path>
```

- `--chat-local` 启动 `LocalExecution`，不连接消息平台、不创建频道 runtime。
- workspace 优先级为 flag → 根级 `config.runtime.workspaceDir` → `/workspace`。
- 它显式选择 local，因此不会因为根级 mode 是 gondolin 而启动 VM。
- `--chat-workspace` 仅作用于独立会话，不覆盖 `--chat-conversation` 的频道配置。
- `--chat-local` 和显式 `--chat-conversation` 不可同时使用。
- pi provider 的认证留在 pi 进程中；子 bash 不继承这些环境变量。
- 独立模式没有远端回复路径，`chat_attach/chat_history/chat_request_secret` 不应被当作可用的频道操作。

## 5. 逐文件改动清单

以下对应本轮代码实现，不含原仓库未改动的其他模块。

| 文件 | 状态 | 改动与接手检查点 |
| --- | --- | --- |
| `index.ts` | 修改 | 后端接口替换硬编码 VM；惰性 guest 准备；工具 cwd；secret 写入复用 write tool；动态提示词；local flags；worker cwd；控制命令 checkpoint；worker 冲突预检 |
| `src/core/config-types.ts` | 修改 | `feishu` service、`eventMode`、Feishu 配置、三级 RuntimeConfig、resolved 路径字段 |
| `src/config.ts` | 修改 | runtime 字段加载/继承/验证；local 默认目录；派生 memory/files；配置文件写入后 chmod 0600；Feishu `eventMode` 缺省 HTTP、worker 预检；共享 workspace 警告 |
| `src/execution.ts` | 新增 | 后端接口、动态 import 工厂、`displayPath()` |
| `src/execution-prompt.ts` | 新增 | legacy/XML cwd 替换和明确环境说明 |
| `src/local.ts` | 新增 | 本地 native 文件操作选择、bash 子进程管理、附件 staging、拒绝 VM secrets |
| `src/gondolin.ts` | 修改 | 新增 `mode/workspacePath/sharedPath`，其余 VM 工具实现保留 |
| `src/runtime.ts` | 修改 | transcript 附件路径改用统一 `displayPath()`，队列/消费边界核心算法未重写 |
| `src/secrets.ts` | 修改 | secret name 限制为简单文件名；请求绑定 conversation；写入 0600/目录 0700 |
| `src/live/feishu.ts` | 新增 | HTTP callback server；WebSocket 使用官方 `WSClient` + `EventDispatcher`；AES/token/signature、nonce、转换/去重、回复/上传、断开。看门狗接入后不再把长连接终端错误转成 `onDisconnect` |
| `src/live/feishu-ws.ts` | 新增 | 长连接活动时间、过期检测、销毁重建、指数退避和 `/status` 文本 |
| `src/chat-send.ts` | 新增 | 本地 `/chat-send` 与 `chat_send`：REST 推送，不加频道锁，追加 outbound |
| `src/live/index.ts` | 修改 | 显式 Telegram/Discord/Feishu 路由和未知 service 错误 |
| `src/render/format.ts` | 修改 | Feishu plain-text 分支，避免误用 Discord mention 格式化 |
| `src/services/feishu.ts` | 新增 | tenant REST client、identity、Feishu discovery provider |
| `src/services/types.ts` | 修改 | AccountDraft 变为 token 服务与 Feishu credentials 的联合类型 |
| `src/services/index.ts` | 修改 | 注册 Feishu provider，身份更新支持 Feishu |
| `src/services/discord.ts` | 修改 | AccountDraft service narrowing，防止误传 Feishu draft |
| `src/services/telegram.ts` | 修改 | 同上，Telegram 分支 narrowing |
| `src/tui/feishu-setup.ts` | 新增 | 自建 App guided setup；新建默认 WebSocket，编辑可切回 HTTP；手动 chat ID 和用户 open ID |
| `src/tui/chat-config.ts` | 修改 | Feishu 菜单；global/account/channel runtime UI；编辑频道保留已有配置；Discord 已配频道进入完整菜单 |
| `src/tui/dialogs.ts` | 修改 | 无 UI 时 loader 直接执行 work、notice 使用 notify，支持非交互启动路径 |
| `package.json` | 修改 | Feishu/Lark keywords；`npm test`；开发依赖 tsx |
| `package-lock.json` | 修改 | 锁定新增 tsx 及其依赖；不是全面依赖安全升级 |
| `tsconfig.json` | 修改 | 把 `tests/**/*.ts` 纳入类型检查 |
| `tests/helpers.ts` | 新增 | 临时目录 conversation fixture，避免测试改写真实聊天数据 |
| `tests/runtime.test.ts` | 新增 | 配置/继承、路径提示、worker 冲突、trigger/失败边界/DM 回归 |
| `tests/local.test.ts` | 新增 | 本地工具、cwd、附件、env、timeout/abort/close、VM secrets 拒绝 |
| `tests/feishu.test.ts` | 新增 | callback 安全、转换、REST token、HTTP adapter、分片/上传、重连去重、重放和 reply fallback。另覆盖看门狗重建后的 message id 去重 |
| `tests/feishu-ws.test.ts` | 新增 | 健康阈值、退避抖动、socket 活动探测、过期/关闭重建、断开停止重连、stderr |
| `README.md` | 修改 | 新功能、安装、运行配置、限制、测试说明 |
| `AGENTS.md` | 修改 | 架构及开发约定同步到双后端/Feishu |
| `docs/configuration.md` | 新增 | 可复制配置、启动方式和飞书人工验收清单 |
| `docs/DEVELOPMENT.md` | 新增 | 本交接文档；状态表随后续安全修复更新 |

## 6. 未完成事项与建议开发顺序

### 6.1 验收前应完成（高优先级）

- [ ] **真实飞书/Lark 人工联调。** 当前用户明确要求由用户执行；自动化使用的是 mock，且不会打开飞书 WebSocket。验证 Bot 发布、权限、订阅方式（长连接或 HTTP callback URL）、token/key、DM、mention、访问限制、长回复、附件和 reconnect。
- [ ] **真实 Gondolin 回归。** 使用满足版本要求的 Node 和 QEMU，验证默认旧配置仍能启动、四个工具运行于 VM、自定义 host workspace 挂载及 secrets hook 不退化。
- [ ] **明确是否接受一 App 一活动频道。** 若产品要求一 App 接多个独立 worker，当前设计不足，见下一节 dispatcher 建议。
- [x] **审查凭据和 runtime-secret 权限。** `saveChatConfig()` 写入后 `chmod 0600`，可修复已有文件。runtime secret 目录为 `0700`、文件为 `0600`。聊天 home 目录权限没有强制改成 `0700`，已有过宽的目录仍需人工收紧。
- [x] **审查 secret 回包授权。** 回包必须属于当前 conversation、运行时已 arming，且发送者通过 access policy。未授权用户静默忽略；授权但过期/错频道的回包会得到拒绝提示。pending secret 仍只在内存中，重启后失效，也不是跨进程授权系统。
- [x] **检查已有依赖漏洞。** 本环境 `npm audit --omit=dev --audit-level=high` 仍报告 21 项（9 moderate、12 high），涉及现有 pi peers、Discord/Gondolin 及其依赖。没有执行破坏性 audit fix。升级应分批进行，并重跑平台/VM 回归。

### 6.2 飞书后续能力

- [ ] **账号级 dispatcher / broker。** 一个 listener 验证并持久化 account events，然后按 chat ID 分发给多个 worker。应设计跨进程 ownership、subscriber 注册、背压、停止/重连、ack 和重放；不能仅删除端口预检。
- [ ] **持久化 callback inbox。** 将快速 ack 与业务处理解耦，区分 event ID/message ID、处理中/已完成状态，减少平台重试时的边界问题。
- [ ] **入站图片/文件/音视频。** 根据平台 message resource API 下载，用 `storeDownloadedAttachment()` 生成 `AttachmentInput`，增加 MIME、大小和异常控制。
- [ ] **更完整的 rich-text/card 支持。** 本地化结构、超链接、图片节点、交互卡片及 Markdown 渲染都需 fixture 覆盖。
- [ ] **429/5xx 策略。** 只读 GET 会立即重试一次。消息发送仍不自动重试，因为没有平台级幂等键；需要 backoff 时必须同时设计去重。
- [x] **未知或被删除的 reply target。** reply 返回 IM `230000`–`239999` 时回退到普通发送一次。鉴权、限流和 5xx 不回退。
- [ ] **频道发现/用户管理。** 当前手动输入 IDs；配置 UI 没有飞书用户/角色发现。
- [ ] **更完整的安全/错误测试。** 已覆盖 malformed body、listener 端口冲突、超限 payload、连接内签名重放和 reply fallback。仍缺回调处理失败后的持久化 partial failure、abort 和真实 API 失败矩阵。

### 6.3 本地后端与配置后续工作

- [x] **启动失败后的 fail-closed 行为审计。** `--chat-local` 启动失败后不暴露宿主机 cwd 工具，状态栏保留错误。频道连接失败仍按原路径清理，不把会话标成已连接。pi 是否因扩展异常退出仍取决于宿主 pi 版本。
- [ ] **后台进程生命周期策略。** 当前跟踪直接启动的 bash 及其进程组；自行 daemonize/setsid 的进程、父 shell 提前退出的场景需要专门测试/文档。
- [ ] **必要的 env allowlist 配置。** 有需要时添加显式、可审计的变量配置，不要直接恢复复制宿主机 `process.env`。
- [ ] **本地目录/secret 安全策略。** local 本来不隔离，但仍应避免意外外发附件、secret symlink/traversal 和不必要的宽文件权限。
- [ ] **配置热更新一致性。** 当前 runtime/workspace 改动要求 disconnect/reconnect；入口自动 restart 主要检测 secrets。后续若热更新，应统一处理 live adapter、runtime、后端和捕获的 conversation 引用。
- [x] **更加一致的凭据编辑 UX。** 编辑飞书凭据时 Encrypt Key 空输入保留旧值，输入 `-` 才关闭加密；新建账号时空输入仍表示不启用。取消输入不会保存。
- [ ] **workspace 冲突提示与迁移。** `/chat-spawn-all` 会对共享 workspace 给出警告，但仍不阻止，也不迁移旧 memory/skills/files。迁移应显式确认并保留备份。
- [x] **独立模式工具集合。** `--chat-local` 只激活 `read/write/edit/bash`。频道工具仍注册在扩展里，但不会交给独立会话的模型。
- [ ] **更彻底的本地依赖解耦。** 运行时不加载 Gondolin，不代表 npm 安装时不安装它。若需要完全无 Gondolin 包的安装，可评估 optional dependency/分包，注意 VM 模式错误提示和锁文件兼容。
- [ ] **新增集成测试。** 目前没有完整 tmux 多 worker、真实 session/new/compact、secret 交换、native tool 替换全生命周期回归。

### 6.4 现有基础设施的已知边界

- `loadChatConfig()` 读取/解析错误时返回默认空配置，错误配置可能被误认为“没有账号”。排障时先校验 JSON 并备份，不要立即在 UI 保存覆盖。
- `readConversationLog()` 有较宽的错误兜底；损坏 JSONL 可能让日志看起来为空。生产增强应考虑逐行恢复、错误定位和原文件保护。
- failed job 的重试依赖新的 trigger；去重集合不会因为模型失败而允许同一个 callback 再次创建任务。
- disconnect/new session 与正在运行的 turn、adapter callback 之间存在并发状态，扩展时应补充 race tests，避免使用已经切换的 context。
- 消息分片是共享字符级工具，不是针对所有平台格式、Unicode 边界和 byte limit 的完整协议实现。

这些待办不是本轮承诺的已完成能力，也不是要求接手者一次全部重构；建议先完成人工验收和安全边界确认，再做账号级分发。

## 7. 本地源码安装、检查与运行

以下用当前仓库实际路径 `/workspace/pi-chat`。在别的机器上替换该绝对路径。

### 7.1 环境要求

```bash
node --version
npm --version
pi --version
command -v bash
```

本次实际测试环境：

- Node `v22.23.3`
- npm `10.9.9`
- pi `1.1.0`
- Linux，存在 `/bin/bash`

Gondolin 0.7.0 声明 Node `>=23.6.0`。Node 22 上 `npm ci` 会出现 `EBADENGINE` 警告，但本地模式已验证能运行。若 npm 配有 `engine-strict=true`，安装可能直接失败；推荐在需要完整 VM 功能时使用满足要求的 Node，例如 Node 24，并安装 QEMU。

`tmux` 只在使用 worker 管理命令时需要，不是单进程或独立本地测试的依赖。

### 7.2 精确安装命令

```bash
cd /workspace/pi-chat
npm ci
npm run check
npm test
pi install /workspace/pi-chat
pi list
```

重要说明：

- `pi install /workspace/pi-chat` 安装的是本地源码 package 引用，用户级 pi settings 会记录该目录；不是构建一个独立 `pi-chat` 可执行文件。
- `pi list` 可能显示相对用户 settings 的路径，同时显示解析后的 `/workspace/pi-chat`，这是正常的。
- local source package 的依赖需先 `npm ci`；不要假定 `pi install` 会替本地目录执行依赖安装。
- 修改源码后，新 pi 进程会使用新代码；已有进程建议先断开再重启。不要依赖 module cache 被自动清除。
- 本仓库仍声明旧 namespace 的 pi peers（`@mariozechner/...`）；当前安装的 pi 1.1.0 实际加载已通过。迁移 namespace 前必须核对运行时映射和导出，不能只做字符串替换。

取消本地 package 注册（仅在确实要卸载时）：

```bash
pi remove /workspace/pi-chat
```

### 7.3 “构建”在本项目中的含义

当前没有 `npm run build`，没有需要运行的 `dist/index.js`。

- `package.json` 的 `pi.extensions` 指向 `./index.ts`。
- pi 负责加载 TypeScript 扩展。
- `tsconfig.json` 设置 `noEmit: true`。
- `npm run check` 执行 Biome 和 `tsc --noEmit`。
- `npm test` 用 tsx 运行 TypeScript 测试。

因此当前可用的交付验证是安装依赖 → 检查/测试 → 加载源码扩展，不要凭空添加一个未存在的 build 步骤。

### 7.4 不安装 package，直接加载源码

```bash
cd /workspace
pi --no-extensions -e /workspace/pi-chat/index.ts \
  --chat-local --chat-workspace /workspace \
  --model openai/gpt-6-luna:low
```

`--no-extensions` 禁止其他自动发现扩展，但显式 `-e` 仍被加载，适合隔离扩展冲突。不带该选项时要注意已安装 package 与其他扩展是否覆盖相同工具。

### 7.5 启动真实消息频道

先通过 `/chat-config` 或手动合并配置设置账号和频道。下面不是完整配置，仅演示根级运行项：

```json
{
  "runtime": { "mode": "local", "workspaceDir": "/workspace" }
}
```

**不要用这个片段覆盖已有 `accounts`。**完整 Feishu/Lark 配置在 [configuration.md](configuration.md)。

```bash
cd /workspace
pi --model openai/gpt-6-luna:low \
  --chat-conversation feishu-team/general
```

或进入 pi 后：

```text
/chat-config
/chat-list
/chat-connect feishu-team/general
/chat-status
/chat-disconnect
```

`account/channel` 使用配置 object key，不是显示名称，也不是远端 chat ID。

### 7.6 tmux workers

先确认 `tmux -V`，再在 pi 中使用：

```text
/chat-spawn-all
/chat-workers
/chat-open-all
/chat-kill-all
```

需要重建时：

```text
/chat-spawn-all --restart
```

排查某个 worker：

```bash
tmux list-sessions
tmux attach -t pi-chat-worker-ACCOUNT_CHANNEL
```

实际 tmux 名称由 `tmuxSafeName(conversationId)` 生成，有字符替换和长度限制，优先从 `/chat-workers` 或 `tmux list-sessions` 复制，不要手工猜。

## 8. 指定模型的本地 /workspace 冒烟测试

### 8.1 认证与模型检查

```bash
pi --list-models gpt-6-luna
pi auth check --provider openai --json
```

本环境列表包含 `openai/gpt-6-luna`，认证检查为 ready。目标必须精确为 `openai/gpt-6-luna:low`；如果缺失或无权限，报告错误并补齐 pi provider 配置，**不要悄悄换模型**。

不要在日志里执行/展示 `print-api-key` 或 `print-bearer-token`。模型认证属于 pi，不应写入聊天账号 App Secret 字段。

### 8.2 最短可复制命令

```bash
cd /workspace
pi --chat-local --chat-workspace /workspace \
  --model openai/gpt-6-luna:low --no-session \
  -p 'Use bash to run pwd. Then reply with LOCAL_OK and the directory.'
```

这不需要飞书/Telegram/Discord 凭据，也不打开 callback listener。它验证的是本地执行后端与真实 pi/model 的整合，不是远端消息传输。

交互常驻会话：

```bash
cd /workspace
pi --chat-local --chat-workspace /workspace \
  --model openai/gpt-6-luna:low
```

### 8.3 带审计日志的完整命令

Linux 环境可以使用 `timeout`；macOS 没有该命令时移除它或安装相应工具。

```bash
cd /workspace

timeout 180 pi \
  --chat-local \
  --chat-workspace /workspace \
  --model openai/gpt-6-luna:low \
  --no-session \
  --no-mcp \
  --no-skills \
  --no-context-files \
  --mode json \
  -p 'This is a pi-chat local backend smoke test. Use the bash tool exactly once to run: pwd; printf "PI_CHAT_HOME=%s\n" "$HOME". Do not read or modify any files. Then reply with LOCAL_OK, the working directory, and the HOME value that the tool returned.' \
  > /tmp/pi-chat-local-smoke.jsonl \
  2> /tmp/pi-chat-local-smoke.stderr

code=$?
printf 'SMOKE_EXIT_CODE=%s\n' "$code"
```

验收条件：

1. 命令退出码 0，stderr 无扩展加载/启动错误。
2. `tool_execution_end` 的工具名为 `bash`，`isError` 为 false。
3. 工具输出包含：

   ```text
   /workspace
   PI_CHAT_HOME=/workspace
   ```

4. 最终 `message_end.message`：
   - `role: "assistant"`
   - `provider: "openai"`
   - `model: "gpt-6-luna"`
   - `thinkingLevel: "low"`
   - `stopReason: "stop"`
   - 文本包含 `LOCAL_OK`。
5. 没有启动 QEMU 或 guest image preparation。

`HOME=/workspace` 是本地后端的显式设置，除 cwd 外还能帮助区分普通宿主机默认 bash 和 pi-chat 的本地 bash operations。

### 8.4 本轮已得到的真实结果

执行了两轮真实模型测试：

- 第一轮从 `/workspace` 启动，工具 cwd `/workspace`。
- 第二轮从 `/workspace/pi-chat` 启动，仍用 `--chat-workspace /workspace`，工具 cwd `/workspace`，验证它不依赖调用进程的 cwd。

第二轮日志：

- `/tmp/pi-chat-local-smoke-final.jsonl`
- `/tmp/pi-chat-local-smoke-final.stderr`

实际输出摘要：

```json
{
  "result": "PASS",
  "processCwd": "/workspace/pi-chat",
  "provider": "openai",
  "model": "gpt-6-luna",
  "thinking": "low",
  "toolOutput": "/workspace\nPI_CHAT_HOME=/workspace\n",
  "reply": "LOCAL_OK — working directory: `/workspace`; HOME: `/workspace`",
  "stderr": "empty"
}
```

退出码为 0；这是 one-shot 测试，进程测试后已退出，不是在后台留了一个飞书机器人服务。安全修复之后又从 `/workspace` 复跑了同一命令，退出码仍为 0，stderr 为空，bash 输出仍是 `/workspace` 与 `PI_CHAT_HOME=/workspace`，最终回复包含 `LOCAL_OK`，模型为 `openai/gpt-6-luna`、thinking `low`，没有启动 QEMU。以上 `/tmp` 文件是当前环境产物，不属于仓库，可能被临时目录清理。

**提示词调试陷阱：**新版 pi 的 JSON transcript 可以继续记录原始 structured system sections，即使扩展返回了覆盖后的 `systemPrompt`。因此不能单凭日志中 `sections.cwd` 仍是进程 cwd，就断言后端工作目录替换没有生效。本轮曾用这一错误假设做日志断言，随后依据 pi 扩展契约纠正；最终验收用真实工具输出、模型身份、回复和单元测试。原始 session `cwd` 也代表 pi 进程的 cwd，不是工具 cwd。

## 9. 自动化测试和类型检查

### 9.1 常用命令

```bash
cd /workspace/pi-chat

# 标准检查，不写文件
npm run check

# 测试
npm test

# 分别检查
npx biome check .
npx tsc --noEmit

# 单文件测试
npx tsx --test tests/local.test.ts
npx tsx --test tests/feishu.test.ts
npx tsx --test tests/runtime.test.ts

# Git whitespace 检查
git diff --check

# 仅在准备修改格式时运行；此命令会写源码
npm run format
```

本轮 `npm run check` 无错误，`npm test` 为 32 passed、0 failed。斜杠命令测试不启动真实 pi 会话。`git diff --check` 需在改动后重跑。

### 9.2 测试覆盖范围

| 测试文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/feishu.test.ts` | 13 | token/AES/signature/expiry/app ID/nonce；消息过滤/身份/控制 mention；rich-text；Lark token cache/refresh；本地 HTTP callback、去重、分片、文件发送、query string、超限 body、端口冲突、签名重放、reply fallback、GET 单次重试；WebSocket `EventDispatcher` 去重/app 过滤/不占端口；非法 App ID 不发网络请求，缺省 eventMode 仍要求 HTTP token；Typing/CrossMark 生命周期、`reactions` 与 `FEISHU_REACTIONS` 开关、表情 API 失败不影响连接 |
| `tests/local.test.ts` | 3 | native read/write/edit/bash/cwd/staging；最小 env、timeout、已 abort/运行中 abort、close；拒绝 Gondolin secrets 且失败后工具不可用 |
| `tests/model-command.test.ts` | 3 | `/model` 列表、`provider/id` 与 `:thinking` 匹配、未知 pattern 建议、非法 thinking level |
| `tests/slash-commands.test.ts` | 5 | 斜杠解析、空白名单只读策略、`/help` 列出扩展命令并隐藏 chat 管理命令、飞书卡片/去重、禁止命令不执行 |
| `tests/runtime.test.ts` | 7 | 配置默认值/继承/验证；旧/新 pi prompt cwd；worker 冲突、WebSocket 不占端口、未知 eventMode；配置文件权限；catch-up/access/失败消费边界；DM/VM display path 回归；缺省 eventMode 为 HTTP；`/model` 控制命令解析 |
| `tests/secrets.test.ts` | 1 | secret 名称、conversation 绑定、清理，以及 secret 文件/目录权限修复 |

飞书测试只 mock 官方 REST；HTTP callback 使用本机临时端口。WebSocket 用例注入 session factory，调用真实 `EventDispatcher`，不打开平台长连接。不会访问真实飞书 App。fixture 把 conversation 文件路径重定向到临时目录并清理。

这些测试不能替代：

- 真实 Discord/Telegram/Feishu 平台权限和网络联调；
- 真正的 QEMU VM 启动；
- 全生命周期的 tmux worker orchestration；
- 真实平台限流、崩溃恢复和高并发。

### 9.3 添加测试的建议

- 新配置字段：在 `runtime.test.ts` 加默认值、三级覆盖、非法输入、旧配置兼容。
- 新后端行为：先用临时 workspace 和真实工具 factory 测试，不先接模型或平台。
- 新飞书事件：保存去标识/去凭据的官方 payload fixture，测试转换层，再测 HTTP adapter。
- 各种重试：显式统计 API 调用次数，验证幂等，而不是仅断言“最终成功”。
- 进程终止：测试 pre-aborted signal、运行中 abort、timeout、disconnect，确保 Promise 结束且无未处理 rejection。
- 端到端模型测试：保持 prompt 小且只读，固定模型，独立记录 stderr 和 JSON 事件，不写真实项目文件。

## 10. 调试工作流

### 10.1 先区分故障层

```text
扩展未加载？
  → pi list / 显式 -e / stderr
后端未启动？
  → runtime config / workspace 权限 / local secrets / QEMU
平台未接入？
  → credentials / eventMode / webhook 或 WebSocket 订阅方式 / gateway / polling
消息已入站但无 job？
  → arming / dm / trigger / allowed users / bot IDs
有 job 无模型请求？
  → ctx.isIdle / chatTurnInFlight / pending queue
模型跑完但没回消息？
  → stopReason / send API / reply ID / attachment upload
路径看起来不对？
  → process cwd vs workspaceDir vs workspacePath vs transcript sections
```

### 10.2 扩展加载和版本问题

```bash
pi list
pi --version
pi --help
cd /workspace
pi --no-extensions -e /workspace/pi-chat/index.ts \
  --chat-local --chat-workspace /workspace \
  --model openai/gpt-6-luna:low --no-session -p 'Reply with READY.'
```

如果有多个扩展注册 `bash/read/write/edit`，先用显式加载隔离，确认工具实现未被其他扩展覆盖。`READY` 只验证模型回复；仍需前面的 pwd/HOME 测试验证工具后端。

遇到 pi API 差异时，阅读当前安装版本的扩展文档和 `.d.ts`。不要只根据本仓库 peerDependency 的 `"*"` 推断所有历史版本都兼容。

本环境可参考：

```text
/home/box/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
/home/box/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/cli.md
/home/box/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md
```

### 10.3 runtime / log / lock

重点定位：

```text
~/.pi/agent/chat/config.json
~/.pi/agent/chat/accounts/<account>/channels/<channel>/channel.jsonl
~/.pi/agent/chat/accounts/<account>/channels/<channel>/.lock
~/.pi/agent/chat/worker-status/<tmux-safe-name>.json
```

JSONL 中按顺序检查：`inbound` → `checkpoint` → `job_queued` → `outbound` → `job_completed`，失败时查 `job_failed/error`。

- `.lock` 中含 owner PID；仅确认对应进程已死后才考虑手动处理。
- 原逻辑会尝试回收 dead PID lock；活进程锁不能直接删除后并发连接同频道。
- worker status 约每 15 秒刷新；进程已退出时最后一个文件可能仍在，要结合 tmux/PID 和更新时间判断。
- 配置和日志包含敏感消息，不要直接发到公共 issue。

### 10.4 飞书 callback 排障

监听检查（Linux）：

```bash
ss -ltnp 'sport = :3000'
```

本机 URL verification 探针只用于隔离 HTTP listener/token 问题。用临时测试账号或从环境变量读取 token，不要把真实 token 写进可共享脚本。真实平台上的加密/签名还需要人工验证。

常见对应关系：

| 现象 | 首先检查 |
| --- | --- |
| bot identity 请求失败 | App ID/Secret、region、Bot 能力、发布范围 |
| 没有任何 callback / WebSocket 事件 | 订阅方式是否与 `eventMode` 一致；HTTP 查公网 HTTPS 和反向代理；WebSocket 查长连接模式、出站网络、事件已发布、机器人已入群。不要两种订阅方式同时开 |
| WebSocket 连接超时或 App ID 错误 | App ID 必须是 `cli_` + 16 位十六进制；region 与 domain 一致；30 秒内没有 `onReady` |
| 404 | 请求必须为 POST，path 在去掉 query string 后完全匹配 |
| 403 | Verification Token、Encrypt Key、raw body、签名 headers、系统时间 |
| 413 | callback 超过 1 MiB |
| 500 | payload content 不符预期、业务 handler/日志错误；检查 runtime error 和 stderr |
| `EADDRINUSE` | 另一个 worker/App 占用同端口 |
| 消息日志有记录但无回复 | allowedUserIds 是否为 open ID、dm/trigger、mention metadata、job/model/send 状态 |
| 重连后旧消息不触发 | 去重或无 history backfill，这是当前策略，不等于 gateway 丢事件 |
| 上传文件失败 | `im:resource` 等资源权限、文件大小/格式、平台 response code |

反向代理使用 `proxy_pass` 到本机 listener，保留请求体和 `X-Lark-*`。当前代码没有 built-in TLS，因此不要把它当作已经配置好证书的公网 server。

### 10.5 本地执行排障

| 现象 | 原因/处理 |
| --- | --- |
| `/workspace` 创建失败 | 当前用户没有权限；创建可写目录或配置其他绝对路径，不要为方便直接运行 root |
| `Gondolin HTTP-hook secrets cannot be used in local mode` | 检查根/账号/频道合并后的 secrets；移除相关设置或选择 VM，不是工具故障 |
| bash 中看不到 OPENAI_API_KEY | 预期行为：子进程环境被精简；模型客户端在 pi 进程中仍可认证 |
| HOME 不是真实 home | 预期为 workspace，用于减少意外读取 shell/profile 配置 |
| `apk` 不存在 | local 不保证 Alpine；按宿主机系统操作，不要套用 VM 安装命令 |
| read/write 能访问 workspace 外部 | local 不隔离，这是安全模型本身；需要隔离就用 VM/独立 OS 用户 |
| `chat_attach` 拒绝文件 | 出站 staging 只允许 workspace/shared 内的 realpath 普通文件 |
| 修改了 runtime 但没有变化 | 断开重连；现有 pi 进程 project cwd 也不会自动改变 |
| `--chat-workspace` 没覆盖频道 | 该 flag 仅用于 `--chat-local`，频道用 JSON runtime 配置 |
| Node 22 安装提示 Gondolin engine | 安装依赖仍包含 Gondolin；local 不执行其 VM 代码，但严格 engine 设置可能阻止安装 |

## 11. 接手后的推荐第一天流程

1. 保存现有工作树，阅读本文件和 `docs/configuration.md`，确认产品是否接受飞书单 App 单活动频道限制。
2. `npm ci && npm run check && npm test`，先建立 13 测试全绿基线。
3. `pi install /workspace/pi-chat` 后重复只读模型冒烟测试，确认 provider/model/thinking 和 pwd/HOME。
4. 不改变现有用户账户的前提下，用专用测试飞书 App 完成人工验收；保留去敏 payload 和错误码。
5. 在有 QEMU/正确 Node 的环境跑 VM 默认路径和自定义 workspace 回归。
6. 先处理发现的协议、安全和生命周期问题，再决定是否拆分 `index.ts` 或实现共享 dispatcher。
7. 每次改动明确区分“已编写”“mock 验证”“真实平台验证”，更新测试和本文的状态表。
8. 未经要求不要推送 Git；不要把 App Secret、模型凭据、真实聊天日志或 `.secrets/` 加入仓库。
