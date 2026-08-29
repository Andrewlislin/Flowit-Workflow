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

单独使用 Agent，通常是：

```text
你
 ↓
Agent
 ↓
做一次任务
 ↓
得到结果
```

加入浮域以后，可以变成：

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

浮域负责记住什么时候运行、哪一个 Session 负责哪一步、需要什么 Skill、哪些上下文可以传递、哪些步骤已经完成，以及失败以后从哪里恢复。

它**不会替代** Agent 自己的模型、登录、权限、沙箱、工作区信任或工具授权。真正执行工作的仍然是你选择的 Agent。

## 为什么不直接只用一个 Agent？

如果只是改一封邮件、总结一个 PDF、解释一个函数、修一个很小的 bug，直接用 WorkBuddy / Claude Code / Codex 通常更简单。

当任务开始出现下面这些特征时，浮域的价值会明显上升：

| 单独 Agent | 浮域 + Agent |
| --- | --- |
| “现在帮我做一下” | “以后一直按这个流程做” |
| 一个长 Prompt | 明确的步骤和检查点 |
| 你自己记得什么时候触发 | 可以用持久 Schedule 触发 |
| 常由一个 Session 从头做到尾 | 可以一个或多个 Session 分工 |
| 中断后可能重新解释上下文 | 已完成步骤和运行状态会保留 |
| 流程主要藏在 Prompt 里 | 流程变成可复用 Pipeline / Preset |
| 一个 Agent 自己写、自己审 | 可以把执行和 Review 拆开 |
| 换 Agent 往往重写整套 Prompt | 同一业务流程可绑定不同 Host |

一句话判断：

> **AI 帮我做一件事 → 直接用 Agent。**  
> **AI 要长期帮我运营一套工作 → 用浮域。**

## 四个核心优势

### 自然语言安装

普通用户不需要记安装命令。最推荐的方式，是直接让当前 Agent 帮你检查、安装、修复和验证浮域。

> 帮我安装浮域（Flowit Workflow）最新 beta 版，并适配你当前这个 Agent。先检查我的环境和已有配置，不要直接修改。先告诉我准备改哪些文件、增加什么权限，等我确认以后再安装。安装完成后做一次健康检查；如果还有必须在界面里手动完成的步骤，用最简单的话告诉我。

底层 Setup Framework 会先规划、再确认、再应用；遇到冲突配置会尽量 fail closed，而不是擅自覆盖。

### 多 Agent 协同

一个业务流程可以拆成不同角色，例如：

```text
WorkBuddy
搜集网页和办公资料
        ↓
Claude Code
深入分析
        ↓
Codex
技术检查 / Review
        ↓
WorkBuddy
整理最终报告
```

也可以只用一个 Session 承担所有角色。浮域既支持“一个 Agent 分阶段做”，也支持“多个 Agent 像团队一样协作”。

### 可恢复执行

复杂任务如果做到一半网络断开、进程重启或 Agent 暂时失败，浮域会保留 Pipeline、节点检查点、重试和 durable state。

用户感受到的区别是：**不是重新把整个任务讲一遍，而是继续从没完成的阶段推进。**

### 定时自动运行

浮域支持手动、每天、工作日和固定间隔的持久调度。用户可以直接说：

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

浮域 MCP 已经提供 Session 查询、Pipeline 创建/运行、Schedule 管理和 daemon 启动等能力，所以有工具权限的 Agent 可以把自然语言转换成真正的持久工作流操作。

<details>
<summary><strong>高级用户：直接安装 beta</strong></summary>

需要 Node.js `^22.19.0` 或 `>=24.0.0`。

```bash
npx @coaseedge/flowit-workflow@beta setup
```

也可以全局安装后使用 `flowit-workflow setup`。

技术标识保持稳定：

```text
npm: @coaseedge/flowit-workflow
CLI: flowit-workflow
```

</details>

## 在不同 Agent 里怎么安装、怎么用

### WorkBuddy：普通办公自动化的优先入口

第一次直接告诉 WorkBuddy：

> 帮我给当前 WorkBuddy 安装浮域。保留我现有的 MCP、Skill 和 Hooks，先给我看安装计划，确认以后再执行，最后做健康检查。

浮域会自动完成机器侧的四层连接：

```text
Flowit MCP
+
Bridge Worker Skill
+
WorkBuddy 生命周期 Hooks
+
持久 Bridge 工作目录
```

**WorkBuddy Desktop 目前还需要一个界面操作：**在 WorkBuddy 的自动化/定时任务里，新建一个周期运行 **Flowit Workflow Bridge Worker** 的任务。它可以理解成“收件员”：定期看看浮域有没有新任务，没有就什么也不做。

如果使用 Managed Driver，则不需要这个桌面轮询步骤。

典型场景：

> 用浮域给我建一个“行业日报”。每个工作日上午 8 点运行，关注 AI、企业软件和智能办公。先找最新信息，再筛选重要内容，再研究背景，最后做事实检查并生成给管理层看的中文摘要。不要自动发布。

这类工作适合 **内容工作室**。

### Claude Code：技术研究、长文档和大型代码任务

第一次告诉 Claude Code：

> 帮我把浮域安装到当前 Claude Code。不要散改我无关的设置，先给我看安装计划，确认后再装。安装完成后重新加载插件并检查是否正常。

浮域使用 Claude Code 的 skills-directory plugin 机制，个人范围默认安装在：

```text
~/.claude/skills/flowit-workflow/
```

其中包含浮域自己的 Skills、Hooks 和 MCP。也支持只安装到当前项目；Claude 自己的 workspace trust / MCP approval 仍然有效，浮域不会绕过。

典型场景：

> 用浮域帮我研究“这个系统是否值得迁移到事件驱动架构”。先规划问题，再找一手证据，再专门找反例，最后综合结论和限制。不要只讲好处。

这类工作适合 **深度研究**。

### Codex：实现、测试和独立 Review

第一次告诉 Codex：

> 帮我给当前 Codex 配置浮域。不要重写我的 config.toml；保留现有 model、sandbox、注释和其它 MCP。遇到已有同名配置就停下来告诉我。

浮域只管理自己的 Codex MCP 配置块，不重新格式化整份 TOML。

典型场景：

> 用浮域处理这个复杂 issue。先分析需求和影响范围，再制定方案，再实现，再测试，最后单独做 Review。Review 发现阻断问题就明确列出来，不要自动 merge。

这类工作适合 **AI 项目小组**。

### OpenCode V2：已有 OpenCode 开发环境的用户

第一次告诉 OpenCode：

> 帮我安装浮域，保留我的 JSONC 注释、model、agent 和其它 MCP。安装后检查 OpenCode Server 是否可访问。

浮域只修改自己的 `mcp.servers.flowit-workflow`，保留其它 JSONC 内容。

浮域**不会偷偷启动一个你不知道的 OpenCode 后台进程**。如果 Server 没运行，Doctor 会明确告诉你需要启动 OpenCode 的 Serve/Server 模式。

典型场景：

> 每天凌晨检查当前项目的依赖、失败测试、明显技术债和 TODO 风险。不要修改代码，只生成报告；第二阶段专门质疑第一阶段的结论。

### DeepSeek Harness：长期常驻型 Agent 系统

DSH 与前几个 Host 不同：浮域通过原生 Cordis plugin / patch 机制集成，而不是强行套 MCP。

用户可以说：

> 帮我安装浮域原生插件。先检查 Harness 当前配置，不覆盖其它 Cordis Plugin，安装后告诉我是否需要重启。

用户级安装会进入持久 home patch；项目级因为 Harness 当前没有项目持久 patch 层，会生成明确的项目 overlay，并提示如何启动。

典型场景：

> 每天研究我们关注的 20 个技术项目。发现重大版本变化时进一步分析。每个项目先搜证据，再找反例，再生成结论，保留历史。

### 豆包办公：GUI + Bridge 的办公方式

豆包办公当前使用 Flowit Bridge v2。浮域不会假装豆包存在没有公开文档支持的 Session Resume、Skill 安装或 Automation 管理 API。

机器侧安装完成后，用户在豆包办公界面完成：

```text
导入 / 启用 Flowit Worker Skill
        ↓
授权访问 Flowit Bridge 目录
        ↓
创建周期运行 Worker 的豆包定时任务
```

典型场景：

> 每个工作日下午 5:30 整理今天的项目资料、会议纪要和待办，输出已完成、未完成、明天要做什么和风险。先生成报告，不自动发给领导。

## 三个内置工作模式

普通用户不需要记 Preset ID。中文界面优先使用下面三个名称；稳定内部 ID 继续兼容。

| 工作模式 | 适合 | 稳定 ID |
| --- | --- | --- |
| **内容工作室** | 新闻、行业内容、日报、公众号草稿 | `content-studio` |
| **深度研究** | 市场、技术、竞品、政策研究 | `research-lab` |
| **AI 项目小组** | 编程、迁移、复杂方案、多步骤执行 | `agent-team` |

### 内容工作室

```text
发现热点
  ↓
选择题目
  ↓
研究资料
  ↓
写作
  ↓
查事实
  ↓
主编审核
```

默认停在人工可审查的最终稿，**不会自动发布到外部平台**。

### 深度研究

```text
规划问题
  ↓
搜证据
  ↓
找反例
  ↓
综合
  ↓
审核
```

强调一手证据、反方证据、不确定性和结论可追溯性。

### AI 项目小组

```text
规划
  ↓
调研
  ↓
执行
  ↓
Review
```

适合大型 Issue、重构、方案制定、迁移计划和复杂办公任务。

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
写作与事实检查
    ↓
最终摘要
```

适合市场、管理层情报、内容运营和企业内部日报。

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

可以让 WorkBuddy 或豆包办公每天固定时间整理文档、会议纪要、待办和风险，最终停在人工确认结果。

## 典型编程场景

### 大型 Issue / 模块重构

```text
Planner
分析目标和约束
    ↓
Researcher
阅读代码和依赖
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

可以每天凌晨检查依赖、失败测试、TODO、明显技术债和风险，只生成报告，不自动修改生产代码。

## 跨 Agent 协作

Preset 支持按角色绑定不同 Host 和不同 Session。例如：

```text
WorkBuddy
网页搜集 / GUI 操作
        ↓
Claude Code
深入分析
        ↓
Codex
代码与技术 Review
        ↓
WorkBuddy
管理层报告
```

当前 DSH 使用嵌入式 Flowit Core/store，因此 DSH 与 root-daemon Host 混在同一个 Preset 时会 fail closed；不要把暂时不可靠的拓扑伪装成已经支持。

## 安全边界

浮域提高的是**可靠性、组织性、可重复性和恢复能力**，不是让模型本身突然更聪明。

还需要注意：

- Host 的登录、权限、沙箱、workspace trust 和审批仍由 Host 控制；
- Setup 采用计划、确认、应用的方式，冲突时优先停止而不是覆盖；
- Preset 安装本身不会立刻执行 Agent 工作；
- 内容工作室默认不自动发布；
- Bridge 历史和 durable state 在卸载时会保守保留；
- 浮域使用 **at-least-once execution**，不宣称所有外部副作用都 exactly-once。

因此发送邮件、发布内容、删除文件、生产部署等不可逆操作，最好使用人工批准或宿主原生幂等能力。

## 技术架构

<img src="assets/flowit-architecture.svg" alt="浮域架构：Schedule、Host Event、Pipeline 和 Host Adapter" width="100%" />

Core 保存工作流事实和引用；Host Adapter 把这些事实翻译成各 Agent 原生的 Session、Skill、Context、Event 和生命周期操作。

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

### Host 支持状态

| Host | 集成方式 | 说明 |
| --- | --- | --- |
| DeepSeek Harness | Reference / Native | 原生 Cordis Plugin、Session、Skill、事件 |
| Claude Code | Pilot | Plugin + Hooks + MCP + resume |
| OpenCode V2 | Experimental | 官方 V2 SDK / HTTP Server |
| Codex | Experimental | App Server v2 + stdio MCP 配置 |
| WorkBuddy | Hybrid | Desktop Bridge 或 Managed Driver |
| 豆包办公 | Bridge | Bridge Worker，宿主 Automation 需人工配置 |

OpenCode 和 Codex 的能力声明保持保守，仍依赖 pinned contract 和真实 Host 验证。

## Durable execution 语义

```text
trigger observed
      ↓
durable admission / atomic claim
      ↓
worker lease + heartbeat
      ↓
dispatch / checkpoint / retry
      ↓
completed → bounded terminal receipt
failed    → retry or dead-letter
```

核心原则包括：

- Schedule claim 会原子校验 `active` 和当前 `nextRunAt`；
- Host event 在 listener 确认前先持久化；
- Pipeline 节点重试使用稳定 correlation key；
- active / retryable run 不会因为历史裁剪而丢失；
- terminal replay dedupe 有数量和时间边界；
- 没有宿主幂等性的外部副作用，在极端崩溃后仍可能重复。

## 存储与迁移

默认存储：

```text
~/.flowit-workflow/instances/<instanceId>/workflow.json
```

DSH-only Preset 默认使用 Harness 对应的嵌入式 store。

旧版数据库冲突时会 fail closed，不会擅自合并不同非空状态。

## 开发者入口

```bash
pnpm install
pnpm check:supply-chain
pnpm typecheck
pnpm test
pnpm test:host-contracts
pnpm build
```

| 命令 | 用途 |
| --- | --- |
| `pnpm check:supply-chain` | 拒绝 URL / Git / local-file / tarball 依赖来源 |
| `pnpm typecheck` | 严格 TypeScript 校验 |
| `pnpm test` | Unit、Recovery、Lease、Migration、Concurrency 测试 |
| `pnpm test:host-contracts` | 固定 Host 协议契约测试 |
| `pnpm build` | 构建发布包 |

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