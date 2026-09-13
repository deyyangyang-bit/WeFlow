# P0-2A Canonical State 设计

> 2026-08-23 · 设计定稿（只盘点 + 设计，未改任何代码 / schema / UI）
> 依据：docs/实施记录/P0-2-数据契约盘点.md（P0-2 三刀划分：P0-2A → P0-2B Evidence Resolver → P0-2C AI Judgment Persistence → P0-2 UI）
> 定位：**不是 CRM 状态机重构，是"谁有资格决定客户当前阶段"的定稿**。第一阶段只解决读取统一，写者收敛按独立提交逐步进行。

---

## 0. 关键前提（来自盘点）

> **如果完全关闭 AI，单靠现有数据：中间阶段（contacted/quoted/negotiating）无法知道；只有 won（正则 DEAL_WORDS）和 dormant（last_contact_at 规则）两个事实锚点可靠。**
> 因此现有 `customer_profile.stage` 本质 = **「AI 最近一次判断」的投影 + 人工纠正 + 两个正则锚点**，不是客户状态。
> AI Current Judgment 的架构含义：stage 必须带 source/confidence/changedAt/basis 元数据一起读，UI 区分「AI 判断」vs「事实信号」vs「人工确认」。

---

## 1. Canonical State 模型

**dormant 从 stage 拆出为 activityState（时间状态，不是销售进展），unknown 不作为正常 canonical stage。**

```text
CustomerState
├── stage             ← 核心销售阶段（进展语义）
│   ├── new           ← 刚建档，未实质沟通
│   ├── contacted     ← 有实质问答
│   ├── quoted        ← 销售已报价
│   ├── negotiating   ← 讨论付款/交期/比价/定制
│   ├── won           ← 成交
│   └── lost          ← 明确拒绝/选别家
│
├── activityState     ← 覆盖层（时间状态，可叠加任意 stage）
│   ├── active
│   └── dormant       ← 沉默 N 天（规则判定，从 active 进入，不改变 stage）
│
└── stateMeta
    ├── source        ← 谁判的（classifier / ai_intent / manual / deal_rule / rule / unknown）
    ├── confidence    ← 写者是否带置信度（null = 无）
    ├── changedAt     ← 当前 stage 最近变更时间
    └── evidence      ← basis（reason / evidenceText / messageKey）
```

- `unknown`：**数据异常 / 无法归一化状态**，不进入正常漏斗、不进入正常销售流程。
- 现有 8 值 canonical（new/contacted/quoted/negotiating/won/lost/dormant/unknown）**继续兼容**，但 Read Model 拆开：`dormant` → activityState，`unknown` → 异常位。
- 迁移：contacted → quoted → negotiating → won；any → lost。new → contacted 需实质沟通。

### 为什么 dormant 必须拆

> 一个已 `quoted` 的客户 30 天没联系 → stage 变 `dormant` → 客户回复 → 又得重新判回 `quoted`。

这会污染漏斗历史（"曾进入"按窗口去重），也让「当前阶段」与「是否活跃」混在一起。拆开后：quoted + dormant 并存，回复自动回到 active，stage 不变。

---

## 2. Stage Read Model

**概念接口（不改 schema，新增读取函数）**：

```ts
getCanonicalStage(customer): CustomerState {
  // stage          ← normalizeStage(profile.stage)  且 dormant/unknown 特殊处理
  // activityState  ← 由 last_contact_at + 沉默规则判定（规则层已有）
  // stateMeta      ← 装配自 intent_tag_log 最近匹配记录 + last_stage_change_at
}
```

**装配来源**（全部现有字段，只读）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `stage` | `customer_profile.stage` 过 `normalizeStage` | 仅取 6 值；dormant 落到 activityState，unknown 落异常位 |
| `activityState` | `last_contact_at` + 沉默阈值（规则层逻辑） | 独立于 stage，可叠加 |
| `stateMeta.source` | `intent_tag_log` 最近「归一化后 == 当前 stage」记录的 `source` | classifier / ai_intent / manual / deal_rule |
| `stateMeta.confidence` | 该记录 `confidence`（insight 路径恒 0.7 已无资格；无则 null） | |
| `stateMeta.changedAt` | `last_stage_change_at`（写者覆盖不全时回退该记录 `created_at`） | 仅 classifier 当前可靠 |
| `stateMeta.evidence` | 该记录 `reason / evidence_text / message_key` | |

**阶段一目标**：全部 UI / 评分 / 规则改走 `getCanonicalStage`，6 个写者不动。

---

## 3. 写者收敛（写入资格定稿）

| 来源 | P0-2A 资格 | 收敛动作 |
|---|---|---|
| **classifier**（onNewMessage 增量） | ✅ 保留合法 AI 写入源 | 现状已达标：英文 canonical + confidence + reason + evidence + 阶段变化才写 + 更新 changedAt。是写入标杆 |
| **salesIntentService**（手动 AI 意向分析按钮） | ✅ 保留合法写入源 | 手动触发，证据完整。中文值经归一后落 canonical |
| **manual correct**（sales:intent:correct） | ✅ 保留（只能人工） | 校验值合法性（拒绝非枚举值）+ 补写 `last_stage_change_at` |
| **deal rule**（crmParseService 私聊成交正则） | ✅ 保留合法写入源 | 非 AI 强信号。补写 intent_tag_log + `last_stage_change_at` |
| **insightService**（见解扫描） | ❌ **降为 signal，禁止直接写 `customer_profile.stage`** | **暂不引入"高置信 + 阶段推进 → 覆盖"规则**（会重新引入一套 stage 仲裁）。只写 intent_tag_log（signal）+ 提示。等 CustomerEvent / Evidence / 多来源事件模型完成后，再做真正的 `signal → evidence → state transition → canonical stage` |
| **generic upsert**（sales:customer:upsert） | ❌ **移除直接写 stage 资格** | stage 移出该 IPC 可写字段（或强制 normalize+校验）；display_name/tags/notes 保留 |
| **dormant rule**（R5 / last_contact_at） | ❌ **不写 stage，写 activityState** | dormant 是 activityState，与 stage 解耦 |

**写入资格总原则**（未来所有写者必须满足）：
① 值合法 canonical（写前归一或校验）② 带 source 元数据 ③ 阶段变化才写（幂等拦截）④ 写 `last_stage_change_at`。
不满足的 → 降级为"写 intent_tag_log signal，不覆盖当前 stage"。

---

## 4. intentScore：定位 + 两个 bug（不重做算法）

**定位**：名义综合意向分（阶段 + 行为 + 衰减 + 商机），P0 设计意图不变。**不重新设计评分模型，只修两个明确 bug。**

输入来源拆解：

| factor | 输入 | 来源 | 现状问题 |
|---|---|---|---|
| 阶段基础分 | stage | customer_profile.stage | **bug 1**：`STAGE_BASE` 中文键 vs 原始 stage（英文 canonical）→ 分类器路径 base 恒 0 |
| 近期意向活跃 | 近 7 天 intent_tag_log 计数 | intent_tag_log（毫秒） | ✓ |
| 久未跟进衰减 | lastEventAt 优先，无则 lastContactAt | intent_tag_log（毫秒）/ `customer_profile.last_contact_at`（**秒**） | **bug 2**：毫秒减秒 → 无意向日志客户衰减恒 30 |
| 商机进展 | activeOpportunitiesByAccount | opportunity（跨库，毫秒） | ✓ |

**修法（bug fix，非重设计）**：
- **bug 1**：`STAGE_BASE` 键改为 **canonical**（new/contacted/quoted/negotiating/won/lost），`intentScore()` 输入 stage 先过 `normalizeStage()`。理由：全系统读写已走向 canonical，中文键只是历史遗留。
- **bug 2**：lastContactAt 传入前统一 秒→毫秒。

```text
normalizeStage()
      ↓
canonical stage
      ↓
STAGE_BASE        （bug 1 修复）

lastContactAt(seconds)
        ↓
统一 milliseconds  （bug 2 修复）
        ↓
decay
```

---

## 5. 执行边界与下一步

**P0-2A 边界（防止膨胀成状态机重构）**：
- 不建 AI Current Judgment schema、不动 UI
- 不改 6 个写者的枚举语义（8 值兼容，Read Model 拆开）
- insightService 只拔污染源（禁写 stage），不引入仲裁规则

**下一步进入代码（按独立提交逐步进行）**：
1. **先修 intentScore 两个 bug**（canonical 键 + normalizeStage + 秒→毫秒）
2. **建立 canonical read model**（getCanonicalStage，全部读取入口统一）
3. **写者收敛按独立提交**：先拔 insightService 直写 → 再拔 generic upsert stage 资格 → manual/deal rule 补元数据

每步独立提交、独立验证（tsc 0 错误 + 既有测试回归 + 新测试），确认后再进 P0-2B Evidence Resolver。
