# 浮域（Flowit Workflow）

**浮域** 是 Flowit Workflow 的中文产品名。

它把 WorkBuddy、Claude Code、Codex、OpenCode、DeepSeek Harness、豆包办公等 Agent 连接到同一套可持久运行的工作流系统中，负责定时、分工、检查点、失败恢复、跨 Session 编排和工作模式复用。

技术标识保持兼容：npm 包继续使用 `@coaseedge/flowit-workflow`，命令继续使用 `flowit-workflow`。

## 现成工作模式

| 工作模式 | 适合 | 稳定技术标识 |
| --- | --- | --- |
| **内容工作室** | 新闻、公众号、行业内容、日报 | `content-studio` |
| **深度研究** | 市场研究、技术研究、竞品、政策分析 | `research-lab` |
| **AI 项目小组** | 编程、方案、复杂办公任务 | `agent-team` |

### 内容工作室

```text
发现热点 → 选择题目 → 研究资料 → 写作 → 查事实 → 主编审核
```

默认停在人工可审查的最终稿，不自动发布。

### 深度研究

```text
规划问题 → 搜证据 → 找反例 → 综合 → 审核
```

### AI 项目小组

```text
规划 → 调研 → 执行 → Review
```

中文工作模式名可以直接作为浮域的 Preset 引用；原英文名称和稳定内部 ID 继续兼容。

更完整的中文命名与产品说明见 [`docs/zh-CN.md`](docs/zh-CN.md)。

英文技术文档见 [`README.md`](README.md)、[`docs/setup.md`](docs/setup.md) 和 [`docs/presets.md`](docs/presets.md)。
