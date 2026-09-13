# P0-3 Current Judgment Consumer Layer：盘点与设计草案

> **状态：盘点完成，设计草案待拍板（2026-08-23）。本阶段不写代码。**
> 前置：P0-2 已 CLOSED（A=State / B=Evidence / C=Judgment 三真源封板，`docs/实施记录/P0-2-收口-契约验收.md`）。

## 1. 背景

P0-2 完成了"数据真源重构"：stage 归 canonical、证据锚定 messageKey、AI 判断持久化到 `customer_judgment`。
P0-3 要做的是把三层真源**组装成单一消费视图**，终结"七张表自己拼 AI 结论"。

```text
Canonical State（现在是什么状态）
   + Evidence（为什么：锚点 + 原文 + 状态）
   + Judgment（AI 当前怎么看：四类判断）
        ↓
getCustomerCurrentView()  —— 唯一消费入口（草案）
        ↓
   360 / Action / UI
```

## 2. 消费者清单（现状盘点，2026-08-23 代码级）

### 2.1 直接拼装点

| 消费者 | 入口 | 现在读什么 | 拼了什么"AI 结论" |
|---|---|---|---|
| **客户 360** | `crm:customer:profile`（crmIpcHandlers.ts:155） | profile + insight records（insightRecordService）+ account/contracts/credited（crmDbService）+ **advice=generateActionAnalysis 现场生成** | 机会/风险/下一步 = 每次打开客户**现场调 LLM**（C.3 已同步落库，但展示仍走现场结果） |
| **SalesContextStrip**（客户上下文条） | `sales:customerGet` + `sales:intentHistory` + `sales:actionSuggest` | 单客户 profile + 意向历史 + 用户主动触发建议（main.ts:4909 现场生成） | 建议五字段 = 现场生成 |
| **今日行动** | `actionGetUnified`（todoList + analysis JSON） | follow_up_task + `analysis` JSON（预热路径写的） | 机会/风险/下一步从 **analysis JSON 字符串**里反序列化 |
| **见解收件箱** | `insight:listRecords` | insight_record（JSON 存储） | summary 展示走 JSON 文件，**不读 customer_judgment(summary)** |
| **漏斗** | `sales:funnel:stats` | customer_profile.stage（读取时归一） | 无 AI 结论（State 消费，已规范 ✓） |
| **周报** | salesReportService | — | **0 处引用 customer_judgment**，非当前消费者 ✓ |

### 2.2 数据形态分裂（本次盘点核心发现）

**同一份"AI 当前判断"，现在有三份不同存储：**

```text
customer_judgment（真源，C.3 后新写）      ← P0-2 建立的规范存储
follow_up_task.analysis（预热 JSON 字符串）← 旧链路仍在写（新旧并存期）
insight_record（JSON 文件）               ← summary 旧存储（C.2 明确不取代）
```

三份数据**未同步**：360 打开过的客户有 judgment；预热过的任务有 analysis JSON；见解收件箱只有 JSON 记录。
P0-3 消费层必须**以 customer_judgment 为唯一真源**，旧存储保持"历史展示"地位（不做迁移、不删）。

### 2.3 消费需求提炼（UI 实际需要什么）

从四个消费者反推，"AI 当前判断"视图需要的是：

1. **四类判断的当前值**（summary / opportunity / risk / next_action）—— 有就有，无就空态
2. **每条判断的证据**（能回查原话 → 展示锚点；不能 → 明确 unavailable，不假装有）
3. **新鲜度**（判断是什么时候生成的——老判断不能冒充当前判断）
4. **来源**（ai 自动 vs manual 用户认可——manual 优先级展示）
5. **状态锚点**（canonical stage / activityState 作为判断的上下文）

## 3. Current ≠ Latest：语义设计（核心）

### 3.1 现状

`judgmentCurrent` = `ORDER BY created_at DESC, id DESC LIMIT 1`——这是 **Latest**，不是语义化的 **Current**。

### 3.2 定义：Current = 该类型最新一条判断 + 三维派生语义

append-only + 按类型去重（24h 窗口）保证：**同一 session 同一类型在窗口内最多一条**，因此"最新一条"天然是"当前有效解释"。但消费层必须在 Latest 之上**显式投影**三个维度，禁止消费者自己从原始行再加工：

```text
Current Judgment（每类型）
├── value            = 最新一条判断值（不合并、不平均、不拼接历史）
├── freshness        = generated_at 距今：
│     ├── fresh      = ≤ 24h（去重窗口内：当前解释）
│     ├── stale      = > 24h（窗口外无更新：解释过期，视图标注"N 天前"）
│     └── none       = 该类型从未生成
├── evidenceStatus   = ok（message_key 可 P0-2B 回查）| unavailable（诚实标注，不伪造）
└── source           = ai | manual（manual = 用户主动认可，展示优先级高于 ai）
```

### 3.3 关键边界（防止消费层再造真源）

- **投影不做推理**：Current View 只做"选最新 + 派生状态"，**不做**——合并多类型、取历史均值、拼接多行、现场调 LLM、拿 analysis JSON 顶替。
- **freshness 窗口沿用 24h 去重窗口**：同一窗口即业务语义（与见解/摘要去重一致），不另造阈值（是否放宽到 3 天，见 §6 待拍板）。
- **manual 覆盖权在写入层已保证**（跳去重窗口），消费层只需呈现 source，不参与仲裁。
- **缺判断的客户**：视图返回空态（`none`），不编造"AI 暂未生成"之外的文案逻辑。

## 4. API 契约草案（不提交，等消费边界拍板）

```ts
// 主进程组装层（唯一入口；不落库、不做推理）
getCustomerCurrentView(sessionId: string): CustomerCurrentView

interface CustomerCurrentView {
  state: {
    stage: StageCanonical          // canonical（读模型）
    activityState: 'active' | 'dormant' | 'unknown'
    lastContactAt: number | null
  }
  judgments: {
    summary:      CurrentJudgment | null   // null = none（空态）
    opportunity:  CurrentJudgment | null
    risk:         CurrentJudgment | null
    nextAction:   CurrentJudgment | null
  }
}
interface CurrentJudgment {
  value: string
  freshness: 'fresh' | 'stale'
  generatedAt: number
  source: 'ai' | 'manual'
  model: string | null               // PRD§23 溯源
  evidence: { status: 'ok' | 'unavailable'; messageKey: string | null }
}
```

**IPC 通道选择（草案倾向）**：新增只读 `sales:customer:currentView`，**不动** `crm:customer:profile` 的现场拼装——
360 保留"时间线/业务对象"职责，Current View 只服务"AI 当前判断卡"；避免一次改造把 360 拖下水。
（等 UI 消费边界确定后再定，见 §6。）

## 5. 消费改造方向（盘点结论，非本期实现）

```text
客户 360 判断卡： 现场 advice 展示 → 改为消费 currentView.judgments
                  （现场生成仍保留：suggest=用户主动刷新，写入层已跳去重=覆盖权利）
SalesContextStrip：customerGet + intentHistory 保持；建议区消费 currentView
今日行动卡：      analysis JSON 反序列化 → 优先消费 currentView（旧 JSON 只作历史）
见解收件箱：      summary 展示 → 可增 customer_judgment 通道（insight_record 保留历史）
```

## 6. 待拍板（进入实现前必须钉死）

1. **freshness 阈值**：沿用 24h（与去重窗口一致，推荐）还是放宽到 3 天？—— 直接决定"旧判断"在视图上是否标 stale
2. **空态表现**：无判断客户（当前 194/200）视图显示什么？"AI 判断生成中" vs 纯空——影响用户预期
3. **evidence 回查触发点**：判断卡上点证据 → 走 P0-2B 回查弹原话，还是只在卡片显示"有据可查"状态？（UI 阶段定）
4. **IPC 通道**：独立 `sales:customer:currentView` vs 扩展 `crm:customer:profile` 返回体
5. **summary 覆盖**：目前 0 条（见解链未触发）；消费层上线时若仍为 0，判断卡 summary 区直接空态——是否接受

## 7. 铁律（延续 P0-2 护栏）

- 消费层**不做推理**：不现场调 LLM 拼当前判断、不合并多类型、不拿 analysis JSON / insight_record 冒充 customer_judgment
- **底层真源不改**：P0-3 只读，schema / 写入链 / 去重语义全部不动
- **UI 只消费 Current View**，不再自己查七张表
