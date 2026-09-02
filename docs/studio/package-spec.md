# Flowit Studio Package Spec v1

[Build with Flowit 首页](README.md) · [English](package-spec.en.md) · [Studio SDK](sdk.md) · [安装](install.md)

**Flowit Studio** 是运行在本地 Flowit Runtime 上的可安装工作流应用。

它与裸 Agent Skill 有意区分：Studio 可以描述角色、Preset、模板、质量规则、Host 兼容性、License 和 Runtime 要求；Flowit 继续拥有持久执行与 Host 集成。

## 产品边界

Studio Package 是应用格式，不是分发渠道。

同一个 Package 可以来自：

```text
SkillHub
Publisher 网站
GitHub
企业 Registry
本地文件
```

所有来源最终都必须经过同一套 Flowit Package / Trust Boundary。分发渠道不能替代 Package Tree 校验、Publisher trust、签名、License 或 Runtime 兼容检查。

首个公共 Manifest 是：

```text
flowit.package.json
schemaVersion: 1
```

## Manifest 示例

```json
{
  "schemaVersion": 1,
  "id": "acme.saas-intelligence",
  "displayName": "SaaS 竞品情报工作室",
  "publisher": {
    "id": "acme-research",
    "displayName": "ACME Research"
  },
  "version": "1.0.0",
  "runtime": {
    "id": "flowit-workflow",
    "version": ">=1.0 <2",
    "bootstrap": "official"
  },
  "supportedHosts": ["claude-code", "codex", "workbuddy"],
  "entryPreset": "saas-intelligence",
  "license": {
    "type": "commercial-perpetual"
  }
}
```

核心字段承担不同语义：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | Manifest Schema 版本 |
| `id` | 全局稳定的 Studio 身份 |
| `displayName` | 面向用户显示的名称 |
| `publisher` | Publisher 身份，不等于渠道身份 |
| `version` | Studio Package 版本 |
| `runtime` | 需要的 Flowit Runtime 与兼容范围 |
| `supportedHosts` | Studio 声明支持的 Agent Host |
| `entryPreset` | Package 的入口声明式 Preset |
| `license` | 本地安装和商业授权类型 |

## Runtime bootstrap 规则

第三方 Package 可以声明需要 Flowit，但**不能定义 Flowit 如何安装**。

在 v1 中：

```text
runtime.id        = flowit-workflow
runtime.bootstrap = official
```

Package 格式有意不提供：

```text
installScript
任意 executable hook
Publisher 控制的 Runtime URL
自定义 Host 配置脚本
```

这样用户可以做一次产品级决定——“安装这个 Studio”——同时由官方 bootstrap 层解析共享 Runtime 和当前 Host 的标准集成。Publisher 不会因此取得直接修改 Agent Host 配置的任意权限。

## 一次安装意图，有限授权

用户明确要求安装某个 Studio 后，这次安装意图可以覆盖标准依赖范围：

```text
缺失时 bootstrap 官方 Flowit Runtime
为当前 Agent Host 建立标准 Flowit 集成
写入 Flowit 管理的 Package 位置
```

这些标准依赖动作不需要再次询问“是否安装浮域”。

但以下高权限行为仍必须跨越各自的用户或 Host 审批边界：

```text
管理员权限
发布到外部账号
生产部署
删除用户数据
访问声明范围之外的 Workspace
Studio 声明的 elevated 权限
```

Host 自己的 workspace trust、MCP approval、Plugin trust 和原生 Automation 边界也保持不变。

## 声明式 Package Tree

典型 Studio：

```text
my-studio/
├── flowit.package.json
├── README.md
├── presets/
│   └── <entryPreset>.json
└── roles/
    ├── researcher.md
    └── reviewer.md
```

Preset 只包含数据，Prompt 只使用受限替换。v1 Package 不通过任意代码执行来扩展安装权限。

## Runtime 共享模型

```text
Studio A ─┐
Studio B ─┼─→ 共享 Flowit Workflow Runtime
Studio C ─┘
```

每个 Studio 声明兼容版本范围，而不是打包自己的私有 Runtime。这样可以统一调度、恢复、Host Adapter、安全修复和状态所有权。

Package 卸载也不得删除不属于该 Package 的 Durable Flowit State。

## Trust principles

1. Publisher 声明要求；Flowit 决定 Runtime 与 Host 集成的实现。
2. 第三方 Package 默认声明式，不获得任意安装代码执行权。
3. Flowit Runtime 在多个 Studio 之间共享；Package 声明兼容范围而不是捆绑私有 Runtime。
4. Studio 卸载不能删除 Package 所有权边界之外的持久状态。
5. Package 签名、License、存储、DSL 编译与生命周期工具都分层建立在 v1 合约上。
6. 渠道身份、Publisher 身份、Package 身份和安装后本地身份必须分别验证，不能互相替代。

## 当前容器

当前 `pack` 输出名称类似：

```text
acme.saas-intelligence-1.0.0.flowit/
```

它是目录 Bundle。未来可以增加二进制容器，但不应改变 Manifest / DSL 的核心合约，也不能削弱对解包后 Package Tree 的完整校验。
