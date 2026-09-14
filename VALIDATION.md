# VALIDATION.md

本文件记录**实际执行过**的验证，而不是设计意图。每条都给出可复现的命令。

## 环境

| 项 | 值 |
| --- | --- |
| 验证日期 | 2026-09-14 |
| OS | Windows 11 |
| Node.js | v24.15.0 |
| npm | 12.0.1 |
| TypeScript | 7.x（tsc） |
| esbuild | 0.28.2 |
| `@modelcontextprotocol/sdk` | 1.30.0 |
| zod | 4.6.5 |
| codex-cli | 0.144.3 |

## 验证结果

### 1. 类型检查

```powershell
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.test.json
```
源码与测试全部通过，exit 0。

### 2. 单元测试

```powershell
npm test
```

```
ℹ tests 41
ℹ pass 41
ℹ fail 0
```

覆盖：schema round-trip（断言 SDK 不会静默 strip 字段）、正常回答路径
（choice / confirm / text / multi_select）、decline / cancel / abort 归类、
超时与每调用覆盖、loopback 表单页端到端（含 token 校验返回 403、超时后端口不再监听）。

测试使用**真实** MCP `Client` 与 `Server`，经 `InMemoryTransport.createLinkedPair()` 相连，
只把"人"换成脚本。

### 3. 插件打包产物可独立运行

```powershell
npm run build:plugin
```

`esbuild` 把 `src/index.ts` 连同 `@modelcontextprotocol/sdk` 与 `zod` 打成单文件
`plugins/codex-human-input-mcp/server/index.mjs`（约 1.34 MB，内联全部依赖；`node_modules` 为 60.1 MB）。

**隔离验证**：把该文件复制到项目目录之外（`%TEMP%\him-bundle-test\`，同级无 `node_modules`），
再对它跑 stdio 冒烟：

```powershell
node scripts/smoke-stdio.mjs <项目外的 index.mjs 路径>
```

结果：`smoke test OK`，全部 PASS。

这一条同时证明了 **Ajv 的代码生成在 bundle 内仍能正常工作**——因为插件 tool 的
`status=answered` 需要服务端用 Ajv 按 `requestedSchema` 校验用户回答后才可能产出。

### 4. 官方插件校验器

```powershell
python %USERPROFILE%\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py plugins/codex-human-input-mcp
```

```
Plugin validation passed: ...\plugins\codex-human-input-mcp
```

### 5. 在真实 Codex 中的端到端表现

已验证（2026-09-14，Codex Desktop）：

- `codex mcp list` 显示 `human_input` 为 `enabled`；
- `codex doctor --json` 报告 `"mcp servers"` 计数增加、`"config.toml parse": "ok"`；
- 模型调用 `ask_choice` 后，**Codex 界面弹出原生模态表单**（下拉选择 + 跳过/继续），
  来源标注 `codex-human-input-mcp`；
- `message` 中的选项描述如期显示（MCP form schema 不支持 per-option description，
  故描述是内联进 `message` 的）；
- 在 `approval policy = OnRequest`（非 granular、未配置 `mcp_elicitations`）下表单照常弹出
  → **`mcp_elicitations = true` 并非必需**。

### 6. 校验和

```powershell
Get-FileHash -Algorithm SHA256 plugins/codex-human-input-mcp/**/*
```
见仓库根目录 `SHA256SUMS.txt`。

## 未验证

诚实边界，以下项目**没有**实测：

- **`ask_multi_select`（array 类型字段）在 Codex 中的渲染质量**。理论上渲染成多选控件，
  未实测。若渲染不理想，设 `HIM_MULTISELECT_MODE=text` 降级为逗号分隔文本框。
- **`ask_confirm`（boolean 字段）在 Codex 中的渲染**。理论上渲染成是/否控件，未实测。
- **`install.py` 的端到端流程**。脚本结构对齐已验证的 `codex-turn-meter-package`，
  但本仓库尚未在干净机器上跑过完整安装。

---

## 第二轮验证（2026-09-14，修复后回归）

本轮改动：elicitation 能力预检对齐 SDK 门（truthy `elicitation`）、修正 `no_capability`
归类正则（SDK 实际文本为 "does not support elicitation"）、confirm 无默认值时不再伪造
"Default: no"、HTTP 兜底表单为 choice/confirm/多选加 `required` 防空提交、`install.py`
增加手工注册冲突检测与 `--migrate`。

### 1. 类型检查 + 全量测试 + 冒烟

```powershell
npm run verify    # typecheck + tsc build + esbuild + 44 tests + plugin smoke
```

```
ℹ tests 44
ℹ pass 44
ℹ fail 0
smoke test OK
```

新增 3 个测试：confirm 无默认值不产出 `default` 键与 "Default:" 文案（含 SDK 往返）、
旧式 `elicitation: {}` 客户端在 `human_input_status` 中报告为支持、旧式客户端的
`ask_choice` 经 elicitation 正常回答。既有 confirm 测试改为断言表单含
`name="confirm" value="true" required`；多选（min=1）断言 checkbox 带 `required`。

### 2. SDK 能力门核对（决定修复方案的依据）

核对 `@modelcontextprotocol/sdk@1.30.0` 源码：

- `server/index.js` `assertCapabilityForMethod('elicitation/create')` 只要求
  `_clientCapabilities?.elicitation` 为真，**不检查 `.form`**；
- `types.js` 的 `ElicitationCapabilitySchema` 带 `z.preprocess`，把裸 `elicitation: {}`
  归一化为 `{ form: {} }`，且该解析发生在 initialize 消息解析层
  （`server/index.js:261` 存储的是已解析的 params）。

结论：旧式声明在真实链路上本就被 SDK 归一化兼容；我们的预检改为与 SDK 相同的门是
防御性对齐，覆盖奇异 capability 形状，无行为回退风险。

### 3. install.py 迁移逻辑单元验证

`python -m py_compile install.py` 通过；以临时 `config.toml` 驱动：

- `[mcp_servers.human_input]` + 其 `.env` 子表被完整定位并注释，前后无关表
  （`[something_else]`、`[other_table]`）原样保留；
- 二次执行幂等（识别已迁移标记，不再改动）；
- 无该段的配置文件原样不动；
- 存在手工 server 且未加 `--migrate` 时按预期 `SystemExit` 拒绝安装。

**线上事故与修复**：首次真机运行暴露了一个单测没覆盖的边界——当目标段是文件的
**最后一个表**（其后没有无关表头）时，区间尾端停留在表头行，只注释了一行，导致
`command`/`args` 等键悬空挂到前一个表下。已修复（用「是否遇到无关表头」而非
「行首是否为 `[`」判定 EOF 情形），并补 4 个回归用例：EOF 收尾、后随无关表、
空段紧跟无关表头、段不存在；每个用例同时断言注释后 TOML 可解析、
`mcp_servers.human_input` 消失、二次执行幂等。真机 `config.toml` 已手工修复为
预期迁移态并经 `tomllib` 验证。

### 4. 回归未覆盖

- 本轮改动后的**真实 Codex Desktop 弹窗回归**未重跑（第 5 节的端到端结论仍基于上一轮）；
  弹窗路径的代码（`forms.ts` 消息文本、`elicitation.ts` 预检）已由新增单测覆盖，
  但表单在 Codex UI 中的实际渲染建议在下一轮实测时复核。

---

## 第三轮验证（2026-09-14，skill 改名 discuss-with-me）

改动：技能 `discussion-mode` → `discuss-with-me`（目录、frontmatter `name`、触发词
`$discuss-with-me`，界面显示名 "Discuss with me"）；版本 0.1.0 → 0.1.1；`install.py`
同时识别新旧两个技能名做冲突归档，并在复制后清理目标树里残留的旧名技能目录
（`remove_stale_target_skill`），避免改名后插件里两份并存。

### 1. 全量回归

`npm run verify`：44/44 通过 + 插件冒烟 `smoke test OK`（新 bundle 含改名后的技能路径）。

### 2. install.py 行为验证

- `py_compile` 通过；
- 临时目录驱动：新旧两个名字的手工技能目录均被归档为 `<名字>.bak-<时间戳>`；
- 目标树同时存在新旧技能目录时，仅清除旧名 `skills/discussion-mode`，保留新名；
- 既有 4 个 section-span 回归用例不受影响。

### 3. 未覆盖

- 改名后的真实 Codex 端到端（弹窗 + `$discuss-with-me` 触发）待用户在新任务中实测。
