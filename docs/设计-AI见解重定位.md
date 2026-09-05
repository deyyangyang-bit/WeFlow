# 设计：AI 见解重定位——从「消息触发」到「决策时刻触发」

> 状态：已评审定稿（2026-09-05，Kimi 初稿 + GLM 逐项核实与修订，合并版）；**阶段一已实现**（2026-09-05，HANDOVER §2.64），**阶段二已实现**（§3.1 晨间摘要=HANDOVER §2.65；§3.2/§3.3 触发重路由+信箱改告警箱=HANDOVER §2.66），阶段三待实施
> 前置依据：PRD v3.4 实测基线（行动卡执行率 0.6%，AGENTS.md「真实运行观察期」收档结论）；数据宪法 §1.10（evidence 规范）、§2.1（SSOT 先行登记）；HANDOVER §2.26（AI 销售副驾驶定位）。
> 事实核查：本稿引用的代码位置/既有机制共 15 处已逐一对照源码核实（PRD 0.6%、DATA-CONSTITUTION §1.10/§3、evidenceResolver.getEvidenceByKey、parseRiskSignal competitor、R2 规则、report_snapshot 结构、signal-notice 槽位等全部属实）。

## 0. 诊断（为什么改）

现有 AI 见解 = 每条新消息 → LLM 评论一句 → 推灵感信箱 + 今日行动卡流。三个先天问题：

1. **评论员而非参谋**：内容多为「对方需求真实，建议追问」——销售自己看完聊天也知道的事。
2. **与已有 AI 能力多头并行**：商机识别（parseBuySignal→opportunity）、阶段分类器（salesStageClassifier）、风险识别（parseRiskSignal→crm_risk）、AI 当前判断（customer_judgment）各自成链，见解是又一个声音，内容高度重叠。
3. **时机错误**：销售是批量作业（早上规划、通话前准备），见解却按消息流插嘴；实测 0.6% 执行率说明推送量与行动量负相关。

**根因：不是「见解不够准」，是「触发逻辑错了」。** 阶段一止血（噪音治理），阶段二治形（触发重路由），阶段三立门槛（例外告警）。

## 1. 目标定位：三个决策时刻

| 时刻 | 问题 | 形态 | 现状 |
|---|---|---|---|
| ① 早上开工 | 今天先跟谁？ | **每日一条晨间摘要**（批量，非散装） | 缺失，阶段二新增 |
| ② 打开客户 | 这人什么情况？下句说什么？ | 按需召唤（AI 当前判断 / 深度分析 / AI 报价） | 已有，保持不动 |
| ③ 例外 | 错过会亏钱的事 | **白名单告警**，带原话证据，不出证据不许报 | 灵感信箱改造 |

原则：**平时安静，早上给方向，点开给判断，出事才喊你。**

## 2. 阶段一：噪音治理（一个提交）

外部自动化工具（群发、删好友检测脚本）写入微信库的消息被当成客户行为：群发触发 N 次扫描、系统消息（type 10000「你已添加了…」）在上下文里冒充对方发言 → AI 产出「对方多次加好友」类错误见解。

### 2.1 新模块 `electron/services/insightNoiseFilter.ts`

零 electron/chatService 依赖（消息用结构化最小类型），可 tsx 单测：

- `classifyInsightMessage(msg)` → `'customer' | 'own' | 'system'`：system = localType 10000（系统消息）/ 266287972401（拍一拍）；own = isSend===1；其余 customer。
- `scanMessagesForTrigger(messages, lastSeenTs)` 纯函数：返回 `{ shouldTrigger, latestTs, ownTexts }`——存在 `createTime > lastSeenTs` 且分类为 customer 的消息才 shouldTrigger；ownTexts 供群发检测器采集。
- `MassSendDetector`（被动检测，零额外 DB 查询）：
  - `recordOwnText(sessionId, content, ts)`：own 文本 ≥2 字 → 内容归一化哈希 → `{sessions:Set, lastHitAt}`；距上次命中 >72h 视为新 campaign 重置；同内容 ≥3 个不同会话 → 标记为群发模板至末次命中+48h；>7 天条目周期清理。
  - `isMassSendTemplate(content)`：命中未过期标记 → true。

### 2.2 触发过滤（`insightService.analyzeRecentActivity` 两条路径）

- 白名单路径（现拉 1 条即触发）与黑名单路径（只看 session 缓存时间戳）统一改为：**拉最新 10 条** → `scanMessagesForTrigger`。
- 仅 own/system 新消息 → 只更新 `lastSeenTimestamp`，不触发（群发风暴根除）。
- 冷却期检查保持在拉消息**之前**（不增无效查询）。
- 附带修复：客户回复后紧接着自己群发、两条都未扫过时，旧逻辑只看最新 1 条会吞掉客户回复；10 条窗口内仍能找到。边界：窗口外被埋没（两次扫描间隔 >10 条）接受为启发式限制，已记设计取舍。
- **分类器闸门（补充）**：`actionStageClassifier`（insightService.ts 黑名单路径，新消息到达即跑）受同一闸门管——仅 customer 消息触发时才跑，防群发/系统消息浪费分类器 API 并误写 stage。
- 顺带修：dedup 跳过日志文案「12h 内已生成过见解」与常量 24h 不符，改为 24h。

### 2.3 上下文标注（`buildInsightContextSection`）

- system 消息 → 说话人显示 `系统`，内容前缀 `[系统消息]`（不再冒充对方发言）。
- own 且命中群发模板 → 内容前缀 `【疑似群发·批量触达】`。
- 返回值改为 `{ text, hasNoise }`（唯一调用方在 generateInsightForSession）。

### 2.4 Prompt 护栏

仅当上下文含噪音标注时，user prompt 追加：

> [系统消息]为微信或自动化工具产生，不代表对方发言；【疑似群发】为你方批量触达模板。禁止将两者解读为对方的行为、意向或回复。

system prompt 不动（保 API 缓存命中）；无噪音时 prompt 保持原样。

### 2.5 原子写（补充）

`insightRecordService.persist()` 的 `writeFileSync` 直写换 `atomicWriteFileSync`（atomicPersist.ts，与 sql.js 落盘铁律同型风险：截断窗口崩溃 → JSON 损坏）。

### 2.6 测试与验收

`scripts/insight-noise-test.ts`（tsx，跟随 insight-dedup-test 惯例）：
a) 三分类正确（含拍一拍归 system）；b) 群发检测：3 会话命中标记 / 2 会话不标 / 48h 过期 / 72h 重置；c) 触发扫描：最新为群发不触发、10 条内埋客户回复仍触发、lastSeen 更新正确；d) 护栏仅在有噪音时追加；e) 上下文标注归因正确（系统消息说话人=系统）。
验收：`npx tsc --noEmit` 零错误 + `npx tsc -p tsconfig.node.json --noEmit` 无新增错误；测试全绿；文档同步。

## 3. 阶段二：触发重路由

### 3.1 晨间摘要（每日一条）

- **调度器** `startMorningDigestScheduler`：挂 main.ts 启动链（`startActionEngineScheduler` 旁），仿其时间窗写法（setInterval 30 分钟检查「08:05-08:35 且今日未跑」→ `enqueueSalesTask`）。故意设在 08:00 runFullScan 之后，摘要基于当天最新卡流。
- **生成** `morningDigestService.ts`（零 electron 依赖纯核心 + 薄壳）：
  1. 取 `getUnifiedSignals()` top 10（已有 priorityScore 排序）；
  2. 单次 LLM 调用：输入卡片清单（客户/阶段/规则理由/沉默天数/商机金额），输出「今天先动这 3 个 + 每人一句人话理由」；
  3. **AI 失败降级**：不调 AI 直接取 priorityScore top 3 + 规则理由拼接——摘要永远有，AI 只负责更好读。
- **落库**：复用 `report_snapshot`（period_type='morning_digest'，ai_summary 存正文）——现存唯一「周期级 AI 文本」容器，不建新表。
- **展示**：TodayActionPage 复用 `.signal-notice` banner 槽位（可 dismiss 提示条形态），晨间摘要优先于现有「高意向动向」提示。点摘要条目 → 深链 `/customers?id=`。
- **成本**：1 次 API 调用/天。

### 3.2 散装见解降级：进档案，不进卡流

activity/silence 触发的见解**继续生成**（customer_judgment 与 enrich 的上游，P0-3 currentView 依赖预计算），但：

- **从 `getUnifiedSignals` 卡流移除**（删 salesActionEngine 的 insight 合流分支与 INSIGHT_BOOST）；
- **insightRecord 照写、改语义**（⚠️ 评审修正：Kimi 原稿「不再写 insightRecord」会炸掉 24h 去重——`generateInsightForSession` 的去重闸门 `hasRecentRecord()` 读的就是记录，停写则每条客户消息都触发 LLM 调用）：activity/silence 记录打 `sourceType='archive'`，信箱列表默认过滤 archive，`hasRecentRecord` 读全量（去重保住）。语义：「记录 = 分析事实 SSOT，信箱 = 告警视图」。
- 前端配套清理：**store 三处 + 页面 chips**（实现前先盘点 insight 在前端的状态消费点，盘点结果落 HANDOVER 增量；已知 TodoSidebar.tsx 消费 insight 记录，卡流渲染分支同步清）。
- message_analysis（手动解析）保持原样。

### 3.3 灵感信箱 = 告警箱

信箱 UI 保留，数据源不变（insightRecordService），写入方只剩阶段三的告警白名单。页标题改「重要提醒」。存量垃圾记录手动清 `weflow-insight-records.json`（数据清理，不写代码）。

## 4. 阶段三：例外告警白名单

### 4.1 告警契约（所有告警必须满足）

1. **证据强制**：每条告警携带 `message_key` + 客户原话 ≤200 字；创建时经 `evidenceResolver.getEvidenceByKey` 校验 `status='found'`，验不出原话 → 告警不成立，直接丢弃（符合宪法 §1.10：key 引用不复制正文，evidence_text 仅展示快照）。
2. **幂等去重**：同客户同告警类型 72h 内不重复（沿用 INSIGHT_RECORD_DEDUP_MS 模式）。
3. **落库**：insightRecord（triggerReason=`alert:<type>`），进信箱 + 今日行动卡流（新 SignalSource type='alert'，加分高于 rule 卡，因为稀缺）。
4. **评测准入**：每类告警上线前过离线评测（§4.3），准确率 ≥85% 才获得「主动弹」资格；不达标降级为档案标注（customer_judgment risk 类型，不打扰）。

### 4.2 告警目录 v1（按实现成本排序）

| # | 告警 | 识别层 | 处置 |
|---|---|---|---|
| A | **竞品提及** | 复用 `parseRiskSignal` competitor 分支（识别层零改动），在 crmParseService upsertRisk 命中点补 messageKey 锚点 + 出告警 | **第一个做** |
| B | **客户明示流失**（「不买了/找别家了/已经买了」） | 新增规则（parseRiskSignal 同型风格），先离线评测再上线 | 第二个做 |
| C | ~~决策中 48h 未回~~ | 与 R2（negotiating 沉默≥2 天）+ urge 扫描双出卡 | **不做** |
| D | **承诺打款日过期** | 全新机制：聊天里识别未来日期承诺 + 到期扫描比对 payment_record | 最后做，独立设计 |

### 4.3 评测集扩展（告警准确率）

- 新表 `alert_eval_case`（salesDb，结构仿 opportunity_eval_case：label 三档 / evidence keys / 人机分存 / status CHECK）。**SSOT 铁律：先入 DATA-CONSTITUTION §3 登记再建表。**
- 不复用 opportunity_eval_case：label 语义、UNIQUE 键、候选生成逻辑全商机专属，evalStats 全表聚合会被污染。
- 离线跑法：对历史聊天副本跑识别规则 → 候选 → 评测标注页复核 → 算准确率 → 达标签「获准推送」。

## 5. 明确不做

- 自动回复 / 对外发送（宪法红线）；
- 告警规则配置 UI（阈值走常量，先不开设置项）；
- activity/silence 见解的 prompt 调优（降级为档案标注后独立后续项）；
- 晨间摘要多条化 / 分时推送（一天一条，先证明有人看）；
- 群发效果复盘视图、`lastCustomerMessageAt` 新鲜度字段（twenty 模式借鉴，阶段二落地后评估是否值得——阶段一闸门后新数据已干净）。

## 6. 验收

- **阶段一**：noise 测试全绿；群发后信箱零新增；系统消息在上下文中归因「系统」。
- **阶段二**：信箱一周新增 < 10 条且全部为告警；今日行动卡流零 insight 来源卡；晨间摘要每日 08:05-08:35 生成、AI 挂掉时降级摘要仍在。
- **阶段三**：每类告警评测准确率 ≥85% + 100% 带可回溯原话（evidenceResolver found）。
- 测试跟随仓库 tsx 脚本惯例：insight-noise-test / morning-digest-test / alert-gate-test（证据校验丢弃、72h 幂等、评测门槛路由）。
- 文档同步铁律：实现完成后 HANDOVER 增量小节 + 本设计稿标注「已实现」。

## 7. 与既有机制映射（防重复建设）

| 新需求 | 已有机制 | 处置 |
|---|---|---|
| 摘要落库 | report_snapshot（period_type/ai_summary） | 复用 |
| 证据校验 | evidenceResolver.getEvidenceByKey | 复用，告警强制过它 |
| 竞品识别 | parseRiskSignal competitor + crm_risk | 复用，只补 messageKey + 出告警 |
| 决策中未回 | R2 rule_r2_negotiating_stall + urge 扫描 | 不新建 |
| 按需分析 | customer_judgment + 档案三按钮 | 不动 |
| 去重 | insightRecord + hasRecentRecord | 保留（archive 语义化，见 §3.2） |
| 评测流程 | opportunity_eval_case + 评测标注页 | 仿造新表，流程复用 |

## 8. 实施顺序与提交切分

1. **阶段一（一个提交）**：insightNoiseFilter 新模块 → 触发过滤两路径+分类器闸门 → 上下文标注 → prompt 护栏 → 原子写 → noise 测试 → tsc 双检查 → 文档同步。
2. **阶段二**：晨间摘要（调度器/服务/降级/落库/展示）→ §3.2 触发重路由（含 archive 语义配套修 + 前端清理）→ 信箱改造 → morning-digest-test。
3. **阶段三**：告警 A（竞品锚点）→ 评测基建（宪法 §3 登记先行）→ 告警 B → 告警 D 独立设计。
