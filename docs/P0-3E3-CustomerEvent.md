# P0-3 E3 CustomerEvent：设计文档（E3.1 Infrastructure）

> **状态：E3.1 设计定稿（2026-08-23），进入实现**
>
> 前置：docs/P0-3E3-CustomerEvent-盘点.md（第一刀只读盘点）→ 用户拍板 Scope Lock（下方原文引用）→ 本设计。

---

## ① Scope Lock（用户拍板，2026-08-23，不再扩大）

```text
P0-3 E3 CustomerEvent Scope

① 新建通用 customer_event 表
   - append-only
   - session 轴
   - message_key 复用 P0-2B
   - 客户行为 + 用户行动统一承载

② 首期事件类型
   customer_replied
   quote_asked
   script_copied
   chat_opened
   follow_up_done

③ intent_tag_log 不迁
   - 继续作为 Intent Event / 判定事件
   - 不与 CustomerEvent 合并

④ quote_signal 不迁
   - 报价业务事实继续由 quote_signal 承载
   - customer_replied 统一写 CustomerEvent
   - quote_signal.customer_replied_at 暂留兼容
   - 本期不退役

⑤ 消费者全部不迁
   - Funnel → State
   - Intent Score → intent_tag_log
   - Weekly Report → 现有 intentBefore
   - Today Action / R7 → 维持现状

⑥ 本期只解决 Event Production
   - 建表
   - 写入原语
   - 最小事件生产者
   - 幂等/append-only/证据约束
   - 测试
   - 真实库只读验收

⑦ 不做
   - 历史迁移
   - quote_signal 迁移
   - R7 迁移
   - 四消费者迁移
   - UI
   - Judgment 改造
   - State 改造
```

## ② 硬门禁：CustomerEvent ≠ 万能日志表

用户在拍板中明确：

> CustomerEvent 不允许成为"万能日志表"，否则半年后 event_type 里会长出 stage_changed / ai_summary_generated / opportunity_detected / contract_signed ...

四者定位钉死，**不能互相冒充**：

| 载体 | 定位 |
|---|---|
| `customer_event` | **客观发生的事实**（客户行为 + 用户行动） |
| `intent_tag_log` | AI / classifier / manual 对**意向的判定** |
| `customer_judgment` | AI 对客户当前状态的**结构化判断** |
| `customer_profile` | 当前 **canonical State** |

分层：

```text
事实发生        CustomerEvent
                     ↓
判断产生        customer_judgment / intent_tag_log
                     ↓
当前状态        Canonical State
```

**门禁的 schema 层实现**（沿用 P0-2C `customer_judgment` CHECK 禁 stage 的先例）：
- DB 层：`CHECK (event_type IN (五类))`——新增事件类型必须走迁移，是有意的摩擦
- TS 层：`isCustomerEventType()` 守卫，非法类型（含 stage/judgment 类）抛错
- 分类派生：客户行为（customer_replied/quote_asked）vs 用户行动（script_copied/chat_opened/follow_up_done）由函数只读派生（同 `judgmentEvidenceStatus` 模式），**不加列**

## ③ E3 拆刀（用户拍板路线）

| 刀 | 内容 | 状态 |
|---|---|---|
| E3.0 盘点 | 只读盘点 + 拍板 | ✅ 已封板 |
| **E3.1 Infrastructure** | schema + shared event types + create/read 原语 + append-only/幂等/证据约束 + 测试 + 真实库只读验收，**不接业务生产者** | ◀ 本刀 |
| E3.2 最小生产者 | customer_replied / quote_asked 接入（最接近现有真实事实链） | 待定 |
| E3.3 Action events | script_copied / chat_opened / follow_up_done（P0-4 前置） | 待定 |

## ④ E3.1 设计

### Schema（sales 库，追加到 SCHEMA_SQL）

```sql
-- P0-3 E3 客户事件（append-only；客观发生的事实，非判断/状态——四者不互相冒充）
-- 硬门禁：event_type 只允许五类（加类型必须走迁移）；message_key 为 P0-2B 证据锚点
CREATE TABLE IF NOT EXISTS customer_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('customer_replied', 'quote_asked', 'script_copied', 'chat_opened', 'follow_up_done')),
  message_key TEXT,
  evidence_text TEXT,
  source TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_msgkey ON customer_event(message_key) WHERE message_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_session ON customer_event(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_type ON customer_event(event_type, created_at);
```

- **幂等**：partial unique index on message_key——有 key 的事件天然幂等（同 key 拒绝）；无 key 的手动事件（如 follow_up_done 手动标记）允许重复
- **证据约束**：message_key 复用 P0-2B（getEvidenceByKey 回查原话），与 customer_judgment 同一锚点机制，不发明第二套
- **source**：写入来源（'system' / 'manual' / 'rule' / 'ai'），与 intent_tag_log.source 同义
- **metadata**：JSON 扩展（如报价金额、脚本 id），可空

### shared/customerEvent.ts（纯模块零依赖，前后端共用）

```ts
export const CUSTOMER_EVENT_TYPES = ['customer_replied', 'quote_asked', 'script_copied', 'chat_opened', 'follow_up_done'] as const
export type CustomerEventType = (typeof CUSTOMER_EVENT_TYPES)[number]

/** 事件分类（只读派生，不加列）：客户行为 vs 用户行动 */
export type CustomerEventCategory = 'customer' | 'action'
export function customerEventCategory(t: CustomerEventType): CustomerEventCategory

export function isCustomerEventType(t: string): t is CustomerEventType  // 第一道 TS 拦截

export interface CustomerEventRecord {
  id?: number
  session_id: string
  event_type: CustomerEventType
  message_key?: string | null   // P0-2B 证据锚点
  evidence_text?: string | null // 证据原话/转述
  source: string                // system/manual/rule/ai
  metadata?: string | null      // JSON 扩展
  created_at?: number
}
```

### salesDbService 原语

| 原语 | 语义 |
|---|---|
| `customerEventAdd(input)` | append；TS 层 isCustomerEventType 守卫（非法抛错）；message_key 已存在 → 返回 null（幂等拒绝，不重复写）；返回新行 |
| `customerEventsBySession(sessionId, limit?)` | 该会话事件流，倒序 |
| `customerEventsByType(eventType, sinceMs?, limit?)` | 按类型查询（P0-4 漏斗 / E3.2+ 生产者验证用） |

消费原语最小化——E3.1 无消费者，够验证能力即可，其余等 E3.2/3.3 再补。

### 测试（scripts/customer-event-test.ts）

- **A 静态护栏**：五类型枚举无越界（不含 stage/judgment 类）；建表含 CHECK；幂等 unique index；原语命名；类型守卫被 salesDbService 引用；customerEventAdd 的 INSERT 只写 customer_event 一张表（四者不互相冒充）；盘点文档 Scope Lock 存在（文档同步护栏）
- **B 行为（temp DB）**：append 后可读；同 key 幂等拒绝；无 key 事件可重复写；非法类型抛错；bySession 倒序；byType + since 过滤；metadata 往返；与 intent_tag_log / customer_judgment 互不干扰（同 session 三表独立 append，事件不产生判断）

### 真实库只读验收（sql.js）

- customer_event 表存在性（应用若已以新代码启动）或 0 基线提示（表不存在 = 部署时序，同 p0-3-closed-gate 先例）
- 行数 = 0（E3.1 无生产者，正确）
- 全仓确认无任何 consumer 引用 customer_event（生产端未接，消费端为零）

## ⑤ 提交计划

- 一刀一提交（code commit：shared/customerEvent.ts + salesDbService + 测试；docs commit：设计文档 + HANDOVER + 盘点文档状态更新）
- 门禁：根 `npx tsc --noEmit` 0 错误 + node tsc 162 基线不新增 + 全量脚本回归（product-import 环境失败除外）
- AGENTS.md 更新（gitignore，不进 commit）
