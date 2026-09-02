# Flowit Studio SDK / CLI

[Build with Flowit 首页](README.md) · [English](sdk.en.md) · [Quickstart](quickstart.md) · [Package Spec](package-spec.md)

Flowit Studio SDK 把专业方法转换成声明式、可在本地 Flowit Runtime 上运行的工作流应用。Creator 不需要修改 Flowit Core，也不需要自己实现调度、恢复、Host Adapter 或安装信任链。

当前 SDK 随 `@coaseedgeltd/flowit-workflow` 一起发布：

```text
npm package: @coaseedgeltd/flowit-workflow
CLI:         flowit-studio
ESM export:  @coaseedgeltd/flowit-workflow/studio
```

## Author loop

```bash
flowit-studio init ./customer-research \
  --id=acme.customer-research \
  --name="客户研究工作室" \
  --publisher=acme \
  --host=codex

flowit-studio validate ./customer-research
flowit-studio test ./customer-research
flowit-studio pack ./customer-research --out=./dist
```

`init` 会生成最小的 `flowit.package.json`、入口 Preset、角色 Prompt 和 README。Runtime 范围由当前 CLI 中的 Flowit 版本推导，因此新建 Studio 默认与当前 Creator CLI 兼容。

非空目录不会被隐式覆盖；只有明确需要替换时才使用 `--force`。

## CLI 命令

| 命令 | 作用 |
| --- | --- |
| `flowit-studio init <dir>` | 生成最小 Studio 骨架 |
| `flowit-studio inspect <dir>` | 读取并展示 Package Descriptor |
| `flowit-studio validate <dir>` | 校验 Manifest、路径、Package Tree 和声明式工作图 |
| `flowit-studio test <dir>` | 通过 Runtime 同一 PresetDefinition 路径做编译测试 |
| `flowit-studio pack <dir>` | 生成再次校验过的 `.flowit` 目录 Bundle |
| `flowit-studio skillhub <dir>` | 生成只包含数据的 SkillHub payload |
| `flowit-studio list` | 列出本地已安装 Studio |
| `flowit-studio install <dir>` | 进入用户侧 Package / Runtime / Host 安装链 |
| `flowit-studio install-skillhub-payload <dir>` | 从外部 SkillHub payload 开始，先冻结到 Flowit-owned snapshot，再进入安装链 |
| `flowit-studio experience-report` | 读取本地安装体验诊断聚合 |

安装命令涉及 Publisher trust、License、Host scope 和 Runtime handoff；不要把它当成普通文件复制。完整语义见 [安装与 Runtime bootstrap](install.md)。

## Public API

Creator 可以从稳定子路径导入 authoring API：

```ts
import {
  createStudioScaffold,
  validateStudioProject,
  packStudioProject,
} from '@coaseedgeltd/flowit-workflow/studio'
```

最常用的三个入口分别对应：

```text
createStudioScaffold
  创建目录、Manifest、Preset、角色 Prompt 和 README

validateStudioProject
  加载 Package、校验安全树、编译声明式 Preset、渲染测试 Pipeline

packStudioProject
  先校验，再复制到独立输出树，再对输出 Package 重新校验
```

`@coaseedgeltd/flowit-workflow/studio` 还导出 Schema、Package Loader、Store、DSL、签名、License、安装、Bootstrap、Distribution 和 diagnostics 等 Studio 子系统。使用这些底层 API 时，应把相应安全与版本契约视为公共边界，而不是内部便利函数。

## 声明式 Preset

`presets/<entryPreset>.json` 只包含数据。Studio 作者不能在 Preset 中定义任意 JavaScript hook。

Prompt 文件支持的受限替换是：

```text
{{input}}
{{workspace}}
{{pipelineName}}
```

最小工作图由以下对象构成：

```text
roles
nodes
edges
input contract
promptFile references
```

`validate` 和 `test` 会把这些声明编译为 Flowit 使用的 `PresetDefinition`，并使用测试 Session binding 渲染 Pipeline。

## Package 输出

`pack` 当前生成目录形式的 Bundle：

```text
<studio-id>-<version>.flowit/
├── flowit.package.json
├── presets/
├── roles/
└── ...
```

它不是包含任意安装脚本的二进制容器。渠道可以把目录放进自己的归档格式中运输，但 Flowit 的信任边界针对解包后的完整 Package Tree 建立。

默认输出目录位于 Studio 源目录之外；SDK 会拒绝源树与输出树互相包含，避免递归复制或破坏性覆盖。

## 安全边界

Studio 作者可以声明：

```text
Runtime 版本范围
Host 兼容性
角色与 Prompt
Skill 与权限需求
Publisher 与 License
```

Studio 作者不能声明：

```text
自定义 Flowit Runtime URL
自定义 Runtime 安装器
任意 Host 配置脚本
Package installScript
声明式边界之外的任意代码执行
```

标准 Host 集成仍由 Flowit Setup Providers 管理。商业签名和离线 License 位于 authoring 之后：Publisher 对完成的 Package Tree 签名，接收方使用本地信任的 Publisher key 和 License 文档验证。

## 版本策略

当前 Studio 能力仍处于 Beta，并与主 Runtime 同版本发布。现在保持一个 Monorepo 和一个 npm 分发，可以避免 SDK、Package Spec、Runtime 与安装器之间过早产生跨仓库版本漂移。

出现稳定 `v1`、大量外部 Creator、独立 issue 生态和独立发布节奏后，再评估拆分 `flowit-studio-sdk` repository 或 npm package。

## 当前执行边界

SDK 已经能够生成、校验、测试、打包和安装 Studio，但统一的已安装 Studio `run` / `activate` / `studio_run` consumer API 仍未完成。不要把 `install complete` 或 `pack succeeded` 解释为所有 Host 都已经拥有通用启动入口。
