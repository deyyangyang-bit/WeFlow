# Phase 1 内网同步最小版 · 设计定稿（2026-09-04）

> 状态：**已实施（2026-09-04 三刀落地；2026-09-09 定向投递修订）**。修订内容：下行从「公共 down/ 全员可消费」改为「按接收者身份分队列定向投递 + 终端 ACK + 中枢结算」，修复多人终端事件串领；主管通知（sla1_escalate_supervisor）接入同一协议闭环。测试 scripts/lan-sync-test.ts（60/60）+ scripts/lan-sync-e2e-test.ts（37/37，真实三终端拓扑：中枢/销售甲/销售乙三库隔离）。
> 前置共识：中央主机后补；现阶段用 Windows 共享文件夹（SMB）当同步通道；Phase 3a 将传输 adapter 从 SMB 演进为内网 API，保留既有事件语义，新增认证与同步能力按 PRD 落地。

## 1. 目标与边界

- 中枢（主管机/后续中央主机）产出分配指令，终端（销售机）消费；
- 终端上行业务回执，中枢消费；
- **终端只见自己线索**（展示过滤，同 HANDOVER §2.55 口径：展示层便利，非安全边界）；
- **聊天原文永不出机**——上行事件只含结构化字段，不含消息正文（宪法 §2.6 隐私条款）。

## 2. 传输通道

- SMB 共享文件夹，一事件一 JSON 文件；
- 文件内字段：`eventSeq`（单调递增）、`idempotencyKey`、`deliveryRole`（apply/remove/notify）、`to`（接收者投递键）、payload；**复用 outbox_event 表**做中枢侧的事件登记；
- 写入方式：先写 `.tmp` 再 rename（同 atomicPersist 原子写铁律，防终端读到半截文件）；
- 目录结构（2026-09-09 修订，R3 风险闭环）：
  - `<共享根>/down/<投递键>/`：中枢→指定接收者；**每个销售身份一个独立队列**（投递键 = 销售姓名文件系统安全化，稳定可重复计算），终端只读自己的队列——非目标终端不能应用、移动或删除他人事件；
  - `<共享根>/down/<投递键>/.failed/`：毒文件/终态失败事件隔离区（保留可审计状态）；
  - `<共享根>/up/<终端标识>/`：终端→中枢（claim / bind_wx / first_touch / audit）；
  - `<共享根>/up/<终端标识>/ack/`：终端→中枢的投递回执（一个投递一个 ACK 文件，基名 = `<幂等键安全化>-<投递角色>`，与投递文件名解耦，重复投递换文件名也命中同一幂等标记）。

### 2.1 投递语义（ACK 协议，2026-09-09 修订）

- 中枢产出：把事件写进每个接收者的队列，outbox 行**保持 pending**——文件落盘 ≠ 终端已接收；
- 终端消费（只读自己的队列）：单事务「业务写 + syncApplied/syncOutcome 幂等标记」→ 写 ACK → 按结果清理：
  - `applied` / `conflict`：ACK 后删事件文件（conflict 也标已应用，留人工审计，不反复重试）；
  - `nolead`：ACK(nolead) 后**保留**文件（lead 可能随后续事件到达，下轮重试）；
  - `invalid`：ACK 后移入自己队列的 `.failed/` 隔离区（保留可审计，不静默当成功）；
- 中枢 ACK 结算：`processUpAcks` 消费 `up/*/ack/` → scan_state `syncAck:<投递键>:<基名>` 标记（nolead 不落标记）；`settleDownDeliveries` 逐条 pending 行取其全部接收者的 ACK 标记——**全部 applied → 行标 sent**（投递完成，清理残留文件）；**任一 conflict/invalid → 行标 failed + audit_event(action='sync_down_fail')**；否则保持 pending 等下一轮；
- 接收者规则：`assign` → 新销售（apply）；`recycle` → 原销售（apply）；`transfer` → 新销售（apply，新权属）+ 原销售（remove，只移除权属不建新行）；同一业务事件多接收者各自独立投递与 ACK，一个接收者确认不提前清理其他接收者的投递；
- 幂等：重复投递（writeEventFile 跳过已存在 + syncApplied 标记）、重复 ACK（syncAck 标记 + skippedDup）、中枢/终端重启（outbox pending 行 + 队列文件 + scan_state 均持久）全部幂等；临时断网恢复后继续投递（R3）。

## 3. 事件清单

### 下行（中枢权威，终端只执行）
1. `assign`：lead 基础资料 + 目标销售 + SLA 参数，投递给新销售；
2. `transfer`：调派——新销售收 apply（旧行 transferred + 新行），原销售收 remove（权属移除）；
3. `recycle`：回收，投递给原销售；
4. `sla1_escalate_supervisor`（2026-09-09 接入）：SLA1 三次超时回收的主管通知——路由到中枢自己的队列（中枢 = 主管/分配员工作机），中枢在本轮同步内落地 crmDb `notify_inbox`（宪法 §3 登记；idempotency_key 唯一幂等；UI 在资源分配管理页「回收改派」页签展示列表与已读）。

### 上行（只增不改，append-only）
1. `claim`（认领回执）；
2. `bind_wx`（绑定微信/加好友回执）；
3. `first_touch`（首触回执）；
4. `audit`（审计行，字段裁剪见 §4 Q4）。

## 4. 四个实施裁决（2026-09-04 定，实现时照此执行）

- **Q1 终端行内编辑是否上行** → **否**。Phase 1 只上行四样回执；终端对 lead 字段的手工编辑不出本机，待中央主机期再议。
- **Q2 中枢 recycle 命中终端「已转客户」lead** → **加 ACCOUNT 拦截小刀**：lead 已转客户（已挂 account）时中枢回收器跳过该行并写审计（reason='converted_skip'），不再下发 recycle 事件。
- **Q3 已应用幂等键存哪** → **存 scan_state**（沿用现有 key-value 机制，`syncApplied:<idempotencyKey>`，与 leadScan 游标同模式）。
- **Q4 audit 上行字段裁剪** → 只上行 `actor/action/entity_type/entity_id/detail` 五字段 + `idempotencyKey`；detail 里若含联系方式做脱敏（手机号中段打码，复用前端既有打码格式）。

## 5. 实施三刀（顺序执行）

1. **中枢下行产出**：assignment assign/transfer/recycle 三处写点时，同步产出 down 事件文件（复用 outbox 登记 + tmp+rename 落盘）；
2. **终端消费下行 + 上行产出**：启动轮巡消费 down/（幂等键查 scan_state，应用后标记）；claim/bind/firstTouch 三处写点时产出 up 事件文件；
3. **中枢消费上行 + 设置页同步区块**：轮巡 up/<终端>/ 各目录消费（幂等）；设置页加「内网同步」区块（共享目录路径配置 + 角色：中枢/终端 + 最近同步状态展示）。

## 6. 已知风险

- **R3 SMB 无强 ACL**：共享文件夹权限颗粒粗。2026-09-09 修订后下行文件已按接收者身份分子队列，终端侧只读自己的队列（应用、移动、删除均只发生在本机队列内），串领根因消除；SMB 部署形态下其他账号仍可能读到他人目录内容，共享权限配置要求写进部署文档；聊天原文不出机底线不变。
- 共享目录不可用（断网/未挂载）时事件积压本地 outbox，恢复后重放——idempotency_key 保证业务侧可重放（宪法 §1.11）。

## 7. Phase 3a 演进

Phase 3a 将传输 adapter 从 SMB 文件读写演进为中央主机内网 API，保留既有事件的格式与幂等语义；PostgreSQL、工作区认证、冲突裁决及扩展上下行范围另按 PRD §7 和 API 契约实施，硬件到货不等于软件演进完成。此后主机迁至 NAS 通常只换部署位置与连接地址，保留已实施 API 契约；停写、最终备份及回退步骤见 [中央节点采购方案 §5](中央节点采购方案.md#5-阶段二升级-nas-的触发条件与路径)。
