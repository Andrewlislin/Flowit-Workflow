<div align="center">

# Build with Flowit

## 用浮域创建 AI 工作室

**把你的专业方法，变成一个可以安装、由浮域运行、并能分发给他人的 AI 工作室。**

免费开发 · 本地优先 · 支持多个 Agent · 不必自己开发 Workflow Runtime

[返回浮域首页](../../README.md) · **中文** · [English](README.en.md)

</div>

---

## 你负责专业方法，浮域负责长期运行

很多专业工作真正有价值的部分，不是某一条 Prompt，而是：

```text
角色分工
+ 判断标准
+ 固定步骤
+ 中间产物
+ 审核规则
+ 失败后的恢复边界
```

Flowit Studio 把这些内容封装成一个声明式工作流应用。Creator 描述方法和交付标准，Flowit Workflow 负责持久状态、调度、重试、恢复、多 Agent 编排和 Host 集成。

```text
你的专业方法
      ↓
Flowit Studio Package
      ↓
Flowit Workflow Runtime
      ↓
Claude Code / Codex / WorkBuddy / 其他 Host
```

Studio 不等于一个裸 Agent Skill。Skill 通常告诉 Agent“会做什么”；Studio 还可以声明角色、流程图、Prompt 文件、质量边界、Host 兼容性、Runtime 范围、License 和 Package 身份。

## 从这里开始

| 入口 | 适合解决的问题 |
| --- | --- |
| [10 分钟创建第一个 Studio](quickstart.md) | 从零生成、校验、测试并打包一个最小 Studio |
| [Starter Studios](../../examples/studios/) | 从可复制的最小示例学习 Package、Preset 和角色文件 |
| [Studio SDK / CLI](sdk.md) | 查看 authoring API、CLI 命令和声明式边界 |
| [Studio Package Spec v1](package-spec.md) | 理解 Manifest、Runtime 兼容范围和 Package 信任边界 |
| [安装与 Runtime bootstrap](install.md) | 理解用户侧安装、Host 集成、Doctor 和不可重复授权 |
| [发布与分发](publish.md) | 理解打包、签名、License、SkillHub 和其他分发渠道 |

## Creator 工作流

```text
定义专业方法
      ↓
生成 Studio 骨架
      ↓
编辑角色 / Prompt / Preset
      ↓
validate
      ↓
test
      ↓
pack
      ↓
签名 / 分发 / 安装
```

当前 Creator CLI 提供 `init`、`inspect`、`validate`、`test`、`pack` 和 `skillhub` 等入口。Studio 默认是声明式 Package，不允许作者通过任意 JavaScript hook、安装脚本或自定义 Runtime URL 越过 Flowit 的信任边界。

## 两种产品入口，一个底层平台

```text
浮域 / Flowit
│
├── Flowit Workflow
│   └── 使用、运行和长期运营 AI 工作流
│
└── Build with Flowit
    └── 创建、验证、打包和分发 AI 工作室
              │
              ▼
       Flowit Studio Package
              │
              ▼
       Flowit Workflow Runtime
```

因此，这个仓库仍然只有一个工程中心：Flowit Workflow。Creator 文档拥有独立入口和叙事，但 SDK、Package Spec、安装器和 Runtime 继续在同一个 Monorepo 中演进。

`Flowit Studio SDK` 是当前 Creator Platform 的技术入口，不是长期唯一入口。未来可以在同一产品层下继续增加 Studio CLI 和 Studio Builder GUI，而不改变 Package 与 Runtime 的边界。

## 当前 Beta 能力边界

现在已经具备：

- 创建最小 Studio 骨架；
- 校验 Manifest、Package Tree、路径和声明式工作图；
- 通过与 Runtime 相同的 PresetDefinition 路径做编译测试；
- 生成经过再次校验的 `.flowit` 目录 Bundle；
- 描述 Publisher、License、Host 兼容性和 Runtime 范围；
- 对商业 Package 进行签名和本地 License 校验；
- 通过统一安装链准备 Package、兼容 Runtime、Host 集成和 Doctor readiness；
- 生成只包含数据的 SkillHub payload。

仍在演进：

- 通用的已安装 Studio `run` / `activate` / `studio_run` consumer API；
- 默认 Preset Registry 对 `StudioPackageStore` 的自动发现；
- 面向非程序员的 Studio Builder GUI；
- 完整的 Publisher 后台、市场、交易和自动交付体验。

因此，“安装完成”当前准确表示 Package、兼容 Runtime 与标准 Host 集成已经准备好并通过 Doctor；它不等于所有 Host 已经拥有统一的一键启动入口。

## 代码和产品边界

Creator 可以声明：

```text
Studio 身份与版本
角色和 Prompt
Preset 与工作图
输入和产物约定
支持的 Host
需要的 Skill 与权限
Runtime 兼容范围
License 类型
```

Flowit 保留控制权：

```text
Durable Runtime
Host Setup Provider
Package Tree 校验
Runtime bootstrap
Publisher trust
签名与 License 验证
安装事务
调度、重试、恢复和 Lease
```

这种分工让第三方 Creator 能生产 Studio，而不需要获得修改 Flowit Runtime 或 Agent Host 配置的任意权限。

## 下一步

第一次开发 Studio，直接进入 [10 分钟 Quickstart](quickstart.md)。已经有方法论或现成流程时，从 [research-starter](../../examples/studios/research-starter/) 复制结构，再逐步替换角色、Prompt 和工作图。
