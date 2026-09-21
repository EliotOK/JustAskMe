---
name: ask-with-card
license: MIT
description: 当 Codex 已经需要向用户提出澄清、选择、确认、多选或开放问题时，使用 JustAskMe 的互动卡片代替普通文字提问。只改变提问方式，不主动增加问题、不降低提问门槛；普通回答、状态说明以及可自行推断的细节不触发。
---

# 卡片提问

本技能只负责把**已经确定需要提出的问题**改用互动卡片呈现。它不启用讨论模式，不要求主动寻找更多决策点，也不改变何时应该打断用户。

## 选择工具

当当前环境提供 `human_input` 工具时：

- 少量互斥选项用 `ask_choice`，为每个选项写清简短后果。用户可能需要补充、质疑或提出替代方案时，设置 `allow_free_text: true`。
- 是/否问题用 `ask_confirm`，尤其要写清破坏性或不可逆操作的具体对象和后果。
- 无法合理枚举的输入用 `ask_text`。
- 需要选择一个子集时用 `ask_multi_select`。

不要为使用卡片而把本可自行查明或安全推断的事项改成问题。答案不会改变下一步行动时，不要提问。

## 处理结果

- `answered`：结合 `selected`、`free_text`、`confirmed` 和 `answer` 理解完整回复，然后继续。
- `discussion`：读取 `free_text`；追问先解释，文字已明确决定时直接采用，不要求重新点选。
- `needs_user_input`：改用普通消息复述返回的题面和选项，等待用户回复。
- `declined`：不要重复提问；采用安全默认值并说明，或报告必须由用户决定。
- `cancelled` / `timeout`：没有获得许可；破坏性操作不得继续猜测。
- `invalid_response` / `unsupported` / `error`：按照返回的 `message` 和 `next_step` 处理。

如果当前环境没有 `human_input` 或其他同步提问卡片，使用普通文字提出同一个问题，不声称已经显示卡片。
