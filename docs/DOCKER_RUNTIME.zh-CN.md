# Docker 执行后端：实现指南

> **状态：实现指南；工作区已有实现，验证范围见 §14.2。** §§1–13 保留原设计和发布门槛，其中“提议”、源码基线和历史环境说明不是当前实现状态。§14 记录本轮决定、真实测试结果及尚未完成的发布验证；不能把局部 E2E 通过解读为全部平台/安全矩阵已认证。
>
> 范围：在 `gondolin` 和 `local` 之外新增 Docker **工具执行**。pi/模型客户端、消息适配器、会话日志和控制器仍留在宿主机上。

## 1. 依据、范围和术语

### 源码基线

引用基于以下已检查的版本；行号以此基线为准，实现过程中会变动：

- pi-chat：`/workspace/pi-chat`，提交 `e6678cfd49dc08697cc73056c3de9fb776c07044`；初始工作区干净。
- Gondolin：`/workspace/gondolin`，精确标签 `v0.7.0`，提交 `c9a37ff25d8a517dc0ce576a622d8685c2711fdc`；`host/package.json:3` 声明 `0.7.0`。pi-chat 声明的是 **`^0.7.0`**，不是精确锁定（`package.json:25`）。实现时要核对 lockfile/实际安装版本。
- 已有交接文档：[`DEVELOPMENT.md`](DEVELOPMENT.md)，尤其是 §§2–4、6.3–6.4 和 9；[`configuration.md`](configuration.md) 中的运行时继承和 standalone 模式。
- 背景分析：`/workspace/gondolin-control-plane.md:24–209`（生命周期/状态）、`:211–247`（空闲/复用）；`/workspace/microvm-runtime-hardening/docs/threat-model.md:39–165`（资产、边界、风险、未决结论）。
- 已安装的工具契约：`node_modules/@mariozechner/pi-coding-agent/dist/core/tools/{bash,read,write,edit}.d.ts`。也检查了已安装的 pi 扩展文档和远程操作示例：`/home/box/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` 和 `examples/extensions/ssh.ts`。编码前再确认一次实际安装版本；仓库的 pi peer 依赖是 `"*"`。

像 `src/execution.ts:5–25` 这样的 pi-chat 路径相对于本仓库。`G/host/src/...` 表示 `/workspace/gondolin/host/src/...`。外部 Docker/gVisor 参考资料集中在 §15，它们说明的是 API 语义，**不能**证明提议的部署已经测试过。写本文时没有跑过真实的 Docker 或 gVisor 端到端测试；当时本机 PATH 上没有 `docker`。已有交接文档里的测试数量是历史数据，而且各节不一致；发布门槛以实际测试输出为准，不以这些数字为准。

### 目标

1. 可以显式选择 `runtime.mode: "docker"`，且不改变旧配置默认使用 Gondolin 的行为。
2. 每个已连接会话在一个受管容器内运行 `read`、`write`、`edit` 和 `bash`；支持一个隔离的 standalone 冒烟测试模式。
3. 保留宿主机持久化的 `/workspace` 和账号级 `/shared`、附件路径、memory/skills、任务消费边界和平台行为。
4. 提供有时限的启动/关闭、流式输出、真正的取消、空闲回收，以及受控的 stop/start 复用。
5. 默认拒绝出网；可选通过中介转发 HTTP(S)，带主机名策略和由宿主机持有密钥的替换机制，类似 Gondolin 的 HTTP 钩子。
6. 默认最小权限，并在诊断信息中如实展示实际隔离级别、生效的限制和生命周期状态。
7. 普通单元测试不依赖 Docker、QEMU、消息平台凭证和模型提供方。另加一套需单独选择的真实 Docker 测试。

### 首个版本的非目标

- 把 pi、它的 API 凭证、机器人凭证或适配器搬进 Agent 容器。
- 替换 Gondolin、宣称 Docker/runc 等同于 microVM，或静默回退到 local/runc/不受限网络。
- Kubernetes、Swarm、任意远程 Docker 守护进程、Docker-in-Docker、特权容器、host 网络、GPU/设备直通，或任意 `docker run` 参数。
- 通用 TCP/SSH/UDP/QUIC 转发、入站/端口发布、浏览器网络对等能力，或为忽略显式代理的客户端提供透明网络。
- 内存/进程快照、CRIU、自动 `docker commit`，或在空闲关闭后保留后台进程。
- 重新设计聊天授权、投递保证或待处理任务的重建算法。
- 把提示词指令或环境变量代理配置当作安全边界。

**建议的支持边界：** 先认证本地 Linux Docker Engine、Linux 容器、生效的 cgroup 限制，以及专用的非 root 控制器账号。Rootless Docker 和 `runsc` 是单独测试的配置。在挂载、UID、socket 和资源测试通过之前，不要宣称支持 Docker Desktop、远程 context、用户命名空间重映射或其他运行时。

## 2. 现有代码实际做了什么

### 执行与连接行为

- `src/execution.ts:5–16` 定义通用操作接口；`:18–25` 懒加载 local，否则加载 Gondolin。目前最后一个分支是兜底，而不是穷尽的模式判断。
- `src/gondolin.ts:73–101` 创建目录、构建密钥钩子、用两个 `RealFSProvider` 挂载创建虚拟机、探测/尝试安装 bash，并把 `{vmId, secretNames}` 写入 `gondolin/session.json`。这个文件不是恢复机制。`:103–108` 关闭虚拟机；pi-chat 没有空闲计时器，也没用 checkpoint。
- local 执行有意返回 `undefined` 的文件操作，从而使用 pi 的宿主机文件系统实现（`src/local.ts:71–82`）。它的 bash 环境刻意保持最小，并忽略调用方的环境继承（`:110–181`）。local 启动时会拒绝所有合并后的 Gondolin 钩子密钥（`:32–48`）。不要把它返回 `undefined` 操作的做法照搬到 Docker。
- `index.ts:836–1043` 解析会话、断开上一个会话、只为 Gondolin 准备 QEMU、获取运行时锁、启动执行，然后连接实时适配器。失败清理会关闭执行并释放运行时锁。
- 工具委托在 `index.ts:530–558`；注册在 `:1680–1716`。它们使用 `sandbox.workspacePath`，不是 `ctx.cwd`。`sandbox` 名字是历史遗留，现在其实是 `ConversationExecution`。
- 远程轮次有工具白名单（`index.ts:1432–1443`）。这不是整个进程的隔离：扩展、斜杠命令集成、模型访问、memory 加载、下载、密钥写入和日志仍在宿主机上执行。
- `executionRequired` / `executionError` 目前只对 **standalone local 启动** 强制持久的失败即关闭（`index.ts:1735–1767`）。不要假设连接模式的失败也有同样的保护：没有 sandbox 时，委托可能选用宿主机工具。选择 Docker 的启动、替换和意外退出路径都需要自己显式的失败锁存。

### 与新设计相关的 Gondolin 语义

| 关注点 | 已核实的行为 | 对 Docker 的影响 |
| --- | --- | --- |
| 虚拟机/根存储 | 虚拟机获得新 UUID（`G/host/src/vm/core.ts:342–350`）。读取镜像 manifest 默认值后，根模式回退到 `cow`（`:486`）；COW 分支创建一次性 overlay（`:573–590`）。关闭时删除"关闭即删"的根磁盘（`:1392–1450`）。 | 持久化的 bind 挂载与 rootfs 持久化是两回事。不要把容器 stop/start 等同于虚拟机挂起。 |
| 执行 | pi-chat 使用 bash、`proc.output()` 和 `exitCode`（`src/gondolin.ts:299–339`）。Gondolin 发送 exec 帧和流控额度更新（`G/host/src/vm/core.ts:1090–1192`）。 | Docker 需要流解复用和 exec 查询，而不是虚拟机协议。 |
| 中止 | 检查过的 Gondolin 中止监听器只会拒绝/移除宿主机侧 exec 会话（`G/host/src/vm/core.ts:1110–1117`），不会在这个监听器里向虚拟机内发送 kill。 | 不能拿它证明进程树被终止。Docker 要显式规定更强的取消。 |
| Checkpoint | `checkpoint()` 尽力同步、关闭虚拟机、保留 qcow2 磁盘，并记录 `snapshotKind: "disk"`（`G/host/src/vm/core.ts:1905–2029`）。恢复时创建一个以 checkpoint 为底的新 overlay（`G/host/src/checkpoint.ts:420–472`）。 | 不延续内存/执行/网络状态。恢复还会调用改写底层路径（rebase）的辅助函数；背景笔记里"checkpoint 从不被修改"的说法太绝对。 |
| 网络边界 | Gondolin 有一套中介式用户态网络栈，不是通用 NAT（`G/docs/architecture.md:123–149`）。HTTP 钩子只是其中一部分。 | 引入 `createHttpHooks()` 并不会得到代理、TLS 拦截或生效的 Docker 网络边界。 |
| 当前 pi-chat 出网 | 有密钥时，pi-chat 调用 `createHttpHooks({allowedHosts: ["*"], secrets})`；没有密钥时不提供钩子（`src/gondolin.ts:29–44`）。 | 现有的密钥主机限制不是通用的出网主机白名单。Docker 的默认值要做得更好，但不要假装 Gondolin 已经有了。 |
| 钩子默认值 | 钩子生成 24 个随机字节作为十六进制占位符，默认开启内网地址拦截，并合并 `allowedHosts`、`allowedInternalHosts` 和密钥主机（`G/host/src/http/hooks.ts:58–82`）。合并后列表为空则全部放行（`:154–168`）。 | Docker 提议的空白名单表示全部拒绝。不要直接把 `[]` 传给 Gondolin 并指望被拒绝；也不要根据密钥定义自动扩大 Docker 的主机策略。 |
| 替换 | 替换请求头字符串和 Basic 认证；查询参数替换需主动开启；请求体不替换（`G/host/src/http/hooks.ts:84–121, 363–490`）。真实值检查会在支持的请求头/查询字段中保护后续不允许的目标（`:274–361`）。 | 照搬这个窄契约，不要做任意请求体/HMAC/SSH 密钥注入。 |
| IP 策略 | 请求检查和解析地址检查是分开的（`G/host/src/qemu/contracts.ts:48–75`）。实际连接时的解析受保护（`G/host/src/http/utils.ts:304–372, 537–583`）；重定向采用手动处理（`G/host/src/qemu/http.ts:1278–1427`）。 | 在普通的无保护 `fetch()` 之前只检查一次主机名，挡不住 DNS 重绑定和重定向。 |

威胁模型里有刻意留下的未决点，它们不是普遍事实。其中两点可从当前代码澄清：`/shared` 是**账号级**的（`src/config.ts:74`）；Gondolin 内置的 `RealFSProvider` 确实有词法/realpath/祖先目录检查（`G/host/src/vfs/node/vendored-node-vfs/lib/internal/vfs/providers/real.js:209–309`），也有逃逸软链接测试（`G/host/test/vfs-realfs-provider.test.ts:127–207`）。这些检查并不能保证宿主机侧每个路径操作都无竞态地限制在范围内。要保留威胁模型中"源码检查"和"运行时验证"的区分。

## 3. 精确的集成点清单

同时使用符号名和这些基线行号。表中的新模块名是建议，不是现有文件。

| 位置 | 需要的实现工作 |
| --- | --- |
| `src/core/config-types.ts:3–7, 117–148` | 在运行时/解析后的模式类型中加入 `"docker"`；定义可选的嵌套 Docker 配置和完全解析后的 Docker 设置类型。新增 Docker 元数据路径，不要挪用 `gondolinDir`。root/account/channel 已共用 `RuntimeConfig`（`:27–43, 118–124`）。 |
| `src/config.ts:43–100` | 用明确的继承规则解析嵌套设置；校验不可信 JSON；缺少 mode 时仍为 Gondolin。Docker 默认使用每个频道独立的宿主机工作区，并显示 `/workspace`、`/shared` 路径。在 `conversationDir` 下增加解析后的 Docker 元数据目录。 |
| `src/config.ts:127–140` | root 运行时配置已能正确读写。不要把新校验放进"加载失败就返回空"的宽泛 catch 里：无效的 Docker 策略必须报错，不能看起来像没配置。 |
| `src/config.ts:107–114, 153–164` | 保留外部工作区的删除语义。删除账号/频道前要考虑仍保留的受管容器。对不安全的重叠工作区给出警告/拒绝；现有警告只按字符串完全相等分组，不处理规范化别名或祖先目录重叠。 |
| `src/execution.ts:5–25` | 扩展模式联合类型；加入懒加载的 Docker 分支和明确的"不支持的模式"错误。绝不为其他后端提前导入 Docker/Gondolin。 |
| **新增** `src/docker.ts` | `DockerExecution implements ConversationExecution`：生命周期、操作租约、路径策略、exec、附件暂存、空闲计时器、归属与复用。 |
| **新增** `src/docker-client.ts` | 可注入的 Docker Engine 传输层；结构化的 create/inspect/start/exec/stop/kill/remove 操作和有界流式传输。不通过 shell 拼接 Docker 命令。 |
| **新增** `src/docker-egress.ts` 及策略辅助模块 | 由宿主机持有的每会话策略/密钥上下文；HTTP(S) 代理、生命周期、限额、DNS 安全的连接器、脱敏。策略要能在没有容器的情况下测试。 |
| **新增** 镜像/辅助程序资产 | 可信的预构建 bash 镜像、非 root 入口点/中继、二进制安全的文件辅助程序。镜像和辅助程序协议一起打版本/digest。这里没有任何东西会在宿主机上自动构建 Agent 写的代码。 |
| `src/log.ts:57–68` | 目录初始化目前总会创建 `gondolinDir`。有意识地新增 Docker 私有目录；未使用的 Gondolin 目录兼容可以先保留。元数据/日志/锁放在挂载根目录之外。 |
| `index.ts:467–480, 1730–1769` | 注册 standalone Docker 参数；校验组合；启动所选的 standalone 执行；只保留四个活动工具。在任何启动操作可能抛错之前就锁存失败状态。 |
| `index.ts:530–558, 1680–1716` | 所有工具都使用 Docker 操作；保持后端报错而不是回退到宿主机。在 bash 委托/注册层加入有界输出集成（§7）。 |
| `index.ts:811–834` | 现有重启逻辑是先启动新后端，**再**关闭旧后端。不要让两个共用同一工作区/代理归属的 Docker 实例竞争。涉及 Docker 的替换要先静默、关闭旧代，再启动/发布新代。失败保持关闭状态。 |
| `index.ts:836–859, 1022–1043` | Docker 预检/启动放在现有的 Gondolin 专属准备逻辑旁边，绝不放进 `prepareGondolin()`。先获取运行时锁，再做 Docker 归属/接管。所有失败都要清理部分创建的 Docker 资源。 |
| `index.ts:1445–1477` | 配置界面目前只比较 `gondolinSecrets`。也要比较生效的 Docker 执行设置/策略，或者 v1 规定所有 Docker 变更都需断开重连。声称更新成功后绝不能继续使用旧策略。 |
| `src/tui/chat-config.ts:30–64` | 增加模式选项并附上准确的隔离提示。现有赋值会整体替换 `target.runtime`；编辑模式/工作区时要保留嵌套的 Docker 字段。若采用下文的兼容 schema，同时更新密钥标签（`:124–160`）。 |
| `src/execution-prompt.ts:4–15`；`index.ts:50–109, 1788–1804` | 在**两条**提示词路径里都加上 Docker 专属的环境说明。对任意镜像不要说 Alpine/apk/全新虚拟机，也不要在只读 rootfs 上建议用 root 装包。 |
| `index.ts:588–630`；`src/runtime.ts:31–44`；`src/execution.ts:27–36` | memory、skills、SYSTEM.md、对话附件使用解析后的路径。保留 `/workspace` 和 `/shared` 显示；`displayPath()` 只是字符串转换，不是安全检查。 |
| `index.ts:866–884`；`src/secrets.ts:44–54` | 运行时密钥交换仍会在宿主机写明文文件。要确保映射后的 UID 能访问，并在有恶意内容的可写挂载中安全写入；与代理持有的密钥区分开。 |
| `index.ts:1325–1339`；`src/gondolin.ts:119–138`；`src/local.ts:84–107` | Docker 的 `stageAttachment()` 给适配器返回私有的**宿主机**路径，不是容器路径。保留接口，但加强路径/竞态安全（§8）。 |
| `index.ts:1383–1429, 1808–1882` | 在轮次、分发错误、发送完成、中止和关闭前后持有/释放执行活动。断开连接时必须停止空闲/代理计时器，并等待或报告销毁结果，然后才释放归属。 |
| `index.ts:1772–1775` | 幂等的 `session_shutdown` 清理仍是必须的。SIGKILL 不会触发它：要加安全的孤儿资源对账。 |
| `index.ts:129–149, 798–806, 1076–1105` | 状态里加入 Docker 状态、短 ID、运行时/镜像标识、限额、空闲/复用和最近一次脱敏的执行错误。worker 快照不得泄露密钥。 |
| `index.ts:387–419` | tmux 仍是宿主机 worker。它传的是 `--chat-conversation`，不是 standalone 执行参数。由配置选择 Docker，无需把 tmux 容器化。不要把 standalone 参数转发给所有 worker。 |
| `tests/helpers.ts:10–32` | 扩展临时测试夹具路径；绝不让新元数据默认落到真实的 `~/.pi/agent/chat`。 |
| `tests/runtime.test.ts:19–70`；`tests/local.test.ts:9–84` | 扩展默认值/继承/提示词测试，并保留原生工具/环境变量/取消/local 拒绝密钥这些回归测试。 |
| `package.json:31–39`；`tsconfig.json` | `check` 和普通 `test` 保持不依赖守护进程；增加需主动选择的 E2E。不要借后端开发顺便大范围升级 peer/依赖。 |

**不要**往 `ConversationRuntime` 里加 Docker 专属调度。它的连接/锁（`src/runtime.ts:71–82`）、分发/切片（`:236–254`）、完成/失败（`:256–295`）仍是会话状态机。执行失败不能伪造 `job_completed`，也不能推进已消费消息的边界。

## 4. 配置与参数：提议的契约

### Schema 和默认值

使用 `runtime.docker`，不要在根级再加第四棵无关的设置树。允许在 root、account 和 channel 层级配置。例如，下面是一段**未来的配置片段**，不是 `config.json` 的完整替换：

```json
{
  "runtime": {
    "mode": "docker",
    "docker": {
      "image": "registry.example.org/pi-chat-tools@sha256:REPLACE_WITH_REAL_DIGEST",
      "pullPolicy": "never",
      "runtime": "runc",
      "user": "1000:1000",
      "memoryMiB": 1024,
      "cpus": 1,
      "pidsLimit": 128,
      "tmpfsMiB": 128,
      "sharedReadOnly": true,
      "network": {
        "mode": "proxy",
        "allowedHosts": ["api.github.com", "registry.npmjs.org"],
        "replaceSecretsInQuery": false
      },
      "lifecycle": {
        "onClose": "remove",
        "idleTimeoutSeconds": 900,
        "retainedTtlSeconds": 86400
      }
    }
  }
}
```

上面的 UID 只是示例：必须与部署的实际归属/映射一致。不要把它硬编码成通用值。

| 设置 | 提议的默认值和校验 |
| --- | --- |
| `runtime.mode` | 现有默认 `gondolin`；显式写 `docker` 才启用。未知或非字符串模式报错。 |
| `runtime.workspaceDir` | Docker 默认 `<conversationDir>/workspace`；允许用宿主机绝对路径覆盖。容器内路径仍是 `/workspace`。不自动迁移，不展开 `~`。 |
| `docker.image` | 在维护中的项目镜像发布之前，必须填写固定 digest 的可信镜像。拒绝缺 digest、形似参数的字符串、平台/辅助程序版本不对的镜像。不要编造已发布的镜像名。 |
| `docker.pullPolicy` | `never`；可选 `if-missing`。只有在运维授权下才通过宿主机 Engine 拉取。拉取不能改变 Agent 的出网策略。绝不把镜像仓库认证传给容器。 |
| `docker.runtime` | 显式 `runc`；可选 `runsc` 或运维批准的具名 runsc 配置。这是 Docker 的 OCI 运行时名，不是 `runtime.mode`。校验 `/info` 和启动结果；绝不静默替换。 |
| `docker.user` | 在已认证的 rootful Linux 上，默认取控制器的非零有效 `UID:GID`，并检查挂载权限。如果控制器是 root，必须显式配置一个非零身份；拒绝 UID/GID 0。命名空间映射需要单独验证。 |
| `memoryMiB`、`cpus`、`pidsLimit` | 1024 MiB、1 个 CPU、128 个 PID。须为正的有限值；内存/PID 为整数。memory+swap 设为与内存相等；不要用 0/-1 表示无限。配置运维上限。 |
| `tmpfsMiB` | `/tmp` 为 128 MiB；`/run` 和 `/dev/shm` 单独设上限（例如各 16 MiB）。拒绝与内存预算不兼容的值。 |
| `sharedReadOnly` | Docker 下为 `true`。显式设为 `false` 会开启账号级写入并给出警告；只读时提示词不能引导写入。现有 Gondolin/local 行为不变。 |
| `network.mode` | 默认 `none`；可选 `proxy`。v1 不提供不受限/host/bridge 模式。 |
| `network.allowedHosts` | proxy 模式下 `[]` 表示全部拒绝。数组会替换继承的数组，包括显式空数组。先只支持规范化的精确 DNS 名；拒绝 `*`、URL、路径、userinfo、IP 字面量和端口。通配符可作为以后经过审查的扩展。 |
| `replaceSecretsInQuery` | `false`；只能显式开启，且不记录查询参数日志。没有请求体替换选项。 |
| `lifecycle.onClose` | `remove`；可选 `stop`，保留已停止容器供经验证的复用。v1 没有 commit 选项。 |
| `idleTimeoutSeconds` | 900；`0` 表示显式关闭空闲回收。非负有限整数。空闲动作是 stop；bind 数据保留。 |
| `retainedTtlSeconds` | 已停止容器为 86400；有界正数。TTL 用于对账，并不保证在没有控制器/维护进程运行时会自动清理。 |

create/start/stop/请求超时和传输字节上限先作为文档化的内部默认值（见 §§6–9）；不要开放自由格式的 `extraArgs`、`env`、`mounts`、`devices` 或 `securityOpt` 后门。配置变更必须通过可信宿主机进行，绝不通过聊天工具参数。

**继承：** 每个标量按 channel → account → root → 默认值 取值。已知嵌套对象逐字段合并，不使用任意深度合并库。数组整体替换；`false`、`0` 和 `[]` 都有意义。拒绝 `null` 和格式错误的结构。在触碰 Docker 之前校验最终生效的组合。即使 root 模式是 Gondolin，channel 层选择的 Docker 模式也可以从 root 继承 Docker 限额/镜像。把模式从 Docker 改走时，保留已存的 Docker 配置，但不执行。

### 密钥 schema 兼容

首个实现中，复用现有合并后的 `conversation.gondolinSecrets`，作为 Docker proxy 模式下 HTTP 钩子式密钥的**旧配置名**。这样迁移最少，并保留全局/账号/频道的密钥继承（`src/config.ts:43–51, 88`）。在界面/文档中明确改标为"HTTP 代理密钥（Gondolin / Docker proxy）"；不要通过通用的 Docker env 设置暴露密钥值。

规则：

- local 继续拒绝这个映射。`network.mode: "none"` 的 Docker 遇到非空映射时报错，而不是静默忽略或暴露。
- 在解析/启动时校验环境变量名、非空值和主机列表，不能只在 TUI 里校验。禁止保留的环境变量键（PATH、HOME、代理/CA 变量、加载器变量等）。
- 对 Docker 而言，密钥目标必须被 `network.allowedHosts` 显式允许；密钥**不能**自动放宽网络策略。按 v1 精确主机规则，每个密钥主机都必须是允许列表中的规范化精确名。遇到通配符旧定义，给出迁移错误，而不是放宽。
- 密钥值保留在宿主机策略内存/配置中。只有随机占位符进入 exec 环境。未来如果引入中性的 `httpSecrets` schema，需要单独的优先级/弃用方案；初期不支持含义模糊的重复 schema。
- `chat_request_secret` 创建的 `.secrets/<name>` 本来就是 Agent 可读的明文，不在"宿主机持有密钥"的保证范围内。

### CLI 行为

建议与现有 `--chat-local` 含义一致，而不是含糊的连接模式覆盖：

- `--chat-docker`：standalone Docker 工具，没有消息连接，没有会话任务运行时。使用 root 的 Docker 设置，与 root `runtime.mode` 无关。
- `--chat-workspace <absolute-host-path>`：对两种 standalone 参数都适用。standalone Docker 的优先级是：显式参数 → root `runtime.workspaceDir` → 专用的 standalone 工作区（例如 `CHAT_HOME/docker-standalone/workspace`），**不会隐式挂载控制器的 cwd 或整个 `/workspace`**。配置的/参数给的路径仍要过挂载安全检查。local 保持当前的 `/workspace` 默认值。
- 可选 `--chat-docker-image <digest-ref>` 只在 standalone Docker 下覆盖 root 镜像；校验必须同时带 `--chat-docker`。
- 拒绝同时使用 `--chat-local` 和 `--chat-docker`；拒绝它们与显式 `--chat-conversation` 同用。与当前 local 模式一样，显式选择 standalone 时不能自动连接已保存的会话。
- 连接模式的 Docker 由配置加 `--chat-conversation account/channel` 或 `/chat-connect` 选择，而不是 `--chat-docker`。
- standalone 实例即使没有会话锁，也需要自己的工作区/元数据租约。并发调用不能意外共用同一个保留的容器。
- 所有无效组合/后端失败都要锁存为"执行不可用"并限制工具；不能让宿主机原生工具保持可用。

## 5. 后端契约和模块边界

保留现有契约，扩展其模式联合类型：

```ts
interface ConversationExecution {
  readonly workspacePath: string;
  readonly sharedPath: string;
  readonly mode: "gondolin" | "local" | "docker";
  start(): Promise<unknown>;
  close(): Promise<void>;
  stageAttachment(path: string): Promise<string>;
  createReadOperations(): Promise<ReadOperations | undefined>;
  createWriteOperations(): Promise<WriteOperations | undefined>;
  createEditOperations(): Promise<EditOperations | undefined>;
  createBashOperations(): Promise<BashOperations>;
}
```

现有工厂接收 `ResolvedConversation`；standalone local 则有意用一个更小的路径/密钥对象构造 `LocalExecution`（`src/local.ts:25–30`、`index.ts:1751–1757`）。给 `DockerExecution` 一个同样明确的执行上下文类型，包含解析后的 Docker 设置、存储/显示路径、密钥定义，以及一个与消息平台无关的归属标识。已解析的会话可以提供这些字段；standalone 解析器必须在不编造 Telegram 账号、不获取假聊天日志锁的前提下提供它们。standalone 的 shared/元数据根目录放在 `CHAT_HOME/docker-standalone/` 下，与 `CHAT_HOME/local/` 分开。

Docker 的所有文件操作工厂都返回实现，绝不返回 `undefined`。`start()` 在可用期间幂等/单飞（singleflight）；`close()` 幂等，并且对该对象是终态，即使它留下了一个可复用的已停止容器。内部的空闲 stop **不是** `close()`。

为编排加一个小的可选扩展是合理的：

- `holdActivity?(): () => void`：获取一个同步租约，阻止空闲 stop，返回一个幂等的释放函数。各操作自己获取租约。轮次级租约防止在模型思考或发送出站附件期间停掉容器。
- `getStatus?()`：返回一个脱敏的值对象用于状态展示。不要把 Docker 客户端、代理、原始 inspect 数据或虚拟机句柄暴露给 `index.ts`。

这些保持可选，现有后端无需实现空闲行为。也可以实现等价的协调器，但不要让后端读取全局的 `chatTurnInFlight` 状态。远程分发和 standalone Agent 生命周期分别接线，并在**每条**终止/错误/关闭路径上释放。pi 工具可能并发执行；需要串行就显式串行，不要从会话任务的顺序推断。

为测试使用一个可注入的小型 Docker 客户端抽象。直接通过 Unix socket 访问 Engine HTTP 就够了；经过依赖审查后用维护中的库也可以。如果直接用 HTTP，要实现 API 版本协商、劫持流解析、可中止的截止时间、JSON 大小上限和类型化错误；不要以为几次 `fetch()` 就能搞定 exec 流式传输。挂载路径、容器名和 ID 都不能做 shell 插值。如果用 CLI 做原型，用基于 argv 的 `spawn`、显式的守护进程端点和最小环境，并在发布前替换掉或完整测试其错误/取消语义。

不要只为了拿网络钩子就在 Docker 模式下导入 Gondolin。要么使用一个不加载虚拟机代码、经过严格审查的辅助模块，要么自己实现有限的兼容替换行为，注明出处并移植测试。独立的宿主机代理仍要自己实现 Gondolin 网络栈围绕这些钩子提供的那套网络机制。

## 6. 容器生命周期和归属

### 状态机

```text
new -> starting -> ready <-> idle-stopped
           |         |           |
           +------> failed <------+  (unexpected loss / policy failure)
                      |
any nonterminal -> closing -> closed
```

内部记录代数（generation）、start/close promise、活动和排队中的操作、轮次租约、空闲截止时间、代理状态、所拥有的容器 ID，以及取消/重置状态。代数栅栏防止关闭/替换之后迟到的 create/start 响应发布就绪状态。

### 预检与 create/start 顺序

1. 解析并校验配置、挂载隔离、归属以及所选镜像/辅助程序契约。获取会话或 standalone 租约。Docker 守护进程访问权是可信控制器的权力，绝不是容器的权力。
2. 连接到明确批准的**本地 Unix socket**。查询 Engine 版本/info；确认 Linux、所需的资源/安全支持、所选运行时和可接受的 API 版本。不要盲目遵从从 pi 进程继承的 `DOCKER_HOST`、`DOCKER_CONTEXT` 或 TLS 变量。如果启用 rootless，显式选择批准的 socket。
3. 检查固定的镜像、架构、入口点/辅助程序版本、声明的卷和镜像环境变量。只有显式配置时才拉取。拒绝未声明的可写/匿名卷效果和意外的入口点；不继承镜像凭证或不安全的加载器变量。
4. 只对账本会话的受管元数据/资源（见下文复用/对账小节）。绝不接管任意同名容器。
5. proxy 模式下，在启动容器之前初始化宿主机策略和私有代理 socket/公开 CA 目录。CA 私钥和密钥表放在所有挂载之外。
6. 用精确的结构化设置（§10）、唯一的代数名和标签调用 `POST /containers/create`；标签包括：managed-by、部署/控制器标识、会话哈希、schema 版本、不可变配置指纹。标签中不能含密钥值。拿到返回的 ID 立即保存，便于清理。
7. `POST /containers/{id}/start`；然后 inspect 并运行有界的就绪探测：预期的辅助程序、bash、非 root 身份、工作区可写、shared 的写/只读行为、安全设置已生效、代理中继可用。启动时不执行 `apk add`/`apt install`。
8. 原子写入私有会话元数据，探测通过后才发布 `ready`。任何失败都要关闭代理、停止/删除刚创建的容器、报告清理失败；资源状态不确定时保留墓碑记录。

建议的截止时间：每个控制请求 10 秒，经授权的镜像拉取 120 秒，create/start/就绪整体 30 秒，stop 宽限 10 秒外加有界的强制删除截止时间。这些是提议的默认值，不是实测性能。exec 生命周期超时与 Engine HTTP 控制截止时间分开；合法的长时间 exec 不能被 10 秒的请求计时器打断。

建议的元数据放在 `<conversationDir>/docker/` 下（绝不放在挂载的工作区里）：

```text
session.json          # container ID, deployment/conversation identity, image ID/digest,
                      # config fingerprint, state, timestamps; no secret values
outgoing/             # private attachment copies
execution.jsonl       # bounded/rotated structured audit
proxy-public/         # only proxy.sock + public CA bundle; the only extra bind mount
proxy-private/        # optional private CA material; never mounted
```

私有材料使用目录权限 0700/文件权限 0600。proxy-public 目录/socket 的权限必须明确允许映射后的容器身份访问，同时不向宿主机其他用户开放。以只读方式挂载的目录里仍可以有可连接的 Unix socket：只读挂载并不会去掉 socket 的权限。

### Exec 和输出传输

- 用 `POST /containers/{id}/exec` 创建 exec：`Cmd` 为 argv，固定 `User`，校验过的 `WorkingDir`，`Tty: false`，附加 stdout/stderr；只有文件/辅助程序负载才用 stdin。用 `POST /exec/{execId}/start`（附加、非分离）启动；流结束后查询 `/exec/{execId}/json` 获取 `Running`/`ExitCode`。
- Bash argv：`/bin/bash --noprofile --norc -c <command>`。bash 是容器**内部**有意不受信的解释器；宿主机绝不执行这条命令。
- 不把 `options.env` 当作批量继承来源。构建干净的 exec 环境：固定的 PATH/LANG、`HOME=/workspace`、TMPDIR、显式配置的代理/CA 变量和密钥占位符，仅此而已。确保镜像继承的环境变量不能重新引入凭证、`BASH_ENV`、`ENV`、`LD_PRELOAD` 等；必要时通过可信辅助程序/`env -i` 启动。
- 非 TTY 的 Engine 输出是多路复用的：8 字节帧头（流标识字节、三个保留字节、大端负载长度）后跟数据。要能跨任意分块边界解析，强制帧/缓冲上限，保留二进制字节，并通过 `onData(Buffer)` 转发 stdout/stderr。绝不把字节当 JSON 解码，也不要假设一个网络分块就是一帧。
- 仅仅流 EOF 不代表成功。带截止时间 inspect exec，并在结算前读完所有输出。容器内非零退出是正常的操作结果 `{exitCode}`；传输/启动/守护进程错误则 reject。不要把所有退出码 137 都标成 OOM——要结合 inspect/events/cgroup 证据。
- `docker logs` 是 PID1 的日志，不能替代附加的 exec 输出。PID1/中继日志单独记录并设上限。

### 取消、超时和关闭

Docker 有 exec 的 create/start/inspect 接口，但没有通用的 exec kill 接口。关闭 HTTP 流或杀掉本地 `docker exec` 客户端，**不能**证明容器里的进程停了。

v1 采用保守策略：

1. 每个容器的 Agent exec/文件事务串行执行（如果以后引入并行，要明确定义取消的关联关系）。创建 exec 前检查信号是否已中止；注册监听器后以及每个异步启动边界都再检查一次。
2. bash 中止/超时时，阻止该代的新工作、撤销其活动的代理连接，并 stop/kill **整个容器**。等待确认它不再运行。必要时从短宽限升级到 kill/强制删除。
3. 把所有受影响的操作标记为已中止；不能因为它们的流碰巧结束就报告成功。在 `BashOperations` 边界上精确抛出 `Error("aborted")` 或 `Error("timeout:<seconds>")`，以便 pi 现有的格式化逻辑正常工作。
4. 之后另一个单独请求的工具，可以在确认关停后启动一个干净的新进程代。绝不自动重放被取消/结果不确定的命令。bind 挂载上的副作用不会回滚；要写明这一点。
5. 如果因为守护进程消失而无法确认关停，就让后端保持失败状态并保留清理元数据。不要启动第二个写入者，也不要启用 local 工具。

整容器取消也会杀掉分离的子孙进程/`setsid` 守护进程，但同样会杀掉有意运行的后台服务。必须记录这个取舍。以后的单 exec 监管/cgroup 设计只有在有测试证明子孙进程被终止后才能作为改进；对恶意命令来说，仅杀进程组是不够的。

`close()` 取消计时器，拒绝排队中和新的工作，等待进行中的 start 完成清理或被栅栏挡掉，撤销代理权限，并按 `onClose` 停止/删除资源。重复关闭无害。在 create 期间关闭，不能因为容器 ID 迟到而泄漏容器。所有清理都要有截止时间；要报告失败，而不是只靠 `index.ts` 里现有的 `.catch(() => undefined)` 吞掉。

### 复用、保留和空闲回收

| 机制 | 保留下来的 | 不保留的 | 建议 |
| --- | --- | --- | --- |
| 同一个运行中的容器 | 进程、tmpfs、挂载、根层 | 本身没有丢失 | 连接期间复用。 |
| 对同一 ID 先 `stop` 再 `start` | 容器配置和可写层（如果有）；bind 数据 | 运行中的进程、exec 会话、活动网络流；tmpfs 内容 | 作为支持的空闲/重连优化；重新运行入口点和就绪检查。 |
| 删除后用固定镜像重建 | bind 数据 | 根层改动、tmpfs、进程状态 | 默认关闭行为。配合只读 rootfs 时可复现性最好。 |
| `docker commit` 后重建 | 可写容器层中的镜像改动 | bind/卷内容和实时内存/进程状态 | v1 不做；在默认只读/非 root 策略下对安装系统包没有用。 |

已停止的容器不是挂起的进程。Docker exec 命令不会随容器重启。`pause` 不是空闲内存回收，也不是提议的空闲动作。

空闲计时器设计：

- 使用单调时间；只有在没有轮次租约、操作、排队操作、文件传输或活动代理请求时才开始倒计时。状态轮询不算活动。
- 在检查/唤醒容器**之前**获取操作租约。唤醒与空闲 stop 串行；绝不在操作的就绪检查和 exec 创建之间停容器。
- 到期时在生命周期锁下再检查一次，然后 stop；关闭代理上游连接。对象保持 `idle-stopped`；下一个真实操作调用就绪/唤醒。不断开实时消息适配器，也不释放会话日志锁。
- 容器内的后台进程不能无限续期租约。文档中的空闲策略可能终止它们。对连接/请求设生命周期上限，避免挂起的代理请求永远钉住容器。
- 已停止容器超过 TTL 后，安全对账只删除自己拥有的容器。不能删除 bind 数据。worker 可以运行周期性清扫；所有 worker 都停了时的全局清理需要单独调用的维护任务，而不是一个想象中一直在跑的计时器。

对于 `onClose: "stop"`，新的所有者只有在获取租约后，并比对部署标识、会话标识、镜像 ID/digest、规范化挂载、用户、OCI 运行时、加固设置、辅助程序版本和生效的非密钥配置指纹之后，才能复用一个经 inspect 确认的**已停止**容器。`session.json` 里的 ID 只是线索。限额/挂载/镜像/策略变化时应重建，而不是修补一部分未知设置。

每个控制器/代理代都重新生成占位符，并在 exec 时注入，而不是写进不可变的容器 `Config.Env`。重启后的 worker 必须重新连接/重建代理和中继，并重新校验公开 CA/socket 挂载。Agent 保存下来的旧占位符字符串无效，应得到明确的拒绝，而不是静默通过认证。策略/密钥轮换时关闭连接池。标签里含密钥的配置哈希可能被字典猜测泄露；指纹要不含密钥，或者在需要比较密钥版本时使用宿主机私有的带密钥值。

孤儿对账必须同时使用归属标签和存活所有者/租约检查，不能只靠脱敏后的名字或过期时间戳。现有基于 PID 的频道锁有用（`src/log.ts:166–194`），但不是多主机租约。运行中的孤儿容器应先停止再接管；绝不重新连接到可能仍在运行的 exec。归属不确定时报错，并给出运维指引。不要运行宽泛的 `docker system prune`，也不要删除任意镜像/卷。

如果以后要求基于 commit 的复用，要做成一个单独的不安全/可写根配置：需运维明确批准、镜像配额/TTL、不自动推送、静默处理、重新应用所有创建时的加固，并审查密钥/凭证残留。优先重新构建经过审查的 Dockerfile，而不是保留被 Agent 改过的根层。

## 7. 文件操作与 pi 输出集成

### 在容器内执行文件系统访问

照搬 Gondolin 对工具可见路径的限制（`/workspace` 和 `/shared`），而不是 local 模式不受限的宿主机路径。把 POSIX 相对路径相对 `/workspace` 规范化；拒绝空路径/NUL 路径、词法上越出两个根目录的路径，以及 `/workspace-other` 这类前缀相似的路径。v1 的文件工具不接受这两个挂载以外的容器绝对路径。bash 仍能读容器里的普通镜像文件；这条策略并不打算把 bash 限制在两个目录内。

通过 exec 使用可信镜像中的文件辅助程序：

- `readFile`：以 Buffer 返回原始字节，在宿主机累积前就限制大小；确认是普通文件，拒绝读取 FIFO/socket/设备和超限文件。
- `access`：read 操作检查可读；edit 操作检查读写权限和 shared 只读策略。不能用 `access` 成功替代真正 open 时的检查。
- `writeFile`：通过 stdin 发送 UTF-8 内容并限制长度；绝不把内容插值到 shell 文本/argv/base64 命令行中。新文件显式设置权限。在符合 edit 契约的情况下，优先使用同目录临时文件 + 原子 rename；有意保留已有文件的权限。
- `mkdir`：在批准的根目录内递归创建，不跟随会逃逸的中间链接。
- `detectImageMimeType`：返回支持的图片 MIME 或 null，使用有界嗅探或现有基于扩展名的行为；绝不返回伪造的图片数据，也不要误用宿主机 `file` 去处理容器路径。
- edit 使用 pi 现有的精确替换实现，搭配 Docker 的 read/write/access 操作；不要实现新的文本匹配算法。

文件辅助程序必须基于文件描述符做相对路径限制，而不仅仅是先 `realpath()` 再单独按路径名 open。Linux 基线上，使用 `openat2` 风格的 beneath/no-magic-link 约束，或经过审计的 fd 相对、逐段不跟随软链接的遍历；如果所选运行时缺少所需原语，就报错而不是降级。要定义是否支持根目录内的软链接。合理的 v1 契约是：文件工具路径中出现软链接就拒绝，容器内正常使用软链接交给 bash。在 runsc 下也要测试；这是支持门槛，不能假设系统调用完全一致。

操作类型是确定的：read/edit 的 `readFile(path)` 返回 `Promise<Buffer>`；write/edit 的 `writeFile(path, content: string)` 返回 `Promise<void>`；access/mkdir 返回 `Promise<void>`。Bash `exec(command, cwd, {onData, signal?, timeout?, env?})` 返回 `Promise<{exitCode: number | null}>`，`timeout` 单位是**秒**。在检查过的 pi 契约中，文件操作回调本身没有 AbortSignal 参数：要由后端自己设截止时间（例如 30 秒加有界的传输时间），并传播后端关闭时的取消。Docker 退出状态未知/缺失时是错误，不是 `null` 成功。

在委托/事务层串行化**完整的** Docker 工具调用，尤其是 edit 的读–改–写序列；只串行化单次辅助程序 exec 调用是不够的。避免在操作内部递归获取同一把不可重入锁。这挡不住有意放到后台的 bash 进程修改文件；要记录这个限制。

辅助程序不是针对容器用户的新安全边界——用户可以直接调用它们——但要确保控制器不会意外把文件工具变成宿主机操作。除非确实打算让容器可读，否则运行时密钥不通过这个辅助程序协议传递。

不要默认每个操作都用 `docker cp`/归档解压。那会带来归档/软链接/设备校验和归属问题，还可能绕过预期的容器用户语义。如果某个操作使用 Engine 归档 API，要把返回的所有 tar 条目视为恶意：拒绝路径穿越、链接、特殊文件、意外的多条目和超长长度；绝不把任意容器归档解压到宿主机存储。

### 现有的 bash 溢出文件陷阱

已安装的 pi bash 工具即使使用自定义 `BashOperations`，也会在**宿主机**上写截断/完整输出：`node_modules/@mariozechner/pi-coding-agent/dist/core/tools/bash.js:19–22, 207–258, 269–293`。所以只返回 Docker 操作，会得到一个限制在 `/workspace` 的 read 读不到的 `fullOutputPath`。大输出行为必须纳入实现，不能当作 Docker 细节忽略。

在 bash 委托/结果集成点（`index.ts:554–558, 1708–1715`）给出明确方案：

- 优先使用感知执行后端的输出收集器/包装器：一个有界的私有缓冲文件，加上一份容器可见的副本放在 `/workspace/.pi-chat-output/`，保留 pi 的尾部截断和错误语义。
- 如果包装 pi 现有工具，只迁移本次调用创建并被追踪的溢出文件，在其流结束后通过安全的文件桥迁移。同时改写给模型看的文本和结构化的 `details.fullOutputPath`，包括部分更新和非零退出路径。绝不从命令输出中解析任意的"Full output:"字符串去读那个宿主机文件。
- 限制总转发/缓存输出（例如每次 exec 16 MiB），超出时以明确的输出超限错误终止。pi 的显示截断本身不是磁盘/内存配额。在累积无界缓冲前要尊重背压。
- 不要为解决这个问题把宿主机 `/tmp` 挂进容器。不要放宽文件操作去读任意宿主机临时路径。

测试二进制分块处理、超长单行、超过 2,000 行、跨分块切开的 Unicode、流错误、回调错误、最终文件刷写，以及恢复/回读所声明的输出路径。编码前选定一种收集策略；对照已安装的 pi API 验证，而不是就地修改依赖。

## 8. 挂载、宿主机桥接和残余风险

### 挂载布局

| 容器内目标 | 宿主机来源 | 默认权限 |
| --- | --- | --- |
| `/workspace` | `conversation.workspaceDir` | 读写，专属于这个信任域 |
| `/shared` | `conversation.sharedDir`（`<accountDir>/shared`） | Docker 下只读；需显式开启写入 |
| `/run/pi-chat-proxy` | 仅本代的 proxy-public 目录 | 只读；只有策略 socket 和公开 CA 证书包 |
| `/tmp`、`/run`、`/dev/shm` | 有上限的 tmpfs | 可写临时空间；不 bind 宿主机 |

bind 传播设为 `rprivate`；在支持的地方禁用递归包含子挂载（Engine bind `NonRecursive`，或 CLI `bind-recursive=disabled`）。否则检测/拒绝意外的子挂载。只读 rootfs **不等于**只读 bind 存储。旧内核的递归只读行为不同；不要假设嵌套挂载会自动变成只读 [D5]。要 inspect 最终的挂载结果。

挂载来源是在**守护进程所在主机**上解析的，不是 CLI/客户端主机 [D5]。拒绝未批准的远程端点。规范化来源，并确认它们不包含/不重叠私有控制器元数据、配置、Docker socket、`/`、宿主机 home、`/proc`、`/sys`、凭证目录或其他会话的私有存储。会话目录下放工作区的正常布局只允许挂指定的工作区子目录，不能挂整个会话目录。拒绝可能通过另一个可写别名绕过只读 `/shared` 的 workspace/shared 重叠。不要为了让启动通过而递归 chown 任意用户目录。指向宿主机敏感文件的已有硬链接同样能击穿纯基于路径名的边界；使用不含此类别名的专用存储（最好是独立的文件系统/配额域），而不是复用有特权的工作树。没有软链接的检查无法证明文件没有指向外部的硬链接。

### 可写数据是宿主机消费者有意留下的逃逸通道

bind 挂载限制了命名空间访问，但有意暴露了其中的内容。Agent 可以修改 `.git/hooks`、`.git/config`、`.envrc`、包脚本、CI 文件、提示词/skill 文件，以及之后人或宿主机工具会执行的其他文件。把工作区输出视为不可信。特别是 `spawnConversationTmux()` 以工作区作为 cwd 启动 pi（`index.ts:387–419`）；宿主机的项目发现/扩展不能自动执行 Agent 写的内容。运行专用的可信 worker，并适当配置 pi 的项目信任/资源加载。容器隔离并不能把之后加载的宿主机扩展关进沙箱。

不要声称文件工具的过滤能防住 bash 写同一批挂载路径。细粒度的禁写路径需要文件系统/挂载层面的强制、一个代理服务，或经过审查的工作树/导出流程。这些是两个基础挂载之外的可选加固，而不是在 `writeFile()` 里做子串检查。

不要在 workspace/shared 中放置**任何宿主机服务的 Unix socket**：network-none 挡不住通过文件系统暴露的 Unix socket。盘点已有的特殊文件，并要求使用不与宿主机服务共享的专用目录；这需要靠运维约束来保证，因为启动时扫描一次挡不住宿主机之后创建的 socket。绝不挂载 Docker/containerd/SSH-agent socket，即使"只读"也不行。唯一有意提供的 socket 权限是范围严格受限的出网代理。

### 宿主机侧桥接需要自己的限制

`safeReadMountedText()`（`index.ts:169–186`）、目录初始化、下载/落盘（`src/log.ts:41–68, 200–227`）、运行时密钥写入（`src/secrets.ts:45–54`）和导出（`index.ts:973–984`）仍会接触宿主机路径。恶意容器可以创建绝对路径软链接，它在容器命名空间里指向无害位置，但宿主机跟随时却指向敏感文件。

在声称可以安全操作恶意工作区之前，要用目录 fd/不跟随链接的遍历和普通文件检查（包括**中间**路径段）审计/加固这些桥接。先 `realpath()` 再只对最终文件加 `O_NOFOLLOW`，并不是完整的 TOCTOU 防御。宿主机密钥写入目前用的是普通的 `mkdir/chmod/writeFile`；简单的文件名正则保护不了被替换的 `.secrets` 目录或已存在的目标软链接。每次追加日志都会重新跑目录初始化，所以这不只是首次启动的问题。

非 root UID 设计要覆盖两个方向：宿主机下载的文件和 0600 的运行时密钥必须能被目标容器身份读取；容器创建的文件必须仍能被控制器管理。rootful 同 UID、rootless 和重映射配置要分别测试。不要用 `chmod 777`、容器内 root 或递归 chown 解决权限不匹配。共享的明文密钥对所有能访问的身份可见；频道密钥不要放进 `/shared`。

### 附件暂存

Docker 的 `stageAttachment()` 应通过容器内安全的文件辅助程序获取有界字节（只限 `/workspace` 或 `/shared` 中的普通文件），并在私有的 `docker/outgoing/` 下独占创建一个新的 0600 宿主机文件。这样可以避免用宿主机路径语义跟随容器写的软链接。设置可配置/内部的附件大小上限（例如 50 MiB，同时遵守适配器限制），流式传输而不是读取不限大小的文件，并清理失败的部分副本。使用随机文件名和脱敏后的基础名。校验后不要直接从可写的 bind 源发送：它可能在适配器上传前被改掉。

只把暂存后的宿主机路径返回给 `index.ts:1331`。暂存文件保留到发送/重试/取消有结果为止，之后按有界的保留策略处理。绝不把暂存目录作为挂载暴露。稳定的暂存能防止路径替换，但复制期间正在被编辑的文件仍可能得到不一致的快照；要么写明这点，要么在复制期间协调文件修改。

## 9. 出网代理和密钥占位符

### 建议的强制拓扑

初始 Linux 实现使用 **network-none 加单个 Unix socket 代理权限**：

```text
untrusted agent container (Docker NetworkMode=none, no host namespaces)
  curl/python/etc -> HTTP(S)_PROXY=http://127.0.0.1:18080
                         |
                 non-root loopback TCP -> Unix-socket relay
                         |
  read-only bind: /run/pi-chat-proxy/proxy.sock + public CA bundle
                         |
trusted host per-conversation HTTP(S) policy proxy
  canonical host/port checks -> guarded DNS/connect -> TLS verification
  secret placeholder substitution -> approved upstream
```

镜像入口点在不带任何 capability 的情况下启动/回收回环中继。客户端使用显式的代理变量（按需提供大小写两种），`NO_PROXY` 为空；删掉这些变量只会让直接访问互联网失败。容器只有回环网卡 [D4]。它无法通过 IP 路由访问宿主机回环、DNS、局域网、元数据端点、其他容器或互联网。raw socket/capability 和宿主机 socket 挂载仍然禁止。容器可以绕过/杀掉自己的中继，或直接连接暴露的 Unix 代理，但最终仍只能到达同一套由宿主机强制的策略；它自己容器内的可用性不是受保护资产。

这种拓扑避免了在 pi-chat 中编写需要特权的宿主机防火墙规则，也避开了 Docker 内嵌 DNS 的逃逸面。它需要受支持的本地 Linux socket bind 和经过测试的运行时行为。中继/代理传输不可用时就绪检查必须失败；绝不以挂 bridge 网络作为回退。

**gVisor 资格说明：** 仅 `--runtime=runsc` 不足以支持这个拓扑。当前上游 runsc 的 `host-uds` 默认为 `none`；`host-uds=open` 才允许连接暴露的宿主机 socket [G2]。运维必须注册一个专用、经审查的运行时配置（或配置 `runsc`），允许 open 而不是 create/all，并跑完 E2E 矩阵。pi-chat 不能自动编辑 `/etc/docker/daemon.json` 或重启 Docker。这会放宽对允许挂载中任何宿主机 socket 的访问，进一步说明 §8 中专用目录要求的必要性。检查已安装的 runsc 版本，而不只是上游 `master`。不带代理的 `network.mode: "none"` 不需要宿主机 UDS 访问。

替代方案：每会话一个 internal bridge，加一个双网卡的可信代理 sidecar，可以支持不能 bind socket 的平台。它**不是**初始回退方案。Docker 文档说明 internal 网络仍可能访问其网关/配置得当的宿主机服务 [D3]。这种设计需要外部强制的宿主机/对等/DNS/IPv6 隔离、一个不做转发且上行链路上没有 Agent 成员的代理，以及一次全新的安全审查。仅仅 `--internal` + `HTTPS_PROXY` 是不够的。

### HTTP(S) 处理流程

构建或集成一个维护中、经过审查的 HTTP 代理/TLS 拦截组件，而不是临时拼凑的原始字符串解析器。宿主机端点属于可信计算基，要解析攻击者控制的字节。

1. **通过 socket/监听器绑定识别会话**，而不是靠容器提供的账号头。策略上下文、CA 签发、占位符映射、DNS 缓存和连接池都要隔离。只绑定私有 Unix socket；绝不绑定 `0.0.0.0`。
2. 在缓冲之前强制连接/请求头/请求体/响应/并发/截止时间上限。建议的初始上限：请求头 32 KiB、32 个并发请求、请求体 16 MiB、响应体 64 MiB，以及有界的 TLS/请求头/空闲/总时长；记录与大文件下载的不兼容，只允许经运维审查的修改。带背压流式传输请求体；客户端关闭时中止两端。
3. 严格解析绝对形式的 HTTP 请求和 CONNECT authority。v1 只接受 HTTP 80 端口和 HTTPS 443 端口。规范化 DNS 主机名（IDNA、大小写、统一的结尾点规则）；拒绝格式错误的 authority、userinfo、IP 字面量/含糊的数字主机、其他端口和不支持的协议。主机名策略在解析被拒绝的主机之前就生效，防止通过 DNS 标签任意外泄数据。
4. 对 CONNECT，先检查允许的主机名/443，然后用每会话 CA 终止客户端 TLS。**不要提供盲 TCP 隧道**，即使目标是允许的主机名：盲隧道无法做密钥替换，还能绕过走非 HTTP 流量。要求 CONNECT authority、SNI、HTTP Host/authority 与内层请求 URL 一致；不一致就拒绝。只协商已实现的协议（初期为 HTTP/1.1）。拒绝 websocket 升级、CONNECT 套 CONNECT、通用 TCP、HTTP/3、证书固定的客户端和 mTLS 流程，除非另行支持。
5. 只挂载公开 CA/证书包。为支持的客户端提供信任设置（按需设置 `SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`NODE_EXTRA_CA_CERTS` 等）。不要关闭 TLS 校验，也不要挂载 CA 私钥。代理要独立地按真实主机名/SNI 校验真实上游证书。
6. 对最终的规范化 URL、方法和端口做授权。v1 可以允许常规 HTTP 方法，但代理握手之外的 CONNECT/升级除外；以后对高价值 API 增加路径/方法限制会有用。去掉逐跳头和代理凭证；拒绝格式错误的重复分帧、冲突的 Content-Length/Transfer-Encoding、CR/LF 注入和请求走私。
7. 在宿主机上用代理自己的解析器解析。对 IPv4 和 IPv6（包括映射地址）拒绝回环、私有、链路本地、未指定、组播、保留/非全局地址段、云元数据以及宿主机/容器子网。v1 没有内网主机例外。检查过的 Gondolin 私有地址辅助函数覆盖范围比完整的非全局地址策略窄；不要夸大它，也不要盲目照抄。
8. 把实际上游连接固定到已校验的地址，同时保留按主机名的 TLS SNI/证书校验。IP 字面量需要显式拒绝/检查，因为 DNS 回调可能根本不会触发。每次新连接/重试/重定向都必须走受检连接器；不能有绕过它的默认 `fetch()`/全局 agent 路径。限制 DNS 缓存时长，并防止跨策略复用连接池。混合公网/私网 DNS 答案的处理必须明确（v1 保守做法：整组拒绝）。
9. 只在最终目标校验后替换支持的占位符。请求体字节原样透传，受大小限制。相关时对替换后的请求再检查一次密钥主机限制。只通过 HTTPS 认证上游：**即使主机被允许，也绝不在明文 HTTP 中注入密钥**。
10. 代理最好不跟随上游重定向：把 3xx 返回给客户端，由客户端把下一个请求再发回来过一遍策略。这样避免重放流式请求体。如果以后实现服务端跟随，使用手动的有界跳转，校验每个目标/IP，去掉跨源凭证/cookie，并在改写后执行每个密钥的主机检查。绝不在已替换请求头的情况下使用 `fetch` 的自动重定向。
11. 返回有界的响应流和脱敏错误。不要在异常文本里回显替换后的请求头/URL。默认不缓存带凭证的响应。

即使没有密钥，代理也必须失败即关闭：策略执行不依赖非空的密钥映射。代理崩溃/不可达意味着请求失败，而不是改为直连。关闭会话或修改其策略时，既要撤销已有的代理连接，也要拒绝之后的请求。

### 替换契约和限制

- 为每个上下文生成不可猜测的占位符（检查过的参考格式是 `GONDOLIN_SECRET_<48 hex>`；用 Docker 专属前缀也可以）。每个占位符绑定密钥名、值、允许的主机、会话和代数。宿主机上的值绝不进入 Docker create/exec JSON、标签、argv、容器文件或日志。
- 替换请求头值中的完整已知令牌（例如 `Authorization: Bearer $TOKEN`），包括 Basic 认证的解码/替换/重新编码。发往错误主机的令牌要拒绝；不要静默保持原样。转发上游时去掉代理认证头；代理身份不是上游 API 凭证。
- 只有显式开启时，才用正确的 URL 编码替换解析出的查询参数名/值。不替换原始 URL 路径、任意编码的请求体、压缩负载或签名请求。HMAC/签名计算以及需要明文密钥的工具与此机制不兼容。
- 未知/过期的占位符前缀令牌应得到脱敏的拒绝。不做"看起来像令牌就替换"的通配。作用域/缓存归属要能阻止其他会话使用某个令牌。
- 精确主机许可并不限制 API 操作：被攻破的 Agent 可以用允许的令牌修改资源，或通过这个 API 外泄数据。优先使用细粒度、短期、只读的凭证，并可选加上方法/路径限制。
- 被允许的上游可能在响应中回显凭证，或把它变成 Agent 能读到的数据。Gondolin 的默认钩子不提供通用的响应密钥清洗。不要承诺密钥值*永远*到不了容器：保证的是"不会直接提供给容器；只注入到经授权的上游请求中"。有界的精确值响应/响应头脱敏可以作为纵深防御，但编码/流式/语义变换会让通用脱敏失效。不要把回显服务加为可信的生产目标。
- 所有白名单服务仍是潜在的数据外泄目的地。主机白名单不是数据防泄漏。

### 最低限度的代理测试用例

从 `G/host/test/http-hooks.test.ts:444–685` 移植的是**行为**而不只是名字：Bearer、Basic 认证、错误主机、已是真实密钥却发往不允许的目标、被改写的目标、查询替换关/开。再加上 Docker 专属的：空列表拒绝/通配符拒绝、不自动扩展主机、只在 HTTPS 注入、跨会话/过期令牌、重复请求头、主机名规范化、CONNECT/SNI/Host 不一致、IP 字面量/映射 IPv6、实际连接时的重绑定、重定向、请求体不变、TLS 校验失败、策略轮换后的连接池以及所有字节上限。

## 10. 安全加固默认值

使用结构化的 Engine 字段。下面等价的命令行参数只是为了说明；不是让你现在去运行一个只配了一部分的容器。

| 控制项 | 必需的设置 / 校验 |
| --- | --- |
| Capabilities | `HostConfig.CapDrop: ["ALL"]`（CLI `--cap-drop=ALL`）；不添加任何能力。不要 `CAP_SYS_ADMIN`、`NET_ADMIN`、`NET_RAW` 或 `SYS_PTRACE`。 |
| 特权 | `Privileged: false`；`SecurityOpt` 包含 `no-new-privileges:true`（CLI `--security-opt=no-new-privileges`）。不允许 exec 以特权覆盖。 |
| 用户 | 数字形式、非零的 `Config.User`；每次 exec 用同一用户；不加有特权的附加组。不依赖 sudo/setuid。 |
| 根文件系统 | `ReadonlyRootfs: true`。镜像预先提供 bash、CA/客户端工具和辅助程序。装包在经审查的镜像构建中完成，或在工作区里使用无特权的语言环境。 |
| 临时空间 | 有大小上限的 `/tmp`、`/run`、`/dev/shm`；`nosuid,nodev`，tmpfs 最好加 `noexec`。需要执行时在工作区里构建。`noexec` 挡不住解释器读脚本，不是通用的执行禁令。 |
| PID/内存/CPU | 提议默认值：`PidsLimit: 128`、`Memory: 1073741824`、`MemorySwap: 1073741824`、`NanoCpus: 1000000000`。要确认真正生效/受支持，而不只是 JSON 序列化成功。保持 OOM killer 开启。 |
| 文件描述符/core | 有界的 `nofile`（例如 1024）和 `core=0`；不要把凭证 dump 到宿主机 core 文件。不要拿按 UID 计的 `nproc` 替代容器 PID 限制。 |
| 网络 | `NetworkMode: "none"`；不发布端口/全部端口，不加额外主机别名、links、网络加入或 host 网络。代理只是指定的 Unix 权限。 |
| 命名空间/设备 | 在支持的地方使用私有 PID/IPC/cgroup 命名空间。不使用宿主机 PID/IPC、不加入命名空间、不挂任意设备、不开可写 cgroup，也不挂宿主机 `/proc`/`sys`。保留 Docker 屏蔽/只读的系统路径。 |
| Seccomp | 保留 Docker 默认 seccomp 或经明确审查的更严格配置。绝不 `seccomp=unconfined`。校验守护进程配置/支持情况；不要假设每个 Engine 版本都支持较新的 `seccomp=builtin` 语法。 |
| LSM | 在可用的地方保留强制模式的 AppArmor/SELinux；不要用一刀切的 `label=disable`/unconfined 绕过。在专用挂载上配置标签/权限，绝不为了方便给整个宿主机 home 重打标签。 |
| Init/入口点 | 可信的非 root 监管进程，或 Docker `Init: true` 加一个受控的常驻入口点，负责信号转发和子进程回收。校验前不执行任意镜像入口点。 |
| 重启/保留 | `RestartPolicy.Name: "no"`；重启由控制器负责。`AutoRemove: false` 并显式做有界删除，以便 inspect/复用/对账。不要把自动删除和已停止容器复用一起用。 |
| 日志 | 设置有界的守护进程日志驱动选项，不需要时关闭 PID1 日志，另加单独的脱敏生命周期审计。exec 输出单独设上限。 |
| OCI 运行时 | 显式的已批准名称；runsc 需要运维安装管理的运行时和支持性测试。缺少运行时/安全特性就报错，而不是改用更弱的设置。 |

rootful Docker socket 是权限极高的宿主机权力。只让控制器能访问，放在所有容器挂载之外。加入 Docker 组不构成无特权的安全边界。Rootless/用户命名空间能降低部分风险，但消除不了 bind 挂载投毒、代理漏洞或宿主机消费者风险。runc 与宿主机共享内核；gVisor 插入一个用户态内核，会改变兼容性/性能，但它不会让挂载的数据变安全，也不能替代出网策略。

内存/CPU/PID 限制**不能**约束 bind 挂载的磁盘用量、守护进程镜像存储、宿主机日志或代理/控制器内存。要另外加工作区/暂存/日志/镜像的预算和保留策略；支持时用文件系统配额做硬性磁盘上限。轮询剩余空间只是尽力而为。限制同时启动的容器数和每台主机的总容量；只有单容器上限时，worker 一多仍可能耗尽主机。

## 11. 错误处理、可观测性和隐私

### 错误分类

| 故障 | 必需的行为 |
| --- | --- |
| 配置无效 / 缺镜像或运行时 / 守护进程不可用 | 错误要指明出问题的设置/能力和安全的补救方法。在连接适配器或暴露宿主机回退工具之前就失败。 |
| create 成功，但 start/就绪/元数据写入失败 | 只清理自己拥有的这一代；保留原始错误并附带脱敏的清理警告。记录状态不确定的资源，供以后对账。 |
| bind / 运行时密钥权限失败 | 报告预期的映射 UID 和路径类别，不报密钥内容；不自动 chown/chmod 成全局可写/提权到 root。 |
| exec 命令非零退出 | 从操作中返回 exitCode；由 pi 格式化成工具错误。这与 Docker API 失败不同。 |
| 中止/超时/输出超限 | 按规定终止容器这一代；不重放；报告可能已持久化的文件系统副作用。 |
| exec 期间守护进程断开 | 结果未知，而不是成功。复用前要验证/停止。绝不自动重试有副作用的命令。 |
| OOM/容器退出 | 尽可能记录 inspect/events、脱敏原因和最后的生命周期状态；让活动执行失败，并要求经验证的重启。 |
| 出网被拒 | 稳定的类别（主机/IP/协议/密钥主机/大小/TLS），只给出脱敏的主机/端口。面向用户的错误中不出现请求头、查询参数、请求体、占位符或真实凭证。 |
| 关闭失败 / 守护进程离线 | 限制等待时间，私下报告保留的容器 ID/清理需求，保留归属元数据；不要假装清理完成。 |
| 元数据过期 / 归属不匹配 | 报错，或只在确认归属后删除；名字冲突时绝不删除无关容器。 |

任何操作都不应留下未处理的 rejection、无界计时器、泄漏的流，或容器已消失却仍可复用的"ready"对象。在合理的地方对有界、幂等的 inspect/就绪调用做重试。容器 create/start 超时需要按自有身份对账，因为客户端超时后服务端可能已经完成了请求。

### 日志和状态

在 stderr 上输出结构化事件（`[pi-chat docker]`、`[pi-chat docker-egress]`），另有私有的轮转审计流。字段：会话/部署 ID、代数、短容器/exec ID、事件、单调时长、退出码、字节数、策略决策类别、规范化主机/端口、运行时/镜像 ID、资源状态和清理结果。在有集成钩子的地方关联任务/工具调用 ID；不要误导性地暗示后端 `BashOperations` 现在能拿到任务 ID。

默认不要记录完整配置、原始 Docker inspect/env、完整命令行、请求/响应体、查询字符串、认证/cookie、CA 私钥、占位符或密钥值。命令里也可能含有用户提供的明文密钥；完整命令审计是受保护的显式开启项，不是默认。即使是规范化主机和文件路径也可能是隐私。在写入日志、状态、会话消息或远程回复**之前**就对异常脱敏。脱敏是纵深防御，不是可以整包 dump 请求的许可。

当前的会话记录联合类型里没有后端生命周期事件（`src/core/runtime-types.ts:86–99`）；`ConversationRuntime.appendError()` 使用现有的 `error` 记录（`src/runtime.ts:297–299`）。详细的后端遥测单独保存；可选地通过 runtime 追加摘要后的失败。不要在不更新读取方/类型/测试的情况下注入任意新的 JSONL 记录类型。正常的空闲 stop 不是任务失败，也不是适配器断开。

状态应区分 `starting`、`ready`、`idle-stopped`、`failed`、`closing`、`closed`；显示后端 `docker`、OCI 运行时、镜像 digest、shared 只读状态、网络策略摘要、空闲截止时间和最近的清理问题。worker 存活和容器存活是两回事。现有每 15 秒一次的 worker 状态循环不应人为地让容器保持活跃。

## 12. 测试计划

先完整写好实现和测试，再跑完整的验证/E2E 流程。不要用 mock 声称覆盖了真实运行时。下面的测试是发布标准，不是已取得的结果。

### 不依赖 Docker 的单元和集成测试

建议的新文件：`tests/docker-config.test.ts`、`tests/docker.test.ts`、`tests/docker-egress.test.ts`，以及使用假 pi API 的针对性扩展集成测试。用 `tests/helpers.ts` 让测试名/路径远离真实聊天存储。

1. **配置：** 旧默认值；每个继承层级；嵌套的部分覆盖；空列表/false/0 的语义；无效的 null/类型/限额/UID/镜像/主机名；network-none 下有密钥时报错；不隐式扩展密钥主机；路径正确；local/Gondolin 路径中不导入/探测 Docker。
2. **create 规格：** 快照/断言所有必需的加固、限额、挂载、用户、运行时和干净环境。拒绝多余/递归/敏感的挂载、含凭证的标签、违规的镜像卷/环境变量/入口点，以及不支持的安全能力。
3. **生命周期：** start 单飞；重复 close；create/start 之前/期间 close；close 之后迟到的成功；每个 await 处的部分失败；有界的守护进程中断；外部删除；过期/不匹配的元数据；运行中的孤儿；另一个存活所有者；接管保留的容器。确认没有意外的宿主机回退。
4. **空闲：** 假时钟；任何租约/排队传输期间都不 stop；到期只 stop 一次；状态查询不续租；并发唤醒/启动；断开时取消计时器；后台工作按策略终止；已停止 TTL 只删除自有资源。
5. **Exec：** 分片的多路复用帧头/负载、stdout/stderr、二进制/UTF-8 边界、格式错误/超大的帧、stdin 背压、退出前 EOF、非零/null/未知退出、预先中止/启动竞态/输出中途中止、超时、onData 失败、输出超限。断言真实的 stop/kill API 调用，而不只是 Promise 被 reject。
6. **文件：** 普通文本/图片读取，通过真实 pi 工厂的多处 edit 行为，mkdir/write，含引号/换行/前导短横线的文件名，路径穿越/前缀相似，父级/最终/悬空软链接，硬链接，特殊文件，只读 shared，大小上限和中断的复制。单独测试宿主机桥接对软链接替换的防御。
7. **输出集成：** 截断后的 stdout 路径容器内可读；部分/最终/错误结果中的路径一致；伪造的输出无法触发宿主机读取；宿主机缓冲有上限并被安全清理。
8. **代理：** §9 的纯策略/替换测试；使用假 DNS/连接器、基于回环/Unix 的 HTTP 夹具测试解析器/TLS/限额；被拒主机不发出网络请求。测试**实际连接器**无法选中被拒 IP，而不只是预解析拒绝了它。
9. **index 集成：** standalone 参数冲突/已保存会话；运行时选择；Docker 不做 QEMU 准备；连接启动失败锁存；重启时不会同时存在两代 Docker；断开/关闭；允许的工具；提示词准确；每个 `agent_end` 分支以及分发/发送失败时都释放轮次租约；失败任务的边界不变。
10. **隐私：** 哨兵真实密钥/占位符字符串绝不出现在假 Engine 的 create/exec 请求中（指真实值）、宿主机日志/状态/审计/错误中（两者都不行），或导出的元数据中。刻意的上游响应回显测试要记录残余泄漏行为，而不是断言一个不可能的普遍保证。

保留并重跑 `tests/local.test.ts`、`tests/runtime.test.ts`、`tests/secrets.test.ts`、平台、模型和斜杠命令测试。现有测试覆盖了真实 local 工具工厂和取消，但目前并不构成完整的扩展生命周期或真实虚拟机覆盖。

### 需主动开启的真实 Docker E2E

把真实守护进程测试放在默认 `tests/*.test.ts` 通配之外（例如 `tests/e2e/docker.test.ts`），以后用 `test:docker` 脚本或显式的 `tsx` 调用。要求 `PI_CHAT_DOCKER_E2E=1` 以及显式指定的一次性镜像/专用工作区。专门的 CI 任务在缺少 Docker 前提条件时必须**失败**，而不是静默跳过。普通 `npm test` 不能尝试 Docker。

前提条件：经批准的 Linux 守护进程/socket、一次性的专用测试存储、从可信源构建的固定镜像、无生产密钥、端口/socket 权限和容量。runc、rootless 和 runsc 任务分开；记录 Engine/内核/运行时/镜像/辅助程序版本以及生效的 inspect/cgroup 数据。安装运行时和修改守护进程策略是运维任务——停下来询问，不要隐式配置。

必需的 E2E 用例：

- create/start 就绪；`pwd=/workspace`；正确的非 root `id`；宿主机环境哨兵不存在；inspect 以及 `/proc/self/status`/mountinfo 或适合该运行时的等价方式确认 capability、no-new-privileges、rootfs/挂载策略。用该配置支持的检查方式验证 seccomp，而不是对所有运行时都用一个万能的 `/proc` 断言。
- 真实的 write/edit/read/图片操作、暂存的出站字节、模拟宿主机下载到 incoming、memory/skills/SYSTEM 路径、明文运行时密钥可见性/0600 归属；不读取批准挂载之外的宿主机文件。
- 位于容器中不存在路径上的宿主机哨兵无法被访问。软链接和软链接竞态无法骗宿主机桥接/暂存去读取或覆盖它。shared 只读即使尝试别名也依然生效。
- 很长的 stdout/stderr 混合输出和二进制输出；非零退出；stdin 传输；大输出文件可通过后端读取。worker/守护进程日志不会无限增长。
- 用 `sleep`、fork 的子进程、守护化/`setsid` 子孙进程、后台写入进程和忽略 SIGTERM 的进程测试超时/中止/断开。观察到写入进程真的停了、容器进程都没了；Promise 被 reject 是不够的。
- 用小的受控负载测试内存/PID/CPU 上限；区分 OOM 与手动 kill。绝不运行无上限的宿主机 fork 炸弹。确认守护进程/内核限制会导致预检失败即关闭。
- 空闲 stop/重启：工作区标记文件保留，tmpfs 标记消失，旧进程/exec 不会回来，新命令可用。`onClose=remove` 会删除容器；`stop` 只保留/复用匹配的已停止容器；digest/用户/挂载/策略变化时重建。
- 杀掉**测试 worker**，重启/对账，确认没有双写入者且清理安全。在一次性测试守护进程上或通过注入的传输层模拟守护进程丢失；不要停共享的生产 Docker 服务。演练容器启动后适配器连接失败的情况。
- 代理：不带凭证的允许 HTTP 和带占位符认证的 HTTPS 能到达受控夹具；夹具看到真实测试令牌，容器内 inspect/env 只看到占位符。使用注入的仅测试用可信上游/解析器接缝或专用公网夹具；不要为了测试方便加入生产环境的内网 IP 绕过。
- 直连 IP 的 TCP/UDP/DNS、`curl --noproxy '*'`、取消代理变量、宿主机网关/元数据/局域网/IPv6 地址、另一个容器和任意 CONNECT 都失败。也测试直接访问 Unix 代理：无法绕过每会话策略。盲 TLS 隧道/非 HTTP 协议都不能成功。
- 代理崩溃、中继崩溃、过期令牌、策略轮换、DNS 重绑定、重定向到被拒/内网目标、证书失败、HTTPS 降级和 CONNECT/SNI/Host 不一致都失败即关闭。两个并发会话不能复用彼此的 socket/令牌上下文。
- runsc：已认证镜像/辅助程序的系统调用行为、host-UDS 配置、文件可见性、资源限制、取消和代理测试。缺少 runsc 配置时必须失败，且不回退到 runc。
- 清理时只盘点带测试标签的容器、socket、私钥和临时文件；所有预期删除都完成，保留的资源要明确列出。绝不对守护进程做大范围 prune。

最后，用真实的 pi 在 standalone Docker 模式下配合已配置的模型测试实际扩展，再在一个专用聊天会话中测试附件和 stop/status。后端 E2E 套件不需要模型或平台凭证；最后这两个冒烟测试需要。缺少条件时通过合适的安全流程向运维询问。使用合成数据，不要打印生产凭证。

**在实现了各自的前提条件之后**，未来的验证命令可以是：

```bash
npm run check
npm test
PI_CHAT_DOCKER_E2E=1 npx tsx --test tests/e2e/docker.test.ts
# Only once the proposed flag and trusted image config exist:
pi --no-extensions -e /workspace/pi-chat/index.ts \
  --chat-docker --chat-workspace /absolute/disposable-workspace \
  --no-session -p 'Use bash to run pwd and id. Reply with DOCKER_OK and the output.'
git diff --check
```

不要把 `npm run format` 当作只读验证命令；它会写文件。本次文档任务中没有执行任何测试/构建步骤作为 Docker 支持的证据。

## 13. 有序的实现任务和验收标准

先交付离线执行，再开放网络代理模式；未完成的模式保持不可用，而不是削弱默认值。每个任务都有具体的完成门槛。

### 任务 1 — 锁定实现契约

- 解决 §14 中的阻塞项（认证的平台/运行时、镜像/辅助程序、代理实现、输出收集器）。
- 确认已安装的 pi 操作契约和 Engine API 兼容范围。
- 决定并记录 rootless/runsc 的支持状态、UID 映射、大小预算和加固验证方式。

**验收：** 有一份明确无歧义的 create 规格和生命周期/密钥契约；没有开放式的额外 Docker 参数；没有测试任务支撑的平台不宣称支持。

### 任务 2 — 添加配置/类型和懒加载路由

- 更新类型、解析、校验、默认值、私有 Docker 路径和测试夹具。
- 添加穷尽的懒加载执行工厂分支；保留 Gondolin/local 行为。
- 添加配置/单元测试，包括在 Docker 策略下继承的旧密钥。

**验收：** 旧配置解析结果完全不变；无效 Docker 设置在产生副作用前就失败；local/Gondolin 测试不加载/探测 Docker；默认执行仍是 Gondolin。

### 任务 3 — 实现 Engine 客户端和可信镜像

- 添加可注入的传输层和有界的 create/inspect/start/exec/stop/kill/remove API。
- 产出一个经审查的固定镜像，包含 bash、入口点/回收进程、文件辅助程序和可选中继；定义辅助程序就绪协议和干净环境。
- 实现流分帧和结构化/脱敏的错误转换。

**验收：** 假守护进程契约测试覆盖分帧/迟到响应/限额；镜像不需要容器内 root、运行时安装系统包、宿主机凭证或 Docker socket 访问。

### 任务 4 — 实现离线生命周期和取消

- 创建 `DockerExecution`、代数/状态/租约处理、私有元数据和清理。
- 支持 network-none、有界启动和终态幂等的 close。
- 实现整容器取消和结果不确定时的处理。

**验收：** 每个注入的启动失败都清理自有资源；close/start 竞态无法发布泄漏的 ready 容器；中止会等待 stop，或留下明确的失败状态；不重放命令，不回退到 local。

### 任务 5 — 实现安全的文件操作、暂存和有界输出

- 提供全部四种操作，使用容器 cwd 和字节安全的传输。
- 加固暴露的宿主机桥接和目录/密钥写入，抵御恶意挂载内容；无关代码改动保持最小范围。
- 解决 pi 溢出文件的可见性问题；加入暂存文件保留策略和预算。

**验收：** 真实 pi 工具工厂能在注入的操作上运行；路径/竞态/特殊文件/大小测试通过；声明的输出路径后端可读；没有安全桥接就不会把容器路径当宿主机路径用。

### 任务 6 — 接入参数、连接/重启和提示词

- 添加 standalone Docker 启动/失败锁存；保留 standalone local 语义。
- 添加连接模式的失败即关闭保护、串行化的 Docker 替换，以及重连时显式应用策略。
- 更新两处提示词、界面字段保留、状态和 worker 处理；接入轮次活动租约。

**验收：** 假扩展生命周期覆盖每条启动/关闭/错误分支；Docker 从不触发 QEMU 准备、不把自己误标为 VM/local，也不启用不安全的回退工具。聊天分发/完成语义保持不变。

### 任务 7 — 添加空闲 stop、安全复用和对账

- 实现假时钟下的空闲计时、同一对象唤醒、可选的已停止容器保留、TTL 和限定范围的孤儿清理。
- 按不可变设置校验 inspect 状态；归属变化时轮换代理权限。

**验收：** 有租约时不 stop；后台进程不会隐式存活；不会有两个存活所有者；保留数据/重建 tmpfs 的行为有明确规定；删除绝不触及 bind 内容或他人资源。

### 任务 8 — 实现策略和宿主机密钥替换

- 实现规范化精确主机策略、非全局 IP 拒绝、受检连接器、隔离的令牌映射、Bearer/Basic/查询语义和隐私控制。
- 移植相关的 Gondolin 测试用例，并添加刻意更严格行为的测试。

**验收：** `[]` 全部拒绝；密钥不能放宽主机策略、不能以真实值进入 Engine env，也不能通过 HTTP 注入；错误主机/改写后/过期的令牌被拒绝。不做请求体替换，也不做普遍机密性的承诺。

### 任务 9 — 实现强制的代理传输和 TLS

- 添加宿主机 Unix 监听器、回环中继、公开 CA 挂载/信任、经审查的 CONNECT 中间人和有界 HTTP 转发。
- 接入关闭/策略变更时的撤销，并确认不存在直连网络路径。
- 在不自动修改守护进程的前提下，验证 runsc 的 host-UDS 配置。

**验收：** 所有网络路径都经过同一套策略，否则失败；没有盲 CONNECT；每个实际出站连接都做地址检查；代理故障不能开放出网；不支持的配置启动失败。通过此门槛之前不开放 proxy 模式。

### 任务 10 — 完成审计/状态和完整验证

- 添加脱敏的结构化事件、配额/保留策略、清晰的运维诊断和考虑归属的清理可见性。
- 完成所有单元/集成和需主动开启的 E2E 用例，然后按顺序运行 `npm run check`、`npm test`、真实 Docker 矩阵和 pi/chat 冒烟测试。
- 在实现改动中，用**实际**结果和支持限制更新面向用户的配置/开发说明。本次文档任务不授权现在修改那些文件。

**验收：** 记录了版本/结果；Docker CI 没有把跳过当通过；没有泄漏的测试资源或哨兵凭证；现有后端/平台测试通过；明确列出只能由运维提供的前提条件。只有用户另行授权才 commit/push。

## 14. 待定问题和不能靠猜测拍板的决定

1. **镜像和辅助程序实现（阻塞）：** 谁维护/发布固定 digest 的镜像？需要哪些发行版/架构和语言？哪个经过审计的 fd 相对辅助程序能同时在 runc 和所选 runsc 下工作？通用的任意镜像与提议的契约不兼容。
2. **代理组件（proxy 模式的阻塞项）：** 用哪个维护中的 HTTP/TLS 中间人实现？如何保证受检的 DNS/连接路径？纯 Gondolin 钩子工厂不是这个组件。复制代码前审查解析器/TLS 依赖和许可证。
3. **平台基线（阻塞）：** 初期只支持 Linux 本地 Engine 是否足够？Desktop/远程守护进程上的 socket 共享和 rootless 的 UID/cgroup 行为需要单独的设计/测试；不要悄悄降低网络或加固要求。
4. **gVisor 部署（runsc+proxy 的阻塞项）：** 是否接受由运维管理、开启 host-UDS open 的运行时？部署的 runsc 是否支持文件辅助程序所需的系统调用和预期的挂载语义？上游存在某个参数不等于该部署已认证。
5. **输出收集器（阻塞）：** 是装饰已安装的 pi bash 工厂，还是提供兼容的有界收集器？必须处理部分/最终/错误路径，不能读取用户指定的宿主机文件，也不能修改 node_modules。
6. **shared 写入：** Docker 默认只读 `/shared` 是否可以接受，还是跨频道写 memory 必不可少？如果可写，用户必须确认接受同账号跨频道的信任关系。提示词要随实际模式调整。
7. **取消范围：** 命令中止/超时时终止后台服务是否可以接受？安全的 v1 策略是整容器 stop。细粒度终止是额外工作，不是杀掉客户端流就行。
8. **持久化预期：** 用户只要工作区持久化，还是也要保留安装的系统包？只读 rootfs + 非 root 有意禁止后者。stop/start 并不能让 `apt install` 变得可行；commit 也不是默认答案。
9. **宿主机消费者信任（发布门槛）：** 在可写工作区中，pi 项目扩展/配置、git hooks 和 shell 集成如何禁用/审查？后端保护不了随后执行 Agent 所写代码的宿主机。
10. **磁盘/宿主机资源治理：** 需要哪些工作区配额、最大 worker 数、代理预算、附件上限和保留资源 TTL？所有 worker 都停了时由什么维护任务负责？
11. **密钥演进：** 初期按提议保留旧的 `gondolin.secrets` 写法，还是规划一个单独定义的中性迁移？真的需要查询参数令牌吗？哪些允许的 API 主机需要操作/路径限制？
12. **私有服务 / 协议：** 默认拒绝内网服务和非 HTTP 协议。如果需要私有镜像仓库、SSH 或自定义端口，要定义严格认证的代理例外并配测试；不要加 `allowedHosts: ["*"]` 或不受限的 bridge。
13. **热重载：** v1 可以要求 Docker 设置变更后断开重连。如果需要在线轮换策略，要原子地撤销旧的代理连接池/权限，并更新所有捕获的会话引用；目前只比较密钥的重启判断不够。
14. **删除体验：** 删除频道时是否先自动停止/删除其保留的 Docker 容器，还是要求显式清理？只要还有保留/运行中的所有者可能写入，就拒绝静默删除挂载的宿主机存储。
15. **验证条件：** 编写文档的环境 PATH 上没有 Docker。真实的 runc/runsc、网络负面测试、UID/权限和清理测试需要合适的主机和运维许可；未满足的条件要如实报告，而不是标记为通过。

### 14.1 本轮实现决定

以下决定对应上面的 1–15 项。没有运维条件的项目选择“不支持/待认证”，不放宽安全策略。

| 项 | 决定与边界 |
| --- | --- |
| 1 镜像/辅助程序 | 由部署方审查并显式构建 `assets/docker/Dockerfile`；没有声称已发布的项目镜像。当前 Alpine/Linux amd64，Python 3 fd-relative、逐段 `O_NOFOLLOW` 辅助程序协议 `1`；文件工具拒绝软链接、特殊文件和多重硬链接。镜像运行引用必须含仓库 digest，不能使用浮动 tag。发行版包版本尚未完全锁定，重建产物须重新认证。 |
| 2 代理 | 使用 Node 维护的 HTTP/1 解析器、TLS 栈及宿主机 OpenSSL 签发测试/会话证书，`ipaddr.js@2.2.0` 做地址分类，不复用 Gondolin VM。自有 CONNECT/转发策略仍属于可信计算基，需要独立安全审查；现有 fixture E2E 不等于完成 §9 全部攻击矩阵。 |
| 3 平台 | 当前基线为本地 Linux rootful Engine，固定 Unix socket，非 root 控制器与容器同有效 UID:GID。rootless、userns-remap、Desktop、远程 Engine 不认证；当前预检拒绝 rootless/userns。即使配置了非零 user，root 控制器也不在本轮支持范围。 |
| 4 runsc | 本轮只认证下面列出的 `network=none` 用例；保持部署现有 `host-uds=none`。不修改 daemon.json、不重启 Docker、不测试 runsc proxy。runsc 的资源压力等价性尚待单独验证，不能由 runc 结果代替。 |
| 5 输出 | 使用 `src/docker-output.ts` 的有界收集器，16 MiB 总输出预算；大输出通过后端写入 `/workspace/.pi-chat-output/`。不解析命令伪造的宿主机路径，不改 node_modules。二进制由 Engine 层保留；stdout/stderr 两条管道不保证跨流的全局写入顺序。 |
| 6 shared | 默认只读；显式 `sharedReadOnly=false` 才接受账号级共同写入信任。工作区/shared 重叠拒绝，别名写入不能绕过只读挂载。 |
| 7 取消 | 接受整容器停止，包括 setsid 后代和后台服务；必须确认写入停止。持久化副作用不回滚，也不重放取消的命令。 |
| 8 持久化 | 只保证 bind 数据；rootfs 只读，不保留系统包安装、不做 commit。stop/start 重新创建进程/tmpfs。 |
| 9 宿主机消费者 | 容器生成的扩展、脚本、hooks 都是不可信内容；部署方必须审查/禁止宿主机自动执行。本轮没有完成可信 worker 的项目资源发现审计，仍为生产发布门槛。 |
| 10 预算 | 文件/附件单次 50 MiB；exec 输出 16 MiB；outgoing 有总量/文件数预算和过期清理；保留容器默认 TTL 86400 秒，在持有租约的对账时执行。没有全局常驻清扫器、硬磁盘配额或最大 worker 数治理，不宣称 bind 磁盘用量被 cgroup 限制。 |
| 11 密钥 | 保留旧 `gondolin.secrets` schema；仅 proxy 接受，精确目标不得扩大主机许可；查询替换默认关闭。明文 `.secrets` 与宿主机代理密钥分开。生产 API 权限/路径限制由部署方决定，不自动授权。 |
| 12 私有服务 | 不提供私网、自定义端口、SSH/通用 TCP 例外。E2E 注入 fixture 连接器只在测试代码构造，不增加生产配置绕过项。 |
| 13 热重载 | Docker 设置变更必须关闭旧代再重新连接，不承诺在线原子轮换。不能同时保留两个写入者。 |
| 14 删除 | 有保留资源元数据时拒绝静默删除频道/账号数据，要求显式清理并对账；不做广泛 prune。 |
| 15 验证条件 | 使用当前已安装 Engine/runc/runsc，专用 `/tmp/pi-chat-docker-e2e`，无平台凭证、无生产密钥。不操作飞书 worker。真实 pi+模型与专用聊天冒烟需用户另行提供/指定测试条件。 |

### 14.2 本轮验证记录与复现

实际环境：Linux `6.12.94+` x86_64；Docker Engine `26.1.5+dfsg1` / API `1.45`；runc `1.1.15+ds1`；runsc `release-20261005.0`；Node `22.23.3`；已安装 pi 工具包 `@mariozechner/pi-coding-agent@0.67.67`、Gondolin `0.7.0`。没有修改 Engine 配置或任何已运行聊天 worker。

本轮从仓库镜像资产构建并通过仅监听 `127.0.0.1:15000` 的一次性本地 registry 取得真实仓库 digest：

```text
localhost:15000/pi-chat-e2e@sha256:130f22a9c53923a3f124ebb4c0d9d8408267749ebda9b211e73d9a3b56bd0302
helper protocol: 1
image ID: sha256:e53009a4d69bed8200f28491e9dfa2df44e905d4303ebbba473459fbc7871a15
```

这是本机测试产物，不是公开发布地址。测试通过非 root `box` 控制器运行，使用其已有 docker 组权限，不改变 socket 权限或组配置。最终盘点未留下受管测试容器；一次性 registry 容器及其匿名卷已删除，专用 E2E 目录为空。已构建的测试镜像、构建缓存及拉取的基础/registry 镜像留在本地 Engine，未做广泛 prune；测试日志保留在 `/tmp/pi-chat-{check,test,runc,runsc}.log`。

- `npm run check`：通过，Biome 无错误/警告，TypeScript 通过。
- `npm test`：100/100，通过；不连接 Docker。
- 真实 runc：5/5，通过；包含文件/图片/运行时明文密钥/附件/二进制及大输出、只读挂载和环境隔离、直连网络拒绝、超时/abort/close 后写入停止、空闲/复用/配置变更重建、SIGKILL **一次性测试控制器** 后孤儿对账、受控 PID/CPU/OOM 负载、HTTP/HTTPS 占位符代理。
- 真实 runsc：3/3，通过，全部 `network=none`；包括文件辅助程序、上述离线安全/生命周期及孤儿测试；不注册 proxy 测试，因此不是把 proxy skip 当通过。
- runc 实际 cgroup：测试配置 256 MiB 时 `memory.max=268435456`、`memory.swap.max=0`、`pids.max=64`、`cpu.max=50000 100000`。资源压力用例另用 128 MiB、32 PID、0.25 CPU；观测 `nr_throttled` 和 `oom_kill` 增长，不把 137 单独当 OOM 证据。
- 真实 Engine 暴露并修复一个 mock 未覆盖的错误：`Tmpfs` 字典键顺序不同会导致 JSON 字符串比较误报加固失败。现用结构深比较，并让 fake Engine 反转键序作为回归覆盖；没有删除任何加固字段检查。

复现（镜像必须已经由运维批准并存在于本地 Engine；换机器须重新构建并填入真实 digest）：

```bash
npm run check
npm test
PI_CHAT_DOCKER_E2E=1 \
PI_CHAT_DOCKER_IMAGE='<approved-repository>@sha256:<actual-digest>' \
PI_CHAT_DOCKER_WORKSPACE='/absolute/disposable-directory' \
PI_CHAT_DOCKER_RUNTIME=runc npm run test:docker
# 相同参数，将 runtime 改成 runsc；仅 network=none。
git diff --check
```

**仍未完成的发布验证：** §12 全部攻击矩阵尚未穷尽，尤其代理崩溃/中继崩溃、并发会话连接池隔离、完整请求走私/TLS/DNS 重绑定矩阵、恶意工作区宿主机消费者审计和 runsc 资源压力认证。真实 pi+模型 standalone、专用聊天附件/stop/status 冒烟尚未执行；不能使用正在运行的飞书 worker 代测。rootless/Desktop/其他架构均未认证。现有测试通过只支持本节列出的结论，不代表 §13 全部发布门槛完成。

## 15. 实现的主要参考资料

本指南中的本地源码引用是当前 pi-chat/Gondolin 行为的权威依据。另外参考了以下官方资料来确认 Docker/gVisor 语义；生产中要锁定/重新核对所用版本。

- **[D1] Docker Engine API v1.48，Moby v28.0.0：** [带版本的 OpenAPI 源文件](https://github.com/moby/moby/blob/v28.0.0/docs/api/v1.48.yaml)。参见容器 create/start/stop/kill/delete、exec create/start/inspect、attach 流分帧、`HostConfig`、资源字段、bind 选项和容器状态。这是参考契约，不是要求对每个守护进程都盲目请求 API 1.48。
- **[D2] Docker exec：** [官方命令参考](https://docs.docker.com/reference/cli/docker/container/exec/) / [源文件](https://github.com/docker/cli/blob/master/docs/reference/commandline/container_exec.md)。exec 要求 PID1 在运行，容器重启后命令不会重启。
- **[D3] Docker internal 网络：** [network create 参考](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal) / [源文件](https://github.com/docker/cli/blob/master/docs/reference/commandline/network_create.md)。internal 网络对网关/宿主机服务的可达性会影响代理拓扑。
- **[D4] Docker network-none：** [文档](https://docs.docker.com/engine/network/drivers/none/) / [源文件](https://github.com/docker/docs/blob/main/content/manuals/engine/network/drivers/none.md)。只配置回环网卡。
- **[D5] Bind 挂载：** [文档](https://docs.docker.com/engine/storage/bind-mounts/) / [源文件](https://github.com/docker/docs/blob/main/content/manuals/engine/storage/bind-mounts.md)。在守护进程主机上解析、递归挂载、传播和只读的局限。
- **[D6] 容器运行/加固选项：** [参考](https://docs.docker.com/reference/cli/docker/container/run/) / [源文件](https://github.com/docker/cli/blob/master/docs/reference/commandline/container_run.md)。rootfs、tmpfs、用户、安全选项和运行时控制。
- **[D7] 资源限制：** [文档](https://docs.docker.com/engine/containers/resource_constraints/) / [源文件](https://github.com/docker/docs/blob/main/content/manuals/engine/containers/resource_constraints.md)。容器默认不受限；支持时 memory 与 memory-swap 相等可禁止 swap；CPU 配额与 CPU 份额是两回事。
- **[D8] Seccomp：** [文档](https://docs.docker.com/engine/security/seccomp/) / [源文件](https://github.com/docker/docs/blob/main/content/manuals/engine/security/seccomp.md)。默认配置和内核/守护进程支持；不要为了方便关闭限制。
- **[D9] Stop 和 commit：** [stop](https://docs.docker.com/reference/cli/docker/container/stop/) / [源文件](https://github.com/docker/cli/blob/master/docs/reference/commandline/container_stop.md)；[commit](https://docs.docker.com/reference/cli/docker/container/commit/) / [源文件](https://github.com/docker/cli/blob/master/docs/reference/commandline/container_commit.md)。stop 使用信号/宽限/kill 序列；commit 不包含挂载卷的数据，并且在捕获文件系统改动时通常会暂停进程。
- **[G1] gVisor Docker 快速入门：** [文档](https://gvisor.dev/docs/user_guide/quick_start/docker/)。运行时注册是宿主机/运维任务；通过 Docker 的 `--runtime` 选择。
- **[G2] gVisor 宿主机 Unix socket：** [runsc 参数注册](https://github.com/google/gvisor/blob/master/runsc/config/flags.go)，`host-uds` 默认 `none`；[配置类型](https://github.com/google/gvisor/blob/master/runsc/config/config.go)，`HostUDSNone/Open/Create/All`。这些是上游实时参考，不是锁定的已安装 runsc 版本。
- **[G3] gVisor 文件系统行为：** [文档](https://gvisor.dev/docs/user_guide/filesystem/)。rootfs overlay、bind 可见性和运行时文件系统设置必须针对所选版本验证。

**发布规则：** 每个结论都要标明是已实现、已单元测试、已真实 Docker 测试，还是仍未验证。只要缺少必需的能力，安全默认值就必须保持失败即关闭。
