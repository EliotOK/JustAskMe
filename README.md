# JustAskMe

让 **Codex** 遇到需要你拍板的事时，弹出结构化表单等你回答——选择题、是/否确认、填空、多选，答完它再继续干活。体验对标 Claude Code 的 `AskUserQuestion`，但属于 Codex。

不改 Codex 源码，不做网页 hack，不要求常驻 GUI。

---

## 安装（约 3 分钟）

**你需要**：

- Windows + 已登录的 Codex CLI 或 Desktop
- [Node.js](https://nodejs.org/) ≥ 20
- [Python](https://www.python.org/downloads/) ≥ 3.10（仅安装器需要，装完不再用）

**整段复制进 PowerShell，回车：**

```powershell
git clone https://github.com/EliotOK/JustAskMe.git
cd JustAskMe
.\Install.cmd
```

就这样。安装器会自动：注册插件、绑定本机的 Node 路径、检查有没有旧配置冲突。唯一需要加参数的情况——你以前**手工**在 `config.toml` 里配过本项目的 MCP server——那就改跑：

```powershell
.\Install.cmd --migrate
```

它会自动注释掉旧配置并归档旧技能副本（不删除，可回滚）。

> macOS / Linux：`python3 install.py`，效果等价。

> 更懒的办法：把下面这句话直接发给 Codex，让它自己装——
> 「从 GitHub 克隆 https://github.com/EliotOK/JustAskMe 并运行里面的 Install.cmd 把它装成你的插件」

## 验证（30 秒）

1. **重开一个 Codex 任务**（插件在新任务里生效）。
2. 发送：`调用 human_input_status 工具看看`
   看到 `client_supports_form_elicitation: true` 和五个工具 → 连接成功。
3. 发送：`遇到需要我决定的地方就弹卡片问我。比如：用 pnpm 还是 npm？`
   Codex 弹出带选项的表单，选一个提交，它拿着答案继续 → 完成。

出问题了？直接翻下面的[常见故障](#常见故障)，绝大多数是一行解法。

## 日常怎么用

不需要记任何命令。Codex 遇到该问的事会自己弹卡片。想让它更主动地问你：

- 说 **「讨论模式」** 或 **「边做边讨论」**——启用提问纪律：值得问的当场问、能自己查清的不烦你、答完立刻收束干活。
- 说 **「快聊一下」「展开讨论」「挑战一下我的想法」「先收束」**——随时调整讨论深度。
- 四个工具各管一摊：**选择**（`ask_choice`）、**是/否**（`ask_confirm`，破坏性操作前必用）、**填空**（`ask_text`）、**多选**（`ask_multi_select`）。细节见[工具参考](#工具参考)。

卸载：`codex plugin remove just-ask-me@personal`，再删掉 `~\plugins\just-ask-me` 即可。

---

## 常见故障

| 现象 | 处理 |
| --- | --- |
| `Install.cmd` 报 Python 相关错误 | 装官方 Python（python.org）后重跑；安装器会自动选对解释器，LibreOffice 等软件塞进 PATH 的残缺 Python 不会再被误用 |
| agent 说"我问不了" / 收到 `declined` 但你没看到表单 | 客户端在自动拒绝。看返回里的 `auto_reject_suspected: true`；本项目已把它改报为 `needs_user_input`，agent 会在对话里直接问。也可临时设 `HIM_FALLBACK=http` 拿到网页表单 |
| Codex 启动报 `failed to load configuration` / `missing field ...` | config.toml 的 `[approval_policy.granular]` 三个必填没写全（`sandbox_approval` / `mcp_elicitations` / `rules`）。**通常根本不用写这个块**——默认配置就能弹表单 |
| `cannot extend value of type string with a dotted key` | 同时写了 `approval_policy = "..."` 和 `[approval_policy.granular]`。二选一 |
| 表单弹出来了，提交却无效 | Codex 的 `tool_timeout_sec` 小于等待时间。设 600 以上，并 ≥ `HIM_TIMEOUT_MS/1000` |
| 列表里没有 human_input 或 `disabled` | 路径不对。`node <那个路径>` 手动跑一下，出 `ready` 说明路径没问题 |
| 表单弹了但浏览器没开（`http` 模式） | 无头环境。`HIM_HTTP_OPEN=0`，URL 仍会打到 stderr |
| 模型从来不调这些工具 | 项目里没有提问纪律。把本仓库的 [AGENTS.md](AGENTS.md) 复制到你**项目**的根目录（见下） |

**验证排障三板斧**（按可靠性）：

1. 让 agent 跑 `human_input_status`——服务端视角的真相；
2. `codex mcp list` 看 `Status = enabled`；
3. `node scripts/smoke-stdio.mjs` 绕开 Codex 直接测 server——它通则锅在 Codex 侧。

---

## 工具参考

所有 `ask_*` 返回**同一个结构**（`outputSchema` 已声明）。**只有 `status: "answered"` 代表拿到了答案**：

| `status` | 含义 | agent 应该做什么 |
| --- | --- | --- |
| `answered` | 用户回答了 | 用 `answer`/`selected`/`confirmed`/`free_text` 继续，不要重复问 |
| `needs_user_input` | 表单**从未展示**给用户 | 把 `message` 里的问题和选项原样复述到对话里，等用户回复 |
| `declined` | 用户拒绝回答 | **不要再问**。选最保守方案并声明假设，或报告需要决策 |
| `cancelled` / `timeout` | 用户关掉 / 没人回答 | 未回答 ≠ 许可。破坏性操作上不要猜 |
| `invalid_response` | 答了但内容不可用 | 读 `message` 后简化重问或声明假设 |
| `unsupported` / `error` | 不支持 elicitation 且 fallback=off / 参数或服务端异常 | 读 `message` 与 `next_step` 照做 |

辅助字段：`client_elicitation`（客户端是否声明 elicitation 能力）、`auto_reject_suspected`（`decline` 快于 400ms，几乎必然是客户端自动拒绝而非用户点否——此时状态会被提升为 `needs_user_input`）。

| 工具 | 输入要点 | 返回 |
| --- | --- | --- |
| `ask_choice` | `question` + 2–25 个 `{label, description?}`（2–5 个最佳）；`default` 须精确匹配某 label；`allow_free_text` 加备注框；`timeout_ms` 覆盖等待 | `answer`/`selected` 为所选 label |
| `ask_confirm` | `question`（写清对象和后果）；`default?` | `confirmed: boolean`，`answer` 为 `"yes"`/`"no"` |
| `ask_text` | `question`；`placeholder?` 格式提示；`default?` | `answer`（已 trim） |
| `ask_multi_select` | `question` + `options`；`min?`/`max?` 数量边界 | `selected: string[]`，`answer` 逗号连接 |
| `human_input_status` | `verbose?` | 能力/配置诊断，不提问不阻塞 |

## 给项目仓库加提问纪律（可选）

安装器已把提问纪律通过 MCP `initialize.instructions` 下发，模型开箱即知基本规则。想让**某个项目**里纪律更硬，把本仓库的 [AGENTS.md](AGENTS.md) 复制到那个项目根目录即可。核心判断标准：

> **只有在「决策价值 > 打断成本」时才提问。**
> 该问：关键歧义 / 不可逆的架构选择 / 方案同样合理靠偏好定 / 破坏性操作 / 用户可见行为有真实取舍。
> 不该问：小问题 / 能推断的自己定 / 能从仓库读出来的先读 / 答案不影响下一步的别问 / 问过的别再问。
> 拿不准的顺序：**先读代码 → 按仓库约定推断 → 仍影响重大才提问。**

## 配置与手工接入（想调才看）

环境变量（写进 `[mcp_servers.human_input.env]`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HIM_TIMEOUT_MS` | `300000` | 单题等待上限（1000–3600000） |
| `HIM_FALLBACK` | `return` | `return` \| `http` \| `off`，见下 |
| `HIM_HTTP_OPEN` / `HIM_HTTP_HOST` / `HIM_HTTP_PORT` | `1` / `127.0.0.1` / `0` | `http` 回退的浏览器/绑定/端口；**不要改成 0.0.0.0** |
| `HIM_MULTISELECT_MODE` | `array` | `text` 可降级为逗号分隔输入 |
| `HIM_AUTO_REJECT_MS` | `400` | 快于此值的 `decline` 判定为客户端自动拒绝 |
| `HIM_LOG` | `info` | 日志级别，全部走 stderr |
| `HIM_STRICT_STDOUT` | `1` | `0` = 关闭 console→stderr 重定向保险 |

**回退三模式**（客户端不支持 elicitation 时）：`return`（默认）把问题原样交还 agent 在对话里问，不阻塞；`http` 起一个 `127.0.0.1` 上的一次性表单页（128 位随机 token、用完即关、零外部资源）；`off` 直接报错。为什么用 HTTP 而不是终端提示？stdio 的 stdin 就是 JSON-RPC 通道，动它必坏协议——loopback HTTP 是唯一完全不碰消息流的回退。

**手工接入**（不想用插件安装器）：在 `%USERPROFILE%\.codex\config.toml` 加：

```toml
[mcp_servers.human_input]
command = "node"
args = ["<本仓库克隆位置>\\dist\\index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 600          # 必须 >= HIM_TIMEOUT_MS/1000
[mcp_servers.human_input.env]
HIM_FALLBACK = "return"
HIM_TIMEOUT_MS = "300000"
```

完整注释版见 `docs/codex-config.example.toml`。**手工注册与插件二选一**：并存会出现两份 `ask_*` 工具；想切到插件形态，跑 `.\Install.cmd --migrate`。

**从源码开发**：`npm install && npm run verify`（typecheck + 44 个单元测试 + 打包 + 冒烟，期望 `smoke test OK`）。测试用真 MCP `Client`/`Server` 经 `InMemoryTransport` 相连，只把"人"换成脚本；另有 `node scripts/smoke-stdio.mjs --manual` 人工模式。

---

## 附录 A：MCP elicitation 事实核查

网上教程很多在细节上是错的，以下每条都在本机实测过：

| 事项 | 结论 |
| --- | --- |
| MCP SDK 支持 elicitation？ | ✅ `@modelcontextprotocol/sdk@1.30.0` 的 `elicitInput(params, options)` |
| 返回结构 | `{ action: 'accept'\|'decline'\|'cancel', content? }`（`ElicitResultSchema`） |
| form 模式字段 | 只支持扁平原始类型：string / boolean / number / integer / array-of-enum |
| SDK 会静默丢字段吗 | ⚠️ 会。`properties` 走 Zod union + `.strip()`，未知键被丢掉而非报错；`test/schema.test.ts` 用 round-trip 深度相等断言把此事变成会失败的测试 |
| 客户端没声明能力时 | ⚠️ `elicitInput()` 直接 throw，不会发出去。本项目前置探测 + 对该 throw 兜底分类 |
| 默认超时 | ⚠️ 60 秒。人类读题不止 60 秒，本项目始终显式传 `timeout`（默认 300s） |
| SDK 会校验用户回答吗 | ⚠️ 会（Ajv）。越界选项抛 `McpError(InvalidParams)`，到不了本项目代码——所以有 `allow_free_text` |
| 取消能传递到 server 吗 | ✅ 客户端 abort → `notifications/cancelled` → `extra.signal` 被 abort |
| Codex CLI 支持 elicitation 吗 | ✅ 0.144.3 实测支持，**默认配置就能弹表单**；granular 的 `mcp_elicitations` 块通常不需要 |
| Codex 会渲染表单吗 | ✅ 实测原生渲染：模态框 + 选项 + 跳过/继续，来源标注 `just-ask-me` |

## 附录 B：已实测与未验证的边界

**已实测**：schema round-trip 无字段被 strip；stdio 被真实客户端拉起并完成 `elicitation/create` 往返；Codex Desktop 原生渲染 `ask_choice` 表单；`OnRequest` 策略下无需配置 `mcp_elicitations`；选项描述内联进 `message` 后如期显示。

**未验证**：Codex 对 `array` 字段（`ask_multi_select`）与布尔字段（`ask_confirm`）的渲染质量——若不理想，`HIM_MULTISELECT_MODE=text` 可降级；`enumNames` 是否被 Codex 采用（被忽略也不影响正确性）。详细验证记录见 [VALIDATION.md](VALIDATION.md)。

**已知取舍**：数字字段完全不用（Codex 有公开问题会把数值 elicitation 字段降级成审批提示）；`ask_multi_select` 故意不设 required，让空选走本项目自己的可读报错而非 SDK 校验；越界选项在 elicitation 路径上拿不到用户原话（Ajv 异常不含原始值），这正是 `allow_free_text` 的存在意义。

## 附录 C：仓库结构

```
JustAskMe/
├── src/                  # index(入口) server(tools+instructions) tools(提问流水线)
│                         # elicitation(能力探测) forms(schema 转换) http-form(回退页)
│                         # schemas/outcome(统一状态) config(HIM_* env) logger(stderr)
├── test/                 # 44 个单元测试：schema 往返 / 四工具 / 取消归类 / 超时 / HTTP 回退端到端
├── scripts/smoke-stdio.mjs   # 真实 stdio 子进程冒烟（--manual 人工模式）
├── plugins/just-ask-me/  # 发布产物：单文件 server（内联全部依赖）+ discuss-with-me 技能
├── docs/codex-config.example.toml
└── AGENTS.md             # 提问纪律（复制到你的项目根目录）
```

为什么是 TypeScript：MCP 官方 SDK 的 elicitation 支持最完整；Codex 是 Node 生态，`node` 零包装拉起；运行时依赖只有 `@modelcontextprotocol/sdk` 和 `zod` 两个。

---

## 许可

MIT。
