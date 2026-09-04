# Phase 1 内网同步最小版 · 设计定稿（2026-09-04）

> 状态：设计定稿，未实施。实施三刀见 §5。
> 前置共识：NAS 后补；现阶段用 Windows 共享文件夹（SMB）当同步通道；NAS 到位后只换传输 adapter，协议不变。

## 1. 目标与边界

- 中枢（主管机/后续 NAS）产出分配指令，终端（销售机）消费；
- 终端上行业务回执，中枢消费；
- **终端只见自己线索**（展示过滤，同 HANDOVER §2.55 口径：展示层便利，非安全边界）；
- **聊天原文永不出机**——上行事件只含结构化字段，不含消息正文（宪法 §2.6 隐私条款）。

## 2. 传输通道

- SMB 共享文件夹，一事件一 JSON 文件；
- 文件内字段：`eventSeq`（单调递增）、`idempotencyKey`、payload；**复用 outbox_event 表**做中枢侧的事件登记；
- 写入方式：先写 `.tmp` 再 rename（同 atomicPersist 原子写铁律，防终端读到半截文件）；
- 目录结构：`<共享根>/down/`（中枢→终端）、`<共享根>/up/<终端标识>/`（终端→中枢）。

## 3. 事件清单

### 下行（中枢权威，终端只执行）
1. `assign`：lead 基础资料 + 目标销售 + SLA 参数；
2. `transfer`：调派（旧行 transferred + 新行）；
3. `recycle`：回收。

### 上行（只增不改，append-only）
1. `claim`（认领回执）；
2. `bind_wx`（绑定微信/加好友回执）；
3. `first_touch`（首触回执）；
4. `audit`（审计行，字段裁剪见 §4 Q4）。

## 4. 四个实施裁决（2026-09-04 定，实现时照此执行）

- **Q1 终端行内编辑是否上行** → **否**。Phase 1 只上行四样回执；终端对 lead 字段的手工编辑不出本机，待 NAS 期再议。
- **Q2 中枢 recycle 命中终端「已转客户」lead** → **加 ACCOUNT 拦截小刀**：lead 已转客户（已挂 account）时中枢回收器跳过该行并写审计（reason='converted_skip'），不再下发 recycle 事件。
- **Q3 已应用幂等键存哪** → **存 scan_state**（沿用现有 key-value 机制，`syncApplied:<idempotencyKey>`，与 leadScan 游标同模式）。
- **Q4 audit 上行字段裁剪** → 只上行 `actor/action/entity_type/entity_id/detail` 五字段 + `idempotencyKey`；detail 里若含联系方式做脱敏（手机号中段打码，复用前端既有打码格式）。

## 5. 实施三刀（顺序执行）

1. **中枢下行产出**：assignment assign/transfer/recycle 三处写点时，同步产出 down 事件文件（复用 outbox 登记 + tmp+rename 落盘）；
2. **终端消费下行 + 上行产出**：启动轮巡消费 down/（幂等键查 scan_state，应用后标记）；claim/bind/firstTouch 三处写点时产出 up 事件文件；
3. **中枢消费上行 + 设置页同步区块**：轮巡 up/<终端>/ 各目录消费（幂等）；设置页加「内网同步」区块（共享目录路径配置 + 角色：中枢/终端 + 最近同步状态展示）。

## 6. 已知风险

- **R3 SMB 无强 ACL**：共享文件夹权限颗粒粗，终端理论上能读到别人的下行文件。缓解：下行文件按终端分子目录 + 部署文档写明共享权限配置要求；数据敏感度 Phase 1 可接受（聊天原文不出机已守住底线）。
- 共享目录不可用（断网/未挂载）时事件积压本地 outbox，恢复后重放——idempotency_key 保证业务侧可重放（宪法 §1.11）。

## 7. Phase 3a 演进

NAS 到位后只替换传输 adapter（SMB 文件读写 → NAS 内网 API），事件格式、幂等机制、上下行清单全部不变。
