---
name: Flowit Workflow Bridge Worker
description: Process one authorized Flowit Workflow request from the local bridge folder in 豆包办公任务模式.
---

# Flowit Workflow Bridge Worker（豆包办公）

仅在用户明确授权 `~/.flowit-workflow/bridges/doubao-office/` 后执行。

1. 将最早的 `inbox/<requestId>.json` 原子重命名到 `processing/<requestId>.json`。
2. 校验 envelope v2，包括 `idempotencyKey`、过期/取消路径、`receiptPath`、`executionClaimPath`、`executionLeaseMs`。
3. 检查过期/取消；已有 receipt 仅在它满足 **receipt v1、`status=completed`、idempotencyKey 完全一致**时复用。损坏或错误 key 的 receipt 移到 `receipts/quarantine/`。可重试失败绝不能写共享 receipt。
4. 按 idempotencyKey 领取 execution lease。renew、release、过期接管必须先持有 `claims/.mutation/<sha256(idempotencyKey)>.lock/`；过期 owner 不能续租复活。短 mutation lock 若孤儿化则 fail closed，不自动删除。
5. 已有活跃 execution lease 时禁止执行副作用，只能等待有效 completed receipt，或在 lease 到期后成功取得 mutation lock 再接管。
6. 加载 `request.skills` 指定技能，缺失即 fail closed；`context` 仅为只读背景。
7. 第一个及每个后续副作用前检查过期/取消和 lease ownerToken；长任务在到期前续租，续租失败后停止启动新副作用，并向支持的宿主操作传递 `idempotencyKey`。
8. 成功后构造 receipt v1 `{version:1,idempotencyKey,status:"completed",completedAt,result}`：先完整写入同目录临时文件并 fsync，再在仍持有 execution lease 时用 no-replace 的原子 link/rename-equivalent 发布到 `receiptPath`。不得先创建最终 receipt 再逐步写 JSON。
9. completed receipt durable 后，再把普通 `result` 写入 `outbox/<requestId>.json`。失败只写本次 outbox 的 `error`，不创建共享 receipt，从而允许相同 idempotencyKey 的新 transport attempt 重试。
10. durable result/失败收口后，在 mutation lock 内核对 ownerToken 并释放 execution lease，最后清理 processing 文件。

当前 Flowit 不假设豆包办公存在公开稳定的 Session Resume API。无人值守时由豆包原生定时任务周期调用本 Worker。没有宿主幂等/fencing 机制的副作用任务仍应保留人工审核，因为已在宿主侧执行中的动作不能仅凭 lease 到期自动回滚。
