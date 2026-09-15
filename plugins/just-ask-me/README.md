# JustAskMe

让 Codex 能主动向你发起**结构化提问**并等你回答，体验接近 Claude Code 的 `AskUserQuestion`。

本目录是 Codex 插件本体，含两部分：

- **MCP server**（`server/index.mjs`）—— 提供 `ask_choice` / `ask_confirm` / `ask_text` / `ask_multi_select` / `human_input_status`
- **技能**（`skills/discuss-with-me/`）—— 规定什么时候该问、什么时候自己决定

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

开启 `allow_free_text` 后可以只提交文字。仅文字返回 `discussion`，模型先理解或解释回复；选项与文字一起提交时，文字中的限制仍须遵守。
