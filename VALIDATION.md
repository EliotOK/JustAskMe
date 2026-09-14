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
