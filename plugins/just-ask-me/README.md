# JustAskMe

让 Codex 能主动向你发起**结构化提问**并等你回答，体验接近 Claude Code 的 `AskUserQuestion`。

本目录是 Codex 插件本体，含三部分：

- **MCP server**（`server/index.mjs`）—— 提供 `ask_choice` / `ask_confirm` / `ask_text` / `ask_multi_select` / `human_input_status`
- **自动卡片技能**（`skills/ask-with-card/`）—— 已经需要提问时，用卡片代替普通文字，不增加提问
- **讨论模式技能**（`skills/discuss-with-me/`）—— 用户显式启用后，主动识别并征询重要决策

仓库安装器还会在用户级 `$CODEX_HOME/AGENTS.md` 中维护一段带标记的卡片路由规则，作为隐式技能发现之外的全局提示。重复安装会原位更新，不覆盖用户的其他规则。

## 运行前提

运行插件需要 **Node.js ≥ 20.11.0**；请单独确认 Node 已安装。

`server/index.mjs` 是用 esbuild 打包的**单文件**，已把 `@modelcontextprotocol/sdk` 与 `zod` 内联，**无需 `npm install`**。

## 配置

`.mcp.json` 只声明一条：

```json
{
  "mcpServers": {
    "human_input": {
      "command": "node",
      "args": ["./server/index.mjs"],
      "cwd": "."
    }
  }
}
```

`command` 保持裸 `node`，由本仓库的安装器改成本机绝对路径。

## 环境变量（可选）

在插件 `.mcp.json` 的 `mcpServers.human_input.env` 中配置，修改后重新安装插件：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HIM_TIMEOUT_MS` | `300000` | 单题等待上限 |
| `HIM_FALLBACK` | `return` | `return`（对话里问）/ `http`（本地表单页）/ `off`（报错） |
| `HIM_MULTISELECT_MODE` | `array` | 多选控件渲染不佳时改 `text` |
| `HIM_LOG` | `info` | 日志级别，全部走 stderr |

## 完整文档

见仓库根目录的 `README.md`。

`ask_choice` 默认在第一张同步 MCP 卡片增加可点击的“自定义回答”（设置 `allow_free_text: false` 可关闭）。选择预设选项直接返回 `answered`；只有选择“自定义回答”才打开第二张输入卡，原题和选项会在卡片中重现，提交后返回 `discussion`，模型先理解或解释回复。
