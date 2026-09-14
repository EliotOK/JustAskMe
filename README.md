# codex-human-input-mcp

让 **OpenAI Codex CLI**（以及任何支持 MCP 的客户端）能主动向用户发起**结构化提问**并等待回答——体验接近 Claude Code 的 `AskUserQuestion`。

不改 Codex 源码，不做网页 DOM hack，不要求常驻 GUI。

---

## 1. 事实核查（先读这一节）

你在别处看到的关于 MCP elicitation 的教程，很多在细节上是错的。下面每一条都在本机实测过，标注了证据。

| 事项 | 结论 | 证据 |
| --- | --- | --- |
| MCP SDK 是否支持 elicitation | ✅ 支持 | `@modelcontextprotocol/sdk@1.30.0`，`dist/esm/server/index.d.ts:158` 有 `elicitInput(params, options): Promise<ElicitResult>` |
| 返回结构 | `{ action: 'accept' \| 'decline' \| 'cancel', content?: Record<string, string\|number\|boolean\|string[]> }` | `dist/esm/types.d.ts:5381` `ElicitResultSchema` |
| form 模式支持哪些字段 | 只支持**扁平原始类型**：string / boolean / number / integer / array-of-enum | `dist/esm/types.d.ts:4984-5062` |
| SDK 会静默丢字段吗 | ⚠️ **会**。`properties` 用 Zod union + `.strip()`，不认识的键被**丢掉而不是报错** | 同上；`test/schema.test.ts` 用 round-trip 断言把这件事变成会失败的测试 |
| 客户端没声明能力时 | ⚠️ `elicitInput()` **直接 throw** `'Client does not support form elicitation.'`，**不会**发出去 | `dist/esm/server/index.js:351` |
| 默认超时 | ⚠️ `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`，不显式传 `timeout` 就 60 秒静默超时 | `dist/esm/shared/protocol.d.ts:57` |
| SDK 会校验用户回答吗 | ⚠️ **会**，用 Ajv 按 `requestedSchema` 校验；不匹配抛 `McpError(InvalidParams)`，所以越界选项**到不了本项目的代码** | `dist/esm/server/index.js:356-369` |
| 取消能否传递到 server | ✅ 能。客户端 abort → SDK 发 `notifications/cancelled` → server 的 `extra.signal` 被 abort | `dist/esm/shared/protocol.js:169-176, 670-687` |
| Codex CLI 是否支持 elicitation | ✅ 0.144.3 支持，**且默认配置下就能弹表单**——`approval policy = OnRequest`、完全不配置 `mcp_elicitations` 时实测正常弹出 | 2026-09-14 实测：Codex Desktop 弹出模态表单，来源标注 `codex-human-input-mcp` |
| Codex 会渲染表单吗 | ✅ **已实测原生渲染**：模态框 + 下拉选择 + 跳过/继续按钮 | 同上。「server 能发起 elicitation」与「客户端一定会渲染」仍是两件事，§13 保留了这个区分 |
| Codex 的 granular 配置 | ⚠️ **通常不需要**，只在想显式**关闭** elicitation 时才用。真要写时有**必填**字段：`sandbox_approval`、`mcp_elicitations`、`rules`，少一个 Codex **拒绝加载整个 config.toml** | 本机实测：`missing field 'sandbox_approval'` / `missing field 'rules'` |

> **本项目不依赖任何未证实的 API。** 所有 SDK 调用都按 1.30.0 的真实类型定义写，测试直接跑真 SDK 的 `Client` + `Server` 握手。

---

## 2. 目录结构

```
codex-human-input-mcp/
├── src/
│   ├── index.ts          # stdio 入口：唯一的 stdout 消费者是 JSON-RPC transport
│   ├── server.ts         # McpServer 组装 + 通过 initialize 下发的 instructions
│   ├── tools.ts          # 5 个工具的注册 + 唯一的提问流水线 runQuestion()
│   ├── elicitation.ts    # 封装 elicitInput，含能力探测与错误分类
│   ├── forms.ts          # FormQuestion ⇄ MCP 受限 JSON Schema 的双向转换
│   ├── http-form.ts      # fallback：127.0.0.1 一次性表单页
│   ├── schemas.ts        # zod 输入 schema + 统一的输出 schema
│   ├── outcome.ts        # 统一的 AskResult 状态机类型
│   ├── config.ts         # HIM_* 环境变量 → ServerConfig
│   └── logger.ts         # 只写 stderr 的日志 + console.log 重定向保险
├── test/
│   ├── helpers.ts        # 真 MCP Client/Server over InMemoryTransport
│   ├── schema.test.ts    # schema round-trip / 工具定义 / 参数校验
│   ├── choice.test.ts    # 正常回答路径（choice / confirm / text / multi_select）
│   ├── cancel.test.ts    # decline / cancel / abort / 无能力降级
│   ├── timeout.test.ts   # 超时与每调用覆盖
│   └── fallback.test.ts  # loopback 表单页端到端（含 token 校验与自关闭）
├── scripts/
│   └── smoke-stdio.mjs   # 真实 stdio 子进程端到端冒烟（含 --manual 人工模式）
├── docs/
│   └── codex-config.example.toml
├── AGENTS.md             # 给 Codex 的提问纪律（复制到你的项目根目录）
├── package.json
├── tsconfig.json
└── tsconfig.test.json
```

---

## 3. 为什么选 TypeScript

不是偏好问题，是成本问题：

- MCP 官方 SDK 的 elicitation 支持最完整，且官方自带 `elicitationFormExample`；
- Python SDK 要额外拉 `mcp[cli]` + `pydantic` + `anyio`，依赖面更大；
- Codex 本身是 Node 生态，`node dist/index.js` 零包装即可被 `command`/`args` 拉起；
- 运行时依赖只有 **2 个**：`@modelcontextprotocol/sdk`、`zod`。

---

## 4. 安装

### 4.1 作为 Codex 插件（推荐）

本仓库本身就是一个 Codex 插件仓库，`plugins/codex-human-input-mcp/` 内含 MCP server 与
`discussion-mode` 技能。发布用的 server 是 esbuild 打包的**单文件**（已内联 SDK 与 zod），
所以安装**不需要 `npm install`**，只需要 `PATH` 上有 Node ≥ 20。

```powershell
cd <本仓库>
.\Install.cmd
```

`Install.cmd` 会调用 `install.py`，它做六件事：

1. 检查 `%USERPROFILE%\.codex\config.toml`：若已有手工注册的 `[mcp_servers.human_input]`，
   **直接终止**并说明原因（插件与手工注册并存会出现两份 `ask_*` 工具）；加 `--migrate`
   则在装完后自动把该段**注释掉**（不删除，回滚即删掉注释块）；
2. 把 `plugins/codex-human-input-mcp` 复制到 `~\plugins\codex-human-input-mcp`；
3. 把 `.mcp.json` 里的裸 `node` **改写成这台机器的绝对路径**（这样插件不依赖子进程的 PATH）；
4. 用官方 `plugin-creator` 助手更新 cachebuster 并校验；
5. `codex plugin add codex-human-input-mcp@personal`；
6. 迁移收尾：注释掉手工 server 段；`--migrate` 时还会把 `~\.codex\skills\discussion-mode\`
   手工副本**改名归档**为 `discussion-mode.bak-<时间戳>`（不删除）——插件内是更新的版本
   （含「提问时机」一节、会话级持续生效）。

装完**开新任务**验证两件事：`human_input_status` 只报告一套 `ask_*` 工具；`$discussion-mode`
是插件版（行为准则里含「提问时机」）。然后说一句「遇到需要我决定的地方就弹卡片问我」即可。

### 4.2 手工接进已有的 `config.toml`

不想用安装器的话，直接在 `%USERPROFILE%\.codex\config.toml` 里加：

```toml
[mcp_servers.human_input]
command = "node"
args = ["<本仓库克隆位置>\\dist\\index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 600
[mcp_servers.human_input.env]
HIM_FALLBACK = "return"
HIM_TIMEOUT_MS = "300000"
```

> 手工注册与插件是**二选一**：并存会注册两个同名 server，每个 `ask_*` 工具出现两份。
> 之后想切到插件形态，跑 `.\Install.cmd --migrate` 即可自动迁移。

### 4.3 从源码开发

```powershell
npm install
npm run build          # tsc → dist/
npm test               # 44 个单元测试
npm run build:plugin   # esbuild → plugins/*/server/index.mjs
npm run test:plugin    # 对打包产物跑 stdio 冒烟
npm run verify         # 以上全套
```

期望输出：`smoke test OK`，且每一项都是 `PASS`。

> `npm run dev` 可以用 `tsx` 直接跑源码，免编译，但每次启动慢 ~300ms，日常开发用。

---

## 5. Codex 接入

### 5.1 写配置

把下面内容合并进 `%USERPROFILE%\.codex\config.toml`（完整注释版见 `docs/codex-config.example.toml`）：

```toml
# 【可选，多数情况不需要】实测（2026-09-14，codex-cli 0.144.3）：approval policy 保持
# 默认 OnRequest、完全不配置 mcp_elicitations 时，表单已经能正常弹出。
# 只有你想显式【关闭】elicitation 才需要下面这块。
#
# 真的要写的话注意两点：
#   1) 这三个字段是必填，少任何一个 Codex 会拒绝加载整个 config.toml；
#   2) 未列出的 skill_approval / request_permissions 会取默认 false，
#      可能改变你现有的审批行为，别想当然地加上去。
#
# [approval_policy.granular]
# sandbox_approval = true
# mcp_elicitations = true
# rules = true

[mcp_servers.human_input]
command = "node"
args = ["<本仓库克隆位置>\\dist\\index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 600          # 必须 >= HIM_TIMEOUT_MS/1000，否则表单还没提交就被掐
[mcp_servers.human_input.env]
HIM_FALLBACK = "return"
HIM_TIMEOUT_MS = "300000"
```

**注意**：不要同时写 `approval_policy = "on-request"` 和 `[approval_policy.granular]`，TOML 会报 `cannot extend value of type string with a dotted key`。整块要么用 granular 表，要么用字符串，二选一。

### 5.2 或者让 CLI 帮你写

```powershell
codex mcp add human_input `
  --env HIM_FALLBACK=return `
  --env HIM_TIMEOUT_MS=300000 `
  -- node "<本仓库克隆位置>\dist\index.js"
```

`codex mcp add` 只写 `[mcp_servers.*]`，这就够了——granular 那一段是可选的（见 §5.1）。

### 5.3 验证配置被读到

```powershell
codex mcp list
```

期望看到（实测输出）：

```
Name         Command  Args                                       Env             Status   Auth
human_input  node     D:\...\dist\index.js                       HIM_FALLBACK=…  enabled  Unsupported
```

`Status = enabled` 说明注册成功。`Auth = Unsupported` 是正常的（stdio server 不需要 OAuth，这一列只对 HTTP server 有意义）。

更细的诊断：

```powershell
codex doctor --json | Select-String 'mcp'
```

应包含 `"mcp servers": "1"`，以及：

```
"approval policy": "Granular(GranularApprovalConfig { sandbox_approval: true, rules: true,
                     skill_approval: false, request_permissions: false, mcp_elicitations: true })"
```

`"mcp servers"` 的数字应随注册的 server 数量增加；`"config.toml parse": "ok"` 说明配置能被解析。

**关于 `mcp_elicitations`**：如果 `approval policy` 显示为 `OnRequest`（没有 granular 块），说明你没配置它——**这是正常的**，实测表单照样弹出。只有在 policy 显示为 `Granular(... mcp_elicitations: false ...)` 时，Codex 才会静默拒绝所有 elicitation，表现为 agent 说"我问不了"。

### 5.4 把提问纪律交给 Codex

把 `AGENTS.md` 复制到你**项目仓库**的根目录（不是本项目的根目录）。内容见 §6。

---

## 6. AGENTS.md 规则

完整内容在 `AGENTS.md`。摘录核心判断标准：

> **只有在「决策价值 > 打断成本」时才提问。**
>
> 该问：关键歧义 / 架构选择不可逆 / 多个方案同样合理靠偏好决定 / 删除覆盖迁移等破坏性操作 / 用户可见行为有真实取舍。
>
> 不该问：小问题别频繁打断 / 能安全推断的自己定 / 能从仓库读出来的先读 / 答案不改变下一步的别问 / 问过的别重复问。
>
> 拿不准的顺序：**先读代码 → 再按仓库既有约定推断 → 仍然影响重大且无法推断时才提问。**

工具选择：2–5 个候选 → `ask_choice`；是/否 → `ask_confirm`；自由输入 → `ask_text`；选子集 → `ask_multi_select`。

这套纪律同时也通过 MCP 的 `initialize.instructions` 下发（见 `src/server.ts`），所以即使你的仓库里没有 AGENTS.md，模型也能拿到基本规则。

---

## 7. 工具参考

所有 `ask_*` 返回**同一个结构**（`outputSchema` 已声明，客户端可用 `structuredContent` 直接解析）。

### `ask_choice`

| 输入 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `question` | string(1–2000) | ✅ | 直接问出来的那个问题，自带回答所需上下文 |
| `options` | `{label, description?}[]`, 2–25 | ✅ | label 唯一；2–5 个最佳 |
| `default` | string | | 推荐项，必须精确匹配某个 label |
| `allow_free_text` | boolean | | 额外给一个自由文本输入框 |
| `timeout_ms` | int(1000–3600000) | | 覆盖本次等待上限 |

返回：`answer`/`selected` 为所选 label；`free_text` 为附加说明。

### `ask_confirm`

`question` ✅、`default?: boolean`、`timeout_ms?` → 返回 `confirmed: boolean`，同时 `answer` 为 `"yes"`/`"no"`。

### `ask_text`

`question` ✅、`placeholder?`、`default?`、`timeout_ms?` → 返回 `answer`（已 trim）。

### `ask_multi_select`

`question` ✅、`options` ✅(2–25)、`min?`、`max?`、`timeout_ms?` → 返回 `selected: string[]`，`answer` 为逗号连接。

### `human_input_status`（诊断）

`verbose?: boolean`。**不提问、不阻塞。** 用来确认：客户端是否声明了 elicitation、当前 fallback 模式、超时设置、工具清单。第 11 节的排查主要靠它。

---

## 8. 返回状态矩阵

**只有 `status: "answered"` 代表拿到了答案。**

| `status` | 含义 | agent 应该做什么 |
| --- | --- | --- |
| `answered` | 用户回答了 | 用 `answer`/`selected`/`confirmed`/`free_text` 继续；不要重复问 |
| `needs_user_input` | 表单**从未展示**给用户 | 把 `message` 里的问题和选项原样复述到对话里，等用户回复 |
| `declined` | 用户拒绝回答 | **不要再问**。选最保守方案并声明假设，或报告需要决策 |
| `cancelled` | 用户关掉了，或工具调用被 abort | 未回答 ≠ 许可。破坏性操作上不要猜 |
| `timeout` | 限时内没人回答 | 别重复等同一题；改用对话提问或声明假设 |
| `invalid_response` | 客户端答了但内容不可用 | 读 `message`（含原始内容/校验错误）后重问或声明假设 |
| `unsupported` | 客户端不支持 elicitation 且 `HIM_FALLBACK=off` | 自行决断并显式说明假设 |
| `error` | 参数非法或服务端异常 | 读 `message` 修正后重试 |

另外两个辅助字段：
- `client_elicitation` — 客户端是否声明了 `capabilities.elicitation.form`；
- `auto_reject_suspected` — `decline` 回得太快（默认 <400ms），几乎可以断定是客户端**自动拒绝**而非用户点了"否"。此时 `status` 会被提升为 `needs_user_input`，而不是误报成用户的拒绝。

---

## 9. Elicitation 不可用时会发生什么

按 `HIM_FALLBACK` 三选一，**都不会破坏 MCP 消息流**：

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `return`（默认） | 立刻返回 `needs_user_input`，附上完整问题与选项，让 Codex 在对话里直接问。**不阻塞。** | 通用默认；最安全 |
| `http` | 在 `127.0.0.1` 随机端口起一个**一次性**表单页，URL 打到 stderr 并尝试打开浏览器，阻塞等待提交或超时，然后自动关闭 | 想要真正的结构化 UI 时显式开启 |
| `off` | 返回 `isError: true` 的 `unsupported` 结果 | 非交互/CI 环境 |

`http` 模式的安全属性：只绑 `127.0.0.1`、需要 128 位随机 token（constant-time 比较）、一题一实例用完即关、页面零外部资源（离线可用）。**它不是常驻 GUI。**

> 为什么 fallback 用 HTTP 而不是终端提示？因为 stdio MCP server 的 stdin **就是** JSON-RPC 通道，读它或往 stdout 写提示都会破坏协议。loopback HTTP 是唯一完全不碰 MCP 消息流的 fallback。

---

## 10. 测试

```powershell
npm test                      # 44 个测试
npx tsc -p tsconfig.test.json # 源码 + 测试全量类型检查
node scripts/smoke-stdio.mjs  # 真实子进程 stdio 端到端
node scripts/smoke-stdio.mjs --manual   # 人工模式：题目打到终端，你手动回答
```

覆盖情况：

| 要求 | 位置 | 说明 |
| --- | --- | --- |
| schema validation test | `test/schema.test.ts` | 每个 schema 过一遍 SDK 自己的 `ElicitRequestFormParamsSchema.parse()` 并断言**深度相等**——SDK 是 `.strip()` 的，不相等就意味着字段正在被静默丢弃 |
| choice response test | `test/choice.test.ts` | choice/confirm/text/multi_select 全部正常路径 + 越界 + 空值 |
| cancel test | `test/cancel.test.ts` | decline / cancel / **abort 必须归类为 cancelled 而非 timeout** / 无能力降级 |
| timeout test | `test/timeout.test.ts` | 配置超时、每调用覆盖，并断言实测耗时远小于 SDK 的 60s 默认值 |
| fallback test | `test/fallback.test.ts` | 真起 HTTP、真发请求、token 校验返回 403、提交后返回答案、超时后端口不再监听 |
| 人工 smoke test | `scripts/smoke-stdio.mjs` | 见上，`--manual` 会真的把表单题目打到终端等你输入 |

测试用的是**真** MCP `Client` 和 `Server`，通过 `InMemoryTransport.createLinkedPair()` 相连，只把"人"换成脚本。

---

## 11. 如何确认 Codex 真的调用了 MCP tool

按可靠性从高到低：

1. **看 server 的 stderr。** 把 `HIM_LOG=debug` 写进 `[mcp_servers.human_input.env]`，然后 Codex 运行时你会在终端看到：
   ```
   [codex-human-input-mcp] info: ready (log=debug, fallback=return, timeout=300000ms, ...)
   [codex-human-input-mcp] debug: elicitation/create resolved in 13ms: accept
   ```
   没看到 `ready` = server 没起来；看到 `ready` 但没有 `elicitation/create` = **模型没调这个工具**，是提示词/AGENTS.md 的问题，不是连接问题。

2. **让 agent 调 `human_input_status`。** 直接在 Codex 里说「调用 human_input_status 看看」。它的输出会告诉你客户端能力、fallback 模式、超时值——这是唯一能确认"服务端视角看到了什么"的办法。

3. **`codex doctor --json`** 确认配置层：`"mcp servers": "1"` 且 `mcp_elicitations: true`。

4. **`codex mcp list`** 确认注册层：`Status = enabled`。

5. **独立排除 Codex**：`node scripts/smoke-stdio.mjs`。它跑通说明 server 本身没问题，锅在 Codex 侧配置或提示词。

---

## 12. 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| agent 说"我问不了用户" / 直接自己猜 | 若 policy 是 `Granular(... mcp_elicitations: false ...)`，Codex 静默自动拒绝 | 改成 `true`，或用 `codex doctor --json` 先看当前 policy 是不是 granular |
| 用户没看到表单，agent 却收到 `declined` | 客户端自动拒绝（未把 elicitation 弹给用户） | 看 `auto_reject_suspected: true`；本项目已把这种情况改报为 `needs_user_input`，不会误导 agent。也可临时把 `HIM_FALLBACK` 改成 `http` 拿到结构化 UI |
| Codex 启动就报 `failed to load configuration` / `missing field ...` | granular 三个必填字段没写全 | 补 `sandbox_approval` / `mcp_elicitations` / `rules` |
| `cannot extend value of type string with a dotted key` | 同时写了 `approval_policy = "..."` 和 `[approval_policy.granular]` | 二选一 |
| 表单弹出来了，提交却无效/报错 | Codex 的 `tool_timeout_sec` 小于等待时间，`tools/call` 被提前掐断 | `tool_timeout_sec` 设 600 或更大，并保证 ≥ `HIM_TIMEOUT_MS/1000` |
| `Status = disabled` 或列表里没有 | 路径写错 / 没 `npm run build` | `node <那个路径>` 手动跑一下，能出 `ready` 说明路径对 |
| stdout 出现非 JSON 内容导致连接断开 | 有代码往 stdout 写日志 | 本项目已把 `console.log/info/debug/warn` 全部重定向到 stderr（`src/logger.ts`）；`HIM_STRICT_STDOUT=0` 可关掉这层保险 |
| 用户没看到表单，agent 却收到 `declined` | 客户端自动拒绝 elicitation | 看 `auto_reject_suspected: true`；本项目已把这种情况改报为 `needs_user_input`，不会误导 agent |
| 模型从来不调这些工具 | 提示词里没有提问纪律 | 把 `AGENTS.md` 放到项目根目录 |
| 选项描述没显示 | MCP form schema 不支持 per-option description | 本项目已把描述**内联进 `message`**（`1. label — description`），客户端看不到结构化描述也不丢信息 |
| `http` fallback 起了页面但浏览器没开 | 无头/远程环境 | `HIM_HTTP_OPEN=0` 关掉自动打开，URL 仍会打到 stderr |

---

## 13. API 覆盖与已知不确定

诚实边界：

**已实测确认（本机）**
- SDK 1.30.0 的 `elicitInput` 存在且行为如 §1 所述；
- 客户端未声明能力时 SDK 会先 throw，本项目已前置探测 + 兜底分类；
- 本项目生成的每个 `requestedSchema` 都能通过 SDK 自己的 schema 校验且**无字段被 strip**（round-trip 测试）；
- server 能以 stdio 被真实客户端拉起、握手、收发 `elicitation/create`（`scripts/smoke-stdio.mjs`）；
- Codex 0.144.3 能解析配置、注册 server（`codex mcp list` 显示 `enabled`）；
- **Codex Desktop 会原生渲染 elicitation 表单**（2026-09-14 实测）：`ask_choice` 弹出模态框，含 `Options:` 列表、下拉选择、跳过/继续按钮，来源标注 `codex-human-input-mcp`；
- **在 `approval policy = OnRequest`（非 granular、未配置 `mcp_elicitations`）下表单照样弹出**，即那个开关不是必需的；
- 选项的描述文本如期出现在 `message` 正文里（确认了「per-option description 不可表达、必须内联」这个设计判断）。

**未验证 / 不确定**
- **Codex 对 `array` 类型字段的渲染质量**（即 `ask_multi_select`）。理论上渲染成多选控件，尚未实测。若不理想：`HIM_MULTISELECT_MODE=text` 会把它降级成一个逗号分隔的文本框，解析逻辑已实现并测试。
- **`ask_confirm` 的布尔字段渲染**。理论上渲染成是/否控件，尚未实测。
- **Codex 对 `enumNames` 的支持**。本项目同时发 `enum` 和 `enumNames`（值相同），即使被忽略也不影响正确性。
- **`number`/`integer` 字段**本项目**完全不用**。有公开 issue 反映 Codex 会把数值型 elicitation 字段降级成审批提示并提交空内容，所以所有 schema 只用 string/boolean/array-of-enum。

**已知的设计取舍**
- 越界选项值在 elicitation 路径上会被 SDK 的 Ajv 拦下并变成 `invalid_response`（拿不到用户原话，因为异常里不含原始值）。这正是 `allow_free_text` 存在的意义：用它是让用户回答"你没预料到的选项"的**受支持**方式。
- `ask_multi_select` 的 `choices` 字段**故意不设为 required**，这样空选会走到本项目自己的边界检查，给出可读的错误而不是死在 SDK 校验里。

---

## 14. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HIM_TIMEOUT_MS` | `300000` | 单题等待上限（1000–3600000） |
| `HIM_FALLBACK` | `return` | `return` \| `http` \| `off` |
| `HIM_HTTP_OPEN` | `1` | `http` 模式是否自动打开浏览器 |
| `HIM_HTTP_HOST` | `127.0.0.1` | **不要改成 0.0.0.0** |
| `HIM_HTTP_PORT` | `0` | 0 = 随机空闲端口 |
| `HIM_MULTISELECT_MODE` | `array` | `array` \| `text` |
| `HIM_AUTO_REJECT_MS` | `400` | 快于此值的 `decline` 判定为客户端自动拒绝 |
| `HIM_LOG` | `info` | `silent` \| `error` \| `warn` \| `info` \| `debug`，全部走 stderr |
| `HIM_STRICT_STDOUT` | `1` | `0` = 关闭 `console.log` → stderr 的重定向保险 |

命令行也支持 `-c` 覆盖，例如仅临时调：

```powershell
codex -c 'mcp_servers.human_input.env.HIM_LOG="debug"' 
```

---

## 15. 许可

MIT。
