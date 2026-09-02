# 10 分钟创建第一个 Flowit Studio

[Build with Flowit 首页](README.md) · [English](quickstart.en.md) · [Studio SDK](sdk.md) · [Package Spec](package-spec.md)

这个 Quickstart 会创建一个最小的“客户研究工作室”，然后完成校验、编译测试和打包。

## 1. 准备 Creator CLI

需要 Node.js `^22.19.0` 或 `>=24.0.0`。

```bash
npm install --global @coaseedgeltd/flowit-workflow@beta
```

确认 CLI 可以运行：

```bash
flowit-studio list
```

没有安装任何 Studio 时，列表为空是正常结果。

## 2. 创建 Studio 骨架

```bash
flowit-studio init ./customer-research \
  --id=acme.customer-research \
  --name="客户研究工作室" \
  --publisher=acme \
  --host=codex
```

生成结构：

```text
customer-research/
├── flowit.package.json
├── README.md
├── presets/
│   └── customer-research.json
└── roles/
    └── worker.md
```

`init` 默认生成 `0.1.0` 版本、一个 `worker` 角色和一个 `work` 节点。Runtime 兼容范围由当前 Creator CLI 的 Flowit 版本推导，因此这个骨架默认与当前 CLI 兼容。

目标目录非空时，CLI 不会隐式覆盖。只有明确要替换时才使用 `--force`。

## 3. 描述你的方法

先编辑 `roles/worker.md`。最小 Prompt 可以只描述工作标准：

```markdown
# 客户研究员

根据输入目标完成客户研究。

必须区分：
- 已确认事实；
- 合理推断；
- 尚未验证的信息缺口。

最终报告写入 {{workspace}}。
本次目标：{{input}}
```

Prompt 文件支持受限替换：

```text
{{input}}
{{workspace}}
{{pipelineName}}
```

然后编辑 `presets/customer-research.json`，把一个通用 Worker 逐步拆成真正的专业流程，例如：

```text
定义研究问题
    ↓
收集证据
    ↓
识别反例和信息缺口
    ↓
综合结论
    ↓
独立审核
```

Preset 是纯数据，不允许任意 JavaScript hook。角色、节点和边必须通过声明式工作图表达。

## 4. 校验 Studio

```bash
flowit-studio validate ./customer-research
```

校验范围包括：

```text
flowit.package.json
Package Tree 与路径边界
Manifest 与 Preset 的一致性
角色和 Prompt 引用
节点、边和声明式工作图
Runtime / Host 声明
```

失败时先修正文档或 Package 内容，不要绕过校验器。

## 5. 做编译测试

```bash
flowit-studio test ./customer-research
```

`test` 会沿着 Flowit Runtime 使用的同一 `PresetDefinition` 路径编译 Studio，并用测试绑定生成一份 Pipeline。它验证的是 Studio 能否形成合法工作流，不会替你执行真实外部任务。

## 6. 打包

```bash
flowit-studio pack ./customer-research --out=./dist
```

输出类似：

```text
dist/
└── acme.customer-research-0.1.0.flowit/
```

当前 `.flowit` 是经过再次校验的目录 Bundle，不是一个隐含可执行脚本的二进制容器。分发渠道可以运输这个目录，但安装时 Flowit 仍会对解包后的完整 Package Tree 重新建立信任结论。

## 7. 从 Starter Studio 继续

仓库内置了一个可复制示例：

```text
examples/studios/research-starter/
```

它包含：

```text
flowit.package.json
presets/research-starter.json
roles/researcher.md
roles/reviewer.md
```

查看 [Starter Studios](../../examples/studios/) 了解示例目录和 `studios/community/` 的区别。

## 当前边界

完成这个 Quickstart 后，你已经拥有一个可以校验、测试和打包的 Studio Package。

当前 Beta 还没有统一的已安装 Studio `run` / `activate` / `studio_run` consumer API，也没有让默认 Preset Registry 自动扫描所有已安装 Package。因此：

```text
pack 成功
≠ 已发布到市场
≠ 所有 Host 已拥有统一一键启动入口
```

安装、签名、License 和渠道分发分别见：

- [安装与 Runtime bootstrap](install.md)
- [发布与分发](publish.md)
- [Studio Package Spec v1](package-spec.md)
