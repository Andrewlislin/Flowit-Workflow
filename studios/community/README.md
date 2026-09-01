# Flowit Community Studios

[浮域产品首页](../../README.md) · [Build with Flowit](../../docs/studio/README.md) · [Creator Examples](../../examples/studios/)

这个目录面向 **Flowit 使用者**，包含随仓库维护的现成社区 Studio。它们用于展示具体工作模式，而不是承担 SDK Reference 或最小教学示例的职责。

```text
studios/community/
├── agent-team/
├── content-studio/
└── research-lab/
```

## 现有 Studio

### AI 项目小组

```text
Planner
  ↓
Researcher
  ↓
Executor
  ↓
Reviewer
```

适合编程、迁移、复杂方案和多阶段执行。

### 内容工作室

```text
Radar
  ↓
Strategist
  ↓
Researcher
  ↓
Writer
  ↓
Fact-checker
  ↓
Editor
```

适合行业内容、日报和文章草稿。默认目标是人工可审核产物，不代表自动外部发布。

### 深度研究

```text
Planner
  ↓
Researcher
  ↓
Skeptic
  ↓
Synthesizer
  ↓
Reviewer
```

适合市场、技术、竞品与政策研究。

## 和 `examples/studios/` 的区别

```text
studios/community/
= 面向用户的现成工作室
= 强调具体业务价值和完整角色流程

examples/studios/
= 面向 Creator 的 Starter
= 强调最小结构、复制和学习
```

两个目录都遵守同一个 [Studio Package Spec v1](../../docs/studio/package-spec.md)，但不能承担同一个文档中心。

Creator 应从 [Starter Examples](../../examples/studios/) 或 [Quickstart](../../docs/studio/quickstart.md) 开始；普通用户应先从根 README 理解浮域，再选择适合自己的工作模式。

---

## English

This directory contains ready-made community Studios maintained as user-facing product examples:

- `agent-team` for multi-stage project work;
- `content-studio` for research, writing, fact-checking and editorial review;
- `research-lab` for evidence, counter-evidence, synthesis and review.

Creator tutorials live in [`examples/studios/`](../../examples/studios/). Both directories use the same Package Spec but serve different audiences.
