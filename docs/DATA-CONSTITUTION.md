# DATA-CONSTITUTION — WeFlow 数据宪法（D1 定案）

> 状态：**D1 + D2 定稿**（2026-09-02）。依据：`docs/规划/weflow-hermes-PRD-v3.4.md` §5（11 对象）/ §11（ADR-001）。
> 本文档优先级高于各模块设计文档；凡冲突，以本文档为准，修订须经评审。
> 范围说明：§1 对象契约（D1）+ §2 四项 Policy（D2：SSOT / Soft Delete / Feature Gate 七问 / Identity Resolution / Stage Transition）已定稿；§2.5 Stage 矩阵 🔶 格待 D8 主管签字生效。

---

## 0. 术语表（优先级最高，撞名以本节裁决为准）

| 术语 | 裁决含义 | 反义/边界 |
|---|---|---|
| **assignment** | **资源分配**：lead → 销售的分配行为与生命周期（表 `assignment`） | ≠ allocation（到款归属，现有表 `allocation`，不动） |
| **customer** | **人/公司锚点**：跨微信号、跨会话的客户主体（新表 `customer`） | ≠ account（单微信号会话维度的客户档案，现有表原样保留）；≠ customer_profile（salesDb 会话维度视图） |
| **quote** | 宪法对象名，报价单及其版本模型 | = quotation（物理表名就是 `quotation`，不建新表、不改名） |
| **account** | 单微信号维度的客户档案（现有表），28 项现有能力照旧 | 通过可空列 `customer_id` 挂接到 customer；不重建、不改主键 |
| **customer_profile** | salesDb 会话（session）维度的客户视图 | 其既有列 `customer_id` 裁决为**指向新 `customer` 表的逻辑外键**，Phase 1 迁移回填对齐（见 §2.2） |
| **owner_sales** | 归属销售姓名（自由文本语义化） | 同名列有三处：`account.owner_sales`（转正为 ownership，见 §1.7）、`opportunity.owner_sales`、`logistics.owner_sales`——三列同口径，一并语义化，不允许第四处出现 |
| **lead.tag** | **需求标签**（Excel 导入线索的来源/需求标记） | ⚠️ 归属语义**已退役**（见 §4.2 决策 B）：历史「tag=销售归属」写法作废，任何人不得再把 tag 当归属读 |
| **lead 死列** | `owner_id` / `pool_id` / `assigned_at` / `private_deadline` 四列为历史预留死列（全仓零读写） | **永久禁用**，禁止任何新代码启用；分配事实一律走 `assignment` 表 |

---

## 1. 11+1 对象契约

> 每对象五要素：一句话定义 / 字段级规格 / 合法写入者 / AI 三档标注 / 实现映射。
> **通用五列**（所有新表必备）：`source` / `updated_by` / `updated_at` / `version` / 删除标记（soft delete，见 §2.2）。
> AI 三档：**A** = auto_committed（证据质量+规则校验达标即自动写）；**B** = proposed → 人工 confirm；**C** = request → 审批。
> 状态机统一约定：存量表维持现状（如 lead.status 无 CHECK，service 层守卫）；**CHECK 范围已定（9/2）**：新表有穷枚举一律加 CHECK 硬门禁（assignment.status / customer_identity.identity_type / outbox_event.status，沿用 customer_event 先例）。

### 1.1 customer（新建）
- **定义**：人/公司锚点，跨微信号的客户主体。
- **字段**：主键 id；`name`；`type`（dealer / end_user，PRD 1.5）；客户设备档案（品牌 / 车龄 / 是否已改装——§5.1 改装信号来源）+ 通用五列。
- **写入者**：迁移回填（Phase 1）、确认后的 AI 提案、人工建档。
- **AI 档位**：type 与设备档案 = **B**（proposed→confirm）；建档本身 = **C**。
- **映射**：新建表（crmDb）。`account.customer_id` 可空列挂接（Phase 1 迁移回填）；`customer_profile.customer_id`（salesDb 既有列）为逻辑外键同步对齐。

### 1.2 customer_identity（新建）
- **定义**：customer 的可联系身份（手机号/微信号）归一化登记。
- **字段**：`(identity_type, identity_value)` 唯一约束，identity_type ∈ {phone, wxid}，identity_value 归一化后入库；`customer_id` **可空**（资源池线索未建档时）；`source`（auto/manual）+ `confidence` + 通用五列。
- **写入者**：1.4a 加好友双路判定（手动绑定写 `source=manual, confidence=1.0`）、迁移查重归并。
- **AI 档位**：自动匹配 = **B**；手动绑定 = 人工行为（记 manual/1.0，全程审计）。
- **映射**：新建表。跨库引用 customer 仅逻辑外键（见 §2.1 跨库规则）。

### 1.3 assignment（新建）
- **定义**：资源分配——lead 到销售的一次分配及其生命周期；**lead 归属的唯一事实源**。
- **字段**：主键 id；`lead_id`（逻辑外键 → lead）；`sales_name`（过渡期用姓名，来自 1.2a 本地身份档案字段；Phase 3a 平滑升级 `employee_id`）；`mode`（比例权重 / 轮询 / 负载）；两段 SLA 计时字段（第一段「加了没有」机械计时；第二段「聊了没有」挂 LLM 扫描结果引用，不内嵌计时器——PRD 1.4）；`status` ∈ {assigned, claimed, recycled, transferred} + 通用五列。
- **写入者**：分配服务（三模式引擎）、分配员手工改派、SLA 回收器。
- **AI 档位**：分配引擎执行 = **A**（规则驱动，非 LLM）；回收改派 = **A**；引擎参数（比例权重）调整 = **C**。
- **映射**：lead ↔ assignment **1:N**；当前分配 = 该 lead 最新有效行。**lead 状态机不动，分配状态永不入 lead 表**；lead 四死列永久禁用（术语表）。

### 1.4 lead（现有表转正）
- **定义**：线索池条目；状态机 NEW→CONTACTED→WX_ADDED→ACCOUNT + DEAD/REOPEN（`crmLeadService.ts:157`，健康不动）。
- **字段**：现有列全保留；四死列标注禁用（不删列，防旧库迁移路径再生变数）。
- **写入者**：分配员录入通道（Excel/粘贴导入，走现有 `importLeads` 写路径）；⚠️ 群资源扫描通道**已下线**（§4.2 决策 B）。
- **AI 档位**：录入查重 = **A**；转客户（toAccount）= 人工触发。
- **映射**：现有表（crmDb）转正，零 DDL。

### 1.5 opportunity（现有表转正 + 补列）
- **定义**：商机。
- **补列**（幂等 ALTER）：`source`（AI 发现 vs 手动——HANDOVER 已列为前置项）、`type`（整车/改装）、`amount_cny` / `original_currency` / `original_amount` / `rate_note`、`main_model`、`order_qty` / `shipped_qty`、`expected_ship_start` / `expected_ship_end`、`delivery_date`、`quote_version_id`、`customer_id`（与既有 `account_id` 并存，逻辑外键）。
- **写入者**：信号扫描（parseBuySignal 链路）、人工、迁移回填。
- **AI 档位**：信号建/推商机 = **B**；金额/币种字段 = **B**（真实库曾出现手机号落金额的前科，规则校验必备）。
- **映射**：现有表补列；`owner_sales` 列语义化口径与 account 一致（术语表）。

### 1.6 quote（quotation 转正 + 版本模型）
- **定义**：报价单；**append-only 版本链**，历史版本只读。
- **补列**：`version`、`effective_from` / `effective_to`、`pdf_hash`；合同绑定走 `contract.quote_version_id`（contract 侧补列）。
- **裁决（既有反向链）**：现状 `quotation.contract_id → contract`。新权威方向 = `contract.quote_version_id → quote 版本`；`quotation.contract_id` 过渡期保留双写只读兼容，后续 Phase 退役，D3 写清双写起止。
- **写入者**：docgen 链路、人工新建版本。
- **AI 档位**：AI 起草报价 = **B**；版本生效（effective）= 人工动作。
- **映射**：现有 `quotation` 表补列；版本行 append-only（同主键组新版本行，旧行置 effective_to）。

### 1.7 ownership（不建表，列语义化）
- **定义**：「当前谁在跟进」= `account.owner_sales` 语义化转正。
- **裁决**：不建独立 ownership 表；现状该列无自动化写入路径（P0-2 盘点确认），转正后写入者收敛为：分配/移交/回收动作（写 `ownership_history` 同事务回写本列）+ 人工编辑。
- **口径覆盖**：`account` / `opportunity` / `logistics` 三处 owner_sales 同语义（术语表）。
- **AI 档位**：**C**（归属变更一律留痕，禁止 AI 直写）。

### 1.8 ownership_history（新建）
- **定义**：归属变更流水（分配/移交/回收/离职）。
- **字段**：`entity_type` / `entity_id` / `old_owner` / `new_owner` / `reason`（分配/移交/回收/离职）/ `actor`（1.2a 姓名+角色）+ 通用五列；append-only。
- **写入者**：分配服务、移交/回收动作；与 owner_sales 回写同事务。
- **AI 档位**：**C**。

### 1.9 stage_history（不建表，收口）
- **定义**：阶段历史 = 事件流 + 当前态投影，不建独立表。
- **实现**：`intent_tag_log`（append-only 事件流，自带 message_key 证据）+ `customer_profile.stage`（当前态投影）。
- **写入者**：继承 P0-2A 定案——classifier / intent / manual / deal 四写者，其余禁写（insightService 降 signal、generic upsert 已剥离）。
- **AI 档位**：classifier/intent = **A**（既有资格）；manual/deal = 人工/规则。

### 1.10 evidence（不建表，定规范）
- **定义**：证据 = key 引用，不复制正文。
- **规范**：`evidence_key` 格式 = P0-2B messageKey 体系（`shared/messageKey.ts` 单一真源，`shared/evidenceKey.ts` 5 格式分类）升格为宪法规范；`evidence_text` = 客户原话 ≤200 字（非 AI 结论）；**只存 key 不复制正文**（evidence_text 仅作展示快照）。
- **消费**：D7 评测集直接引用本规范。
- **AI 档位**：所有 AI 产出必须带 evidence 才可进 B/A 档。

### 1.11 outbox_event（新建，+1）
- **定义**：外发事件暂存（2.11 Hermes 微信推送 / Phase 3a 上行）。
- **字段**：`event_seq` / `idempotency_key` / `payload` / `status`（pending/sent/failed）+ 通用五列。
- **写入者**：业务动作埋点；**1.10 阶段只记录不发送**（无发送器）。
- **AI 档位**：AI 永不直写；由业务代码写入。
- **映射**：新建表。**崩溃语义已定（9/2）**：sql.js 内存库 500ms 防抖落盘，崩溃丢失的 pending 行 = 事件未发生（1.10 只记录阶段无业务后果）；Phase 3a 上行阶段升级为同步落盘；idempotency_key 保证业务侧可重放。

### 1.12 audit_event（新建）
- **定义**：统一审计流水；append-only，无删除、无更新。
- **字段**：`actor`（1.2a 姓名+角色）/ `action` / `entity_type` / `entity_id` / `detail` + 通用五列中的时间列（审计行本身不需要 version/删除标记，写死规则见 §2.2 例外）。
- **⚠️ 身份与权限分离**：actor 的角色字段**仅署名用途，不作访问控制依据**（PRD 1.2a 明文）。Phase 1 本机功能入口的门禁靠机器部署形态 + 现有应用锁；Phase 3a 起以 NAS 服务端绑定认证为准。
- **写入者**：一切新审计写点一律走 audit_event；`activity_log` / `auto_confirm_log` **封存只读留档**（历史可查，新写禁止）。
- **AI 档位**：**C**（AI 行为被审计，不产生审计写权限）。

---

## 2. Policies

### 2.1 SSOT 规则（D2 细化，已定裁决先行）
- 每对象唯一事实源见 §1 各「映射」行；投影/缓存必须可溯源、可重建。
- **跨库规则（新裁决）**：crmDb 与 salesDb 为两个独立 SQLite 库（按微信号分库），**跨库引用一律只做逻辑外键，不建 FK 约束**；跨库一致性由 service 层「先 crmDb 后 salesDb」铁律 + 启动兜底自愈保证（现有 SLA 卡先例）。
- **阶段 SSOT**：`customer_profile.stage` 唯一真源（P0-2A/漏斗改造定案），本宪法继承不翻案。
- **归属 SSOT**：`assignment` 表（lead 维度）、`owner_sales` 三列（客户/商机/物流维度）。

### 2.2 Soft Delete 规则（D2 细化，已定裁决先行）
- 通用五列含删除标记；删除 = 置标记，不物理删。
- **例外**：`audit_event` / `ownership_history` / `intent_tag_log` / `outbox_event` 为 append-only，**连删除标记都没有**，永不删改。
- **PIPL 删除权通道（2026-09-03 D8 补）**：客户依法要求删除 → 先逻辑删（置标记，界面即刻不可见）+ 定期物理清除（含派生快照/证据文本），全过程写 `audit_event` 留痕。
- **迁移铁律（现状继承）**：本项目无版本表，迁移全靠「CREATE IF NOT EXISTS + 逐列 ALTER 吞错」双路径（`crmDbService.ts:337` 模式）；**列一经发布不得改名/改语义**，只能加列。lead 式 DROP 重建为历史特例，新表不得再触发。

### 2.3 Feature Gate 七问（D2 定稿）

任何不在当前 Phase 清单里的新需求/新字段/新表，入宪前先答七问（原文收录自开发流程计划纪律 #11）：

1. 属哪个 Phase？
2. 为什么现在必须做？
3. 会不会引入未来架构？
4. 会不会改变数据宪法？
5. 会不会新增事实源？
6. 会不会新增权限边界？
7. 挤掉什么？

**裁决流程**：七问全过 → 写入本宪法（对象契约 / Policy / §3 扩展占位）；任何一问答不过 → 进 Backlog，不做。AI 不得自行扩大需求范围；答七问的责任在提案者。

### 2.4 Identity Resolution Policy（D2 定稿）

- **身份优先级**：手机号 > wxid > 昵称。昵称仅显示用途，**永不作匹配依据**（改名不失效的前提 = 内部绑 wxid，见 §1.2）。
- **归一化**：identity_value 入库前归一化（手机号去非数字字符、wxid 去首尾空白），归一化后才参与 `(identity_type, identity_value)` 唯一约束。
- **归并规则**：同手机号 → 同 customer；一人多 wxid → 多 identity 行挂同一 customer_id。
- **后补关联**：资源池线索的 identity 行 `customer_id = NULL` 是合法态（未建档）；在绑定微信（1.4a）/ 认领 / 转客户时后补关联。
- **冲突处理**：同一 identity 挂到不同 customer → 系统不自动处置，只产**合并提案** → 人工审批后执行（合并动作 = 改挂 identity 行 + 写 ownership_history + 写 audit_event，三者同事务）。
- **AI 边界**：AI 只产关联/合并提案（B 档 proposed→confirm），**永不执行合并**。手动绑定（source=manual, confidence=1.0）是人工行为，不受此限但全程审计。

### 2.5 Stage Transition Policy（D2 定稿，继承 P0-2A 不翻案）

- **状态模型**：canonical stage 6 值 `new / contacted / quoted / negotiating / won / lost` + `activityState`（active/dormant）独立维度 + `unknown` 异常位（数据缺失合法态）。事实源 = `customer_profile.stage`；历史 = `intent_tag_log` 事件流（§1.9）。
- **转移矩阵**（✅ 直接合法 / 🔶 需人工确认 / ⛔ 禁止）：

| from \ to | new | contacted | quoted | negotiating | won | lost |
|---|---|---|---|---|---|---|
| **new** | — | ✅ | ✅ 跳级 | ✅ 跳级 | ⛔ 禁直连 | ✅ |
| **contacted** | 🔶 | — | ✅ | ✅ 跳级 | ⛔ 禁直连 | ✅ |
| **quoted** | 🔶 | 🔶 | — | ✅ | ✅ | ✅ |
| **negotiating** | 🔶 | 🔶 | 🔶 | — | ✅ | ✅ |
| **won** | ⛔ | ⛔ | ⛔ | ⛔ | — | 🔶 |
| **lost** | 🔶 复活 | 🔶 复活 | 🔶 复活 | 🔶 复活 | ⛔ | — |

- **PRD 四规则落实**：允许跳级 = 前进任意格 ✅；回退受限 = 后退一律 🔶；成交禁直连 = won 仅 quoted/negotiating 可达；流失复活需确认 = lost → 任何阶段 🔶。
- **activityState 不占矩阵**：dormant 由沉默规则写（P0-2A），与 stage 正交。
- **unknown**：→ unknown 仅限初始化/数据缺失置位（系统行为）；unknown → 任何 stage 一律 🔶；业务流转不得把已知阶段改回 unknown。
- **写入资格**（P0-2A 四写者原样收编）：classifier / intent = A 档，**仅可落 ✅ 格**；deal rule 同；manual = 人工，可落 ✅ + 🔶 格；其余写者禁写（insightService 降 signal、generic upsert 已剥离——P0-2A 六刀不翻案）。
- **流失判定证据规则（2026-09-03 D8 裁决）**：`new/contacted → lost` 保持 ✅，但 A 档写 lost **必须携带「客户明确拒绝」的原话证据（messageKey，§1.10）**，无证据不得落 lost；「流失判定准确率」纳入 D7 评测集（与商机判定同门槛，先评测再放量）。
- ⚠️ 本矩阵为 D2 提案：🔶 格已列入 D8 评审包请主管签字；签字前实现以本表为准。

### 2.6 AI Read Boundary（2026-09-03 D8 裁决 8）

写有边界（§2.4/§2.5 + AI 三档），读也必须有边界：

- **默认本账号 scope**：AI 读数据默认限本微信号账号的数据范围（accountScope 隔离升格为正式裁决）。
- **跨账号最小化**：仅允许查重 / 合并提案所需的**最小身份字段**（手机号 / wxid），**不得读取他账号的聊天原文与商机金额**。
- **云推理脱敏（同日拍板）**：聊天扫描等云 API 推理保留，但发送前自动脱敏——手机号 / 微信号 / 身份证号等私密字段打码为 `***`；**聊天原文不出本机**指未脱敏原文，脱敏片段可出。

---

## 3. 扩展对象占位（防过度设计）

- **action**：Phase 2 入宪。当前事实载体 = `follow_up_task` + `customer_event`（P0-3 E3 已 CLOSED），入宪时再裁决是否独立成表。
- **ticket**：Phase 4 入宪。当前无对应物，不预设字段。
- **opportunity_eval_case**（特许扩展，非业务事实表）：PRD 2.10 商机评测集，D7 落库 salesDb（与 intent_tag_log 同库，证据引用同库闭环），salesDb 无 ENTITIES 白名单（该机制仅 crmDbService 有）故无需注册，带通用五列。除本行特许外，任何新表须先过 §2.3 Feature Gate 七问入宪。

---

## 4. D3 实施范围与存量处置

### 4.1 D3 建表/改列清单
- **新建 6 表**（全走幂等双路径）：`customer` / `customer_identity` / `assignment` / `ownership_history` / `outbox_event` / `audit_event`。
- **幂等 ALTER 2 组**：① `account.customer_id`（可空）；② `opportunity` / `contract` 补列（§1.5 / §1.6 清单）。
- 新表注册进 `ENTITIES` 白名单（`crmDbService.ts:194`）——历史坑：`crm_risk`/`opportunity_event` 漏注册曾静默失败。

### 4.2 决策 B：群资源扫描整功能下线（2026-09-02 拍板）
> 背景：PRD 1.3 定分配员录入 + 三模式分配，群扫线索「进资源池、不直接落归属」；群扫描的「昵称=销售名」自动归属与新模型直接冲突，且已产生「秒变/静候」昵称误配前科。拍板：**整功能下线**，录入只走分配员 Excel/粘贴导入。

- **下线清单**：`crmLeadScanService.ts` / `crmLeadScanCore.ts` 停用删除；线索页「扫描群资源」按钮与模态移除；设置项 `crmLeadScanGroup` / `crmLeadScanWhitelist` 移除；`scan_state` 键 `leadScan:*` 游标清理（进 1.2 迁移报告）。
- **`lead.tag` 归属语义退役**：tag 仅保留 Excel 导入「需求标签」语义。
- **`leadReassignOwner` 整链路删除（2026-09-02 拍板，不改道）**：函数 + `crm:lead:reassign` IPC + preload/d.ts 桥接 + 线索页「⚙ 管理归属」弹窗一并移除。理由：批量修误配的场景随群扫描下线消失；批量 UPDATE 改归属会绕过 assignment 状态流转与留痕；新模型的归属调整统一走分配服务改派（assignment transferred/recycled + ownership_history + audit_event）。
- **存量处置**：已入库群扫线索（约 4,680 条，含历史 tag 归属）**tag 归属不迁 assignment**，统一回资源池由分配员按 1.3 重新分配（先 200 条小批量验证）；历史归属留在 `note`（现有「曾归属:X（日期）」格式）备查。
- **1.2 迁移清单同步**：现有线索（含群扫描）→ lead → customer_identity 查重归并（PRD §11 表），本条不变。

### 4.3 迁移既有列裁决汇总
| 既有物 | 裁决 |
|---|---|
| `account.customer_id`（新列） | 可空挂接，Phase 1 回填；account 本体 28 项能力照旧 |
| `customer_profile.customer_id`（既有列） | 语义 = 指向新 customer 表；Phase 1 回填对齐 |
| `lead.owner_id/pool_id/assigned_at/private_deadline` | 永久禁用死列，不删不启用 |
| `lead.tag` | 归属语义退役，仅需求标签 |
| `quotation.contract_id` | 过渡期双写只读兼容，权威方向为 `contract.quote_version_id` |
| `activity_log` / `auto_confirm_log` | 封存只读；新审计一律 `audit_event` |
