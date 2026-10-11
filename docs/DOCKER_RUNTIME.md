# Docker execution backend: implementation guide

> **Status: design / implementation instructions, not an implemented feature.** This document is the only deliverable of the context-gathering task. All Docker config keys, flags, modules, tests, and commands described as proposed below still need implementation. Do not interpret an example as evidence that Docker execution already works.
>
> Scope: add Docker **tool execution** beside `gondolin` and `local`. The pi/model client, messaging adapters, conversation log, and controller remain on the host.

## 1. Evidence, scope, and terminology

### Source baseline

References use the following inspected revisions; line numbers describe that baseline and will move during implementation:

- pi-chat: `/workspace/pi-chat`, commit `e6678cfd49dc08697cc73056c3de9fb776c07044`; initially clean working tree.
- Gondolin: `/workspace/gondolin`, exact tag `v0.7.0`, commit `c9a37ff25d8a517dc0ce576a622d8685c2711fdc`; `host/package.json:3` declares `0.7.0`. pi-chat declares **`^0.7.0`**, not an exact pin (`package.json:25`). Verify the lockfile/install when implementing.
- Existing handoff: [`DEVELOPMENT.md`](DEVELOPMENT.md), especially §§2–4, 6.3–6.4, and 9; [`configuration.md`](configuration.md), runtime inheritance and standalone mode.
- Background analysis: `/workspace/gondolin-control-plane.md:24–209` (lifecycle/state), `:211–247` (idle/reuse); `/workspace/microvm-runtime-hardening/docs/threat-model.md:39–165` (assets, boundaries, risks, unresolved claims).
- Installed tool contracts: `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/{bash,read,write,edit}.d.ts`. The installed pi extension documentation and remote-operations example were also inspected: `/home/box/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` and `examples/extensions/ssh.ts`. Check the actual installed version again before coding; the repository's pi peer dependencies are `"*"`.

A pi-chat path such as `src/execution.ts:5–25` is relative to this repository. `G/host/src/...` means `/workspace/gondolin/host/src/...`. External Docker/gVisor references are collected in §15. They establish API semantics, **not** proof that the proposed deployment was tested. No real Docker or gVisor E2E was run for this document; `docker` was not found on this host's PATH. Existing handoff test counts are historical and inconsistent across sections; use actual test output, not those counts, as a release gate.

### Goals

1. Explicitly select `runtime.mode: "docker"` without changing old configurations' default Gondolin behavior.
2. Run `read`, `write`, `edit`, and `bash` inside one managed container per connected conversation; support an isolated standalone smoke-test mode.
3. Preserve host-persistent `/workspace` and account-scoped `/shared`, attachment paths, memory/skills, job consumption boundaries, and platform behavior.
4. Provide bounded startup/shutdown, streaming output, real cancellation, idle reclamation, and controlled stop/start reuse.
5. Provide deny-by-default egress, optionally mediated HTTP(S) with hostname policy and host-held secret substitution analogous to Gondolin's HTTP hooks.
6. Default to least privilege and expose the actual isolation level, effective limits, and lifecycle state in diagnostics.
7. Keep ordinary unit tests independent of Docker, QEMU, messaging credentials, and a model provider. Add a separately selected real-Docker suite.

### Non-goals for the first release

- Moving pi, its API credentials, bot credentials, or adapters into the agent container.
- Replacing Gondolin, claiming Docker/runc is equivalent to a microVM, or silently falling back to local/runc/unrestricted networking.
- Kubernetes, Swarm, arbitrary remote Docker daemons, Docker-in-Docker, privileged containers, host networking, GPU/device passthrough, or arbitrary `docker run` flags.
- Generic TCP/SSH/UDP/QUIC forwarding, ingress/port publishing, browser networking parity, or transparent networking for clients that ignore explicit proxies.
- Memory/process snapshots, CRIU, automatic `docker commit`, or preserving background processes through idle shutdown.
- Redesigning chat authorization, delivery guarantees, or the pending-job reconstruction algorithm.
- Claiming prompt instructions or an environment-variable proxy configuration are a security boundary.

**Recommended support boundary:** first certify a local Linux Docker Engine, Linux containers, enforced cgroup limits, and a dedicated non-root controller account. Rootless Docker and `runsc` are separate tested profiles. Docker Desktop, remote contexts, user-namespace remapping, and other runtimes must not be advertised as supported before the mount, UID, socket, and resource tests pass.

## 2. What the existing code actually does

### Execution and connection behavior

- `src/execution.ts:5–16` defines the common operations interface; `:18–25` lazily imports local, otherwise Gondolin. Its current final branch is a fallback, not an exhaustive mode switch.
- `src/gondolin.ts:73–101` creates directories, builds secret hooks, creates a VM with two `RealFSProvider` mounts, probes/attempts to install bash, and writes `{vmId, secretNames}` to `gondolin/session.json`. That file is not a restore mechanism. `:103–108` closes the VM; there is no pi-chat idle timer or checkpoint use.
- Local execution returns `undefined` file operations intentionally, selecting pi's host filesystem implementation (`src/local.ts:71–82`). Its bash environment is deliberately minimal and it ignores caller environment inheritance (`:110–181`). Local startup rejects all merged Gondolin hook secrets (`:32–48`). Do not copy its `undefined` operations into Docker.
- `index.ts:836–1043` resolves the conversation, disconnects the previous one, prepares QEMU only for Gondolin, acquires the runtime lock, starts execution, then connects the live adapter. Failure cleanup closes execution and releases the runtime lock.
- Tool delegates are in `index.ts:530–558`; registration is in `:1680–1716`. They use `sandbox.workspacePath`, not `ctx.cwd`. `sandbox` is now a `ConversationExecution`, despite its historical name.
- Remote turns have a tool allowlist (`index.ts:1432–1443`). This is not whole-process isolation: extensions, slash-command integrations, model access, memory loading, downloads, secret writes, and logs still execute on the host.
- `executionRequired` / `executionError` currently enforce persistent fail-closed behavior for **standalone local startup** (`index.ts:1735–1767`). Do not assume connected-mode failure has the same guard: absent a sandbox, delegates can choose host tools. Docker-selected startup, replacement, and unexpected-exit paths need their own explicit failure latch.

### Gondolin semantics relevant to the new design

| Concern | Verified behavior | Consequence for Docker |
| --- | --- | --- |
| VM/root storage | VM gets a new UUID (`G/host/src/vm/core.ts:342–350`). Root mode falls back to `cow` after image manifest defaults (`:486`); the COW branch creates a disposable overlay (`:573–590`). Close removes a delete-on-close root disk (`:1392–1450`). | Persistent bind mounts are separate from rootfs persistence. Do not equate container stop/start with VM suspend. |
| Exec | pi-chat uses bash, `proc.output()`, and `exitCode` (`src/gondolin.ts:299–339`). Gondolin sends exec frames and credit updates (`G/host/src/vm/core.ts:1090–1192`). | Docker needs stream demultiplexing and exec inspection, not the VM protocol. |
| Abort | Gondolin's inspected abort listener rejects/removes the host exec session (`G/host/src/vm/core.ts:1110–1117`); it does not send a guest kill in that listener. | Do not reuse this as proof of process-tree termination. Specify stronger Docker cancellation explicitly. |
| Checkpoint | `checkpoint()` syncs best-effort, closes the VM, preserves the qcow2 disk, and records `snapshotKind: "disk"` (`G/host/src/vm/core.ts:1905–2029`). Resume creates a new overlay backed by the checkpoint (`G/host/src/checkpoint.ts:420–472`). | No memory/exec/network continuation. Resume also calls a backing-path rebase helper; the background note's blanket “checkpoint is never modified” wording is too strong. |
| Network boundary | Gondolin has a mediated userspace network stack, not generic NAT (`G/docs/architecture.md:123–149`). HTTP hooks are only one part of that stack. | Importing `createHttpHooks()` does not create a proxy, TLS interception, or an enforced Docker network boundary. |
| Current pi-chat egress | With secrets, pi-chat calls `createHttpHooks({allowedHosts: ["*"], secrets})`; with no secrets it supplies no hooks (`src/gondolin.ts:29–44`). | Current secret host restrictions are not a general outbound host allowlist. Improve Docker defaults without pretending Gondolin already has them. |
| Hook defaults | Hooks generate 24 random bytes as a hex placeholder, default internal-address blocking on, and combine `allowedHosts`, `allowedInternalHosts`, and secret hosts (`G/host/src/http/hooks.ts:58–82`). An empty resulting host list allows all (`:154–168`). | Docker's proposed empty allowlist means deny all. Do not directly pass `[]` into Gondolin and expect denial; do not auto-expand Docker's host policy from secret definitions. |
| Substitution | Header strings and Basic auth are replaced; query replacement is opt-in; bodies are not substituted (`G/host/src/http/hooks.ts:84–121, 363–490`). Real-value checks protect subsequent disallowed destinations in supported header/query fields (`:274–361`). | Mirror the narrow contract, not arbitrary body/HMAC/SSH-key injection. |
| IP policy | Request checks and resolved-address checks are separate (`G/host/src/qemu/contracts.ts:48–75`). Actual connection lookup is guarded (`G/host/src/http/utils.ts:304–372, 537–583`); redirects use manual handling (`G/host/src/qemu/http.ts:1278–1427`). | Checking a hostname once before an ordinary unguarded `fetch()` is insufficient against rebinding and redirects. |

The threat model contains deliberately unresolved points, not universal facts. Two can be clarified from this checkout: `/shared` is **account-wide** (`src/config.ts:74`), and Gondolin's vendored `RealFSProvider` does have lexical/realpath/ancestor checks (`G/host/src/vfs/node/vendored-node-vfs/lib/internal/vfs/providers/real.js:209–309`) and escaping-symlink tests (`G/host/test/vfs-realfs-provider.test.ts:127–207`). Those checks do not establish race-free containment for every host-side path operation. Preserve the threat model's distinction between source inspection and runtime verification.

## 3. Exact integration map

Use symbol names as well as these baseline line references. New module names in this table are recommendations, not existing files.

| Location | Required implementation work |
| --- | --- |
| `src/core/config-types.ts:3–7, 117–148` | Add `"docker"` to runtime/resolved mode types; define optional nested Docker config and a fully resolved Docker settings type. Add Docker metadata paths without repurposing `gondolinDir`. Root/account/channel already share `RuntimeConfig` (`:27–43, 118–124`). |
| `src/config.ts:43–100` | Resolve nested settings with explicit inheritance rules; validate untrusted JSON; keep missing mode = Gondolin. Docker uses per-channel host workspace by default and `/workspace`, `/shared` as displayed paths. Add resolved Docker metadata directory under `conversationDir`. |
| `src/config.ts:127–140` | Root runtime already round-trips. Do not put new validation inside the broad load-and-return-empty catch: an invalid Docker policy must produce an error, not appear to be absent configuration. |
| `src/config.ts:107–114, 153–164` | Keep external workspace deletion semantics. Account/channel deletion must account for retained managed containers before deleting storage. Warn/reject unsafe overlapping workspaces; the existing warning groups equal strings only, not canonical aliases/ancestor overlaps. |
| `src/execution.ts:5–25` | Extend mode union; add a lazy Docker branch and explicit unsupported-mode error. Never import Docker/Gondolin eagerly for another backend. |
| **New** `src/docker.ts` | `DockerExecution implements ConversationExecution`: lifecycle, operation leases, path policy, exec, attachment staging, idle timer, ownership and reuse. |
| **New** `src/docker-client.ts` | Injectable Docker Engine transport; structured create/inspect/start/exec/stop/kill/remove operations and bounded streaming. No shell-generated Docker commands. |
| **New** `src/docker-egress.ts` and policy helper | Host-held per-conversation policy/secret context; HTTP(S) proxy, lifecycle, limits, DNS-safe connector, sanitization. Keep policy testable without a container. |
| **New** image/helper assets | Trusted prebuilt bash image, non-root entrypoint/relay, binary-safe file helper. Version/digest the image and helper protocol together. Nothing here runs as an automatic host-side build of agent-authored code. |
| `src/log.ts:57–68` | Directory initialization currently always creates `gondolinDir`. Add Docker private directories deliberately; unused Gondolin directory compatibility can remain initially. Keep metadata/log/lock outside mounted roots. |
| `index.ts:467–480, 1730–1769` | Register standalone Docker flag(s); validate combinations; start selected standalone execution; preserve only four active tools. Latch failure before any startup operation can throw. |
| `index.ts:530–558, 1680–1716` | Use Docker operations for every tool; maintain backend errors instead of host fallback. Add bounded-output integration at the bash delegate/registration layer (§7). |
| `index.ts:811–834` | Existing restart starts a new backend **before** closing the old one. Do not allow two Docker instances with the same workspace/proxy ownership to race. For a Docker-involved replacement, quiesce, close the old generation, then start/publish the new one. Failure stays closed. |
| `index.ts:836–859, 1022–1043` | Docker preflight/start belongs beside the existing Gondolin-specific preparation, never in `prepareGondolin()`. Keep runtime lock acquisition before Docker ownership/adoption. Cleanup partial Docker resources on all failures. |
| `index.ts:1445–1477` | Config UI currently compares only `gondolinSecrets`. Compare effective Docker execution settings/policy as well, or require disconnect/reconnect for all Docker changes in v1. Never continue with stale policy after a claimed successful update. |
| `src/tui/chat-config.ts:30–64` | Add mode choice with accurate isolation warning. Existing assignment replaces `target.runtime` wholesale; preserve nested Docker fields when editing mode/workspace. Update secret labels (`:124–160`) if using the compatibility schema below. |
| `src/execution-prompt.ts:4–15`; `index.ts:50–109, 1788–1804` | Add a Docker-specific environment description in **both** prompt paths. Do not say Alpine/apk/fresh VM for arbitrary images or recommend root package installation on a read-only rootfs. |
| `index.ts:588–630`; `src/runtime.ts:31–44`; `src/execution.ts:27–36` | Memory, skills, SYSTEM.md, transcript attachments use resolved paths. Keep `/workspace` and `/shared` display; `displayPath()` is string translation, not a security check. |
| `index.ts:866–884`; `src/secrets.ts:44–54` | Runtime secret exchange still writes plaintext host files. Ensure mapped UID access and safe writes in hostile writable mounts; distinguish it from proxy-held secrets. |
| `index.ts:1325–1339`; `src/gondolin.ts:119–138`; `src/local.ts:84–107` | Docker `stageAttachment()` returns a private **host** path for adapters, not a container path. Retain the interface but improve path/race safety (§8). |
| `index.ts:1383–1429, 1808–1882` | Hold/release execution activity around turns, dispatch errors, send completion, abort and shutdown. Disconnect must stop idle/proxy timers and await or report teardown before releasing ownership. |
| `index.ts:1772–1775` | Idempotent `session_shutdown` cleanup remains mandatory. SIGKILL cannot invoke it: add safe orphan reconciliation. |
| `index.ts:129–149, 798–806, 1076–1105` | Extend status with Docker state, short ID, runtime/image identity, limits, idle/reuse and last sanitized execution error. Do not leak secrets in worker snapshots. |
| `index.ts:387–419` | tmux stays a host worker. It passes `--chat-conversation`, not standalone execution flags. Config selects Docker; no need to containerize tmux. Avoid forwarding standalone flags to all workers. |
| `tests/helpers.ts:10–32` | Extend temporary fixture paths; never let new metadata default into real `~/.pi/agent/chat`. |
| `tests/runtime.test.ts:19–70`; `tests/local.test.ts:9–84` | Extend defaults/inheritance/prompt tests, and retain native-tools/env/cancellation/local-secret rejection regressions. |
| `package.json:31–39`; `tsconfig.json` | Keep `check`/ordinary `test` daemon-free; add opt-in E2E selection. Avoid broad peer/dependency upgrades as part of backend work. |

Do **not** add Docker-specific scheduling to `ConversationRuntime`. Its connect/lock (`src/runtime.ts:71–82`), dispatch/slice (`:236–254`), complete/fail (`:256–295`) remain the conversation state machine. An execution failure must not fabricate `job_completed` or advance the consumed-message boundary.

## 4. Configuration and flags: proposed contract

### Schema and defaults

Use `runtime.docker` rather than a fourth unrelated root-level settings tree. Allow it at root, account, and channel scope. For example, this is a **future config fragment**, not a complete replacement for `config.json`:

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

The UID above is illustrative: it must match the deployment's actual ownership/mapping. Do not hard-code it as universal.

| Setting | Proposed default and validation |
| --- | --- |
| `runtime.mode` | Existing default `gondolin`; explicit `docker` opts in. Unknown/non-string modes fail. |
| `runtime.workspaceDir` | Docker default `<conversationDir>/workspace`; absolute host directory override allowed. Guest path remains `/workspace`. No automatic migration or `~` expansion. |
| `docker.image` | Required digest-pinned trusted image until a maintained project image is published. Reject missing digest, option-like strings, wrong platform/helper version. Do not invent a published image name. |
| `docker.pullPolicy` | `never`; optional `if-missing`. Pull through the host Engine only with operator authorization. Pulling must not alter the agent egress policy. Never pass registry auth to the guest. |
| `docker.runtime` | Explicit `runc`; optionally `runsc` or an operator-approved named runsc profile. This is Docker's OCI runtime name, not `runtime.mode`. Verify `/info` and startup; never silently substitute. |
| `docker.user` | Default nonzero controller effective `UID:GID` on certified rootful Linux, with mount permission checks. If controller is root, require an explicitly provisioned nonzero identity; reject UID/GID 0. Namespace mapping requires separate validation. |
| `memoryMiB`, `cpus`, `pidsLimit` | 1024 MiB, 1 CPU, 128 PIDs. Positive finite bounds; integer memory/PIDs. Set memory+swap equal to memory; do not use 0/-1 unlimited. Configure an operator ceiling. |
| `tmpfsMiB` | 128 MiB for `/tmp`; separately cap `/run` and `/dev/shm` (e.g. 16 MiB each). Reject values incompatible with memory budget. |
| `sharedReadOnly` | `true` for Docker. Explicit `false` enables account-wide writes with a warning; prompt must not invite writes when read-only. Existing Gondolin/local behavior is unchanged. |
| `network.mode` | `none` by default; optional `proxy`. No unrestricted/host/bridge mode in v1. |
| `network.allowedHosts` | `[]` = deny all in proxy mode. Arrays replace inherited arrays, including explicit empty. Start with canonical exact DNS names; reject `*`, URLs, paths, userinfo, IP literals and ports in this list. Wildcards can be a later reviewed extension. |
| `replaceSecretsInQuery` | `false`; explicit opt-in only, with no query logging. No body substitution option. |
| `lifecycle.onClose` | `remove`; optional `stop` keeps a stopped container for verified reuse. No commit option in v1. |
| `idleTimeoutSeconds` | 900; `0` explicitly disables idle reclamation. Nonnegative finite integer. Idle action is stop; bind data persists. |
| `retainedTtlSeconds` | 86400 for stopped containers; bounded, positive. TTL is for reconciliation, not a promise of autonomous cleanup while no controller/maintenance process runs. |

Keep create/start/stop/request timeouts and transport byte limits as documented internal defaults initially (see §§6–9); do not create a free-form `extraArgs`, `env`, `mounts`, `devices`, or `securityOpt` escape hatch. Require configuration changes through the trusted host, never a chat tool argument.

**Inheritance:** for each scalar, channel → account → root → default. Merge known nested objects field-by-field, not with an arbitrary deep-merge library. Arrays replace; `false`, `0` and `[]` are meaningful. Reject `null` and malformed structures. Validate the final effective combination before touching Docker. A Docker mode selected at channel scope may inherit Docker limits/image from the root even when root mode is Gondolin. Changing mode away from Docker preserves, but does not execute, stored Docker configuration.

### Secret schema compatibility

For the first implementation, reuse the existing merged `conversation.gondolinSecrets` as the **legacy configuration name** for HTTP-hook-style secrets in Docker proxy mode. This minimizes migration and preserves global/account/channel secret inheritance (`src/config.ts:43–51, 88`). Clearly relabel the UI/docs as “HTTP proxy secrets (Gondolin / Docker proxy)”; do not expose values through a generic Docker env setting.

Rules:

- Local continues rejecting this map. Docker with `network.mode: "none"` rejects a nonempty map, rather than silently ignoring or exposing it.
- Validate env names and nonempty values/host lists at resolution/startup, not just in the TUI. Disallow reserved environment keys (PATH, HOME, proxy/CA variables, loader variables, etc.).
- For Docker, secret destinations must be explicitly permitted by `network.allowedHosts`; secrets must **not** automatically widen the network policy. With v1 exact-host rules, require each secret host to be an allowed canonical exact name. Reject wildcard legacy definitions with a migration error rather than broadening them.
- Secret values remain in host policy memory/config. Only random placeholders enter exec environment. A future neutral `httpSecrets` schema needs a separate precedence/deprecation plan; do not support ambiguous duplicate schemas initially.
- `.secrets/<name>` created by `chat_request_secret` is intentionally readable plaintext for the agent. It is not covered by the “host-held secret” guarantee.

### CLI behavior

Recommend the same meaning as existing `--chat-local`, not an ambiguous connected-mode override:

- `--chat-docker`: standalone Docker tools, no messaging connection, no conversation job runtime. Uses root Docker settings, regardless of root `runtime.mode`.
- `--chat-workspace <absolute-host-path>`: applies to either standalone flag. For standalone Docker, precedence is explicit flag → root `runtime.workspaceDir` → a dedicated standalone workspace (e.g. `CHAT_HOME/docker-standalone/workspace`), **not an implicit mount of the controller's cwd or all of `/workspace`**. Configured/flag paths still undergo the mount-safety checks. Local retains its current `/workspace` default.
- Optional `--chat-docker-image <digest-ref>` overrides the root image only for standalone Docker; validate that `--chat-docker` is present.
- Reject `--chat-local` + `--chat-docker`; reject either with an explicit `--chat-conversation`. As with current local mode, an explicit standalone choice must not auto-connect a persisted conversation.
- Connected Docker is selected by config and `--chat-conversation account/channel` or `/chat-connect`, not by `--chat-docker`.
- Standalone instances need their own workspace/metadata lease, even without a conversation lock. Concurrent invocations must not share one retained container by accident.
- All invalid combinations/backend failures latch execution unavailable and restrict tools; they must not leave native host tools active.

## 5. Backend contract and module boundaries

Retain the existing contract, extending its mode union:

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

The existing factory takes a `ResolvedConversation`; standalone local deliberately constructs `LocalExecution` from a smaller path/secret object (`src/local.ts:25–30`, `index.ts:1751–1757`). Give `DockerExecution` an equivalently explicit execution-context type containing resolved Docker settings, storage/display paths, secret definitions, and a non-messaging ownership identity. A resolved conversation can supply those fields; a standalone resolver must supply them without inventing a Telegram account or acquiring a fake chat log lock. Keep standalone shared/metadata roots under `CHAT_HOME/docker-standalone/`, separate from `CHAT_HOME/local/`.

For Docker, all file operation factories return implementations, never `undefined`. `start()` is idempotent/singleflight while usable; `close()` is idempotent and terminal for that object, even when it leaves a reusable stopped container. Internal idle stop is **not** `close()`.

A small optional extension is justified for orchestration:

- `holdActivity?(): () => void`: acquire a synchronous lease that prevents idle stop, returning an idempotent release. Operations acquire their own leases. A turn-level lease prevents stopping the container during model thinking or outbound attachment delivery.
- `getStatus?()`: return a sanitized value object for status rendering. Do not expose the Docker client, proxy, raw inspect data, or VM handle to `index.ts`.

Keep these optional so existing backends need not implement idle behavior. Alternatively implement an equivalent coordinator, but do not make the backend read global `chatTurnInFlight` state. Wire remote dispatch and standalone agent lifecycle separately and release on **every** terminal/error/shutdown path. Pi tools may execute concurrently; serialization must be explicit, not assumed from conversational jobs.

Use an injectable, small Docker client abstraction for tests. A direct Engine HTTP client over a Unix socket is sufficient; a maintained library is also acceptable after dependency review. If using direct HTTP, implement API negotiation, hijacked stream parsing, abortable deadlines, JSON size limits, and typed errors; do not claim a few `fetch()` calls cover exec streaming. No shell interpolation of mount paths, container names, or IDs. If a CLI prototype is used, use argv-based `spawn`, an explicit daemon endpoint/minimal environment, and replace it or fully test its error/cancellation semantics before release.

Do not import Gondolin merely to obtain the network hooks in Docker mode. Either use a narrowly reviewed helper that does not load VM code, or implement the limited compatible substitution behavior with attribution and ported tests. A standalone host proxy must still implement the networking machinery that Gondolin's stack supplies around those hooks.

## 6. Container lifecycle and ownership

### State machine

```text
new -> starting -> ready <-> idle-stopped
           |         |           |
           +------> failed <------+  (unexpected loss / policy failure)
                      |
any nonterminal -> closing -> closed
```

Internally track generation, start/close promises, active/queued operations, turn leases, idle deadline, proxy state, owned container ID, and cancellation/reset state. A generation fence prevents a late create/start response from publishing readiness after close/replacement.

### Preflight and create/start sequence

1. Resolve and validate config, mount separation, ownership, and the selected image/helper contract. Acquire conversation or standalone lease. Docker daemon access is trusted controller authority, never guest authority.
2. Connect to an explicitly approved **local Unix socket**. Query Engine version/info; verify Linux, required resource/security support, chosen runtime, and accepted API version. Do not blindly obey `DOCKER_HOST`, `DOCKER_CONTEXT`, or TLS variables inherited from the pi process. If rootless is enabled, select its approved socket explicitly.
3. Inspect the pinned image, architecture, entrypoint/helper version, declared volumes, and image env. Pull only if explicitly configured. Reject undeclared writable/anonymous volume effects and unexpected entrypoints; do not inherit image credentials or unsafe loader variables.
4. Reconcile only this conversation's managed metadata/resources (the reuse/reconciliation subsection below). Never adopt an arbitrary same-named container.
5. For proxy mode, initialize host policy and private proxy socket/public CA directory before starting the container. Keep CA private key and secret table outside every mount.
6. `POST /containers/create` with exact structured settings (§10), unique generation name, and labels: managed-by, deployment/controller identity, conversation hash, schema version, immutable config fingerprint. Labels must contain no secret values. Store the returned ID immediately for cleanup.
7. `POST /containers/{id}/start`; then inspect and run bounded readiness probes: expected helper, bash, non-root identity, writable workspace, shared write/read-only behavior, enforced security settings, and proxy relay availability. Do not execute `apk add`/`apt install` at startup.
8. Write private session metadata atomically and publish `ready` only after probes pass. On any failure close proxy, stop/remove the just-created container, report cleanup failures, and retain a tombstone if resource state is uncertain.

Suggested deadlines: 10 seconds per control request, 120 seconds for authorized image pull, 30 seconds for create/start/readiness as a whole, 10 seconds stop grace plus a bounded force-removal deadline. These are proposed defaults, not measured performance. Separate exec lifetime timeout from Engine HTTP control deadlines; a long valid exec must not be cut off by a 10-second request timer.

Suggested metadata under `<conversationDir>/docker/` (never under the mounted workspace):

```text
session.json          # container ID, deployment/conversation identity, image ID/digest,
                      # config fingerprint, state, timestamps; no secret values
outgoing/             # private attachment copies
execution.jsonl       # bounded/rotated structured audit
proxy-public/         # only proxy.sock + public CA bundle; the only extra bind mount
proxy-private/        # optional private CA material; never mounted
```

Use directory mode 0700/file mode 0600 for private material. Proxy-public directory/socket permissions must explicitly allow the mapped guest identity without opening it to other host users. A directory mounted read-only can still contain a connectable Unix socket: read-only mounting does not remove the socket's authority.

### Exec and output transport

- Create exec with `POST /containers/{id}/exec`: `Cmd` argv, fixed `User`, validated `WorkingDir`, `Tty: false`, stdout/stderr attached; stdin only for file/helper payloads. Start with `POST /exec/{execId}/start`, attached/non-detached; inspect `/exec/{execId}/json` for `Running`/`ExitCode` after stream completion.
- Bash argv: `/bin/bash --noprofile --norc -c <command>`. Bash is an intentionally untrusted interpreter **inside** the container; the host must never evaluate the command.
- Ignore `options.env` as a bulk inheritance source. Build a clean exec environment: fixed PATH/LANG, `HOME=/workspace`, TMPDIR, explicitly configured proxy/CA variables and secret placeholders only. Ensure inherited image env cannot reintroduce credentials, `BASH_ENV`, `ENV`, `LD_PRELOAD`, etc.; use a trusted helper/`env -i` launch path as necessary.
- Non-TTY Engine output is multiplexed: an 8-byte frame header (stream byte, three reserved bytes, big-endian payload length) followed by bytes. Parse across arbitrary chunk boundaries, enforce frame/buffer limits, preserve binary bytes, and forward both stdout/stderr through `onData(Buffer)`. Never decode bytes as JSON or assume one network chunk = one frame.
- Stream EOF alone is not success. Inspect the exec with a deadline and drain all output before settling. Nonzero guest exit is a normal operations result `{exitCode}`; transport/start/daemon errors reject. Do not label every exit 137 as OOM—correlate inspect/events/cgroup evidence.
- `docker logs` is the PID1 log, not a replacement for attached exec output. Keep PID1/relay logging separate and bounded.

### Cancellation, timeout, and close

Docker has exec create/start/inspect endpoints, not a general exec kill endpoint. Closing the HTTP stream or killing a local `docker exec` client does **not** prove the container process stopped.

Use a conservative v1 policy:

1. Serialize agent exec/file transactions per container (or define explicit cancellation coupling if parallelism is added). Check pre-aborted signals before creating an exec; recheck after listener registration and at every async start boundary.
2. On bash abort/timeout, prevent new work in that generation, revoke its active proxy connections, and stop/kill the **whole container**. Await confirmation that it is not running. Escalate from short grace to kill/force removal when needed.
3. Mark all affected operations aborted; do not report their success because their stream happened to end. Emit exactly `Error("aborted")` or `Error("timeout:<seconds>")` at the `BashOperations` boundary so pi's existing formatter works.
4. A later, separately requested tool may start a clean process generation after verified shutdown. Never automatically replay the cancelled/uncertain command. Bind-mounted side effects are not rolled back; say so.
5. If shutdown cannot be confirmed because the daemon vanished, leave the backend failed and retain cleanup metadata. Do not start a second writer or enable local tools.

Whole-container cancellation kills detached descendants/`setsid` daemons as well, but also kills intentional background services. This trade-off must be documented. A later per-exec supervisor/cgroup design can improve it only with tests proving descendant termination; process-group kill alone is not sufficient for hostile commands.

`close()` cancels timers, rejects queued/new work, waits for an in-progress start to either finish cleanup or be fenced out, revokes proxy capabilities, and stops/removes resources according to `onClose`. Repeated closes are harmless. Closing during create must not leak a container whose ID arrives late. Keep deadlines on all cleanup; report failures rather than swallowing them solely via the existing `.catch(() => undefined)` paths in `index.ts`.

### Reuse, retention, idle reclaim

| Mechanism | What survives | What does not | Recommendation |
| --- | --- | --- | --- |
| Same running container | Processes, tmpfs, mounts, root layer | Nothing inherently | Reuse during a connection. |
| `stop` then `start` same ID | Container config and writable layer if one exists; bind data | Running processes, exec sessions, live network streams; tmpfs contents | Supported idle/reconnect optimization; rerun entrypoint and readiness checks. |
| Remove then recreate pinned image | Bind data | Root-layer changes, tmpfs, process state | Default close behavior. Most reproducible with read-only rootfs. |
| `docker commit` then recreate | Image changes from writable container layer | Bind/volume contents and live memory/process state | Not v1; not useful for installing OS packages under the default read-only/non-root policy. |

A stopped container is not a suspended process. Docker exec commands do not restart with the container. `pause` is not idle memory reclamation and is not the proposed idle action.

Idle timer design:

- Use monotonic time; start the deadline only when no turn lease, operation, queued operation, file transfer, or active proxy request exists. Status polling does not count as activity.
- Acquire an operation lease **before** checking/start-waking the container. Serialize wake vs idle stop; never stop between an operation's readiness check and its exec creation.
- At expiry, recheck under the lifecycle lock and stop; close proxy upstream connections. Keep the object `idle-stopped`; next actual operation calls readiness/wake. Do not disconnect the live messaging adapter or release the conversation log lock.
- Background guest processes do not keep the lease alive indefinitely. The documented idle policy may terminate them. Apply connection/request lifetime caps so a hanging proxy request cannot pin a container forever.
- After a stopped-container TTL, safe reconciliation removes only owned containers. Bind data must not be deleted. A worker can run a periodic sweeper; global cleanup when all workers are down needs a separately invoked maintenance task, not an imaginary always-running timer.

For `onClose: "stop"`, a new owner may reuse only an inspected **stopped** container after acquiring the lease and comparing deployment identity, conversation identity, image ID/digest, canonical mounts, user, OCI runtime, hardening, helper version, and effective non-secret config fingerprint. An ID in `session.json` is only a hint. Changing limits/mounts/image/policy should recreate rather than patch an unknown subset of settings.

Generate placeholders afresh for each controller/proxy generation and inject them at exec time, not into immutable container `Config.Env`. A restarted worker must reconnect/rebuild its proxy and relay and revalidate the public CA/socket mount. Old placeholder strings persisted by the agent are invalid and should produce a clear denial, not silently authenticate. Close connection pools on policy/secret rotation. Secret-bearing config hashes in labels can leak via dictionary guesses; keep fingerprints secret-free, or use a host-private keyed value where comparison requires secret revisions.

Orphan reconciliation must use both ownership labels and a live-owner/lease check, not a sanitized name or stale timestamp alone. The existing PID-based channel lock is useful (`src/log.ts:166–194`) but is not a multi-host lease. A running orphan should be stopped before adoption; never reconnect to potentially still-active execs. If ownership is uncertain, fail with operator instructions. Do not run broad `docker system prune` or delete arbitrary images/volumes.

If commit-based reuse is later requested, make it a separate unsafe/writable-root profile with explicit operator approval, image quotas/TTL, no automatic push, quiescing, reapplication of all create-time hardening, and secret/credential residue review. Prefer rebuilding a reviewed Dockerfile to preserving an agent-mutated root layer.

## 7. File operations and pi output integration

### Execute filesystem access inside the container

Mirror Gondolin's tool-visible restriction to `/workspace` and `/shared`, not local mode's unrestricted host paths. Normalize POSIX relative paths against `/workspace`; reject empty/NUL paths, lexical traversal outside either root, and prefix lookalikes such as `/workspace-other`. Absolute container root paths outside these mounts are not accepted by the file tools in v1. Bash can still read ordinary image files inside its container; this policy is not meant to restrict bash to two directories.

Use the trusted image's file helper through exec:

- `readFile`: returns raw bytes as a Buffer, bounded before host accumulation; verify regular file, reject FIFO/socket/device reads and over-limit files.
- `access`: read operation checks readability; edit operation checks read/write permission and shared read-only policy. Do not let `access` success stand in for checks at the actual open.
- `writeFile`: send UTF-8 content via stdin with a length limit; never interpolate it into shell text/argv/base64 command lines. Set explicit permissions for new files. Prefer temporary sibling + atomic rename where compatible with the edit contract; preserve existing file mode intentionally.
- `mkdir`: recursive creation inside the approved root, without following escaping intermediate links.
- `detectImageMimeType`: return supported image MIME or null, using bounded sniffing or the existing extension-based behavior; never return fabricated image data or accidentally use host `file` on a guest path.
- Edit uses pi's existing exact-replacement implementation with Docker read/write/access operations; do not implement a new text-matching algorithm.

The file helper must enforce descriptor-relative containment, not only `realpath()` followed by a separate pathname open. For a Linux baseline, use `openat2`-style beneath/no-magic-link constraints or an audited fd-relative no-symlink component walk; fail rather than weaken if the chosen runtime lacks the required primitive. Define whether in-root symlinks are supported. A reasonable v1 contract rejects symlinks in file-tool path components and leaves normal in-container symlink use to bash. Test this under runsc as well; it is a support gate, not assumed syscall parity.

The operation types are precise: read/edit `readFile(path)` returns `Promise<Buffer>`; write/edit `writeFile(path, content: string)` returns `Promise<void>`; access/mkdir return `Promise<void>`. Bash `exec(command, cwd, {onData, signal?, timeout?, env?})` returns `Promise<{exitCode: number | null}>`, and `timeout` is in **seconds**. File-operation callbacks themselves have no AbortSignal parameter in the inspected pi contract: enforce backend-owned deadlines (e.g. 30 seconds plus bounded transfer time), and propagate backend shutdown cancellation. An unknown/missing Docker exit status is an error, not `null` success.

Serialize the **complete** Docker tool invocation, especially edit's read–modify–write sequence, at the delegate/transaction layer; serializing individual helper exec calls is insufficient. Avoid recursively taking the same non-reentrant lock inside operations. This does not prevent an intentionally backgrounded bash process from changing a file; document that limit.

Helpers are not a new security boundary against the container user—the user can invoke them directly—but ensure the controller does not accidentally turn a file tool into a host operation. Runtime secrets are not passed through this helper protocol unless explicitly intended to become guest-readable.

Do not default to `docker cp`/archive extraction for every operation. It brings archive/symlink/device validation and ownership issues and can bypass the intended guest user semantics. If using Engine archive APIs for a specific operation, treat all returned tar entries as hostile: reject traversal, links, special files, multi-entry surprises, and oversized lengths; never extract an arbitrary guest archive into host storage.

### Existing bash spill-file trap

The installed pi bash tool writes truncated/full output on the **host**, even with custom `BashOperations`: `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/bash.js:19–22, 207–258, 269–293`. Simply returning Docker operations therefore produces a `fullOutputPath` that `/workspace`-restricted read cannot read. Large-output behavior must be part of implementation, not dismissed as a Docker detail.

At the bash delegate/result integration point (`index.ts:554–558, 1708–1715`), supply an explicit solution:

- Prefer an execution-aware output collector/wrapper with a bounded private spool and a guest-visible copy under `/workspace/.pi-chat-output/`, retaining pi's tail truncation and error semantics.
- If wrapping pi's current tool, migrate only spill files tracked as created by that invocation, after their stream finishes, through a safe file bridge. Rewrite both model-facing text and structured `details.fullOutputPath`, including partial-update and nonzero-exit paths. Never parse an arbitrary “Full output:” string from command output and read the named host file.
- Cap total forwarded/spooled output (e.g. 16 MiB per exec) and terminate on excess with an explicit output-limit error. Pi's display truncation alone is not a disk/memory quota. Respect backpressure before accumulating unbounded buffers.
- Do not mount host `/tmp` into the container to solve this. Do not relax file operations to read arbitrary host temp paths.

Test binary chunk handling, large single lines, >2,000 lines, Unicode split across chunks, stream errors, callback errors, final file flush, and recovery/readback of the advertised output path. Choose one collector strategy before coding; verify it against the installed pi API rather than modifying dependencies in place.

## 8. Mounts, host bridges, and residual risks

### Mount layout

| Container destination | Host source | Default access |
| --- | --- | --- |
| `/workspace` | `conversation.workspaceDir` | read/write, dedicated to this trust domain |
| `/shared` | `conversation.sharedDir` (`<accountDir>/shared`) | read-only in Docker; explicit opt-in write |
| `/run/pi-chat-proxy` | only this generation's proxy-public directory | read-only; only policy socket and public CA bundle |
| `/tmp`, `/run`, `/dev/shm` | bounded tmpfs | writable scratch; no host bind |

Specify bind propagation `rprivate`; disable recursive submount inclusion where supported (Engine bind `NonRecursive`, or CLI `bind-recursive=disabled`). Otherwise detect/reject unexpected submounts. Read-only rootfs is **not** read-only bind storage. Older kernels' recursive read-only behavior differs; do not assume nested mounts become read-only automatically [D5]. Inspect the resulting mounts.

Mount sources are interpreted on the **daemon host**, not the CLI/client host [D5]. Reject unapproved remote endpoints. Canonicalize sources and verify they do not include/overlap private controller metadata, config, Docker sockets, `/`, host home, `/proc`, `/sys`, credential directories, or another conversation's private storage. The legitimate workspace-under-conversation layout is allowed only for the designated workspace child, not the whole conversation directory. Reject workspace/shared overlap that could bypass a read-only `/shared` through another writable alias. Do not recursively chown arbitrary user directories to make startup pass. Preexisting hardlinks to sensitive host files also defeat a purely pathname-based boundary; use dedicated storage without such aliases (ideally a separate filesystem/quota domain), not a reused privileged worktree. A no-symlink check cannot prove a file has no outside hardlink.

### Writable data is an intentional escape route for host consumers

A bind mount confines namespace access but exposes its contents intentionally. An agent can modify `.git/hooks`, `.git/config`, `.envrc`, package scripts, CI files, prompt/skill files, and other files a human or host tool later executes. Treat workspace output as untrusted. In particular `spawnConversationTmux()` launches pi with the workspace as cwd (`index.ts:387–419`); host project discovery/extensions must not automatically execute agent-authored content. Run dedicated trusted workers and configure pi project trust/resource loading appropriately. Container isolation does not sandbox subsequently loaded host extensions.

Do not claim that file-tool filtering protects against bash writing the same mounted paths. Fine-grained deny-write paths need filesystem/mount enforcement, a broker, or a reviewed worktree/export workflow. Those are optional hardening beyond the basic two mounts, not a substring check in `writeFile()`.

Avoid placing **any host service Unix socket** in workspace/shared: network-none does not block access to a Unix socket exposed via the filesystem. Inventory existing special files and require a dedicated directory not shared with host services; enforce this operationally because a startup scan alone cannot prevent later host-created sockets. Never mount Docker/containerd/SSH-agent sockets, even “read-only.” The only deliberate socket capability is the narrowly scoped egress proxy.

### Host-side bridges need their own containment

`safeReadMountedText()` (`index.ts:169–186`), directory initialization, downloads/materialization (`src/log.ts:41–68, 200–227`), runtime secret writes (`src/secrets.ts:45–54`), and export (`index.ts:973–984`) still touch host paths. A malicious container can create absolute symlinks which resolve innocuously in its namespace but point at sensitive files when the host follows them.

Before claiming safe hostile-workspace operation, audit/harden these bridges with directory-fd/no-follow traversal and regular-file checks, including **intermediate** components. `O_NOFOLLOW` on only the final file after an earlier `realpath()` is not a complete TOCTOU defense. Host secret writes currently use normal `mkdir/chmod/writeFile`; a simple filename regex does not protect a replaced `.secrets` directory or preexisting target symlink. Directory bootstrap runs again on log appends, so this is not only a first-start issue.

Non-root UID design must cover both directions: host downloads and 0600 runtime secrets must be readable by the intended guest; guest-created files must remain manageable by the controller. Test rootful same-UID, rootless and remapped profiles separately. Do not solve permission mismatches with `chmod 777`, guest root, or recursive chown. Shared plaintext secrets are visible to every identity with access; keep channel secrets out of `/shared`.

### Attachment staging

Docker `stageAttachment()` should obtain bounded bytes from the safe in-container file helper (only `/workspace` or `/shared`, regular file) and write a new exclusive 0600 host file under private `docker/outgoing/`. This avoids following a guest-authored symlink using host path semantics. Apply a configurable/internal attachment size cap (e.g. 50 MiB, additionally respecting adapter limits), stream rather than read an unlimited file, and clean failed partial copies. Use random names and a sanitized basename. Do not send directly from the writable bind source after validation: it could change before adapter upload.

Return the staged host path to `index.ts:1331` only. Keep staging alive through send/retry/cancellation resolution, then apply a bounded retention policy. Never expose the staging directory as a mount. Stable staging prevents path substitution, but a file being edited during copying can still produce an inconsistent snapshot; either document this or coordinate file mutation while copying.

## 9. Egress proxy and secret placeholders

### Recommended enforced topology

Use **network-none plus a single Unix-socket proxy capability** for the initial Linux implementation:

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

The image entrypoint starts/reaps the loopback relay without capabilities. Clients use explicit proxy variables (upper/lowercase as needed), with empty `NO_PROXY`; deleting these variables just makes direct Internet access fail. The container only has loopback [D4]. It cannot reach host loopback, DNS, LAN, metadata endpoints, other containers, or the Internet through an IP route. Raw sockets/capabilities and host socket mounts remain forbidden. A guest may bypass/kill its relay or connect directly to the exposed Unix proxy, but it still reaches only the same host-enforced policy; availability inside its own container is not a protected asset.

This topology avoids privileged host firewall programming in pi-chat and Docker's embedded DNS escape surface. It requires a supported local Linux socket bind and tested runtime behavior. Readiness must fail if the relay/proxy transport is unavailable; never attach a bridge network as fallback.

**gVisor qualification:** `--runtime=runsc` alone is not enough for this topology. Current upstream runsc defaults `host-uds` to `none`; `host-uds=open` allows connecting to exposed host sockets [G2]. An operator must register a dedicated reviewed runtime profile (or configure `runsc`) permitting open, not create/all, and run the E2E matrix. pi-chat must not edit `/etc/docker/daemon.json` or restart Docker automatically. This broadens access to any host socket in allowed mounts, reinforcing the dedicated-directory requirement in §8. Check the installed runsc version, not just upstream `master`. `network.mode: "none"` without proxy does not require host-UDS access.

Alternative: a per-conversation internal bridge plus a dual-homed trusted proxy sidecar can support platforms without socket binds. It is **not** the initial fallback. Docker documents that an internal network can still reach its gateway/appropriately configured host services [D3]. Such a design needs externally enforced host/peer/DNS/IPv6 isolation, a non-forwarding proxy with no agent membership on its uplink, and a fresh security review. Merely `--internal` + `HTTPS_PROXY` is insufficient.

### HTTP(S) processing sequence

Build or integrate a maintained, reviewed HTTP proxy/TLS-interception component, not an improvised raw string parser. The host endpoint is part of the trusted computing base and parses attacker-controlled bytes.

1. **Identify conversation by socket/listener binding**, not a guest-supplied account header. Separate policy contexts, CA authority, placeholder maps, DNS caches and connection pools. Bind only the private Unix socket; never `0.0.0.0`.
2. Enforce connection/header/body/response/concurrency/deadline limits before buffering. Suggested initial bounds: 32 KiB headers, 32 concurrent requests, 16 MiB request body, 64 MiB response body, bounded TLS/header/idle/total durations; document incompatibility with larger downloads and allow only operator-reviewed changes. Stream bodies with backpressure; abort both sides when a client closes.
3. Parse absolute-form HTTP requests and CONNECT authorities strictly. v1 accepts HTTP port 80 and HTTPS port 443 only. Canonicalize DNS hostnames (IDNA, case, one consistent trailing-dot rule); reject malformed authority, userinfo, IP literals/ambiguous numeric hosts, alternate ports and unsupported schemes. Hostname policy is applied before resolving denied hosts, preventing arbitrary DNS-label exfiltration.
4. For CONNECT, check allowed hostname/443, then terminate client TLS using a per-conversation CA. **Do not provide a blind TCP tunnel**, even to an allowed hostname: that prevents secret substitution and permits non-HTTP bypass. Require consistent CONNECT authority, SNI, HTTP Host/authority and inner request URL; reject disagreements. Negotiate only implemented protocols (HTTP/1.1 initially). Deny websocket upgrades, CONNECT-inside-CONNECT, generic TCP, HTTP/3, certificate-pinned clients, and mTLS workflows unless separately supported.
5. Mount only the public CA/bundle. Provide trust settings for supported clients (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, etc. as applicable). Do not disable TLS verification or mount the CA private key. The proxy independently verifies the real upstream certificate against the real hostname/SNI.
6. Authorize the final canonical URL, method and port. v1 can allow normal HTTP methods except CONNECT/upgrade outside the proxy handshake; future path/method restrictions are useful for high-value APIs. Strip hop-by-hop headers and proxy credentials; reject malformed duplicate framing, conflicting Content-Length/Transfer-Encoding, CR/LF injection and request smuggling.
7. Resolve on the host via the proxy's resolver. Deny loopback, private, link-local, unspecified, multicast, reserved/non-global ranges, cloud metadata and host/container subnets, for both IPv4 and IPv6 including mapped addresses. No internal-host exception in v1. Gondolin's inspected private-address helper is narrower than a full non-global-range policy; do not overstate or blindly copy it.
8. Pin the actual upstream connection to the validated address while preserving TLS SNI/cert verification for the hostname. Literal IPs need explicit rejection/checks because a DNS callback may never run for them. Every new connection/retry/redirect must use the checked connector; no default `fetch()`/global-agent path around it. Bound DNS cache lifetime and prevent cross-policy connection-pool reuse. Handling mixed public/private DNS answers must be explicit (conservative v1: reject the answer set).
9. Replace supported placeholders only after final destination validation. Request body bytes pass unchanged, under size limits. Check the substituted request again for secret-host violations where relevant. Authenticate upstream over HTTPS only: **never inject a secret into plain HTTP** even if the host is allowed.
10. Prefer not following upstream redirects in the proxy: return 3xx to the client, which sends its next request back through policy. This avoids replaying streaming bodies. If server-side following is later implemented, use manual bounded hops, validate every destination/IP, strip cross-origin credentials/cookies, and enforce per-secret host checks after rewrites. Never use automatic `fetch` redirect following with already-substituted headers.
11. Return bounded response streams and sanitized errors. Do not echo substituted request headers/URLs in exception text. No caching of credential-bearing responses by default.

The proxy must fail closed even without secrets: policy enforcement does not depend on a nonempty secret map. Proxy crash/unreachable means requests fail, not direct networking. Closing a conversation or changing its policy revokes existing proxy connections as well as future requests.

### Substitution contract and limitations

- Generate unguessable per-context placeholders (`GONDOLIN_SECRET_<48 hex>` is the inspected reference format; a Docker-specific prefix is fine). Bind each to secret name, value, permitted host(s), conversation and generation. Host values never enter Docker create/exec JSON, labels, argv, container files, or logs.
- Replace complete known tokens within header values (e.g. `Authorization: Bearer $TOKEN`), including Basic auth decode/replace/re-encode. Deny tokens sent to the wrong host; do not leave them silently unmodified. Remove proxy-auth headers from upstream forwarding; proxy identity is not an upstream API credential.
- With explicit opt-in only, replace parsed query parameter names/values with proper URL encoding. Do not substitute raw URL paths, arbitrary encoded bodies, compressed payloads or signed requests. HMAC/signature computation and tools requiring plaintext secrets are incompatible with this mechanism.
- Unknown/stale placeholder-prefix tokens should produce a sanitized denial. No wildcard “replace anything that looks like a token.” Scope/cache ownership must prevent another conversation from using a token.
- Exact host permission does not limit API actions: a compromised agent can use an allowed token to mutate resources or exfiltrate through that API. Prefer fine-grained, short-lived, read-only credentials and optional method/path restrictions.
- An allowed upstream can echo a credential in its response, or transform it into data the agent can read. Gondolin's default hooks do not supply a universal response-secret scrubber. Do not promise that values can *never* reach the guest: the guarantee is “not directly provisioned into the guest; only injected into authorized upstream requests.” Bounded exact-value response/header redaction can add defense in depth, but encoding/streaming/semantic transformations defeat general redaction. Do not add an echo service as a trusted production destination.
- All allowlisted services remain potential data-exfiltration destinations. Host allowlisting is not data-loss prevention.

### Minimum proxy test vectors

Port the **behavior**, not just names, from `G/host/test/http-hooks.test.ts:444–685`: Bearer, Basic auth, wrong host, already-real secret on disallowed destination, rewritten destination, query off/on. Add Docker-specific deny-empty/deny-wildcard behavior, no automatic host expansion, HTTPS-only injection, cross-conversation/stale tokens, duplicate headers, hostname canonicalization, CONNECT/SNI/Host mismatch, IP literals/mapped IPv6, rebinding on actual connect, redirects, body untouched, TLS validation failures, connection pooling after policy rotation and all byte limits.

## 10. Security-hardening defaults

Use structured Engine fields. The equivalent flags below are explanatory; they are not an instruction to execute a partially specified container now.

| Control | Required setting / validation |
| --- | --- |
| Capabilities | `HostConfig.CapDrop: ["ALL"]` (CLI `--cap-drop=ALL`); no additions. No `CAP_SYS_ADMIN`, `NET_ADMIN`, `NET_RAW`, or `SYS_PTRACE`. |
| Privilege | `Privileged: false`; `SecurityOpt` includes `no-new-privileges:true` (CLI `--security-opt=no-new-privileges`). Do not allow privileged exec overrides. |
| User | Numeric, nonzero `Config.User`; same user on every exec; no supplementary privileged groups. No sudo/setuid dependency. |
| Root filesystem | `ReadonlyRootfs: true`. Image supplies bash, CA/client tooling and helpers ahead of time. Package installation occurs in reviewed image builds, or unprivileged language environments in workspace. |
| Scratch | Size-bounded `/tmp`, `/run`, `/dev/shm`; `nosuid,nodev`, preferably `noexec` on tmpfs. Build in workspace if execution is needed. `noexec` does not prevent an interpreter reading a script and is not a general execution ban. |
| PIDs/memory/CPU | `PidsLimit: 128`, `Memory: 1073741824`, `MemorySwap: 1073741824`, `NanoCpus: 1000000000` for proposed defaults. Confirm enforcement/support, not only successful JSON serialization. Keep OOM killer enabled. |
| File descriptors/core | Bounded `nofile` (e.g. 1024) and `core=0`; do not dump credentials in host core files. Avoid UID-wide `nproc` assumptions as a substitute for container PIDs limits. |
| Network | `NetworkMode: "none"`; no publish/all-ports, extra host aliases, links, network joins, or host network. Proxy is only the specified Unix capability. |
| Namespaces/devices | Private PID/IPC/cgroup namespaces where supported. No host PID/IPC, namespace joins, arbitrary devices, writable cgroups or host `/proc`/`sys` mounts. Preserve Docker's masked/read-only system paths. |
| Seccomp | Retain Docker's default seccomp or an explicitly reviewed stricter profile. Never `seccomp=unconfined`. Verify daemon configuration/support; newer `seccomp=builtin` syntax is not assumed supported by every Engine version. |
| LSM | Retain enforcing AppArmor/SELinux where available; no blanket `label=disable`/unconfined workaround. Provision labels/permissions on dedicated mounts, never relabel an entire host home for convenience. |
| Init/entrypoint | Trusted non-root supervisor or Docker `Init: true` plus a controlled long-lived entrypoint, with signal forwarding and child reaping. No arbitrary image entrypoint execution before validation. |
| Restart/retention | `RestartPolicy.Name: "no"`; controller owns restart. `AutoRemove: false` with explicit bounded removal, permitting inspect/reuse/reconciliation. Do not combine automatic removal with stopped-container reuse. |
| Logs | Bounded daemon log driver options or disabled PID1 logs if unnecessary, plus separate redacted lifecycle audit. Exec output is separately bounded. |
| OCI runtime | Explicit approved name; runsc requires installed operator-managed runtime and support tests. Missing runtime/security feature is an error, not a reason to use weaker settings. |

A rootful Docker socket is highly privileged host authority. Keep it available only to the controller, outside all guest mounts. Membership in the Docker group is not an unprivileged security boundary. Rootless/user namespaces reduce some risk but do not eliminate bind-mount poisoning, proxy vulnerabilities, or host-consumer risks. runc shares the host kernel; gVisor interposes a userspace kernel and changes compatibility/performance, but does not make mounted data safe or replace egress policy.

Memory/CPU/PID limits do **not** bound bind-mount disk usage, daemon image storage, host logs, or proxy/controller memory. Add independent workspace/staging/log/image budgets and retention; use filesystem quotas for a hard disk bound when supported. Free-space polling is only best-effort. Restrict simultaneous container startup and total per-host capacity; per-container caps alone can still exhaust a host with many workers.

## 11. Error handling, observability, and privacy

### Error taxonomy

| Failure | Required behavior |
| --- | --- |
| Invalid config / missing image/runtime / daemon unavailable | Error names the failing setting/capability and safe remediation. Fail before attaching an adapter or exposing host fallback tools. |
| Create succeeded, start/readiness/metadata write failed | Clean only the owned generation; preserve original error plus sanitized cleanup warning. Track uncertain resources for later reconciliation. |
| Permission failure on bind / runtime secret | Report expected mapped UID and path category, not secret contents; no auto-chown/chmod-to-world/root escalation. |
| Exec command exits nonzero | Return exitCode from operations; pi formats a tool error. This is distinct from Docker API failure. |
| Abort/timeout/output cap | Terminate container generation as specified; no replay; report possible persisted filesystem side effects. |
| Daemon disconnect mid-exec | Outcome is unknown, not success. Verify/stop later before reuse. Never automatically retry a side-effecting command. |
| OOM/container exit | Capture inspect/events if available, sanitized reason and last lifecycle state; fail active execution and require verified restart. |
| Egress denied | Stable category (host/IP/protocol/secret-host/size/TLS), sanitized host/port only. No headers, query, body, placeholder or real credential in user-facing error. |
| Close fails / daemon offline | Bound the wait, report retained container ID/cleanup requirement privately, keep ownership metadata; do not pretend cleanup completed. |
| Stale metadata / ownership mismatch | Fail or remove only after verified ownership; never delete unrelated containers on name collision. |

No operation should leave an unhandled rejection, unbounded timer, leaked stream or reusable “ready” object whose container is gone. Retry bounded, idempotent inspect/readiness calls where justified. Container create/start timeouts require reconciliation by owned identity because the server may have completed the request after the client timed out.

### Logs and status

Use structured events on stderr (`[pi-chat docker]`, `[pi-chat docker-egress]`) and a private rotated audit stream. Fields: conversation/deployment ID, generation, short container/exec ID, event, monotonic duration, exit code, bytes, policy decision category, canonical host/port, runtime/image ID, resource state and cleanup result. Correlate with job/tool call IDs through integration hooks where available; do not falsely imply backend `BashOperations` receives a job ID today.

Do not log full config, raw Docker inspect/env, full command lines by default, request/response bodies, query strings, auth/cookies, CA private keys, placeholders or secret values. Commands can contain user-supplied plaintext secrets too; full command auditing is an explicitly protected opt-in, not the default. Even canonical hosts and file paths may be private. Sanitize exceptions **before** writing logs, status, session messages or remote replies. Redaction is defense in depth, not permission to dump entire requests.

The current conversation record union has no backend lifecycle event (`src/core/runtime-types.ts:86–99`); `ConversationRuntime.appendError()` uses existing `error` records (`src/runtime.ts:297–299`). Keep detailed backend telemetry separate; optionally append summarized failures via runtime. Do not inject arbitrary new JSONL record types without updating readers/types/tests. Healthy idle stop is not a job failure or adapter disconnect.

Status should distinguish `starting`, `ready`, `idle-stopped`, `failed`, `closing`, `closed`; show backend `docker`, OCI runtime, image digest, read-only shared state, network policy summary, idle deadline and last cleanup issue. Worker liveness and container liveness are different. The existing 15-second worker status loop should not keep containers artificially active.

## 12. Testing plan

Write the implementation and tests completely, then run the full validation/E2E sequence. Do not claim real runtime coverage from mocks. The tests below are release criteria, not results already obtained.

### Unit and integration tests without Docker

Recommended new files: `tests/docker-config.test.ts`, `tests/docker.test.ts`, `tests/docker-egress.test.ts`, and focused extension-integration tests with a fake pi API. Keep test names/paths out of real chat storage using `tests/helpers.ts`.

1. **Config:** legacy default; each inheritance level; nested partial overrides; empty list/false/0 semantics; invalid null/types/limits/UID/image/host names; secrets-with-network-none error; no implicit secret-host expansion; correct paths; no Docker import/probe in local/Gondolin paths.
2. **Create spec:** snapshot/assert all mandatory hardening, limits, mounts, user, runtime and clean env. Reject extra/recursive/sensitive mounts, labels with credentials, image volumes/env/entrypoint violations and unsupported security capabilities.
3. **Lifecycle:** singleflight start; repeated close; close before/during create/start; late success after close; partial failure at every await; bounded daemon outage; external removal; stale/mismatching metadata; running orphan; another live owner; retained-container adoption. Confirm no accidental host fallback.
4. **Idle:** fake clock; no stop during any lease/queued transfer; one stop on expiry; status does not renew lease; concurrent wake/start; disconnect cancels timer; background work terminates according to policy; stopped TTL only removes owned resources.
5. **Exec:** fragmented multiplex headers/payloads, stdout/stderr, binary/UTF-8 boundaries, malformed/oversized frames, stdin backpressure, EOF-before-exit, nonzero/null/unknown exit, pre-abort/start-race/mid-output abort, timeout, onData failure, output cap. Assert actual stop/kill API calls, not just rejected Promise.
6. **Files:** normal text/image read, multi-edit behavior through real pi factories, mkdir/write, quotes/newlines/leading-dash filenames, traversal/prefix lookalikes, parent/final/dangling symlinks, hardlinks, special files, read-only shared, size cap and interrupted copy. Test host bridge symlink-swap defenses separately.
7. **Output integration:** truncated stdout path is guest-readable; partial/final/error result paths agree; forged output cannot trigger host reads; host spool is bounded and cleaned safely.
8. **Proxy:** pure policy/substitution tests from §9; loopback/Unix HTTP fixtures for parser/TLS/limits with fake DNS/connector; no network call for denied host. Test that the **actual connector** cannot select a denied IP, not merely that preflight resolution rejected one.
9. **Index integration:** standalone flag conflicts/persisted session; runtime selection; no QEMU preparation for Docker; connected-start failure latch; no two Docker generations during restart; disconnect/shutdown; allowed tools; accurate prompts; turn leases released on every `agent_end` branch and dispatch/send failure; unchanged failed-job boundary.
10. **Privacy:** sentinel real secrets/placeholder strings never appear in fake Engine create/exec requests (real values), host logs/status/audit/errors (either), or exported metadata. Deliberate upstream response-echo tests must document the residual leak behavior rather than asserting an impossible universal guarantee.

Preserve and rerun `tests/local.test.ts`, `tests/runtime.test.ts`, `tests/secrets.test.ts`, platform, model and slash-command tests. Existing tests cover real local tool factories and cancellation but do not currently constitute full extension lifecycle or real VM coverage.

### Opt-in real Docker E2E

Place real-daemon tests outside the default `tests/*.test.ts` glob (for example `tests/e2e/docker.test.ts`), with a future `test:docker` script or explicit `tsx` invocation. Require `PI_CHAT_DOCKER_E2E=1` and explicit disposable image/dedicated workspace. The dedicated CI job must **fail**, not silently skip, if its Docker prerequisites are absent. Ordinary `npm test` must not attempt Docker.

Prerequisites: approved Linux daemon/socket, disposable dedicated test storage, pinned image built from trusted source, no production secrets, port/socket permissions and capacity. Separate runc, rootless, and runsc jobs; record Engine/kernel/runtime/image/helper versions and effective inspect/cgroup data. Runtime installation and daemon policy changes are operator tasks—stop and ask, do not provision them implicitly.

Required E2E cases:

- Create/start readiness; `pwd=/workspace`; correct non-root `id`; host env sentinel absent; inspect and `/proc/self/status`/mountinfo or runtime-appropriate equivalents confirm capabilities, no-new-privileges, rootfs/mount policy. Validate seccomp with the profile's supported checks, not one magic `/proc` assertion for every runtime.
- Real write/edit/read/image operations, staged outgoing bytes, simulated host download into incoming, memory/skills/SYSTEM paths, plaintext runtime-secret visibility/0600 ownership; no host file reads outside approved mounts.
- Host sentinel at a path absent from the container cannot be accessed. Symlink and symlink-race cases cannot trick host bridges/staging into reading or overwriting it. Shared read-only enforcement holds even through attempted aliases.
- Long mixed stdout/stderr and binary output; nonzero exit; stdin transfer; large-output file readable via the backend. No unbounded worker/daemon log growth.
- Timeout/abort/disconnect with `sleep`, forked child, daemonized/`setsid` descendant, background writer and SIGTERM-ignoring process. Observe that the writer really stops and container processes are gone; a rejected Promise is insufficient.
- Memory/PID/CPU bounds using small controlled loads; distinguish OOM from manual kill. Never run an unbounded host fork bomb. Confirm daemon/kernel limitations cause fail-closed preflight.
- Idle stop/restart: workspace marker persists, tmpfs marker disappears, old processes/execs do not return, new command works. `onClose=remove` removes container; `stop` retains/reuses only a matching stopped one; changed digest/user/mount/policy recreates.
- Kill the **test worker**, restart/reconcile, verify no double writer and safe cleanup. Simulate daemon loss on a disposable test daemon or injected transport; do not stop a shared production Docker service. Exercise adapter-connect failure after container start.
- Proxy allowed HTTP without credentials and HTTPS with placeholder auth reach a controlled fixture; fixture observes the real test token, guest inspect/env sees only placeholders. Use an injected test-only trusted upstream/resolver seam or a dedicated public fixture; do not add production internal-IP bypasses to make the test convenient.
- Direct IP TCP/UDP/DNS, `curl --noproxy '*'`, unset proxy variables, host-gateway/metadata/LAN/IPv6 addresses, another container and arbitrary CONNECT fail. Test direct Unix-proxy access too: it cannot bypass per-conversation policy. No blind TLS tunnel/non-HTTP protocol succeeds.
- Proxy crash, relay crash, stale token, policy rotation, DNS rebinding, redirect to denied/internal destination, certificate failure, HTTPS downgrade and CONNECT/SNI/Host mismatch all fail closed. Two concurrent conversations cannot reuse one another's socket/token context.
- runsc: certified image/helper syscall behavior, host-UDS profile, file visibility, resource enforcement, cancellation and proxy tests. A missing runsc profile must fail with no runc fallback.
- Teardown inventories only test-labeled containers, sockets, private keys and temp files; all expected removals completed, retained resources explicitly listed. Never broad-prune the daemon.

Finally, test the actual extension with real pi in standalone Docker mode and a configured model, then one dedicated chat conversation with attachments and stop/status. The backend E2E suite does not need either a model or platform credentials; these last two smoke tests do. Ask the operator for missing conditions through the appropriate secure workflow. Use synthetic data and do not print production credentials.

Future validation commands, **after implementing their prerequisites**, could be:

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

Do not run `npm run format` as a read-only validation command; it writes files. No test/build step was performed as evidence of Docker support during this documentation task.

## 13. Ordered implementation tasks and acceptance criteria

Deliver offline execution before exposing network proxy mode; keep incomplete modes unavailable rather than weakening defaults. Each task includes a concrete completion gate.

### Task 1 — Lock the implementation contract

- Resolve §14 blockers (certified platform/runtime, image/helper, proxy implementation, output collector).
- Confirm the installed pi operations contracts and Engine API compatibility range.
- Decide and document rootless/runsc support status, UID mapping, size budgets and hardening verification.

**Acceptance:** one unambiguous create spec and lifecycle/secret contract; no open-ended extra Docker arguments; no claims of platform support without a test job.

### Task 2 — Add config/types and lazy routing

- Update types, resolution, validation, defaults, private Docker paths and fixtures.
- Add exhaustive lazy execution factory branch; preserve Gondolin/local behavior.
- Add config/unit tests including inherited legacy secrets under Docker policy.

**Acceptance:** old configs resolve identically; invalid Docker settings fail before side effects; local/Gondolin tests do not load/probe Docker; default execution is still Gondolin.

### Task 3 — Implement the Engine client and trusted image

- Add injectable transport and bounded create/inspect/start/exec/stop/kill/remove APIs.
- Produce a reviewed pinned image with bash, entrypoint/reaper, file helper and optional relay; define helper readiness protocol and clean environment.
- Implement stream framing and structured/redacted error conversion.

**Acceptance:** fake-daemon contract tests cover framing/late responses/limits; image does not need guest root, runtime OS package installation, host credentials or Docker socket access.

### Task 4 — Implement offline lifecycle and cancellation

- Create `DockerExecution`, generation/state/lease handling, private metadata and cleanup.
- Support network-none, bounded startup and terminal idempotent close.
- Implement whole-container cancellation and uncertain-outcome handling.

**Acceptance:** every injected startup failure has owned-resource cleanup; close/start races cannot publish a leaked ready container; abort waits for stop or leaves a clear failed state; no command replay or local fallback.

### Task 5 — Implement safe files, staging and bounded output

- Provide all four operations with container cwd and byte-safe transfer.
- Harden the exposed host bridges and directory/secret writes against hostile mount contents; keep unrelated code changes narrowly scoped.
- Solve pi spill-file visibility; add staged-file retention and budgets.

**Acceptance:** real pi tool factories work against injected operations; path/race/special-file/size tests pass; advertised output paths are backend-readable; no guest path is used as a host path without a safe bridge.

### Task 6 — Wire flags, connection/restart and prompts

- Add standalone Docker startup/failure latch; preserve standalone local semantics.
- Add connected-mode fail-closed guarding, serialized Docker replacement and explicit policy application on reconnect.
- Update both prompts, UI field preservation, status and worker handling; wire turn activity leases.

**Acceptance:** fake extension lifecycle exercises every startup/shutdown/error branch; Docker never triggers QEMU preparation, mislabels itself as VM/local, or activates unsafe fallback tools. Chat dispatch/completion semantics remain unchanged.

### Task 7 — Add idle stop, safe reuse and reconciliation

- Implement fake-clock idle timing, same-object wake, optional stopped-container retention, TTL and scoped orphan cleanup.
- Validate inspect state against immutable settings; rotate proxy capabilities on ownership changes.

**Acceptance:** no stop while leased; no implicit background-process survival; no two live owners; retained data/recreated tmpfs behavior specified; deletion never touches bind contents or foreign resources.

### Task 8 — Implement policy and host secret substitution

- Implement canonical exact-host policy, non-global-IP denial, checked connector, isolated token map, Bearer/Basic/query semantics and privacy controls.
- Port relevant Gondolin test vectors and add intentional stricter-behavior tests.

**Acceptance:** `[]` denies all; secrets cannot widen host policy, enter Engine env as real values, or be injected over HTTP; wrong-host/rewritten/stale tokens deny. No body substitution or universal confidentiality claims.

### Task 9 — Implement enforced proxy transport and TLS

- Add host Unix listener, loopback relay, public CA mount/trust, reviewed CONNECT MITM and bounded HTTP forwarding.
- Wire revocation on close/policy change and verify no direct network route exists.
- Qualify runsc's host-UDS profile without automatic daemon changes.

**Acceptance:** all network paths traverse the same policy or fail; no blind CONNECT; every actual outbound connect is address-checked; proxy failure cannot enable egress; unsupported profiles fail startup. Do not expose proxy mode before this gate.

### Task 10 — Finish audit/status and full validation

- Add sanitized structured events, quotas/retention, clear operator diagnostics and ownership-aware cleanup visibility.
- Complete all unit/integration and opt-in E2E cases, then run `npm run check`, `npm test`, real-Docker matrix and pi/chat smoke tests in that order.
- In the implementation change, update user-facing configuration/development instructions with **actual** results and support limitations. This present documentation task does not authorize editing those files now.

**Acceptance:** recorded versions/results; no skipped-as-passed Docker CI; no leaked test resources or sentinel credentials; existing backend/platform tests pass; operator-only prerequisites are explicitly listed. Commit/push only if separately authorized by the user.

## 14. Open questions and decisions that must not be guessed away

1. **Image and helper implementation (blocker):** who maintains/publishes the digest-pinned image, which distro/architectures and languages are required, and which audited fd-relative helper works under both runc and selected runsc? Generic arbitrary images are not compatible with the proposed contract.
2. **Proxy component (blocker for proxy mode):** which maintained HTTP/TLS MITM implementation will be used, and how is the checked DNS/connection path guaranteed? The pure Gondolin hook factory is not that component. Review parser/TLS dependencies and licensing before copying code.
3. **Platform baseline (blocker):** is Linux local Engine enough initially? Socket sharing on Desktop/remote daemons and rootless UID/cgroup behavior require separate designs/tests; do not quietly downgrade networking or hardening.
4. **gVisor deployment (blocker for runsc+proxy):** is an operator-managed host-UDS-open runtime acceptable? Does the deployed runsc support file helper syscalls and the intended mount semantics? Upstream flag existence is not certification of that deployment.
5. **Output collector (blocker):** decorate the installed pi bash factory or provide a compatible bounded collector? Must handle partial/final/error paths without reading user-selected host files or patching node_modules.
6. **Shared writes:** is Docker's read-only `/shared` default acceptable, or is cross-channel memory writing essential? If writable, users must acknowledge same-account cross-channel trust. Prompt changes must follow the effective mode.
7. **Cancellation scope:** is terminating background services on command abort/timeout acceptable? The safe v1 policy is whole-container stop. Fine-grained termination is additional work, not killing the client stream.
8. **Persistence expectations:** does the user want only workspace persistence or installed OS packages too? Read-only rootfs + non-root intentionally forbids the latter. Stop/start does not make `apt install` possible; commit is not the default answer.
9. **Host-consumer trust (release gate):** how are pi project extensions/config, git hooks and shell integration disabled/reviewed in writable workspaces? The backend cannot protect a host that subsequently executes agent-written code.
10. **Disk/host resource governance:** required workspace quotas, max workers, proxy budgets, attachment limits and retained-resource TTL? What maintenance runs when all workers are down?
11. **Secret evolution:** keep the legacy `gondolin.secrets` spelling initially as proposed, or plan a separately specified neutral migration? Are query tokens really needed? Which allowed API hosts require action/path restrictions?
12. **Private services / protocols:** the default denies internal services and non-HTTP protocols. If private registries, SSH or custom ports are required, specify narrowly authenticated brokered exceptions and tests; do not add `allowedHosts: ["*"]` or an unrestricted bridge.
13. **Hot reload:** v1 can require disconnect/reconnect for Docker settings. If live policy rotation is required, atomically revoke old proxy pools/capabilities and update all captured conversation references; current secret-only restart comparison is not sufficient.
14. **Deletion UX:** should deleting a channel first stop/remove its retained Docker container automatically, or require explicit cleanup? Refuse silent deletion of mounted host storage while a retained/running owner can still write it.
15. **Verification availability:** the documentation environment lacks Docker on PATH. Real runc/runsc, network-negative, UID/permissions and cleanup tests require a suitable host and operator permission; report unmet conditions rather than marking them passed.

## 15. Primary references for implementation

The local source references throughout this guide are the authority for current pi-chat/Gondolin behavior. The following official sources were additionally consulted for Docker/gVisor semantics; pin/recheck the versions used in production.

- **[D1] Docker Engine API v1.48, Moby v28.0.0:** [versioned OpenAPI source](https://github.com/moby/moby/blob/v28.0.0/docs/api/v1.48.yaml). See container create/start/stop/kill/delete, exec create/start/inspect, attach stream framing, `HostConfig`, resource fields, bind options and container state. This is a reference contract, not a requirement to blindly request API 1.48 against every daemon.
- **[D2] Docker exec:** [official command reference](https://docs.docker.com/reference/cli/docker/container/exec/) / [source](https://github.com/docker/cli/blob/master/docs/reference/commandline/container_exec.md). Exec requires running PID1 and commands do not restart after container restart.
- **[D3] Docker internal networks:** [network create reference](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal) / [source](https://github.com/docker/cli/blob/master/docs/reference/commandline/network_create.md). Internal network gateway/host-service access matters to proxy topology.
- **[D4] Docker network-none:** [documentation](https://docs.docker.com/engine/network/drivers/none/) / [source](https://github.com/docker/docs/blob/main/content/manuals/engine/network/drivers/none.md). Only loopback is configured.
- **[D5] Bind mounts:** [documentation](https://docs.docker.com/engine/storage/bind-mounts/) / [source](https://github.com/docker/docs/blob/main/content/manuals/engine/storage/bind-mounts.md). Daemon-host interpretation, recursive mounts, propagation and read-only limitations.
- **[D6] Container run/hardening options:** [reference](https://docs.docker.com/reference/cli/docker/container/run/) / [source](https://github.com/docker/cli/blob/master/docs/reference/commandline/container_run.md). Rootfs, tmpfs, user, security options and runtime controls.
- **[D7] Resource constraints:** [documentation](https://docs.docker.com/engine/containers/resource_constraints/) / [source](https://github.com/docker/docs/blob/main/content/manuals/engine/containers/resource_constraints.md). Containers are unconstrained by default; equal memory/memory-swap prevents swap when supported; CPU quota is distinct from CPU shares.
- **[D8] Seccomp:** [documentation](https://docs.docker.com/engine/security/seccomp/) / [source](https://github.com/docker/docs/blob/main/content/manuals/engine/security/seccomp.md). Default profile and kernel/daemon support; do not disable confinement for convenience.
- **[D9] Stop and commit:** [stop](https://docs.docker.com/reference/cli/docker/container/stop/) / [source](https://github.com/docker/cli/blob/master/docs/reference/commandline/container_stop.md); [commit](https://docs.docker.com/reference/cli/docker/container/commit/) / [source](https://github.com/docker/cli/blob/master/docs/reference/commandline/container_commit.md). Stop uses a signal/grace/kill sequence; commits exclude mounted-volume data and normally pause processes while capturing filesystem changes.
- **[G1] gVisor Docker quick start:** [documentation](https://gvisor.dev/docs/user_guide/quick_start/docker/). Runtime registration is a host/operator task; selection uses Docker's `--runtime`.
- **[G2] gVisor host Unix sockets:** [runsc flag registration](https://github.com/google/gvisor/blob/master/runsc/config/flags.go), `host-uds` default `none`; [configuration types](https://github.com/google/gvisor/blob/master/runsc/config/config.go), `HostUDSNone/Open/Create/All`. These are live upstream references, not a pinned installed runsc version.
- **[G3] gVisor filesystem behavior:** [documentation](https://gvisor.dev/docs/user_guide/filesystem/). Rootfs overlays, bind visibility and runtime filesystem settings must be validated for the chosen version.

**Release rule:** label every conclusion as implemented, unit-tested, real-Docker-tested, or still unverified. Secure defaults must remain fail-closed whenever a required capability is missing.
