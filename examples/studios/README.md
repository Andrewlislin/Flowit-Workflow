# Flowit Studio Starter Examples

[Build with Flowit](../../docs/studio/README.md) · [10 分钟 Quickstart](../../docs/studio/quickstart.md) · [Studio SDK](../../docs/studio/sdk.md)

这个目录面向 **Studio Creator**。示例的目的不是充当市场或安装目录，而是提供可以阅读、复制、修改和验证的最小工程。

```text
examples/studios/
└── research-starter/
    ├── flowit.package.json
    ├── presets/
    │   └── research-starter.json
    └── roles/
        ├── researcher.md
        └── reviewer.md
```

## research-starter

`research-starter` 展示一个第三方兼容 Studio 的最小结构：

```text
Researcher
    ↓
Reviewer
```

它包含：

- 稳定的 Studio 与 Publisher identity；
- `schemaVersion: 1` 的 `flowit.package.json`；
- Flowit Runtime 兼容范围；
- Claude Code 与 Codex Host 声明；
- 一个声明式入口 Preset；
- 独立的 Researcher 和 Reviewer Prompt。

在仓库根目录验证：

```bash
pnpm build
node dist/studio/cli-entry.js validate ./examples/studios/research-starter
node dist/studio/cli-entry.js test ./examples/studios/research-starter
```

安装过 npm beta CLI 后也可以直接使用：

```bash
flowit-studio validate ./examples/studios/research-starter
flowit-studio test ./examples/studios/research-starter
```

## 和 `studios/community/` 的区别

```text
examples/studios/
= Creator 教学示例
= 优先追求最小、可复制、可解释

studios/community/
= 随仓库维护的现成社区 Studio
= 面向用户体验具体工作模式
```

不要把 Starter Example 当成 Publisher Marketplace，也不要把社区 Studio 的产品内容反向塞进 SDK Quickstart。两者共享同一个 Studio Package Spec，但服务不同受众。

## 复制为自己的 Studio

```bash
cp -R ./examples/studios/research-starter ./my-studio
```

复制后至少修改：

```text
flowit.package.json
  id
  displayName
  publisher
  version
  supportedHosts
  license

presets/
  id
  displayName
  roles
  nodes
  edges

roles/
  专业角色 Prompt 与交付标准
```

然后执行 `validate`、`test` 和 `pack`。完整步骤见 [10 分钟创建第一个 Studio](../../docs/studio/quickstart.md)。

---

## English

This directory contains copyable Creator-facing examples, not a marketplace or end-user installation catalog.

`examples/studios/research-starter` demonstrates a minimal third-party-compatible Studio with a v1 manifest, one declarative Preset and separate researcher/reviewer prompts.

Use `examples/studios/` to learn the Package structure. Use [`studios/community/`](../../studios/community/) for ready-made community Studios maintained as product examples.
