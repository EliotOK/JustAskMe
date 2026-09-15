# JustAskMe

[English](README.en.md)

让 **Codex** 遇到需要你拍板的事时，弹出结构化表单等你回答——选择题、是/否确认、填空、多选，答完它再继续干活。体验对标 Claude Code 的 `AskUserQuestion`，但属于 Codex。

不改 Codex 源码，不做网页 hack，不要求常驻 GUI。

---

## 安装（约 3 分钟）

**你需要**：

- Windows + 已登录的 Codex CLI 或 Desktop
- [Node.js](https://nodejs.org/) ≥ 20.11.0
- [Python](https://www.python.org/downloads/) ≥ 3.10（仅安装器需要，装完不再用）

**整段复制进 PowerShell，回车：**

```powershell
git clone https://github.com/EliotOK/JustAskMe.git
cd JustAskMe
.\Install.cmd
```

就这样。安装器会自动：注册插件、绑定本机的 Node 路径、检查有没有旧配置冲突。如果检测到旧插件、手工 MCP 注册或本项目的旧技能副本，改跑：

```powershell
.\Install.cmd --migrate
```

安装器自包含，不依赖本机的 plugin-creator 辅助脚本。它先准备并检查新版本，再切换注册；迁移会注释旧 MCP 配置，将旧技能移到扫描目录之外。恢复副本保存在 `$CODEX_HOME/just-ask-me-backups/`（默认 `~/.codex/just-ask-me-backups/`）。失败时尝试恢复文件与注册；若 CLI 恢复失败，会明确报告并保留备份。旧插件源目录保留。含多行字符串的 TOML 配置需手动迁移，安装器会在写入前停止。

> macOS / Linux 使用 `python3 install.py`；本次自动验收在 Windows 完成，其他系统仍需实机验证。

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

- 说 **「讨论模式」** 或 **「边做边讨论」**——启用提问纪律：值得问的当场问、能自己查清的不烦你、答完立刻收束干活。这套纪律由内置的 **DiscussWithMe** 技能提供，详见[下文](#discusswithme-配套的讨论纪律)。
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
3. `node scripts/smoke-stdio.mjs` 绕开 Codex 直接测 server——通过说明协议链路可用；真实客户端界面、等待和通知仍需单独验证。

---

## 工具参考

所有 `ask_*` 返回**同一个结构**（`outputSchema` 已声明）。**`answered` 表示提交了答案，`discussion` 表示提交了仅含自由文字的回复**：

| `status` | 含义 | agent 应该做什么 |
| --- | --- | --- |
| `answered` | 用户回答了 | 用 `answer`/`selected`/`confirmed`/`free_text` 继续，不要重复问 |
| `discussion` | 用户仅提交自由文字 | 先解释追问；若文字已明确决定，直接采用 |
| `needs_user_input` | 尚未取得可用表单答案 | 把 `message` 里的问题和选项原样复述到对话里，等用户回复 |
| `declined` | 用户拒绝回答 | **不要再问**。选最保守方案并声明假设，或报告需要决策 |
| `cancelled` / `timeout` | 用户关掉 / 没人回答 | 未回答 ≠ 许可。破坏性操作上不要猜 |
| `invalid_response` | 答了但内容不可用 | 读 `message` 后简化重问或声明假设 |
| `unsupported` / `error` | 不支持 elicitation 且 fallback=off / 参数或服务端异常 | 读 `message` 与 `next_step` 照做 |

辅助字段：`client_elicitation`（客户端是否声明 elicitation 能力）、`auto_reject_suspected`（`decline` 快于 400ms，可能是客户端自动拒绝，耗时不能证明用户是否看到或拒绝——此时状态会被提升为 `needs_user_input`）。

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

## DiscussWithMe：配套的讨论纪律

JustAskMe 服务器解决的是"**怎么问**"——弹卡片、等答案、状态可靠；本仓库内置的 **DiscussWithMe** 技能（`plugins/just-ask-me/skills/discuss-with-me/`）解决的是"**何时问、问什么**"——没有它，工具只是个能弹窗的嘴，有了它，Codex 才有提问的分寸。

对 Codex 说「讨论模式」「边做边讨论」「重要选择先问我」即可激活（`$discuss-with-me` 亦同），当次会话内持续生效。它规定的核心纪律：

- **识别值得问的决策**：答案会实质改变目标、范围、方法或返工量的才问；低影响、易撤销、不涉及偏好的细节自主处理，一句话说明即可。
- **提问时机**：确认是决策点就当场发问，不要先把整个方案写完再问——那时用户改的成本已经变高，问题也从"你选哪条路"退化成"要不要推翻你"。
- **组织提问**：一次一个关键决策；选项公平呈现、推荐要有依据；允许用户自由填写时不另造"其他"选项。
- **调节深度**：「快聊一下」「展开讨论」「挑战一下我的想法」「先收束」随时切换，深度服务于决策，不取消收束条件。
- **让选项可追问**：用户不了解选项差别时，先解释再请求选择，不把"给我讲讲"当成授权。
- **围绕具体产物讨论**：抽象偏好难以表达时，做最小草稿或样例让你看效果再定，不用完整实现代替低成本示例。
- **收束执行**：信息足够就立即开工，不添加"最后一个问题"；最终交付记录实际方案与假设，不把讨论过程写进成品。

分工一句话：**服务器保证"问了必有答"，DiscussWithMe 保证"问得值得、答完就干"。**

**脱离 Codex 也能用**：技能本身是纯提示词，宿主无关。把 `plugins/just-ask-me/skills/discuss-with-me/` 复制到 `~/.agents/skills/discuss-with-me/`，Claude Code、ZCode、Cursor 等同样扫描该目录的 agent 就能识别同一套纪律——在它们那里，"同步提问工具"自动指宿主原生的选择题卡片（如 `AskUserQuestion`），没有卡片的环境则按技能规则降级为普通文字提问。仓库根目录的这份即为唯一正典，改动后请同步运行副本。

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


## 自由回答与发布验证

`ask_choice` 开启 `allow_free_text` 后，用户可只填写文字，不必选择预设方案。
仅文字返回 `discussion`；有选项的提交仍返回 `answered`。模型应结合完整文字理解回复，
先处理追问和“暂不执行”等限制，不能把任一提交自动视为操作授权。
HTTP 备用表单会按多选数量校验；无效提交保留页面和已填内容，修正后可继续提交。

开发验证：`npm ci`、`npx playwright install chromium`、`npm run verify`。
其中安装器测试使用临时用户目录及模拟 CLI，浏览器测试使用真实 Chromium。
这些测试不代替真实 Codex 的新用户安装、卡片展示、长时间等待和桌面通知验收。
通知及客户端允许的最长等待时间受 Codex 和操作系统配置影响，本插件不保证一定弹出系统通知。
