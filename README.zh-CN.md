# 浮域（Flowit Workflow）中文说明

本仓库的规范中文首页是 [README.md](README.md)。本文件保留为仓库治理与工具链可发现的简体中文入口。

## 公共开发命令契约

以下命令属于仓库维护者确认的稳定公共入口：

- `pnpm build`：先构建 `packages/*` workspace 包，再构建根兼容分发包，生成可发布产物。
- `pnpm test`：先执行完整 build，再运行确定性的默认测试套件；命令与构建产物契约测试包含在该默认套件中。

依赖安装不得通过 `preinstall`、`install`、`postinstall` 或 `prepare` 生命周期脚本隐式触发仓库构建。CI 和 Release 必须显式执行构建与测试门禁。
