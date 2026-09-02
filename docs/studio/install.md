# 安装 Flowit Studio：工作室优先的用户体验

[Build with Flowit 首页](README.md) · [English](install.en.md) · [Package Spec](package-spec.md) · [发布与分发](publish.md)

普通用户的默认入口是**安装工作室**，而不是先学习或单独安装浮域 Runtime。

## 用户第一次没有浮域，或当前 Runtime 不兼容

```text
用户：安装这个工作室
        ↓
复制到 Flowit-owned immutable Studio snapshot A
        ↓
校验 Studio manifest / runtime range
        ↓
当前 Flowit 满足 range？
   ├─ 是 → 继续审核 A
   └─ 否 → 从固定官方 npm registry 准备 compatible Runtime
            → handoff 携带 A 的 snapshot path + digest + 原 source label
            → compatible flowit-studio 从 A 继续
            → 不重新打开外部 publisher source
        ↓
识别当前 Agent Host
        ↓
Publisher / License / DSL / 权限审核（同一 frozen bytes）
        ↓
官方 Host Setup Provider
        ↓
原子提交 reviewed snapshot 到 Flowit-owned storage
        ↓
Doctor
        ↓
complete → package/runtime/Host installation complete
manual-action-required → 明确告诉用户仍需完成 Host 信任步骤
partial / unhealthy → 要求 Repair
```

Host Setup 的状态聚合是 fail-closed 的：`partial`、`failed`、`unsupported` 都会把 Studio install 归为 `partial`，即使随后 Doctor 返回 `healthy` 也不能提升成 `complete`。这类结果在 first-run 中是 `repair-required`，diagnostics 归因到 `host-setup`，且不会记录 `host_setup_success` 或 `studio_install_success`。

Runtime handoff 不是一次新的外部安装请求。旧 Runtime 在 child 结束前保留 frozen snapshot；compatible child 接收该 snapshot 路径和预期 digest，并再次校验 byte identity。即使原下载目录在 handoff 期间被替换，安装仍只能继续最初冻结的 bytes。

用户已经明确选择“安装这个工作室”以后，标准依赖树不再重复询问“是否安装浮域”。管理员权限、外部发布、生产部署、删除数据以及 Studio 声明的 `elevated` 权限仍然必须单独批准；Host 自己的 workspace trust、MCP approval、Plugin trust、原生 Automation 等边界也保持不变。

## 安装时的安全链

Flowit 不直接在第三方可变目录上形成信任结论。外部 source 先复制到 Flowit-owned staging，然后对 staging 执行 symlink/tree fence、manifest/DSL validation、完整 package digest、Publisher signature 和 License 校验。`apply` 只允许提交 prepare 审核过的 snapshot；commit 前再次 fence/hash，最终 installed bytes 必须与 reviewed bytes 相同。

商业 Package 的签名使用 Ed25519；离线 License 支持 personal/team/enterprise。`commercial-team` 只接受 team/enterprise，`commercial-enterprise` 只接受 enterprise。Team 的 seats 是签入 License 的本地 entitlement 信息；无云模式下 Flowit 不虚构跨设备的集中 seat 消耗计数。

## Official Runtime trust root

Studio 只能声明兼容范围，不能指定 Runtime URL 或安装脚本。Runtime bootstrap 固定使用：

```text
package:  @coaseedgeltd/flowit-workflow
registry: https://registry.npmjs.org/
scope:    @coaseedgeltd → https://registry.npmjs.org/
```

安装时禁用 npm lifecycle scripts，并记录本地 provenance；没有该 provenance 的旧 runtime 不会被当作 official 复用。Studio 的 runtime range 在 consumer install 中是强制 preflight，而不是文档提示。

## SkillHub：第三方 payload 与官方 Installer 分离

第三方 Publisher 的 SkillHub 发布物是**纯数据 payload**：

```text
flowit-skillhub.json
studio/
  flowit.package.json
  presets/
  roles/
  ...
```

`flowit-studio skillhub` 不会把 `SKILL.md`、`install.mjs`、bootstrap script 或其它 executable installer 复制进第三方 payload。

自动安装由**单独发布的 CoaseEdge 官方 Flowit Studio Installer Skill**负责。SkillHub 或其它分发渠道必须在执行它之前认证该 Installer 的 publisher identity 为 CoaseEdge；如果渠道不能提供这个身份保证，Flowit 不把该路径宣称为可信的一键安装。

官方 Installer 自身不在 mutable payload 上读取 metadata/manifest 并形成信任结论。它只从固定官方 npm registry 启动：

```text
flowit-studio install-skillhub-payload <payload-directory>
```

Flowit child 的第一步是把**完整 SkillHub payload**复制到 Flowit-owned `SkillHubPayloadStore` snapshot。随后只在该 snapshot 上进行：

```text
tree / symlink fence
→ flowit-skillhub.json runtime parsing
→ metadata ↔ manifest identity
→ full payload digest
→ studio/ tree digest
```

真正的 Studio 安装只接受 `snapshot/studio`，并把 `studioDigest` 传入普通 Studio immutable-source fence。因此：

```text
外部 payload A
→ Flowit freeze/check A
→ 外部目录随后变成 B
→ 安装仍只能继续 A
```

如果 Flowit-owned payload snapshot 在 Studio child freeze 前被修改，则 digest mismatch 会在 Host setup mutation 之前 fail closed。SkillHub 的渠道检查和 Studio 最终安装因此被绑定为：

```text
channel bytes
→ Flowit-owned payload snapshot
→ checked metadata/manifest
→ frozen Studio digest
→ trust/license review
→ installed bytes
```

同一个 `.flowit` Studio 仍可以来自 SkillHub、作者官网、GitHub、企业内部 Registry 或本地文件；SkillHub 不是 Studio application/trust format。

## 安装完成不等于已经有通用执行入口

当前安装链建立的是：

```text
Package install
+ compatible Runtime
+ Host integration
+ Doctor readiness
```

它**尚未提供**一个通用的 installed-Studio `run` / `activate` / `studio_run` consumer API，也没有让默认 Preset registry 自动扫描 `StudioPackageStore`。

因此 `transaction.status === complete` 的准确含义是：

> Studio package、兼容 Runtime 与标准 Host integration 已安装且 Doctor 通过。

CLI 不输出“可以直接开始”，也不会生成一个看似可执行的通用 prompt。后续若加入 first-class installed-Studio execution bridge，应作为独立 contract/PR 设计和审核。

## 本地 diagnostics

体验诊断默认只写本地：

```text
~/.flowit-workflow/diagnostics/experience.jsonl
```

Runtime 会对事件对象执行严格 allowlist；未知字段直接拒绝，不会把调用方原对象 `JSON.stringify` 后写盘。允许的内容只有事件类型、时间、Studio id/version、Host id、耗时和有限的 failure stage。没有 Prompt、用户文件、代码、workspace 路径、Session 内容或任意 metadata，也没有自动上传逻辑。

`manual-action-required` 记录为 pending，不计为 `studio_install_success`；只有 `complete` 才记录 package/Host 安装成功。诊断事件不声称通用 Studio execution 已成功。

用户或支持人员可以主动运行：

```bash
flowit-studio experience-report
```

查看本地聚合结果。
