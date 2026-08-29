<div align="center">

<img src="assets/flowit-hero.svg" alt="浮域（Flowit Workflow）— CoaseEdge 出品的多 Agent 持久工作流编排平台" width="100%" />

<br />

[![CI](https://github.com/Andrewlislin/Flowit-Workflow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Andrewlislin/Flowit-Workflow/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-D22128?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%5E22.19%20%7C%20%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Release](https://img.shields.io/badge/release-v0.5.0--beta.1-F59E0B?style=flat-square)](https://github.com/Andrewlislin/Flowit-Workflow/releases/tag/v0.5.0-beta.1)

# 浮域（Flowit Workflow）

**把你已经在使用的 AI Agent，从“一次性助手”变成可长期运行、可分工、可恢复、可定时执行的 AI 工作流。**

由 **CoaseEdge / 高斯边界** 出品。

**中文（默认）** · [English](README.en.md) · [安装与修复](docs/setup.md) · [现成工作模式](docs/presets.md) · [技术架构](docs/architecture.md)

</div>

---

## 浮域是什么？

WorkBuddy、Claude Code、Codex、OpenCode、DeepSeek Harness、豆包办公等 Agent，本来就很会“做一件事”。

浮域解决的是另一个问题：**怎样让这些 Agent 长期、重复、分步骤地把一套工作稳定做下去。**

```text
定时 / 事件 / 手动开始
          ↓
         规划
          ↓
         调研
          ↓
         执行
          ↓
         审核
          ↓
       人工确认
```

浮域负责记住什么时候运行、哪个 Session 负责哪一步、需要什么 Skill、哪些上下文可以传递、哪些步骤已经完成，以及失败以后从哪里恢复。

它**不会替代** Agent 自己的模型、登录、权限、沙箱、工作区信任或工具授权。真正执行工作的仍然是你选择的 Agent。

## 什么时候值得用浮域？

如果只是改一封邮件、总结一个 PDF、解释一个函数、修一个很小的 bug，直接用 WorkBuddy / Claude Code / Codex 通常更简单。

当任务开始具备下面这些特征时，浮域的价值会明显上升：

- 每天、每周都要重复；
- 要经过多个固定步骤；
- 需要独立 Review 或第二轮检查；
- 任务很长，中断后不能从头再来；
- 不同 Agent 各做自己擅长的部分；
- 希望把一套 Prompt 沉淀成团队可复用的标准流程。

一句话判断：

> **AI 帮我做一件事 → 直接用 Agent。**  
> **AI 要长期帮我运营一套工作 → 用浮域。**

## 和一般 Harness / Agent Team 有什么不同？

可以把三者理解成三个层级：

- **Harness**：让 Agent 能运行，负责模型、工具、Session、宿主能力。
- **Agent Team**：让多个 Agent 按角色协作，负责 Planner / Researcher / Coder / Reviewer 等分工。
- **浮域**：在 Agent / Agent Team 之上增加一层**持久工作流控制面**，负责调度、状态、恢复、跨 Host、检查点和可靠执行。

| 能力 | 一般 Harness | 一般 Agent Team | **浮域（Flowit Workflow）** |
| --- | --- | --- | --- |
| 核心定位 | Agent Runtime / 工具环境 | Multi-Agent Coordination | **Durable Agent Workflow Control Plane** |
| 单 Agent 运行 | 强 | 依赖底层 Harness | 不替代 Harness，复用现有 Agent |
| 多角色 / 多 Agent | 通常有限 | 强 | **强，可单 Session 也可多 Session** |
| 流程状态 | 多在 Session / 进程内 | 常由 Manager Agent 记忆 | **Pipeline / Run / Node 状态持久化** |
| 定时运行 | 常需 cron / 外部系统 | 通常不是核心 | **原生 Durable Schedule** |
| DAG / 固定流程 | 可选 | 常以对话和角色交接为主 | **原生 Pipeline DAG + Checkpoint** |
| 中断恢复 | Session 级为主 | 依赖 coordinator / manager | **Lease + Retry + Checkpoint + stale recovery** |
| 事件可靠性 | 视实现而定 | 常依赖进程内队列 | **Durable Event Admission，先落盘再执行** |
| 跨 Host | 通常绑定自身 | 多数在同一框架内 | **WorkBuddy / Claude / Codex / OpenCode / DSH / 豆包** |
| Skill 约束 | Host 内部 | 常靠 Prompt 约定 | **执行时 Skill Binding，无法建立时 fail closed** |
| Context 传递 | Transcript / Memory | Agent 间消息 | **Context Graph：传引用，不自动复制权限和完整聊天** |
| 多 Worker 竞争 | 通常假设单实例 | 很少作为核心问题 | **原子 claim、lease、heartbeat、fencing** |
| Bridge / 弱 API Host | 需要自行适配 | 通常能力有限 | **Bridge v2：requestId / idempotencyKey / receipt / lease** |
| 模板产品化 | Skill / Agent Template | Team Template | **Preset = 角色 + Prompt + Artifact + Graph + Host + Schedule** |
| 安装运维 | 各 Host 各自处理 | 通常没有统一层 | **setup / doctor / repair / uninstall** |
| 外部副作用语义 | 经常未明确 | 经常未明确 | **明确 at-least-once，不虚构 generic exactly-once** |
| 最适合 | 一次 Agent 执行 | 临时多 Agent 协作 | **长期、重复、可恢复、跨 Agent 的业务流程** |

更简单地说：

```text
Harness    = 让一个 Agent 能运行
Agent Team = 让多个 Agent 能合作
浮域        = 让 Agent / Agent Team 作为长期业务系统可靠运行
```

## 四个核心优势

### 自然语言安装

普通用户不需要记安装命令。最推荐的方式，是直接让当前 Agent 帮你检查、安装、修复和验证浮域：

> 帮我安装浮域（Flowit Workflow）最新 beta 版，并适配你当前这个 Agent。先检查我的环境和已有配置，不要直接修改。先告诉我准备改哪些文件、增加什么权限，等我确认以后再安装。安装完成后做一次健康检查；如果还有必须在界面里手动完成的步骤，用最简单的话告诉我。

Setup Framework 会先规划、再确认、再应用；遇到配置所有权冲突时优先停止，而不是擅自覆盖。

### 多 Agent 协同

```text
WorkBuddy
网页 / 办公操作
      ↓
Claude Code
深入分析
      ↓
Codex
技术实现 / Review
      ↓
WorkBuddy
整理最终报告
```

也可以只用一个 Session 承担所有角色。浮域把“角色边界”和“Session 数量”分开：先用一个 Agent 分阶段做，稳定后再拆成真正的多 Agent 团队。

### 可恢复执行

复杂任务如果做到一半网络断开、进程重启或 Agent 暂时失败，浮域会保留 Pipeline、节点检查点、重试、lease 和 durable state。

用户感受到的区别是：**不是重新解释整个任务，而是从没完成的阶段继续。**

### 定时自动运行

支持手动、每天、工作日和固定间隔的持久调度。用户可以直接说：

> 每天早上 8 点运行。

> 每个工作日上午 9:30 运行。

> 每两小时检查一次。

Schedule 是浮域自己的持久状态，不依赖 Agent “记得明天再做”。

## 最简单的开始方式：直接对 Agent 说人话

安装好以后，可以继续对 Agent 说：

> 帮我看看浮域现在有哪些工作流。

> 用当前会话给我建一个深度研究。

> 现在运行“认证模块重构”这个工作流。

> 把“行业日报”改成每个工作日上午 8 点运行。

浮域 MCP 提供 Session 查询、Pipeline 创建/运行、Schedule 管理和 daemon 启动等能力，有工具权限的 Agent 可以把自然语言转换成真正的持久工作流操作。

<details>
<summary><strong>高级用户：直接安装 beta</strong></summary>

需要 Node.js `^22.19.0` 或 `>=24.0.0`。

```bash
npx @coaseedge/flowit-workflow@beta setup
```

技术标识保持稳定：

```text
npm: @coaseedge/flowit-workflow
CLI: flowit-workflow
```

</details>

## 六个 Host 怎么用

| Host | 浮域集成方式 | 普通用户最适合的场景 | 仍需注意 |
| --- | --- | --- | --- |
| **WorkBuddy** | MCP + Hooks + Bridge / Managed Driver | 日报、网页研究、办公自动化、GUI 操作 | Desktop Bridge 需要 WorkBuddy 原生 Automation 周期调用 Worker |
| **Claude Code** | skills-directory Plugin + Hooks + MCP | 技术研究、长文档、大型重构 | 项目 scope 仍受 Claude workspace trust / MCP approval 控制 |
| **Codex** | App Server v2 + MCP config | 实现、测试、代码 Review | 保留 Codex 自身 sandbox / approval 边界 |
| **OpenCode V2** | 官方 V2 SDK / HTTP Server | 夜间代码检查、开发流程 | 浮域不会偷偷启动 OpenCode Server |
| **DeepSeek Harness** | 原生 Cordis Plugin | 常驻研究、长时间后台任务 | DSH 使用嵌入式 Flowit store；混合 root-daemon Host 会 fail closed |
| **豆包办公** | Bridge Worker | 办公日报、会议/文档整理 | Skill 启用和豆包原生定时任务仍需宿主 UI 操作 |

详细安装、Doctor、Repair、Uninstall 见 [docs/setup.md](docs/setup.md)。

## 三个内置工作模式

| 工作模式 | 流程 | 适合 |
| --- | --- | --- |
| **内容工作室** | 发现热点 → 选择题目 → 研究资料 → 写作 → 查事实 → 主编审核 | 新闻、行业内容、日报、公众号草稿 |
| **深度研究** | 规划问题 → 搜证据 → 找反例 → 综合 → 审核 | 市场、技术、竞品、政策研究 |
| **AI 项目小组** | 规划 → 调研 → 执行 → Review | 编程、迁移、复杂方案、多步骤执行 |

`内容工作室` 默认停在人工可审查的最终稿，**不会自动发布到外部平台**。

Preset 支持一个 Session 承担全部角色，也支持按角色绑定不同 Session、Host 和 Skill；还能创建 daily / weekdays / fixed interval 的 durable Schedule。详见 [docs/presets.md](docs/presets.md)。

## 典型办公场景

### 每日行业日报

```text
工作日 08:00
    ↓
发现热点
    ↓
筛选重点
    ↓
深度研究
    ↓
写作 + 事实检查
    ↓
管理层摘要
```

### 每周竞品研究

```text
研究计划
  ↓
搜集 A / B / C 公司证据
  ↓
找反例和信息缺口
  ↓
比较产品 / 融资 / 招聘 / 营销
  ↓
结论、风险、机会、下周关注点
```

### 项目工作汇总

WorkBuddy 或豆包办公可以每天固定时间整理文档、会议纪要、待办和风险，最终停在人工确认结果。

## 典型编程场景

### 大型 Issue / 模块重构

```text
Planner
目标和约束
    ↓
Researcher
代码和依赖
    ↓
Executor
实现和测试
    ↓
Reviewer
独立检查阻断问题
    ↓
Human approval
```

对于两分钟的小修复，直接用 Codex 更简单；对于几十分钟甚至更长、需要多阶段恢复和 Review 的任务，浮域更有意义。

### 夜间代码健康检查

每天凌晨检查依赖、失败测试、TODO、明显技术债和风险，只生成报告，不自动修改生产代码。

## 安全边界

浮域提高的是**可靠性、组织性、可重复性和恢复能力**，不是让模型本身突然更聪明。

需要注意：

- Host 的登录、权限、沙箱、workspace trust 和审批仍由 Host 控制；
- Setup 采用 plan → confirm → apply，配置冲突时优先停止；
- Preset 安装本身不会立刻执行 Agent 工作；
- 内容工作室默认不自动发布；
- Bridge 历史和 durable state 在卸载时会保守保留；
- 浮域使用 **at-least-once execution**，不宣称所有外部副作用都 exactly-once。

发送邮件、发布内容、删除文件、生产部署等不可逆操作，最好使用人工批准或宿主原生幂等能力。

## 技术架构

<img src="assets/flowit-architecture.svg" alt="浮域架构：Schedule、Host Event、Pipeline 和 Host Adapter" width="100%" />

```text
Schedule / Host Event
        ↓
Durable admission
        ↓
Pipeline / Work Graph
        ↓
Checkpoint / Retry / Lease
        ↓
Host Adapter
        ↓
WorkBuddy / Claude Code / Codex / OpenCode / DSH / 豆包办公
```

Core 保存工作流事实和引用；Host Adapter 把这些事实翻译成各 Agent 原生的 Session、Skill、Context、Event 和生命周期操作。

详细执行模型见 [docs/architecture.md](docs/architecture.md)。

## 开发者入口

```bash
pnpm install
pnpm check:supply-chain
pnpm typecheck
pnpm test
pnpm test:host-contracts
pnpm build
```

## 更多文档

- [安装、Doctor、Repair、Uninstall](docs/setup.md)
- [内置工作模式与定时激活](docs/presets.md)
- [架构与执行模型](docs/architecture.md)
- [AgentAdapter 契约](docs/adapter-contract.md)
- [Host Adapter 能力](docs/host-adapters.md)
- [Bridge Protocol v2](integrations/bridge/PROTOCOL.md)
- [中文品牌与命名约定](docs/zh-CN.md)

## License

Apache License 2.0。详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

Copyright © 2026 CoaseEdge.
