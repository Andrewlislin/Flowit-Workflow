# 发布与分发 Flowit Studio

[Build with Flowit 首页](README.md) · [English](publish.en.md) · [Package Spec](package-spec.md) · [安装](install.md)

发布 Studio 不是把一个目录上传到某个网站这么简单。需要把四个事实分开：

```text
Studio Package 是什么
Publisher 是谁
用户拥有什么 License
Package 通过什么渠道到达用户
```

Flowit Studio Package 是应用与信任格式；SkillHub、GitHub、Publisher 网站、企业 Registry 和本地文件只是分发渠道。

## 基本发布流水线

```text
Studio 源目录
      ↓
validate
      ↓
test
      ↓
pack
      ↓
完成的 Package Tree
      ↓
Publisher 签名 / License 策略
      ↓
渠道包装
      ↓
用户侧 Flowit 安装链重新校验
```

推荐至少执行：

```bash
flowit-studio validate ./my-studio
flowit-studio test ./my-studio
flowit-studio pack ./my-studio --out=./dist
```

`pack` 生成经过再次校验的 `.flowit` 目录 Bundle。不要在打包后继续修改目录并沿用旧签名或旧 Digest；Publisher 应当对最终、冻结的 Package Tree 建立身份声明。

## Package、Publisher、Channel、License

这四层不能互相替代：

| 层 | 回答的问题 |
| --- | --- |
| Package identity | 用户收到的是哪个 Studio、哪个版本、哪些 bytes |
| Publisher identity | 谁对这个 Package 负责 |
| Channel identity | 这些 bytes 通过什么渠道到达用户 |
| License entitlement | 这个用户被授权如何使用 |

例如：

```text
SkillHub 认证了渠道中的官方 Installer
≠ SkillHub 自动替第三方 Publisher 背书
≠ 商业 Package 可以绕过 Publisher signature / trust 要求
≠ 用户自动拥有商业 License
```

用户侧安装仍会冻结来源、校验完整树、绑定 Digest，并独立检查 Publisher trust 与 License。

## 开源、Freeware 与商业 Studio

Manifest 可以声明不同 License 类型。产品层通常会出现三类：

```text
开源
  代码与内容按照开源 License 分发

Freeware
  免费使用，但不自动获得再分发或改作权

Commercial
  使用权由签名 Package 与本地 License entitlement 共同约束
```

License 文本、Manifest 类型、销售页面和实际交付文档必须一致。不要在 Manifest 中写 `freeware`，同时在页面上暗示用户获得源码再分发权；也不要把 `commercial-*` 写成云端席位管理能力，除非确实存在相应的在线权威服务。

## 商业签名与离线 License

当前商业 Package 签名使用 Ed25519。Publisher 对完成的 Package Tree 签名，安装方使用本地信任的 Publisher key 验证。

离线 License 支持：

```text
personal
team
enterprise
```

Team seats 是签入 License 的本地 entitlement 信息。在无云模式下，Flowit 不虚构跨设备的实时 seat 消耗计数。

签名解决“谁发布了这些 bytes”，License 解决“这个用户拥有什么使用权”。两者不是同一件事。

## SkillHub 发布

生成渠道 payload：

```bash
flowit-studio skillhub ./my-studio --out=./dist
```

第三方 Publisher payload 是纯数据：

```text
flowit-skillhub.json
studio/
  flowit.package.json
  presets/
  roles/
  ...
```

它不会包含：

```text
SKILL.md
install.mjs
bootstrap script
任意 executable installer
```

自动安装由独立发布、需要渠道认证 Publisher identity 的 CoaseEdge 官方 Installer 承担。第三方 Studio payload 不能把自己伪装成官方 Installer，也不能指定任意 Runtime 下载源。

## 其他渠道

同一个 `.flowit` Package 可以通过以下方式分发：

```text
GitHub Release
Publisher 官网下载
企业内部 Registry
受控文件共享
本地目录
```

无论渠道如何变化，用户侧都应进入同一个 Flowit 安装事务。渠道可以提供发现、下载、支付和交付，但不能绕开：

```text
immutable snapshot
Package Tree fence
Manifest / DSL validation
Digest
Publisher trust
signature / License
Runtime compatibility
Host Setup / Doctor
```

## 发布前检查

发布前至少确认：

1. `flowit-studio validate` 和 `test` 在干净环境中通过；
2. `flowit.package.json` 的 `id`、Publisher、版本、Host 和 Runtime 范围准确；
3. Package 不包含 symlink 越界、临时文件、密钥、用户数据或无关构建产物；
4. Prompt 与 Preset 不把外部发布、删除、生产部署等高风险行为伪装成普通默认步骤；
5. `.flowit` Bundle 在最终签名后不再变化；
6. 渠道页面没有把未来的统一启动、市场或云端 License 能力写成当前已交付功能。

## 当前商业边界

现在可以完成：

```text
创建
校验
测试
打包
签名
离线 License
渠道 payload
本地安装与 Host readiness
```

现在还没有完整的：

```text
Publisher Console
Studio Marketplace
支付、退款和税务
自动 License 签发
云端 seat 管理
统一 installed-Studio 启动入口
```

因此“可以出售”当前应理解为：Publisher 可以在自己的商业和交付系统中销售 Package 与 License；Flowit 已提供本地 Package、Trust 和 License 基础，但尚未提供完整市场交易平台。
