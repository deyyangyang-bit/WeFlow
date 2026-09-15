# WeFlow AI 销售助手 · 交接文档（HANDOVER）

> 给**任何接手者 / 新会话 / clone 本仓库的人**看的全局交接文档。
>
> **文档导航入口 = `docs/CURRENT.md`**（现行权威文档清单 + 冲突优先级）。本文档头部之后的 §2.x 是**按时间记录的历史流水，仅作追溯**，不代表当前状态。
>
> **当前需求文档 = `docs/规划/weflow-hermes-PRD-v3.4.md`**（Phase 0 数据宪法 / Phase 1 单机可靠性 / Phase 2 Hermes 与知识治理；开发约定见 `AGENTS.md`）。
> **上一阶段主线「AI 销售副驾驶」（§2.26）已于 2026-08-24 P0-4 CLOSED 后收口**，成果仍在主干运行（`customer_judgment` + `getCustomerCurrentView()`、`customer_event` + `task_id`、双漏斗 UI）。§2.26 的 P0-5（L0-L3 文档化）从未产出，已作废。**新会话不要按 §2.26 路线继续开发。**
> **Phase 3a 中央同步（当前重点）**：首轮实现 = `160786e` / `b295155` / `ae6903b`；2026-09-15 阻断项修复 = `8e757f7`（中央协议与服务端闸门）/ `7a4c5fa`（本机侧出机白名单、双向投递与版本化增量）/ `5024030`（真实契约闭环测试）/ `aa73c26`（文档校准）。详见 **§2.104 / §2.105** 与 `docs/audit/中央同步-阻断项修复-审计报告-claude-20260915.md`。**Phase 3a 代码侧仍未收口**——部署、真机、Windows、SSE、真实消息推送验收全部未做。第四轮收口（§2.108：升级前 pending 移交惰性兼容 / 失败 outbox 正式重投入口（替换测试里的 SQL 翻转）/ `mode` 四值枚举收紧 / `entityId` 必须具体引用 / p0-3 门禁输出脱敏）已完成并通过自动化验证。第五轮收口（§2.109：历史移交富化的**一致性核对**与字符串 SLA 拒收 / 本机分配 `mode` 与同步接收端共用同一四值契约（`assignLeads` 非法值零写入、批量**不再静默回退** `weight`）/ 重投结果按**该行自己的最终状态**判定（「重新排队」≠「同步成功」）/ p0-3 文案哨兵**真的写进合成库**（消除空断言）/ 适配器测试**不再直接改 outbox 状态**）已完成并通过自动化验证。
> 基线 commit `d40cd4d`；（历史）AI 销售副驾驶 §2.26 已收口，见文件头；客户名真相源修复（微信号名回填微信真实备注）见 §2.25（已提交）；漏斗改造（历史累计流转 + canonical 语义层 + 下钻修复）见 §2.24（已提交）；物流群扫描失效修复见 §2.23（getMessages 升序 + 传 startTime 扫增量，已提交）；最近提交 **P0-4.4 打磨修正**（`828b6bb` 固定比例梯形 + svg 圆角渐变 + 主题蓝箭头 + 映射 tooltip + 删跳级；`a21fc2e` 文档；见 §2.38）+ **P0-4.4 双漏斗 UI 统一视觉体系**（`e0736b3` 四档窗口 + 蓝系渐变 + 行动漏斗 HTML/CSS 自绘梯形 + 映射 tooltip，纯 UI，见 §2.38）+ P0-4.3 UI/KPI 消费（`94f1bbb` 五段漏斗 + 6 KPI + 点击下钻可追溯 + breakdown 下钻原语共享判定行，25/25，**P0-4 CLOSED**，见 §2.37）+ P0-4.2.3（`e431221` 护栏 17/17 + 验收文档 `docs/实施记录/P0-4.2-收口-契约验收.md`，**P0-4.2 CLOSED**，见 §2.36）+ P0-4.2.2（`20ddc3f` getActionFunnel Task-level 只读组装层：六段去重 / sources 逐段 / rate null 守卫 / superseded 排除 / 时序守卫 / days 只过滤 created，19/19 + 真实库验收 5/5，见 §2.36）+ P0-4.2.1（`4292d06` correlation 补齐：customer_event.task_id + 三写点带 task_id，20/20，见 §2.36）+ E3 收口（`d97f663`，16/16，见 §2.35）+ P0-3 收口（`scripts/p0-3-closed-gate.ts` + `docs/实施记录/P0-3-收口-契约验收.md`，**P0-3 CLOSED**，见 §2.34）+ `03d994d`（P0-3.4：今日行动卡判断展示消费 currentView，analysis JSON 不再冒充当前判断，见 §2.33）+ `14eaa07`（P0-3.3：SalesContextStrip 消费 currentView + suggest 主动生成保留 + 落库断链修复，见 §2.32）+ `9a375b3`（P0-3.2：Customer 360 判断卡消费 currentView，360 不再现场调 LLM，见 §2.31）+ `7950ca6`（P0-3 第一刀：customer current view 只读组装层 + 独立 IPC，见 §2.30）+ `2ce99fc`（P0-2 收口 runtime CLOSED）+ `2932195`（P0-3 Current Judgment Consumer 盘点）+ `35519a1`（P0-2 收口：真实库只读盘点 + 契约验收封板）+ `057f8aa`（P0-2C.3 action analysis 三调用点统一落 judgment）+ `fc654b2`（P0-2C.2 summary 判断落库）+ `07241f4`（P0-2C.1 customer_judgment 基础设施）+ `21fd148`（P0-2B evidence resolver）+ `04dbaec`（P0-2B messageKey 集中化）；`3ff3f1f`（P0-2A.6 manual/deal 写者元数据收口）；`ef100ed`（2026-08-23 漏斗改造：历史累计流转 + canonical 语义层 + 下钻修复，见 §2.24）；P0-1 AI 证据链 `4338921`——intent_tag_log 证据列 message_key/evidence_text + follow_up_task.source_message_id，三件运行时验证通过，见 §2.26；P0-2A 六刀已全部提交：`6bf1ff6` intentScore 两 bug → `a3f3479` canonical read model（真实库并行验证 0 漏斗变化）→ `308d5d9` action rules 阶段口径归一 → `53ee94b` insightService 禁写 stage 降 signal → `2933a2d` generic upsert 移除 stage 资格（IPC 运行时剥离 + TS 类型删除双保险，tags/notes 仍正常更新）→ `3ff3f1f` manual/deal rule 写者元数据收口（manual 校验值合法性 + changedAt；deal rule 补写 intent_tag_log + changedAt）；**P0-2 数据契约盘点完成**（`docs/实施记录/P0-2-数据契约盘点.md`；**P0-2A Canonical State 设计已定稿**，`docs/P0-2A-Canonical-State-设计.md`——canonical stage 6 值 + activityState 拆 dormant + unknown 异常位；写者资格 classifier/intent/manual/deal 保留、insightService 禁写 stage 降 signal、generic upsert 移除、dormant 规则写 activityState；intentScore 只修两 bug 不重做算法；**六刀已全部提交**）；**P0-2B Evidence Resolver 两刀已提交**（`04dbaec` messageKey 构造集中 + `21fd148` 统一证据读入口，45 测试断言含只读验证，设计 docs/P0-2B-Evidence-Resolver-设计.md）；**P0-2C AI Judgment Persistence 三刀已全部提交**：`07241f4`（P0-2C.1 customer_judgment 基础设施，盘点 docs/P0-2C-AI-Judgment-Persistence-盘点.md）+ `fc654b2`（P0-2C.2 summary 落库，接入 generateInsightForSession）+ `057f8aa`（P0-2C.3 action analysis 三调用点统一落 judgment）；**P0-2 已收口 CLOSED**（静态契约验收全绿 + 真实库只读盘点 + 8 条架构护栏封死，见 §2.29，下一动作 = P0-3 Current Judgment Consumer Layer））；客户名称读取侧统一 + 同名不跨会话 + logi 签收闭环 `068a403`，见 §2.20；SLA 首触卡移出主卡流 `c90e6c9`，见 §2.17；今日行动/待办职责分工 `d5b9f62`，归档 FollowUpPage，见 §2.19；AI 回写 model/sourceId 溯源 `223c158`，见 §2.18；SLA 卡置顶+提分 `678e3f0`，见 §2.17；线索池排序 `3156910`；SLA/Action 接通 `5ba531b`，见 §2.17；Customer 360 统一时间线 `6c439bf`，见 §2.16；侧边栏导航收口 7 模块 `09d5600`，见 §2.15；信息待确认迁至工作台客户 tab `57c4e0f`；跟单中心物流卡两行化 `bfed14d`；新建合同选型号 `3e44a12`；复盘排除非销售联系人 `ed510df`；销售复盘改造 `9a9fbaf`；AI 见解 24h 去重+非客户黑名单 `f02b13c`；今日行动新建待办 `8085dc2`；漏斗深链 `11359fe`；漏斗数据 `c719678`；P0 见 `0eab71f`；阶段性交接见 docs/归档/交接旧版/HANDOVER-20260818-CRM零操作改造与产品库.md）。
> `npx tsc --noEmit` 零错误；crm 全系单测：workbench **50/50**、golden **45/45**、claim **17/17**、autoconfirm **58/58**、docgen **68/68**、enrich **55/55**、lead **53/53**、logistics **37/37**、opportunity **45/45**、funnel **40/40**（历史累计流转漏斗 + P0-1 证据断言）、todo-followup **11/11**（手动待办）、report-review **33/33**（销售复盘）、message-key **17/17**（P0-2B messageKey 构造集中）、evidence-resolver **45/45**（P0-2B 证据统一读入口，含只读断言）、customer-judgment **40/40**（P0-2C.1 AI 判断基础设施，禁 stage 硬门禁 + 证据诚实）、summary-judgment **33/33**（P0-2C.2 summary 落库：证据诚实 / append-only 去重 / 手动覆盖权利）、action-analysis-judgment **37/37**（P0-2C.3 三调用点统一落 judgment：任务锚点证据 / 兜底链路 / 按类型去重 / suggest 手动覆盖 / 三层分离）、current-view **30/30**（P0-3 第一刀只读组装层：空态 / 投影 / freshness 窗口 / analysis 不并入）、customer360-consumer **13/13**（P0-3.2 360 消费 currentView：无现场 LLM / 无 advice 直读 / UI 不直读真源）、sales-context-strip **10/10**（P0-3.3 状态条消费 currentView：suggest 主动生成保留 / sessionId 断链修复 / 生成后立即重读闭环）、today-action-consumer **14/14**（P0-3.4 今日行动卡消费 currentView：analysis JSON 不再冒充 / 虚拟卡 judgments null / 生成后重读闭环 / 收件箱保留历史语义）、p0-3-closed-gate **6/6 静态 + 真实库运行态**（P0-3 收口：全仓 137 文件历史载体零冒充 / 真实库 18 判断 6 客户全 fresh 证据可解析，见 §2.34）、customer-event **16/16**（P0-3 E3.1 CustomerEvent 基础设施：五类型 CHECK 门禁 / message_key 幂等 / 单表写四者不互相冒充 / 无 key 手动事件可重复，见 §2.35）、customer-event-producer **15/15**（P0-3 E3.2 最小生产者：quote_asked/customer_replied 双写不改变原链路 / closed>0 门控 / 复用 canonical key / 写失败不阻断 / 三表零污染 / **无名 session 门控**（accountId=0 不写 customer_event——观察期防污染），见 §2.35）、insight-unnamed-session **6/6**（无名 session 跳过见解链：沉默扫描 + blacklist 活跃分析无客户档案会话不入队 + 零 this.isSessionIdLike 模块函数护栏，见 §2.37、2026-08-24 isSessionIdLike 修复）、customer-event-action **20/20**（P0-3 E3.3 销售行动事件：script_copied/chat_opened/follow_up_done 挂在动作成功点 / follow_up_done 状态转换幂等 / 写失败不阻断 UI / 无第二套 action log；**P0-4.2.1** 行动事件带 task_id correlation（before.id / 前端 rawTaskId / 无 task 上下文 NULL 不伪造），见 §2.35、§2.36）、customer-event-closed-gate **16/16**（P0-3 E3 收口：全仓静态 13 项契约 + 真实库运行态 3 项，E3 已 CLOSED，见 §2.35；**P0-4.2.2 起 A2 更新为「事件查询原语仅 Action Funnel 消费」**——getActionFunnel 为唯一正当只读消费者，四消费者仍不迁）、action-funnel **25/25**（P0-4.2.2 六段只读组装 + **P0-4.3 breakdown 下钻**：executed/responded 事件类型计数精确 + 最近任务样本降序去重 / 与聚合共享 collectTaskRows 判定行口径严格一致，见 §2.36、§2.37）、action-funnel-closed-gate **17/17**（P0-4.2.3 收口护栏：静态 8 + 真实库运行态 7——created 口径闭合 1217+1601=2818 / won=26 / 窗口结构不变量 / executed+responded+progressed 0 样本属部署时序，见 §2.36；**P0-4.3 起 A2 升级为整文件检查**——collectTaskRows 提取后读方法移出 getActionFunnel 体，改查全文件零写方法 + 读访问仅白名单三原语，更严格）。
> Mac + Windows 双平台打包验证通过。
> **2026-08-13 增量**：确认中心零操作化（自动确认引擎 + 三触发点 + 前端摘要/历史/撤销）+ 行动卡一键闭环（打开聊天/复制话术）+ Electron 闪退真因修正（见 §2.6）。
> **2026-08-20 增量**：客户名真相源修复（微信号名回填微信真实备注 + 显示名解析优先微信备注，见 §2.25，已提交）；漏斗改造（历史累计流转 + 逐级转化率 + canonical 语义层 + 下钻修复，见 §2.24，已提交）；AI 销售助手 V1 P0 三缺口落地——商机闭环（采购信号→商机→阶段联动→漏斗）、意向评分 0-100、风险预警结构化（见 §2.14）；漏斗数据修复（转化率相对顶部 + 近7天去重，commit `c719678`，已被 §2.24 取代）；漏斗深链修复（阶段统一 customer_profile.stage，commit `11359fe`）；今日行动新建待办（手动待办进信号流 + 侧栏可勾选，commit `8085dc2`）；AI 见解 24h 去重 + 非客户自动黑名单（commit `f02b13c`）；销售复盘改造（周复盘打通 + 非客户过滤 + 崩溃兜底，commit `9a9fbaf`）；复盘排除非销售联系人（手动排除名单，同事/朋友聊天剔除出统计，commit `ed510df`）；新建合同选型号（工作台从产品库勾选，创建即自动生成报价单，commit `3e44a12`）；跟单中心物流卡两行化（信息/时间与操作分区，commit `bfed14d`）；信息待确认迁至工作台客户 tab（裁决与 AI 补全同页闭环，跟单中心不再展示，commit `57c4e0f`）；侧边栏导航收口 7 模块（今日行动/聊天/CRM/跟单/AI·知识/报表/系统，数据驱动 NAV_GROUPS，commit `09d5600`）；Customer 360 统一时间线（客户档案时间线聚合合同/到款/物流/报价/线索流转/商机事件/AI 见解一条流，前端四色混排并删重复「最近见解」块，commit `6c439bf`）；SLA/Action 接通（首触 SLA 扫描接入 Action 引擎每日 08:00 + 今日行动页打开周期，长时间运行不漏卡；lead:/logi: 虚拟卡隐藏无效「打开聊天」，commit `5ba531b`）。
> **2026-08-23 增量**：**落 §2.26「AI 销售副驾驶」为下一阶段产品/开发主线**（规划定稿）。定位：AI 观察/理解/判断/准备，销售最终判断与对外执行，L3 自动对客回复明确不做。固化三个关键事实：① P0-1 前置已确认——微信消息读取统一走**应用读取层 `chatService`**（解密 WCDB 只读，产品核心能力；HTTP API 是同一读取层的 HTTP 封装，非独立数据源），无需新增读取层，真正缺口是 AI 记录侧持久化 `messageKey`，`evidenceText` 作历史兜底；② CustomerEvent（P0-3）AI 节流必须复用 `insightService` 12h 机制；③ 自动扫描循环已存在（runFullScan + lazyScan + 每日全量 + 增量），真正缺的是**行动结果回流**（Agent Action → Outcome → Re-evaluation）。北极星升级为「有效销售行动」六段漏斗（发现→生成→采纳→执行→响应），先埋点后看板。§10 待办已按 P0 路线核销/合并/新增。**P0-1 第一刀已提交**：`intent_tag_log` 加 `message_key`/`evidence_text` 两列（幂等 ALTER），透传链路落地（classifier/intentService/actionEngine/insightService urge），`follow_up_task` 用 `source_message_id` 存 messageKey；`funnel-test` 增 9 条 P0-1 证据断言；运行时三件事验证通过（① 新日志带 message_key ✓ ② message_key 回查命中原消息 ✓ ③ evidence_text 为原话非 AI 结论 ✓）。**P0-2B Evidence Resolver 两刀已提交**（`04dbaec` messageKey 构造集中 + `21fd148` 统一读入口 getEvidenceByKey，历史裸 ID 兼容只读、不迁移、不新增 WCDB 读取层，45 断言，见 §2.27）。**P0-2C AI Judgment Persistence 盘点定稿**（`docs/P0-2C-AI-Judgment-Persistence-盘点.md`，纯只读：四字段 summary/opportunity/risk/nextAction 无持久化、`crm_risk.source_msg` 空列、AI 判断无证据锚点；设计=append-only 判断历史 + 当前投影，证据统一走 P0-2B，禁 stage 双真源）。**P0-2C.1 已提交**（`07241f4` customer_judgment 基础设施：shared 类型 + 表 + 5 方法 + 禁 stage 硬门禁 CHECK，40 断言，见 §2.28）。**P0-2C.3 已提交**（`057f8aa` action analysis 统一落库：`generateActionAnalysis` 三调用点——预热 salesActionEngine / suggest main.ts / 客户 360 crmIpcHandlers——把 opportunity/riskSignal/nextMove 统一持久化到 customer_judgment，替代「预热写 analysis JSON + on-demand 丢弃」；证据=关联任务 source_message_id（P0-1 锚点）→ extractEvidence 兜底，无可靠 key 不伪造；suggest=manual 跳过去重 / 预热+360=ai 24h 按类型去重；basis 输入快照；不碰 follow_up_task.analysis 旧链路（三层真源分离），37 断言，见 §2.28）。**P0-2C.2 已提交**（`fc654b2` summary 落库：只接 generateInsightForSession，落库前绑定证据（复用 extractEvidence/toMessageSnippets，客户最近一条实质消息；无可靠 messageKey → evidence unavailable 不伪造），append-only + hasRecentJudgment 持久化去重（非手动沿用 24h 窗口，手动保留覆盖权利），保留现场生成路径不改 UI/prompt，insight_record 与 customer_judgment(summary) 两表不合并不取代，33 断言，见 §2.28）。**P0-3 第一刀已提交**（`7950ca6` `getCustomerCurrentView()` 只读组装层 + 独立 IPC `sales:customer:currentView`，30 断言，见 §2.30；只做投影不做判断——analysis JSON 不并入 / 无判断不现场调 LLM；Latest 与 Fresh 并存；UI 未迁移）。**P0-3.2 已提交**（`9a375b3` Customer 360 判断卡迁移：`crm:customer:profile` 删除现场 `generateActionAnalysis`（不再打开档案调 LLM）、删除 customer_360 生产者调用，改返回 `getCustomerCurrentView` 只读投影；UI advice 五字段卡 → `currentView.judgments` 四卡（总结/机会/风险/下一步）+ 空态不补生成 + stale 标「较旧」+ 证据点击走 `sales:evidence:getByKey` 回查原话；护栏测试 13/13，见 §2.31）。**P0-3.3 已提交**（`14eaa07` SalesContextStrip 迁移：展开面板新增 AI 当前判断四卡消费 `sales:customer:currentView`（与 360 同语义：空态不补/stale 标较旧/证据点击回查 P0-2B）；**suggest 主动生成保留**（用户主动触发不属"打开页面自动生成"）——修复断链 `item` 补 `sessionId`（缺失 → persist invalid_input 跳过，suggest 落库从未生效），并验证闭环：生成成功 → customer_judgment append → **立即重读 currentView → UI 显示新判断**（主动分析与 Current View 不形成两套真源）；护栏测试 10/10，见 §2.32）。**P0-3.4 已提交**（`03d994d` 今日行动卡判断展示消费 currentView：`getUnifiedSignals` 组装 signal 时主进程同步投影 `judgments`（虚拟卡 todo:/logi: 查无客户 → null）；store 删除 analysis JSON `Object.assign` 合并（历史快照不再进卡冒充当前判断），`fetchSuggestion` 成功后重读 currentView（生成 → 落库 → 重读 → 显示闭环在列表页成立）；AIActionCard 折叠面板改 judgments 四卡 + 较旧/人工徽标 + 证据点击回查（与 360/状态条同语义），话术 suggestion 保留；InsightInboxPage 保持历史收件箱语义未改（insight_record 继续存在不冒充当前判断）；护栏测试 14/14，见 §2.33）。**P0-3 收口已 CLOSED**（全仓静态护栏 6/6 + 真实库运行态验收通过，验收文档 `docs/实施记录/P0-3-收口-契约验收.md`，见 §2.34）；**P0-3 E3 CustomerEvent 已拍板并启动**（用户拍板 = 建通用 customer_event 表 / quote_signal 分流不迁 / 四消费者全部不迁 / 硬门禁防万能日志表；第一刀只读盘点 `docs/实施记录/P0-3E3-CustomerEvent-盘点.md` + Scope Lock 设计 `docs/P0-3E3-CustomerEvent.md`，见 §2.35）。**P0-3 E3.1 已提交**（CustomerEvent 基础设施：shared 类型 + customer_event 表（CHECK 五类型 + message_key 幂等）+ 三个原语 + 16 断言，见 §2.35）。**P0-3 E3.2 已提交**（最小生产者接入：crmParseService 报价/回复双写 quote_asked + customer_replied，写失败不阻断原链，14 断言，见 §2.35）。**P0-3 E3.3 已提交**（销售行动事件：recordUserActionEvent 白名单 + completeAction before 状态检查幂等写 follow_up_done + IPC sales:action:recordEvent + AIActionCard 成功点上报 chat_opened/script_copied，15 断言，见 §2.35；**E3 三刀齐，先 E3 收口 + 真实库运行态验证，再进入 P0-4 Action Funnel**）。**E3 收口已 CLOSED**（`d97f663` 护栏 16/16 + 验收文档，见 §2.35）。**P0-4.1 Action Funnel 盘点已提交**（零编码只读刀：`docs/实施记录/P0-4-Action-Funnel-盘点.md`——真实六段漏斗 / 每段唯一事实来源 / correlation key 现状（task_id 缺失但补丁成本极低）/ 硬边界不新增第二套 Action Log，见 §2.36）。**P0-4.2.1 correlation 补齐已提交**（用户拍板三刀之一：customer_event 加 `task_id INTEGER NULL`（不改 event_type CHECK，幂等 ALTER 兼容旧库升级）；三行动写点全带 task_id——follow_up_done=completeAction 直写 before.id / script_copied+chat_opened=前端卡片 sources[].rawTaskId 经 IPC 透传（IPC typeof number 才传）；无任务上下文允许 NULL 禁止伪造——**task_id 是 correlation key，不是事件合法性的前置条件**；测试 20/20 + 真实库只读验收 7/7，见 §2.36）。**P0-4.2.2 getActionFunnel 只读组装层已提交**（用户拍板三刀之二：`getActionFunnel(days?, now?)` Task-level read model——六段 Task-level 去重 / sources 逐段事实来源 / 分母 0 → rate null / superseded 不重复计 + supersededCount / 时序守卫 / days 只过滤 created / **零 LLM 零 judgment 消费**；新原语 `tasksCreatedSince(ms)`；测试 19/19 + closed-gate A2 更新 + 真实库只读验收 5/5，见 §2.36）。**P0-4.2.3 收口护栏 + 真实库验收已提交**（用户拍板三刀之三：静态护栏 8 项——导入白名单 / 零写方法 / 事件白名单不膨胀 / sources 不变量 / divRate 守卫 / tasksCreatedSince 唯一消费者 / 无第二套 action log / task_id 非空写点仅 E3.3；真实库运行态 7 项——created 口径闭合 1217+1601=2818 / won=26 / 窗口结构不变量 / executed+responded+progressed 0 样本属部署时序；验收文档 `docs/实施记录/P0-4.2-收口-契约验收.md`；**P0-4.2 三刀齐 CLOSED**，见 §2.36）；**P0-4.3 UI/KPI 消费已提交**（五段漏斗 + 6 KPI + 点击下钻可追溯，breakdown 与聚合共享判定行，25/25；**P0-4 CLOSED**，见 §2.37）；**P0-4 之后不马上 P0-5——进入真实运行观察期**：看 created/executed/responded/progressed/won 每段掉多少，4 场景诊断（A 执行高响应低 → Action Quality / B 执行低 → Action UX / C 响应高推进低 → Sales Process / D 全好 → Scale），找最大漏损点再决定 P0-5A/B/C；**Summary 覆盖率观察项**：真实库 summary=0 先不修，观察随正常见解链是否自然增长，仍 0 则开 P0-4.x Summary Production Coverage 小任务）。
>
> **2026-08-24 增量（UI 美化地基，观察期 UI 例外 #2，用户拍板）**：功能线（跟单中心到款认领）先独立提交 `b4f6252` 隔离后，UI 线做地基不扩页面——① `src/styles/main.scss` 前进视觉 tokens 立 light/dark 双套（表面/文本/线条/品牌 alias/语义/滚动条/圆角/阴影/字体），品牌 alias `--color-accent: var(--primary)` 定义一次、8 套旧主题 × 双模式自动继承；② 品牌色拍板 Apple 蓝 `#0071E3`（dark `#0A84FF`），回绿只改主题层；③ 旧主题保留但只经 token 映射，不做独立视觉；④ 漏斗色板散调收口 `shared/funnelPalette.ts` 单一真源（两漏斗页 tsx 改导入，纯视觉）；⑤ 已打磨页（Sidebar/App/两漏斗 scss）硬编码 hex 清零、暗色自动可用；⑥ 1 页规范 `docs/DESIGN-SPEC-MINI.md`（五条红线：不改业务逻辑/不新增第三套 token/不硬编码品牌色/light+dark 双验/不改交互结构与行动任务可见性——观察期指标归因不受污染）。暗色灰阶与旧页面同坡（#171717/#212121/#2F2F2F/#383838）无接缝。波次：W1 地基（本次）→ W2 Chrome → W3 高频页 → W4 低频页。
> **2026-08-24 增量（W1 双模式验收 PASS）**：2 页 × 2 模式四张 CDP 截图全过——销售漏斗 light/dark + 行动漏斗 light/dark（app 跟随系统外观，OS 切暗/切亮各截一轮）：暗色灰阶与旧页面同坡无接缝、无白底残留/对比度崩坏；行动漏斗色板已升级 Apple 蓝渐变族（旧 tailwind 蓝零残留）；亮色白卡 + 浅灰画布、蓝色分段选中。护栏 payments-claim-test 18/18、`npx tsc --noEmit` 零错误。W1 地基验收闭环，待进入 W2。
> **2026-08-24 增量**：**P0-4 全链路 CLOSED**（用户拍板 P0-4.3 只做三件事：① 五段直观漏斗——行动产生→销售执行→客户响应→有效推进→成交，曝光显示「N/A · 当前未埋点」不为好看硬算曝光率；② KPI 只放有意义的——行动数/执行率/客户响应率/执行→响应转化率★（北极星，第一个回答「销售做了动作以后客户有没有反应」的指标）/响应→推进转化率/成交数；③ 点击可解释——执行/响应率点击下钻到事件类型计数 + 最近任务样本，数字可追溯到事件）。P0-4.3 实现：`getActionFunnelBreakdown` 只读下钻原语 + `collectTaskRows` 共享判定行（getActionFunnel 与 breakdown 口径严格一致）+ 双 IPC + ActionFunnelPage（五段 ECharts 漏斗 + 6 KPI + 下钻弹层 + 口径脚注），25/25 测试。**P0-4 之后不马上 P0-5——进入真实运行观察期**：看 created/executed/responded/progressed/won 每段掉多少 + 4 场景诊断（A 执行高响应低 → Action Quality / B 执行低 → Action UX / C 响应高推进低 → Sales Process / D 全好 → Scale），找最大漏损点再决定 P0-5A/B/C；**Summary 覆盖率观察项**：真实库 summary=0（18 条 judgment 全是 opportunity/risk/next_action）先不修，观察是否随正常见解链自然增长，仍 0 则单独开 P0-4.x Summary Production Coverage 小任务（不动 P0-2C）。**P0-4.4 双漏斗 UI 统一视觉体系已提交**（`e0736b3`：两漏斗窗口统一 7/30/90/全部 四档（行动默认 7、销售默认 30）+ 蓝系渐变配色（浅蓝→藏青，流失灰）+ 行动漏斗 ECharts 换 HTML/CSS 自绘梯形（段间箭头 + 段内转化率 + 推进/成交映射 Info tooltip + 每段可点击下钻）+ 销售漏斗 rich label 双行转化率 + 点击态；纯 UI 改造，未动口径/事件/判断/推荐逻辑，见 §2.38）。**P0-4.4 打磨修正已提交**（`828b6bb` + `a21fc2e`：梯形固定比例收窄不绑数值（跳级/转化率>100% 形状不变）+ svg path 圆角渐变（clip-path 无法圆角）+ 段间主题蓝小三角箭头（行动漏斗=过程链路 vs 销售漏斗=状态分布）+ 推进/成交映射 Info tooltip + 数字层级（主数字 26px/16px 纯白 vs 转化率 70% 白）+ 卡片阴影/间距；跳级高亮验收后删除——两漏斗转化率 >100% 均不特殊处理；见 §2.38）。**无名 session 边界修复已落地并提交**（`76bf709` fix(gate): unnamed-session immunity）——观察期防污染（A1 清理 3 条污染后上保险，属冻结清单「埋点/数据完整性 Bug」唯一例外）：① crmParseService E3.2 双写 quote_asked/customer_replied 加 accountId 门控（无名 session=displayName/alias/contact 均未匹配到 CRM 联系人，不写 customer_event；quote_signal 业务真源不受门控影响）；② insightService 沉默扫描 + blacklist 活跃分析跳过无客户档案会话（customerGetBySession 判定，见解链只服务已识别客户；whitelist 显式配置不受影响）；③ 测试：customer-event-producer 15/15（A9 门控护栏）+ insight-unnamed-session 5/5 新增，closed-gate B11 更新为「0 行基线」（表已存在，A1 后归零）；④ 行为前提：修复落地前不在无联系人会话聊天（用户承诺）。**2026-08-24 验证期修复：isSessionIdLike 模块函数不走 this 已提交**（`3666f3e`，观察期数据完整性例外——活跃分析整链 TypeError）——`insightService.ts` 3 处 `this.isSessionIdLike(...)` 实为 `shared/wechatId` 模块级函数，运行时 TypeError `this.isSessionIdLike is not a function` 致白名单会话活跃分析全部失败（日志 18:39 起连续报错，见解链静默断供——非门控在拦，是整链抛错）；修复为直接调用 `isSessionIdLike(...)`，node tsc TS2339 清零（159 条既有基线不动），编译产物重建（`npx vite build`，dist-electron/main.js 内联 0 处 `this.zl(`），insight-unnamed-session 5/5→6/6 加护栏（防 this. 前缀回归）；教训：`npx tsc --noEmit` 只查 root（src/shared），node tsconfig 的 TS2339 被基线容忍——electron/ 编译错误必须靠 `npx tsc -p tsconfig.node.json --noEmit` 单独 grep 新错。**跟单中心认领模式改造（未提交）**：用户拍板「不设计 AI 判断」——跟单中心去掉自动确认区（前端 autoSummary/runAutoConfirm/undoAutoConfirm 引用清零，后端函数保留不调度）；到款区重做为「每日到款清单」（近 30 天按 pay_time 天分组，今天/昨天标签 + 当日合计）+ 销售手动认领（选客户或新客户名建档 + 选合同 + 销售名）+ 认领后显示开票状态（订单群 PDF 发票解析 → invoice.status='issued' 即「已开票」+ 发票号）；真实库盘点发现旧 AutoConfirm 遗留 35 行 confirmed 但未挂客户/合同（仅公司名）——前端标「旧自动认领遗留 · 请补认领」，claimPayment 支持对这类行补挂；新后端 `paymentsByDay(days)`（四轴 LEFT JOIN：allocation/account/contract/invoice 子查询非作废最近一张）+ `claimPayment(id, patch)`（approvePayment 兜底建归属 / 已认领拒绝 / 旧数据补挂 / confirmAllocation 到客户合同）+ IPC `crm:payments:byDay` / `crm:payment:claim`（preload/electron.d.ts 桥接）；测试 `scripts/payments-claim-test.ts` **9/9**（静态 5 + 真实库只读 4：四轴 JOIN / 三步闭环 / 前端零 AI / 每日三要素 / 桥接齐全 + 近 30 天 61 笔分布快照）；tsc root 0 / node 无新增（6 条既有基线不动）。**构建劫持 + 误删坑（已踩）**：electron/** 下 tsc 编译产物（`*.js`/`*.d.ts`，gitignore）会劫持 vite 构建——vite resolve.extensions 优先 `.js`，dev/build 全部读取旧编译代码，`npm run dev`/`vite build` 均不反映 electron/ 源码改动，现象是「No handler registered for 'crm:payments:byDay'」；修复必须先删产物：`find electron -name "*.js" -delete; find electron -name "*.d.ts" -delete`，**但删除前必须 `git ls-files electron | grep -E '\.(js|d\.ts)$'` 对照白名单**——本次误删了 5 个 git-tracked 真实文件（`sql-js.d.ts`（sql.js 声明，删了即 TS7016 回归）、`nodert.d.ts`、`types/sherpa-onnx-node.d.ts`、`types/whisper-node.d.ts`、`assets/wasm/wasm_video_decode.js`），已 `git checkout --` 恢复；node gate 的 TS7016 排查时不要新建 shared 声明，仓库已有 `electron/sql-js.d.ts`。**每日到款折叠 + 只看未认领（2026-08-24 用户拍板）**：页面太长——每日分组默认只展开今天，昨天及更早折叠成 header（日期 + 笔数 + 合计 + 未认领数红字），点 header 展开/收起（collapsedDays/expandedDays 双 Set + toggleDay）；「只看未认领」筛选按钮（onlyUnclaimed 过滤 isClaimable 行，开启时强制全展开）；财付通（企业微信收款码收单方，近 30 天 23 笔 7.27 万占三成）判定为对账项必须留账（钱不消失），但付款方永远无客户名（收单方吞名）、0 笔开票（发票 PDF 按客户名匹配天然断链）——不单列不弱化，靠折叠自然收敛；payments-claim-test 9/9→10/10。**认领表单瘦身（2026-08-24 用户拍板）**：① 认领销售输入框去掉——认领自动带当前登录账户显示名（新 IPC `crm:currentSalesName`：config myWxid → `wcdbService.getDisplayNames([myWxid])` 微信真实备注，取不到回退空不阻塞认领；历史遗留 94 条 sales_name 是裸 wxid 的旧数据不迁移）；② 客户选择改**输入客户名**（用户拍板，2026-08-24 再改）：原生 select 与「新客户名」输入框合并为一个客户名输入框（`CustomerPicker`，常驻 input + 输入即联想已有客户 + 点候选认领到该客户 + 无匹配提示「直接认领将新建」+ 认领时 `customerIdOf` 精确匹配、匹配不到 `accountEnsure(name)` 建档兜底——claimAccount/claimNewName/logiAccount/logiNewName 四 state 合并为 claimCustomer/logiCustomer 两文本 state），物流认领 + 每日到款认领两处共用；payments-claim-test 10/10→12/12（A7 零手动销售输入 + 客户名输入建档兜底、A8 currentSalesName 桥接）。**销售名与到账口径修正（2026-08-24 用户澄清「认领款项不一定是一个人的」）**：① 认领销售输入框回归——不填=默认本人（mySalesName 兜底），填了=记到该人（许丽娟/李林辉/杨青等多销售共用）；② 合同工作台「本月已确认到款」¥583,416 是旧 AutoConfirm 遗留假数——143 条 confirmed 全部无客户/合同（pay_time 5/16-8/24 横跨四月），`statsOverview.monthPaid`/`paidWeekly` 改为 `account_id IS NOT NULL` 过滤（只算人工认领），修正后显示本月真实人工认领额；payments-claim-test 12/12→13/13（A7 改默认本人可改 + A9 到账口径护栏）。**已确认到款罗列（2026-08-24 用户拍板「确认收到款项也得罗列出来」）**：每日到款清单下新增「已确认到款」区——把已认领且挂上客户/合同（confirmed + account_id/contract_id 非空）的到款集中罗列（付款方/金额/客户/合同/销售/开票状态/到账时间），与每日流水分开、不受折叠影响；数据复用 paymentsByDay 返回字段零新后端；payments-claim-test 13/13→14/14（A10 claimedPayments 过滤 + 罗列展示护栏）。**物流跟单按天分组（2026-08-24 用户拍板「物流跟踪可以和每日到款一样设计」）**：待认领 / 已认领待签收 / 已签收 三队列全部改按天分组（`LogiDayGroups` 模块级组件，按 latest_update_at 天分组，今天/昨天标签，默认只展开今天，header 日期 · 笔数点开/收起，各队列折叠状态独立互不干扰；dayKeyOf/dayLabelOf 提为模块级，每日到款与物流共用）；分页/空态/认领表单/签收按钮均保留；payments-claim-test 14/14→15/15（A11 三队列按天 + 今天默认展开护栏）。**销售团队下拉（2026-08-24 用户拍板「加个销售人员选项」，选了可管理方案）**：header「立即扫描群消息」旁新增「销售团队（N）」下拉——名单 = 真实库 allocation.sales_name 去重（非空非 wxid 裸号）+ 当前登录账户显示名，每人附单数/金额；点成员 = 设为认领默认销售（mySalesName 联动，认领表单默认值跟随）；底部可添加新销售、移除离职（丁帅已离职）；管理持久化走 config 两个新 key `salesTeamAdded`/`salesTeamRemoved`（ConfigSchema + defaults，重新添加即撤销离职）；真实库盘点：历史 4 个 wxid 裸号（94 条 36 万，其中 1 个是当前账户）+ 4 个人名词条（杨青 5/1.1万·李林辉 21/11万·许丽娟 21/5.7万·丁帅 1/2千已离职）→ 在职 3 人；新 IPC `crm:sales:team` / `crm:sales:team:add` / `crm:sales:team:remove`（resolveMySalesName 抽出与 currentSalesName 复用）；payments-claim-test 15/15→16/16（A12 名单过滤 + 管理 + 前端下拉联动护栏）。**拆单金额口径修复（2026-08-24 用户问「金额对不对」）**：真实库核账发现本月 20 笔已确认到款全部是「拆单认领」——银行聚合流水（财付通收单，amount_net 如 ¥12,524.90）被解析器从群消息拆成每客户实际付款 hint（5,100/3,150/1,900/2,400，20/20 hint==credited），统计卡口径 SUM(credited_amount)=¥47,310 正确，但跟单中心每日清单/已确认区显示 amount_net（聚合总额）——同一笔被 N 客户认领时重复显示全款，合计 ¥161,456 虚高 3.4 倍；修复：paymentsByDay SQL 补返回 `al.credited_amount`，前端新增 `shownAmountOf = credited_amount ?? amount_net`（拆单显示实际付款额，未认领/无拆单回退聚合额），每日分组合计/认领提示/已确认区五处统一换口径，与统计卡同源一致；另查实：本月 18 个认领客户全部 0 合同（全库 1 份）→ 合同回款统计空转是业务数据缺口非代码 bug；invoice 表 0 条 → 发票解析待观察；payments-claim-test 16/16→17/17（A13 拆单口径护栏）。**到账统计改按到款日口径（2026-08-24 用户拍板「改按到款日」）**：核账发现 20 笔本月确认 ¥47,310 中只有 5 笔（¥8,980）是 8 月真实到款——其余 15 笔（¥38,330）是 5-7 月历史到款（8/24 集中补扫入库 + 集中认领，confirmed_at 全是 8/24），「本月已确认到款」按认领时间归类虚高；修复：`statsOverview.monthPaid`/`paidWeekly` JOIN payment_record 改按 **pay_time**（到款日）归类（pay_time >= 月初 / 周窗口），前端卡片文案改「本月到账（已认领）」；payments-claim-test 17/17→18/18（A9 改 pay_time JOIN 断言 + B14 真实库验证到款日口径 ≤ 认领时间口径）。**跟单中心改 7 天一页（2026-08-24 用户拍板「七天一页，物流和款项认领」，澄清后重做）**：一页 = **7 个自然日**（第 0 页 = 今天往前 6 天，如「8/18 ~ 8/24」，跨窗口翻页上限 = 最老一条所在页），页内**每天一个折叠行**（默认折叠，header 显示日期（今天/昨天标签）· 笔数 · 合计 · 未认领数红字，点击展开当天明细；页内倒序展示，最新/今天在最上）；款项认领 + 物流三队列（待认领/待签收/已签收）统一走模块级组件 `WeekDayGroups`（按天分组 + 翻页 + 展开态独立）；翻页控件 = 上一页/下一页 + 「8/18 ~ 8/24 · 第 n / m 页」；「只看未认领」筛选强制全展开（forceOpen）；删除旧的物流 10 条分页（LogiPager/slicePage/logiPage/pendingPage/signedPage 及已签收整区开关 showSignedLogi 全部移除）；纯前端改动，测试 18/18（A6/A11 断言改一页七天 + 每天折叠 + 翻页护栏）。**SearchTable 表格骨架 + 合同列表试点（2026-08-25，未提交）**：借鉴 Arco Design Pro search-table（调研 5 个 admin 模板后唯一 React 栈匹配者，MIT，不搬代码只取模式）——受控组件 `src/components/crm/SearchTable.tsx`（WeFlow 无 axios 层，数据来自 IPC，故数据/分页由调用方持有）：props = columns（key/title/render/className/width）+ data + rowKey + page/onPageChange + pageSize=10 + total?（默认 data.length，后端分页可显式传）+ loading? + filterBar?/toolbar?（ReactNode 左右分布）+ onRowClick? + rowClassName? + emptyText?；内置 Pager（上一页/下一页 + 「第 n / m 页 · 共 N 条」，total ≤ pageSize 隐藏）+ 前端分页切片；合同工作台 `CrmWorkbenchPage` 试点：状态筛选下拉 + 合同名搜索（变更自动 setPage(1)）+ 7 列（合同/金额/已确认回款/全款进度条/状态/预警/操作）+ 行点击选中联动 + selected 高亮保留；crm-workbench-test 48/48→**50/50**（0a 工作台引入 + 筛选栏/分页/行点击、0b 骨架要素 + 前端切片 + 空态文案护栏）；tsc root 0。
> **2026-08-27 增量（工作区未提交，见 §2.39）**：线索模块「群资源扫描」上线（手动触发，8,912 条真实消息回放漏配 0，用户已在应用内正式扫描 **4,680 条**入库，归属分布 秒变1513/李林辉1355/杨青981/静候653/未分配178）+ 线索页归属筛选 chips + 商机识别三修复（手机号不当金额 / 无产品信号重复建商机 / 亿级金额格式化，Windows 打包版需重构建生效）。
> **2026-08-28/29 增量**：Mac live 库商机脏金额修复（opportunity id=10 的 ¥152 亿 = 手机号 15200000006 落库于修复前，清零 + 备份 `crm-backups/weflow-crm-before-opp-amount-fix-2026-08-28T17-28-50.db`）；**Windows x64 安装包已重打（2026-08-29 21:36 含 §2.40 分库）**（`release/WeFlow-1.0.0-Setup.exe` 142M，asar 探针验证：main.js 带 `weflow-crm-` 命名/迁移与切换日志串/`chat:archiveBusinessData` IPC/reopenForWxid + preload 桥接 + SettingsPage「归档当前账号业务数据」按钮 + koffi win32 3.1.0 一致；8/28 旧包**无分库**已覆盖）——Windows 侧还欠：**装新包（装完首次启动自动把 legacy 库归到当时 myWxid=amthi66 名下 → 设置→数据库→「归档当前账号业务数据」点一次得干净新库）+ 跑商机修复 SQL**；**§2.40 微信号分库已实施（2026-08-29，Mac live 迁移验证通过，工作区未提交，见 §2.40 实施记录）**。**§2.41 报表 & CRM 七页 UI 美化 + 线索归属管理已实施（2026-08-29~30 设计稿拍板后八轮落地，含默认主题棕金→Apple 蓝根因修复、限宽 1280 居中、线索归属管理功能，工作区未提交，冷启动交接见 §2.41）**。
> **2026-08-29 增量（W3 先行：报表+CRM 六页 UI 迁移，工作区未提交）**：用户拍板 HTML 设计稿（`docs/UI美化-报表与CRM-设计稿.html`，六页 mockup + 6 条全局动作 + 红线自检）后落地，**纯视觉零逻辑**：① 图表色收口 `shared/funnelPalette`（SalesReportPage 两图 #007aff/#34c759、CrmWorkbenchPage 到款/管道柱 #16a34a/#2563eb → 品牌蓝渐变族；OpportunityPage STAGE_COLORS 红/橙撞色 → 蓝族 0/1/2/4 档 + 徽标背景 TSX 内联注入）；② 五页 scss token 化（CrmWorkbench/Opportunity/CustomerWorkspace/CrmReview/SearchTable：slate 硬编码 → `--color-*`，统计卡 26px/700 tabular-nums + 白卡浮起 hover accent 描边、进度条/意向条 accent、待确认卡红左条强调）；③ SalesReportPage：周报/月报分段控件、AI 摘要 accent 渐变卡、🔥/❄️/✂️ 语义 tint 卡（红/蓝/灰）、阶段条 accent、历史 active 左条 + 排行前三徽章、紫色系（#8e2de2）全部退场；④ 客户工作台 cws-tab 升级分段控件惯例。**顺带修 initPromise 护栏 bug**：`salesDbService.close()` 未清 `initPromise` → close 后再 initialize 被 resolved promise 短路（funnel-test 场景 2 崩「未初始化」），close() 补清；funnel **40/40**、crm-workbench **50/50**、payments-claim **18/18**、crm-lead **55/55**、golden **45/45**、current-view **30/30**、isolation **27/27**、tsc root **0**。红线 1-5 自检过（结构/按钮位/口径未动，dark 走 token 自动继承）。**第二轮（同日，用户反馈「和 HTML 稿差距大」后补齐展示层元素）**：合同/商机统计卡加语义图标芯片（38px 圆角 ico + 26px 数字）、合同表格状态/预警列 pill 化（`crm-pill` 通用徽标）、商机列表行六段对齐（日期/名称·产品/徽标/金额右推/意向度条/最近信号，金额缺失显示「待确认·金额」）、客户页 tabs 加 ⚡/✨/👥 图标、信息待确认行改设计稿布局（标题+置信 pill 行 + 证据引用块 accent 左边线 + 按钮右置）、跟单中心每日分组 header muted 卡行化（未认领红字右推）+ 已确认到款行图标芯片/两行信息/开票 pill 右置——全部纯展示层，交互目标与数据不动。**第三轮（同日，用户授权「按 HTML 稿改，按钮位置/点击行为也可改」）**：SearchTable th/td 同步列 className + 金额列 .num 右对齐 tabular-nums + 表头 11px tertiary + 行 hover；合同页头加副标题（合同闭环·报价/发货/回款/开票）+ 刷新 ghost + 新建合同 primary + 表格操作按钮 ghost 化；**商机页 ECharts 漏斗整体替换为 CSS 阶段条**（宽度按 stageDist 比例、段间递进转化率箭头、点击阶段筛选/再点取消——下钻行为保留，ReactECharts 导入移除）；客户页删顶部被动计数行（与带计数 tabs 重复）+ 卡片加 Avatar 头像 + 刷新 ghost；**跟单中心改「💰款项认领 / 🚚物流跟单」两 Tab**（原四 section 纵排一页；扫描群聊配置归物流 Tab，默认款项认领，Fragment 包裹多子元素）；复盘页主次按钮对调（生成周复盘=accent 主按钮，生成周报=描边次按钮，sr-btn-review 紫系类删除）。tsc 0、crm-workbench 50/50、payments-claim 18/18、HMR 全部推送成功。**第四轮（2026-08-30，用户截图反馈修复）**：① 商机页 CSS 漏斗塌陷修复——外层包裹层 shrink-to-fit 导致百分比宽度无法解析（ActionFunnelPage 同款已注释的坑），`.opp-funnel > div` 显式 width:100% + 阶段条 nowrap；0 数量阶段不再显示「递进 0%」箭头（rate 仅在前后两段都 >0 时显示）；② 商机列表行折行修复——取消 flex-wrap，客户名/产品列 ellipsis 收缩、金额/意向度/最近信号右列固定宽，待确认金额改单行「待确认」；③ 线索页（第 7 页）纳入 token 化：CrmLeadPage.scss slate 硬编码清零，统计卡对齐全局语言（白卡浮起 + 26px tabular-nums + hover accent 描边，超时卡红 tint 保留），状态徽章 pill 化（新=蓝/首触=绿/加微信=紫/失效=灰/转客户=琥珀），时间线/弹层/分页 token 化。注：用户使用金色主题——漏斗/阶段徽标保持固定 Apple 蓝族（funnelPalette 单一真源，红线 3），accent 类元素（进度条/chip 选中/按钮）跟随主题金色，属 W1 规范预期行为。 **2026-08-30 增量②（线索归属管理，用户反馈「很多销售归属都是一个人」）**：根因=群资源扫描按白名单「昵称=销售名」归属，「秒变」「静候」是昵称误配成的显示名。新增 `leadReassignOwner(from, to)`（crmLeadService，按 tag 批量 UPDATE，事务 + 空名/同名/无命中校验）+ IPC `crm:lead:reassign` + preload/d.ts `leadReassign` + 线索页归属 chips 行尾「⚙ 管理归属」弹窗（原归属→新归属（现有/新建名）+ 预览条数，执行后刷新列表并联动筛选 chip）；行为验证：2 条合并/空归属/同名拒绝均 ✓；后续扫描的昵称→真名映射在设置页 `crmLeadScanWhitelist` 里改（每行 昵称=销售名）。同轮合同工作台对齐设计稿补齐：客户阶段分布 donut 蓝族映射（new/contacted/quoted/negotiating/won=色板 0-4 档 + unknown 中性）+ 中心总数标题 + 右侧竖排图例；合同管道图空数据显空态文案；AI 准确率面板默认展开（对齐 mockup 数字卡形态）。**第五轮（2026-08-30 01:15，plan 模式拍板「删管道图严格按稿」）**：合同页三卡 grid 改为「到款趋势｜阶段分布｜AI 准确率卡」——合同管道图整卡移除，管道信息以 pill 条（待签约 N 份 · ¥X）并入合同列表上方（crm-pipeline-strip），pipelineOption 定义删除；AI 准确率改为第三卡（核心 4 数字 2×2 大字：采纳率/AI 自动写入/待确认采纳/手动修正 + 「展开明细」折叠 5 项次要指标）；**修复 crm-btn--primary 样式失效**（scss 只定义了嵌套 &.primary，tsx 用 BEM 类名不匹配 → 新建合同按钮显示为描边，补 &.crm-btn--primary 别名）；图表卡标题加 hint 小字（元·按 pay_time / customer_profile.stage / 近 7 天）；搜索框 240→320、全款进度条 90→110。tsc 0 + crm-workbench 50/50（测试不断言管道图）+ HMR 推送 0 错误。**第六轮（2026-08-30 01:28，用户三模块对比截图）**：① 跟单中心「已确认到款」行布局塌陷修复——行复用了 `logi-card` 类（物流卡两行化的 flex-direction:column）把横排挤成竖堆，改用独立 `claimed-row`（flex row + 图标芯片 + 两行信息 + 开票 pill 右置 + 到账时间固定宽）；每日分组 header 拆出「日期加粗 + 今天(蓝 pill)/昨天(灰 pill) + N 笔」三段（dayLabelOf 文本拆 pill）；分页信息改 pill 底。② 商机列表包进单卡容器（opp-list-card：标题 + 条数 + 行改分隔条样式，行不再各自成卡）。③ 客户卡流加「AI 深度分析」按钮（openCustomer + genDeepAnalysis，对齐 mockup 卡操作）。④ 诊断：用户截图里商机统计卡无图标/证据块全宽 = 渲染端未吃进 HMR（dev server 下发模块已含新代码，curl 验证 4 处 opp-stat__ico），Cmd+R 刷新即可。tsc 0 + payments-claim 18/18 + HMR 最终态 0 错误。**第七轮（2026-08-30 01:55，用户「差了这么多」——主题色总根因修复）**：用户对比设计稿始终觉得颜色不对，根因 = `themeStore` 初始 `currentTheme: 'cloud-dancer'`（棕金 #8B7355）——**W1 拍板的 Apple 蓝默认从未真正生效**，应用出厂即棕金。修复：themes 列表头部新增 `default`（默认 · Apple 蓝 #0071E3）+ 初始 currentTheme 改 'default' + ThemeId 联合类型补 'default' + persist version 置 1（丢弃旧持久化的 cloud-dancer 默认，用户重选过的可再选回）；App.tsx data-theme='default' 无对应 CSS 块 → :root 的 --primary #0071E3 生效。商机页最后三个细节：金额待确认改琥珀 pill、高意向（score≥阈值）加绿色「N 高意向」pill、漏斗阶段条加 135° 渐变（GRADIENT_LIGHT→基色）。tsc 0。**第八轮（2026-08-30 02:30）**：① 主题重置真正生效——zustand persist 仅 version 不匹配而缺 migrate 时旧状态仍被采用（采纳按钮仍金色暴露），补 `migrate: () => ({...persisted, currentTheme: 'default'})`；② 客户工作台布局对齐稿：cws-tabs（⚡/✨/👥）从长列表下方移到信息待确认卡上方（稿序 header→chips→待确认→卡流）；③ 待确认行 pill 语义对齐稿：加「待确认」琥珀 pill、置信改纯文本小字。tsc 0。
> - **`MAINTENANCE.md`** = 怎么打包 / 怎么避坑 / 安全红线 / 版本规则（操作手册）
> - **`归档/prd旧版/PRD-v2-销售行动驱动器.md`** = v2 原始需求（已被 v3 第一期取代）
> - **微信文件** = `今日行动-优化PRD-v3.md` / `今日行动-第一期PRD.md`（最新需求来源）
> - **`归档/prd旧版/PRD-v0.2-AI销售助手.md`** = 历史需求（已被 v2 取代，仅供参考）

---

## 1. 项目身份

| 项 | 值 |
|----|----|
| 名称 | WeFlow AI 销售助手（基于 WeFlow v5.0.0 二次开发） |
| 版本线 | **1.0.0**（与上游 5.0.0 脱钩） |
| 定位 | "每天打开就知道该干什么"的零操作销售行动驱动器 |
| 应用场景 | 叉车/仓储设备销售，B端20% + C端80%，单机个人使用 |
| 用户规模 | 月新增 200-500 微信联系人，两极分化成交周期 |
| 源码基线 | `deyyangyang-bit/WeFlow` fork（origin），不依赖上游更新 |
| 备份仓库 | `deyyangyang-bit/WeFlow-AI-Sales`（private），remote 名 `backup` |
| ⛔ 红线 | **永不 `git push origin`**；备份只用 `backup` |
| 技术栈 | Electron 43 + React 19 + Vite 8 + TS + Zustand + ECharts 6 |
| 存储 | 微信库 WCDB 只读（koffi 调原生 dll）；销售数据 = `userData/weflow-sales.db`（sql.js/WASM，5张表） |
| AI | DeepSeek 兼容接口，统一走 `electron/services/ai/aiApiClient.ts` |

---

## 2. 当前状态快照（2026-07-29）

- **代码健康**：`tsc --noEmit` 零错误，`vite build` 成功
- **v3 第一期**：今日行动引擎四项核心优化已完成（客户去重、R6独立清理、懒扫描、AI深度分析）
- **话术提炼 v2**：AI销售教练模式（分析+诊断+优化+多版本）已完成；扫描→确认→提炼→导入全链路打通；日期区间筛选；单选+一键批量双模式
- **知识库**：已导入 353 条产品参数（3个Excel→CSV转标准格式）
- **PRD v2 三周计划**：P0/P1/P2 全部代码完成
- **打包**：Mac DMG+ZIP + Windows EXE 均已产出，沙箱环境打包输出到 `/tmp/weflow-release`
- **Windows 适配**：koffi 打包问题已修复（`@koromix/koffi-win32-x64@3.1.0` + asarUnpack）

---

## 2.1 CRM 模块与产品库 v8.1（2026-07-31 ~ 2026-08-03）

- `a0424ec` feat: CRM 模块后端 — 数据层/解析管道/文件归档/文档生成/IPC（v7 增量①②③）
- `ed852b7` feat: CRM 模块前端 — 工作台/确认中心/型号库三页面+路由三件套（v7 增量④）
- `a410f6d` fix: CRM 接线修复（electron 侧既有类型错误不在本次范围，见 tsconfig.node.json）
- `f1851c4` feat: 产品库 v8.1 — 分类规格模版+specs/variants+三档价+变体合并导入+AI提取/描述+截图式UI
- `3af1353` fix: readImage 补 readFileSync 导入（缩略图修复）+ AI 视觉不支持时降级手动提示
- `240c45e` feat: 报价行项补 material/specs 摘要 + 修复报价单模版行项循环渲染

要点：
- 产品库 schema：product 新增 sku/category/subcategory/image_path/cost_price/reference_price/moq/material/description/specs/variants（ALTER 迁移）；product_line 并入 category；预设三类目 手动改装套件/电动整车/外调车型，模版见 `src/pages/CrmProductPage.tsx` 的 SPEC_TEMPLATES
- 外调 xlsx 导入：`src/utils/productImportMapper.ts`（旧5列/新11列/外调9列三种映射 + 按「车型名称+额定载荷」合并变体行）；验证 `scripts/product-import-test.ts`（59行→15产品，10 检查）与 `scripts/crm-golden-test.ts`（25/25）
- AI：`crm:product:aiDesc` / `crm:product:aiExtract` 走 aiApiClient；当前 DeepSeek 模型不支持 vision 时前端降级为「手动填写模版」提示
- 报价单 docx：`crmDocGenService.ts`（docxtemplater），行项含 spec_summary（材质+specs 摘要）；模版缓存 `userData/crm-templates/*.docx`，改模版构建器后需删除旧缓存才会重生
- 类型检查：`npx tsc --noEmit`（renderer，tsconfig.json）零错误；electron 侧 `tsconfig.node.json` 有约 134 个既有错误（CRM 相关文件无错误）

## 2.2 扫描群聊筛选（2026-08-04，`d442ab0`）

- 确认中心新增「扫描群聊」区 + 「筛选群聊」弹窗：搜索微信群聊 → 选类型（物流发货 logistics / 货款认领 payment / 订单截图 order）→「添加并扫描」；群可启用/停用、改类型
- 修复：preload `groupsSave/groupsUpdate` 未转发参数（导致空配置行）；`crmParseService.scanAll` 改用 `chatService.getMessages`（raw wcdb 行是 snake_case/未解码，之前全跳过）；扫描日志落 `userData/logs/weflow-sales.log`（[CrmParse] 行）
- 实测：艾驱安能物流跟踪群 100 条消息 → 283 条物流行落库（物流待链接）

## 2.3 物流按私聊地址判定 + 货款认领修复（2026-08-04，`240d4e1`）

- 私聊扫描：客户付款后在私聊发收货地址 → `parseShippingInfo` 规则（14/14 真实样本，`scripts/crm-claim-test.ts`）+ AI 兜底 → `shipping_info` 表（account_id/receiver/phone/address/city）
- 归属：主数据无客户时按「发完整地址的私聊对方=客户」懒建 account + alias 学习（跳过含「库叉」自家同事/文件传输助手）；有主数据时按 account/contact/alias 解析
- 物流链接：落库时按收货人自动链接该客户合同；地址到达时回填未链接物流；`logisticsCandidates` 新增「收货人→客户→合同」路径
- 货款认领修复：企微扫码（财付通）到款被销售引用认领时原先静默丢弃 → 现生成 pending 归属（带销售名）进确认中心；归属解析增加收货地址兜底
- 性能：私聊扫描 7 天活跃窗 + 无新消息跳过 + 每周期 150 上限；稳态整轮 <1s（[CrmParse] 日志可见）

## 2.4 AI 销售助手三阶段 + CRM 联动（2026-08-04~05，⚠️未提交）

> 本会话主线：把"AI 见解散点"升级为"AI 销售助手"。**阶段标签 = AI 见解 【阶段】标签**（了解/比价/决策/成交/流失/未知），与分类器英文阶段归一化共存（见 §4 STAGE_NORM 说明）。

- **A1 行动卡自带分析**：`follow_up_task` 新增 `analysis TEXT` 列（ALTER 迁移）；`runFullScan` 落库后对 high/urgent 任务**异步**调 `generateActionAnalysis`（whyNow/opportunity/riskSignal/script/nextMove），`todoUpdate` 写回 analysis；AIActionCard 有 analysis 直接渲染，无需点按钮
- **A2 分类器接线**：`main.ts` DB monitor 回调同时调 `actionOnNewMessage`（走 salesQueue 串行）→ 新消息到达自动 AI 分类 → `customer_profile.stage` 实时更新（含 won）
- **B 客户档案一屏**：IPC `crm:customer:profile(sessionId)` 聚合 销售画像 + AI 画像 + 阶段 + 最近见解 + 待办 + 合同/回款 + 轻量 AI 下一步建议（`generateActionAnalysis` 复用）；CrmWorkbenchPage 客户 tab 展开渲染
- **C1 AI 报价**：`crmQuoteService.aiGenerateQuotation`（拉私聊 50 条 → AI 提取 `{models:[{keyword,qty}],budget,deliveryNote}` → 产品库 name/model 模糊匹配 → `createQuotation` 报价单草稿），客户档案「AI 报价」按钮
- **C2 销售漏斗**：`SalesFunnelPage` + `salesDbService.funnelStats()`（customer_profile 阶段分布 + intent_tag_log 近 30 天时间线）
- **AI 见解 → CRM 自动导入**：`crmImportService.judgeAndImportCrmCustomer`（AI 判断意向→导入）+ `backfillImportFromInsightRecords`（按中文阶段标签批量回填）+ `insightService.importIntentCustomerToCrm`（STAGE_TO_CRM：了解→contacted，比价/决策→negotiating，成交→won），记录后自动触发，`crmImported` 反馈进 AI 见解消息
- **内部名单排除**：`crmInternalGroups`（总部运营中心/库叉线上销售订单对接群/新媒体业务奋斗群/新媒体运营-厂商开发，74 人）启动时收集进 internal list，AI 导入跳过同事
- **私域成交检测**：`crmParseRules.isDealSignal`（保守词表，只认客户消息的明确成交表达）+ `createDealContract`（幂等，金额留 0 待回款确认补）
- **资深销售助理深度分析**：`crmDeepAnalysisService` 固化用户自研七板块 prompt（客户情况/成交概率/顾虑/危险信号/下一步/话术/老板点评），CRM 客户档案「深度分析」按钮独立触发；**AI 见解恢复内置短格式**（清空 aiInsightSystemPrompt，保住【阶段】解析 + CRM 导入闭环）

## 2.5 确认中心修复 + 级联删除 + 漏斗/客户增强（2026-08-05~06，⚠️未提交）

- **确认中心 P0+P1 修复**（用户审出 6 个问题，修到 P1）：
  - `approvePayment`：到款审核通过若无归属 → **自动建 pending 归属转入「归属待确认」**（原逻辑只清 needs_review，截图到款审核通过后钱直接"消失"）
  - `confirmAllocation` 自动挂合同：客户已确定但未选合同 → 自动挂 `activeContractForAccount`；前端未选合同且客户未定时 confirm 二次拦截
  - `bindAccount` 改用 `ensureAccount` **去重**（原 `create('account')` 同名反复建）
  - `reviewQueues` JOIN payment_record 带 `src_group_id/src_time/src_raw`，确认卡片显示**来源群+时间+原始消息**
  - 物流自动匹配多候选 → 提示用下拉选；发票卡片加**金额输入**（原恒 ¥0，文件名不含金额）
- **级联删除**（原设计"不暴露删除端点"已解除，用户定级联策略）：`deleteContract`/`deleteAccount`（子资源 quotation/invoice/logistics/allocation/contract_status_history + alias_map/activity_log 级联）；**删除前自动备份** `userData/crm-backups/weflow-crm-before-delete-*.db`；IPC `crm:contract:delete`/`crm:customer:delete`；工作台两 tab 每行「删除」按钮 + confirm
- **客户 tab 增强**：阶段筛选下拉（选项由数据动态生成，空值显示"未分类"）；深度分析按钮直显列表行（原藏档案展开区）；深度分析报告独立渲染
- **销售漏斗修复**：趋势图柱高 `count*12px` 无上限（单日 170 条 → 2040px 撑爆页面）→ 相对缩放封顶 120px；流失/未分类客户进统计卡+脚注（原完全不可见）；转化率脚注解释逆漏斗（成交>决策 = 直接标记成交跳级）；近 7 天日期补 0

## 2.6 确认中心零操作化 + 行动卡一键闭环 + Electron 闪退真因修正（2026-08-13）

> 主线：把确认中心从"逐条人工确认"升级为"高置信自动处理 + 低置信留人工"（**钱不消失**设计），行动卡从"只能看"升级为"打开聊天 + 复制话术"一键闭环。新增测试 `scripts/crm-autoconfirm-test.ts` **56/56**。

- **自动确认引擎 `electron/services/crmAutoConfirmService.ts`**（新增，纯判定 + 独立执行）：
  - 纯判定函数 `evaluateAllocation/evaluatePayment/evaluateLogistics/evaluateInvoice/evaluateQueues`，无 Electron 依赖，可 tsx 单测
  - **硬前提 = 挂上合同**：客户已定但无 active contract → 留人工（不挂合同 = 钱在报表消失，见 A6 守卫）；引擎**从不创建实体**，只把 customer_hint 解析到已存在 account，回滚只改状态
  - 判定矩阵：归属（精确 0.95 / 模糊唯一 0.85，多候选/无合同/超付/父到款待审→review）、到款（bank_text 精确 0.95 / 近似唯一 0.85，**财付通永不自动**、screenshot 仅精确 0.85）、物流（唯一 0.95 → city 消歧 0.88 → receiver 词元消歧 0.82，消歧后仍多/仅兜底→review）、发票（buyer 精确 0.95 / 近似唯一 0.85 + amount>0，金额缺失用 `extractInvoiceAmountFromName` 保守提取）
  - 执行：`applyDecision` 复用 crmDbService 现有确认函数（opts.autoBy 标记）；每批一次快照 `crm-backups/weflow-crm-before-auto-*.db`（滚动留 20 份）；每个自动动作写三处——salesLog / activity_log(operator='auto') / `auto_confirm_log` 新表
  - `undoAutoConfirm` 增量撤销（creditedTotal 自动重算）；`autoConfirmHistory` 最近 50 条
- **三触发点**：① `crmParseService.setPostScanHook`（扫描完成立即跑，fire-and-forget）② 独立 60s 调度器（30s 冷却防重）③ 确认中心「运行自动确认」按钮
- **前置小修（堵"钱消失"暗口）**：`crmParseService.createPaymentRecord` bank_direct 直连到款但客户未命中 → 补 `needs_review:1` 进到款待审队列（原逻辑客户没登记→无归属可建→钱静默消失）
- **前端**：CrmReviewPage 扫描区后加**自动确认摘要块**（上次处理 N 自动/M 待审 + byEntity 拆分 + 可展开历史带撤销按钮）；SettingsPage「确认中心自动确认」小节（总开关/置信阈值 0.5-1.0/发票自动开单）
- **行动卡一键闭环**：AIActionCard 新增「打开聊天」(`navigate('/chat?sessionId=…')`) + 「复制话术」（无话术先生成再复制，clipboard + fallback），AI 面板加话术行内复制；CrmWorkbenchPage 客户列表/档案加「打开聊天」
- **Electron 闪退真因修正**：旧判断"dist 是 Node wrapper 混入的坏 Electron v24"是**误判**；真因是 `ELECTRON_RUN_AS_NODE=1` 环境变量让 Electron 以 Node 模式启动（`--version` 输出 v24.17.0）。防御已落地 `vite.config.ts`（spawn 前 `delete`），详见 `docs/归档/交接旧版/HANDOVER-20260731-驾驶舱改造与打包问题.md` §四 修正版
- **配置项**：`crmAutoConfirmEnabled`(默认 true) · `crmAutoConfirmThreshold`(默认 0.8) · `crmAutoConfirmInvoiceDocgen`(默认 false)
- 新 IPC：`crm:autoConfirm:run/history/undo`；新 npm script：`test:autoconfirm`
- **坑**：重启 Electron 需 `env -u ELECTRON_RUN_AS_NODE npm run electron:dev`；主进程代码（services/preload/main）改动后 vite 只重建 main.js 不重启进程，必须手动 pkill；`pkill -f "electron:dev"` 杀不掉 Electron 主进程（命令行不含该串），需按 PID `kill -9`（Electron 偶发卡 UE 不可中断睡眠，不影响新实例）

## 2.7 文档模版复刻：报价单/合同真实模版 + 开票申请 Excel（2026-08-13）

> 主线：让 app 生成的单据与用户**真实销售模版** 1:1 复刻——报价单/销售合同直接拿真实 docx 注入 docxtemplater 标签（样式原样保留），开票申请单按 Excel 原样用 exceljs 重建（合并单元格 + 公式 + 合计大写/小写），甲方(客户)开票信息改为系统录入。新增测试 `scripts/crm-docgen-test.ts` **68/68**。

- **真实模版**：`scripts/build-crm-templates.py`（python-docx，一次性）读用户真实样板副本（`/tmp/crm-tpl-inspect/`）→ 打标签 → `resources/crm-templates/{quotation,contract}.docx`（**提交进仓库**，随 `extraResources` 打包）。quotation：7列表格（序号/备注）+ `{customer}` 客户行 + 合计/含运费行 + 付款条款/footer 公司信息保留原样；contract：COOFORK-编号 + 行项目循环 + `合计人民币金额（大写）：{amount_cn}` + table1 甲方块 `{buyer_name/addr/bank/account/tax/phone}`（乙方固定）+ 售后保修附表保留
- **新增 `invoice-app` doc 类型** → `buildInvoiceAppWorkbook`（exceljs）复刻「开票申请」样板 sheet（B:I 列）：标题 B3:I3/日期 B4:I4 合并居中；表头 r8；明细 r9+（商品名称 C:D 合并，总额 `=H{r}*G{r}` 公式，商品编码取 product.sku）；合计 r14（B14 大写 + C14:E14 合并=**中文大写文本**，G14 小写 + H14:I14 合并=`=SUM(I9:I末)` 公式）；r15/16 货款情况静态（款项来源默认 对公转账）；r17 汇款单位名称合并=buyer；r19 复核/填表人：杨青。列宽/宋体/边框按样板复刻
- **金额大写** `electron/services/moneyCn.ts`（新，纯函数，零 electron）：`amountToChinese(n)` 按四位分组 + 组间补零规则，支持 角/分/整/负（`100005→壹拾万零伍元整`、`100050000→壹亿零伍万元整`）
- **架构拆分**：`electron/services/crmDocGenCore.ts`（新，零 electron 纯核心）承接 `renderDocx` + `buildInvoiceAppWorkbook` + 数据装配 + `generateDocBuffer(type, recordId)`（`DOC_TYPES = quotation/contract/invoice-info/invoice-app`，invoice-app 出 `.xlsx`）；`crmDocGenService.ts` 降为 **electron 薄壳**（模板路径三候选解析 → 调 Core → 落盘 `userData/crm-docs/{type}-{id}-{ts}.{ext}` → 写回 `attachment_path`，写回失败不影响生成）。`generateDoc` 改 **async**，`crmAutoConfirmService` 的 docgenRunner 类型同步为 `Promise<{ok;path?;reason?}>`。attachment_path 写回目标：quotation→quotation、invoice-info→**invoice**（invoice-app 同）、contract→contract；`contract` 表已补 `attachment_path` 列（ALTER 迁移，旧库自动加）
- **甲方(客户)开票信息 = 系统录入**（已确认决策）：`CrmWorkbenchPage` 新建合同表单加 5 输入（单位地址/开户银行/银行账号/税号/电话）→ `createContract` 写 `contract.custom_fields`（`buyer_addr/buyer_bank/buyer_account/tax_no/buyer_phone`，与自动确认引擎的 `tax_no` 同 key）；合同详情「子资源」面板加「甲方开票信息」编辑块（5 输入 + 保存 → `crm.update('contract', id, {custom_fields})`，IPC 已存在）
- **前端**：CrmReviewPage 发票待开行加「开票申请」按钮（在「开票信息单」旁）→ `docGenerate('invoice-app', i.id)`
- **数据装配**：合同 `no = COOFORK-{yyyymmdd}{id 补2位}`（date 取 sign_date||created_at）；报价单 `no = Q-{id}`；行项 单位默认 台、备注默认 空；**规格 = 显式 spec 文案优先**（样板「2吨\n550 黑黄 X1c-Li 48V15AH」原样，型号已含在文案内），无 spec 时 型号前置 + spec_summary 参数摘要；invoice-app 经 inv→contract→quotations→items 取明细（商品编码=product.sku），buyer=inv.buyer，tax_no=cf.tax_no
- 新 npm script：`test:docgen`；`docs/HANDOVER.md` 本次同步
- **坑**：exceljs 4.4 的 `ws.model.merges` 是**范围字符串数组**（`["B3:I3","C9:D9"]`），单测需按字符串解析，不是 `{top,left,bottom,right}` 对象；真实 docx 模版含图片（quotation 516KB），`python-docx` 只动段落/单元格文本，图片与样式原样保留

## 2.8 今日行动分页 + 工程基线同步（2026-08-17）

> 主线：今日行动信号卡片流分页（信号卡较高，10 条/页避免页面过长）；`tsx` 纳入 devDependencies（干净 clone 直接跑测试脚本）；`DEVELOPMENT.md` 入库（AI Agent 项目级开发规范）。

- **今日行动分页**：`TodayActionPage.tsx` 信号卡片流 `PAGE_SIZE = 10`，底部上一页/下一页按钮 + 「n / m 页 · 共 N 条」信息栏（`.signal-pagination`）；切换筛选回到第 1 页；数据变化后 page 超范围自动钳制到最后一页，避免空页
- **tsx 进 devDependencies**：交接文档承诺的 `npx tsx scripts/*.ts` 与 `npm run test:autoconfirm` / `npm run test:docgen` 在干净 clone 上可直接运行，无需临时联网拉包
- **`DEVELOPMENT.md`（根目录）**：AI Agent 软件工程开发规范——先调研再编码、先复用再自研、代码/测试/文档同步完成、当前文档只描述当前真实状态、历史信息单独归档；`AGENTS.md` 必读清单引用本文件，`CLAUDE.md`（本地，gitignore）指向本文件
- 文档同步：HANDOVER 头部最近提交引用、docgen 测试数（68 项）、功能清单第 31 行、AGENTS.md 对应 commit 与测试数

---

## 2.9 CRM 零操作改造：AI 自动填充 + 见解联动 + 客户 360 + 可视化（2026-08-17）

> 主线：按 PRD-v2「用户不录入、不标记、不操作」原则重塑 CRM 模块——AI 扫描自动填充客户信息并与灵感信箱联动；客户档案升级为 360 单屏视图；工作台增加可视化面板；漏斗换真漏斗图并可下钻。新增测试 `scripts/crm-enrich-test.ts` **48/48**。

- **信息自动填充引擎**（`crmEnrichService.ts` 装配层 + `crmEnrichCore.ts` 纯核心）：AI 从聊天上下文 + 见解记录 + 关系画像结构化提取 12 字段（公司/职位/电话/行业/省市/需求/预算/意向型号/采购时间/竞品/价格敏感度）。置信分级：≥0.85 自动写入 account（正式列 company/position + custom_fields），0.7~0.85 进 CRM 工作台客户 tab「信息待确认」队列人工裁决，<0.7 丢弃。每字段带 来源/置信度/聊天原话证据（`account.enrich_meta`）。手动编辑过的字段 source=manual + locked，AI 永不覆盖（`setAccountFieldManual`）。引擎绝不创建客户（只充实已导入 account）。触发点：见解导入后（insightService）/ 画像导入后（main.ts）/ 档案「AI 补全」按钮 / 「批量 AI 补全」存量回填（限额，enqueue 串行）
- **「信息待确认」迁至工作台客户 tab**（`57c4e0f`，原为确认中心第 5 队列）：从 account.enrich_meta.pending 派生（不建表），每行 = 客户+字段+AI 值+置信度+证据，操作 采纳/放弃/查看档案（`openInfoCustomer` 深链到客户档案）。裁决入口与 AI 补全同页闭环（补全 → 待确认 → 采纳/放弃），客户 tab 顶部可折叠区块，切 tab 自动 `fetchQueues` 刷新；跟单中心不再展示
- **客户 360 单屏视图**：客户 tab 档案 = 12 字段卡（🤖AI/✍️手动 角标 + 置信度 + 证据悬浮，点击编辑→保存即锁定）+ 动态时间线（CRM 操作 + AI 见解混排倒序 30 条，`crm:customer:profile` 返回 activities + insights 20 条）+ 深度分析/AI 报价入口；客户列表加 公司/AI 填充度 列 + 单客 AI 补全。新建合同零操作化：选客户自动带出名称 + 甲方开票信息，复用已有 account 不重复建客户
- **深链协议**：`/crm?tab=customer&id=<accountId>`（直达档案）与 `/crm?tab=customer&stage=<原始中文阶段>`（漏斗下钻筛选，`11359fe` 起传 customer_profile.stage 原值，见 §2.14「漏斗深链修复」）；灵感信箱卡片显示「已入 CRM」徽章 + 查看档案按钮（`crm:accounts:bySessions` 批量映射）
- **可视化**：`crmDbService.statsOverview()`（总量 + 近 8 周到款趋势 + 阶段分布 + 合同管道）；工作台顶部 4 统计卡（客户总数/在途合同额/本月到款/待确认事项）+ ECharts 三图（echarts-for-react，与仪表盘同款）；漏斗页换 ECharts 真漏斗，点击阶段深链下钻 CRM 客户列表
- **配置项**：`crmEnrichEnabled`(true) · `crmEnrichThreshold`(0.7) · `crmEnrichAutoApply`(0.85) · `crmEnrichBackfillLimit`(20)，设置页可调
- **空壳表处置**：contact（个体销售单联系人场景）列入方案「非目标」；opportunity 已由 §2.14 商机模块落地（AI 采购信号识别 → 商机闭环，见 5.1）；lead 表已由 §2.12 线索流转模块落地（见 5.1）

---

## 2.10 报价跟进事实驱动（R7）+ 批量补全修复（2026-08-17）

> 主线：解决"客户上来问价、报完价就消失"——不靠 AI 猜阶段，用"我方发出过带金额的报价 + 客户没回"两个事实直接生成高优先级行动。同时修复批量 AI 补全全部失败的装配 bug。

- **报价信号检测** `crmParseRules.parseQuoteSignal`：仅销售侧消息；金额 + (报价意向词 或 设备词) 双条件；排除客户询价（多少钱/你报个价）、闲聊小额（无单位且 <1000）、型号内数字（CPD20 的 20）；支持万元单位与千分位；语音消息走转写缓存（`chatService.getCachedVoiceTranscript`，未转写的语音不识别）
- **quote_signal 事实表**（crmDb）：msg_key 幂等；私聊扫描挂钩记录；客户任意回复即自动关闭（markQuoteReplied）
- **R7 规则**（salesActionEngine）：报价发出 24h~7d 内客户未回复 → 高优先级行动卡「报价跟进：X，N小时/天前报出 ¥金额（型号），客户还没回复」，评分高于普通 high；与 R1-R5 同客户取最高分；每日全量扫描时评估
- **R1 阈值 3 天 → 2 天**（AI 阶段兜底的报价跟进提前一天）
- **修复**：批量 AI 补全失败根因 = setEnrichConfig shim 只代理 4 个 enrich 键，回填路径 isAiConfigured 读不到 apiBaseUrl/apiKey；新增 setEnrichAiConfig 注入完整 config + 回填失败逐客户记 WARN
- 测试：golden 39/39（含 8 项报价信号正反例）、enrich 53/53（含 quote_signal 落库往返）

---

## 2.11 三项体验优化（2026-08-17）

- **行动卡深链**：今日行动卡客户名可点击 → `/crm?tab=customer&sid=<sessionId>` 直达客户 360 档案（深链协议新增 sid 参数，按微信会话定位；未导入客户给提示）
- **销售数据备份**：备份页新增「销售数据」勾选项（默认开），`backupService.collectSalesData` 将 weflow-sales.db / weflow-crm.db / WeFlow-config.json / 见解 profiles+records / 群摘要记录打包进归档 sales-data/；备份前强制落盘（crmDbService.persistNow + salesDbService.flushNow）；恢复 = 退出 app 后覆盖回数据目录
- **AI 准确率面板**：`crmDbService.aiAccuracyStats(days)` 聚合 auto_confirm_log + activity_log + quote_signal（AI 自动写入数/待确认采纳放弃/采纳率/手动修正与修正率/报价信号数/24h 回复率/待跟进数），工作台「📊 AI 准确率（近 7 天）」可折叠面板
- 测试：crm-enrich-test 55/55

---

## 2.12 单机线索流转模块（2026-08-19，设计稿 `docs/设计-单机线索流转模块.md`）

> 主线：线索池（lead pool）第一版——Excel/CSV 导入 + 文本粘贴 → 手机号/微信号清洗 → 同批/跨批去重 → 首触 SLA 24h 超时提醒（今日行动卡）→ 首触闭环 → 转客户。单机版明确不做分配/公海/回收/评分（团队版预留字段 `owner_id`/`pool_id`/`assigned_at`/`private_deadline` 恒 0/NULL，单机业务绝不依赖）。

- **lead 表**（crmDb 新表）：联系方式双轨（`contact_phone` + `contact_wechat`，`both` 时手机号为主）、`source`（抖音/视频号/小红书/自定义）、`first_contact_deadline` 导入时锁定（改 SLA 配置不回溯）、状态机 NEW → CONTACTED → WX_ADDED → ACCOUNT + DEAD（REOPEN 是 action 回 NEW）、`activity_log` 全链路流水（entity='lead'）
- **导入核心 `crmLeadImportCore.ts`**（纯函数，零 electron 可单测）：行清洗（手机号 11 位 / 微信号规则）、批量分类（phone/wechat/both/invalid）、同批 + 跨批去重（两类联系方式互不误伤）、来源预设（getCrmLeadSourcePreset）
- **跨库铁律落点**：先写 crmDb（lead + 流水）→ 再写 salesDb（SLA 卡 follow_up_task trigger_type='sla_lead'）+ 启动兜底 `scanLeadSla()` 幂等自愈；两库无法单事务，靠 partial unique index（`idx_ft_sla_once` ON follow_up_task(trigger_type, source_id) WHERE status='pending'）双兜底
- **统一信号流接入**：SLA 卡虚拟 sessionId `lead:<lead_id>` 进 getUnifiedSignals（stage='lead'），今日行动点完成/跳过 → `completeUnifiedSignal` 识别 `lead:` 前缀 → `completeLeadFirstContact`/`skipLeadFirstContact`（lead→CONTACTED + 卡 done + 流水三一致）
- **死因必填**：DEAD 前置校验 `reason` 非空否则拒绝；`DEFAULT_DEAD_REASONS` 预设死因（无效/未接通/加微未回/竞品/价格）
- **UI**：`/leads` 线索池页（导入 modal：预设来源下拉+自定义、文件上传或文本粘贴、无效行报错、批量结果反馈）、统计卡（超时/待处理/今日导入/今日首触）、来源+状态筛选、表格（脱敏 maskLead、超时红/剩余绿徽章、行内 phone/wx/toAccount/reopen/dead）、详情 modal + dead modal、列表导出
- **配置项**：`crmLeadSlaHours`（24，1-72 设置页可调）· `crmLeadSourcePreset`（抖音,视频号,小红书 逗号分隔可配）
- **验证**：`scripts/crm-lead-test.ts` **53/53**（清洗/去重/SLA/闭环四组）；`tsc --noEmit` 零错误；vite build 通过；mock-electron IPC smoke 14/14（含统一信号流 lead: 分支）

## 2.13 跟单中心 + 物流跟单闭环（2026-08-19）

> 主线：确认中心更名为**跟单中心**，物流从「认领即结束」升级为「发货 → 认领（选销售）→ 超期提醒 → 确认签收」的跟单闭环。物流群每晚 6/7 点更新发货列表（只发发货，签收状态不自动带），销售在跟单中心/今日行动人工确认签收（一期）；二期预留快递 100 API 自动查签收扩展点。

- **改名**：侧边栏/跟单中心页/设置页/CrmWorkbench 通知文案「确认中心」→「跟单中心」；`/crm-review` 路由、`crmAutoConfirm*`/`crmEnrich*` 配置键名不变
- **logistics 表**新增 `owner_sales`（认领销售，认领时手动填）+ `signed_at`（签收时间，0=未签收）；`status` 语义扩展：`shipped`（已发货）/`signed`（已确认签收）
- **落库幂等**：物流批量解析 INSERT 前按 `tracking_no` 查重（`logisticsByTrackingNo`），已存在仅刷新 `latest_update_at`，每晚同批列表重扫/补扫不重复建单
- **解析尾部容忍**：`LOGI_LINE_RE` 尾部可跟催单/备注等闲聊文本（如「`800214278737 艾驱电动 谭华 东莞 @妙妙 查一下这个快递，客户在催`」），只取「单号 品牌 收件人 城市」前 4 段，不影响整批识别；纯聊天行（无 4 段结构）仍拒绝，不误抓
- **今日行动 R8 物流跟进**（照抄 R7 报价跟进事实驱动模式）：`pendingLogisticsOverdue(hours)` 取已认领 + 发货超阈值未签收 → 生成 `rule_r8_logistics_overdue` 卡，虚拟 sessionId `logi:<logistics_id>`（不参与沉默天数/阶段过滤）；`completeUnifiedSignal` 识别 `logi:` 前缀，点完成 = 确认签收（卡 done + logistics signed + activity 三一致）
- **启动补扫**：app 启动时把物流群 `last_scan` 回退到昨天 00:00（`processed_msg` 幂等），应对物流更新不准时；调度器 60s 增量补扫
- **跟单中心物流区**（CrmReviewPage）：待认领（单号/品牌/收件人/城市 + 认领销售输入 + 选合同/自动匹配）→ 已认领待签收（超期标红徽章「超期 N 小时」+ 确认签收按钮）→ 已签收（折叠）；顶部统计待认领/待签收/超期数
- **三区分页**：待认领/待签收/已签收各每页 **10 条**（`LogiPager` 复用 `crm-pager` 样式，越界自动收敛）；待认领队列改最新发货在前（`unlinkedLogistics` ORDER BY id DESC），今天发货直接在第 1 页
- **认领反馈可见化**：认领/自动匹配/签收结果就近行内提示（`logi-notice`，不再依赖页面顶部 notice 被滚动遮挡）；未选合同按钮禁用（置灰 + tooltip）；无合同库时待认领区显示引导横幅（先到客户工作台建合同）
- **物流卡两行化**（commit `bfed14d`）：物流卡改两行布局——主行=物流信息 + 发货/签收时间 + 超期徽章，副行=操作（认领销售/合同/确认认领/自动匹配/确认签收）；原一行挤 5 元素、信息与功能无分区，窄屏易横向溢出
- **配置项**：`crmLogisticsOverdueHours`（24，1-168 设置页可调，超期阈值）
- **二期预留**：`markLogisticsSigned` 独立成方法 + `crmLogisticsOverdueHours` 阈值就位 → 接快递 100 API（~0.03 元/次）命中签收自动调用，未签收才提醒销售
- **验证**：`scripts/crm-logistics-test.ts` **25/25**（单号幂等/认领带销售/超期判定边界/签收闭环/logisticsList 分类）；`scripts/crm-golden-test.ts` **45/45**（含解析尾部容忍用例）；`tsc --noEmit` 零错误 + vite build 通过；crm 全系单测回归通过（lead 53 / workbench 48 / claim 17 / autoconfirm 56 / enrich 55 / docgen 68）

---

## 2.14 AI 销售助手 V1 P0：商机 + 意向评分 + 风险预警（2026-08-19~20，PRD `docs/归档/prd旧版/PRD-V1-AI销售助手.md`）

> 主线：按 V1 PRD 三大缺口落地——① **商机实体**（opportunity 从空壳表 → 完整闭环：AI 从微信聊天自动识别采购信号建商机、多商机并行、阶段联动、漏斗统计）；② **意向评分 0-100**（阶段 + 近期事件 + 商机加权，可展开评分依据）；③ **风险预警结构化**（竞品/价格/服务消息检测 → crm_risk 表 + 商机详情展示）。三者贯通：采购信号 → 商机 → 客户阶段联动 → 意向评分；风险信号附着商机。

- **采购信号识别** `crmParseRules.parseBuySignal`（仅客户消息 isSend=0）：吨位（`BUY_TON_RE`）/ 设备（`BUY_DEVICE_RE` 长词优先，电动叉车等 14 类）/ 数量（`BUY_QUANTITY_RE`）/ 金额（`BUY_INTENT_RE` 想了解/询价/报个价/能便宜等）+ 噪声排除（发个图/哪个店/你在吗）→ 返回 `{ product（如「2吨电动叉车」）, quantity, amount, detail }`；门槛 = 设备|数量|金额 任一命中
- **商机闭环**（crmDbService）：`opportunityUpsertBySignal` 同客户同产品 active 机会累积（数量/金额/详情），否则新建（name=`<产品>采购`，stage=「了解」，事件留痕）；`opportunityUpdateStage`（阶段推进）/`opportunityClose`（仅丢单 lost，原因必填，已关闭商机禁止再关）；正式成交走单点 `registerOpportunityDeal`（成交字段 + won + 事件 + 审计同事务）；`syncOpportunityStageByAccount` 客户阶段顺推（了解→比价→决策），成交→仅生成待登记提醒（`opportunity_event` type=`deal_pending`，幂等，不直接置 won）、流失→lost 自动关单；`opportunityStats` 漏斗聚合（stageDist/total/totalAmount，仅 active）；`opportunityList` JOIN 客户名
- **opportunity 表扩展**：product / quantity / amount / intent_score / status / last_signal_at / expected_close_at / main_resistance / competitor 列（Migration ALTER 8 列）；新增 **opportunity_event** 表（created/signal/stage_change/won/lost 事件时间线）+ idx
- **意向评分 0-100** `electron/services/intentScore.ts`（纯核心 `computeIntentScore`）：STAGE_BASE（了解30/比价60/决策80/成交100/流失5/未知0）+ 近期事件加分 min(20, count×6) + 14 天衰减 min(30, (days-14)×2) + 商机加分 10+(details?5:0)，封顶 100；level 高≥70/中≥40/低≥15；`salesDbService.intentScore(sessionId, opp)` 跨库装配（account.session_id → salesDb profile + intent_tag_log 近 7 天事件 + active opps 的 count/quantity/amount）；前端分数条 + 详情「意向评分依据」factors 展开
- **风险信号** `crmParseRules.parseRiskSignal`（仅客户消息）：竞品（别家/比你们便宜 → high）、价格（再便宜/太贵/底价 → medium）、服务（售后/保修 怎么处理 → low）；`crmDbService.upsertRisk` 同客户同类型 active 幂等累积（详情叠加 + severity 取高），`riskList`（JOIN 客户名，active 在前）、`resolveRisk`（人工确认处理）
- **crm_risk 表**（crmDb）：account_id / opportunity_id / risk_type / detail / severity / source_msg / status(active/resolved) / created_at / resolved_at + idx_crm_risk_account；ENTITIES 注册补齐 `opportunity_event` + `crm_risk`（否则 create() 被 isEntity 拦截静默失败——本次修复）
- **扫描挂钩**（crmParseService 私聊分支）：报价信号后接采购信号块（未建档客户自动 `importCustomerFromProfile` 建档再建商机）+ 风险块（取该客户第一个 active 商机挂 opportunity_id）；新建商机/风险均记 INFO 日志
- **阶段联动**：`insightService.importIntentCustomerToCrm` 导入后调 `syncOpportunityStageByAccount`（AI 中文阶段 → 商机顺推/关单）
- **前端** `src/pages/OpportunityPage.tsx`（新页面，路由 `/opportunities`，侧边栏「商机」）：ECharts 漏斗（点击下钻筛选）+ 统计卡（活跃商机/金额/待确认/决策中）+ 商机卡片（阶段徽章 + 意向评分条 tooltip=factors）+ 详情 modal（阶段推进按钮、成交/丢单、事件时间线、意向评分依据、**风险预警区**：类型标签 + 严重度 + 详情 + 确认处理按钮）
- **IPC**：`crm:opportunity:list/get/events/stats/stage/close/intentScore` + `crm:risk:list/resolve`（crmIpcHandlers + preload + electron.d.ts 同步）
- **验证**：`scripts/crm-opportunity-test.ts` **45/45**（评分 0a-0g / parseBuySignal 1a-1i / 商机累积 2a-2h / 阶段联动 3a-3e / 漏斗 4a-4e / 风险 5a-5k）；`tsc --noEmit` 零错误 + vite build 通过；crm 全系回归通过（lead 53 / workbench 48 / claim 17 / autoconfirm 56 / enrich 55 / docgen 68 / golden 45 / logistics 25 / opportunity 45）
- **已知边界**：风险只附着已建档客户（account_id 非 0）。漏斗深链 bug（customer_profile 中文 stage vs account.sales_stage 英文双轨）已于 `11359fe` 修复：**customer_profile.stage 为唯一阶段真源**（见本段「漏斗深链修复」）
- **2026-08-20 漏斗数据修复**（commit `c719678`，⚠️ 已被 §2.24 漏斗改造取代）：① 转化率口径由「阶段间相除」改为「相对漏斗顶部『了解』的比例」（成交 24/了解 71 = 34% 赢单率；原算法在 成交>决策 时算出 300% 失真）；② 近 7 天由「AI 扫描标签条数」改为「新增进漏斗客户数」（`intentTimeline` 按 `MIN(created_at)` 首次打标日期去重，同客户重复扫描只计 1 次）；③ `salesDbService.initialize` wasm 路径加根 `node_modules` 兜底（同 crmDbService 模式）。新增 `scripts/funnel-test.ts` **5/5**
- **2026-08-20 漏斗深链修复**（commit `11359fe`，⚠️ 语义与归一化已被 §2.24 取代，历史留档）：漏斗点阶段 → CRM 客户列表筛空。根因双轨：漏斗用 `customer_profile.stage`（中文 了解/比价/决策/成交），CRM 用 `account.sales_stage`（英文 contacted/quoted/negotiating/won，导入时 比价+决策 都映射成 negotiating），sales_stage **无 quoted**，漏斗「比价」深链「已报价」必空。修复统一 `customer_profile.stage` 为唯一阶段真源：`crm:customers` IPC 附带 `profile_stage`（session_id 关联）；CrmWorkbenchPage `stageLabel` 优先 `profile_stage`、无画像才回退 sales_stage 标签；SalesFunnelPage 下钻直接传原始中文阶段名（删 FUNNEL_TO_CRM_LABEL 映射）。实测 customer_profile 了解71/比价62/成交24/决策8 全部命中；深链协议改 `/crm?tab=customer&stage=<原始中文阶段>`
- **2026-08-20 今日行动新建待办**（commit `8085dc2`）：修复能力断层——手动「新建待办」原只在已隐藏的 FollowUpPage，今日行动无入口。① `getUnifiedSignals` 加 manual 分支：手动待办绕过沉默天数过滤（事实驱动），无客户 → 虚拟 sessionId `todo:<id>` 独立卡（**动态计算不落库**，因 `todoUpdate` 白名单不含 session_id）、绑客户 → 并入客户卡（displayName 回退客户档案名）；② `completeUnifiedSignal` 加 `todo:` 前缀分支按 `getTask(id)` 关单；③ 今日行动 header「新建待办」弹窗（标题必填 + 客户搜索下拉可选 + 截止时间可选）；④ `todayActionStore` 加 todos 状态（fetchToday 顺带刷新，主卡流与侧栏同源同步），TodoSidebar 数据源切 store、checkbox 可点击完成、主卡流完成也同步侧栏；⑤ AIActionCard `todo:` 虚拟卡隐藏「打开聊天」+「AI 分析」；⑥ 老页面 FollowUpPage 保留（后于 §2.19 归档）。新增 `scripts/todo-followup-test.ts` **11/11**（虚拟卡/绑客户卡/关单/老链路兼容）
- **2026-08-20 待办清单分页 + 重叠修复**（commit `6d33074`）：① TodoSidebar 进度条改纯视觉轨道（6px 双色段，数字移除到独立统计行）——原在窄百分比段内嵌 nowrap 文字必现溢出重叠（真实库 pending 106/done 73/total 1389）；② 列表分页 **10 条/页**（prev/next + `N / M`，数据变化自动钳制回合法页）；③ 统计分母排除 superseded/ignored/dismissed 防虚高，文案「已完成 N · 共 M」
- **2026-08-20 跟进待办页同客户去重 + 分页**（commit `95c9dd6`）：FollowUpPage（老页面，后于 §2.19 归档）平铺同客户多条待办刷屏（真实库 6 客户各 2 条：urge_customer 催办 + rule_r1/r2 规则卡）。① 去重：同 `session_id` 合并为一组，主卡=最高优一条（全局已按 逾期>疑似>待跟进 + priority_score 排序，首见即最高），其余折叠「同客户还有 N 条」可展开逐条确认/忽略；无 session 手动待办独立成组不合并；② 分页：按去重后组数 **10 条/页**（prev/next + `N / M`），数据变化自动钳制回合法页；③ 纯函数 `src/utils/followUpGroup.ts`（`groupFollowUpTasks`，随 §2.19 归档删除）+ `scripts/followup-group-test.ts` **10/10**
- **2026-08-20 AI 见解 24h 去重 + 非客户自动黑名单**（commit `f02b13c`）：① **数据源调查结论**——今日行动与灵感邮箱**同源**（都读 `insightRecordService`，JSON 落盘 `weflow-insight-records.json`），今日行动只取最近 24h 未读记录，与 `follow_up_task` 经 `getUnifiedSignals` 合并；② **24h 去重**：`INSIGHT_RECORD_DEDUP_MS` 12h→24h（同客户 24h 内不重复触发 AI 分析），`hasRecentRecord` 加 `sourceType==='insight'` 过滤——手动消息解析（`message_analysis`）不算「已分析过」，不阻塞后续自动 AI 见解；③ **非客户自动黑名单**：AI 输出【阶段=未知】→ `blacklistNonCustomer` 自动加入 `aiInsightNonCustomerBlacklist`（electron-store 持久化，与手动 whitelist/blacklist 名单完全独立）→ `isSessionAllowed` 先查黑名单硬屏蔽，不触发任何见解；④ **设置页可解除**：SettingsPage AI 见解 tab 底部展示黑名单（头像+名称+「解除」按钮），防 AI 误判永久沉默；前端 `src/services/config.ts` 加 `getAiInsightNonCustomerBlacklist`/`setAiInsightNonCustomerBlacklist`。新增 `scripts/insight-dedup-test.ts` **6/6**（a 24h 命中 / b message_analysis 不阻塞 / b2 混存命中 / c 黑名单读写 / d 与手动名单独立）
- **2026-08-20 销售复盘改造**（commit `9a9fbaf`）：复盘页从「统计报表」升级为「经营分析 + 统计」双能力。**背景**：`generateWeeklyReview`（周复盘，PRD P1 重点）是后端孤岛——定时器每周日 20:00 自动落库，但前端 `sales.reviewGenerate` 已暴露从未调用；且 `weekly_review` 记录混入 reportList 被当「月报」展示、点开 `dailyMessageCounts.length` TypeError **整页白屏**。① **周复盘打通**：复盘页加「生成周复盘」按钮 + `weekly_review` 专属视图（管道/热/冷/放弃 4 统计卡 + 阶段分布条 + 热/冷/放弃明细列表 + AI 复盘正文），`electron.d.ts` 补 reviewGenerate 声明；② **热了改基线对比**：原「本周有新 intent 且阶段∈{quoted,negotiating,won}」无基线误报，现 `intentBefore`（salesDbService 新增，查上周最终阶段）对比——本周阶段前进才热（新进管道也算），后退/无变化/已成交/已流失不算；③ **修复中英混存漏判**：stage 中英混存（insightService 中文 / classifier 英文），原英文列表匹配中文 stage 永不命中，统一 `normalizeStage`（salesActionEngine 导出复用）；④ **非客户过滤**：`filterCustomerSessions` 纯函数，topContacts/活跃客户只留命中 CRM account 或 AI 画像的会话（剔除家人/同事），Top 客户名优先 CRM 客户名；⑤ **崩溃兜底**：`viewReport` 按 period_type 分派 + 结构校验，历史脏 `weekly_review` 仅保留报告头。统计纯函数化 `computeWeeklyReviewStats`/`filterCustomerSessions`。新增 `scripts/report-review-test.ts` **28/28**
- **2026-08-20 复盘排除非销售联系人**（commit `ed510df`）：新增 `reportExcludedSessions` 配置（electron-store + 前端 config API `get/setReportExcludedSessions`），周报/月报/周复盘统计均剔除。背景：现有非客户过滤只剔「既非 CRM account 也无 AI 画像」的会话，同事/朋友被 AI 误打标建画像后仍混进复盘——排除名单是**人工兜底**，命中一律剔除。**两处生效**：`generate` 经 `filterCustomerSessions` 第四参剔除（activeContacts/Top 列表）；`computeWeeklyReviewStats` 循环顶部跳过（阶段分布/热/冷/放弃/管道数全部不含，pipelineTotal 曾漏已修）。**两个入口**：复盘页「排除联系人」弹窗（`chat.getSessions` 全量单聊过滤群聊/公众号，搜索 + 已排除置顶 + 保存）+ Top 互动客户每条「排除」快捷按钮（前端本地过滤 currentStats 不重复调 AI + 写配置）。`report-review-test.ts` 扩到 **33/33**（A5 排除不进任何统计 / B6 排除优先于 account 命中）
- **2026-08-20 新建合同选型号**（commit `3e44a12`）：CRM 工作台新建合同表单加「型号」选择区——从产品库搜索勾选产品（可多选，行显示 名称·型号·单价，数量可调，同产品去重），勾选合计实时显示。创建时合同金额**手填优先、未填取型号合计**；有勾选型号即 `quotationCreate` 自动生成报价单行项（单价取产品库）。背景：型号原本只能建完合同后在「新建报价单」里从产品库选，且报价单选择弹窗产品行**不显示型号**（同名不同型号难区分）。现在签单动作一步到位：客户 + 型号 + 数量 → 合同 + 报价单

## 2.15 侧边栏导航收口 7 模块（2026-08-20，commit `09d5600`）

> 产品收口第一步：20 项平铺导航 → **7 个一级模块**（今日行动 / 聊天 / CRM / 跟单 / AI·知识 / 报表 / 系统），把几十个功能第一次视觉上串成一个产品。

- **数据驱动重构**（`Sidebar.tsx`）：`NAV_GROUPS` 模块级数组 = 7 组；多子项组（CRM=线索/客户/商机/漏斗/合同、AI·知识=洞察/知识库、系统=产品库/通讯录）渲染为可展开分组（组头 button + chevron，`openGroups` state，CRM/AI 默认展开、系统收起）；单子项组（今日行动/聊天/跟单中心/复盘）直接渲染 NavLink
- **collapsed 兼容**：折叠态走 `flatMap` 平铺全部子项图标，与旧行为一致（分组只在展开态出现）；组内任一子项激活时组头高亮（`groupActive`）
- **PRD v2 隐藏项**（朋友圈/跟进待办/资源/分析/年报/足迹/导出/备份）`{false}` 死开关原样保留；设置入口仍在底部用户卡菜单
- **样式**（`Sidebar.scss`）：`.nav-group-head`（11px 大写组标签 + hover/active 色 + 旋转 chevron）+ `.nav-item--child`（子项缩进 26px）
- **验证**：`tsc --noEmit` 零错误 + `vite build` 通过（纯 UI，无后端/数据改动）

---

## 2.16 Customer 360 统一时间线（2026-08-20，commit `6c439bf`）

> P0-B：客户档案「动态时间线」从只看 account 实体动作 → **一个客户的所有关键事件一条流**（合同/到款/物流/报价/归属/线索流转/商机事件/AI 见解）。

- **查询适配层**（`crmDbService.accountTimeline`）：8 个 UNION ALL 分支聚合 `activity_log` 六实体（account/contract/logistics/quotation/allocation/payment_record，经 contract→account、allocation→payment_record 关联链）+ `lead_activity`（经 lead.account_id）+ `opportunity_event`（经 opportunity.account_id），按时间升序返回 `{ at, kind, text }`。**不新建统一表**，避免双写与迁移
- **handler**（`crm:customer:profile`）：activities 改用 `accountTimeline(accountId).reverse().slice(0, 40)`，倒序 40 条
- **前端混排**（`CrmWorkbenchPage.tsx`）：四类标签 `TIMELINE_KIND_LABEL`（CRM 绿 / 线索橙 / 商机蓝 / AI 见解紫，`.crm-timeline__tag` 加 `.lead`/`.opportunity` 色）；删除原「最近见解」重复块（已并入时间线）
- **测试**（`scripts/crm-timeline-test.ts`）：10 项——6 实体动作 + 线索 + 商机事件聚合正确、时间升序、跨客户隔离
- **验证**：timeline 10/10 + golden 45 + workbench 48 + lead 53 + opportunity 45 + logistics 25 全过，`tsc` 零错误，`vite build` 通过

---

## 2.17 SLA/Action 接通（2026-08-20，commit `5ba531b`）

> P0-D（用户 P0 3+1 第 4 项）：把「单机线索 → SLA → Action → 销售主闭环」最后一段接上——SLA 首触提醒真正随今日行动卡流自动出现，而不是只靠导入/重启触发。

- **缺口 1（后端）**：`scanLeadSla` 此前仅三个触发点（导入后 / IPC 手动 / 启动兜底）——应用连续运行期间，新到期线索不会自动出卡。修复：挂进 Action 引擎两个扫描周期——`runFullScan` 末尾（每日 08:00 全量扫描）+ `getTodayActions` 内 lazyScan 之后（今日行动页每次打开补偿扫描），均 try/catch 防护
- **不误伤保证**：SLA 卡 `created_by='sla'`，`runFullScan` 清理只滤 `created_by='action_engine'`，重扫不会 superseded SLA 卡（测试覆盖）
- **缺口 2（前端）**：SLA 卡（虚拟 `lead:<id>`）在今日行动显示无效「打开聊天」按钮（跳空白聊天页）。修复：`AIActionCard` 虚拟卡判断泛化为 `todo:`/`lead:`/`logi:` 前缀，均隐藏「打开聊天」（displayName 已含脱敏联系方式，销售自行微信搜索）
- **实测暴露缺口 3（排序埋没）**：卡其实已生成但 priority 51 分被 108 张 110+ 分老库存卡埋没，前端 PAGE_SIZE=10 分页看不到。修复（`678e3f0`）：`getUnifiedSignals` 排序对 `lead:` 前缀 +1000 置顶；`scanLeadSla` 提分至 `min(140, 80+min(hours,30))`，SLA 紧急度直接可见
- **展示策略再收敛（`c90e6c9`）**：职责分工后用户实测反馈「左右都显示线索重复」→ SLA 首触卡**移出主卡流**，只在右侧 TodoSidebar 散任务清单展示（`getUnifiedSignals` 跳过 `sla_lead`，删 `lead:` 虚拟卡与置顶 boost）；完成闭环走 `completeTodo` → `crm:lead:slaComplete`（卡 done + lead→CONTACTED + 流水），普通待办仍 todoUpdate
- **主数据源校正**：今日行动页主数据源是 `getUnifiedSignals`（IPC `sales:action:getUnified`），不是 `getTodayActions`——SLA 扫描除 runFullScan 外只挂 getUnifiedSignals 的 lazyScan 后即可
- **测试**（`scripts/crm-sla-action-test.ts`）：11 项——runFullScan 触发 / 二次扫描不误伤 / 幂等 / getUnifiedSignals 触发 + 主卡流不含 lead: 卡（不重影）+ 卡仍留散任务数据源 / 完成卡回写 lead=CONTACTED
- **验证**：sla-action 11/11 + lead 55 + enrich 61 + todo-followup 11 + funnel 5 + opportunity 45 全过，`tsc` 零错误，`vite build` 通过

---

## 2.18 AI 回写 model/sourceId 溯源（2026-08-20，commit `223c158`）

> P1（AI Writeback 顺手补齐）：兑现 PRD §23「可追溯」——enrich_meta 每条记录明确「哪个模型生成的、基于哪条聊天记录」。

- **数据模型**：`EnrichFieldMetaEntry` / `PendingFieldEntry` / `EnrichIncomingField` 加 `model?`（生成该值的 AI 模型名）+ `sourceId?`（依据的聊天消息 messageKey）；`applyEnrichment` 直接 `JSON.stringify` 落库，无需改写回层
- **model 来源**：`simpleCompletion` 只回文本，模型名从 `getAiModelConfig(cfg).model` 读用户当前配置（aiModelApiModel / aiInsightApiModel 兜底 deepseek-chat）
- **sourceId 来源**：`gatherMaterials` 遍历最近 80 条聊天时记录最后一条有效消息的 `messageKey`（chatService.Message 唯一键），作为本次整批提取的溯源锚点
- **注入点**：`enrichCustomer` 在置信分级循环给每条 AI 结果打 `{ model, sourceId }` 标签（directIncoming 直接写入 + manualPending 进 pending 队列均携带）；`mergeEnrichFields` 四处写点（空目标写入 / 同值刷新 / 高置信覆盖 / pending）透传
- **测试**（`scripts/crm-enrich-test.ts`）：新增 1d/1e/4b/5b/10e/10f 断言透传 + JSON 序列化保留，enrich 61 项全过
- **验证**：`tsc` 零错误，`vite build` 通过；lead 55 / sla-action 11 / funnel 5 / opportunity 45 回归全过

---

## 2.19 今日行动/待办职责分工（2026-08-20，commit `1aefef4` + `d5b9f62`）

> 去重：同一批 `follow_up_task` 曾有三处展示（主卡流按客户合并 / TodoSidebar 逐条平铺含 R1-R8 / FollowUpPage 老页），首页同批任务重影。收敛为职责分工：**主卡流 = 唯一动作入口；侧栏 = 散任务清单**。

- **现状**：`getUnifiedSignals` 主卡流按 sessionId 聚合 R1-R8 行动任务 + 24h 未读洞察成信号卡（带优先级/阶段/沉默天数/AI 分析）；TodoSidebar 此前 `sales.todoList({})` 全量逐条平铺，把有真实客户的行动任务又列一遍——同一件事在首页出现两次
- **散任务判定**（TodoSidebar）：`!session_id`（无客户手动待办 / SLA 卡）或虚拟前缀 `todo:`/`lead:`/`logi:`（物流卡）→ 只进侧栏；有客户会话的行动任务只在主卡流。统计口径（pending/doneCount/进度条）同步只统计散任务，避免 R1-R8 让完成率虚低
- **FollowUpPage 归档**：删组件 + `/follow-up` 路由 + PUBLIC_ROUTES 项 + `utils/followUpGroup.ts` + 孤儿 `followUpStore` + 失效测试 `followup-group-test`；老页唯一剩余价值「新建手动待办」今日行动 header 已有（§2.13 前 8085dc2）
- **跳转收口**：Dashboard「今日待跟进/逾期未跟进」改跳 `/home`；Sidebar 删 follow-up 死代码块（PRD v2 已 `{false}` 隐藏）；App 加 `path="*"` fallback 回落 `/home`，防旧书签/链接空白页
- **验证**：`tsc` 零错误，`vite build` 通过；todo-followup 11/11 回归全过（后端逻辑未动）

---

## 2.20 客户名称统一 + 同名不跨会话 + logi 签收闭环（2026-08-20，commit `068a403`）

> 名称双轨根因：`account.name` 冻结在导入时刻，`customer_profile.display_name` 被每次 AI 扫描重写。展示点各读一边 → 同一客户工作台显示旧名、卡流显示新名；另有同名泛称跨会话误关联 + 侧栏物流卡勾选不真正确认签收。

- **名称双轨读取侧统一**：各展示点统一为「`profile.display_name`（最新微信备注）优先，`account.name` 兜底」。改动点：
  - `crmIpcHandlers` 的 `crm:customers` 附加 `profile_display_name`（与 `profile_stage` 同循环跨库装配）
  - `CrmWorkbenchPage` 客户表格 + 建合同客户下拉改用 `displayNameOf(c)`（= `profile_display_name || name`）
  - `salesReportService` 周报 topContacts 兜底链换序：`profile.display_name` 优先
  - 主卡流/客户列表本就读 profile 名，无需改
- **同名不跨会话**：`matchAccountByName` 加 `opts.excludeSessionId`（跳过已绑定其他 session 的同名客户）；**仅 `enrichCustomer` 使用**——AI 充实只写已存在客户，防止多个「张总」串客户（A 会话误充实 B）。`importCustomerFromProfile` 名称兜底**保留幂等合并语义**（同人多微信号 → 合并同一 account，workbench 测试 7d 约束）
- **logi 物流卡签收闭环**：`completeTodo`（todayActionStore）对 `logi:` 卡改走 `sales.actionCompleteUnified`，复用 `completeUnifiedSignal` 的 logi 分支（卡 done + `markLogisticsSigned` + activity），与跟单中心「确认签收」一致；此前只 `todoUpdate` 标卡 done、物流单仍是 shipped
- **验证**：`tsc` 零错误；新增 `scripts/crm-name-fix-test.ts` **5/5**（match 层排除/向后兼容/导入合并语义回归）；全系回归通过（workbench 48、logistics 25、sla-action 11 等；product-import 依赖微信本地 xlsx 文件不在本机，与本轮无关）

## 2.21 AI 客户工作台收口（2026-08-20）

> 产品定位：**用户不维护 CRM，AI 维护 CRM**——用户只做「看清单、打勾」。客户页回答「谁值得看？为什么现在看？AI 发现了什么？我要做什么？做完系统怎么办？」，不做传统 CRM 管理动作。原两个客户入口并存（CustomerListPage 通讯录 + CrmWorkbenchPage 客户 tab 表格）且无行动视角，已合并收敛。

- **拆分两页**：
  - **`CustomerWorkspacePage`（/customers，侧边栏「客户」）**：AI 客户工作台。默认「值得跟进」视图（复用 `getUnifiedSignals` 全量 signals，过滤 `todo:`/`logi:`/`lead:` 虚拟前缀后按 `priorityScore` 排序），另有「AI 新发现」（仅 24h 未读洞察）与「全部客户」（有信号置顶，支持搜索/阶段筛选）。客户卡片流（客户名/公司/阶段/沉默天数/当前信号/下一步）+ 一键「完成」走 `sales.actionCompleteUnified`（今日行动→执行→回写闭环）；点击卡片展开 360 档案（字段编辑锁定/AI 画像/动态时间线/AI 下一步建议/待办/合同回款/深度分析/AI 报价/删除）。「更多」菜单收纳批量 AI 补全、导出 Excel、AI 准确率。「建合同」跳 `/crm?account=<id>&new=1`。
  - **`CrmWorkbenchPage`（/crm，侧边栏「合同」）**：瘦身为合同工作台（统计卡 + 3 图 + AI 准确率 + 合同表格 + 四子资源 + 新建合同），移除客户 tab 与客户 handlers。
- **归档**：`CustomerListPage.tsx` + `customerListStore.ts` + `CustomerListPage.scss` 删除（git 历史保留）；`CustomerCard` 组件保留（ChatPage 详情面板仍用）；`sales.customerExport` IPC 保留（工作台全量导出）。
- **深链迁移**（query 参数名不变，路径前缀 `/crm?tab=customer` → `/customers`）：行动卡 `?sid=`（AIActionCard）、漏斗下钻 `?stage=`（SalesFunnelPage）、灵感信箱 `?id=`（InsightInboxPage）。
- **Customer 360 Timeline**：验证结论=现有已满足（`accountTimeline` 8 分支聚合 6 实体 + lead + opportunity，前端 activities+insights 混排），仅搬页保留，不重写。
- **验证**：`tsc` 零错误；`vite build` 通过；全系回归通过（name-fix 5、workbench 48、funnel 5、todo-followup 11、timeline 10、opportunity 45、enrich 61、logistics 25、lead 55、autoconfirm 56、claim 17、docgen 68、sla-action 11、report-review 33、insight-dedup 6）。后端无改动、无新增 IPC。

---

## 2.22 物流认领到客户（无合同客户可认领物流）（2026-08-20）

> 痛点：**有的客户不需要合同，但是没有合同又认领不了物流信息**。原物流认领强制依赖合同（`logistics` 只有 `contract_id`，客户归属经 `contract_id → contract.account_id` 间接取得）。本轮将物流认领改为**归属到客户（account_id），合同变为可选上下文**——与到款归属 `allocation`（account_id + contract_id 双列、手动确认可不挂合同）完全同构。

- **数据模型**：`logistics` 表新增 `account_id`（可空，DDL + migration）；认领语义 = 客户必选其一、合同可选（有合同的客户仍关联，保留「未全款已发货」预警 + 合同子资源展示）。
- **手动认领**（跟单中心物流区）：认领卡片改「认领销售 + 客户下拉（必选）+ 关联合同（可选，按所选客户过滤）+ 新客户名建档（`accountEnsure` 去重建档）+ 确认认领」；无合同客户可直接选客户认领。
- **自动匹配**（跟单中心按钮）：候选统一带 `cand_kind`（'contract' | 'account'）；唯一合同候选 → 认领到合同；无合同但收件人确定命中客户（viaShip）→ 认领到客户。
- **扫描自动认领**（`autoLinkLogisticsByReceiver`，私聊收货地址命中）：无合同客户也认领到客户（不再 `return false` 跳过），顺带补 `auto_linked_by='auto'` + activity（撤销链路此前缺失）。
- **确认中心自动确认引擎**：铁律保持「自动确认必须挂 active contract」——只取合同候选，无合同客户仍 `needs_review`「无候选合同」待人工（与到款归属一致）。
- **下游适配**：`pendingLogisticsOverdue` JOIN 改 `COALESCE(c.account_id, l.account_id)`（账户级物流进超期 / 今日行动 R8 卡）；`accountTimeline` logistics 分支加 `OR account_id=?`（无合同物流进客户 360 时间线，8→9 占位符）；`undoLogistics` 同时清 account_id；`deleteAccount` 级联清理账户级物流。
- **IPC**：`crm:logistics:link` 签名升级为 `(id, { accountId?, contractId?, ownerSales? })`（preload / electron.d.ts 同步；调用方全在仓内）。
- **验证**：`tsc` 零错误；`vite build` 通过；`scripts/crm-logistics-test.ts` **37/37**（原 25 + 账户级认领/超期/时间线/候选/扫描自动认领/撤销 12 例）、`crm-autoconfirm-test.ts` **58/58**（原 56 + L7 无合同仅账户级候选留人工）；全系回归通过（workbench 48、claim 17、timeline 10、enrich 61、docgen 68、golden 45、lead 55、funnel 5、todo-followup 11、sla-action 11、report-review 33、insight-dedup 6、opportunity 45、name-fix 5）。

## 2.23 物流群扫描失效修复：getMessages 升序 + 传 startTime 扫增量（2026-08-20，已提交）

> 现象：crmParse 自动扫描「艾驱安能物流跟踪群」自 8月5日 18:50 起失效（`last_scan` 卡在 `1785927053000`），日志一直 `[CrmParse] ... scanned=0`。数据源本身正常（HTTP API 直拉物流群，最新消息全是 8月5日后）。

- **根因**：`chatService.getMessages` 内部经 `collectVisibleMessagesFromCursor` 末尾 `normalizeMessageOrder` 把消息**升序重排（旧在前）**；而 `crmParseService.scanAll` 原实现假设倒序返回，「遇 `ms <= lastScan` 即 break」——第一页第一条恰是最旧的 7月20日消息，`ms <= lastScan` 直接 break → 排在数组后方的 8月5日 后增量（60 条）被漏掉 → scanned=0。
- **修复**（`crmParseService.ts`，群扫描 + 私聊扫描同步）：`getMessages(gid, offset, BATCH, lastScan)` 传 **startTime=lastScan**，让原生游标（`beginTimestamp`，内部自动毫秒→秒）只读 lastScan 之后的增量；遇旧消息改 `continue` 跳过（不再 break）。翻页上限 MAX_PAGES=20（群）/10（私聊），页满记 WARN；处理完按 `maxMs` 推进 `last_scan`（`updateGroup` / `setScanState`）。
- **验证**：重启 dev 后日志 `group=艾驱安能物流跟踪群 page=1 msgs=61 hasMore=false` + `scan done scanned=60`（一次补齐 60 条积压）；下一轮 `msgs=1 scanned=0`（`processed_msg` 幂等，无重复）。
- **不受影响**：HTTP API（`collectRawRows` 直接 `mapRowsLite`，**不经过 normalizeMessageOrder**，保持原生降序）；前端 ChatPage（走 `getLatestMessages` → `getMessagesByOffsetStable` 独立查询）。WCDB 时间戳是秒，`lastScan` 是毫秒（`ms = createTime * 1000` 换算）。

## 2.24 漏斗改造：历史累计流转 + 逐级转化率 + canonical 语义层 + 下钻修复（2026-08-20，已提交）

> 目标：漏斗从「当前阶段快照分布」升级为「历史累计流转漏斗」，统计单位永远是 `customer_id`（`session_id`），绝不按 `intent_tag_log` 行数。阶段语义收口到唯一的 canonical 语义层，前端/统计统一归桶，中英文不再各页面各自理解。**本小节取代 §2.14 的 `c719678` 转化率口径与 `11359fe` 深链口径。**

- **canonical 语义层 `shared/salesStage.ts`**（新建，前后端共用、零依赖、纯常量+纯函数）：
  - `STAGE_CANONICAL` = `new/contacted/quoted/negotiating/won/lost/dormant/unknown`；`FUNNEL_ORDER` = 了解/比价/决策/成交/流失/未知
  - `normalizeStage(raw)` 中英→canonical 幂等（了解/已沟通→contacted、比价/已报价→quoted、决策/谈判中→negotiating、成交/已成交→won、流失→lost、沉默→dormant、新客→new、未知/未命中→unknown）；**未命中从旧版「返回原串」改为「返回 unknown」**，现有集合判断调用点行为不变
  - `funnelBucket(canonical)` 桶映射：new→了解、dormant→流失、unknown→未知；`stageToFunnel(raw)` = 一行归一化出档位（下钻统一比较入口）
  - **「比价」双英文定标 `quoted`**；CRM 侧 `STAGE_TO_CRM`/`BACKFILL_STAGE_TO_CRM`（比价→negotiating）是 CRM `account.sales_stage` 简并枚举（无 quoted 档），保持不动、文档注明
  - DB 不迁移存量数据（不 UPDATE stage）；DB 存机器语义、UI/统计层归桶展示
- **`funnelStats(days=30)` 重写**（`salesDbService.ts`，`days=0`=全部历史），新返回结构：`{ funnel, conversion, intentTimeline, currentDistribution, totalCustomers, newCustomersInWindow }`（旧 `stageDistribution` 字段移除）：
  - `funnel` = 窗口内「曾进入过某档位」的去重客户数（SQL 按窗口过滤 → TS 内存 `firstIn[档位][session_id]=MIN(created_at)` 独立去重）
  - `conversion` = 相邻档位相除（了解→比价→决策→成交，除零为 0；跳级可 >100%）
  - `intentTimeline` = 窗口起始日→今日 逐日×逐档位，按首次进入该档位时间落日、缺失补零
  - `currentDistribution` = `customer_profile.stage` GROUP BY 后归桶（现时快照）；`totalCustomers` = 建档数；`newCustomersInWindow` = 窗口内出现过任意档位记录的去重 session 数
  - `intentCreate` 加可选 `createdAt`（测试回填历史时间戳用，默认 now）
- **IPC 透传 days**：`sales:funnel:stats` handler + `preload.funnelStats(days?)` + `electron.d.ts` 签名（顺带修复旧类型不一致：原 d.ts 声称 intentTimeline 有 stage 字段但后端没有）
- **下钻修复（A，统一归桶比较）**：漏斗/状态卡点阶段 → 传中文档位名；`CustomerWorkspacePage` 新增 `rowStage(c) = stageToFunnel(profile_stage || sales_stage)`，`:139` 过滤、`:153` 下拉选项、卡片徽章全部改走它（英文 `quoted` 客户也能命中「比价」，修复 `11359fe` 未覆盖的英文双轨空白）；深链过滤前再过一次 `stageToFunnel`（幂等防御旧值）；删除本地 `STAGE_LABELS`。**语义说明**：历史漏斗计「窗口内曾进入」，下钻列表是「当前阶段为该档位」——穿过该档位但现已流失/删除的客户不在下钻列表，下钻人数 ≤ 漏斗人数属正常
- **前端漏斗页**（`SalesFunnelPage.tsx` + `.scss`）：时间窗口 toggle（近30天/近90天/全部，切换 refetch）；ECharts 真漏斗 4 档 `sort:'none'`（保留真实档位大小，label 带后端相邻转化率，脚注说明跳级可 >100%）；当前客户状态 6 档小卡片（可点击下钻）；窗口内每天进入各档位的去重客户数堆叠趋势；统计卡（客户总数/窗口新进漏斗/当前成交/当前决策/当前流失）
- **趋势口径统一（D）**：趋势窗口 = 所选统计窗口，与历史累计漏斗同源同口径（intentTimeline）
- **验证**：`npx tsc --noEmit` 零错误；`npx tsx scripts/funnel-test.ts` **40/40**（含 P0-1 证据断言 5.1-5.9）；回归（crm-workbench 48 / crm-claim 17 / todo-followup 11）全过；`npx vite build` 通过

---

## 2.25 客户名真相源修复：微信号名回填 + 显示名解析优先微信备注（2026-08-20，已提交）

> 目标：客户工作台「重复客户 + 客户名不对」反馈的调查结论与修复。数据层确认 100% 无重复客户（「一路向钱」仅 1 条 account id=75，「重复观感」来自该客户 enrich_meta 的 2 条 pending 信息在顶部「信息待确认」区与列表卡同时出现）；「名称不对」根因 = 系统显示名是微信号，WCDB 里有真实微信备注但没被取到。用户确认修复方向：**回填真实备注，保留原样**（保留日期前缀等微信备注原样）。

- **根因**：`resolveInsightSessionDisplayName` 用旧 `looksLikeWxid` 正则判断微信号格式，只匹配 `^wxid_[a-z0-9]+` 与 `@chatroom`，**漏掉自定义微信号**（字母开头 5-20 位，如 `wan923121735`）→ fallback 为微信号时被直接采用，不查 WCDB 备注
- **共享语义层 `shared/wechatId.ts`**（新建）：`isSessionIdLike(text)` 覆盖三类微信号形态（wxid_ 前缀号含下划线后缀 / 自定义微信号 / 群号 `@chatroom`），中文名/日期前缀/电话/数字开头/超短/空均不命中；微信备注是客户名真相源，微信号格式字符串不可直接当客户名展示/存储
- **源头修复**（`insightService.resolveInsightSessionDisplayName`）：fallback 非微信号格式走快速路径；微信号格式优先查 `chatService.getContactAvatar`（返回 `remark || nickName || alias`）再查 sessions 缓存，判断全用共享 `isSessionIdLike`
- **存量回填**（`crmIpcHandlers.ts`）：`crm:customers` handler 首次打开惰性触发 `backfillWxidDisplayNames()`，幂等——只处理 `name` 为微信号格式的 account（真实库 dry-run 确认正好 **13 个**，全部有 WCDB 真实备注可回填）；回填写 `account.name` + `customer_profile.display_name` 双轨；WCDB 未连接返回 -1 不置位，下次打开重试
- **回填安全**：sql.js 内存库 persist 只在写操作后 500ms 落盘、外部改文件会被应用内存库覆盖 → 回填必须走应用自身链路（`crm:customers` 惰性触发），禁止直接改库文件
- **验证**：`npx tsc --noEmit` 零错误；`npx tsx scripts/wechat-id-test.ts` **18/18**（wxid_ 前缀/自定义微信号/群号命中，中文/日期前缀/电话/边界不命中）；dry-run 确认 13 个目标 account 全部有 WCDB 真实备注

---

## 2.26 AI 销售副驾驶：历史主线（2026-08-23 定稿，2026-08-24 已收口）

> **状态：已收口，不作为开发依据。** P0-1~P0-4 全部 CLOSED 且成果在主干运行；P0-5（L0-L3 文档化）未产出、已作废。当前依据 = `docs/规划/weflow-hermes-PRD-v3.4.md`（见文件头）。

> **定位**：AI 负责观察、理解、判断和准备；销售负责最终判断与对外执行。**L3 自动对客回复当前明确不做**。
> 本小节是 §2.26 之后阶段的**产品/开发主线**——不是继续堆 AI 功能，而是把现有能力重新组织成闭环。现状成熟度：**骨架 85% / AI 能力 70% / 产品闭环 65%**；自动运行循环已存在（`runFullScan` + `lazyScan` + 每日 8:00 全量 + 新消息增量），**真正缺的不是"自动运行"，而是「执行 → 客户响应 → 再判断」的结果回流**。

### 1. 产品闭环（目标）

```
客户消息 → AI发现 → AI判断 → 证据 → AI行动包 → 销售判断 → 复制/修改/发送 → 客户响应 → AI识别结果 → 更新客户状态 → 下一次行动
```

- 现状已具备**前半段**（发现/判断/证据数据层/行动包）；下一阶段重点是**把"执行 → 客户响应 → 再判断"产品化**

### 2. 四层架构

- **L1 感知层**：聊天监听 / 意图 / 客户事件（E3）/ 阶段变化 —— 现状 ✅（`insightService` + `salesStageClassifier` + `intent_tag_log`）
- **L2 理解层**：AI 当前判断（P0-2）/ 客户关注点 / 风险 / 机会 / 证据链（P0-1）—— 🟡 有字段卡+评分+时间线，**缺聚合理解卡 + 证据链 UI**
- **L3 准备层**：AI Action Card（补客户关注/跟进目标/证据）/ 话术 / 上下文 / 下一步 —— 🟡 whyNow/阶段/话术/风险/下一步已有，**缺「客户关注①②」列表、跟进目标、证据原文**
- **L4 执行/回流层**：销售人工判断 / 打开聊天 / 复制/修改 / 发送 / 客户响应 / AI 重新判断 —— ❌ **缺埋点（P0-4）**

### 3. P0 路线（按序）

- **P0-1 E4 证据链 UI**：数据层已备（§2.18 `sourceId/messageKey` 溯源）。做：点击 AI 判断 → 展开客户原话。**读取路径（2026-08-23 实证 + 用户定标）**：微信消息读取统一走**应用读取层 `chatService`**（主进程内 `decryptKey` 解密 WCDB，只读 + 游标分页；本产品核心能力，所有功能共用）；项目自身 HTTP API `/api/v1/messages`（返回 `localId/serverId/createTime/parsedContent`）**是同一读取层的 HTTP 封装**（`127.0.0.1` + `access_token` 鉴权），**不是独立数据源**——不存在"走 API = 不碰微信库"的路径。证据回查 = `messageKey → 应用读取层 → 原消息/上下文`。**第一刀（2026-08-23 已实现并提交，P0-1）**：AI 记录侧持久化 `messageKey` + `evidenceText`（`intent_tag_log` 加 2 列，幂等 ALTER，历史数据不动）；透传链路 = `onNewMessage → chatService.getLatestMessages → toMessageSnippets（保留 messageKey）→ salesStageClassifier → intent_tag_log`、`salesIntentService.analyzeIntent → chatService.getMessages → intent_tag_log`、`follow_up_task.source_message_id`（R3 / urge_customer）。**⚠️ 其中第一条链路已于 2026-09-12 失效**：`salesActionEngine.onNewMessage` 与 `salesStageClassifier.classifyStage` 已按 PRD《AI简报与按需识别》§5.4（R）整体删除（拆线没拆弹，复核补刀），新消息不再触发任何 AI 阶段判定；`intent_tag_log` 的 `message_key`/`evidence_text` 列与其写入方法 `salesDbService.intentCreate` 均保留；当前**带证据锚点的实际写入者只剩 `salesIntentService.analyzeIntent`（采购意向分析，手动触发）**；原写入者 `salesStageClassifier.persistClassification` 能力保留但已**无调用方**（无 AI 调用，见 §2.98）。证据约束：`evidence_text` 只存判断依据关键句（客户原话/转述，≤200 字），**不存 AI reason/结论、不存聊天摘要**。保持不动：insightService 聚合扫描 / crmLeadService / message_analysis。运行时验证三件事已通过（① 新日志带 message_key ✓ ② message_key 回查命中原消息 ✓ ③ evidence_text 为原话非 AI 结论 ✓）→ 进入 P0-2
- **P0-2 客户「AI 当前判断」**：把已有字段 + 意向评分 + 时间线聚合成「AI 对客户当前状态的解释」卡（高意向/决策期 + 最近变化 + 当前机会 + 当前风险 + 下一步 + 查看证据）。重点是**理解层**，不是加字段。**2026-08-23 数据契约盘点完成**（`docs/实施记录/P0-2-数据契约盘点.md`，纯只读）：现有数据能稳定生成约 60%，三处硬伤——① Stage 无单一真源（6 写者中英混存、customer_profile/account.sales_stage/opportunity.stage 三口径零同步）② 证据链断点（insight 扫描路径不带 messageKey、source_message_id 双格式、无统一 resolver）③ AI 结论不持久化（summary/opportunity/risk/nextMove 现场生成不落库）。**据此 P0-2 拆为三刀 + UI**：P0-2A Canonical State（**设计已定稿**，`docs/P0-2A-Canonical-State-设计.md`：canonical stage 6 值 new/contacted/quoted/negotiating/won/lost + activityState active/dormant 拆 dormant + unknown 异常位；写者资格定稿 classifier/salesIntentService/manual/deal rule ✅ 保留、insightService ❌ 禁写 stage 降 signal（**暂不引入"高置信+阶段推进→覆盖"规则**，避免重新引入 stage 仲裁）、generic upsert ❌ 移除 stage 资格、dormant rule ❌ 不写 stage 改写 activityState；intentScore 定位综合意向分不重做算法，只修两 bug——`STAGE_BASE` 改 canonical 键 + 输入过 `normalizeStage()`、lastContactAt 秒→毫秒；**六刀已全部提交**：`6bf1ff6` intentScore 两 bug / `a3f3479` canonical read model / `308d5d9` action rules 阶段口径归一 / `53ee94b` insightService 禁写 stage 降 signal / `2933a2d` generic upsert 移除 stage 资格（IPC 运行时剥离 + 类型层删除双保险，tags/notes 仍更新、stage 保持原值） / `3ff3f1f` manual/deal rule 写者元数据收口（manual 校验值合法性 + changedAt；deal rule 补写 intent_tag_log + changedAt；写路径抽 legalStageWriters 不依赖 Electron）；P0-2B Evidence Resolver **已提交**（两刀 `04dbaec` + `21fd148`，见 §2.27）→ P0-2C AI Judgment Persistence（summary/opportunity/risk/nextAction 改为 事件→AI 判断→结构化结果→持久化→证据；不再打开档案现场调 LLM。**三刀已全部提交**：`07241f4` P0-2C.1 基础设施 + `fc654b2` P0-2C.2 summary 落库 + `057f8aa` P0-2C.3 action analysis 统一落库，见 §2.28；**P0-2 已收口 CLOSED**（见 §2.29）→ P0-3 Current Judgment Consumer Layer（`getCustomerCurrentView()` 组装三真源，UI 只消费该视图）→ P0-2 UI（最后一层呈现）。**边界**：P0-4 行动埋点（chat_opened/script_copied）不混入 P0-2；不建 AI Current Judgment schema、不动 UI；P0-2A 不膨胀成 CRM 状态机重构
- **P0-3 E3 CustomerEvent**：**扩展 `intent_tag_log`，不是重写**。最小模型 `{event_type, summary, messageKey, source, created_at}`。动手前先评估 **4 个现有消费者**：漏斗 / 意向评分 / 周报 / 今日行动
- **P0-4 Action 埋点**：**新增 3 个**——`script_copied`（采纳代理）/ `chat_opened`（执行准备）/ `customer_replied`（行动结果）。已有：`intent_tag_log` / `follow_up_task.created_at` / `follow_up_task.status`。最终形成：发现 → 行动生成 → 销售执行 → 客户响应
- **P0-5 L0-L3 文档**：只文档化，**不做权限系统**；顺手把 R1-R6 当前阈值整理成现状表（**本项未产出、已作废**；注：与 `docs/P0-5-Customer-Classification-设计.md` 的「P0-5」编号撞车，后者为独立课题、编号未定）

### 4. 「有效响应」定义（P0-4 落时定死）

- 第一版：`customer_replied` = **follow_up_task 执行后指定时间窗口（24h/48h）内客户产生的新消息**，只记录，不判"有效"
- **"客户回复 ≠ 有效响应"**；等数据跑起来后再定义：有效响应 = 客户产生与采购/产品/需求/下一步相关的新信息。**第一版不把指标搞复杂**

### 5. E3 AI 成本节流（必写）

- 禁止「每条消息 → 生成 summary → 调 AI」的高频调用
- **直接复用 `insightService` 的 12h 节流机制**；后续优化为：新消息 → 规则预筛 → 是否可能产生新事件？→ 是 → AI 事件提取
- 原则：**CustomerEvent 生成必须具备节流/去重，避免事件模型演变成高频 AI 调用源**

### 6. 北极星（先埋点，后看板，硬原则）

| 阶段 | 数据 | 状态 |
|---|---|---|
| AI发现 | `intent_tag_log` | ✅ 已有 |
| 生成行动 | `follow_up_task.created_at` | ✅ 已有 |
| 销售采纳 | `script_copied` | ❌ **新增** |
| 销售执行 | `chat_opened` / `task.status` | ❌ **新增** / ✅ |
| 客户响应 | `customer_replied` | ❌ **新增** |

- **先定义事件 → 埋点 → 验证数据 → 最后做看板**。不做「今天完成 47 次行动」这种无结果关联的漂亮图

### 7. L0-L3（文档化，不建权限系统）

| 级 | AI 能力 | 是否需要销售 |
|---|---|---|
| L0 | AI 观察 | 不需要 |
| L1 | AI 分析/更新画像 | 不需要 |
| L2 | AI 准备行动 | 销售确认 |
| L3 | AI 执行外部动作 | **当前最大边界 = L2；L3 明确禁止 AI 自动向客户发送消息** |

### 8. 冻结范围（P0 闭环完成前暂缓）

自动回复 / 触发规则 UI / 更多 CRM 字段 / 更多 AI 标签 / 复杂 Agent / 向量数据库 / 大量新报表 / 非核心 CRM 增强

> 核心原则：**先把已有 AI 能力串成闭环，不继续堆 AI 功能。**

### 三个固化事实（本次讨论新增，接手者必须知道）

1. **消息读取能力已具备，messageKey 持久化需补**（P0-1 前置，2026-08-23 实证）：微信消息读取统一走**应用读取层 `chatService`**（解密 WCDB，只读，本产品核心能力）；HTTP API `/api/v1/messages` 是同一读取层的 HTTP 封装（`127.0.0.1`+token），**非独立数据源**——证据链**无需新增 WCDB 读取层**，销售功能复用 `chatService` 即可（不新增读取路径）。真正缺口是 **AI 记录侧未持久化 `messageKey`**（实测 1000 条见解记录 0 条带，仅 AI 补全字段 `sourceId` 有）——E4 与 E3 是同一件事的两面：E3 记录「AI 发现了什么（含 messageKey/evidenceText）」，E4 把证据展示给销售
2. **CustomerEvent AI 节流必须复用 `insightService` 12h 机制**（P0-3）：否则事件模型会变成高频 AI 调用源
3. **自动扫描循环已存在**（`runFullScan` + `lazyScan` + 每日全量 + 增量）：AI"自己跑起来"已基本成立；下一阶段核心是 **Agent Action → Outcome → Re-evaluation**（行动结果回流 → 重新判断），不是"自动运行"

## 2.27 P0-2B Evidence Resolver：证据链统一读入口（2026-08-23，已提交 `04dbaec` + `21fd148`）

> 设计定稿：`docs/P0-2B-Evidence-Resolver-设计.md`。定位：把「AI 判断记录 → 证据（原消息 + 上下文）」收敛为**单一读入口**，复用现有应用读取层（chatService / wcdbService 既有原语），**不新增 WCDB 读取层、不直接碰 wcdbCore、不改 `/api/v1/messages`、不迁移历史数据**。

- **刀1 `04dbaec` refactor(shared) messageKey 构造集中**：原 chatService 私有 `buildMessageKey` + apiMessageMapping 拷贝（两处必须保持一致）提取为 **`shared/messageKey.ts` 单一真源**（纯函数，零依赖，Node 可测）。chatService / apiMessageMapping / salesFollowUpService 三方共用。**salesFollowUpService 写点修复**：`roughFilter` 从原生行（`_db_path`/`table_name`/`local_id`）经共享 `buildMessageKey` 产出 canonical messageKey，`todoCreate` 的 `source_message_id` 由裸 `msgId` 改为 **canonical messageKey**（唯一非 canonical 写者已消除，未来写入格式统一）。`tsconfig.node.json` 补 `shared/**/*.ts` include。
- **刀2 `21fd148` feat(sales) 统一证据读入口**：
  - `shared/evidenceKey.ts`：`parseEvidenceKey` 纯解析，5 格式分类（canonical / local: / server: / fallback: / 历史裸数字），**serverId 保留字符串**（16+ 位精度无损，转 Number 丢精度）。
  - `electron/services/evidenceResolver.ts`：`createEvidenceResolver(reader)`（**reader 注入**，默认 chatService、测试注入 fake，无 Electron 运行时依赖）。`getEvidenceByKey(sessionId, messageKey, evidenceText?)` → `{status:'found', message, before, after}` | `{status:'unavailable', reason, evidenceText?}`。失败语义：unparseable → 立即 unavailable 零读取；miss/reader 抛错 → unavailable(message_not_found/reader_error)，**绝不伪造**；evidenceText 仅兜底展示不冒充回查成功；上下文失败非致命（仍 found + 空 before/after）。
  - `chatService.getMessageByServerId` 公开薄包装（历史裸 ID 兼容路径：`wcdbService.getMessageByServerId` → 私有 `parseMessage`）。
  - IPC `sales:evidence:getByKey`（main.ts + preload + electron.d.ts），薄传输无 UI。
  - 测试 `scripts/evidence-resolver-test.ts` **45/45**（canonical 命中 / 历史裸 ID 命中 / miss 不伪造 / unparseable 零调用 / evidenceText 兜底 / 上下文失败非致命 / **只读断言**（仅调用三个读原语，无写方法）/ sessionId 透传 / 4 分支 round-trip）。
- **回归**：`npx tsc --noEmit` 零错误；`tsc -p tsconfig.node.json` 162 个既存 electron 错误（隔离债务，非本次引入，我的改动文件 0 错误）；message-key 17/17 + todo-followup 11/11 + canonical-state 37/37 + intent-score 17/17 + insight 系列 + legal-stage-writers 25/25 + upsert-stage-ban 24/24 + funnel 40/40 + action-rules 32/32 全绿。
- **历史数据**：真实库 `follow_up_task.source_message_id` 1 条裸 serverId + `intent_tag_log.message_key` 1 条 canonical —— **不 UPDATE、不迁移**，由 resolver 的 serverId 分支 + canonical 分支双格式兼容读取。

---

## 2.28 P0-2C AI Judgment Persistence：AI 判断持久化（2026-08-23，盘点定稿 + 刀 1 `07241f4` + 刀 2 `fc654b2` + 刀 3 `057f8aa` 已提交）

> 盘点定稿：`docs/P0-2C-AI-Judgment-Persistence-盘点.md`（纯只读，不写代码）。把「AI 判断本身」从临时字符串变成真正的数据资产。

- **边界（用户拍板）**：`customer_judgment` 只服务 `summary / opportunity / risk / nextAction` 四类；**永不出现 `customer_judgment.stage`**（stage/activityState/stateMeta 归 P0-2A Canonical State，再造一份 judgment stage 会制造三处双真源）。三层次真源分离：正则 opportunity/risk = **客户事实信号**；AI judgment opportunity/risk = **AI 对事实的解释**；follow_up_task = **实际行动对象**。互不冒充。
- **盘点关键发现**：① 四字段无一个带证据可追溯的 AI 判断记录；② 机会/风险是**正则信号**驱动（crmParseService parseBuySignal/parseRiskSignal），非 AI；③ `crm_risk.source_msg` 空列从未写入；④ `generateActionAnalysis` 五字段仅预热路径落 `follow_up_task.analysis`，客户 360 / suggest 现场生成不落库；⑤ AI 见解阶段 signal（salesInsightWrite）不带 message_key/evidence_text。
- **刀1 `07241f4` feat(sales) customer_judgment 基础设施**（本刀不接 LLM）：
  - `shared/customerJudgment.ts`：四类型语义源 `CUSTOMER_JUDGMENT_TYPES` + `isCustomerJudgmentType`（TS 层禁 stage）+ `judgmentEvidenceStatus`（证据状态**只读派生**：message_key 非空=ok / 空=unavailable，绝不伪造"看起来像证据"的 key，与 P0-2B 原则一致）。
  - `customer_judgment` 表：append-only，`CHECK (judgment_type IN (...))` **DB 层硬拦截 stage**；索引 `(session_id, judgment_type, created_at)`。
  - `SalesDbService` 5 方法：`judgmentCreate`（append，TS 守卫 + DB CHECK 双拦截）/ `judgmentCurrent`（该 session 该类型最新）/ `judgmentCurrentAll`（四类型一次取回，客户 360 用）/ `judgmentHistory`（倒序 / 按类型过滤 / limit）/ `hasRecentJudgment`（去重基础，参考 hasRecentTask）。
  - 测试 `scripts/customer-judgment-test.ts` **40/40**（建表列 / CHECK 硬约束 / append-only / projection / 同毫秒 id 兜底 / CurrentAll 跨 session / 历史 / 去重窗口 / 证据字段 round-trip / 证据诚实 / **judgment_type='stage' 抛错硬门禁** / 跨 session 不污染）。
- **刀2 `fc654b2` feat(sales) summary 判断落库**（只接 `generateInsightForSession`，用户拍板 5 边界）：
  - `electron/services/salesSummaryJudgment.ts`：独立可测写模块 `persistSummaryJudgment`——append-only 写 `customer_judgment(summary)`；证据诚实（无可靠 messageKey → 不落 key，状态派生 unavailable，绝不伪造）；去重 `hasRecentJudgment`（非手动沿用 24h 窗口=见解去重窗口 `SUMMARY_JUDGMENT_DEDUP_MS`，手动保留覆盖权利）；永不抛错（落库失败返回 persist_error，不阻断主流程）。
  - `generateInsightForSession` 接入：上下文加载处 `summaryEvidence = extractEvidence(toMessageSnippets(messages))`（复用 P0-1 证据提取，客户最近一条实质消息原话，非 AI 结论）；`addRecord` 成功后 `persistSummaryJudgment`（value=最终见解，model/generatedAt=recordLog，source=ai/manual）。不改 prompt / 生成时机 / 返回形状；`insight_record`（JSON 存储）与 `customer_judgment(summary)` 两表**不合并不取代**。
  - 测试 `scripts/summary-judgment-test.ts` **33/33**（6 验收：① 正常生成→落库 ② messageKey 正确保存 ③ evidenceText 是客户依据非 AI summary 本身（含调用点链路断言） ④ 无可靠 key→unavailable 不伪造（含空白串） ⑤ 重复触发→持久化去重 + 手动覆盖权利 ⑥ 现场生成路径不变：不碰 insight_record / 不抛错 / 结果契约稳定）。
- **刀3 `057f8aa` feat(sales) action analysis 三调用点统一落 judgment**（盘点刀3 契约）：
  - `electron/services/salesActionAnalysisJudgment.ts`：`persistActionAnalysisJudgments` 把 `generateActionAnalysis` 输出的 opportunity/riskSignal/nextMove 三字段分别映射为 `customer_judgment` 的 opportunity/risk/next_action（只写三类型，空字段不落，无 sessionId 不抛错）。
  - **三调用点统一接入**：预热（salesActionEngine，写 analysis JSON 后追加落库）/ suggest（main.ts，用户主动生成）/ 客户 360（crmIpcHandlers，合成 item id=0 + triggerType='customer_profile'）。替代「预热写 analysis JSON + on-demand 丢弃」。（**注：P0-3.2 `9a375b3` 起 360 消费者化**——打开档案不再现场生成/落库，判断只由预热/suggest 两调用点生产；360 只消费 `getCustomerCurrentView`，见 §2.31。）
  - **证据策略**（P0-2B 原则）：优先 actionItem 关联任务 `source_message_id`（P0-1 触发原话锚点，`getTask(id)` 直查）→ 兜底 `chatService.getLatestMessages + extractEvidence`（客户最近一条实质消息原话，≤200 字非 AI 结论）；拿不到可靠 key → 落 `message_key=null`，状态派生 unavailable，绝不伪造。
  - **通道语义**：suggest = 用户主动（source=manual，**跳过去重窗口**保留覆盖权利）；预热/360 = 自动触发（source=ai，24h 窗口 `ACTION_JUDGMENT_DEDUP_MS` **按类型**去重，append-only 不 UPDATE）；`basis` 存输入快照（taskId/triggerType/channel）。
  - **三层真源分离**：本模块只写 `customer_judgment`，不碰 `follow_up_task.analysis` 旧链路（todoUpdate(analysis) 保留，新旧并存）；正则机会/风险=客户事实信号，AI judgment=解释，follow_up_task=行动对象，互不冒充。
  - 测试 `scripts/action-analysis-judgment-test.ts` **37/37**（① 三类型映射 ② 任务 source_message_id 锚点证据 ③ 兜底链路 evidenceText=客户原话≠判断值 ④ 无证据→unavailable 不伪造 ⑤ 去重：同窗口全 dedup / suggest 追加 / 按类型去重 / 窗口外重触发追加 ⑥ 现场路径：invalid_input 不抛错 / 空字段不落 / 证据解析失败不阻断 / basis 快照 / 不产生 follow_up_task 行 / 跨 session 隔离）。
- **回归**：`npx tsc --noEmit` 零错误；`tsc -p tsconfig.node.json` 仍 162 既存 electron 错误（隔离债务，非本次引入）；全量测试 27 个脚本全绿（唯一例外 `product-import-test` 缺本地微信临时目录 xlsx 夹具，环境依赖与本次无关）。
## 2.29 P0-2 收口：数据契约治理 CLOSED（2026-08-23）

> 权威文档：`docs/实施记录/P0-2-收口-契约验收.md`。A=State · B=Evidence · C=Judgment 三块基础设施封板；**P0-2 CLOSED**。下一阶段不再修改底层真源，进入 **P0-3 Current Judgment Consumer Layer**。

- **① 静态契约验收**（代码级，全绿）：A 无第二 stage 真源（4 合法写者 + import 投影列不碰 canonical / insight 禁写 / upsert 剥离 / CHECK 双拦截）；B 无裸 key 新写点（messageKey 唯一构造点 shared/messageKey.ts，无散落拼串）；C 四字段无现场生成不落库路径（summary 单入口 generateInsightForSession / 三判断单生产者 generateActionAnalysis 三调用点全落库 / UI 无 customer_judgment 直读）。**无重新出现的第二套真源。**
- **② 真实 DB 只读盘点 + 运行时验证**（脚本 `scripts/p0-2-real-db-audit.ts`，sql.js 内存加载纯只读）：**200 客户**，canonical stage 分布 contacted=76/quoted=67/won=26/lost=21/negotiating=9/**unknown=1**（六档齐全，存量脏值几乎清零）；intent_tag_log 1131 条，P0-1 透传真实生效（evidence=客户原话）；**应用以 P0-2C+ 代码重启后 → P0-2 runtime CLOSED**：`customer_judgment` 自动建表 + CHECK 硬门禁生效，**18 条判断真实产出**（6 客户 × opportunity/risk/next_action，source=ai，model 溯源，basis 含 taskId），evidence 100% 带 key 且 **6/6 P0-2B 可解析**、evidence_text=客户原话，去重 0 冲突 0 orphan；summary 0 条待见解链触发时机（非缺陷）；判断覆盖 6/200=预热高/紧急任务池，与设计一致。观察项：follow_up_task 新任务锚点仍 0（归 P0-4）；evidence 存在 `[视频]` 样本（P0-3 设计时图片/视频视为非文本证据）。
- **③ 架构护栏封死**（8 条 ❌ 条款，见收口文档 §③）：upsert 禁写 stage / insight 禁抢 stage / 禁 customer_judgment.stage / 判断必须能回答"为什么"（无 key 标 unavailable 不伪造）/ judgment append-only 不 UPDATE / 禁再造 messageKey / UI 禁直读 stage 与现场 LLM / 三层真源互不冒充。新代码不得违反。
- **观察（非本范围，记录不修复）**：`follow_up_task.source_message_id` 今日 0/15（P0-1 锚点写点在任务触发路径未实际生效；C.3 证据解析器已有兜底不影响判断链）→ 建议归入 P0-4 Action 埋点治理。
- **下一刀**：**P0-3 Current Judgment Consumer Layer**（盘点完成 `docs/实施记录/P0-3-Current-Judgment-Consumer-盘点.md`：消费者清单——360 现场 advice / SalesContextStrip suggest / 今日行动 analysis JSON / 收件箱 JSON 文件四处分裂数据形态；**Current ≠ Latest** 语义设计——每类型最新一条 + freshness(24h 窗口)/evidenceStatus/source 三维派生，投影不做推理；API 契约草案 `getCustomerCurrentView()`；**5 项已拍板**（2026-08-23 用户拍板：freshness=24h / 空态不补生成 / evidence 卡片显示"有据可查"点击回查 / 独立 IPC `sales:customer:currentView` / summary 空态接受；铁则：只投影不推理 + Latest 与 Fresh 并存）。**第一刀已提交**（`7950ca6` 只读组装层 + 独立 IPC + 30 断言，见 §2.30），**下一动作 = P0-2 UI 迁移**（判断卡消费 currentView，放在验证通过之后）。

## 2.30 P0-3 Current Judgment Consumer Layer：第一刀 只读组装层（2026-08-23）

> 权威文档：`docs/实施记录/P0-3-Current-Judgment-Consumer-盘点.md`。消费者盘点 + 5 项拍板（用户 2026-08-23 拍板）→ 第一刀 `7950ca6`：只做 `getCustomerCurrentView()` 只读组装层 + 独立 IPC + 测试，**不动任何 UI**。

- **拍板 5 项**：freshness=**24h**（沿用现有去重语义）/ 无判断空态=**不补生成**（显示"暂无 AI 判断"；禁消费层现场调 LLM）/ evidence=卡片显示"有据可查"，点击才走 P0-2B 回查原话（视图不返回 before/after/message）/ IPC=独立 `sales:customer:currentView`（不膨胀 360 IPC）/ summary 空态=**接受**（0 条是生产时机问题，不重生成不伪造）。
- **两个铁则**：① **只投影不做判断**（❌ judgment+analysis JSON 合并 / ❌ insight_record 补数据 / ❌ 无 summary 现场调 LLM / ❌ opportunity/risk 再推理）② **Latest 与 Fresh 并存**（stale ≠ 不存在，历史判断照常返回，UI 弱化不清空）。
- **实现**（`7950ca6`）：
  - `electron/services/customerCurrentView.ts`：`getCustomerCurrentView(sessionId, now?)` 纯同步只读投影——`state`=canonical（getCanonicalState）+ `judgments` 四类型各自最新一条（judgmentCurrent）→ `JudgmentView{type, value, generatedAt, source, freshness, evidenceStatus, messageKey}`；freshness 24h 窗口（generated_at ?? created_at 回退）；source='manual' 仅当记录 source='manual' 否则 'ai'；evidenceStatus=judgmentEvidenceStatus 派生；messageKey 仅作回查锚点不携带正文。
  - IPC 三层：main.ts `sales:customer:currentView`（客户不存在 → {success:false, error:'客户不存在'}）/ preload `customerCurrentView` / electron.d.ts 类型。
  - 测试 `scripts/current-view-test.ts` **30/30**：无客户 null / 空态四类型 null 不补 / 三判断投影 + next_action→nextAction 映射 / 48h 前 stale 仍返回（Latest 与 Fresh 并存）/ 缺 summary 不补不生成 / follow_up_task.analysis JSON 写入后视图不变（不并入）/ 无 key→unavailable / canonical state 透传 / generated_at 回退 created_at。
- **下一刀**：**P0-2 UI 迁移**（AI 当前判断卡消费 `currentView.judgments`；360 判断卡从现场 advice 改消费 currentView；SalesContextStrip/今日行动/收件箱迁移）。**360 已迁移完成**（`9a375b3`，见 §2.31），剩余 SalesContextStrip → 今日行动 → 收件箱。

## 2.31 P0-3.2 Customer 360 AI 判断卡迁移：消费 currentView，不再现场调 LLM（2026-08-23）

> 提交 `9a375b3`。范围只锁 Customer 360 判断卡（一类消费者一验收），其他 UI（SalesContextStrip/今日行动/收件箱）不动。价值验证点：**P0-2C 真正取代了 360 的现场 AI 真源**——打开档案不再触发 LLM。

- **handler 改造**（`crmIpcHandlers.ts` `crm:customer:profile`）：
  - ❌ 删除现场 `generateActionAnalysis(adviceItem)`（合成 item + LLM 五字段建议不再生成）
  - ❌ 删除 customer_360 生产者调用 `persistActionAnalysisJudgments`（判断只由预热/扫描链路生产——打开档案不再"消费即生产"）
  - ✅ 改返回 `getCustomerCurrentView(sessionId)` 只读投影（`data.currentView`，客户不存在 → null 不再阻塞 360）
- **UI 改造**（`CustomerWorkspacePage.tsx`）：advice 五字段卡（为什么现在/机会/风险/话术/下一步）→ **AI 当前判断**四卡（总结/机会/风险/下一步），数据全部来自 `currentView.judgments`：
  - 空态：四类全 null →「暂无 AI 判断（系统扫描/预热时生成，打开档案不现场生成）」，不补不伪造
  - stale：标「较旧」（生成超 24h 仍显示，Latest 与 Fresh 并存）
  - source=manual：标「人工」
  - 证据：视图只带 `messageKey` 锚点，卡片显示「有据可查」→ 点击调 `sales:evidence:getByKey`（P0-2B 统一读入口）回查原话+时间，再点收起；unavailable 不显示按钮
- **护栏测试** `scripts/customer360-consumer-test.ts` **13/13**（静态 + 行为）：
  - A 静态：crmIpcHandlers 无 `generateActionAnalysis` / 无 `persistActionAnalysisJudgments` / 含 `getCustomerCurrentView`；UI 无 `customerProfile.advice` / 含 `currentView` + `evidenceGetByKey` / 不直读 `customer_judgment`·`insight_record`·`follow_up_task`
  - B 行为：空态四类 null / 投影字段完备（value/freshness/source/evidenceStatus/messageKey）/ 有 key→ok / 无 key→unavailable / manual 透传 / stale 仍返回
- **架构演进记录**：§2.28 刀3 的「三调用点」→ 现为**两调用点**（预热 salesActionEngine + suggest main.ts）；360 成为纯消费者。静态契约验收「三调用点全落库」表述为当时事实，后续以本节为准。
- **下一刀**：**P0-3.4 今日行动 + 见解收件箱已提交**（`03d994d`，见 §2.33）→ 下一刀 = **P0-3 收口**：全仓静态护栏扫描（src/ 无 UI 直读 customer_profile.stage / insight_record / follow_up_task.analysis / generateInsight / generateActionAnalysis 现场调用）+ 真实库运行态验收。

## 2.32 P0-3.3 SalesContextStrip 迁移：被动消费 currentView，suggest 主动生成保留（2026-08-23）

> 提交 `14eaa07`。范围只锁聊天页顶部状态条（被动展示层）。**两条路径明确分离**：自动/预热生产（预热 salesActionEngine + 扫描链路）→ customer_judgment → currentView；用户主动生产（suggest 按钮）→ generateActionAnalysis → 落库 → **立即重读 currentView**——主动分析与 Current View 不形成两套真源。

- **被动部分**（`SalesContextStrip.tsx`）：
  - ✅ 展开面板新增 **AI 当前判断四卡**（总结/机会/风险/下一步），数据只来自 `sales:customer:currentView`（与 360 同语义：空态「暂无 AI 判断（可点击下方按钮主动生成）」不补 / stale 标「较旧」/ manual 标「人工」/ 证据点击走 P0-2B `evidenceGetByKey` 回查原话）
  - ✅ 30 秒轮询自动刷新包含 currentView
  - ❌ 不直读 customer_judgment / insight_record / follow_up_task.analysis（护栏断言）
  - 档案字段（notes/display_name/last_contact_at）与最近意向 reason 继续走 customerGet/intentHistory——属观察/档案数据非判断，不违反契约
- **suggest 主动生成保留**（用户拍板例外：主动点击 ≠ 打开页面自动生成）：
  - **断链修复**：`actionSuggest` item 补 `sessionId`——P0-2C.3 起 suggest 落库依赖 `item.sessionId` 定位客户，缺失 → `persistActionAnalysisJudgments` `invalid_input` 跳过，**suggest 落库此前从未生效**
  - **生成后立即刷新闭环**：生成成功 → customer_judgment append → 组件立即重读 `customerCurrentView` → UI 显示新判断（fresh）。验证了「主动分析」与「Current View」同源同步
- **护栏测试** `scripts/sales-context-strip-test.ts` **10/10**：
  - A 静态：消费 customerCurrentView / actionSuggest 保留 / 代码不直读真源（去注释扫描）/ suggest item 带 sessionId / 生成后重读顺序断言
  - B 行为：suggest 落库（channel=suggest）→ **立即 currentView 可见**（append → 重读闭环）/ 无 sessionId → invalid_input 复现断链 / suggest=manual 不跳过去重（重复主动生成保留覆盖权利）
- **下一刀**：**P0-3.4 今日行动 + 见解收件箱已提交**（`03d994d`，见 §2.33）→ 下一刀 = **P0-3 收口**：全仓静态护栏扫描 + 真实库运行态验收。

---

## 2.33 P0-3.4 今日行动卡迁移：判断展示消费 currentView，analysis JSON 不再冒充（2026-08-23）

> 提交 `03d994d`。P0-3 最后一刀。核心原则：**P0-3 要消灭的是「把历史 JSON 当 Current Judgment」，不是消灭历史 JSON 本身**。三个消费者边界按用户拍板：
> - **今日行动卡**：「这个客户现在 AI 判断是什么？」→ `currentView.judgments`；「这个任务当时为什么生成？任务本身是什么？」→ 保留 `follow_up_task`（title/ruleCode/priority/sources/dueAt/status 全部不动）
> - **见解收件箱**：「当前客户判断」→ currentView（收件箱不承担此角色）；「AI 历史见解记录/扫描记录」→ `insight_record` 继续存在——**不因架构洁癖废掉整张表**
> - **护栏**：UI 不得把历史载体冒充 Current Judgment（静态断言 + 行为断言）

- **主进程组装**（`salesActionEngine.ts getUnifiedSignals`）：
  - signal 构建后统一附加 `judgments`：`getCustomerCurrentView(sig.sessionId)` 同步投影（主进程一次组装，列表页零额外 IPC）
  - 虚拟卡（`todo:<id>` / `logi:<id>` / `lead:<id>`）无真实微信会话 → `getCanonicalState` 查无客户 → `judgments = null`
  - `UnifiedSignal.analysis` 字段保留（任务自身历史快照），但不再作为判断消费
- **store**（`todayActionStore.ts`）：
  - ❌ 删除 `JSON.parse(sig.analysis)` + `Object.assign(base, parsed)` 合并——**analysis JSON 历史快照不再进卡片冒充当前判断**（P0-3.4 核心删除）
  - ✅ `ActionItem` 新增 `judgments: ItemJudgments | null`（最小 UI 类型：summary/opportunity/risk/nextAction，每项 value/freshness/source/evidenceStatus/messageKey）
  - ✅ `fetchSuggestion` 成功后重读 `customerCurrentView` 刷新该卡 judgments——suggest 落库（channel=suggest/manual append）→ **生成后立即可见**，与 P0-3.3 单卡闭环同构，列表页成立
  - ✅ `suggestion`（话术）保留——用户主动生成的即时建议
- **UI**（`AIActionCard.tsx`）：
  - ✅ 折叠面板改渲染 `item.judgments` 四卡（总结/机会/风险/下一步），与 360/状态条同语义：stale 标「较旧」/ manual 标「人工」/ evidenceStatus=ok 显示「有据可查」→ 点击走 `sales:evidence:getByKey` 回查原话+时间
  - ❌ 删除 `item.whyNow/opportunity/riskSignal/nextMove/degradationNote` 五字段渲染 + AI 洞察兜底行（insight 文本由 teal 块常显，不进判断面板）
  - ✅ `hasAnalysis` 判定 = `hasJudgments || !!item.suggestion`；无判断无话术 → 按钮仍走现场 suggest（用户主动生成保留）
  - ✅ 虚拟卡（todo:/lead:/logi:）按钮逻辑不变（隐藏 AI 分析）
- **见解收件箱**（`InsightInboxPage.tsx`）：**未改**——历史收件箱语义正确（按日期分组 + 来源/触发原因 + 生成时间 + 深度解析标签），走 `insight.listRecords`，不冒充当前判断
- **护栏测试** `scripts/today-action-consumer-test.ts` **14/14**（静态 + 行为）：
  - A 静态：AIActionCard 消费 item.judgments / 不渲染 analysis 五字段（去注释扫描）/ 不直读真源 / 证据走 evidenceGetByKey / store 无 JSON.parse(sig.analysis) / fetchSuggestion 重读顺序断言（actionSuggest < customerCurrentView）/ getUnifiedSignals 含 getCustomerCurrentView / 收件箱历史语义（listRecords + 无 currentView + 无真源直读）
  - B 行为：有判断客户 + 绑定真实会话 task → signal.judgments 四字段可读（value/source/freshness/messageKey）/ 任务自身字段保留（sources 仍来自 follow_up_task）/ 无判断客户 → 四类 null / 虚拟卡 → judgments null / 判断 append 后重跑 → 反映最新（闭环）
- **P0-3 消费者迁移全部完成**：360（§2.31）→ 状态条（§2.32）→ 今日行动卡（§2.33）；生产路径保持两调用点（预热 salesActionEngine + suggest main.ts）；消费路径唯一入口 `getCustomerCurrentView()` / `sales:customer:currentView`。
- **P0-3 收口已 CLOSED**（见 §2.34）：`scripts/p0-3-closed-gate.ts` 全仓静态护栏 6/6（src/ 137 文件，历史载体零冒充）+ 真实库运行态（customer_judgment 18 行 / 6 客户 / 全 fresh / 证据 18/18 可解析 / 零冲突零孤儿）；验收文档 `docs/实施记录/P0-3-收口-契约验收.md`。下一阶段选择权交回用户。

---

## 2.34 P0-3 收口：全仓静态护栏 + 真实库运行态验收（2026-08-23）

> **状态：P0-3 CLOSED**。四刀全部封板：`7950ca6` 只读组装层 → `9a375b3` 360 消费者化 → `14eaa07` 状态条消费者化 → `03d994d` 今日行动卡消费者化。验收脚本 `scripts/p0-3-closed-gate.ts`（静态 + 运行态），验收文档 `docs/实施记录/P0-3-收口-契约验收.md`。

- **① 全仓静态护栏**（src/ 137 个 .ts/.tsx 剥离注释扫描，用户拍板验收表）：
  - ❌ `customer_judgment` 直读 → 0 出现（真源只经主进程组装层）
  - ❌ `insight_record` 作为当前判断 → 0 出现（收件箱走 `insight.*` IPC 历史语义）
  - ❌ `follow_up_task.analysis` 作为当前判断 → 0 出现（analysis JSON 回退为任务自身历史快照，预热仍写、UI 不消费为判断）
  - ❌ UI 现场 LLM（`generateInsight` / `generateActionAnalysis` / `persistActionAnalysisJudgments`）→ 0 出现
  - ✅ 消费统一走 `sales:customer:currentView` → 3 处 UI 消费（360 `customerProfile.currentView` / 状态条 `customerCurrentView` / store fetchSuggestion 重读）
  - ✅ 判断展示统一消费投影四卡 → 360 / 状态条 / 今日行动卡三消费者一致
- **② 真实库运行态**（sql.js 字节进内存纯只读，复用 p0-2-real-db-audit 先例）：
  - `customer_judgment` 表已激活（应用已以 P0-2C.1+ 代码启动）；18 行 / 6 客户（3.0% 覆盖率）
  - 四类型分布 opportunity=6 / risk=6 / next_action=6（summary=0 属部署时序——summary 走 generateInsightForSession 扫描链路）
  - freshness：stale 0/18（全部 24h 内 fresh；stale 语义由 current-view-test 30/30 覆盖）
  - evidence：message_key 非空 18/18 且 P0-2B `parseEvidenceKey` 全部可解析——**P0-1 证据链真实库生效**
  - 冲突观察：opportunity × won/lost = 0 / risk × won/lost = 0 / orphan = 0；真实判断值样例合理（含"聊天记录不足"诚实标注）
- **最终架构**：生产 2 调用点（预热 ai 24h 去重 + suggest manual 覆盖权利）→ customer_judgment → `getCustomerCurrentView()` 唯一解释层 → 三消费者纯展示+行动；历史载体全部回到"任务自身/历史记录"语义
- **下一阶段**：**P0-4 Action Funnel 盘点完成**（`docs/实施记录/P0-4-Action-Funnel-盘点.md`，零编码只读刀：六段漏斗真实定义 + 每段唯一事实来源 + correlation key 现状——task_id 完全缺失但补丁成本极低（前端 rawTaskId 已存在 + completeAction 持有 before.id），见 §2.36；待用户拍板 P0-4.2 Funnel 原语/read model）。

## 2.35 P0-3 E3 CustomerEvent：盘点 → 拍板 → E3.1 基础设施（2026-08-23）

> **E3.1 已提交**（code `f2bfb00` + docs）。E3 = 行为发生后的事件闭环（AI 建议 → 用户复制/打开聊天 → 客户回复 → 下一轮判断，缺回流）；用户拍板不做 P0-4（action 需先定义成事件一等公民，避免再造多套真源）。

- **第一刀只读盘点**（零编码，`docs/实施记录/P0-3E3-CustomerEvent-盘点.md`）：四个问题全部有答案
  - ① `intent_tag_log` = Intent Event 的一等实现（1131 行真实数据；append-only + message_key 锚点 + 5 写入者；canonicalState 已建立其上），缺的是"类型化"而非事件能力
  - ② 事件散落且活跃（合计 ~4600 行）：quote_signal 22 行（**已含 customer_replied_at 回流字段**）/ activity_log 192 / lead_activity 880 / auto_confirm_log 1315；CRM 侧 account/contract 实体轴与 sales 侧 session 轴正交
  - ③ 四消费者**没有一个是"缺 CustomerEvent 表才能干活"**：漏斗只读 State / 意向评分消费 Intent Event / 周报 intentBefore 已满足 / 今日行动 R7 已是"事实事件驱动行动"正确范式——缺口在生产端（P0-4 埋点需先钉成事件）
  - ④ 边界：有过去时态 → Event（append-only）；有现在时态 → Judgment（取最新）/ State（折叠）
- **Scope Lock**（用户拍板，`docs/P0-3E3-CustomerEvent.md` 全文引用）：① 建通用 customer_event 表（session 轴 + message_key 复用 P0-2B + 客户行为/用户行动统一承载）② 首期五类型（customer_replied/quote_asked/script_copied/chat_opened/follow_up_done）③ intent_tag_log 不迁不合并 ④ quote_signal 不迁（customer_replied 统一写 CustomerEvent，customer_replied_at 暂留兼容）⑤ 四消费者全部不迁 ⑥ 本期只做 Event Production ⑦ 不做迁移/UI/Judgment/State 改造
- **硬门禁**：CustomerEvent ≠ 万能日志表——四者不互相冒充（customer_event=客观事实 / intent_tag_log=判定 / customer_judgment=结构化判断 / customer_profile=canonical State）；DB CHECK 五类型 + TS `isCustomerEventType` 双拦截，新增类型必须走迁移（有意的摩擦）；事件分类（customer/action）函数只读派生不加列
- **E3.1 已提交**（`f2bfb00`，本刀只做 Infrastructure，不接业务生产者）：
  - `shared/customerEvent.ts`（新建）：`CUSTOMER_EVENT_TYPES` 五类型 + `isCustomerEventType` 守卫 + `customerEventCategory` 派生 + `CustomerEventRecord`
  - `salesDbService.ts`：SCHEMA_SQL 增 `customer_event` 表（CHECK 五类型）+ 幂等 partial unique index（message_key）+ session/type 索引；原语 `customerEventAdd`（TS 守卫 + 幂等返回 null + 证据诚实）/ `customerEventsBySession` / `customerEventsByType(sinceMs?)`
  - `scripts/customer-event-test.ts`：16 断言（A 静态护栏 8：五类型/无越界/CHECK/幂等索引/原语/守卫/单表写/Scope Lock 文档；B 行为 8：append/幂等拒绝/无 key 重复/非法类型抛错/倒序/type+since/metadata/与判断意向互不干扰）
  - 验收：tsc root 0 / node 162 基线不变 / 全量 33 脚本回归通过（product-import 环境跳过）；真实库 sql.js 只读 = customer_event 表不存在（应用尚未以新代码启动，0 基线同 §2.34 先例）；全仓无任何 consumer 引用（Scope Lock ⑥）
- **E3.2 已提交**（`e6cd33b`，最小生产者接入，只接两个写入点，窄切锁定）：`crmParseService` 报价信号识别成功块后双写 `quote_asked`（metadata 带 amount/model）+ `markQuoteReplied` 返回 closed > 0 时双写 `customer_replied`（客户确实回复了报价）；`recordCustomerEventSafe` helper 写失败只 WARN 不抛（**事件失败绝不回卷原业务链**）；message_key 复用上游 canonical key（P0-2B buildMessageKey，不现场拼）；evidence_text 只取消息原话（textForSignal/content slice ≤200，非 AI 结论）；幂等依赖 E3.1 unique key。**边界全部守住**：quote_signal 原样写不迁移 / customer_replied_at 保留 / R7 不改（salesActionEngine 零 customer_event 引用）/ intent_tag_log 不改 / 无新增扫描定时任务 / 无历史回填。护栏测试 `scripts/customer-event-producer-test.ts` **14/14**（静态 8：双写点/closed>0 门控/复用 key/原话证据/容错/三表零污染；行为 6：双写一致/双幂等/回复闭环/closed=0 门控/写失败不阻断/原链仍成功）；全量 34 脚本回归通过；真实库 0 基线（应用尚未以 E3.1+ 代码启动），quote_signal 22 行/17 已回复兼容字段继续工作
- **E3.3 已提交**（`5f72030`，销售行动事件：E3.2 是"客户发生了什么"，E3.3 是"销售做了什么"）：三事件 script_copied / chat_opened / follow_up_done，按现有 UI/action handler **成功点**接入，行动成功与事件写入解耦（写失败 WARN+continue）
  - `salesActionEngine.ts`：新增导出 `recordUserActionEvent(sessionId, eventType, messageKey?)`——**白名单校验**（仅行动三事件，防万能日志表；follow_up_done 不经 IPC，只由状态转换触发，防双写/不可控）+ try/catch WARN 容错 + `source='manual'`（与 E3.2 的 system 区分）；`completeAction` 增 **before 状态检查**：仅真实转换（pending→done）写 `follow_up_done`，重复完成（已 done/skipped）不产生新事件——与 `last_stage_change_at` 同一幂等思想
  - `main.ts`：新 IPC `sales:action:recordEvent`（薄调 → recordUserActionEvent）；`preload.ts`：`actionRecordEvent`；前端沿用 `(window as any)` 模式，electron.d.ts 不新增（action 系列本就未声明）
  - `AIActionCard.tsx`：`handleOpenChat` navigate 成功后 fire-and-forget 上报 `chat_opened`；`handleCopyScript` 复制成功（含 fallback）后上报 `script_copied`——只挂在动作成功点，`?.` 容错不阻断 UI
  - `scripts/customer-event-action-test.ts`：**15/15**（静态 8：白名单/completeAction before 门控/IPC 通道/preload 暴露/前端成功点接入/follow_up_done 不经 IPC/无第二套 action log/source=manual；行为 7：pending→done 恰好一条 / 重复完成幂等不新增 / skipped 不写 / script_copied 无 key 不伪造 / 白名单外拒绝不抛 / 空 sessionId 容错）；`customer-event-producer-test` A6 按 E3.3 收窄（customerEventAdd 仅 1 处且在 recordUserActionEvent 内，R7 路径零直接事件引用）
  - 验收：E3.3 15/15 + E3.2 14/14 + E3.1 16/16 + 全量 23 脚本回归通过（product-import 环境跳过）；tsc root 0 / node 162 基线不变；真实库 sql.js 只读 = customer_event 表 0 基线保持（应用尚未以 E3.1+ 代码启动）+ DDL 在内存副本无损建表 + 模拟写入五类型通过；quote_signal 22 行全已回复（动态基线，兼容字段继续工作）
- **E3 收口已 CLOSED**（`d97f663`，验收文档 `docs/实施记录/P0-3E3-收口-契约验收.md`，护栏 `scripts/customer-event-closed-gate-test.ts` **16/16**）：静态全仓 13 项——customerEventAdd 出现点恰 3（定义+E3.2 helper+E3.3 recorder）/ 事件查询原语零消费者（Scope Lock ⑥ 四消费者不迁）/ 无绕过 DDL 直接 SQL / 五类型写点归属（A4a-d）/ follow_up_done 不经 IPC / 单表写不冒充 judgment-profile-intent / quote_signal 不迁移（recordQuoteSignal+markQuoteReplied+customer_replied_at 继续工作）/ 无第二套 action log（activity_log 仅遗留 crmDbService）/ R7 不迁移（completeUnifiedSignal 零事件消费）/ 文档同步；真实库运行态 3 项——customer_event 表 0 基线（待应用重启激活，部署时序）/ quote_signal 分流兼容（22 行全已回复）/ DDL 内存副本无损建表 + CHECK 拒绝越界
- **E3 三刀齐 + 收口 CLOSED**：下一步 = **P0-4 Action Funnel**（建立在已验证的 customer_event 事实事件之上）

## 2.36 P0-4 Action Funnel：只读盘点（2026-08-24）

> **P0-4.1 盘点已提交**（零编码只读刀）。核心问题：**销售今天做了什么？做完有没有产生客户响应？最终有没有推动商机？**

- **六问盘点**（`docs/实施记录/P0-4-Action-Funnel-盘点.md`）：
  - ① **Action 来源**：follow_up_task 2818 行（r1 报价 1210 / sla_lead 872 / r2 谈判 383 / urge_customer 171 / r4 156 / manual 3 等）；status 分布 superseded 1601 / pending 1131 / **done 仅 73（规则任务零完成，全在 urge_customer/ai_detected）**；source_message_id 覆盖率 **1/2818**（P0-1 锚点只在 ai_detected 路径写入）
  - ② **六段漏斗**：用户建议六段中「打开聊天」与「复制话术」同属销售执行（同一卡片两按钮，E3.3 已统一）——真实六段 = 行动产生（follow_up_task）→ 行动曝光（**无事件**）→ 销售执行（script_copied/chat_opened/follow_up_done）→ 客户响应（customer_replied/quote_asked）→ 有效推进（stage 前进）→ 商机转化（won）
  - ③ **每段可靠事件**：①②④⑥可靠；**②曝光段不可测**（今日行动卡加载无 read 事件，缺口 G1）；⑤ last_stage_change_at 写者已就位（P0-2A.6 legalStageWriters）但真实库 0 非空（部署时序未激活）
  - ④ **correlation key**：当前只有 session_id 可靠串链；message_key 仅覆盖 E3.2 事件；**task_id 完全缺失**——但补丁成本极低：前端 `item.sources[].rawTaskId`（task.id）已存在 + completeAction 持有 `before.id`，customer_event 加可选列 task_id 即可
  - ⑤ **有效销售行动**：Action Started → Executed → Responded → Progressed；北极星 = **Executed→Responded 转化率**（客户真实反馈，非点击量）
  - ⑥ **现有消费者**：今日行动/周报（State 消费）/CRM 漏斗（State 消费）/消息统计——**行动级统计全仓不存在**，P0-4 是真实缺口；现有统计无一个消费 customer_event（E3 收口已证零消费者）
- **硬边界**：不新增第二套 Action Log（action_log/sales_action_event/conversion_event 零新表）；Funnel 是只读 read model（同 customerCurrentView 先例）；quote_signal 不迁移；不做历史回填；G1 曝光段本期承认不可测
- **真实库**：follow_up_task 2818 / customer_profile 200（成交 26）/ quote_signal 22/22 已回复 / customer_event 0 基线（app 未重启）
- **P0-4 拆刀建议**（已拍板）：P0-4.2.1 correlation 补齐 → P0-4.2.2 getActionFunnel 只读组装 → P0-4.2.3 护栏 + 真实库验收 → P0-4.3 UI/KPI 消费 → P0-4 CLOSED

> **P0-4.2.1 correlation 补齐已提交**（2026-08-24，用户拍板「给 customer_event.task_id INTEGER NULL + 三个行动写点全带 task_id」）：
>
> - **schema**：`customer_event.task_id INTEGER`（nullable，**未动 event_type CHECK**——加列合法）；CREATE TABLE 直含 + 幂等 ALTER 兜底旧库升级（初始化双路径兼容：新库直建带列 / 旧库 ALTER 添加，存量行 task_id=NULL）
> - **三写点**：follow_up_done = completeAction 直写 `before.id`（状态转换成功后，幂等思想不变）；script_copied/chat_opened = 前端卡片 `item.sources.find(s => s.type === 'task')?.rawTaskId`（task 卡已带 rawTaskId，零新组装）→ IPC `sales:action:recordEvent` 透传（`typeof p.taskId === 'number'` 才传，防脏值）→ `recordUserActionEvent(sessionId, eventType, messageKey, taskId)` 四参
> - **口径**：无任务上下文（insight 卡/无 task source）允许 NULL，**禁止伪造**——task_id 是 correlation key，不是事件合法性的前置条件
> - **验证**：customer-event-action 20/20（新增 A2'/A3'/A5'/B9'/B15：before.id 直写 / IPC 透传 / rawTaskId 提取 / follow_up_done.task_id=task.id / 无 taskId → NULL）；customer-event-closed-gate 16/16（A4d 同步新签名）；全量 31 脚本回归通过（product-import 环境跳过）；tsc root 0 / node 162 基线不变；真实库 sql.js 只读验收 7/7（0 基线 + 新库直建带 task_id + 旧库 ALTER 升级 + 存量 NULL + 重复 ALTER 幂等 + CHECK 越界仍拒绝）
> - **未做**：不做历史回填（E3 先例）；rule 任务 source_message_id 缺口 G2 不修（进入 P0-4.2.2 口径说明）

> **P0-4.2.2 getActionFunnel 只读组装层已提交**（2026-08-24，用户拍板三刀之二）：
>
> - **定位**：Task-level read model（同 customerCurrentView 先例），`getActionFunnel(days?, now?)`——**绝不实时推理**：不调 LLM、不从 customer_judgment 推导；只消费 follow_up_task / customer_event / customer_profile 三张 canonical State 表
> - **六段 Task-level 去重**（每 task 布尔 0/1，非事件计数）：created = 窗口内 follow_up_task（superseded 排除，另返回 supersededCount 口径透明）/ exposed = null（G1 不可测，N-A 不伪造分母）/ executed = task 至少一个执行事件（script_copied OR chat_opened OR follow_up_done，task_id 精确关联）/ responded = task 产生后 session 有 customer_replied/quote_asked（session 轴关联——客户事件无 task_id）/ progressed = task 产生后 last_stage_change_at 变更 / won = normalizeStage(stage) === 'won'
> - **sources 逐段可解释**：created=follow_up_task / exposed=unmeasured / executed+responded=customer_event / progressed+won=customer_profile.stage（ACTION_FUNNEL_SOURCES 随视图返回）
> - **口径守卫**：任何分母 0 → rate=null（不返回 0%，防 UI 把「无样本」误读成「0% 转化」）；时序守卫（事件须 created_at >= task.created_at，task 前事件不计）；days 窗口只过滤 created，每 task 后续判定用全生命周期（不截断）；无 task_id 执行事件不归入任何 task（不伪造关联）
> - **新原语**：`salesDbService.tasksCreatedSince(ms)`——窗口内任务（ms=null 全量），created 段唯一数据源
> - **验证**：action-funnel-test 19/19（静态 4：纯只读零 judgment/LLM + sources 逐段 + rate=null 守卫 + 原语存在；行为 15：空库全 null / 组合场景绝对断言 / task-level 去重 / 无 task_id 不归入 / superseded / 时序守卫 / responded 去重 / progressed 时序 / won 口径 / 响应率公式 / days 窗口）；customer-event-closed-gate A2 更新（事件查询原语唯一消费者 = getActionFunnel，四消费者仍不迁——P0-4 是 customer_event 首个正当消费者）；全量 34 脚本回归通过；tsc root 0 / node 162 基线不变
> - **真实库只读验收 5/5**（sql.js 字节进内存，绝不写盘）：created 全量 1217（排除 1601 superseded）、7d 窗口 1050、30d 1214、won=26、last_stage_change_at 非空 0（部署时序，E3/legalStageWriters 激活后才有 progressed 样本）——窗口分布有意义，funnel 口径在真实数据成立
> - **未做**：G1 曝光段本期不做（exposed=null）；rule 任务 source_message_id 缺口 G2 不修（responded 已改 session 轴关联，不受影响）

> **P0-4.2.3 收口护栏 + 真实库验收已提交**（2026-08-24，用户拍板三刀之三）：
>
> - **静态护栏 8 项**（`scripts/action-funnel-closed-gate-test.ts`，防口径漂移/第二套统计/写者越界）：A1 导入白名单（零 salesActionEngine/customer_judgment/LLM——纯只读组装边界）/ A2 getActionFunnel 体内零写方法（10 个写方法零出现）/ A3 执行+响应事件白名单不膨胀（source 级正则，新类型必须显式加入才计入漏斗）/ A4 sources 六段不变量（exposed 恒 unmeasured——G1 未做前禁止伪造分母）/ A5 divRate 分母守卫 / A6 tasksCreatedSince 唯一消费者 = actionFunnel / A7 无第二套 action log（四表名零新 CREATE）/ A8 task_id 非空写点仅 E3.3（crmParseService 客户事件写点零 task_id）
> - **真实库运行态 7 项**（sql.js 字节进内存只读，绝不写盘）：customer_event 0 基线（部署时序）/ **created 口径闭合：非 superseded 1217 + superseded 1601 = 总量 2818**（与 P0-4.1 盘点完全一致）/ **won=26**（normalizeStage 中文口径同实现；profile 200 行 unknown 0）/ 窗口结构不变量 7d<=30d<=全量（days 只过滤 created）/ executed+responded=0（空表无样本，rates 全 null 语义成立）/ last_stage_change_at 非空 0（legalStageWriters 未激活，progressed 待重启后才有样本）/ 六段事实来源字段齐全
> - **验收文档**：`docs/实施记录/P0-4.2-收口-契约验收.md`（三刀回顾 / 口径契约 / 护栏全景 / 真实库快照 / 未做边界）
> - **真实库结论**：funnel 口径在真实数据产生有意义的窗口分布；executed/responded/progressed 三段 0 样本属部署时序（app 未以 E3.1+ 代码重启），非口径缺陷
> - **下一刀**：P0-4.3 UI/KPI 消费——已做，见 §2.37（**P0-4 CLOSED**）

---

## 2.37 P0-4.3 UI/KPI 消费 + P0-4 CLOSED + 真实运行观察期（2026-08-24）

> **用户拍板 P0-4.3 只做三件事**，全部完成；**P0-4 五刀（2.1/2.2/2.3/2.3 护栏/4.3）全链路 CLOSED**。

- **① 漏斗展示**：五段直观漏斗——行动产生 → 销售执行 → 客户响应 → 有效推进 → 成交（ECharts funnel，`sort:'none'` 保留真实段差）；**行动曝光显示「N/A · 当前未埋点」**（G1 无 read 事件，不为好看硬算曝光率、不伪造分母；曝光段不进图，仅提示行）
- **② KPI 只放有意义的**（6 卡，分母 0 → N/A 不显示 0%）：
  - 行动数（created）/ 执行率（executed/created）/ **客户响应率★ 执行→响应转化率**（responded/executed——**北极星**，第一个回答「销售做了动作以后客户有没有反应」的指标，金色高亮）/ 响应→推进转化率（progressed/responded）/ 成交数（won）
- **③ 点击可解释**：执行/响应 KPI 点击 → 下钻弹层：已执行 N/未执行 M + **事件类型计数**（script_copied/chat_opened/follow_up_done → 可答「执行率 32% → 已执行 320/未执行 680 + 事件分布」）+ **最近任务样本 ≤10**（taskId/sessionId/title/createdAt/事件标签，createdAt 降序）；created/progressed/won 下钻为口径说明行（诚实不硬给事件明细）
- **实现**：
  - `electron/services/actionFunnel.ts`：**`collectTaskRows` 共享判定行**（executedByTask + respondedBySession 索引，TaskFunnelRow 携带事件级计数）——getActionFunnel 与 `getActionFunnelBreakdown(days?, now?)` 消费同一判定，**防口径分叉**；`zeroEventCounts()` 五键显式（新增事件类型触发 TS 编译错误——白名单不膨胀的编译期保障）；samples 上限 `SAMPLE_LIMIT=10`
  - IPC：`sales:actionFunnel:get` / `sales:actionFunnel:breakdown`（纯只读，不调 LLM）+ preload `actionFunnelGet/actionFunnelBreakdown` + electron.d.ts 完整类型
  - 前端：`src/pages/ActionFunnelPage.tsx` + `.scss`（新，lazy 路由 `/action-funnel`，侧边栏「报表」组「行动漏斗」Filter 图标）；KpiCard / 五段漏斗 / 曝光 N/A 行 / 下钻弹层 / 口径脚注（每段事实来源一行）
- **验证**：action-funnel-test **25/25**（+6 breakdown：计数与聚合一致 / eventTypeCounts 精确 / samples 降序+双类型去重 / 任务标识 / 窗口传递）；closed-gate **17/17**（A2 升级整文件检查）；tsc root 0 / node 162 基线；全量回归 36/37（product-import 环境失败——微信临时目录 xlsx 已清理，非本次改动）；真实库快照沿用 §2.36（app 重启后 executed/responded/progressed 才有样本）
- **P0-4 CLOSED**。**下一阶段 = 真实运行观察期**（用户拍板：P0-4 做完不马上 P0-5）：
  - **看 5 个数字**：created / executed / responded / progressed / won——每段掉多少就是最大漏损点
  - **4 场景诊断**：A 执行高响应低 → Action Quality（行动质量）；B 执行低 → Action UX（行动体验）；C 响应高推进低 → Sales Process（销售流程）；D 全好 → Scale（扩量）
  - 找到最大漏损点后再决定 P0-5A/B/C；**不提前猜 P0-5**
  - **Summary 覆盖率观察项**：真实库 summary=0（18 条 judgment 全是 opportunity/risk/next_action，P0-2C 生产链路 8-24 至今未产出 summary）——**P0-4 期间不修**，先观察是否随正常见解链自然增长；若真实运行期后仍为 0，单独开小任务 **P0-4.x Summary Production Coverage**（不动 P0-2C 设计）
- **最终目标**：系统从「工程项目」变成「销售增长系统」——AI Judgment → Action → Event → Outcome 可观测闭环

---

## 2.38 P0-4.4 双漏斗 UI 统一视觉体系（2026-08-24）

> **用户拍板三点**，全部完成。纯 UI 改造（观察期冻结清单外属已拍板增量）：未动 Judgment Prompt / Action 推荐 / Funnel 口径 / Event schema / Summary 生成。

- **① 时间窗口**：两个漏斗窗口选项都用 **7/30/90/全部 四档**（不互相阉割——90 天对 B2B 叉车长决策链是季度结构观察关键窗口）；**行动漏斗默认 7 天，销售漏斗默认 30 天**
- **② 配色统一但语义保留**：两漏斗同一蓝系渐变——`#93c5fd → #60a5fa → #3b82f6 → #2563eb → #1e3a8a`（了解→比价→决策→成交，成交藏青呼应）；流失/未知中性灰（`#94a3b8`/`#cbd5e1`）；无警报红
- **③ 行动漏斗 ECharts → HTML/CSS 自绘**（hover/点击态/箭头/tooltip 全可控，不依赖 echarts-for-react）；销售漏斗保留 ECharts（趋势堆叠柱仍 ECharts）
- **实现**（2026-08-24 验收三轮打磨后的最终形态，`e0736b3` 后两次修正提交（`828b6bb`））：
  - 通用：两漏斗**梯形固定比例收窄**（`STAGE_WIDTHS` 纯装饰不绑数值——跳级/转化率>100% 不改变形状）+ 每段**极细微渐变**（左上→右下轻微加深，浅端 `STAGE_GRADIENT_LIGHT` 两图共用同一色板，深端 = STAGE_COLORS 基准色）+ **数字层级**（主数字 26px/16px 纯白粗体；转化率 10-11px 白色 70% 透明度，主次分明）+ 统计/KPI/状态卡轻投影 + 间距呼吸感
  - `SalesFunnelPage`：DAY_OPTIONS 四档（默认 30）+ 副标题「客户当前所处销售阶段分布」+ ECharts funnel **rich label 双行**（`段名 人数人` 大字 + `转化 X%` 小字半透明白；第一档恒 100%）+ `value` 传固定比例 + `data.real` 存真实人数（label/tooltip 均取 real）+ `minSize: 0` 使宽度严格等于固定比例 + itemStyle `LinearGradient` + `borderRadius: 2` + `gap: 2` + `selectedMode:'single'` 点击态 + 状态卡 hover 上浮/active 归位（顶部色条随阶段色）
  - `ActionFunnelPage`：DAY_OPTIONS 四档（默认 7）+ **自绘五段梯形**（svg path 梯形 + 同色描边 `strokeWidth:4` `strokeLinejoin: round` = 2-4px 圆角——clip-path 无法圆角故改 svg；`width: STAGE_WIDTHS[i]%` 固定比例；⚠️ col 必须显式 `width:100%`——否则 shrink-to-fit 下百分比宽度无法解析，每段退化为内容宽不呈梯形）+ 段间**主题蓝小三角箭头**（ChevronDown 16px，链路感——行动漏斗=过程链路 vs 销售漏斗=状态分布）+ 段内：段名 + 人数大字 + 转化率小字（源头段显示「源头」、分母 0 显示 N/A）+ 每段可点击 → 与 KPI 共用下钻弹层（hover 亮度高亮）+ **推进/成交段右上角 Info 徽标 → hover/focus 出 tooltip**（弱化口径映射说明：progressed=比价→决策→成交 stage 变更 / won=销售漏斗同口径；徽标在 wrap 层、按钮外——描边/裁剪会裁掉溢出按钮的 tooltip）
- **验证**：tsc 双 gate（root **0** / node 162 基线不变）+ funnel **40/40** + action-funnel **25/25** + 两 scss sass 独立编译通过 + vite HMR 无编译错误
- **观察期纪律**：P0-4 冻结清单不变（观察期内不改 Judgment Prompt / Action 推荐 / Funnel 口径 / Event schema / Summary 生成逻辑；唯一例外=埋点/数据完整性 Bug）

---

## 2.39 线索模块「群资源扫描」+ 商机识别三修复（2026-08-27，工作区未提交）

> 用户拍板「给线索模块加扫描，自动扫描录入当前销售人员的资源分配」；观察期红线内纯增量：手动触发唯一路径、零调度器、不改 crmParseService 现有扫描行为。方案与验证详见 `docs/设计-单机线索流转模块.md` §4.5。
>
> ⚠️ **群扫部分已下线（2026-09-02 决策 B，DATA-CONSTITUTION §4.2）**：本节「群资源扫描」「归属语义」「线索页归属筛选（扫描侧）」「配置项」四块已整体下线——`crmLeadScanService.ts`/`crmLeadScanCore.ts` 删除、入口按钮/模态/`crm:lead:reassign`/`crm:lead:scanGroup` IPC/设置项全数移除、`scan_state` `leadScan:*` 游标清空（信号扫描 `priv:*` 不受影响）；`lead.tag` 仅保留 Excel 导入的「需求标签」语义。取代方案 = Phase 0 新表 `assignment`（§2.42）。**「商机三修复」与「构建坑复现」两小节仍有效**（与群扫无关）。

- **群资源扫描**：线索页「扫描群资源」按钮 → 模态「仅预览（不写入）/ 扫描并导入」。新建 `electron/services/crmLeadScanCore.ts`（纯提取，零 electron 依赖）+ `crmLeadScanService.ts`（编排，salesQueue 串行）；chatService 分页读群消息（BATCH 500 / MAX_PAGES 100）→ 两种分配式：同消息（`手机号 客户 @销售`）+ 引用（type 49 按 rawContent `<refermsg><svrid>` 配对被引消息）→ `@token` 匹配白名单三种真实变体（多 @ 任意命中即归属 / 双 @ `@@昵称` 去前导 @ / 直接 @显示名；全局扫 token、key/value 双向匹配）→ 复用 `importLeads('群资源扫描', …)` 全部写路径（UNIQUE 去重 / SLA / lead_activity / import_batch 免费）→ `scan_state` 键 `leadScan:<群id>` 增量游标（dry-run 不动游标零写库；truncated 也推进，下次续扫）
- **归属语义**：非白名单 @ 仍录线索 tag=「未分配」（不丢弃）；同号换归属单向升级（仅 tag 为空/未分配可升级，用户手动改过的不碰）+ note 记 `曾归属:X（日期）` 历史；note 证据格式 `群扫描归属:销售（日期）·同消息|引用识别·msg:<serverId>`
- **红线已守（只读核验）**：不写 `processed_msg`（信号扫描幂等键）、不写 `group_config`（会被 crmParseService.scanAll 认领）——扫描前后 group_config 2 行、processed_msg 51,346 行均不变
- **真实数据验证**：8,912 条群消息离线回放对照外挂脚本基准 → 三种 @ 变体 bug 致漏配 9，修复后**漏配 0**（多配出 11 条均为基准脚本漏识别）；正式扫描已由用户在应用内执行：**4,680 条入库**（归属分布 秒变1513 / 李林辉1355 / 杨青981 / 静候653 / 未分配178），引用未解析 118 条（被引消息早于游标等）
- **线索页归属筛选**（用户反馈「4000 多个号码不是一个人的」）：tag 筛选 chips（按计数倒序，默认「全部归属」）；扫描线索 tag=销售归属、Excel 导入线索 tag=需求标签，同一维度可筛
- **配置项**：`crmLeadScanGroup` / `crmLeadScanWhitelist`（留空用内置默认群「新媒体业务奋斗群」+ 7 行默认名单；设置 → 线索流转可改）
- **商机三修复**（Windows 打包版实测反馈，修复在源码需 `npm run build` 重打包生效）：① `parseQuoteSignal`/`parseBuySignal` 手机号不当金额（`PHONE_NUM_RE` 跳过 + `AMOUNT_MAX=1e8` 合理性上限；真实案例 ¥15,200,000,006 = 手机号 15200000006）② `opportunityUpsertBySignal` 无产品信号累积到最近一条无产品 active 商机（此前每条信号新建→重复商机）③ OpportunityPage 商机金额 ≥1e8 显示「亿」（此前 ¥3040527.4万 式畸形单位）
- **构建坑复现**（同 2026-08-24 增量所记）：`electron/**` 陈旧 tsc 产物 `.js` 经 vite resolve.extensions（.js 先于 .ts）静默遮蔽 `.ts` 源码——本次 51 个陈旧产物致 dev main.js 四天未更新；删除产物 + 全量重启 dev 后恢复（产物无 .ts 兄弟的白名单资产如 `assets/wasm/*.js` 不删）

---

## 2.40 微信号分库：业务数据按账号隔离（2026-08-29 方案定稿 + **已实施**，工作区未提交）

> 用户实测反馈（Windows 打包版）：切换微信号后，上一个微信的 266 客户 / 18 条信息待确认 / 值得跟进 199 仍全量显示。**用户已拍板「按微信号分库」**（三选一：分库 / 切换归档 / 手动清空按钮）。本节为冷启动交接：实现会话按本节直接开工，无需重新调研。
>
> **✅ 实施记录（2026-08-29，按本节设计原样落地）**：`businessDbPath.ts`（sanitize/businessDbName/businessDbPath/migrateLegacyBusinessDbs/archiveStampOf/archivedDbName）+ 两服务 `initialize(userDataPath, wxid?)` + `initPromise` 并发护栏 + `reopenForWxid` + `archiveCurrentDb`（`currentDbPath()` accessor）+ main.ts `config:set` myWxid 值变化钩子（`switchBusinessDbsForWxid` 走 `enqueueSalesTask` 串行）+ 启动迁移（`startupWxid` 传三处 initialize）+ 归档 IPC `chat:archiveBusinessData` + crmIpcHandlers 补 wxid + backupService 备份清单 glob `weflow-(crm|sales)-*.db`（排除 `.archived-` 件）+ preload/d.ts 桥接 + SettingsPage 数据库 tab「业务数据归档」按钮（confirm + 完成提示归档文件名 + wxid-changed 事件）。**验证**：`scripts/account-db-isolation-test.ts` **27/27**（静态 11 + 行为 16：wxidA 写入→切B空→切回A数据在 / 迁移幂等 / 共存不动 / 归档产出 .archived-<yyyyMMdd-HHmmss>.db / 空 wxid 回退 legacy / 并发 initialize 去重 / findExistingBusinessDb 路径解析）；`npx tsc --noEmit` 0 错误 + node 侧 158 条与 HEAD 基线逐条 diff **零新增**；crm-lead-test **55/55** + payments-claim-test **18/18** + crm-golden-test **45/45**。**分库后真实库脚本路径修复（2026-08-29 独立复查发现）**：7 个硬编码 legacy 路径 `weflow-{crm,sales}.db` 的只读脚本（payments-claim-test / p0-2-real-db-audit / p0-3-closed-gate / p01-evidence-inspect / canonical-state-validate / action-funnel-closed-gate-test / customer-event-closed-gate-test）在迁移后全部 ENOENT——`businessDbPath` 新增 `findExistingBusinessDb(userDataPath, kind)`（suffixed 按 mtime 最新优先 / 回退 legacy / 排除 `.archived-` / 零写入），7 脚本统一改用后复跑通过（其余 gate 的个别 FAIL 均为 08-24 硬编码数据基线过期：customer_event 已积累 10 行、won 27/228、last_stage_change_at 出现首例——数据正常增长，与分库无关）。**Mac live 重启实测**：迁移日志 `crm → weflow-crm-wxid_wen24wq8ojio22.db, sales → weflow-sales-wxid_wen24wq8ojio22.db`，重启前已备份 `crm-backups/weflow-{crm,sales}-before-accdb-migration-20260829-111612.db`；二次重启迁移日志 0 条（幂等）；sqlite 只读抽查迁移后库 lead=4680 / account=203 / opportunity=5 数据完好。**遗留**：Windows 侧装新包后首次启动即自动迁移（历史库归到当时的 myWxid，Windows 特例见下「已知限制」，点一次设置页「归档当前账号业务数据」即得干净新库）。**2026-08-29 21:36 Windows x64 包已重打并 asar 探针验证分库全在**（用户 8/29 报告「切号后上一账号数据仍有存留」即 8/28 旧包无分库 + 扫描继续写共享库所致；洞察模块的隔离是行级 `accountScope= wxid:<myWxid>` 标记 + 读时过滤（insightRecordService `getCurrentAccountScope/getScopedRecords`），分库是文件级强隔离且已拍板，无需改洞察式）。

### 根因（已查实）

- 切换微信号链路：SettingsPage 两处（`selectWxid` ~:1245、myWxid 输入 ~:2538）→ `configService.setMyWxid` → IPC `config:set` → `chat.close()`/`chat.connect()` 切 wcdb 账号目录 + 前端 `clearAnalyticsStoreCache()`/`resetChatStore()`/`wxid-changed` 事件
- **wcdb（聊天）天然按账号隔离**（每账号独立目录），但**业务库全局单份**：`weflow-crm.db`（crmDbService.ts:300，客户/商机/线索/合同）、`weflow-sales.db`（salesDbService.ts:228，跟进卡/AI 判断/意图日志）都固定 `join(userDataPath, 文件名)`，与 wxid 无关
- 后果 = 旧账号数据原样显示 + **信号扫描（crmParseService）继续把新微信会话写进同一库**，两账号客户混表，越用越脏
- 附：`chat:clearCurrentAccountData`（main.ts:2857，无渲染层调用者）只清 config/缓存/导出，不碰业务库

### 设计（已定稿）

1. **库命名**：`weflow-crm-<wxid>.db` / `weflow-sales-<wxid>.db`；wxid 清洗 `[^A-Za-z0-9_-]→'-'`；**空 wxid（未完成引导）回退 legacy 名**（兼容现有测试/初始化顺序）
2. **新建 `electron/services/businessDbPath.ts`**（纯 fs/path，可单测）：`businessDbPath(userDataPath, wxid, kind)` + `migrateLegacyBusinessDbs(userDataPath, wxid)` —— 迁移规则：wxid 非空 && suffixed 不存在 && legacy 存在 → `renameSync(legacy → suffixed)`；两者共存不动（不重复迁移、不覆盖）
3. **服务层**：`crmDbService`/`salesDbService` 的 `initialize(userDataPath)` 加第二参 `wxid?`；加 `initPromise` 并发护栏（现存在 main.ts:5421 与 crmIpcHandlers.ts:51 双 initialize 竞态，分库后双路径会真坏事）；新增 `reopenForWxid(userDataPath, wxid)` = persistNow → 置空 db/dbPath → initialize
4. **切换挂载点（渲染层零改动）**：main.ts `config:set`（:2037）加 `if (key === 'myWxid' && newValue !== oldValue)` → `enqueueSalesTask`（串行防扫描中换库）内执行 migrate + 两服务 reopen。切账号必经 setMyWxid → config:set，故两处 UI 调用点都不用改
5. **归档逃生舱**（用户 Windows 机的解法，见「已知限制」）：新 IPC `chat:archiveBusinessData` → 归档当前 wxid 的两库为 `<原名>.archived-<yyyyMMdd-HHmmss>.db` → 原账号 reopen 新空库；设置页新增「业务数据」section 按钮（确认弹窗 + 完成提示文件名）
6. **周边**：crmIpcHandlers.ts:51 initialize 补 wxid 参；backupService.ts:719 `collectSalesData` 的 names 追加 suffixed 模式（`weflow-crm-*.db`/`weflow-sales-*.db` 遍历 userData）；preload.ts:252 + electron.d.ts:642 桥接 archiveBusinessData
7. **测试**：`scripts/account-db-isolation-test.ts`（行为：wxid A 写入 → reopen B 为空 → reopen A 数据在；迁移 rename 幂等；静态：config:set 钩子 / preload+d.ts 桥接 / 设置页按钮 / backupService 覆盖）+ 跑 crm-lead-test 53 守回归

### 文件变更清单

| 文件 | 动作 |
|---|---|
| `electron/services/businessDbPath.ts` | 新建：路径计算 + 迁移 |
| `electron/services/crmDbService.ts` / `salesDbService.ts` | initialize 加 wxid 参 + initPromise 护栏 + reopenForWxid |
| `electron/main.ts` | :2037 config:set myWxid 钩子；启动三处 initialize 前调 migrate；新 IPC archiveBusinessData |
| `electron/services/crmIpcHandlers.ts` | :51 补 wxid |
| `electron/services/backupService.ts` | :719 备份清单覆盖 suffixed |
| `electron/preload.ts` / `src/types/electron.d.ts` | archiveBusinessData 桥接 |
| `src/pages/SettingsPage.tsx` | 新「业务数据」section + 归档按钮 |
| `scripts/account-db-isolation-test.ts` | 新建 |

### 已知限制 / 用户须知（交接必读）

- **历史库归属规则 = 升级后首次启动时的当前 myWxid**。Mac 正确（数据即当前账号所产，4,680 线索自动归位）；**Windows 特例**：用户已先切到 amthi66，旧账号的 266 客户会被归到 amthi66 名下 → 升级后在设置点一次「归档」即得干净新库（.archived 备份不删，需回看可手动改回文件名）
- 观察期口径：分库后 P0 指标（漏斗/判断/跟进卡）天然按微信号隔离——这正是本改动意图，非指标漂移
- 不动 `chat:clearCurrentAccountData` 现有行为；不迁移数据内容（整文件换名，零改写风险）

### 验收

1. wxid A 导入客户 → 切 wxid B → 客户/商机/线索/今日行动全空 → 切回 A 原样恢复
2. 升级启动：legacy db 自动改名 suffixed（幂等：二次启动不再动）
3. 归档按钮：当前账号库变 .archived 文件 + 应用内立即空库
4. `npx tsc --noEmit` 零错误 + isolation-test 全绿 + crm-lead-test 53/53
5. Windows 实测：切账号后上个微信数据不再显示

---

## 2.41 报表 & CRM 七页 UI 美化 + 线索归属管理（2026-08-29~30 设计定稿并实施，工作区未提交）

> 用户驱动流程：HTML 设计稿（`docs/UI美化-报表与CRM-设计稿.html`，六页 mockup + 6 条全局动作 + 红线自检，light/dark 双模式可切）→ 用户拍板「可以」→ 实施（先保守只换 token，用户反馈「和稿子差距大」→ 授权「按稿抄，按钮位置/点击行为也可改」→ 连续八轮对齐）。**观察期 UI 例外 #3**（红线沿用 `docs/DESIGN-SPEC-MINI.md`：不改业务逻辑/口径/事件/判断链）。设计稿中的示意数字仅为审阅参考，实际数值由接口注入。

### 全局设计系统（一次定义，七页复用）
1. **内容限宽 1280px 居中**：`.crm-workbench-page / .crm-review-page / .opp-page / .crm-lead-page / .cws-page / .af-page / .funnel-page`（main.scss 尾部统一规则）。⚠️ 窗口 <1280px 时居中不可见（内容本来就占满），拖宽窗口才看得出——用户曾因此误以为「没变」。
2. **默认主题根因修复**：`themeStore` 初始 `currentTheme` 原为 `'cloud-dancer'`（棕金 #8B7355）——**W1 拍板的 Apple 蓝默认从未生效**，应用出厂即棕金，是用户多轮「颜色对不上」的总根源。修复：themes 列表头部新增 `default`（默认 · Apple 蓝 #0071E3）+ 初始值改 `'default'` + ThemeId 补 'default' + **persist `version: 1` + `migrate` 强制重置旧持久化**（⚠️ zustand persist 只设 version 不写 migrate 时旧状态仍被采用，migrate 必须显式返回新默认）。设置页主题选择器首项即「默认 · Apple 蓝」。
3. **统计卡语言**：白卡浮起（surface + shadow-card + radius-card，hover accent 描边上浮）+ 图标芯片 38px（语义 tint）+ 26px/700 tabular-nums 主数字；统计行一律 grid 等分铺满（**禁止 flex 内容宽**——商机/销售漏斗先后栽过）。
4. **图表色单一真源**：所有 ECharts 柱/饼/漏斗色收 `shared/funnelPalette`（funnel-test 的 funnelPalette 红线 3）；阶段分布 donut 中心总数 + 右侧竖排图例；空数据图表显空态文案（如合同管道）。
5. **pill 徽标系统**：待签约/待确认=蓝/琥珀、已签约/已开票/高意向=绿、预警/超期=红、中性=灰（`.crm-pill--*`）；⚠️ `.crm-pill` 定义在 CrmWorkbenchPage.scss，**商机页单页直连时不可依赖跨页类**（`.crm-pill` 已在 OpportunityPage.scss 自含一份——跨页 CSS 依赖坑，见下「坑」）。
6. **分段控件/chips**：灰底 + 选中项浮起（surface + accent 字 + shadow-control），用于周报月报/客户三 Tab/漏斗窗口/跟单两 Tab。
7. **表格**：SearchTable th/td 同步列 className（`.num` 右对齐 tabular-nums）、表头 11px tertiary、行 hover、ghost 操作按钮；筛选栏裸 select/input 统一皮肤（focus 环）。

### 页面级落地（七页）
- **合同** `/crm`：三卡 grid = 到款趋势｜阶段分布｜AI 准确率卡（核心 4 数字 2×2 + 展开明细折叠；管道图已删，信息以 pill 条并入列表上方）；卡标题带 hint 小字；新建合同 primary（⚠️ 曾因 `&.primary` vs 类名 `crm-btn--primary` 不匹配失效）；表格状态/预警 pill。
- **客户** `/customers`：cws-tabs（⚡/✨/👥 带计数）移到信息待确认**上方**；待确认行 = 标题 + 待确认琥珀 pill + 置信灰字 + 证据引用块（accent 左边线限宽 560px）+ 三按钮右置；卡流 3 列大卡（minmax 340px）+ Avatar + 「AI 深度分析」卡上按钮；原顶部被动计数行已删（与 Tab 重复）。
- **商机** `/opportunities`：统计卡图标芯片；**ECharts 漏斗 → CSS 阶段条**（宽度按 stageDist 比例、135° 渐变、段间递进箭头、点击筛选/再点取消，ReactECharts 导入已移除）；列表包进单卡容器（分隔行 + 标题带条数/筛选联动）；行六段对齐（日期/名·品/徽标/金额或待确认琥珀 pill/意向度条/信号）；高意向绿 pill。
- **跟单中心** `/review`：两 Tab（💰款项认领｜🚚物流跟单，扫描群聊配置归物流 Tab，默认款项）；每日分组 header = 日期加粗 + 今天蓝 pill/昨天灰 pill + N 笔 + 未认领红字右推；**已确认到款行** = 独立 `claimed-row`（flex row + ¥ 图标芯片 + 两行信息 + 开票 pill + 到账时间；⚠️ 勿复用 `logi-card`——其 flex-direction:column 会把行挤成竖堆，踩过）；分页信息 pill。
- **线索** `/leads`：scss 全量 token 化（原 slate 硬编码）；统计卡对齐全局语言（超时卡红 tint）；状态徽章 pill（新=蓝/首触=绿/加微信=紫/失效=灰/转客户=琥珀）；**归属管理功能见下**。
- **复盘** `/report`：周报/月报分段控件；**生成周复盘=accent 主按钮**（原紫色系 #8e2de2 全部退场）；AI 摘要 accent 渐变卡；🔥红/❄️蓝/✂️灰 语义 tint 卡；阶段条 accent；历史报告 active 左条 + 排行前三徽章。
- **漏斗两页** `/funnel` `/action-funnel`：限宽 1280 居中；行动漏斗曝光改第 6 张 KPI 卡（N/A 诚实语义保留）、梯形列限宽 720px 居中 + 收窄比 [100,76,56,40,28]；销售漏斗统计卡 5 等分、ECharts 图限宽 860px 居中。

### 线索归属管理（新功能，用户反馈「很多销售归属都是一个人」；⚠️ 2026-09-02 已随决策 B 下线）

> 「⚙ 管理归属」弹窗、`leadReassignOwner`、IPC `crm:lead:reassign`、白名单防复发待办已全数移除（见 §2.39 注记）；存量 4,680 条群扫线索的 tag 归属清理与回资源池 = Phase 0 **D4 迁移脚本**的事。

- **根因**：群资源扫描按白名单「群昵称=销售名」归属，「秒变」「静候」是昵称误配成的显示名（1513/653 条）。
- **能力**：`leadReassignOwner(from, to)`（crmLeadService，按 tag 批量 UPDATE + 事务 + 空名/同名/无命中校验）→ IPC `crm:lead:reassign` → preload/d.ts `leadReassign` → 线索页归属 chips 行尾「⚙ 管理归属」弹窗（原归属→新归属（现有/新建名）+ 预览条数，执行后刷新并联动筛选）。行为验证：2 条合并/空归属/同名拒绝 ✓。
- **后续扫描防复发**：设置 → 线索流转 → 扫描白名单（`crmLeadScanWhitelist`，每行 `昵称=销售名`）把昵称映射到真实姓名——**用户尚未操作，需提醒**。
- 附注：线索页「超时未首触 4679」非 bug（8/27 批量导入的 24h SLA 自然超时）；「今日待处理 5551 > 总数 4680」= SLA 卡含已清除线索的历史卡，数据卫生问题待观察。

### 本轮发现并修复的 Bug（都有回归价值）
1. **`salesDbService.close()` 未清 `initPromise`**：close 后再 initialize 被 resolved promise 短路，库重开不出来（funnel-test 场景 2 崩）——分库 initPromise 护栏的次生坑，close() 已补清。
2. **默认主题出厂即棕金**（见上，persist migrate 语义坑：只设 version 不写 migrate 时旧状态仍被采用）。
3. **`crm-btn--primary` 样式失效**：scss 只定义嵌套 `&.primary`，BEM 类名不匹配 → 新建合同按钮显示描边；补 `&.crm-btn--primary` 别名。
4. **商机 CSS 漏斗塌陷**：外层包裹 div shrink-to-fit 导致百分比宽度无法解析（ActionFunnelPage 同款坑有注释），`.opp-funnel > div` 须显式 width:100%。
5. **已确认到款行竖堆**：行复用 `logi-card`（flex-direction:column）挤垮横排 → 独立 `claimed-row`。
6. **`.crm-header h2 { margin-right: 0 }` 误伤**：为合同页副标题写的全局覆盖把客户/跟单页头按钮也贴到标题旁 → `:has(.crm-header__sub)` 收窄作用域。

### 验证状态（全部通过）
`npx tsc --noEmit` 0；crm-workbench **50/50**、payments-claim **18/18**、crm-lead **55/55**、funnel **40/40**、golden **45/45**、current-view **30/30**、分库护栏 **27/27**；七页均经 dev HMR 推送 + 用户窗口目视比对。

### 坑（新会话必读）
- **HMR 假象**：vite 日志 `(client) hmr update` 只代表推送，渲染端未必应用（用户多次「没变」实为旧渲染态）——排查时先让用户 **Cmd+R**，或 `touch index.html` 触发 `page reload` 整页重载；判定服务端是否新代码用 `curl localhost:3000/src/pages/X.tsx` grep 关键串。
- **纯浏览器打不开渲染器**：应用深度绑定 Electron preload（`window.electronAPI`），plain browser 白屏属预期，不能用作预览手段。
- **跨页 CSS 依赖**：客户/商机页复用 CrmWorkbenchPage.scss 的 `crm-*` 类，单页直连时新类须在本页样式文件自含。
- **flex 内容宽统计卡**：统计卡行一律 grid 等分，禁止 flex（商机/漏斗两页先后栽过）。
- **截图 2x 分辨率**：用户截图量尺寸记得除 2（曾误判 max-width 未生效，实际已生效）。

### 待办（UI 线收口）
1. **提交工作区**（攒了：分库 §2.40 + 七页 UI + 归属管理 + 4 个 bug 修复，全部未 commit）。
2. **Windows 重打包并安装**（分库 + 七页 UI 一起带上；装完首次启动自动迁移 → 设置页点一次「归档」得干净库）+ 跑商机修复 SQL。
3. 复盘页（`.sr-page`，全高滚动布局）尚未做限宽居中——需验证后再动。
4. 线索归属：提醒用户改扫描白名单映射（防复发）。

---

## 2.42 Phase 0 D3：宪法 6 新表 DDL + 决策 B 群扫描下线（2026-09-02，工作区未提交）

> Phase 0 第三刀（排期与坑清单见 `docs/规划/weflow-hermes-Phase0-启动细化.md`）。字段权威 = `docs/DATA-CONSTITUTION.md` §1，本节记实现事实、拍板与验证；AGENTS.md「2026-09-02 增量」为同内容速记。

- **6 新表**（SCHEMA_SQL「CREATE TABLE IF NOT EXISTS」+ ENTITIES 白名单注册——漏注册=静默失败前科 crm_risk）：`customer`（§1.1）/ `customer_identity`（§1.2）/ `assignment`（§1.3）/ `ownership_history`（§1.8）/ `outbox_event`（§1.11）/ `audit_event`（§1.12）；表结构速览见 §5.1
- **CHECK 硬门禁仅三处**（有穷枚举才配硬门禁）：assignment.status / customer_identity.identity_type / outbox_event.status；customer.type 等未定标枚举不加，防 Phase 1 被硬门禁卡死
- **通用五列**（source/updated_by/updated_at/version/deleted）只给可变更实体；append-only 表按宪法 §2.2 例外只带 source+created_at（outbox_event 另有 updated_at，因 status 会流转），**不设 version/updated_by 死列**（lead 四死列教训）
- **幂等 ALTER 2 组**（逐列 ALTER 吞错，宪法 §2.2 无版本表约定）：account.customer_id 可空挂接；opportunity 补 14 列（§1.5）+ quotation 版本模型 4 列（§1.6）+ contract.quote_version_id。**quotation.contract_id 双写拍板**（已写进 crmDbService 迁移块注释）：Phase 1 版本链写入路径上线起同事务双写，Phase 2 读路径切换后退役
- **决策 B 下线执行**（§2.39/§2.41 注记所指）：删 `crmLeadScanService.ts`/`crmLeadScanCore.ts`（**两者从未进 git**——群扫整套是未提交工作区功能，electron/services/config.ts 删字段后恰好回 HEAD 态、git status 无痕）；线索页「扫描群资源」按钮+模态、「⚙ 管理归属」弹窗、`crm:lead:reassign`/`crm:lead:scanGroup` IPC、preload/d.ts 桥接、设置项 `crmLeadScanGroup`/`crmLeadScanWhitelist`（electron+前端两层）全数移除；doInitialize 幂等 `DELETE FROM scan_state WHERE key LIKE 'leadScan:%'`（源库实测 1 条待清，`priv:*` 168 条不碰）。**首触 SLA 检查（scanSla）不在下线清单且链路完好**——实现一直在 crmLeadService.ts:213，与被删的 scan 服务无关；`lead.tag` 仅保留 Excel 导入的「需求标签」语义（线索页 chips 文案已同步）
- **验证**：新脚本 `scripts/phase0-d3-ddl-test.ts`：fresh **36/36**（新表建成且空/五列/append-only 例外/CHECK 拒非法值+全枚举可写/UNIQUE 复合键/ENTITIES create+getById/存量表补列）+ real **21/21**（真实库副本：存量 8 表 count 零变化、补列到位、leadScan 游标清零、CHECK 生效）+ 已迁移库二次初始化复验 **21/21**（幂等；B2 首迁守卫在复验场景的误报已修为场景分支）；`npx tsc --noEmit` **0 错误**；node 侧 158 条与既有基线逐条核对**零新增**（crmDbService×2 / crmIpcHandlers×3 仅行号平移、config.ts×1 为 HEAD 既有 crmAutoConfirm* 缺默认值）；回归 **crm-lead 55/55 + crm-workbench 50/50 + payments-claim 18/18 + crm-golden 45/45** 全过；electron/ 编译产物对照白名单 5 文件零陈旧产物（坑清单 #9）
- 存量 4,680 条群扫线索的 tag 归属清理与回资源池 = **D4 迁移脚本**的事（只写不跑），本刀未动任何 lead 数据

---

## 2.43 Phase 0 D4+D5：迁移脚本骨架 + 接口契约（2026-09-02，工作区未提交）

> Phase 0 第四/五刀（排期见 `docs/规划/weflow-hermes-Phase0-启动细化.md` §二）。本节记交付物与试跑事实；AGENTS.md「2026-09-02 D4+D5 增量」为同内容速记。

- **D4 = 只写不跑的骨架**：`scripts/migration/` 共 6 文件——`types.ts`（统一迁移报告：total/wouldApply/alreadyDone/skipped/failed/conflicts + 逐条失败原因，幂等 alreadyDone 为必填）+ 四模块 + `dry-run-all.ts` 试跑入口。每模块头部写死铁律：**执行必须走应用链路（crmDbService），禁直改库文件**（sql.js 覆盖前科 §2.40）。**未写执行器**——执行器属 Phase 1
- **四模块口径**：① 决策 B 存量处置（4,680 条群扫线索 tag 清理，note 留痕格式 `曾归属:X（日期）` = 宪法 §4.2 原文；leadScan:* 游标核验）② account → customer 回填 + customer_id 挂接（§2.4：手机号优先 / session_id wxid 兜底查重；19 个无锚公司名 account 进失败清单）③ lead → customer_identity 归并（(identity_type, identity_value) 唯一约束；customer_id=NULL 资源池合法态；lead.contact_normalized 对 wechat 曾小写归一 vs 宪法只 trim 的差异已写进 notes）④ 历史成交 → opportunity 补列（won 态 + source='migration'，合同里没有的量留空不伪造）+ quotation 首版本核验（version=1 / effective_from←created_at）+ contract.quote_version_id 挂最新版本
- **dryRun 试跑（真实库副本，只读）**：`npx tsx scripts/migration/dry-run-all.ts [--json <path>]`——源库复制到 /tmp 临时目录（等价 WEFLOW_USER_DATA_PATH 隔离意图），initialize 走应用链路（对副本执行幂等 DDL 无害），统计查询全部只读。实测：① 4,680（tag 分布 秒变1513/李林辉1355/杨青981/静候653/未分配178——与 §2.39 入库记录**完全吻合**；leadScan:* 游标已清=0，priv:* 168 不动）② 205 → wouldApply 186（手机号锚 11 / wxid 锚 175；失败 19）③ 4,680 行全唯一、命中 account 锚 9 条 / 资源池 NULL 4,671 条、冲突 0 ④ 签约/发货合同 **0 张**、quotation **0 行**（无可迁成交，诚实结果非 bug）——总计 wouldApply 9,368 / failed 19 / conflicts 0
- **D5 = `docs/API-CONTRACT.md`（9/2 拍板收缩版）**：四层深度——IPC 层**端点级完整**（现有 113 通道 crm:71 + sales:42，全部从 preload.ts / crmIpcHandlers.ts / main.ts 实码梳理，含每端点请求/响应/错误现状 + 幂等等级 R·U·S·N；Phase 0/1 新增 9 端点规范：`crm:assignment:assign/claim/recycle/transfer/list` + `crm:identity:bind` + `crm:customer:mergeProposal` + `crm:audit:query` + `crm:ownership:history`，统一信封 `{ok,data}` + 错误码 E1xx-E5xx，分配/归属类动作**同事务写 assignment + ownership_history + audit_event** 为强制项）；本机 HTTP 只读层摘要（15 端点，详情指向 HTTP-API.md）；**NAS / MCP 两层只写占位规范**（认证/版本/幂等/错误码约定 + 空表头，端点级契约 Phase 3a / Phase 2 再补）；另附已下线通道防复活清单（`crm:lead:scanGroup` / `crm:lead:reassign`）
- **文档真实性裁决**：用户口述「API-TRACT.md」按启动细化 §二-D5 权威（「落为 docs/API-CONTRACT.md，9/2 拍板收缩版」）定名；PRD 迁移映射表实为 §9（§11 是 ADR-001），按内容为准
- **验证**：`npx tsc --noEmit` **0 错误**；node 侧 158 条 = 基线**零新增**；dryRun 全链路只读试跑通过，`--json` 可落盘四模块报告；未触碰任何现有 service 实现代码（红线）

---

## 2.44 UI 美化第二波：全局组件 + 高频页 37 文件 token 迁移（2026-09-02~03，工作区未提交）

> 承接 §2.41（七页）与 DESIGN-SPEC-MINI 波次规划；范围经用户拍板 = 「全局组件 + 高频页」，三大巨石（ChatPage 6859 行 / SettingsPage 3835 / SnsPage 3016）与 Export 模块、年报/双报独立窗口**留到下一波**。本轮五批并行（A 全局组件 / B 今日行动+卡片 / C AI·知识+人脉 / D 分析+系统页 / E 低频展示页），全部只动 SCSS（唯一例外见下 AIActionCard.tsx 两处 CSS 变量值）。

- **批次 A · W2 Chrome 全局组件 11 个**：ConfirmDialog / DateRangePicker / UpdateDialog / UpdateProgressCapsule / JumpToDateDialog / JumpToDatePopover / VoiceTranscribeDialog / WindowCloseDialog / NotificationToast / LockScreen / TitleBar。弹层统一 `overlay + blur(3px) + shadow-pop + radius-card`，入场动效全部带 `prefers-reduced-motion` 关闭。**LockScreen 视觉修复**：`--bg-total/--bg-input/--primary-color` 系从未定义的死变量（border/focus 环/按钮底此前全部静默失效），换真 token 后首次生效
- **批次 B · 今日行动 + sales 卡片 8 个**：TodayActionPage（删整块 `--wf-*` 私有 23 变量色板 + 43 hex）/ AIActionCard / TodoSidebar / SalesContextStrip / CustomerCard / CustomerPicker / ReplySuggestion / ExtractScriptDialog（83 hex 全项目最重，紫色系收编 accent 族）。统计卡语言对齐（白卡浮起 + 26px/700 tabular-nums）、pill 五语义、分段控件惯例。**唯一 TSX 改动**：`AIActionCard.tsx` 2 处（ring-gauge 轨道/三档配色的 `var(--wf-*…)` 引用，SCSS 色板已删不改会退化成 light-only 字面色），纯 CSS 变量值替换
- **批次 C · AI·知识与人脉 6 个**：InsightInbox（旧青绿品牌色 `rgba(91,147,144,*)` 收编 accent）/ KnowledgeBase（紫色渐变按钮收编）/ Contacts / Home（**金色系品牌变量改走 accent 派生——默认主题下首页视觉由金转蓝，红线 3 的必然结果**）/ SalesDashboard / ChatAnalyticsHub
- **批次 D · 分析与系统页 9 个**：Backup / Analytics（奖牌金银铜无语义 token，→warning/chart-neutral/color-mix 近似）/ Agreement / CrmProduct（20 行 21 hex）/ ChatHistory / ChatAnalysisHeader / Avatar / ImagePreview（深色看图器 scrim 保留，双模式固定深色属有意设计）/ ReportComponents（**`--ar-*` 死 token 收敛**——全仓无定义）
- **批次 E · 低频展示页 3 个**：Resources / MyFootprint / WelcomePage（删 9 处手动 dark 覆盖块改由 token 层自动覆盖）
- **全局层顺手修（本人执行）**：main.scss 删死变量 `--gold-*/--glow-color/--brand-text/--desc-text`（批次 C 后全仓零引用）；补定义 `--font-mono`（SettingsPage 3 处引用此前悬挂）；WelcomePage 补 `@keyframes slideUp`（`.brute-force-progress` 引用但全仓无定义，动画此前静默失效）
- **验证**：`npx vite build` exit=0；tsc root **0** / node **158**=基线零新增；37 文件 grep 自查 0 旧族 `var(--bg-*/--text-*)`、0 非白 hex（残留命中全是注释文字与彩色面字面白豁免）
- **遗留（下波或全局层）**：① TSX 内联阶段色板仍是字面 hex（`AIActionCard.tsx` STAGE_COLORS / `SalesContextStrip.tsx` STAGE_INFO / `CustomerCard.tsx` / `TodayActionPage.tsx` STAGE_COLORS）——多色相语义色非品牌色，是否收 `shared/funnelPalette.ts` 待裁决；② fadeIn/slideUp keyframes 多文件重复定义（值相同无冲突，冗余）；③ `.crm-btn`/`.crm-header`/`.crm-notice` 在 CrmWorkbenchPage.scss 与 CrmProductPage.scss 双份全局定义（历史遗留，lazy 加载后载者覆盖，有串扰风险）；④ 视觉验收（light/dark 截图比对）未做
- **2026-09-03 双漏斗格式统一（用户实测后拍板）**：行动漏斗「曝光 N/A」卡从 KPI 网格外孤儿位收进网格（第 6 卡同格）；两页统计卡统一为设计稿统计卡语言（白卡浮起 surface+shadow-card+radius-card、标签在上、26px/700 tabular、网格同规则 minmax(160px,1fr)）；行动漏斗 h2 补 700 字重、刷新按钮补 hover、空态色对齐、漏斗容器卡限宽 860 居中与销售漏斗同规格；销售漏斗统计卡 DOM 改标签在上（纯视觉）。funnel-test 40/40 + tsc 0
- **下波候选**：ChatPage / SettingsPage / SnsPage 三巨石 + Export 模块 6 文件 + Sns/ 子组件
- **2026-09-03 A048 立体圆柱漏斗（用户参考图拍板）**：两页漏斗图统一换成 `src/components/FunnelCylinder.tsx`（+`.scss`）——每段 = SVG 圆柱（viewBox 0 0 100 44，柱身 path + 顶面 ellipse 白色 0.3 高光）+ HTML 文字层（段名 12px + 主数字 24px/700 字面白豁免）；段间 ChevronDown + 转化率标注；宽度数组纯装饰不绑数值（沿用决策 14 精神）；色板仍取 `shared/funnelPalette` 单一真源（FUNNEL_STAGE_COLORS / FUNNEL_STAGE_GRADIENT_LIGHT）。行动漏斗 widths=[100,76,56,40,28]、gapText=`转化 x.x%`/N/A、点击段开 drill；销售漏斗删 ECharts 漏斗 option/events 改圆柱（widths=[100,85,70,55]、countText=`N 人`、colorIndex 走 SALES_STAGE_COLOR_INDEX、点击段 navigate 客户列表下钻保留），趋势图/当前状态卡仍用 ECharts 不动。验证：tsc root 0 / node 158=基线、vite build 0 error、funnel-test 40/40。**用户目视验收通过，三巨石页美化用户拍板不做（现状可接受），UI 线收工**
- **2026-09-03 三笔提交存档**：`c4e626c` docs（宪法/契约/评测指引/归档整理）、`86b3ece` Phase 0 工程（D3/D4/D7/群扫下线/分库）、`fde3dad` UI 美化全线。工作区仅余不入库物：eval pack jsonl（PIPL）与 reports/（诊断留档）

## 2.45 Phase 0 收尾：D7 标注启动 + D8 评审包（2026-09-03）

- **D7 现状盘点**：`opportunity-eval.ts export` 复跑确认——候选① intent_tag_log 全库仅 1 条带 message_key 锚点（阶段非商机档，0 入选，属数据现状非脚本 bug）；候选② quote_signal 46 条；候选③ 对照样本 30 条（对照池 203 会话）；合计 76 行已出包 `opportunity-eval-pack-20260902.jsonl`（不入 git，PIPL）
- **AI 预标注**：原排期用 GLM 预填 ai_label，GLM 额度耗尽后改由 Kimi 子代理执行——逐行拉锚点消息前后文 → 填 `ai_label`/`ai_evidence_keys` → 输出 `*.ai.jsonl`（不覆盖原包、不动人工字段、live 库零写）。人工标注仍按评测集标注指引走「先自判再对照 AI」防锚定
- **D8 评审包落稿**：`docs/支撑材料/Phase0-D8-评审包.md`——决策清单（术语口径 / Identity 归并 / Stage 矩阵 🔶 格 / owner_sales 三处口径 / 决策 B 存量处置 / AI 三档边界 / PIPL 证据规范）+ 附件 A 术语表 + 附件 B 对象契约一页表；每条带通俗解释与签字栏，30 分钟可过。**9/3 经 GLM 评审修订一轮**：措辞三修（裁决 4 与 A 档分界=转客户那一刻 / 裁决 6 审计为系统自动写入+Hermes 固定模板推送措辞 / 裁决 7 云推理脱敏上云、原文不出本机=未脱敏原文）+ 新增裁决 8（AI 读边界：默认本账号 scope，跨账号仅最小身份字段）+ 裁决 3 补流失判定带证据规则 + 宪法 §2.2 补 PIPL 删除通道；现行 8 条，主管口头同意、约定试运行一周后复核，签字后宪法 §2.5 🔶 格生效
- **D7 缺口提示**：目标 ≥100 条，现包 76 条，且 intent_tag_log 证据锚点稀缺（打标链路 message_key 覆盖率低）——Phase 1 打标链路若不加锚点回填，评测集只能靠 quote_signal + 对照样本撑量
- **D7 AI 预标注完成（Kimi 子代理，复用 evidenceKey+wcdbCore 链路，全程只读）**：76 行全部拉到上下文、零失败 → `opportunity-eval-pack-20260902.ai.jsonl`（ai_label 分布 has 33 / none 16 / uncertain 27；对照样本 6 条实为 has 正是对照组价值；quote_signal 误报确认 2 条典型：手机号/物流单号误识别为金额）。另出 `*.for-review.jsonl`（ai_* 清空，防锚定，主管标注用）。**误报跟进（9/3）**：拿 case46/35 原文实测现行 `parseQuoteSignal` 均正确拒识（手机号拦截 + 1 亿上限在旧行写入后才加，脏行是历史遗留，留库作评测证据）；两条原文已锁进 crm-golden（45→47/47）。对照样本 6 条漏报 = 规则只认销售侧报价消息（客户询价无销售报价不回不触发，设计使然），召回补强项 = Phase 2 AI 商机识别，评测集即其验收尺。三坑记录：① 原生库须用项目 Electron 二进制跑且 `env -u ELECTRON_RUN_AS_NODE`；② decryptKey 是 safeStorage 密文且须 `app.setName('weflow')`；③ wcdbCore 退出时原生 shutdown SIGSEGV 无害

## 2.46 决策B存量处置：群扫线索首触 SLA 存量重置（2026-09-03 用户拍板「存量重置」）

> 用户实测发现：线索池「超时未首触」4,000+ 条。根因 = 群扫导入日即起计 `first_contact_deadline`（`crmLeadService.ts` 导入路径），4,680 条存量从未分配也无人该首触 → 全超时；连带 salesDb 堆积 **5,551 张 pending sla_lead 卡**（其中 872 张孤儿卡，source_id 指向已不存在的 lead——历史重复建卡前科），今日行动被刷屏（行动卡执行率 0.6% 主因）。

- **修复**：`crmLeadService.resetLegacyGroupScanSla()`（挂 main.ts 启动链路，startActionEngineScheduler 之前）——① 群扫 NEW 线索 deadline 置 `LEAD_SLA_UNASSIGNED_SENTINEL`（`shared/leadSla.ts`，2100-01-01；**NOT NULL 列不能置 NULL，哨兵=待分配不起计时**；Phase 1 分配上线后 SLA 从 assignment 起算，分配动作覆盖本列）；② pending sla_lead 卡批量 skipped 关单（重置线索的卡 + 孤儿卡）；③ 写 `audit_event`（action=`lead_sla_stock_reset`，宪法 §1.12 新审计写点首用）。天然幂等（二次命中 0 行）
- **UI**：线索列表首触期限列对哨兵值渲染「待分配」（`CrmLeadPage.tsx`）；「检查超时」按钮/统计卡口径不变（哨兵自然不再命中 `deadline < now`）
- **「销售只能看到自己的线索」属 Phase 1 未建功能**（依赖 assignment 分配引擎 + 1.2a 身份档案），当前线索页为资源池/分配员视角——已在 D8 评审包口径内
- **验证**：`scripts/lead-sla-reset-test.ts` 真实库副本 13/13（清零/关单/幂等/审计/非群扫零影响/新导入不受影响）；回归 crm-lead 55/55、payments-claim 18/18；tsc root 0 / node 158=基线。⚠️ shared/*.js/.d.ts 为 composite 构建产物（gitignore），新增 shared/leadSla.ts 后需 `npx tsc -b tsconfig.node.json` 出产物，否则 root tsc 报 TS6305
- **⚠️ 大坑（9/3 实锤）：electron/services/*.js 同目录编译产物会影子覆盖 .ts 源码**——vite 解析 `.js` 优先于 `.ts`，`tsc -b` 在源码旁就地 emit 的陈旧 .js 会让 dev/打包跑旧逻辑（本次孤儿卡逻辑在 tsx 测试过但 App 首跑静默缺失，872 张卡残留才暴露）。**改完 electron/ 或 shared/ 的 .ts 必须重跑 `npx tsc -b tsconfig.node.json` 再启动/打包**。善后：`resetLegacyGroupScanSla` 卡关单不再随 resetIds 空短路（孤儿卡每次启动都扫），二次启动日志「SLA 孤儿卡清扫：872 张」，live 终态：超时 NEW=0、pending sla_lead=0、pending 总卡 246（有效卡不再被淹没）

## 2.47 决策B存量处置（续）：群扫 tag 归属残留清理（2026-09-03 用户当面拍板执行）

> 承接 §2.46。群扫时代 `lead.tag` 列被当作「归属销售」用（秒变/李林辉/杨青/静候/未分配），群扫下线后归属改由 assignment 承载（宪法 §1.3：分配状态不放 lead）——但 4,680 条存量 tag 残留，线索页「标签 chips」与新「归属 chips」同名打架（杨青 tag 981 vs 归属 0），用户验收时混淆。

- **修复**：`crmLeadService.cleanupLegacyGroupScanTags()`（挂 main.ts 启动链路，紧随 resetLegacyGroupScanSla）——遍历 `source='群资源扫描' AND tag非空`：tag='未分配' 直接清空不留痕；其余挪 note 留痕（`曾归属:{tag}（YYYY-MM-DD）`，note 已含同值则只清 tag 不重复追加）；同事务 UPDATE + `audit_event`（action=`lead_tag_owner_cleanup`）。天然幂等（二次命中 0 行）
- **验证**：`scripts/lead-tag-cleanup-test.ts` 真实库副本 13/13（清空计数 / 留痕格式 / 「未分配」不留痕 / 幂等 / 已留痕不重复追加 / 非群扫零影响）；回归 crm-lead 55/55；tsc root 0 / node 158=基线
- **生效方式**：下次 App 启动自动执行（与 §2.46 同款启动迁移模式），live 库届时 4,680 条 tag 清空、4,502 条 note 留痕（178 条「未分配」不留痕）
- **✅ 已生效（9/3 重启实测）**：live 终态 tag 残留 0 / note 留痕 4,502 / 审计 1 条

## 2.48 决策B存量处置（再续）：旧 tag 归属恢复为正式分配（2026-09-03 用户拍板「恢复成正式分配」）

> 承接 §2.47。tag 清完后归属筛选全是「未分配」，用户需要看到「这几千条原来是谁的」。拍板：旧归属恢复为正式分配（assignment）。外号映射用户当面确认：**秒变=许丽娟**；**静候=丁帅，已离职**，不挂名留资源池。

- **修复**：`crmAssignmentService.restoreLegacyGroupScanAssignments()`（挂 main.ts 启动链路，紧随 tag 清理）——扫 `source='群资源扫描' AND note LIKE '%曾归属:%'`，按映射分组后复用 `assignLeads`（自带 E201 幂等：已有有效分配跳过；assignment + ownership_history + audit_event 单事务）。映射：杨青→杨青、李林辉→李林辉、秒变→许丽娟；静候/未分配/未知旧值 → 留资源池
- **⚠️ 关键坑：note 含多个历史「曾归属」标记**——群扫时代多次换归属，note 里形如 `群扫描归属:秒变（2026-08-27）…；曾归属:秒变（2026-02-27）；曾归属:李林辉（2026-09-03）`，字符串顺序即时间顺序。**必须取最后一个标记**（= tag 清理时的最终归属）；首版取第一个导致归属错挂，副本测试抽查段当场抓获
- **验证**：`scripts/lead-assignment-restore-test.ts` 真实库副本 13/13（按最后标记分组对账 / 外号映射 / ownership_history+audit_event 逐条留痕 / 幂等 / 静候·未分配零分配）；回归 crm-lead 55/55、assignment 28/28；tsc root 0 / node 158=基线
- **✅ 已生效（9/3 重启实测）**：live 终态有效分配 许丽娟 1,511 / 李林辉 1,356 / 杨青 981 = 3,848 条，资源池 832 条（静候 654 + 未分配 178）；审计 `lead_assign` 3,848 条。⚠️ 恢复分配的 `sla1_deadline` 留 NULL（首触 SLA 不起计时，同 §2.46 遗留，Phase 1 分配引擎再补）

## 2.49 Phase 1 W3 自动备份：双保险定时备份（2026-09-03，PRD 1.1 当周硬交付）

> 与既有 `backupService.ts`（手动整包导出：WCDB 快照 + tar）无关——本节是新的轻量定时备份，只备两个业务 db（crm/sales），用户拍板「双保险」：本机兜底目录始终执行 + 网络共享目录（办公室另一台 macOS 的 SMB 挂载）可达时同步一份。

- **分层**：`electron/services/autoBackupCore.ts` 纯核心（零 electron，可 tsx 单测；只依赖 businessDbPath）+ `autoBackupService.ts` 装配层（依赖注入 config/userData/appVersion，自身不 import electron）+ `autoBackupIpcHandlers.ts`（注册约定同 evalIpcHandlers）
- **产出**：每层 `we-flow-auto-YYYYMMDD-HHmm/` 目录 = 两 db 副本 + `manifest.json`（app 版本 / ISO 时间 / 各 db 文件大小 / 两层各自状态 / 耗时 / trigger）。本机层根 = `userData/backups/auto/`；网络层根 = config `autoBackupNetworkPath`
- **网络层不可达是正常情况**（对方电脑下班关机）：路径不存在/非目录 → manifest 记 `network: 'skipped_unreachable'` 跳过，整体 ok 只看本机层，不报错不惊扰；空配置记 `skipped_not_configured`
- **保留策略**：每层滚动留最近 20 份（`AUTO_BACKUP_KEEP`），超出删最旧（目录名字典序=时间序）；网络层仅本次可达时清理
- **调度**（`startAutoBackupScheduler`，挂 main.ts 启动链路 SLA 存量处置之后、startActionEngineScheduler 之前）：config `autoBackupTime`（默认 `14:37`，非法值回退）每日到点跑（5min tick：`now >= 今日计划时刻 && 上次成功 < 今日计划时刻`）；**启动补跑**：延迟 10s 检查，距上次成功 >20h 且当前在工作时段（8:00-19:00）→ 立即补跑一次（防周末/关机错过）；`running` 标志防重入；上次成功时间从本机层最新 manifest 推导（不落额外状态）
- **sql.js 落盘铁律**：crm/sales 是内存库 500ms 防抖落盘——`executeAutoBackup` 备份前调 `crmDbService.persistNow()` + `salesDbService.flushNow()` 强制刷盘，否则可能备出防抖窗口前的旧文件（测试组②哨兵行专项验证：写入后 <500ms 立即备份，恢复件必须含该行）。⚠️ 实测发现 live 的 sales db 文件曾为 0 字节（内存库未落盘的实锤），本机制的强制刷盘正是对策
- **审计**：每次备份（成功/失败都写）`audit_event`（actor=`system:auto-backup`，action=`auto_backup`，detail 含两层状态/文件大小/耗时/清理数/error）
- **串行化**：`enqueueSalesTask` 只加最外层——调度 tick / 启动补跑 / IPC runNow 三入口共用 `runGuarded`，`executeAutoBackup` 内部不再 enqueue
- **IPC 三处配齐**：`backup:auto:runNow` / `backup:auto:status`（上次时间 + 两层状态 + 下次计划）；preload `backup.autoRunNow/autoStatus`；electron.d.ts `AutoBackupStatus` 类型。config 两层新键：`autoBackupNetworkPath`（默认 ''）/ `autoBackupTime`（默认 '14:37'）
- **设置页**：数据库 tab 底部「自动备份」区块——网络备份路径输入框（onBlur 保存）+ 上次备份状态（时间/两层状态/下次计划/保留 20 份说明）+ 「立即备份」按钮（行内 spinner + 结果 toast）
- **验证**：`scripts/auto-backup-test.ts` 副本隔离 **32/32**（①产出完整含 manifest 字段/审计 ②恢复演练删库→恢复→行数对账含哨兵行 ③21 份→留 20 最旧被删（小尺寸假库独立 userData）④不可达 skipped_unreachable 不报错 + 空配置 skipped_not_configured ⑤同分钟重跑同目录覆盖幂等 + 审计逐次留痕）；回归 crm-lead 55/55；tsc root 0 / node 158=基线；vite build ✓；`tsc -b tsconfig.node.json` 产物已重建（§2.46 大坑铁律）

## 2.50 本地身份档案（2026-09-04，PRD §1.2a，分配前置）

> 姓名 + 角色（销售/主管/分配员）存本地配置，**与现有应用锁完全独立**。用途：`audit_event` / `ownership_history` 的 actor 署名、分配服务认领身份、审批确认显示操作人。⚠️ **角色仅作署名，绝不作访问控制/数据过滤依据**（宪法 §1.12 明文）——全链路无任何权限判断。

- **config 三键**（electron schema + 默认值，已随 127940a 入库）：`identityName`('') / `identityRole`(''，合法值仅 销售/主管/分配员） / `identityOnboardingDismissed`(false)
- **薄服务 `identityService.ts`**（零 electron 之外依赖，只读 config）：`getIdentity()`（姓名空=未建档返回 null）/ `getActorLabel()`（「姓名（角色）」，角色未选只写姓名，未建档返回 null 由调用方兜底）/ `setIdentity`（角色非法归一空；建档成功自动置 dismissed）/ `shouldPromptOnboarding` / `dismissOnboarding`（幂等）。**未来所有 audit/ownership 写点统一从 `getActorLabel()` 取署名**
- **actor 兜底链改造**（`crmAssignmentService.assignLeads`）：显式 actor > 身份档案「姓名（角色）」> 未建档兜底「分配员」；`system:migration` 等显式值不受影响（`||` 短路，测试态不实例化 config）
- **首次启动引导**：`IdentityOnboardingDialog.tsx`（ConfirmDialog 同款 LiquidGlass 弹窗样式）——App.tsx 在**应用锁检查完成且未锁定后**才判断（新增 `lockChecked` 状态），不挡应用锁、不卡启动；每次启动最多弹一次（ref 守卫），「稍后再填」落 `identityOnboardingDismissed` 不再反复弹
- **设置页区块**：数据库 tab 底部「自动备份」之后新增「身份档案」——姓名输入 + 角色 custom-select（暂不选择/销售/主管/分配员）+ 保存按钮 + 当前署名预览行。**⚠️ 该区块的 UI 形态已于 2026-09-13 卡片化重做（自绘下拉 → 分段选择器、署名预览行 → 卡片内身份可视化），见 §2.100**；数据键、保存时机与取值枚举未变
- **IPC 三处配齐**：`identity:get`（profile + actorLabel + shouldPromptOnboarding）/ `identity:set`（姓名必填 E101）/ `identity:onboarding:dismiss`——新 `identityIpcHandlers.ts`（注册在 main.ts config:set 旁，**不** enqueueSalesTask：只写配置不碰 salesDb）；preload `identity.{get,set,dismissOnboarding}`；electron.d.ts 同步
- **验证**：`scripts/identity-test.ts`（WEFLOW_USER_DATA_PATH/WEFLOW_CONFIG_CWD 落盘隔离 + fresh crmDb，**25/25**：config 读写 / 署名三格式 / 角色归一含脏数据 / 分配兜底链四级 + ownership_history 同步署名 / 跳过幂等 + 建档自动 dismiss）；回归 crm-lead 55/55 + assignment 28/28；tsc root 0 / node 158=基线零新增；vite build ✓；`tsc -b tsconfig.node.json` 产物已重建

## 2.51 Phase 1 存量迁移执行器：02 account→customer + 03 lead→customer_identity（2026-09-04，副本验证完，live 待重启生效）

> D4 骨架（§2.43「只写不跑」）的执行器落地。⛔ **本刀未在 live 库执行**——sql.js 内存库铁律，live 生效 = 应用下次启动时 main.ts 启动链路自动跑（前置条件见末行）。模块①（决策B 群扫清理）Phase 0 已以别的形式 live 执行完，不在此；模块④ 历史成交真实库 0 合同 0 报价，只做核验不建执行器。

- **新服务 `crmMigrationService.ts`**（零 electron 依赖，`crmDbService` 唯一依赖）：`migrate02AccountToCustomer()` / `migrate03LeadToIdentity()` / 入口 `runStockDataMigration()`（②先于③，锚点就位后归并）。归一化三函数 `normalizePhone`/`normalizeWxid`/`accountAnchor` 提升为本服务导出 = **预演/执行口径唯一真源**（dry-run 骨架 02/03 改为从这里导入，防漂移）
- **幂等双保险**：① scan_state 一次性标记 `migration:02-account-to-customer` / `migration:03-lead-to-identity`（与数据**同事务**写入）；② 数据级判重（account.customer_id 已挂 / (identity_type, identity_value) 已存在即 alreadyDone 跳过）——标记丢失重跑也零业务数据副作用（测试 A5 删标记重入实证）
- **同事务 + 审计**：每模块 `runTx` 单事务（建 customer + 登记 identity + 挂接 account + audit_event + 标记），审计 actor='system:migration'（沿 crmAssignmentService 先例）、action=`migration_02/03_*`、detail=报告摘要 JSON（总数/实绩/新建/幂等/失败/冲突 + 逐条清单，上限 200 条截断标记）
- **冲突不静默**：无锚 account / 多名归并组 / 多归属组 / 跨客户身份冲突 → 进报告清单**不动数据**，合并处置留人工审批（宪法 §2.4）。02 既有 NULL identity 命中锚点 → 后补挂接（§2.4 合法态消解路径）
- **有意不做（偏离记录）**：① owner_sales 全空的 account **不回写「归销售本人」**——归属变更是 C 档人工动作（宪法 §1.7）且 live 188 个 anchored account owner 全空属历史现状，只在 dryRun notes 计数，补登走分配/认领流程或人工；② salesDb 侧 customer_profile.customer_id 对齐不在这刀（独立后续步骤，先 crmDb 后 salesDb 铁律）
- **main.ts 挂载**：紧随群扫旧归属恢复块之后、自动备份启动之前，独立 try/catch 不惊扰启动
- **验证 `scripts/migration-live-test.ts`（46/46）**：Part A fresh 库构造 10 account + 8 lead（干净锚/无锚/多名/多归属/已挂接/NULL identity 后补/同 wxid 归并/非法身份）全断言；Part B **live 库 /tmp 副本全量**——先 dryRun 取预测再执行对账：customer **188**（手机号锚 13 / wxid 175）/ account 挂接 **188** / identity **4857**（挂 customer 188 + 资源池 NULL 4669）/ 03 幂等命中 **11**（=02 已登记锚 ∩ lead 身份键）/ 失败 **19**（无锚公司名 account 218-234·242·256，逐条列清单未动数据）/ 冲突 0；实绩与 dryRun 预测逐项相等；重跑零副作用
- **dryRun 复核**：`dry-run-all.ts` 数字与执行器口径一致（02 wouldApply 188/failed 19；03 wouldApply 4680/命中锚 11/NULL 4669）；基线 tsc root 0 / node 158 零新增；回归 crm-lead 55/55 + assignment 28/28 + identity 25/25；`tsc -b tsconfig.node.json` 产物已重建（.js 全部 gitignore 不入库）
- **live 执行前置条件（用户操作）**：① 先手动触发一次自动备份并确认成功（autoBackupService，§2.49）；② 重启应用，启动链路自动执行并打 `[Sales] 存量迁移②/③完成` 日志；③ 失败/冲突清单查 audit_event（action LIKE 'migration_%'）detail
- **⚠️ 2026-09-04 后续注记（live 已真实执行）**：用户重启应用后 live 库已由启动链路真实跑完 02/03——副本探针实证：markers 置位 / customer 188 / 挂接 188 / identity 4857（NULL 4669）/ 19 无锚未动 / 审计 2 行，与本节预测逐项一致。`migration-live-test.ts` Part B 同步改为**「已迁移副本幂等重跑」口径**（B0 已迁移事实核验 + B1 标记命中零副作用 + B2 dryRun 已迁移口径 alreadyDone 全量 + B3 删标记数据级幂等兜底，真实数据零写入），现 **44/44**；「预迁移副本全量首迁」口径永久失效，勿再恢复

## 2.52 ⛔ 重大事故档案：sql.js 落盘截断窗口致 sales 库两次全灭 + 根因修复（2026-09-04）

> **事故时间线（实证）**：① 9/3 12:06–20:23 之间 live sales 库被清空（3.9MB → 106KB 空壳；9/3 20:38 的自动备份只来得及备到空壳——备份机制本身无错，备的是已损坏的源）；② 9/4 09:56 kill 进程再次把 sales 库截成 0 字节。crm 库暴露在同一风险下。live sales 库已由人工用 9/3 12:06 的 /tmp 副本恢复（4,005,888 字节）。
>
> **根因链**：sql.js 是内存库，旧 persist 用 `writeFileSync` 直写目标文件 = **先截断为 0 再整体写入**；此窗口期被 kill/崩溃 → 磁盘文件 0 字节 → 下次启动 `new SQL.Database(0字节buffer)` 静默初始化空库 → 后续 persist 把空库写回 → 数据全灭且无人察觉。**两个缺陷叠加：落盘非原子 + 启动无守卫。**

- **修复① 原子落盘**：新共用模块 `electron/services/atomicPersist.ts`（零 electron 依赖，可 tsx 单测）。`atomicWriteFileSync(target, data)` = 写 `目标.tmp-<pid>` → fsync → `renameSync` 原子替换（POSIX rename 原子性；tmp 与目标同目录保证同文件系统）；任何时刻目标文件要么旧版完整要么新版完整，绝无 0 字节/半截中间态；失败清理 tmp 残留并抛错（调用方既有 try/catch 打日志不变）。**全部 .db 落盘点已收口（5 处）**：`salesDbService.persist`（500ms 防抖）/ `salesDbService.persistNow`（flushNow 入口）/ `crmDbService.persist` / `crmDbService.persistNow` / `crmDbService.exportSnapshot`（删除前快照）。autoBackupCore 的 copyFileSync（live→备份目录副本）不动（边界），其半截副本风险由守卫的 manifest size 校验兜底
- **修复② 启动守卫** `loadBusinessDbWithGuard(SQL, dbPath, userData, label, log)`：替换两服务 doInitialize 的裸 `new SQL.Database(readFileSync(...))`。文件存在但 **0 字节或打开/解析失败 → ⛔ 禁止静默初始化空库**，处置链：坏文件改名 `<原名>.corrupt-<yyyyMMdd-HHmmss>` 留证（同名已存在追加毫秒后缀，**留证绝不覆盖**）→ 从最新 `backups/auto/we-flow-auto-*` 快照恢复同名文件（**manifest.json 校验**：不可解析/无条目/登记 size ≠ 实际 size 的备份跳过，回退更早快照）→ 恢复件必须能被 sql.js 实际打开才算数（**坑：sql.js 构造器对坏文件惰性不抛，`new Database` 成功但首条语句才报 `file is not a database`——守卫内 `openVerified` 实跑 `SELECT count(*) FROM sqlite_master` 探活**）→ 全部无可用备份才允许空库启动，且打 **ERROR 日志「从空库启动，原文件已损坏」**。日志桥：service 层注入 `dbGuardLog` = salesLog 落盘 + console
- **审计**：crmDb 恢复成功（outcome='restored'）在 SCHEMA 就位后补写 `audit_event`（actor=`system:persist-guard`，action=`db_recover`，detail 含 corruptPath/restoredFrom）。**有意偏离**：salesDb 无 audit_event 表，恢复只打 WARN/ERROR 日志不落审计（审计表是 crmDb 的 Phase 0 产物）
- **outcome 四态**：`existing`（健康加载）/ `fresh`（文件本不存在，新装正常空库）/ `restored`（恢复）/ `fresh-corrupt`（无备份空库启动）
- **验证**：`scripts/persist-guard-test.ts`（/tmp 隔离 + WEFLOW_WORKER=1，**36/36**）——原子写内容/无 tmp 残留/重复写幂等；service 端到端 flushNow 哨兵行对账；0 字节启动恢复（core 日志断言 + service 端到端数据读回）；无备份空库启动 + ERROR 日志断言；corrupt 文件恢复 + 留证不覆盖；manifest size 不符/缺失跳过回退更早快照；crmDb 恢复 audit_event 补写。回归 crm-lead 55/55 + identity 25/25 + migration-live 46/46 + auto-backup 32/32；tsc root 0 / node 158 零新增；`tsc -b tsconfig.node.json` 产物已重建（§2.46 大坑铁律）
- **顺带修复**：`auto-backup-test.ts` 审计断言查询补 `ORDER BY id DESC`——原查询无排序拿 audit1[0]，live 副本带入 9/3 历史 auto_backup 行后断言误伤（HEAD 上就 31/1，与本刀无关的环境性失败）
- **善后待做**：live 库当前目录可能存在历史 0 字节/空壳遗留与 `.corrupt-` 留证，重启应用后守卫自动处置并打日志；确认日志后可人工清理留证文件

## 2.53 线索分配 Phase 1 完整版：claim/recycle/transfer + SLA 起计时 + SLA1 回收器（2026-09-04，后端+IPC，无前端 UI）

> 接 §2.40/AGENTS 9-03「最小可用 assign+list」补齐契约五端点（API-CONTRACT §1.14 表 265-269 行）+ PRD 1.4 第一段 SLA「加了没有」机械计时闭环。**本刀只做后端+IPC，前端 UI（认领按钮/回收/移交入口）后续刀。**

- **claim**（`claimLead(leadId, actor)`）：assigned→claimed。E301 无分配行；E201 非 assigned 态（重复 claim 被状态机拒，契约 S）/ 非本人（actor 或身份档案姓名 ≠ sales_name；actor 空时按 `getIdentity().name` 判本人）。**不写 ownership_history**（归属没变），只写 assignment 状态（version+1/updated_by 署名）+ audit_event（action=`lead_claim`）
- **recycle**（`recycleAssignment(assignmentId, reason, actor)`）：有效行（assigned/claimed）→ recycled，lead 回资源池。E301 无行；E202 已回收；E201 已移交（当前分配在新行）。同事务四写：assignment 状态 + ownership_history（reason=回收类，new_owner=''）+ audit_event（`lead_recycle`）+ **lead.first_contact_deadline 重置回 2100 哨兵**（回资源池=待分配不起计时）；回池后可再 assign（重起计时）
- **transfer**（`transferAssignment(assignmentId, toSales, reason, actor)`）：旧行→transferred + 新建 assigned 行（source='transfer'，重起 SLA1）。E301 无行；E201 非有效态/目标=当前归属；E203 目标销售不在 config `crmSalesList`。同事务：双行 + ownership_history（reason=移交类）+ audit_event（`lead_transfer`）+ lead 期限跟随新 sla1。**离职移交批量=循环调本端点**（契约原文），不复活旧 reassign
- **assign 起计时**：`assignLeads` 写 `sla1_deadline = now + crmLeadSlaHours`（现有配置键，默认 24h）+ 同事务把 lead.first_contact_deadline 从哨兵覆盖为同一期限（scanLeadSla 现有机制不动继续工作）。⚠️ 这是「分配状态永不入 lead 表」的**唯一例外**——写的是首触 SLA 计时列不是分配状态；claim 后第二段 SLA（sla2）本刀不做（等 LLM 扫描，PRD 1.4）
- **SLA1 回收器**：`runSla1Recycle(now?)` 扫 status='assigned' 且 sla1_deadline 过期 → 逐条调 recycleAssignment（**reason='SLA超时回收'，actor='system:sla'**，A 档引擎动作审计/流水照写；逐条独立事务单条失败不阻塞）；**claimed 不动**（已认领进第二段归 LLM 扫描）。`startSlaRecycleScheduler()` 挂 main.ts（自动备份/行动引擎调度器旁，启动延迟 60s 首扫 + setInterval，幂等防重入，unref）；间隔 config 新键 **`crmSlaRecycleIntervalMin`**（分钟，5-1440，默认 30）
- **存量补写迁移块** `backfillAssignmentSla1()`：~~补写 = 分配时间（updated_at）+ crmLeadSlaHours~~ **⚠️ 此口径错误已在 §2.54 事故中引爆并修正为「执行时刻+24h」**；幂等（只补 NULL 行）；有实绩落一条汇总审计（actor='system:migration'，action='assignment_sla1_backfill'）
- **IPC 三处配齐**：`crm:assignment:claim/recycle/transfer`（crmIpcHandlers + preload `assignmentClaim/assignmentRecycle/assignmentTransfer` + electron.d.ts 三处同步，统一信封沿用）
- **验证**：`scripts/assignment-full-test.ts`（WEFLOW_WORKER 落盘隔离 + fresh crmDb，**55/55**：A 起计时 / B claim 状态机+身份档案署名挂钩 / C recycle 哨兵重置+回池再分配 / D transfer 双行+E203+流水 / E 回收器过期回收·未过期不动·claimed 不动·幂等 / F 补写幂等+汇总审计）；旧 `assignment-test.ts` 28/28 不回归（起计时对旧断言零影响）；基线 tsc root 0 / node 158 零新增；回归 crm-lead 55/55 + identity 25/25 + persist-guard 36/36 + auto-backup 32/32；`tsc -b tsconfig.node.json` 产物已重建（.js gitignore 不入库）
- **环境性失败记录**：migration-live-test 本刀跑出 38/8（HEAD 上同样 38/8，与本刀无关）——live 库已被重启后的应用执行过存量迁移 02/03（§2.51 的 live 生效已发生），副本内 scan_state 标记已置位 → 执行器 skippedByMarker，测试的「预迁移 live 副本」口径失效。该测试要恢复 46/46 需改为「已迁移 live 副本幂等重跑」口径（后续刀的事）

## 2.54 ⛔ 事故档案：SLA1 回收器首扫误回收 3,848 条存量分配 + 纠正性恢复（2026-09-04）

> **事故**：9/4 中午 live 首次启动，日志 `[CRM] SLA1 超时回收 3848 条（actor=system:sla）`——回收器首扫把全部 3,848 条存量分配（许丽娟 1511/李林辉 1356/杨青 981，9/3 由旧归属恢复而来）一次性置 recycled，lead.first_contact_deadline 全回 2100 哨兵。
> **根因**：`backfillAssignmentSla1` 初版口径「分配时刻（updated_at）+24h」——分配时刻是 9/3，到 9/4 中午补写完**立即全部过期**，60s 后回收器首扫全灭。**教训：任何给存量补截止时间的逻辑，基点必须是「补写执行时刻」，绝不能用过去的时间基点。**

- **命中核验（live /tmp 副本，动手前先查）**：`status='recycled' AND updated_by='system:sla'` 精确命中 3,848（分布与事故前一致；updated_at 全在 2026-09-04T03:28:22Z 一个 ~350ms 窗口 = 首扫单轮）；非误扫 recycled 夹杂 0 行；audit `lead_recycle` / ownership `SLA超时回收` 各 3,848 行对账吻合
- **backfill 语义修正**：补写值 = **执行时刻 + crmLeadSlaHours**（给存量全新首触窗口），注释写明事故教训；`assignment-full-test` F2b 加回归防线（补写值 ≠ 分配时刻+24h）
- **纠正性恢复 `correctSla1Misrecycle()`**（crmAssignmentService，一次性启动迁移块，挂 main.ts 紧随 backfill 之后、回收器启动之前）：
  - **方案 B：插入新 assigned 行**（source/updated_by='system:correction'，sla1=执行时刻+24h），**不改写回收行**——理由：① 回收行是误扫事实记录，保留使「分配→回收→纠正分配」链路可对账；② currentAssignment 取 id 最大有效行，新行自然成当前归属；③ 方案 A（recycled→assigned 回写）抹掉回收事实、version 语义混乱
  - ⛔ append-only 铁律：ownership_history/audit_event 历史行零删改；补偿流水 ownership reason='分配' actor='system:correction' + audit action='lead_assign' detail 含「SLA1误扫回收纠正」+ recycledAssignmentId 指回原行；另落一条汇总审计 action='sla1_misrecycle_correction'
  - lead.first_contact_deadline 同步恢复为新 sla1（非哨兵）
  - **幂等双保险**（沿 crmMigrationService）：scan_state 标记 `migration:sla1-misrecycle-correction`（同事务）+ 数据级判重（lead 已有有效分配即跳过）
- **验证**：`scripts/assignment-correction-test.ts`（live /tmp 副本实跑，**24/24**：命中 3,848 核验 / 分布恢复 / sla1 全在未来 24h 窗口 / lead 期限同步 / 流水审计只增 +3,848·+3,849 / 误扫行保持 recycled / 重跑标记跳过 / 标记丢失数据级兜底零补偿）；`assignment-full-test.ts` 扩 G 组 15 项（fresh 库构造误扫现场端到端）→ **71/71**
- **顺带修复**：`assignment-test.ts` 样本选择从「当前无有效分配」收紧为「从未有任何分配行」（live 存量 lead 事故后带历史行，旧口径命中历史行击穿计数断言；28/28 恢复）
- **基线**：tsc root 0 / node 158 零新增 / assignment 28/28 + assignment-full 71/71 + crm-lead 55/55 + identity 25/25 + migration-live 44/44（a33c8b9 已改已迁移口径）+ persist-guard 36/36 + auto-backup 32/32；产物已重建
- **live 生效方式**：下次应用启动时启动链路自动跑纠正块（日志 `[Sales] SLA1 误扫纠正完成：补偿再分配 3848/3848 条`）；本刀只在副本验证，未碰 live 库、未启动应用

---

## 2.55 线索池页 Phase 1 完整交互：认领闭环 + 调派/回收 + 销售视角（2026-09-04，前端 UI，接 §2.53 后端）

> §2.53 交付了 claim/recycle/transfer 后端+IPC 但无前端入口；本刀补齐线索池页（CrmLeadPage）全部交互，零后端改动、零新增 IPC。

- **纯判定层 `src/utils/leadAssignmentView.ts`**（零依赖，可单测）：`buildOwnerMap`（leadId → 当前有效分配行 {assignmentId, salesName, status}，按 id 取大防乱序）/ `isSalesView`（角色=销售 且 已建档；**空身份=管理视角看全部**）/ `canClaimLead`（已建档 + 归属销售=本人姓名 + assigned 态，与后端「本人」判定同口径）/ `canManageAssignment`（已归属 + 角色≠销售；空角色=管理视角可见）/ `filterLeadsForView` / `visibleOwnerChips`。⚠️ 注释写明：销售视角过滤是**展示层便利，不是安全边界**（宪法 §1.12：角色仅署名，门禁靠部署形态+应用锁）
- **认领闭环**：行操作区「认领」按钮（canClaimLead 可见）→ 弹窗确认 + 两个可选输入框「客户微信号」「客户昵称」→ 确认调 `crm:assignment:claim`（**actor 不传**，服务端按身份档案姓名判本人）→ 填了的微信号/昵称复用行内编辑资料的 `crm:lead:update` 写路径落 lead（只传非空字段，不覆盖已有值；**不写 customer_identity**——那是 1.4a 绑定的事）；成功后 fetchAll 刷新列表 + 归属 chips 计数
- **调派/回收**（分配员/主管用，行操作区，canManageAssignment 可见）：「调派」弹窗选新销售（名单排除当前归属人）+ 可选原因（默认「人工调派」）→ `crm:assignment:transfer`（旧行 transferred + 新行 assigned 重起 SLA1）；「回收」二次确认弹窗 → `crm:assignment:recycle`（reason='人工回收'，lead 回资源池，first_contact_deadline 回 2100 哨兵）
- **销售视角**（identityRole='销售' 且已建档）：列表只显示当前归属=本人姓名的线索；归属 chips 只留「我的」（未分配 chip 不渲染、列表不混入）；「分配给…」按钮同步隐藏（池子不可见，选中集恒空）；归属筛选逻辑让位（visibleLeads 已过滤）
- **空身份兜底**：未建档（identityName 空）→ isSalesView=false 看全部，canClaimLead=false 认领按钮不出现；调派/回收可见（管理视角）
- **身份读取**：fetchAll 增 `identity.get()`（§2.50 IPC），无新增 config 键/无 electron 改动
- **测试**：`scripts/lead-assignment-view-test.ts`（纯函数直测，**32/32**：归属映射/销售视角判定/认领可见性/调派回收可见性/视角过滤/chips 集合）；`npx tsc --noEmit` 0 错误 / `npx vite build` ✓ / 回归 crm-lead 55/55 + assignment 28/28 + assignment-full 71/71 + identity 25/25；electron/ 未动，无需 `tsc -b tsconfig.node.json`
- **有意偏离**：① 「分配给…」按钮对销售视角隐藏（需求只点名调派/回收，但池子对销售不可见时留着必 E201 空转，一并收掉）；② 认领弹窗两个输入框预填 lead 现有 wechat/name 值（与行内 ✏️ 编辑弹窗同习惯，改不改随用户）；③ 调派/回收/认领均不传 actor，统一走服务端身份档案兜底链（§2.50），前端不重复拼姓名

---

## 2.56 加好友判定双路（PRD 1.4a）：手动绑定微信 + 自动检测停 SLA1 表（2026-09-04）

> PRD 1.4a 双路全落地：① 手动——线索行「绑微信」弹窗搜本机联系人绑定；② 自动——30 分钟轮巡精确匹配。
> 任一命中即停 SLA1 表（第一段「加了没有」计时终止）+ lead→WX_ADDED + customer_identity 登记 + 审计。

- **停表方案（已拍板落法）**：assignment 幂等 ALTER 加 **`sla1_met_at INTEGER`**（NULL=计时中，命中写停表时刻），SCHEMA_SQL 同步收录。理由：① assignment.status 语义 = 分配生命周期（assigned/claimed/recycled/transferred，宪法 §1.3），不承载「加了没有」结果——状态推进会造第二套语义；② 停表时刻本身有业务价值（加好友耗时统计/审计对账）；③ 幂等天然（`UPDATE ... WHERE sla1_met_at IS NULL`）。回收器 `runSla1Recycle` 扫描加 `AND sla1_met_at IS NULL`——**已加好友的分配永不超时回收**；transfer 新行 sla1_met_at 随新行天然为 NULL（新归属人重新计时，若好友事实仍在，自动检测下轮会再停表，自愈）
- **新服务 `crmFriendDetectService.ts`**（零 electron 依赖，归一化函数从 crmMigrationService 导入 = 口径唯一真源）：
  - `bindLeadWxid(leadId, wxid, {actor?, source?, displayName?, matchField?})` —— 双路共用核心，契约端点 `crm:identity:bind` 实现（API-CONTRACT §1.14）。单事务四件套：① customer_identity（identity_type='wxid'，值=**contact.username 内部 id 改名不失效**，source=manual/auto，confidence=1.0）；② 该 lead 有效分配行停表；③ lead NEW/CONTACTED→WX_ADDED（DEAD/ACCOUNT 不动）+ wechat 空则回填 + lead_activity；④ audit_event `identity_bind`。**E101** wxid 空 / **E301** lead 不存在 / **E204** wxid 已挂他 customer（冲突不自动改挂，留合并提案人工审批，宪法 §2.4）。customer_id 按 §2.4 Identity Resolution：lead.account_id 挂接 > account 锚点（session_id=wxid / 手机号锚等值）；多候选冲突挂 NULL + audit detail 记 conflictNote；既有 NULL identity 后补关联（不新建行）。**幂等短路**：四件套均已落 → alreadyBound=true 直接返回，零写入零新审计
  - `runFriendDetectScan(contacts)` —— 自动路（保守版）：扫 assigned/claimed 且未停表的分配行，lead 的 wechat/手机号 × 联系人标识（username/alias）**精确等值**匹配，命中走 bindLeadWxid(source='auto', actor='system:friend-detect')。⚠️ 宁缺毋滥：remark/nickName 永不参与匹配（宪法 §2.4 昵称仅显示用）；群聊/公众号排除；**WCDB contact 表无可靠手机号字段，手机号命中仅当 username/alias 恰为同一 11 位号码**（仍是精确等值）；联系人注入式参数化（测试零 WCDB 依赖）
  - `startFriendDetectScheduler(fetchContacts)` —— main.ts 挂 startSlaRecycleScheduler 旁，延迟 90s 首扫 + 间隔轮巡（新 config 键 **`crmFriendDetectIntervalMin`** 分钟，5-1440，默认 30，与回收器同款）；生产 fetcher = `chatService.getContacts({lite:true})`（应用读取层，WCDB 只读，未连接/空 → 本轮零副作用）
- **前端（CrmLeadPage）**：行操作区「绑微信」按钮（`canBindWxid`：已归属 + 销售视角仅本人行/管理视角任意行；已停表行仍可见，再点走后端幂等短路提示）→ 弹窗：关键词搜本机联系人（`chat.getContacts({lite:true})` 只取 friend，备注/昵称/微信号模糊搜仅用于**选人**）→ 下拉展示 头像（getContactAvatar 惰性补齐）/备注/昵称/微信号 → 确认调 `crm:identity:bind`；**认领弹窗可选填的微信号接入同一链路**（claim 成功后 identityBind，E204 等失败回退 leadUpdate 仅落资料）；期限列已停表行显示「已加好友 ✓」；`buildOwnerMap` 携带 sla1MetAt
- **测试** `scripts/friend-detect-test.ts`（WEFLOW_WORKER 隔离 + fresh 库，**33/33**：A 四件套+署名 / B 幂等零重复写 / C E101/E301/E204 冲突零写入 / D 锚点挂接+后补关联 / E 自动检测命中·不误伤·昵称不匹配·claimed 同扫·DEAD 不复活·重扫幂等 / F 回收器尊重停表）
- **验证**：tsc root 0 错误 / node 158 条与基线逐条 diff 零新增 / vite build ✓ / 回归 crm-lead 55/55 + assignment 28/28 + assignment-full 71/71 + identity 25/25 + lead-assignment-view 32/32；`tsc -b tsconfig.node.json` 产物已重建
- **有意偏离**：① 自动路不做模糊猜（PRD 允许匹配手机号/wxid，但 WCDB 无可靠手机号字段，保守收窄为 username/alias 精确等值）；② 认领弹窗填的微信号视作销售人工断言直接绑定（source=manual，置信 1.0），失败回退纯资料保存不阻塞认领；③ actor 兜底链手动路 = 显式 > 身份档案 > 「销售」，自动路恒 `system:friend-detect`

---

## 2.57 两段接力 SLA 第二段「聊了没有」+ 客户类型 dealer/end_user（PRD §1.4/§1.5，2026-09-04）

> PRD 1.4 第二段原文：「弃用首触 SLA 计时器，改为 LLM 扫描对话判断跟进状态（是否已有效触达 / 是否需介入），低置信转人工」。落法与「加好友检测停 SLA1 表」（§2.56）同构：**扫描命中 → 写标记列 → 回收器尊重标记**，不在 assignment 里起第二套倒计时。

- **标记列 `assignment.sla2_scan_ref`**（D3 建表已含，live 副本 PRAGMA 核验已存在，无需 ALTER）：JSON 串 `{verdict, confidence, scanRef, source, at}`，`''` = 第二段尚无扫描结论；verdict ∈ `contacted`（已有效触达）/ `need_intervention`（需介入）/ `uncertain`（低置信=转人工的持久化标记）
- **新服务 `crmSla2Service.ts`**（零 electron 依赖，同 crmFriendDetectService 模式）：
  - `markSla2ScanResult(leadId, input)` —— 规则/LLM/人工三路结论的**统一写入口径**（单事务 UPDATE assignment + audit_event `sla2_scan_result`，detail 记 prevVerdict/overridden）。E101 参数非法（verdict 枚举外/confidence 出 0-1/scanRef 空）；E301 无有效分配；**E201 第二段未开始**（sla1_met_at 仍 NULL = 第一段「加了没有」还没过）。幂等：同 (verdict, scanRef, source) 重放 alreadyMarked 零写入零新审计；不同结论允许覆盖（最新扫描胜出），每次覆盖留审计。actor 兜底：rule 路恒 `system:sla2-scan`，llm/manual 路 = 显式 > 身份档案 > 「操作员」
  - `runSla2RuleScan(fetchMessages)` —— **规则骨架（占位版 LLM）**：扫 assigned/claimed 且已停表且未标记的行，取绑定会话（lead.wechat，停表时已回填）停表时刻后的消息，**只认「客户有回复」这一事实**（isSend≠1，confidence=1.0，scanRef=messageKey）；其余情形不下结论零写入（宁缺毋滥，留给 LLM/人工）
  - `startSla2ScanScheduler(fetchMessages)` —— main.ts 挂加好友检测调度器旁，延迟 120s 首扫 + 间隔轮巡（新 config 键 **`crmSla2ScanIntervalMin`** 分钟，5-1440，默认 30，同款三段式）；生产 fetcher = `chatService.getMessages` 适配（startTime 传毫秒内部自转秒；createTime 秒→毫秒归一；WCDB 只读，未连接 → 该条跳过零副作用）
  - **回收器尊重标记**：SLA1 回收器只扫 `sla1_met_at IS NULL` 的行，进入第二段的分配天然不在其扫描域，回收器零改动
  - **⚠️ 缺口（后续刀）**：真实 LLM 对话跟进状态判定未实现——现有代码无可复用的「对话跟进状态」LLM 扫描服务。接入时：① 结论一律经 `markSla2ScanResult(source='llm')` 写入；② 出机内容必须先过本服务 `maskPrivateText`（宪法 §2.6：手机号/wxid/身份证号 → `***`，未脱敏原文不出本机）；③ 低置信写 `verdict='uncertain'`（转人工的呈现入口也是后续刀）
- **客户类型（PRD §1.5，R9/R10 前置）**：`customer.type` 列 D3 已建（dealer/end_user/'' 未设置）。新服务 `crmCustomerService.ts`：`setCustomerType(customerId, type, actor?)` 单事务 UPDATE + audit_event `customer_type_set`（detail 含新旧值）；E101 枚举外 / E301 不存在；同值重放 unchanged 零写入。⚠️ type 是 B 档字段（宪法 §1.1：proposed→人工 confirm），本服务只承载人工写入，AI 提议走 enrich 待确认链路
- **IPC 三处配齐**：`crm:sla2:mark` / `crm:customer:setType`（crmIpcHandlers + preload `sla2Mark`/`customerSetType` + electron.d.ts，统一信封）；`crm:customer:profile` 附挂 `customer` 行（account.customer_id → customer，供档案展示类型）
- **前端（CustomerWorkspacePage 客户 360）**：「客户信息」区块顶部加「客户类型」行——下拉 未设置/经销商/终端客户，选即存（写审计）+ 档案刷新；account 未挂接 customer 时显示「未建档」不可编辑
- **测试** `scripts/sla2-customer-type-test.ts`（WEFLOW_WORKER 隔离 + fresh 库，**41/41**：A 写入口径+署名 / B E101×4+E301+E201 守卫零写入 / C 幂等重放+覆盖留 prevVerdict+uncertain 可写 / D 规则扫描命中·只己方不写·早于停表不算·无会话跳过·claimed 同扫·重扫零重复·回收器尊重第二段域 / E 脱敏三类打码 / F 类型设置+审计+幂等+枚举守卫+清除 / G Schema 防线）
- **验证**：tsc root 0 错误 / node 158 条与基线一致零新增 / vite build ✓ / 回归 crm-lead 55/55 + assignment-full 71/71 + friend-detect 33/33 + lead-assignment-view 32/32；`tsc -b tsconfig.node.json` 产物已重建；live 库未碰（副本只读核验列存在）
- **有意偏离**：① SLA2 不起计时器也不做回收动作——PRD 第二段只要求「扫描判定跟进状态」，回收语义只属于第一段；② 规则骨架只标 `contacted`（客户回复=事实），`need_intervention`/`uncertain` 只能由 LLM/人工路写入，规则不猜；③ 客户类型编辑只进 360 档案（依赖 account.customer_id 挂接），未挂接的存量 account 暂不可编辑（迁移 ② 已 live 跑过，新 account 走建档链路）

---

## 2.58 售后规则 + 离职移交 + local_outbox（PRD §1.6/§1.7/§1.7a/§1.7b/§1.9/§1.10，2026-09-04）

- **售后 `crmAftersalesService.ts`**（零 electron）：事实驱动规则扫描 → follow_up_task 行动卡（created_by='aftersales'，独立于 action_engine 重扫清理，沿 'sla' 先例）；去重 = idx_ft_sla_once + salesDbService 新方法 `pendingTaskBySource`/`hasAnyTaskBySource`；统一入口 `runAftersalesScan(now)` 挂 runFullScan（scanLeadSla 旁）；触发类型已进 getUnifiedSignals 标签/理由映射。
  - §1.6 生命周期 = `dealAftersalesStage` 纯推导（成交→已交付→待回访→复购老客，不建列）；复购 = 同 customer（退 account）≥2 笔 won，叠加客户级维护 = R10 加 60 天档。
  - R9：dealer 客户签收满 10 天出预警卡（due=签收+15 天）；pending 卡超 15 天 → todoUpdate 升级标题+提 urgent 分，不新建卡。
  - R10：won 商机成交满 15/30/90 天出回访卡，一次性，**每单每次只出最近一个到期档**（不补旧档骚扰）；R5 互斥=既有 won/lost 守卫，未改动。
  - R11：quoted>14 天 / negotiating>21 天（以 customer_profile.last_stage_change_at 为准，缺失不猜）→ 停滞卡，pending 去重压制。
  - §1.7a 设备周期：delivery_date 起算，轮子 180/液压 365/电池 1095 天，一次性；delivery_date 缺省用最近物流签收推断；非特种设备无年检。
  - §1.7b R12 简单版：dealer 最近拿货（won/发货取大）超 60 天 → 回购提醒卡；从未拿货不提醒。
  - ⚠️ 缺口：delivery_date 无录入入口；质保到期/以旧换新/「升 A 级」无字段未实现；R12 学习版=Phase 4；阈值全常量。
- **离职移交 `crmOwnershipService.ts`**（§1.9）：`departureHandoff` = lead 循环 transferAssignment（契约原文，reason='离职'，逐条独立事务）+ owner 三列（account/opportunity/logistics）同事务直改 + 逐行 ownership_history + audit_event + 汇总审计 `departure_handoff_summary`；E101/E203。IPC `crm:ownership:departure` + preload `ownershipDeparture` + d.ts 三处配齐；前端入口 = 线索池页 header「离职移交」（角色≠销售可见）。
- **outbox `crmOutboxService.ts`**（§1.10 只记录不发送，宪法 §1.11）：`recordOutboxTx` 在业务既有事务内登记（event_seq=MAX+1；idempotency_key 重放 false 零写入；type 进 payload 不加列）；五写点 assign/transfer/recycle/claim/bind_wx，与内网同步设计 §3 对齐；⚠️ first_touch 上行缺口；owner 三列离职直改不登记（同步清单只覆盖 lead 分配域）。
- **顺带修复**：todoUpdate 的 priority_score 参数此前不落库（body 漏字段），补上（R9 提分首次用到；无现存调用方传该参，零行为变化）。
- **测试** `scripts/aftersales-transfer-outbox-test.ts` **53/53**；验证：tsc root 0 / node 158 零新增 / vite build ✓ / 回归 crm-lead 55 + assignment-full 71 + friend-detect 33 + sla2-customer-type 41 + lead-assignment-view 32 + identity 25 全绿；产物已重建；live 未碰。
- **有意偏离**：① R10 只出最近到期档；② 液压周期 PRD 未定取 12 个月；③ 离职移交入口放线索池页（与名单/分配同页闭环）而非设置页。

---

## 2.59 Phase 1 内网同步最小版实施：三刀全落 + 模拟双机验证（2026-09-04，设计 docs/规划/Phase1-内网同步最小版-设计.md）
> 设计定稿的三刀一次落完：SMB 共享文件夹通道、一事件一 JSON、tmp+rename 原子写、复用 outbox_event 登记口径、幂等键存 scan_state（Q3）。未配置共享目录/角色 = 同步关闭，全入口静默跳过。**零新表**（scan_state 承载幂等键/游标/最近同步时间）。
- **新服务 `lanSyncService.ts`**（零 electron，tsx 可测）：
  - 配置三键 `lanSyncSharedDir` / `lanSyncRole`（''=关 / hub 中枢 / terminal 终端）/ `lanSyncPollIntervalMin`（1-60，默认 1 分钟）；路径支持 `~` 展开。
  - **终端标识 = 身份档案姓名优先、未建档回退机器名**（目录名安全化：空白与 `\\/:*?"<>|` → `_`）。
  - 事件文件 `{ eventSeq, idempotencyKey, type, payload, emittedAt, from? }`；写盘一律 `atomicWriteFileSync`（tmp→fsync→rename），消费方只列 `*.json`——`.tmp` 半截文件天然不入眼；毒文件改名 `.bad` 隔离不反复重试。
  - **刀1 中枢下行产出 `emitDownEvents`**：扫 pending outbox 挑 assign/transfer/recycle，富化 payload（lead 基础资料 name/contact/wechat/source/note + 目标销售 + slaHours/sla1Deadline）写 `down/<seq>-<key>.json` 后标 `status='sent'`；目录不可写整轮跳过、行留 pending 等重放（R3 积压语义，宪法 §1.11 业务侧可重放）。
  - **刀2 终端消费下行 `consumeDownEvents`**：按文件名升序逐条应用，单事务 = 业务写 + `syncApplied:<idempotencyKey>` 标记；成功删文件。跨机 id 不可信——**lead 按 (contact_type, contact_normalized) 身份解析**，本机无此 lead 时随 assign 事件建档（资料齐备）；assign 命中本地已有有效归属 → conflict 不覆盖（标已应用留人工，防反复重试）；transfer = 旧行 transferred + 新行 assigned 重起 sla1；recycle = 有效行 recycled + lead 期限回 2100 哨兵。
  - **刀2 终端上行产出 `emitUpEvents`** 到 `up/<终端标识>/`：① pending outbox 中 claim/bind_wx/first_touch 富化 lead 身份后落文件（**键加终端前缀 `<tid>/<原键>` 保证多终端全局唯一**，Q3 的 `syncApplied:` 判定照原文成立）→ 标 sent；② **audit 上行（Q4）不走 outbox**——scan_state 游标 `syncUp:auditCursor` 逐条扫 audit_event（排除 `sync_%` 同步层行防回声），payload 裁剪为 actor/action/entity_type/entity_id/detail 五字段，detail 过 `maskAuditText`（**手机号中段打码 `138****5678` 复用前端 maskLead 格式** + wxid/身份证号 *** 复用 maskPrivateText），游标随落盘成功推进、失败即停保序。
  - **刀3 中枢消费上行 `consumeUpEvents`**：扫 `up/*/` 各目录，**跳过自己的终端标识目录**（中枢不消费自己的 up）；claim → 当前分配 assigned→claimed；bind_wx → 停 SLA1 表 + lead→WX_ADDED + wechat 回填；first_touch → NEW→CONTACTED + lead_activity + 审计；audit → 五字段原样入 audit_event（entity_id 是终端本机 id，Phase 1 接受）。全部幂等标记 + 删文件。
  - `lanSyncStatus()`（设置页区块数据源：角色/目录/终端标识/四个最近同步时间戳/待发出积压 backlogPending/待消费积压 backlogIncoming）+ `runLanSyncOnce()` 按角色分派 + `startLanSyncScheduler()`（main.ts 挂周复盘旁，首巡 150s，每轮按当前配置动态分派角色）。
- **Q2 拦截（设计 §4）落在 `recycleAssignment` 单点**（人工+回收器共用漏斗）：lead 已挂 account → E205 跳过 + 审计 `lead_recycle` detail.reason='converted_skip' + **不下发 recycle 事件**；回收器每轮会再命中同一行 → scan_state 标记 `convertedSkip:<assignmentId>` 保证一行只留一条拦截审计，不每 30 分钟刷屏。
- **first_touch 写点补齐**（§2.58 缺口关闭）：`updateLeadStatus(contacted)` 与 `completeLeadFirstContact` 双写点登记 outbox，同 key `first_touch:<leadId>` 幂等（先登记者生效）；payload 带 lead 身份供中枢解析。**Q1 行内编辑不上行**：updateLeadProfile 零 outbox 登记（测试断言）。
- **角色差异启停**：终端角色**不启动 SLA1 回收器**（main.ts 按 getLanSyncConfig().role 门控，回收由中枢下行 recycle 事件驱动）；中枢 emitDown+consumeUp、终端 consumeDown+emitUp，同一套代码。
- **IPC/前端**：`lanSyncIpcHandlers.ts` 两端点 `lansync:status`（只读）/ `lansync:run`（enqueueSalesTask 串行，手动一轮）；preload `lanSync.*` + d.ts `LanSyncStatus` 三处配齐；config API `get/setLanSyncSharedDir`、`get/setLanSyncRole`；**设置页数据库 tab「内网同步」区块**（身份档案后）：共享目录路径（blur 保存）+ 角色下拉（立即保存）+ 状态行（最近同步时间/积压数/终端标识）+「立即同步」按钮，沿用自动备份区块同款样式。**⚠️ 该区块的 UI 形态已于 2026-09-13 卡片化重做（角色下拉 → 分段选择器、状态行 → 同步拓扑图 + 积压指标卡，时间改相对时间显示），见 §2.100**；四个时间戳字段、保存时机与方向文案口径未变
- **测试**：`scripts/lan-sync-test.ts` **42/42**（开关静默/下行富化/R3 积压重放/Q4 裁剪脱敏/Q2 拦截防刷屏/Q1 对照/first_touch 双写点/毒文件/半截 tmp/重复投递/自己目录跳过/冲突不覆盖/状态字段）；`scripts/lan-sync-e2e-test.ts` **30/30** 模拟双机（/tmp 两 userData 目录用 `reopenForWxid` 换库 + 一个共享目录）：A 分配→down→B 消费（分配+资料齐全+sla1 一致）→B 认领→up→A 消费（claimed）→重复投递幂等零重复→销售甲/乙各自视角过滤成立→半截 tmp 不消费→transfer 下行闭环→中枢跳过自己 up。
- **验证**：tsc root 0 错误 / node 158 条零新增 / vite build ✓（产物含 lansync 端点与设置页区块）；回归 crm-lead 55/55、assignment-full 71/71、friend-detect 33/33、sla2-customer-type 41/41、aftersales-transfer-outbox 53/53、lead-assignment-view 32/32、identity 25/25、assignment 28/28、persist-guard 36/36、auto-backup 32/32、crm-golden 47/47 全绿；assignment-correction-test 14/10 为 HEAD 既有环境性失败（live 库已被运行中应用执行过纠正，副本口径失效，同 §2.53 记录的 migration-live 情况，与本刀无关——git stash 实证 HEAD 同样 14/10）；产物已重建；live 未碰。
- **有意偏离/边界**：① 下行不分终端子目录（R3 缓解项，Phase 1 接受：终端消费后删文件 + 幂等键兜底，共享权限配置属部署文档范畴）；② audit 上行 entity_id 为终端本机 id（Q4 五字段裁剪口径的直接后果，跨机对账靠 actor/时间/detail）；③ 终端「已转客户」不上行，Q2 拦截只看本机 account 挂接（设计自身边界）；④ conflict（中枢指令与本地有效归属打架）标已应用不反复重试，留人工对账；⑤ 同步调度间隔启动时读取（改 lanSyncPollIntervalMin 需重启生效；角色/目录每轮动态生效）。

## 2.60 启动链 bug 修复：resetLegacyGroupScanSla 误清已分配线索期限 + 存量对齐（2026-09-05）

> **bug**：`resetLegacyGroupScanSla`（决策B存量处置，**每次启动都跑**、靠「二次命中 0 行」幂等）的 WHERE 不排除已分配 lead——9/4 旧归属恢复为正式分配后，下一次启动把 3,837 条 assigned 群扫 lead 的 `first_contact_deadline` 打回 2100 哨兵（assignment.sla1_deadline 仍有效，回收器不受影响，但 lead 期限列失真、超时统计口径被污染）。assignment-correction-test 口径修正时现场查出。

- **修复①**：`resetLegacyGroupScanSla` 加 `NOT EXISTS 有效分配（assigned/claimed）` 排除（SELECT/UPDATE 双处），注释写明事故。
- **修复②**：新增 `syncLeadDeadlineFromAssignment()`（crmAssignmentService，启动链挂 correctSla1Misrecycle 之后）：`lead.status='NEW'` 且有有效分配时 `first_contact_deadline` 对齐当前分配行 `sla1_deadline`，幂等（只改不一致行）。live 已生效：启动日志「对齐 3,837 条」。
- **坑（写测试须知）**：`crmDbService.runTx` 的 `tx.run` 返回 `last_insert_rowid()` 而非修改行数——UPDATE 语句拿它当命中数必错，用前后 COUNT 差值。
- **测试口径修正**（live 已演进，旧口径永久失效）：
  - `assignment-correction-test` → 「已纠正副本」终态核验 + 幂等重跑（17/17）。⚠️ live 实际恢复路径核查：3,848 条 assigned 行是 9/4 14:11 由 restoreLegacyGroupScanAssignments 重跑恢复（source=manual/updated_by=system:migration），correctSla1Misrecycle 首跑即 alreadyAssigned 跳过、只落汇总审计——system:correction 补偿流水在 live 不存在属正常（补偿路径由 assignment-full G 组 fresh 场景覆盖）。
  - `lead-sla-reset-test` → 增量对账口径（live 已有 9/3 重置留痕）+ 新增 D 组防线：已分配 lead 不被重置误清 / 对齐修复命中 / 幂等（18/18）。
- **验证**：tsc root 0 / node 158 基线零新增 / 全量回归 14 脚本全绿（crm-lead 55/55、assignment 28/28、assignment-full 71/71、friend-detect 33/33、sla2-customer-type 41/41、aftersales-transfer-outbox 53/53、lead-assignment-view 32/32、identity 25/25、lan-sync 42/42、lan-sync-e2e 30/30、persist-guard 36/36、auto-backup 32/32、crm-golden 47/47、lead-sla-reset 18/18）+ assignment-correction 17/17；产物已重建。

---

## 2.61 客户工作台 360 档案改右侧抽屉（2026-09-05，UI 体验修复）

> **问题**：客户工作台点客户后，360 档案（12 字段信息 + 40 条时间线 + AI 画像 + 当前判断 + 待办 + 业务 + 深度分析报告）内联展开在 188 张客户卡片下方，页面极长、操作要反复滚动。

- **改法**：`CustomerWorkspacePage.tsx` 档案区包进 `.cws-drawer`（半透明遮罩 + 点遮罩关闭）+ `.cws-drawer__panel`（右侧滑出，宽 min(760px,94vw)，全高独立滚动，头部 sticky 吸顶 + ✕ 关闭按钮）；样式全为新类，不改 `.crm-detail` 本体（与合同工作台共用，免误伤）。
- **⚠️ 此改动不在已打好的 `release/WeFlow-1.0.0-Setup.exe`（009de01）里**——UI 反馈收敛后需重打一次包再发销售。
- **验证**：tsc root 0 / lead-assignment-view 32/32。

---

## 2.62 CRM 六页接入 wxid-changed 自动重查（2026-09-05，账号隔离体验修复）

> **问题**：用户反馈「客户/商机/漏斗/合同数据隔离没做好，切微信号后数据一样」。核查结论：§2.40 微信号整库分库（weflow-crm/sales-<wxid>.db）后端**早已生效**（`config:set myWxid` → `switchBusinessDbsForWxid` → `reopenForWxid`），但 CRM 页面**不监听 wxid-changed 事件**，切账号后屏幕残留上一账号数据（需手动换页才刷新），看起来就像没隔离。

- **改法**：新增 `src/utils/useWxidRefresh.ts`（ref 转发，保证触发时调最新 reload 闭包）；客户工作台 / 商机 / 漏斗 / 合同工作台 / 今日行动 / 线索池六页统一接入。
- **注意**：切到从未用过的微信号会建**空库**（正常，即隔离生效的表现）；另三个微信号目录（xwechat_files 下）≠ 都在 WeFlow 配过密钥，`wxidConfigs` 只配了 wen24 一个号。
- **遗留（用户已拍板「先测后补」）**：① 销售维度的隔离（销售只看自己的客户/商机/合同）未做——现仅线索池一页有展示层过滤；② LAN 同步下行是全量广播，未按销售投递；③ contract 表无 owner_sales 列（宪法设计：经 account 推导）。
- **⚠️ 不在已打好的 Windows 包（009de01）里**，与 §2.61 一起待重打。
- **验证**：tsc root 0 / account-db-isolation 27/27。

---

## 2.63 存量脏金额启动清理（2026-09-05，商机页 ¥304亿 修复）

> **问题**：Windows 机器商机页显示「商机金额 ¥304.05 亿」，王静一条 ¥15,200,000,006——即手机号 15200000006 被当金额。**根因是存量**：护栏（`PHONE_NUM_RE` + `AMOUNT_MAX=1e8`，crmParseRules.ts:35/37）9/2 才随 86b3ece 上线，此前旧版本已把脏数据写进 Windows 本地库；覆盖安装只换程序不动数据，故新包仍看到旧脏数据。Mac 本机库是干净的（opportunity 仅 5 行 amount 全 0）。

- **改法**：`crmDbService.ts` doInitialize 内、决策 B 游标清理后，新增幂等启动清理——`opportunity`/`quote_signal` 中 `amount ≥ 1e8` 的行归零（=待人工确认），每行 `opportunityEventAdd('amount_reset')` 留痕，有命中写一行 `audit_event`（actor=`system:migration`，action=`absurd_amount_sweep`）。
- **口径**：1 亿阈值——叉车整机/改装单价远不及此，必为误识别；归零而非删除，销售可在商机页人工补填真实金额。
- **注意**：`this.all()` 非泛型（返回 `CrmRow[]`），993/1184 两行 `this.all<{...}>` 是既有基线错误（TS2558，含在 158 基线内），新代码不要照抄该写法。
- **⚠️ 不在 009de01 包里**，随 §2.61/§2.62 一起待重打；销售机器**无需手动清库**，新包首次启动自动清。
- **验证**：tsc node 158 基线零新增 / crm-opportunity-test 45/45 / crm-golden-test 47/47 / 一次性实证脚本（/tmp/sweep-verify.ts）：脏行归零、正常行不误伤、amount_reset+audit 留痕、二次启动幂等 0 命中。

---

## 2.64 AI 见解噪音治理：触发闸门 + 归因修正 + 群发识别（2026-09-05，已提交）

> **总设计**：`docs/设计-AI见解重定位.md`（三阶段：噪音治理 → 触发重路由 → 例外告警；本节为阶段一落地）。**问题**：外部自动化工具（群发「去看看」、删好友检测脚本重添加产生「你已添加了…」系统消息）写入微信库后被当成客户行为——群发风暴触发 N 次 AI 扫描（单日 46 条垃圾见解）；系统消息 isSend=0 在上下文里冒充对方发言，AI 产出「对方多次加好友」类 180° 错误结论。

- **新模块 `electron/services/insightNoiseFilter.ts`**（零 electron/chatService 依赖，可 tsx 单测）：`classifyInsightMessage` 三分类（system=localType 10000/266287972401 拍一拍；own=isSend 1；其余 customer）+ `scanMessagesForTrigger` 纯函数（存在「新且是客户发的」消息才触发；lastSeen 传 0 时 own 全采集，供上下文加载点复用）+ `MassSendDetector` 群发模板被动检测（同内容 ≥3 会话/72h 窗口 → 标记维持至末次命中+48h；7 天条目顺带清扫；误判代价=多一句护栏，可控）。
- **触发闸门（insightService 两条路径）**：白名单路径拉最新 1 条→改 10 条（`TRIGGER_SCAN_WINDOW`）走 `scanMessagesForTrigger`；黑名单路径原只看 session 缓存时间戳→新增同款拉取扫描。仅群发/系统消息更新 → 只推进 `lastSeenTimestamp` 不触发。**行为变化**：冷却期检查移到拉消息之前（原黑名单路径先更新 lastSeen 再查冷却，冷却期间到达的客户回复会被时间戳消费吞掉；现在冷却结束后补扫窗口内客户消息）。
- **分类器闸门**：`actionStageClassifier`（黑名单路径新消息即跑）移到客户闸门之后——群发/系统消息不再浪费分类器 API、不误写 customer_profile.stage。
- **上下文标注**：`buildInsightContextSection` 签名改 `{ text, hasNoise }`——system 消息说话人改「系统」+ 前缀 `[系统消息]`（不再冒充对方）；own 命中群发模板 → 前缀 `【疑似群发·批量触达】`。
- **prompt 护栏**：仅当 `hasNoise` 时 user prompt 追加「[系统消息]…不代表对方发言；【疑似群发】…禁止解读为对方行为/意向/回复」（system prompt 不动，保 API 缓存命中；无噪音时 prompt 原样）。
- **原子写**：`insightRecordService.persist()` 的 `writeFileSync` 直写换 `atomicWriteFileSync`（截断窗口崩溃可致 JSON 损坏，与 sql.js 落盘铁律同型）。
- **顺带修**：dedup 跳过日志「12h」文案与 24h 常量不一致 → 24h。
- **不做**（设计 §5/§2.2）：`scanUrgeFollowUps` 不加闸门（催办要求沉默 ≥2 天，群发后沉默时长必小于阈值，天然免疫）；`batchProfileCore`（画像回填，stage=unknown 限定）不动；silence 扫描不动。
- **验证**：tsc root 0 / node gate 158 基线零新增 / insight-noise-test 32/32（新）/ insight-dedup-test 6/6 / insight-unnamed-session-test 6/6 / insight-stage-ban-test 16/16。
- **遗留**：阶段二（晨间摘要+触发重路由+archive 语义去重配套修+前端 store 三处/chips 清理）与阶段三（告警白名单+alert_eval_case 评测基建）见设计稿；存量 46 条垃圾 insightRecord 手动清 `weflow-insight-records.json`。

---

## 2.65 晨间摘要：每日一条「今天先跟谁」（2026-09-05，设计-AI见解重定位 阶段二 a，已提交）

> **总设计**：`docs/设计-AI见解重定位.md` §3.1（阶段二「触发重路由」第一刀，上承 §2.64 阶段一噪音治理）。**定位**：从「消息触发的散装卡流」转向「决策时刻的一条摘要」——每天 08:05-08:35 生成一条「今天先跟谁」；AI 失败也永远有摘要，AI 只负责更好读。成本 1 次 API 调用/天。

- **新服务 `electron/services/morningDigestService.ts`**（纯函数可单测 + 服务薄壳）：`getUnifiedSignals` top 10 → 单次 LLM（`buildDigestPrompt` 卡片清单：客户/阶段/规则理由/沉默天数/优先级分，**不含聊天原文**）→ `parseAiDigest` 只认输入清单内的 sessionId（防幻觉，全不匹配 → 降级）；AI 未配置/失败 → `buildFallbackDigest` priorityScore top 3 规则拼接。
- **落库复用 `report_snapshot`**（period_type='morning_digest'，现存唯一「周期级 AI 文本」容器，不建新表、不动宪法）：`stats` = JSON `{items, aiUsed}`，`ai_summary` = 人话正文。**同日幂等**：`generateTodayDigest` 当天已有直接返回；`regenerateToday` 删当天旧行重建（`reportDeleteByTypeAndDate`）。
- **调度**：`startMorningDigestScheduler` 30 分钟轮询 08:05-08:35 窗口（错开 08:00 runFullScan，摘要基于当天最新卡流；main.ts 挂 startActionEngineScheduler 旁）；「今日已生成」以 report_snapshot 落库行为准，重启不重复；定时触发走 `enqueueSalesTask`。
- **salesDbService 两方法**：`reportLatestByType(periodType)` / `reportDeleteByTypeAndDate(periodType, date)`（按 period_start 本地日删）。⚠️ salesDb 的 `this.all<T>`/`this.get<T>` **是泛型的**（与 crmDb 的非泛型坑不同，见 §2.63 注意项），可放心用。
- **接线**：main.ts IPC `sales:morningDigest:get` / `sales:morningDigest:regenerate`（regenerate 走 enqueueSalesTask）+ setConfig/startScheduler 启动链；preload `morningDigestGet`/`morningDigestRegenerate`；electron.d.ts 类型同步。
- **前端（TodayActionPage）**：有当天摘要时 banner（`.signal-notice--digest`，Sunrise 图标 + 纵向条目列表）**取代**高意向提示条（两者互斥不同时出现）；条目点击深链 `/customers?sid=`；「收起」+ **⟳ 刷新小按钮**（`morningDigestRegenerate` → 回拉刷新，转圈防重复点）——用户测试入口，不必等早上 8 点；切微信号（useWxidRefresh）重查摘要并复位收起态。
- **验证**：morning-digest-test 22/22（新，窗口/降级/幻觉过滤/幂等/regenerate）/ insight-noise-test 32/32 / funnel-test 40/40 / report-review-test 33/33；tsc root 0 / node 158 基线零新增；vite build ✓；`tsc -b tsconfig.node.json` 产物已重建。
- **遗留**：阶段二其余（§3.2 散装见解降级进档案不进卡流 + archive 语义、§3.3 灵感信箱改「重要提醒」告警箱）与阶段三例外告警白名单见设计稿。

---

## 2.66 散装见解降级 + 信箱改「重要提醒」（2026-09-05，设计-AI见解重定位 阶段二 b，已提交）

> **总设计**：`docs/设计-AI见解重定位.md` §3.2/§3.3（阶段二「触发重路由」后两刀，上承 §2.64 阶段一噪音治理、§2.65 晨间摘要）。**语义**：「记录 = 分析事实 SSOT，信箱 = 告警视图」——自动见解继续生成（customer_judgment 与 enrich 的上游），但只作档案标注，不再进信箱/卡流。

- **sourceType 三分**：`InsightRecordSourceType` 加 `'archive'`——insightService 唯一自动写入点（generateInsightForSession 的 addRecord，activity/silence/test/manual 全走它）改落 `sourceType: 'archive'`；message_analysis（手动单条解析）不变；`'insight'` 预留给阶段三告警（triggerReason='alert:*'）。
- **⚠️ 去重配套修（评审定论的地雷，两行必须一起改）**：`hasRecentRecord` 过滤从 `=== 'insight'` 改 `!== 'message_analysis'`——archive 必须计入 24h 去重，否则每条客户消息都重触发一次 LLM 调用；注释同步「记录=分析事实 SSOT，信箱=告警视图」。
- **卡流移除 insight**：salesActionEngine 删 insight 合流分支（4b）+ INSIGHT_BOOST + SignalSource 'insight' 变体 + completeUnifiedSignal 的 insight read 标记；`stats.insightOnly`/`merged` **保留字段恒 0**（防前端引用断裂）。
- **⚠️ 隐藏消费点盘点（设计稿 §3.2 要求的实现前盘点，两处差点被默认过滤误伤）**：`crmEnrichService` 素材【AI 见解记录】与 `crm:customer:profile`（客户 360 时间线 insights 混排）都靠 listRecords 读记录——「进档案」全靠这两处。为此 `InsightRecordFilters` 加 **`includeArchive` 内部开关**（默认关=信箱隐藏），两处显式 `true`，行为与降级前完全一致；显式 `sourceType='archive'` 亦可查归档（数据清理/调试用）。
- **信箱改「重要提醒」**：listRecords 默认（all/未指定）过滤 archive，todayCount/unreadCount/contacts 联系人面板同口径；页标题改「重要提醒」（加载/报错文案同步）。存量 'insight' 记录仍显示（历史），新写入只有 message_analysis，直至阶段三告警上线。
- **前端清理**：todayActionStore SignalSource/SignalFilter 去 'insight'（ActionStats 字段保留）；TodayActionPage 删「有动向」chip + chipCounts.insight + filter 谓词 + **高意向提示条整个删除**（已被晨间摘要 banner 取代，Bell/noticeDismissed 引用一并清）；AIActionCard teal 洞察块 + hasInsight 按钮分支删除（卡流渲染分支同步清）；**TodoSidebar 盘点结论：不消费 insight 记录，未动**（设计稿 §3.2 的「已知消费」记载有误）。
- **测试**：insight-dedup-test 6→**11**（e1-e5：archive 计入去重 / 信箱 total·unread·today·contacts 不含 archive / 显式 archive 视图可查）；todo-followup-test 11→**14**（e1-e3：archive+存量 insight 不出卡 / 卡流零 insight 来源 / stats 恒 0）；回归 insight-noise 32 + morning-digest 22 + funnel 40 + report-review 33 + crm-enrich 61 + customer360 13 + today-action-consumer 14 + customer-event 20 + insight-stage-ban 16 + insight-unnamed 6 全绿。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓ / `tsc -b` 产物已重建。
- **遗留**：阶段三（告警 A 竞品锚点先行 + alert_eval_case 评测基建，**先入宪法 §3 再建表**）见设计稿 §4；存量垃圾 insightRecord 手动清 `weflow-insight-records.json`（§3.3，数据清理不写代码）。

---

## 2.67 例外告警契约框架 + 告警 A「竞品提及」（2026-09-05，设计-AI见解重定位 阶段三 A，已提交）

> **总设计**：`docs/设计-AI见解重定位.md` §4.1/§4.2（阶段三第一刀，上承 §2.66「信箱=告警视图」——告警是信箱唯一的预期写入方）。**契约**：四道闸缺一不可——①证据强制（getEvidenceByKey 必须 found，验不出原话直接丢弃，宪法 §1.10）②72h 幂等（同客户同类型）③推送门（评测 ≥85% 才开，默认全关）④门开才落 insightRecord 进信箱+卡流。

- **新服务 `electron/services/alertService.ts`**（零 electron 依赖，依赖全注入，仿 main.ts:77 `createEvidenceResolver` 模式）：`createAlertService(deps)` 纯核心 + `initAlertService`/`getAlertService` 主进程单例（未注入时 getAlertService()=null，调用方 no-op，不炸扫描链）。模块级常量 `ALERT_PUSH_APPROVED: Record<string, boolean>` 全类型默认 false（competitor 首个在册）；`ALERT_DEDUP_MS=72h`。门关时**零副作用**（连证据校验/去重查询都不做，crm_risk 档案标注已由 parseRiskSignal 链承担，无需额外写）。落库 `sourceType='insight'` + `triggerReason='alert:<type>'`，messageKey 存进记录新增可选字段（最小改动，未动 log 结构）；告警文案含客户原话 ≤200 字快照（`buildAlertMessage`）。
- **insightRecordService 三处最小改动**：`InsightRecordTriggerReason` 加模板字面量 `` `alert:${string}` ``；`InsightRecord`/`Summary`/`addRecord` 加可选 `messageKey` 字段；新方法 `hasRecentAlert(sessionId, triggerReason, windowMs)`——**按 triggerReason 精确匹配、不限 sourceType**（与 hasRecentRecord 的 24h 去重语义正交：告警只与告警去重，archive 不挡告警）。
- **告警 A 竞品提及（识别层零改动）**：`crmDbService.upsertRisk` 加 `sourceMsg?: string` 参数——`crm_risk.source_msg` 空置列本次激活（create 落列；update **只补空不覆盖**）；`crmParseService` 私聊扫描 upsertRisk 命中点传 `sourceMsg: key`（复用上游 canonical messageKey，不现场拼），competitor 类型 `void getAlertService()?.createAlert({type:'competitor', sessionId, displayName, messageKey: key, evidenceText: textForSignal.slice(0,200)})` fire-and-forget，不阻断扫描链。price/service 类型只落 crm_risk 不出告警（设计 §4.2 处置）。
- **main.ts 接线**：`initAlertService({getEvidenceByKey ← evidenceResolver, hasRecentAlert/addRecord ← insightRecordService, log ← salesLog})` 挂在 createEvidenceResolver 之后（证据回查复用 P0-2B 同一 resolver 实例）。
- **卡流合流（salesActionEngine 4b 分支）**：`getUnifiedSignals` 新增 alert 合流——`listRecords` 里 `triggerReason` 以 `alert:` 开头且 **24h 内**的记录进卡流（信箱同源；`ALERT_WINDOW_MS=24h` / `ALERT_BOOST=110` 即 urgent 档，稀缺故加分高于 rule 卡）；SignalSource 加 `{type:'alert', alertType, label, reason, recordId, messageKey}` 变体。与 §3.2 删掉的 insight 分支不冲突：删的是 activity/silence 散装见解（archive 语义），此处是告警白名单。
- **前端**：todayActionStore SignalSource 加 alert 变体；AIActionCard SourceTag 三态（task 石墨蓝 / **alert 红徽章**（code='!'，scss `&--alert` 复用徽章结构）/ 历史 insight 黄）；alert-only 卡 title 取 sources[0].reason（告警文案，含原话快照），mapSignal 无需改。
- **当前行为**：推送门全关 → 竞品提及照旧只落 crm_risk（含 source_msg 锚点），信箱/卡流零新增；离线评测（alert_eval_case 评测基建，下一步）准确率 ≥85% 后把 `ALERT_PUSH_APPROVED.competitor` 改 true 即全链路生效，无需再改代码。
- **测试**：alert-gate-test **33/33**（新：a1-a2 证据丢弃零落库 / b1-b5 门=false 零记录、门=true 出记录带 triggerReason / c1-c5 72h 幂等+bad_input+未开通类型 / d1-d8 hasRecentAlert 真 Service 落盘验证+messageKey 落库 / e1-e12 接线静态检查）；回归 insight-noise 32 + insight-dedup 11 + crm-opportunity 45 + morning-digest 22 + todo-followup 14 + insight-unnamed 6 + insight-stage-ban 16 + action-rules 36 全绿。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓ / `tsc -b tsconfig.node.json` 产物已重建（dist-electron/main.js 含告警代码）。
- **遗留**：alert_eval_case 评测基建（宪法 §3 登记先行）→ 评测达标开 competitor 门 → 告警 B（客户明示流失）；告警 D 独立设计。

---

## 2.68 告警评测基建 alert_eval_case + 告警 B 识别规则 parseLossSignal（2026-09-05，设计-AI见解重定位 阶段三评测刀，已提交）

> **总设计**：`docs/设计-AI见解重定位.md` §4.3/§4.2 告警 B（上承 §2.67 契约框架+告警 A）。**SSOT 顺序**：先在 DATA-CONSTITUTION §3 登记 `alert_eval_case` 特许扩展行，再建表。

- **新表 `alert_eval_case`（salesDb，SCHEMA_SQL 幂等 CREATE + 索引兜底双路径，仿 opportunity_eval_case）**：`session_id / anchor_key / alert_type / label CHECK('','correct','wrong','uncertain') / evidence_message_keys / evidence_text（≤200 字快照，PIPL）/ ai_label（同 CHECK）/ ai_evidence_keys / status CHECK('pending','prelabeled','confirmed') / annotated_by / source / 通用五列`；**UNIQUE(session_id, anchor_key, alert_type)**（比商机评测多一维 alert_type——各告警类型独立评测，evalStats 聚合不被单一类型污染，这是不复用 opportunity_eval_case 的核心理由，宪法已记）。`salesDbService` 四方法：`alertEvalCaseUpsert`（幂等命中更新、ai_* 与人工字段分存互不覆盖、非法值 DB CHECK 拦截、status 缺省按内容推导）/ `alertEvalCaseGetById` / `alertEvalCaseGet`（三维幂等键）/ `alertEvalCaseList`（alert_type+status 过滤）/ `alertEvalCaseCount`（分组口径）——加上 Upsert 共五入口（任务书「四方法」按 Get/List/Count/Upsert 计）。
- **告警 B 识别规则 `crmParseRules.parseLossSignal`**（纯函数，parseRiskSignal 同型风格：isSend=0 限定、[表情] 清洗、<4 字跳过、detail=原话 ≤100 字）：窄口径双正则——`LOSS_REJECT_RE`（不买了/不用了/不需要了/不要了/用不上）+ `LOSS_ELSEWHERE_RE`（找别家/别家买/别家买了/在别家订了/已经订了/已经买了/买了别家的）。**⛔ 未接告警链**：parseLossSignal 不出现在 crmParseService（测试 d1 静态守卫）——§4.1 第 4 条，B 必须先在 alert_eval_case 评测到 ≥85% 才允许接 alertService，届时接线点仿 competitor 命中点三行。
- **评测脚本 `scripts/alert-eval.ts`**（仿 opportunity-eval.ts export/import 双命令）：⚠️ **WCDB 聊天库只能经应用内 native worker 打开，离线脚本读不了**——「历史聊天副本」落地为聊天导出 JSONL（`--dump`，行 {session_id, display_name, message_key, is_send, content, create_time}，message_key 须为 P0-2B canonical key）。export：dump 只读 + sales 库（可选 --db）复制 /tmp 副本初始化仅取显示名 + **sha256 零写核验**；候选两路——①loss_signal 命中（ai_label='correct' 预标注）②no_loss_sample 确定性等距抽样负样本（ai_label='wrong'，按 anchor_key 排序幂等，默认 30 条——没有负样本准确率会虚高）；群聊 @chatroom 一律排除（D7 口径）。import：label 非法/evidence_text>200/缺 annotated_by 进失败清单，合法行走 `alertEvalCaseUpsert`（status=confirmed，幂等 upsert），回写后按 alert_type 输出准确率与「推送门 ≥85% 达标」判定。**评测标注页（/eval-annotate）扩展支持告警样本是后续刀**，本刀只做脚本通道。
- **测试**：alert-eval-test **42/42**（新：a1-a6 建表/CHECK 拦截/三维 UNIQUE/幂等 upsert 人机分存；b1-b5 四方法；c1-c7 parseLossSignal 命中 8 例+我方消息/<4 字/正常询价 7 例不误判/detail 上限/表情清洗；d1-d3 B 未接线守卫+competitor 保持接线；e1-e8 export 零写核验+负样本+群聊排除静态检查）；回归 alert-gate 33 + insight-noise 32 + insight-dedup 11 + crm-opportunity 45 + morning-digest 22 + todo-followup 14 + action-rules 36 + message-key 17 全绿。
- **脚本冒烟实测**：export 对真实 sales 库副本跑通（群聊/我方消息正确排除、零写核验通过）；import 到 /tmp 副本新增 1 条 → 二次导入幂等更新 1 条；准确率输出 ✓。⚠️ 冒烟只动 /tmp 副本，live 库零写。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓ / `tsc -b tsconfig.node.json` 产物已重建（salesDbService.js 含 alert_eval_case）。
- **遗留**：人工标注跑量（dump 从应用聊天导出来源化→写导出通道或手动）→ loss 准确率 ≥85% → `ALERT_PUSH_APPROVED.loss=true` + crmParseService 接线三行；评测标注页支持 alert 样本（/eval-announce 扩展）；告警 D 独立设计。

---

## 2.69 审计流水（屏 7）+ 归属留痕时间线（屏 6 右）（2026-09-05，UI设计稿-Phase1-资源分配，已提交）

> **依据**：`docs/UI设计稿-Phase1-资源分配.html` 屏 7/屏 6 右 + 附录视觉红线；契约已定实现照抄——`API-CONTRACT.md §1.14` 的 `crm:audit:query` / `crm:ownership:history`（R 只读，统一信封 `{ok,data}`），数据口径 = 宪法 §1.12 audit_event / §1.8 ownership_history（append-only，无软删列，永不删改）。

- **后端（crmAssignmentService 尾部两查询，与分配链同文件——三表同事务写点就在这里）**：`queryAuditEvents(opts)`——契约参数 entityType/entityId/actor/action/beginAt/endAt/page/pageSize + **keyword 扩展参数**（一把搜 actor/detail/entity_type/entity_id，契约未含但为设计稿「搜索 操作人/对象」所需，超集兼容）；action 类别过滤映射：assign→lead_assign/lead_transfer/lead_claim/departure_handoff，bind→identity_bind，recycle→lead_recycle，**weight 为预留类（action LIKE '%weight%'，批次权重写点上线自动归入）**。`listOwnershipHistory({entityType, entityId, page, pageSize})`——非法参数返回 `{ok:false, 空集}` 不炸。
- **三处同步**：crmIpcHandlers 注册 `crm:audit:query` / `crm:ownership:history`；preload `auditQuery`/`ownershipHistory`；electron.d.ts 类型同步（rows 逐字段定型）。
- **前端屏 7「审计流水」**：新组件 `src/components/settings/AuditTrailSection.tsx/.scss`，挂 **SettingsPage 安全 tab**（线索流转区块之后、应用锁之前——审计与安全同域，侵入最小；独立路由备选未采用）。UI 按设计稿：搜索框（keyword，回车/按钮触发）+ action 五段分段控件（灰底浮起 accent）+ 表格（时间/操作人/动作/对象/细节，数字列 tabular-nums）+ 分页器；区块默认折叠点标题展开（设置页不加长首屏）。**脱敏展示层兜底**：actor/detail 里手机号 `152****5273`、wxid `wxid_8f****de`；detail 是 JSON 时给 `k:v · k:v` 摘要；动作列 pill 五语义（分配绿/绑定绿/回收红/移交琥珀/其余灰）。
- **前端屏 6 右「归属留痕」**：线索详情弹窗（CrmLeadPage）新增只读时间线——openDetail 时并行拉 `ownershipHistory({entityType:'lead', entityId, pageSize:50})`（拉取失败仅不显示，不阻塞详情）；每条按方向推导动词（空→有=分配/有→空=回收/有→有=改派，空侧显示「资源池」），渲染 `谁→谁 · 时间 · 操作人 · 理由`；样式复用 `.lead-timeline/.lt-item` + `.ld-ownhist-hint`（--color-* 族）。
- **视觉红线合规**：新 scss 零硬编码 hex（测试 d6 静态断言），颜色全走 `--color-*`/`--radius-*`/`--shadow-*`，light/dark 自动继承；pill 五语义类内聚在组件 scss。
- **测试**：audit-query-test **26/26**（新：a1-a12 信封/四类别过滤/keyword 搜人·搜细节·搜对象/分页/实体/时间窗；b1-b6 留痕排序·实体隔离·非法参数·分页；c1 查询零写；d1-d7 三处同步+前端挂载+脱敏+零硬编码 hex 静态检查）；回归 assignment-full 71 + assignment 28 + crm-lead 55 + crm-sla-action 11 + identity 25 + lead-assignment-view 32 + lead-sla-reset 18 + sla2 41 + friend-detect 33 + alert-gate 33 + alert-eval 42 全绿。
- **⚠️ 两个存量红测（与本刀无关，git stash 基线复跑同败）**：`assignment-correction-test`（12/5）与 `lead-assignment-restore-test`（6/7）断言的是**live 生产库副本**里历史迁移的精确审计行数（期望 3848），生产数据已自然增长到 11542 → 硬编码期望过期。修复方向=改断言为「≥ 基线行数且幂等不翻倍」或落定快照库，属数据耦合测试的独立修缮，本刀不动。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓ / `tsc -b tsconfig.node.json` 产物已重建（main.js 含 crm:audit:query）。
- **遗留**：屏 6 左「待改派」表格 + 改派建议（负载最低·非原归属）是下一刀；activity_log/auto_confirm_log 封存视图（设计稿口径）未做；权重调整写点（批次功能）上线后自动进审计「权重调整」段。

---

## 2.71 SLA1 三次提醒制（设计稿屏 4/屏 6，2026-09-05，已提交）

> **依据**：`docs/UI设计稿-Phase1-资源分配.html` 屏 4 note「超时提醒，每 24h 复查，第 3 次抄送主管，3 次后自动回收改派（卡上会看到自己处于第几次提醒）」+ 屏 6 留痕时间线「提醒抄送」项；**SSOT 顺序**：先在 DATA-CONSTITUTION §1.3 修订登记 `sla1_remind_count` 列与三次提醒语义，再动代码。上承 §2.54 误扫事故（时间纪律延伸）。

- **宪法 §1.3 修订**：补列 `sla1_remind_count INTEGER DEFAULT 0`（0=未提醒过）入字段清单；登记三次提醒制语义（首/次超时只提醒、满 3 回收、claimed 纳入扫描、20h 间隔护栏、append-only 不受影响）。crmDbService 幂等 ALTER 落列（紧随 sla1_met_at 之后）。
- **回收器改造 `runSla1Recycle`**：扫描范围 `status='assigned'` → **`IN ('assigned','claimed')`**（已认领未加好友同在 24h 计时内，认领不重置 sla1_deadline、沿用分配时起点——设计稿屏 4 第 2/3 张卡语义）；未停表（`sla1_met_at IS NULL`）过期行分流：
  - `count < 2` → **只提醒不回收**：`sla1_remind_count +1` + `audit_event(action='sla1_remind'，detail 含 remindNo/total/deadline)`，assignment 状态/归属/lead 零变更（ownership_history 不写）；
  - **20h 间隔护栏**：已提醒行（count≥1）距上次动作（updated_at）≥ `SLA1_REMIND_MIN_GAP_MS=20h` 才允许下一次提醒——回收器默认 30 分钟轮巡不会一轮把 3 次刷满（§2.54 教训延伸：回收器不凭「行存在即处置」，须尊重计数与间隔状态）；首提（count=0）不受限；
  - `count ≥ 2`（第 3 次超时）→ 才 `recycleAssignment(reason='SLA三次超时回收')`（三表同事务照写）+ 独立事务写 `outbox_event type='sla1_escalate_supervisor'`（idempotency_key=`sla1Escalate:<assignmentId>` 幂等，抄送主管占位，宪法 §1.11 只记录不发送）。
  - 返回值 `{recycled, reminded}`；调度器日志分列「三次超时回收 / 超时提醒」两条。
- **bindLeadWxid 停表零改动**（任务书确认项）：停表后回收器按 `sla1_met_at IS NULL` 扫描条件自然跳过，`sla1_remind_count` 语义即固化。
- **assignmentList（任务书第 4 项）**：`SELECT *` 已天然带出新列，`AssignmentRow` 补 `sla1_remind_count?: number` 类型字段（electron.d.ts），前端 C 任务可直接显示「第 N 次提醒」徽章。
- **OutboxEventType 扩展**：加 `'sla1_escalate_supervisor'`（payload 内 type 字段，表结构零 DDL，宪法 §1.11）。
- **测试**：assignment-full-test **55→79**（E 节按三次提醒制改写 17 断言：首超时只提醒/20h 内不重复提醒/满 20h 第二提/满 3 次回收+outbox 抄送行/claimed 纳入扫描且计时沿用/停表跳过/重跑幂等/回池新行计数归零；G 节误扫现场构造改直插——三次提醒制后回收器首扫不再即回收，构造补齐 §2.54 形态的流水/审计行）；sla2-customer-type-test D11、friend-detect-test F2 断言同步三次提醒口径（41/41、33/33）；回归 assignment 28 + crm-lead 55 + crm-sla-action 11 + identity 25 + lead-assignment-view 32 + lead-sla-reset 18 + audit-query 26 全绿（assignment-correction-test / lead-assignment-restore-test 仍为 §2.69 记录的存量数据耦合红测，与本刀无关）。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓ / `tsc -b tsconfig.node.json` 产物已重建（main.js 含 sla1_remind_count）。
- **⚠️ 行为变化提醒（上线感知）**：① 存量已过期的 assigned 行不再被立即回收，而是进入三次提醒节奏（首扫提醒第 1 次 → ~24h 后第 2 次 → ~24h 后回收）；② 前端后续刀在分配卡上渲染「第 N 次超时提醒」徽章（数据已就绪）；③ 内网同步设计 §3 事件清单需补 sla1_escalate_supervisor 一行（中枢消费时对齐）。
- **遗留**：屏 4 卡片「第 N 次提醒」徽章渲染 + 屏 6 左待改派表（前端 C 任务）；reminder 提醒的触达通道（站内卡流已有，微信推送待 Phase 3a）。

---

## 2.72 线索页三视角改版（设计稿屏 2/3/4/6 左，2026-09-05，已提交）

> **依据**：`docs/UI设计稿-Phase1-资源分配.html` 屏 2/3/4/6 + 附录实现规格；**评审决策：不新建 /allocation 路由，改版现有 /leads（CrmLeadPage）**，避免双页面打架。视角判定沿用 `leadAssignmentView.isSalesView`：销售=屏 4 资源卡；分配员/主管/空身份=管理三页签（资源池/分配控制台/回收改派），空身份=管理视角（现状惯例）。

- **纯函数扩展（leadAssignmentView.ts，屏 4/6 判定与屏 3 预览全部可 tsx 单测）**：`leadPageView`（sales/manager）；`distributePreview(mode, count, sales, weights, loads)`（三模式份额：weight 最大余数法缺省等权 / round_robin 轮询 / load 逐条给在手+本批最少者）；`suggestReassignOwner`（在手最少且非原归属，防循环占位；全同名回空提示手动）；`sla1Countdown`（屏 4 倒计时五档：wait_claim 蓝/ok/warn<4h 琥珀/over 红+「第 N 次提醒」读 sla1_remind_count/done 绿进入第二段）。
- **新 IPC `crm:assignment:assignBatch`（屏 3 核心，三处同步配齐）**：`assignBatchLeads({count, mode, weights, actor})`——待分配池 SQL 一次取（NEW 且无当前有效分配行，回收行天然回池）；份额规划 `buildDistribution`（service 导出，与前端 distributePreview **同口径双实现**，assignment-full-test H10 断言逐模式一致防漂移）；逐条走现有 assignLeads（单条事务失败落 skipped 不阻塞）；批次审计一行 action='lead_assign_batch'（detail 含 mode/assigned/perSales/weights），**批次号='#A'+审计行号，不建新列**（设计稿屏 3 口径）；空池 E301。mode 落 assignment.mode。权重存 config `crmAssignWeights`（CONFIG_KEYS+ConfigSchema+默认值三处），执行时随批次审计留痕（C 类操作可追溯）。
- **导入审计补写**：`importLeads` 事务内落 `audit_event(action='lead_import')`（detail 含 batchId/total/valid/duplicate/invalid）——屏 2 蓝横幅数据源（任务书口径：导入写点缺 audit 行则补上）。
- **屏 2 资源池**：四统计卡（待分配/已分配·待认领/跟进中/已回收，26px/700 tabular-nums，点击=分段筛选）+ 蓝横幅（最近导入批次统计，audit 驱动）+ 分段列表（待分配/已分配/跟进中/已回收，回收行标记「回池」）+ 搜索/来源/标签筛选 + 表格列按设计稿（联系方式脱敏+wxid 小字/来源/需求标签 pill/备注/入池时间/入池方式/操作）。⚠️ **入池方式为展示层近似**（lead↔import_batch 无外键列）：created_at 与最近导入审计时刻 <10 分钟显示「批次 #Axxx」否则「存量导入」，正式批次联动需后续加列。
- **屏 4 销售资源卡**：待认领/跟进中/已回收分段 + 卡片（脱敏联系方式+状态 pill 五语义 / 来源·标签·备注·分配时间 / 倒计时区 ok·warn·over·done 四色档 / 操作按钮：认领（复用 claimTarget 弹窗）、绑定微信（复用 bindTarget 弹窗）、已加好友=查看对话）。倒计时读 sla1_deadline+sla1_remind_count（上一刀数据就绪）。
- **屏 6 左 待改派表**：最新分配行 recycled 的线索列表（线索/原归属/回收原因=lead_recycle 审计 reason/建议改派人=在手最少且非原归属+在手数/确认改派按钮）。⚠️ **确认改派走 assignLeads（回池再分配）而非 transfer**——transferAssignment 仅限 assigned/claimed 行（E201），recycled 行语义上已在资源池，回池再分配即现有同事务写路径；原归属在建议人选择中被排除。
- **前端数据流**：fetchAll 增拉 assignmentList 原始行（latestAsg 映射判 recycled/在手计数/销售卡 SLA 字段）+ auditQuery 三路（lead_import/lead_assign_batch/lead_recycle→原因映射）；权重 getCrmAssignWeights/setCrmAssignWeights（src/services/config 新增）。
- **测试**：assignment-full-test **79→91**（H 节 assignBatch：权重 50/30/20→5/3/2、批次号/审计行/mode 落列、clamp 取池、轮询均分、负载均衡执行=规划器口径、空池 E301、**前后端份额函数逐模式一致**、lead_import 审计行）；lead-assignment-view-test **32→48**（G 节三视角/三模式预览/建议人选/倒计时五档）。回归 assignment 28 + crm-lead 55 + crm-sla-action 11 + identity 25 + lead-sla-reset 18 + sla2 41 + friend-detect 33 + audit-query 26 + alert-gate 33 全绿。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓ / `tsc -b tsconfig.node.json` 产物已重建（main.js 含 assignBatch）。
- **遗留**：屏 6 左「3 次超时未加」pill 与提醒抄送语义的中文映射已由 sla1_remind 链路供数；入池方式精确化（lead.import_batch_id 加列）与批量导入横幅「查重报告可下载」属后续刀；权重调整的独立审计写点（当前随批次审计留痕）。

---

## 2.73 告警 D「承诺打款日过期」payment_overdue + payment_promise 承诺登记表（2026-09-05，设计-AI见解重定位 §4.2 D，已提交）

> **依据**：设计-AI见解重定位 §4.2 告警 D（目录 v1 最后一个：全新机制 = 聊天里识别未来日期承诺 + 到期扫描比对 payment_record）；**SSOT 顺序**：先在 DATA-CONSTITUTION §3 登记 `payment_promise`（字段/写者/删除规则/幂等键）再建表。任务口径：客户明确承诺付款时间（「下周打款」「月底付款」），日子过了 payment_record 没有对应到款 → 走链提醒；沿用告警 A 全部既有机制（§2.67 四道闸），不发明新轮子。

- **新表 `payment_promise`（crmDb，SCHEMA_SQL 幂等 CREATE + ENTITIES 白名单注册）**：`account_id`（NOT NULL）/ `session_id`（承诺原话所在会话——createAlert 四道闸证据回查契约必填，故为登记必填项）/ `lead_id` 可空 / `promise_text`（客户原话快照 ≤200 字，§1.10）/ `due_date`（承诺日，存当日 0 点毫秒）/ `evidence_key`（承诺原话 canonical messageKey）/ `status` CHECK('pending','kept','overdue','cancelled') / `source`（默认 'llm'）/ 通用五列。幂等键 **UNIQUE(account_id, evidence_key)**（同一条客户原话只登记一次，消息重扫幂等）；扫描索引 (status, due_date)。写点单点 = `crmPaymentPromiseService`（登记 + 状态流转同事务写 audit_event；crmParseService 与其他模块零直写，测试 i5 静态守卫）。
- **新服务 `electron/services/crmPaymentPromiseService.ts`**（仿 crmSla2LlmScanService 依赖注入模式，纯函数可单测）：
  - **候选窄口径** `isPaymentPromiseCandidate(text, isSend)`：isSend=0 限定、[表情] 清洗、<4 字跳过、按句切分后**同一句**内同时命中付款动词（打款/付款/转账/汇款/打钱/付钱/结款/付定金尾款全款）+ 时间词（明天/下周X/周X/月底/N天后/发工资后/过完年/X月X日…）才算候选——候选只负责省 LLM 调用，是否真承诺由 LLM 判；
  - **LLM 解析**（temperature 0.2，responseFormatJson）：输出 `{is_promise, confidence, time_kind, weekday, date}`，time_kind ∈ tomorrow/days_later/weekday/next_week/month_end/specific_date/none；`parsePaymentPromiseResponse` 非法 kind / 坏 JSON → null；
  - **日期推算全本地确定性**（`resolveDueDate`，不信任 LLM 算术）：明天=次日 0 点；周X=1-7 天内最近 upcoming；下周X=下个自然周（下周一+X-1）；月底=当月最后一天；具体日期严格 YYYY-MM-DD 回验（2026-02-30 拒）；**落过去（≤ 消息当日）/超 400 天视野/解不出 → 0 = 不登记（宁缺毋滥）**；
  - **登记** `registerPaymentPromise`：证据锚点强制——evidenceKey / promiseText / sessionId 缺任一整条丢弃（no_evidence/bad_input）；`processPaymentCandidate` 全链任一环不达标零写入（AI 未配置零调用 / 解析失败 / is_promise=false / **置信 <0.6** / 日期解不出）；
  - **到期扫描** `runPaymentPromiseScan`：`status='pending' AND due_date < 今日 0 点`（承诺日整天过去才算「已过」，月底当天全天仍属承诺期）→ 查该账户**登记之后**（pay_time/created_at ≥ promise.created_at）有无到款（只读三路归因：allocation.account_id 挂链 / 付款方名直配 account.name / 付款方命中 alias_map——**payment_record/allocation 零写入**，测试 i8 静态守卫）：有 → `kept`；无 → `overdue` + `alertService.createAlert({type:'payment_overdue', messageKey: evidence_key, evidenceText: promise_text, message: 含承诺日+原话快照})` 四道闸；流转带 `AND status='pending'` 守卫（重跑幂等）+ audit_event(action='payment_promise_mark')；
  - **调度器** `startPaymentPromiseScanScheduler`：**每日一次，跟随周复盘定时器时段**（20:00-20:30 窗口 + 30min tick + scan_state `paymentPromiseScan:<YYYYMMDD>` 每日标记防重启重扫）。
- **告警 A 机制沿用（零新轮子）**：`ALERT_PUSH_APPROVED.payment_overdue: false`（评测 ≥85% 前门关——gate_closed 零副作用，连证据校验/去重查询都不做）；72h 幂等走 `hasRecentAlert('alert:payment_overdue')`；门开落 insightRecord（sourceType='insight'）进信箱 + 卡流（salesActionEngine `alert:` 前缀合流分支现成可用，type 变体零改动）。
- **识别挂钩 `crmParseService`**：私聊扫描循环（群消息链不动）竞品告警命中点之后，`isSend === 0 && accountId && isPaymentPromiseCandidate(textForSignal, 0)` 才 `await processPaymentCandidate(...)`（accountId=0 无名 session 天然不登记；messageKey 复用上游 canonical key 不现场拼；LLM 出口 = simpleCompletion temperature 0.2，AI 未配置整链静默跳过）。
- **评测配套 `alert-eval.ts`**：`--alert-type payment_overdue` 走既有 export/import 通道——候选① = isPaymentPromiseCandidate 命中（candidate_source='payment_promise_candidate'，ai_label='correct' 预标注）② = no_promise_sample 确定性等距负样本；⚠️ 评测对象是**候选正则**的查准/查全（LLM 环节不参与导出，无 API 依赖，同 loss 口径）；import 准确率速览按导入行 alert_type 分组（payment_overdue 独立达标，不与 loss 混算）。
- **明确不做（任务书口径）**：不做推送文案 UI、不改屏 5 右、不动 payment_record 任何写路径。
- **脱敏前置（宪法 §2.6）**：出机文本唯一出口 = `buildPaymentPromiseUserPrompt`（内部强制 maskPrivateText 后截 200 字 + 消息日期行），测试 i7 静态守卫「llm(PAYMENT_PROMISE_SYSTEM, buildPaymentPromiseUserPrompt(...)) 为唯一调用点」+ f 节运行时断言手机号/wxid 打码。
- **测试**：alert-payment-test **103/103**（新：a1-a8 宪法登记先于建表静态断言；b1-b6 建表/CHECK/UNIQUE/登记幂等；c1-c4 候选正则命中 10 例+我方消息+不误判 9 例；d0-d9 识别链七环零写入门+成功登记+幂等；e1-e8 due_date 解析性（明天/下周X/周X/月底/具体日期/N天后/非法与超视野）；f1-f3 脱敏；g1-g5' 证据锚点强制；h1-h9' 到期扫描全链（门关零副作用/门开落记录/kept 三归因/登记前到款不算/未到期不动/重扫幂等/72h 幂等/证据验不出丢弃/audit 留痕）；i1-i12 接线静态+调度窗口）；回归 alert-gate 33 + alert-eval 42 + crm-opportunity 45 + payments-claim 18 + crm-golden 47 + message-key 17 + customer-event 16 + insight-noise 32 + sla2-llm-scan 26 + sla2-customer-type 41 + morning-digest 22 + action-rules 36 全绿。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓（dist-electron/main.js 含 payment_promise）/ `tsc -b tsconfig.node.json` 产物已重建 / alert-eval.ts CLI 冒烟（payment_overdue export 正负样本+零写核验 ✓）。
- **遗留**：payment_overdue 离线评测跑量（dump 导出→人工标注→准确率 ≥85%）→ 开 `ALERT_PUSH_APPROVED.payment_overdue=true` 即全链生效（代码零改动）；承诺到期前客户主动取消/改期的入口（cancelled 状态已预留，writer 待人工通道）；评测标注页（/eval-annotate）支持 alert 样本展示（§2.68 遗留延续）。

---

## 2.74 评测标注页告警样本页签（/eval-annotate 支持 alert_eval_case，2026-09-06，已提交）

> **依据**：§2.68 遗留「评测标注页支持 alert 样本」+ §2.73 遗留「payment_overdue 离线评测跑量的人工标注入口」。标注页从单一商机样本升级为**两页签**（商机样本 / 告警样本并存，cws-tabs 全局分段控件同款）。SSOT 纪律：读写全走 salesDbService.alertEvalCase* 既有五入口，零新表零新写路径（只读为主）。

- **页签切换（EvalAnnotatePage）**：header 下方 `cws-tabs` 两页签（带各自「已标 X / 共 Y」计数）；商机页签行为零改动（生成按钮/进度统计/EvalCard 卡流原样）；标注人输入框两页签共用（localStorage 记住）。
- **告警样本页签**：
  - **列表行**（AlertRow，轻量行式 vs 商机卡）：类型 pill（**competitor=竞品提及 / loss=客户流失 / payment_overdue=承诺打款过期** 中文映射，三类型语义 tint 全 token：danger/warning/success 系）+ 会话显示名（customer_profile 兜底 session_id）+ session_id + `evidence_text` 原话快照 + **「证据可回查」标识**（有 anchor_key 即显示，hover 出完整锚点；回查交互不做）+ 人工三档按钮（**告警成立 correct / 不成立 wrong / 不确定 uncertain**，DB CHECK 同口径）。
  - **防锚定沿用商机口径**：待标注行 AI 预标注只显「AI 已预判（标注后可见）」占位不显值；标注后展开 AI 判断 + 与人工一致/不一致徽章。
  - **队列过滤**：待标注（pending/prelabeled）/ 已标注（confirmed）二分；标注写回成功后行就地更新并退出待标注队列（已标注页签可查）；已标注沉底排序与商机页一致。
  - **统计行（≥85% 开门判定直接读数）**：按 alert_type 分组（类型集取自库内数据）——`已标注数/总数` + `人机一致率 X%（agree/compared）` + **达标/未达标徽章**（≥85% 绿）。**口径：分母只算人工已标（confirmed）且非「不确定」且有 AI 预标注的样本**（人工标 uncertain = 人机都拿不准，计入分母会虚增；无 ai_label 不可比对）。
- **后端（evalService 扩展告警评测域）**：`alertEvalListCases()`（附展示名 + 待标注在前已标注沉底）/ `alertEvalLabelCase(id, label, annotatedBy)`（import 式幂等 upsert：三档守卫/标注人必填/记录存在校验，**ai_* 与人工字段互不覆盖**——upsert 只动显式传入字段）/ `computeAlertAnnotateStats(rows)`（**纯函数**，tsx 可单测）+ `alertEvalStats()`（读库走纯函数）。IPC 三端点：`eval:alert:list`（只读）/ `eval:alert:label`（写库，enqueueSalesTask 串行铁律）/ `eval:alert:stats`（只读）；preload `alertList/alertLabel/alertStats` + src/types/electron.d.ts `AlertEvalCaseRow/AlertEvalStats` 同步。
- **测试**：alert-annotate-test **46/46**（新：A1-A14 静态接线（页签/映射/三档按钮/证据标识/防锚定/开门读数/队列过滤/三端点+enqueue 铁律/preload+d.ts/既有五入口零直写/样式零硬编码 hex）；B1-B7 列表读路（展示名/沉底/待标注队列消失语义）；C1-C5'' 写回幂等（同 id 零新增/改标胜出/非法 label/空标注人/不存在记录全拒绝）；D1-D2 ai_* 互不覆盖；E1-E10'' 统计口径（分组/分母排除 uncertain 与无 ai_label/一致率数学/17:20=85% 恰好达标+16/19=84% 未达标边界/agreeRate null 不冒充 0%/服务端与纯函数同口径））；回归 alert-gate 33 + alert-eval 42 + crm-opportunity 45 + alert-payment 103 + insight-noise 32 + message-key 17 + customer-event 16 + sla2-llm-scan 26 + payments-claim 18 + crm-golden 47 全绿。
- **⚠️ 存量红测（与本刀无关）**：eval-annotate-test 20/2（A1/A6）——git stash 基线复跑同败：live 候选池已饱和（inserted=0）且无新增报价信号（quote=0），A1/A6 硬编码「必须新增」断言与 live 数据状态耦合（同 §2.69 assignment-correction/lead-assignment-restore 性质），待数据耦合测试独立修缮时一并处理。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓（dist-electron/main.js+preload.js 含 eval:alert 桥接）/ `tsc -b tsconfig.node.json` 产物已重建（evalIpcHandlers.js 含 eval:alert:list）。
- **遗留**：告警行「证据可回查」点击回查交互（复用 sales:evidence:getByKey，P0-2B 通道现成）；告警候选应用内刷新按钮（当前由 alert-eval.ts import 通道产出，页签文案已注明）；eval-annotate-test 数据耦合断言修缮（见上）。

---

## 2.75 前端体验遗留四项合并刀（2026-09-06，单 commit 逐项可独立回滚，已提交）

> **依据**：任务书四项遗留（客户页搜索分页 §2.75 / 行动卡直接完成待办 / 合同详情子列表归属收敛 §2.74 遗留 / 复盘页限宽 §2.41 遗留）。红线：零硬编码 hex、--color-* 族、双模式自动继承；测试不新建脚本（断言补进既有四套）。

- **① 客户页搜索结果分页（CustomerWorkspacePage）**：搜索态结果从手铺行列表改接 `SearchTable` 骨架（合同工作台试点复用）——受控分页 `searchPage` state + 筛选（关键词/阶段）变化回第 1 页 + `pageSize=10` + Pager（≤1 页自动隐藏）；空态文案保留（`emptyText="无匹配客户"`）；行可点开档案（onRowClick→openCustomer）；列 = 客户（头像+名+公司双行单元格 `.cws-search-cell`）/ 阶段 pill / 最近互动。`.cws-search-row` 旧样式保留（`__silent` 类复用）。
- **② follow 卡「完成待办」次级入口**：行动队列 follow 卡（已有「去聊天/已处理」）对**有 pending 待办的客户**加第三按钮——`pendingTodoIdOf(it)` 从卡片 task 源解析 `rawTaskId`（getUnifiedSignals 自带，P0-4.2.1 correlation），`>0` 才渲染（**不可完成时入口不出现**）；点击复用现有 todo 完成 handler `sales.todoUpdate(id,{status:'done'})`（与今日行动页 completeTodo 同一 IPC，**零新 IPC**）→ dismissCard 卡片退出队列 + fetchAll。已有「已处理」（actionCompleteUnified 信号闭环）不被动。
- **③ 合同详情子列表归属收敛（CrmWorkbenchPage select()）**：报价单/发票/物流三子列表接同一 `filterByOwner(rows, identity)`（ByOwner 直接复用，主行已挡、子表补齐）。真实泄漏点 = logistics（owner_sales 列 = 认领销售，他人认领的物流可经收货人自动链接到我的合同）；quotation/invoice 无 owner 列（归属继承主合同）→ filterByOwner 下自然全过，三列表口径统一、未来加列即自动生效。回款归属（allocation.sales_name）不在本刀范围（任务书点名三表）。
- **④ 复盘页限宽居中（SalesReportPage.scss .sr-page）**：加 `max-width: 1280px + margin: 0 auto + width: 100%`——⚠️ 任务书写 1200px 但定语「与七页其余六页一致」为准，六页组单一真源在 main.scss（1280px），取 1280 避免第七种宽度。全高滚动布局保留（height:100% + 内层 .sr-page-body overflow-y:auto 滚动条随列宽收窄）。**肉眼验证已做**：vite dev 真实编译管线（main.scss+SalesReportPage.scss）harness @1600px 视口——几何实测 `.sr-page` width=1280 / left=160（恰好居中）+ 截图确认；dev 实例业务库零写入核验（audit_event 当日 0 行 / follow_up_task 最大时间戳早于窗口 / payment_promise 0 行幂等 DDL；与昨日自动备份的行数差全部对应用户昨日晚间正常使用，见 §2.69 记录的 11542）。
- **测试（断言补进既有四套，零新脚本）**：customer-workspace-simple **27→37**（c1-c10：SearchTable 接线/每页 10+受控分页/回第 1 页/空态保留/行点开 + 完成待办入口 rawTaskId 门控/不可完成不渲染/todoUpdate 复用/退队列/已处理保留）；owner-filter **25→28**（d1-d3：三子表 filterByOwner 接线 + logistics 行级过滤运行时（他人挡/空串与 null 可见）+ 无 owner 列全过）；crm-workbench **50→53**（11a-11c：三子表接线静态/select() 读路/allocation 不扩围）；report-review **33→37**（D1-D4：限宽三件套/全高滚动保留/零硬编码 hex/与六页组同宽）。回归 alert-gate 33 + alert-eval 42 + crm-opportunity 45 + alert-annotate 46 + alert-payment 103 全绿。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓（CustomerWorkspacePage chunk 含 SearchTable+完成待办、SalesReportPage css 含 max-width:1280px）/ electron 产物 `tsc -b` 全量重建（本刀零 electron 源改动）。
- **遗留**：证据回查点击交互（§2.74 遗留延续）；告警候选应用内刷新；eval-annotate-test 数据耦合断言修缮。
---

## 2.76 数据/测试侧遗留三项 + eval-annotate 口径修复（2026-09-06，单 commit，已提交）

> **依据**：任务书三项（§2.69 存量红测修复 / §2.71 入池方式精确化 / §2.72 权重独立审计）+ 追加（§2.74 遗留 eval-annotate-test A1/A6 同类 live 数据耦合）。SSOT 纪律：新列先入 DATA-CONSTITUTION §3 登记（lead.import_batch_id + assignment_weight_change 审计动作两行，§1.4 同步补列注记）再动代码；测试 /tmp 副本隔离零碰 live。

- **① 存量红测修复（改口径不绑死精确数）**：assignment-correction-test **12/5→17/17**、lead-assignment-restore-test **6/7→14/14**。新口径 = 「≥ 基线快照值 且 重跑幂等不翻倍」，基线值（2026-09-05 live 首验 3,848）进脚本头注释常量并写明漂移原因（回收器每日继续回收 append-only 只增不减 / §2.71 三次提醒制后过期行在提醒期内保持 assigned 属合法态——A4 随之改「期限列非空」/ 恢复首跑已在 live 真实执行，副本重跑属幂等重入）。语义修正两处：correction D1 的 alreadyAssigned 对齐误回收行总数（非当前 assigned）；restore 的留痕断言 ≥ 基线 + r1/r2 前后零新增。
- **② lead.import_batch_id（入池方式精确化）**：宪法 §3 登记（列语义=导入批次回溯，逻辑外键 → import_batch.id；**写者=importLeads 单点**；**存量=NULL** 不回填；随 lead 生命周期删除）→ crmDbService 幂等 ALTER（双路径：独立于 lead DROP 重建块之后，保证重建后列必在）→ **importLeads 回填**（同事务先建 import_batch 行拿 id，逐行回填，批次计数插入完成后一次 UPDATE——外部只见最终值）。线索页「入池方式」改读真列：`import_batch_id > 0 → 批次 #A<id>`；**NULL 回退旧时间近似判定**（贴最近导入审计 <10 分钟），不炸存量。electron.d.ts LeadRow 补字段。
- **③ 权重调整独立审计（assignment_weight_change）**：写点选**侵入最小的 main.ts `config:set` IPC 拦截**（key==='crmAssignWeights' 时取改前值，写库后落 diff 审计——零新端点、前端零改动；crmDb 未就绪或 diff 为空静默跳过，审计失败不阻塞配置保存），detail = 前后权重逐 key diff + actor=身份档案姓名。屏 7 审计流水「权重调整」段从 `LIKE '%weight%'` 预留改精确匹配 `weight: ['assignment_weight_change']`（死分支移除）。
- **④ eval-annotate-test A1/A6 口径修复（20/2→23/23）**：A1 注入全新非群聊会话使生成在饱和池上非空转 → 断言「inserted ≥1 且与副本真实新增行数一致」（不再断「必须新增」）；A6 只断报价信号路在 crm 副本上工作（quoteSkipped=false），池饱和不新增属幂等正常。
- **测试（断言补进既有套，零新脚本）**：audit-query **26→28**（a5 改精确匹配 + 种子加权重审计行；a1/a9 total 5→6；d5-d6 main.ts 拦截静态 + LIKE 预留分支已移除）；crm-lead **55→59**（5i-5l：首批行回填 batchId / lead_import 审计同批 / NULL 存量语义置空读回 / 页面读真列+回退静态）。
- **验证**：tsc root 0 / node 158 基线零新增 / assignment-full **91/91** + audit-query **28/28** + 全套回归（crm-lead 59、correction 17、restore 14、eval-annotate 23、alert-gate 33、alert-eval 42、crm-opportunity 45、alert-payment 103、alert-annotate 46、crm-golden 47、customer-workspace-simple 37、sla2-llm-scan 26）全绿 / vite build ✓ / electron 产物 `tsc -b` 全量重建（4 文件含新代码）。
- **遗留**：批量导入横幅「查重报告可下载」（§2.72 遗留另一半，未在本刀范围）；屏 6 左入池方式徽章渲染（§2.72 前端 C 任务延续）。

## 2.77 设置页「傻瓜式」导航层（2026-09-06，单 commit）

> **依据**：设计稿 `docs/UI设计稿-设置页简化.html`（屏 1 常用页 / 屏 2 高级设置二级页 / 附录对照表）。**最高铁律：11 主 tab + AI 5 子 tab 的内容组件一行不改、逻辑不动、配置键不换——本刀只加导航层，改法是在 SettingsPage 外面加壳，不是重写它**（SettingsPage.tsx 零改动）。

- **结构（三件全新增，App.tsx 两处换壳是唯一既有文件改动）**：
  - `src/utils/settingsNav.ts`：导航状态机纯函数（`navInitial` / `navOpenAdvanced` / `navOpenTab` / `navBack`，零 import 可单测）。三视图 `common | advanced | tab(from)`；返回链 = tab → 进来那层 → common。
  - `src/pages/SettingsNavShell.tsx`：外壳。**常用页（默认视图，屏 1）**四卡 + 底部「高级设置」入口；**高级设置二级页（屏 2）**三组行；**tab 视图裸挂 `<SettingsPage onClose/>`**——SettingsPage 自带全屏 modal 框与关闭按钮，外壳 chrome 让位避免双层壳。
  - `src/pages/SettingsNavShell.scss`：新样式全走 `--color-* / --radius-* / --shadow-*` 前进 token 族（DESIGN-SPEC-MINI 红线：新代码禁旧 `--bg-*/--text-*` 族），零硬编码 hex；`SettingsPage.scss` 一行未动，`.switch`/`.message-toast`/`.settings-inline-modal`/`.settings-modal-overlay` 等直接复用。
  - `App.tsx`：`lazy(() => import('./pages/SettingsNavShell'))` 替换原 SettingsPage 懒加载声明 + 挂载点包 `<Suspense fallback={null}>`；深链消费方从 SettingsPage 原样换成壳。
- **常用页四卡全部复用现有键与写入函数（不造第二份）**：外观=外观 tab 同一 `useThemeStore.setThemeMode`（echotrace-theme 持久化）；通知=`configService.get/setNotificationEnabled` + `get/setNotificationFilterMode`（「只收白名单」开关映射现有三值枚举：开=whitelist、关=all，blacklist 模式走高级「通知细节」）；安全=只读状态（`auth.verifyEnabled` + `auth.isLockMode`，文案与安全 tab 同款）+「去设置」跳 security tab（开启/改密/关闭的密码流程不复制）；我是谁=`identity.get/set` + 最简弹层（姓名 + 角色四选一，选项与 SettingsPage「身份档案」内联枚举 ''/销售/主管/分配员 一致）。常用页每次进入重读配置，从 tab 返回不残留旧值；写入走同一键，SettingsPage 挂载时自会读到最新值。
- **高级设置二级页 11 行三组**：AI（AI 设置→aiCommon / API 服务→api / 模型管理→models）、数据（数据库连接→database / **审计流水→security**（AuditTrailSection 现挂安全 tab，原样保留；不按角色显隐——页面过滤档纪律：角色只过滤数据不做功能门禁）/ 缓存→cache / 自动下载→autoDownload（沿用 filteredTabs 的 win32+x64 平台门控））、系统（防撤回→antiRevoke / 通知细节→notification / 分析→analytics / 关于→about）。点行 = `navigate('/settings', { state: { backgroundLocation, initialTab, navFrom } })` **复用 SettingsPage 现有 initialTab 深链机制（零改动）** 进原 tab，返回到高级页再返回到常用。
- **深链/默认**：打开设置默认进常用页（新用户友好）；外部直达入口保留——侧边栏「设置应用锁」`initialTab:'security'` 直达安全 tab（from=common，返回回常用页）。浏览器返回键在设置多视图间的历史栈行为为 dev-only quirk（Electron 无可见返回键）。
- **有意偏离（两条，均有据）**：① 设计稿安全卡「自动锁定」——现有代码无此配置键、无此行为，按铁律不造新键不造新逻辑，不放该行（待后续独立刀先入宪法 §3 再建）；② 高级行数：任务书写「12 行」，设计稿屏 2 实为 11 行（AI 3 + 数据 4 + 系统 4），按屏 2 实施。
- **测试** `scripts/settings-nav-test.ts`（**59/59**，`npx tsx`）：静态断言 A1-A9（App 换壳 / 四卡渲染与现有键复用清单 / 零直写 config 键 / 高级 11 行三分组且行 id ⊆ SettingsTab / 17 个 render 映射 + 11 主 tab + 5 AI 子 tab 防误删 / 返回链与深链保留 / 新样式零 hex 且只消费 --color-* 族 / 审计流水指向 security + 无角色门禁 / 角色枚举一致）+ 状态机纯函数 B1-B8（默认常用页 / 深链直达 / 逐级返回 / 幂等）。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓（SettingsNavShell chunk 正常产出，SettingsPage 代码并入壳 chunk）。
- **遗留**：light/dark 双模式真机目验（本机无法启动 Electron GUI，样式全部走 token 双模式自动继承）；「自动锁定」待独立刀（先入 DATA-CONSTITUTION §3 登记再建）。

## 2.78 商机/漏斗/合同/跟单中心四页简化（2026-09-06，单 commit）

> **依据**：设计稿 `docs/UI设计稿-四页简化.html`（屏 1 商机 / 屏 2 漏斗 / 屏 3 合同 / 屏 4 跟单中心 + 附录对照表）。**铁律：零后端改动、零口径改动、图表只折叠不删除、纯展示层重组**（electron/ 目录零改动，四个页面全是既有数据源与既有交互的重新编排）。

- **屏 1 商机 `OpportunityPage.tsx`**：① 4 统计卡收成一行小字摘要 `活跃 N · 决策中 N · 金额待确认 N`——「金额待确认」琥珀可点（`pendingOnly` 开关筛 `amount<=0` 行，再点取消，与阶段筛选叠加），**¥304 亿这类金额脏数据大字从首屏消失**（`stats.totalAmount` 不再渲染，口径与接口零改动）；② 漏斗图 + 点击筛阶段不动；③ 列表行 8 样减到 4 样（`.opp-row`：头像+客户名 / 副行 产品×数量·最近信号 / 阶段 pill / 金额——无金额显示灰字「金额待确认」），行内无按钮整行点开详情，**意向度分数条从列表撤进详情弹窗**；④ 详情弹窗重排：顶部蓝块「AI 建议下一步」（新纯函数 `src/utils/oppNextStep.ts` 投影：风险预警命中→显示风险+建议介入（严重度最高优先）→ 否则意向评分最高权重因素（|delta| 最大）一句 → 否则按阶段兜底引导；**零 LLM 零新接口**），下方 意向评分依据（含分数条）/风险预警/商机事件依次默认展开。
- **屏 2 漏斗 `SalesFunnelPage.tsx` + 新纯函数 `src/utils/funnelSummary.ts`**：顶部一句人话摘要——窗口内转化率最低的相邻段（数据与漏斗同口径：`conversion` + `funnel` 计数，不新造口径），「近 N 天：X → Y 掉得最多（A 个 X 只 B 个进了 Y）。重点看「X」阶段的客户是不是没人跟。」days=0 → 「全部历史」；from 档全 0 不伪造结论返回 null。「每天进入各档位」堆叠图收进 `.funnel-fold` 折叠区（默认收起，`trendOption` 原样渲染）；快照卡 + 7/30/90/全部切换不动。
- **屏 3 合同 `CrmWorkbenchPage.tsx`**：顶部统计卡收成一行 `本月到账 ¥X · 待签 N · 预警 N`（本月到账沿用 `statsOverview.monthPaid` 口径；待签/预警从销售视角名单 `myWorkbench`（filterByOwner 后）计数；预警非零才 `is-hot` 红色）。「📊 数据看板」折叠区默认收起：到款趋势图 + 客户阶段分布图 + AI 准确率 + 原 4 统计卡**原样**收进（零删除，展开原渲染）。合同 SearchTable（含回款进度条列）+ 子资源四块 + 甲方开票信息不动。
- **屏 4 跟单中心 `CrmReviewPage.tsx`**：顶部「今天要办」摘要行 `N 笔今日到款待认领 · N 单物流待签收 · N 张发票待开`（今日待认领 = 现有 `claimablePayments` 口径 + `pay_time` 落今天（与按天分组同一 `dayStartOf`）；物流待签收 = `logiLinked`；发票 = `queues.invoices`——零新查询零新接口）。「⚙️ 管理」折叠区默认收起：扫描群聊设置区（原物流 tab 内迁出，两 tab 通用）+ 销售团队管理（原 header 弹层改折叠区内联，`.sales-team-drop--inline`，功能原样）。**8/24 拍板的认领三区 + 按天分组 + 7 天一页全部不动**；款项认领/物流跟单分 Tab 不动。
- **owner 过滤四页全部保留**（`filterByOwner`/`isSalesView` 取数路径一行未动，测试逐页断言）。
- **视觉**：折叠行样式抄客户工作台 `.cws-fold`（每页自含类 `.opp-` 无 / `.funnel-fold` / `.crm-fold` / `.review-fold`，lazy chunk 不跨页依赖），verdict 蓝块 = `--color-accent-bg` + `b` accent；全部 `--color-*/--radius-*/--shadow-*` token，零硬编码 hex；旧行样式（`.opp-card` 等）随重组移除。
- **测试（断言补进既有四套，零新脚本）**：crm-opportunity **45→56**（6a-6k：摘要行/待确认筛选/四样行/分数条进详情/蓝块+投影优先级动态断言/漏斗筛选与 owner 过滤保留）；funnel **40→48**（6.1-6.5 真实库造数据验证最低转化段识别 + 4.5-4.7 纯函数边界：from 全 0 不伪造/null/并列取先）；crm-workbench **53→57**（12a-12d：三数行/销售视角计数/看板折叠默认收起零删除/列表子资源不动）；payments-claim **18→20**（A14 今天要办三计数来源、A15 管理折叠区功能原样）。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓ / 回归 crm-lead 59 + crm-golden 47 + lead-assignment-view 56 + settings-nav 59 全绿；electron/ 零改动。
- **遗留**：四页 light/dark 真机目验（dev server 已起，样式全 token 继承）；商机「AI 建议下一步」文案投影为展示层启发式，未来接 LLM 须走既有 insightService 通道（本刀明确不做）。

## 2.79 Hermes 刀 1 知识治理底座 + 刀 2 采用率埋点（2026-09-06，单 commit，同批落地）

> **依据**：`docs/设计-Hermes-MVP.md` 刀 1（2.3+2.7）+ 刀 2（2.6）。**PRD 铁律：埋点与 Hermes 同天上，不许后补——两刀同一 commit**。顺序铁律：先在 DATA-CONSTITUTION §3 登记（knowledge_base 治理列 + proposal_event 两行）再动 schema；红线：enqueueSalesTask 只加最外层入口写库端点（`sales:kb:review` 一处，被调函数内部零 enqueue）。

- **刀 1 知识治理（salesDbService）**：`knowledge_base` 幂等 ALTER 加 7 列——status（staging/published/rejected，NOT NULL DEFAULT staging）/authority（official/community，默认 community）/version（INT 默认 1）/ttl_date（可空）/reviewed_by/reviewed_at/reject_reason（SCHEMA_SQL 同步建新库全列 + idx_kb_status）。**存量迁移双通道**：ALTER ADD COLUMN DEFAULT 背填（主通道，219 条上线即 staging/community）+ `migrateKnowledgeGovernance()` 显式幂等清扫（只补 NULL/空串，已审定行零踩踏，可重入）。**kbReview 状态机唯一治理写点**：staging→published｜staging→rejected 跨态一律拒绝；拒绝必填拒因（写 reject_reason 沉底留档不删）；发布/拒绝写 reviewed_by/reviewed_at，发布可置 authority=official；审核人缺失拒绝（宪法 §1.12 署名口径）。kbCreate 显式落 staging/community（人工/CSV/话术提炼一律先审后发布，AI 永不发布铁律）。
- **刀 2 proposal_event（salesDb，宪法 §3 append-only）**：`event_type` CHECK(proposal/knowledge/action) + `stage` CHECK(generated/viewed/accepted/modified/rejected/expired，expired 占位本批无写点) + entity_type/entity_id（account_info=`<accountId>:<field>`、knowledge=id、follow_up_task=id）+ actor + created_at；**无 UPDATE/DELETE 方法**（§2.2 例外同款）。守卫 `shared/proposalEvent.ts`（TS 层 + DB CHECK 双拦截，仿 customerEvent 先例）。**写点帮助层 `proposalEventTracking.ts`**：吞错不阻断业务主语义 + viewed 每实体只记一次（proposalEventEntityIds 去重，防卡流轮询刷屏）+ actor=身份档案 actorLabel（未建档「未署名」不伪造）。
- **三写点 + generated/viewed 挂钩**：① applyInfo accept/reject → proposal/accepted|rejected（`crmDbService.applyInfoField` 双分支，仅裁决成功后记，跨库写 salesDb 逻辑外键）；② 知识审核发布/拒绝 → knowledge/accepted|rejected（kbReview 内同步落）；③ completeSignal(done) → action/accepted（`completeAction` 仅真实状态迁移记一次，重复完成幂等不重记）；generated：enrich 新 pending 字段（`crmEnrichService.enrichCustomer` 提案生成点）+ todoCreate 任务创建点（action/generated，单点收口全部建卡路径）；viewed：`getTodayActions` 卡流渲染点（主队列实际渲染卡，每卡只记一次）。
- **只读聚合**：`proposalAdoptionStats(days)`——提案类 = proposal+knowledge（行动卡完成不是提案不入分母）；分母 = accepted+rejected+modified；分子 = accepted+modified；分母 0 → rate=null（UI 显示「—」不伪造）；days=0 全历史（同 funnelStats 口径）。IPC `sales:proposal:stats`（只读不排队）。复盘页（SalesReportPage）页首一行「近 7 天：提案 N 条 · 采纳率 X%」（N=已处理总数，与设计稿「处理 N 条」口径一致）。
- **KnowledgeBasePage（刀 1 UI）**：「待审核」区（staging 列表 + 逐条发布/拒绝，拒绝内联必填拒因 textarea，可勾选「官方」置 authority；区头提示「发布后才会被知识问答引用 · 价格类条目请与产品库对账，冲突以产品库为准」——本期不做自动对账）；主列表分区渲染 published 在前（authority 徽标：官方 accent/社区灰）+ rejected 沉底（0.62 透明度 + 拒因行）；status 缺失行视为 staging 防漏审。store 加 reviewEntry（审核后全量重拉换分区）。**不删任何东西**（rejected 留档 + 物理删除仅保留既有 kbDelete 人工通道）。
- **桥接**：preload.ts + electron.d.ts 加 kbReview/proposalStats；`sales:kb:review` 走 enqueueSalesTask 最外层串行（写库端点红线）；salesKnowledgeService 加 review()（service 层校验 + currentActor 署名，知识审核写点②入口）。**既有 AI 上下文（buildKnowledgeContext/retrieveForPrompt）本批不动**——设计稿 published-only 检索是刀 3 问答的检索门，本批只收治理底座，避免话术联动行为回归。
- **测试** `scripts/knowledge-governance-test.ts`（**38/38**，`npx tsx`）：a 状态机流转 9（默认 staging/community/version1、拒绝缺拒因拦截、双向合法迁移+署名落库、rejected 跨态拒绝、重复发布拒绝、审核人缺失拒绝）；b 存量迁移幂等 4（2 条空串存量→staging/community、已审定行零踩踏、重跑 staged=0）；c 拒因必填 service 层 + 知识审核写点 5；d 三写点落埋点 12（accept/reject/complete 幂等/viewed 只记一次/重复裁决不重记/TS 守卫三拦/三写点 source 级静态断言）；e 采纳率口径 7（分母 0→null、基线精确值、窗口外不入、action 不入分母、四舍五入、days=0 全窗口、append-only 静态断言）。
- **验证**：tsc root 0 / node 158 基线零新增（我改文件 0 错误）/ vite build ✓（main.js+preload.js 重建）/ tsc -b 产物重建（含 shared/proposalEvent.js）/ 回归全绿：crm-enrich 61、todo-followup 14、today-action-consumer 14、customer-event-action 20、action-funnel 25、customer-event 16、morning-digest 22、report-review 37、alert-eval 42、canonical-state 37、sales-context-strip 10、action-rules 36、crm-sla-action 11、crm-workbench 57；action-funnel-closed-gate 15+2（B13/B16 真实库行数漂移）、customer-event-closed-gate 15+1（B11 真库基线）、customer-event-producer 14+1（A7 同因）、product-import（缺微信临时目录 xlsx 夹具）——**4 处均 stash 对照干净树同复现，存量环境依赖非本次引入**。
- **遗留**：刀 3 带引用知识问答（published-only 检索 + 引用格式 + 问答埋点 generated/viewed）、刀 4 知识提案 + 批量审核 + 只看 diff、authority=official 的批量置旗（本批仅发布时单条勾选）；存量 219 条需主管在待审核区逐批发布后才可被刀 3 问答引用。

## 2.80 Hermes 刀 3 带引用知识问答（2026-09-06，单 commit）

> **依据**：`docs/设计-Hermes-MVP.md` 刀 3（PRD 2.1 第一件）。宪法 §3 proposal_event 登记行同步增补 `knowledge_ask` 实体口径（entity_id=问题摘要哈希）后动代码。复用刀 1 治理列与刀 2 埋点表，零新表。

- **检索（铁律：LLM 只读 published）**：`salesDbService.kbSearchPublished(keywords, limit)`——SQL 级 `status = 'published'` 过滤（hermes-ask-test a1 静态断言锚点），staging/rejected 无论命中与否都不出检索口（a2 动态断言）。关键词 = 问题 2/3-gram（停用字过滤，retrieveForPrompt 同口径）+ 短问题整句，OR-LIKE 组命中后内存打分（3-gram 权重 2/2-gram 权重 1，标题整句包含 +50）取 top3。向量检索仍是 Phase 3b。
- **组答案 `electron/services/hermesAskService.ts`（新）**：`askKnowledge()` 链路 = 未配置判定（isAiConfigured，未配置 → status=not_configured 整链静默提示「先配置模型」，不检索不调用不埋点）→ 检索 → 无命中 → status=no_hit → 命中条目正文**强制先过 maskPrivateText**（宪法 §2.6 脱敏前置，crmSla2Service 同款函数）→ `callChatCompletion`（temperature 0.2，单一固定 system prompt「只依据知识库参考回答，没有就明说，绝不编造参数价格数字」，差异全放 user prompt）→ 答案 + 结构化 citations（`{id,title,version}`）。**引用由前端按 citations 渲染，不从 LLM 文本解析**——模型编造不了引用。答案为空/调用失败 → status=error 且不记 generated。
- **埋点（刀 3.5 复用刀 2 表）**：出答案 → knowledge/generated（entity_type=knowledge_ask，entity_id=`ask<djb2 哈希>`，actor=system:hermes-ask）；展开答案卡 → knowledge/viewed（`trackKnowledgeAskViewed` 同 askKey 只记一次，防反复展开刷屏）。无命中/未配置/空返回不记 generated（漏斗诚实）。
- **面板 `src/components/sales/KnowledgeAskPanel.tsx`（新，两入口共用，自含样式）**：输入框 + 提问；答案卡**默认折叠**（viewed 语义 = 展开），展开后固定「知识答案，仅供参考」警示徽标 + 答案正文 + 引用行 `引用自：《title》（vN）` 可点击 → `navigate('/knowledge-base', { state: { focusEntryId } })`；无命中 → 「知识库里没有答案」+ 生成知识提案按钮（**刀 4 前置灰**，tooltip「知识提案功能下一版上线」）。**零发送类 IPC**（AI 碰不到发送键，hermes-ask-test g4 静态断言）。知识页新增深链高亮：state.focusEntryId → scrollIntoView + 4.5s 高亮边框。
- **入口**：① 聊天页会话侧栏 search-row 加 BookOpen 图标按钮（ChatPage，state askPanelOpen）；② 客户档案「AI 工具」下拉加「问知识库」项（CustomerWorkspacePage）。
- **桥接**：IPC `sales:kb:ask` / `sales:kb:askViewed`（均 enqueueSalesTask 最外层串行，服务内部零 enqueue）；preload + electron.d.ts 加 kbAsk/kbAskViewed。
- **测试** `scripts/hermes-ask-test.ts`（**29/29**，`npx tsx`）：a published 过滤静态+动态 2；b 无命中分支 2；c 引用格式+组答案+generated 7；d 脱敏前置 3（prompt 不含原始手机号/wxid/身份证，含 ***）；e 未配置静默 3（默认判定 + isAiConfigured 真实判定 + 零埋点）；f viewed 去重 2；g 纯函数 + 铁律静态 10（无发送 IPC / 仅供参考 / 无命中文案 / 两入口 / enqueue 最外层 / 去重单点）。
- **验证**：tsc root 0 / node 158 基线零新增（diff 对照干净树，本批唯一新增错误 ConfigService|null 传参已修）/ vite build ✓ + tsc -b 产物重建 / 回归：knowledge-governance 38、customer-workspace-simple 37、customer360-consumer 13、owner-filter 28、sales-context-strip 10、action-funnel 25、morning-digest 22、report-review 37、alert-eval 42、todo-followup 14、crm-enrich 61 全绿；p0-3-closed-gate 5+1（G3 follow_up_task 直读静态项，stash 对照干净树同复现，存量）。
- **遗留**：刀 4 知识提案（问答无命中「生成知识提案」按钮已预留，届时置灰改实建 staging 提案行）+ 确认队列批量通过 + 只看 diff；问答多轮追问 / 提问历史不在本刀范围。

## 2.81 Hermes 刀 4 知识提案 + 确认队列升级（2026-09-06，单 commit）

> **依据**：`docs/设计-Hermes-MVP.md` 刀 4（PRD 2.1 第二、三件 + 2.8 两项）。宪法 §3 增补「knowledge_base 提案列」登记行（source/evidence_key 两列，幂等 ALTER 只加列；任务书原文「tags 里标 source=proposal」升级为真列——刀 1 HANDOVER 本预留 source 列，可查询优于 tag 字符串解析，登记先行）+ proposal_event 写点⑥。审核走路径 = 刀 1 待审核区，零新审核 UI 语义。

- **知识提案写入路（唯一写点 `salesKnowledgeService.propose`）**：问答无命中「生成知识提案」（KnowledgeAskPanel 按钮**接活**：title=问题、content=问题快照、evidence_key=askKey 问题哈希——可回查 proposal_event knowledge_ask 台账行）+ 知识页「补充知识」提案表单（ProposalForm，证据锚点必填，messageKey 或出处摘要）。落 `knowledge_base` staging 行（source='proposal'，AI 永不发布铁律沿用）+ 埋点 proposal/generated（entity_type=knowledge，entity_id=条目 id，actor=身份档案）。**硬门（宪法 §1.10）**：evidence_key 必填，空锚提案服务层拦截不进审核队列。kbCreate 透传 source/evidence_key（默认 manual，非提案行 NULL 合法；存量 ALTER DEFAULT 背填 manual）。裁决沿用写点② knowledge/accepted|rejected **不双记 proposal/accepted**——采纳率聚合按 stage 跨 proposal+knowledge 求和，双记会虚增分母。
- **确认队列批量通过（防确认疲劳，PRD 点名）**：客户工作台信息待确认卡勾选 + 「批量采纳」（applyInfoBatch）与知识库待审核区勾选 + 「批量发布」（store.reviewEntries）——**逐条走既有单条 handler（crm:infoQueue:apply / sales:kb:review），零新批量写路径**（hermes 铁律：单条 handler 内已有状态机校验+埋点，批量循环复用不绕过）；逐条 try/catch 错误收集，失败条目单独报告（「成功 N 条，失败 M 条 + 逐条原因」）不拖垮整批；批量发布一律 community 口径（标官方走单条勾选发布）。
- **只看 diff（知识审核区）**：区级「只看 diff」开关（冲突数角标）——只显示与已发布条目**同标题（trim 精确命中）**冲突的提案，行级并排对照（`diffLines` 纯函数：已发布列/提案列，行级新增/删除高亮 kb-diff-line--old/--new），区级开启时强制展开对照；无冲突行时提示「没有与已发布条目同标题冲突的提案」。提案卡带「提案」徽标 + 证据锚点行。
- **桥接**：IPC `sales:kb:propose`（enqueueSalesTask 最外层）+ preload kbPropose + electron.d.ts；store 加 proposeEntry/reviewEntries。
- **测试（并入 knowledge-governance-test，38→47）**：f1 提案落 staging（source/evidence_key/埋点）；f2 proposal/generated 落行；f3 空锚硬门（零落库零埋点）；f4 非提案行 source=manual 默认；f5 批量逐条语义（2 过状态机+署名）；f6 失败隔离（跨态行+不存在 id 单独报告不拖垮整批不污染他行）；f7 提案裁决不双记（分母防虚增）；f8 无批量写路径静态断言（循环体走单条 handler）；f9 只看 diff 渲染静态断言（区级开关/同标题冲突检测/并排对照/diffLines）。hermes-ask-test g6 同步更新（提案按钮已接活：调 kbPropose，不再置灰「下一版」）。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓ + tsc -b 产物重建 / 回归：hermes-ask 29、customer-workspace-simple 37、customer360-consumer 13、settings-nav 59、crm-enrich 61 全绿；action-funnel-closed-gate 15+2（B13/B16 真实库漂移，存量）。
- **遗留**：提案与现有条目冲突的「同标题」判定为精确匹配（模糊/语义冲突检测随 Phase 3b 向量底座）；「批量通过」信息待确认区固定 accept 口径（批量拒绝无 PRD 诉求，不做）；存量 219 条与新增提案同队列逐批发布。

## 2.82 Hermes 刀 5 问数据（2026-09-06，单 commit）

> **依据**：`docs/设计-Hermes-MVP.md` 刀 5（业务库联动，2026-09-06 用户确认为刚需）。宪法 §3 proposal_event 登记行增补⑦ data_ask 实体（event_type 沿用 knowledge——三类 CHECK 不动，问一问属问答族）。与刀 3 共用「问一问」输入框：`sales:kb:ask` 入口先意图分类再分发，零新入口。

- **意图分类（纯函数 `classifyAskIntent`）**：规则关键词起步——四模板专属词（今天/商机/快凉/到哪步/到款…）命中 → data+模板；泛化数据词（我的/哪几个/到哪了/本月/这个月）→ data 但无模板 = unsupported；其余 → knowledge（拿不准按知识类，答错知识比查错数据代价小）。**有意不含「多少/谁」**：与产品问题（「这车续航多少」「李林辉是谁」）碰撞率过高，避免劫持刀 3 旗舰场景（a5/a8 反例断言钉死）。客户名提取 `extractCustomerName` 纯函数（剥关键词/客套词/标点）。
- **Tool 白名单注册表（设计稿 §3 形式化）**：`HERMES_DATA_TEMPLATES` 常量恰四模板，一处定义两处消费（执行器 switch + hermes-ask-data-test f1/f2 断言）；清单外不可达（default 分支兜底）。四模板 = 参数化只读 SQL/既有读口 + 文案模板：① today_actions → `todoList(pending)`（getTodayActions 同数据源表，**不触发扫描**）+ `morningDigestService.getLatestDigest()`；② my_opportunities → `opportunityList(active)` 按最近信号沉默天数排序；③ customer_stage → `accountSearchByName`（新只读读口）+ `opportunityList(accountId)` 最近信号行 + `contractsByAccount`（新读口）最新合同；④ month_received → `monthPaidByOwner()`（新读口，**statsOverview.monthPaid 同口径**：confirmed + account_id 非空 + pay_time 落月，按 owner 分组）——测试与 `statsOverview.monthPaid` 交叉验证同值。
- **owner 过滤（§2.74 唯一语义源）**：`filterByOwner/isSalesView/IdentityLike` 迁 `shared/ownerFilter.ts`（前端 leadAssignmentView re-export 保持 import 兼容），主进程问数据模板与前端页面**一处定义两处消费**；四执行器逐一过 filterByOwner（销售=本人+空归属公共，管理=全量；月到款按 owner 分组后过滤再求和）。越权断言：王五问「李林辉到哪步」→「不在你的客户范围内」（不泄露存在性）。
- **铁律（hermes-ask-data-test f 组静态断言）**：回答数字只能来自查询结果行——文案模板纯插值，LLM 只转述（`ASK_DATA_SYSTEM_PROMPT`：每一个数字必须原样来自查询结果，绝不新增/修改/推算；temperature 0.2）；prompt 只传问题 + 查询结果 JSON（`buildAskDataUserPrompt`），不传原始聊天（f5 函数体级断言）；未配置/转述失败回退文案模板（数字同源链路不断，via=template/llm 标注）。
- **覆盖不了 → 诚实**：「这个问题我还不会查，知识库里也没有」+ 生成知识提案入口（复用刀 4 kbPropose，evidence_key=askKey）；unsupported/缺客户名不记 generated（漏斗诚实）。
- **埋点**：出答案 → knowledge/generated（entity=`data_ask`=`<askKey>`，宪法登记行⑦）；展开 → knowledge/viewed（`trackDataAskViewed` 同 askKey 只记一次，与 knowledge_ask 独立去重）。
- **前端**：KnowledgeAskPanel 增加 data 分支渲染（「本机数据 · 模板名 · 转述」徽标 + 人话答案，与知识答案同款折叠卡；unsupported 与知识 no-hit 同款提案入口）；kbAskViewed 加 kind 参数区分实体。
- **测试** `scripts/hermes-ask-data-test.ts`（**42/42**，`npx tsx`，/tmp 双库造数）：a 分类正反例 10（含反例 a5/a8）；b 四模板造数断言 11（数字与库内真实值一致 + statsOverview 交叉验证 + 空分支）；c owner 过滤 4（销售查不到他人/公共可见/管理全量）；d 覆盖不了+LLM 转述 5（prompt 只传结果行/回退文案）；e 埋点 4；f 静态铁律 8。
- **验证**：tsc root 0 / node 158 基线零新增（错误签名 diff 对照，本批 3 个新增类型错误当场修复）/ vite build ✓ + tsc -b 产物重建 / 回归：hermes-ask 29、knowledge-governance 47、owner-filter 28、lead-assignment-view 56、customer-workspace-simple 37、crm-enrich 61、funnel 48、crm-opportunity 56 全绿。
- **遗留**：意图分类 LLM 兜底（设计稿允许，规则起步即最终口径，后续按误分率评估）；商机阶段中文枚举沿页面口径（了解/比价/决策/成交，schema 默认 'initial' 归「无阶段」展示）；今日行动模板不触发懒扫描（与今日行动页数字可能存在分钟级差异——同源表但页面会触发扫描）。

## 2.83 前端收口批：分配文案去技术化 + 问一问侧边栏入口（App 级单例）+「重要提醒」术语（2026-09-07，单 commit）

> **范围铁律**：纯前端接线与文案收口——零后端业务逻辑改动、零新表零迁移、不改 Hermes 问答/检索/提案/埋点/IPC 内部逻辑、不改 `/insight-inbox` 路由。唯一 electron/ 触点 = `crmAssignmentService` 的 E101 **错误文案字符串**（经前端 `setNotice(r.message)` 直达销售，属用户可见技术字段名，非逻辑改动）。

- **分配文案去技术化（CrmLeadPage）**：分配控制台空名单与权重提示两句人话替换——「还没有销售名单。到「资源池」页签勾选线索后点击「分配给…」，可在弹窗中直接添加销售姓名。」/「不调整权重时按人数均分；调整后会自动保存，每次分配都会保留审计记录。」；全仓检索 `crmSalesList`/`crmAssignWeights` 后仅另改一处用户可见文案 = `assignBatchLeads` E101 message（同口径人话）；代码变量/配置键/类型/测试/注释一律保留原名。
- **「问一问」App 级单例**：新 `src/stores/knowledgeAskStore.ts`（zustand 三键：`isKnowledgeAskOpen`/`openKnowledgeAsk`/`closeKnowledgeAsk`，零新依赖）；`App.tsx` 主窗口分支挂载**全应用唯一一份** `KnowledgeAskPanel`（open=false 时面板自渲染 null，关闭不卸载 → 草稿/结果状态不丢失）；ChatPage 会话侧栏书本图标与 CustomerWorkspacePage「AI 工具」下拉**删除局部面板实例与 askPanelOpen state**，改调同一全局打开方法。KnowledgeAskPanel 本身零改动（现仅收 open/onClose 无上下文参数，故 store 不造无效上下文字段；未来要传 sessionId/客户上下文在此扩展）。
- **Sidebar NAV_GROUPS 扩展动作项**：`NavItemDef` 改 discriminated union——路由项 `{label,path,icon}`（NavLink，active 高亮）｜动作项 `{label,icon,action:'openKnowledgeAsk'}`（`<button type="button">` 点击开面板，**不跳路由、不伪造 active、不改 openGroups**，title/aria-label 保留、键盘原生可操作）；AI / 知识分组第一项新增「问一问」（lucide `MessageCircleQuestion`，1.23.0 已有），collapsed 平铺模式同走 `renderNavItem` 动作分支天然可用；`groupActive` 加 `'path' in i` 守卫防 undefined.startsWith。样式零新增（`.nav-item` 本就 button/reset 双兼容，token 深色自动继承）。
- **「重要提醒」术语收口**：Sidebar「洞察」→「重要提醒」（path/图标不变）；InsightInboxPage 空态「暂无见解」→「暂无重要提醒」+ 新空态指引「发现需要及时关注的客户动态时，会在这里提醒你。日常 AI 分析可在客户档案的时间线中查看。」；定位条「已定位通知中的见解」→「已定位这条重要提醒」；顺带统一该页可见 UI 文案（搜索 placeholder「搜索提醒或联系人…」、复制按钮「复制提醒内容」/toast「提醒内容已复制」）。**保留不动**：来源 pill/筛选 tab 的「AI 见解」（真实记录类型标签）、设置页功能名、客户时间线标签、请求日志弹窗内部字段。
- **测试**：`scripts/hermes-ask-test.ts` 29→**40**（h1-h11 新小节：分组第一项/动作项结构断言/App 恰一挂载/两旧入口调全局方法/页面零面板实例/重要提醒术语/路由不变/空态指引/文案去键/配置键保留）。**g7/g8 随任务 B 强制架构同步更新**（断言语义不变=入口存在，接线断言从「页面内渲染面板」收紧为「调全局打开方法」——§2.81 g6 同款先例，非放宽）。
- **验证**：tsc root 0 错误 / node 158 基线零新增 + `tsc -b` 产物重建（E101 新文案已入 .js 产物）/ vite build ✓ / hermes-ask 40 + settings-nav 59 + hermes-ask-data 42 + knowledge-governance 47 + customer-workspace-simple 37 + lead-assignment-view 56 全绿。
- **遗留**：light/dark 双模式与 collapsed 侧边栏真机目验（样式全 token 继承）；`/chat-window` 独立聊天窗口本就无会话侧栏入口，不受单例化影响（该窗口不挂面板，与改前可达行为一致）。

## 2.84 旧库升级阻断修复：knowledge_base 治理迁移索引时序（2026-09-07，commit 1）

> **故障**：SCHEMA_SQL 先建 `idx_kb_status`（引用 status 列）再跑治理 ALTER——新装库正常（SCHEMA_SQL 自带九列），**存量旧账号**（治理前的旧库无 status 列）二次启动在 doInitialize 报 `no such column: status` 中断初始化，应用不可用。修复 = 三层防护 + 真实旧库升级测试。

- **修复内容**（`electron/services/salesDbService.ts` 三处）：① 移除 SCHEMA_SQL 中过早的 `idx_kb_status`（治理索引延迟到 ALTER 完成后建）；② 新增 `isDuplicateColumnError()`（识别 SQLite `duplicate column name` 错误）——ALTER 幂等忽略的唯一依据，**其余迁移报错一律 salesLog('ERROR') + throw**（不静默吞真实故障）；③ ALTER 后强校验 `tableColumns('knowledge_base')` 九治理列齐备（缺列启动中止提示从自动备份恢复），随后建 `idx_kb_status(status, updated_at)` + `migrateKnowledgeGovernance()` + **persistNow() 立即落盘**（迁移成果不依赖 500ms 防抖窗口，二次启动确定性幂等）。
- **公共读口 `tableColumns(table)`**：PRAGMA table_info 包装（失败返回 []），供迁移校验与未来迁移复用。
- **迁移语义不变**：`migrateKnowledgeGovernance` 只补 NULL/空串（staging/community/v1/manual），published/rejected 行零触碰；九字段幂等 ALTER 保留。
- **测试**（`scripts/knowledge-governance-test.ts` 47→**57**，新增 g1-g10）：raw sql.js 构造治理前置旧库（knowledge_base 仅 9 旧字段 + 旧版 follow_up_task/customer_profile/intent_tag_log，存量 2 行）→ `reopenForWxid(legacyDir)` 走完整升级链 → 存量行保留/九列诞生/默认值正确/落盘后磁盘 PRAGMA 验证/索引存在于 sqlite_master/kbReview 可发布/二次 reopen 幂等（published 不被踩回）/migrateKnowledgeGovernance 零补写/SCHEMA_SQL 无早建索引（源码级）/索引创建位于 ALTER 之后。测试真实性经「注回早建索引复现原故障」验证（测试在 doInitialize 精确抛 `no such column`）。
- **验证**：tsc root 0 / node 158 基线零新增 / knowledge-governance 57 + hermes-ask 40 + hermes-ask-data 42 + persist-guard 36 + settings-nav 59 全绿 / vite build ✓。

## 2.85 Hermes 只读智能体第一刀（2026-09-07，commit 2）

> **定位升级**：「问一问」（刀 3/5 单轮问答）→「Hermes」只读智能体——用户提交销售目标 → 模型理解上下文 → 制定计划 → 白名单工具多步骤执行 → 证据核验 → 结构化建议。**只读**：零发送类 IPC、AI 结论不写库、任务状态不落盘（主进程内存）。依据 `docs/设计-Hermes-MVP.md` 智能体刀。

- **深模块 `electron/services/hermesAgent.ts`**（对外仅四接口 `startTask/continueTask/cancelTask/getTask`；prompt 格式、严格 JSON 协议、工具校验、重试、证据核验、限制全部内藏）：真实多步骤 Agent Loop——模型输出 `{type:'tool_call',tool,arguments,reason}` / `{type:'complete',summary,findings:[{text,evidenceRefs}],nextSteps,evidenceRefs}` 单一 JSON（容忍 ``` 围栏但字段严格校验，findings 旧格式字符串数组 = 非法协议）；**零数据 complete 一律拒绝**——任务尚无任何成功工具执行时 complete 回喂纠偏至多 1 次、坚持则 failed `ai_invalid_output`（结论必须来自真实查询；追问轮可引用跨轮既有证据）；**非法 JSON 纠正重试至多 1 次**（超限 failed `ai_invalid_output`）；**白名单外工具拒绝执行**（回喂错误让模型改道）；**重复同工具同参数不执行**（防绕圈烧步数）；**上限 6 次工具调用 / 90s deadline**（超限 failed，`Date.now() > deadlineAt` 安全点检查）；**取消**（cancelTask 置标志 + AbortController；loop 在 completion 前后与**工具返回/抛错后**的安全点检查 `cancelRequested`，丢弃在途结果不改证据表，已收尾任务不受取消影响）；任务内存 Map 上限 50 FIFO。
- **证据防伪造与证据约束闭环（铁律）**：工具每次执行由 agent 登记 `e1..en` 编号表（`evidenceByRef` Map 任务级真源，跨轮保留）；**工具零行证据时兜底登记 result 级证据**（kind=`result`，label 诚实标注「无匹配结果/查询未成功」——「查不到」也是真实查询结论，必须有编号可绑）。接受 complete 前过 `validateCompletion` 三重校验：① 本任务有过成功工具执行；② 顶层 refs ∪ findings refs 的有效并集非空；③ **每条 finding 至少绑定一个有效编号**。任一不过 → 回喂纠偏至多 1 次，坚持则 failed `ai_invalid_output`。展示证据按有效引用**并集从 evidenceByRef 重建**（多轮追问重新引用旧编号也能恢复，徽标不悬空），UI 发现条目内联 `[eN]` 徽标与证据列表一一对应。AI 结论仅供参考（UI 固定 disclaimer），永不写 stage/judgment。
- **工具白名单 `electron/services/hermesToolRegistry.ts`**（`HERMES_TOOLS` 唯一真源，恰九工具，全部复用既有读口）：`customer.search`（accountSearchByName）｜`customer.by_session`（accountBySession——把微信会话解析为客户档案，聊天入口的桥梁工具）｜`customer.current_view`（getById('account')+getCustomerCurrentView）｜`chat.recent`（getById 校验 → chatService.getMessages → **maskPrivateText 脱敏前置**+逐条 200 字截断，每条带 messageKey 证据锚点）｜`crm.customer_business`（opportunityList+contractsByAccount）｜`opportunity.my_list`（opportunityList({status:'active'}) 全局活跃商机，沉默倒序——支撑「快凉的商机」类目标）｜`payment.month_paid`（monthPaidByOwner 本月确认到款汇总）｜`action.pending`（todoList，与刀 5 runTodayActions 同口径）｜`knowledge.search`（extractKeywords+kbSearchPublished，SQL 级只查 published）。工具输出统一 `{ok,data?,evidence?,publicSummary,errorCode?}`。**可见性过滤唯一语义源 shared/ownerFilter**：客户类工具先取 account 行过 filterByOwner（contract 无 owner 列经 account 归属带出），不可见/不存在统一 `not_found`「没有找到…（可能不在你的客户范围内）」。**⚠️ filterByOwner 是展示层可见性过滤，不是安全边界**（ownerFilter.ts 头注释明示：身份为本机自我声明，宪法 §1.12）——Hermes 不宣称访问控制保证，真正门禁待可信设备/账号绑定后由服务端或可信本机凭证校验；文档与测试一律称「可见性过滤」。**归属过滤必须先全量候选、后过滤、再 slice**（禁止先 LIMIT 后过滤把本人可见行挤出；customer.search 用 `accountSearchByName(query, 0)` 取**完整名称匹配集合**——SQL 无 LIMIT、任何有限候选都会被足够多的他人记录挤掉本人行，action.pending 全量候选后 slice）。
- **队列与铁律**：工具读库统一经 `enqueueSalesTask` 串行（防原生 WCDB 并发）；**Loop 本体不入队**——AI 调用是网络 IO 不碰 WCDB，90s Loop 整体入队会阻塞其他 sales 任务；Loop 不在队列内故工具入队无死锁。
- **失败人话（`FRIENDLY_ERROR` 唯一映射出口）**：not_configured（配置指引）/ timeout（「用时太长，请换个更具体的目标」）/ too_many_steps（「拆得更具体」）/ ai_invalid_output、ai_error、internal（统一「暂时无法查询，请重试。若问题持续，请重启 WeFlow 或联系管理员。」）——UI 绝不出现 SQL/IPC/堆栈/路径。
- **IPC**：`hermes:task:start/continue/cancel/get` + `hermes:task:progress` 事件（main.ts 注册 onProgress → 主窗口 webContents.send；preload `onTaskProgress` 返回**精确退订函数** removeListener，不用 removeAllListeners）；preload `hermes` 命名空间零 send 类通道；electron.d.ts 同步 HermesTaskSnapshot/EvidenceItem/StepItem 等类型。
- **前端**：`src/stores/hermesStore.ts`（zustand：`isHermesOpen`/`context: global|chat|customer`/`lastTaskByContext`）——**任务锚点按上下文独立记忆**（`contextKeyOf`：global / `chat:{sessionId}` / `customer:{accountId}`），切换入口不串显别的上下文的任务（客户甲的任务正文绝不挂在客户乙的标题下），关闭抽屉/切路由不删任务，切回原上下文按该锚点经 task:get 恢复。**HermesPanel 以锚点驱动**：切上下文先 `setTask(null)` 再按该上下文锚点恢复（无锚点 = 空态，绝不残留上一上下文正文）；进度推送只接受「当前上下文锚点任务」（无锚点全拒，其他上下文后台进度不灌入）；startTask/continueTask 发起时捕获 `startedKey`，锚点显式写回发起方上下文（await 期间用户切走也不写错），响应回来时上下文已切换则放弃显示。三入口统一 `openHermes(context)`：Sidebar「问一问」→「Hermes」（Bot 图标动作项，无参=global，不伪造 active）；ChatPage 会话侧栏（Bot 图标，注入 `{kind:'chat',sessionId,sessionName}`，模型先 customer.by_session 解析客户）；CustomerWorkspacePage「AI 工具」下拉「问知识库」→「让 Hermes 分析」（注入 `{kind:'customer',accountId,sessionId,customerName}`）。
- **`src/components/hermes/HermesPanel.tsx`**（App 级唯一实例，右侧抽屉 520px + 轻遮罩，常驻挂载 hidden 控制显隐）：五态=空闲（上下文相关推荐目标 chips）/运行（**只渲染主进程推送的真实步骤**，无步骤显示「正在规划查询步骤」不伪造动画）/完成（结论+发现+建议+证据列表「eN」）/失败（errorMessage 人话）/追问（completed 后 continueTask 带摘要窗口，窗口 16 条 + goal 首条永留）；运行中提供「停止」（cancelTask）；样式零硬编码 hex（--color-* / --danger token，light/dark 自适应）。**旧 KnowledgeAskPanel 摘除挂载**（文件暂留未使用，kbAsk/kbAskData 底层能力保留复用）。
- **测试 `scripts/hermes-agent-test.ts`（**69/69**，新增）**：a 组 Agent Loop 动态（fake completion+fake tools 注入：多步骤循环/围栏解析/重试 1 次/白名单外拒绝+改道/**零数据 complete 拒绝（纠偏后补查可过、坚持则 failed）**/**全部引用伪造编号 → 拒绝完成**/**空结果兜底 result ref 可引用**/**findings 单条缺有效引用 → 拒绝纠偏**/**展示证据按并集重建（顶层漏写不悬空）**/**多轮重引旧编号从真源恢复**/伪造 evidenceRefs 丢弃/步数上限/重复调用跳过/取消丢弃在途/**工具执行期间取消丢弃**/快照隔离/多轮继续（含引用跨轮既有证据）/busy 拒绝/任务留存）；b 组可见性过滤动态（真实 HERMES_TOOLS+/tmp 副本库：owner 三态/管理全见/not_found 不泄露行存在性/by_session 桥梁工具/全局商机与到款工具/**完整匹配集合过滤——55 条他人记录也不挤出本人行**/staging 绝不出现/白名单恰 9 且零写语义）；c 组上下文动态（三态上下文进 toolContext/hermesStore 打开全局=global、**任务按上下文独立记忆互不串显**）；d 组 UI 静态护栏（面板零发送 IPC/五态文案/scss 零 hex/preload 零 send/旧面板摘除/主进程零写路径/FRIENDLY_ERROR 全人话/**证据约束闭环源码固化（validateCompletion+并集重建+result 兜底）/取消竞态检查/可见性措辞诚实/推荐目标与工具对齐/findings 徽标接线/面板锚点驱动/完整匹配集合**）。e 组（旧库迁移）由 knowledge-governance-test g1-g10 覆盖。hermes-ask-test g7/g8/h1-h5 随架构同步收紧为 HermesPanel 语义（「唯一实例、三入口统一、无发送」断言语义不变）。
- **验证**：tsc root 0 / node 158 基线零新增 / vite build ✓ / 回归：hermes-agent 69（新）+ knowledge-governance 57 + hermes-ask 40 + hermes-ask-data 42 + persist-guard 36 + settings-nav 59 + customer-workspace-simple 37 + owner-filter 28 全绿。
- **遗留**：真实模型端到端联调（本刀测试全用注入 fake/真实只读工具，未打真实 AI 端点）；chat.recent 依赖微信库连接（未连接诚实返回 chat_unavailable）；**可见性过滤非安全门禁**（filterByOwner 展示层，真正授权待可信设备/账号绑定后由服务端或可信本机凭证校验）；证据 UI 回查（messageKey → getEvidenceByKey 拉原话）留待下一刀；任务不跨进程重启持久（by design，内存态）。

## 2.86 Hermes 信任边界收紧：出站统一脱敏 + 失败查询闭锁 + 会话标识不出宿主 + 取消竞态门槛（2026-09-07，commit 3-4）

> **定位**：只修 §2.85 现有实现的边界缺口——不做 UtilityProcess、不改 UI 设计、不改入口。§2.85 中与本文冲突的语义（by_session 接受模型 sessionId / 失败查询兜底登记证据 / prompt 含真实会话 id）以本节为准。

- **模型出站统一脱敏（唯一出口）**：发往模型的一切内容在 hermesAgent 统一脱敏，不依赖每个工具作者自觉——① `buildUserPrompt` 的用户输入先过 `maskPrivateText`，宿主已知 sessionId 精确替换为 `***`（精确字符串替换，不新增宽泛自由文本正则）；② 工具结果回喂走统一 sanitizer（`maskDataCopy`，接收 `tool.name` + 字段 path）：**客户身份字段允许清单 `IDENTITY_FIELD_PATHS`**（customer.search `customers[*].name` / by_session·current_view·customer_business 顶层 `name` / opportunity.my_list `opportunities[*].customer` / chat.recent 顶层 `customer` / action.pending `tasks[*].customer`）内的值走 `maskStructuredId`（微信号三形态一律 `***`），被改写的整值记入替换表；**清单外的普通业务字段（合同名/知识标题/产品名等）只走 `maskPrivateText`，不做 `isSessionIdLike` 判定**——「ModelX/AgreementA」类业务名不被误伤（a31）；手机号/身份证/wxid_* 在任意文本字段仍被 `maskPrivateText` 脱敏；`error`/证据 label 等自由文本过 `maskPrivateText` 后再按替换表 + 宿主 sessionId 逐值精确替换。**messageKey 绝不出站**：canonical/local/server/fallback 各形态内含本机绝对数据库路径与 wxid/自定义微信号发送者标识——模型副本中该字段直接删除，模型引用证据只走 eN ref（编号协议不变，a30）。**只改发往模型的副本**：库原值、HermesTask/evidenceByRef 的完整 messageKey（回查能力）、用户可见任务快照全部保持原文。存量脏数据（客户 name/company 存微信号或手机号）由此不再出宿主。
- **模型侧零会话标识**：`accountBrief` 删除 `sessionId` 字段（模型可见客户摘要只剩 accountId/name/stage/company，整个工具输出 JSON 不出现 wxid）；`buildUserPrompt` 不再写真实 sessionId/wxid——chat 入口改为语义提示「当前任务已绑定聊天上下文，需要识别客户时调用 customer.by_session，无需提供会话 ID」（customer 入口仍只注入 accountId）；真实会话标识不出宿主。
- **customer.by_session 宿主上下文化**：`HermesToolContext` 新增 `contextKind`（agent 在 `toolContext()` 定格任务入口类型）；工具只认 `ctx.contextKind==='chat' && ctx.sessionId`（宿主持有的当前 chat context），**模型 arguments 里的任何 sessionId 一律不读取、不采信**（argsHint 改 `{}`）；非 chat 上下文（global/customer）或宿主未持有会话 → `context_required` + 人话提示「当前任务没有绑定聊天上下文…请改用 customer.search」；不存在/越权仍统一 `not_found` 不泄露档案存在性。
- **失败查询闭锁 `unresolvedToolFailure`**（动态测试证明，见 a26/a26b）：任一工具执行失败 → 置 true（失败查询零 evidence，只产生 error step）；后续任一成功查询（产出有效结果/证据）才解除；`continueTask` 开新一轮清零。闭锁未解除时输出 complete 一律拒绝并回喂纠偏（至多 1 次，坚持则 failed）——**旧证据替不了失败的新查询**：先成功查询得 e1 → 后续查询失败 → 引用 e1 的结论被拒 → 补一次成功查询后才放行。回喂 `note` 同步明示「没有产生新的证据编号，不得引用旧证据把失败包装成结论」。
- **兜底 result 级证据只对成功查询登记**：ok + 零行 → 「`{publicLabel}：查询完成，无匹配结果`」可引用（「查不到」也是真实查询结论）；结构化标识脱敏 `maskStructuredId`（registry 导出，动态可测）：`isSessionIdLike`（shared/wechatId 三形态：wxid_ 前缀号/自定义微信号/群号）命中一律 `***`，未命中仍走 `maskPrivateText`；结构化字段专用，自由正文不做宽泛正则防误伤。
- **取消串显竞态门槛 `canSettleTaskView`**（hermesStore 导出纯函数，判定唯一真源）：`HermesPanel.handleCancel` 发起时捕获 `cancelKey = contextKeyOf(context)` + `taskId`，await 返回后只有「当前上下文 key 一致 **且** 该上下文锚点仍指向同一任务」才 `setTask`——取消期间切到另一客户/聊天（key 变）或另起新任务/清锚点（锚点变）都拒绝写视图；startTask/continueTask 语义不变。
- **每轮重置 dataRetries**：`continueTask` 新一轮把 `dataRetries` 与失败闭锁清零（每轮追问重新拥有完整纠偏预算）；证据表/okToolCalls/摘要窗口等跨轮语义不变。
- **用户可见标签零内部工具 ID、不信任模型文案**：`HermesToolDef.publicLabel`（九工具人话名称：客户搜索/会话客户识别/客户当前视图/聊天记录查询/客户商机与合同查询/活跃商机盘点/本月到款汇总/待办行动卡查询/知识库检索）；已知工具的步骤 label **固定** `调用{publicLabel}`（模型 `reason` 原文绝不上标签），白名单外步骤显示通用「执行查询」（不显示模型伪造的工具名）；`step.tool` 为内部非展示字段保留；兜底证据 label 同用 publicLabel；证据编号 eN 与 findings v2 协议不变。
- **测试 `scripts/hermes-agent-test.ts` 69→90（+21）**：a18 扩展（兜底 label 人话且不含内部工具 ID）+ a6 扩展（白名单外步骤 label = 「执行查询」）+ 新增 a22（prompt 零真实 sessionId、含语义提示）/a23（失败工具零证据→无据 complete 坚持 failed）/a24（失败查询编号不可引用——引用 e2 被拒、成功 e1 不受影响）/a25（continue 重置 dataRetries）/a26+a26b（失败查询闭锁——借旧 e1 的 complete 被拒、补成功查询解除、坚持则 failed、continue 轮清零后引用既有证据可完成）/a27（goal 含当前 sessionId/wxid/手机号 → 模型消息零原值）/a28（客户 name 为自定义微信号 → 模型消息 data/证据 label 零原值，库原值与本地证据表不动）/a29（reason 显式含 `customer.search` → 快照展示字段零内部 ID）/a30（messageKey 四形态——用真源 `buildMessageKey` 构造含本机绝对路径与 wxid/自定义微信号发送者的 canonical/local/server/fallback key——模型副本零出站，本地证据 messageKey 完整保留）/a31（路径感知脱敏：合同名 `AgreementA`/产品名 `ModelX` 模型输入保持原文不误伤，身份值与手机号/身份证/wxid_* 在任意文本字段仍 ***）；b12-b13 重写 + b12a（伪造 sessionId 被忽略按宿主会话解析）/b12b/b12c（非 chat / 无宿主会话 → context_required）/b20（accountBrief 零 sessionId）/b21（maskStructuredId 三形态 ***、手机号走文本脱敏、昵称不误伤）；c10（真实 HERMES_TOOLS 端到端：聊天入口伪造 sessionId 无效、任务快照零 wxid）/c11（取消收尾门槛四态判定）；d12（handleCancel 接 canSettleTaskView 静态固化）/d13（sender 走 maskStructuredId + accountBrief 零 sessionId 静态固化）。`scriptCompletion` 增加 `captured()`（汇总发往模型的全部消息，出站脱敏断言用）。
- **验证**：`WEFLOW_WORKER=1 npx tsx scripts/hermes-agent-test.ts` **90/90**；tsc root **0 错误** / node **158 基线零新增**（hermes 四文件零报错）/ `npx vite build` ✓ / `git diff --check` 干净；不改数据库 schema、零新依赖。

## 2.87 Hermes UtilityProcess 化：Agent Loop 出宿主 + Main 可信宿主（2026-09-07，与 §2.85-86 的 Agent Core 提取合并单 commit）

> **架构定案**：生产链路 = Renderer → preload（接口零改动）→ Main（Manager=唯一可信宿主）→ UtilityProcess（只跑 Agent Loop）。**旧进程内 Agent（`electron/services/hermesAgent.ts`）仅保留作测试 adapter，生产严禁回退**（main.ts 已不再 import）。依据 `docs/设计-Hermes-MVP.md` 任务书任务 2+3。

- **协议 `shared/hermesProtocol.ts` v1（唯一真源）**：Main→Utility（init/restore/task.start/task.continue/task.cancel/task.get/host.response/shutdown/ping）与 Utility→Main（ready/task.response/task.progress/task.checkpoint/host.request/fatal/pong）两消息族；**严格键集递归校验**（`isMainToUtilityMessage`/`isUtilityToMainMessage`，多余字段=边界违规硬拒绝）；**工具结果在途证据 `HermesBridgeEvidence`（无 ref 无 messageKey）**——ref 是 Utility 消费时才分配的登记号，桥接阶段不存在，出现在工具结果=违规拒绝；checkpoint 脱敏形态（`HermesCheckpoint`：goal/context/conversation/evidenceByRef/nextEvidenceSeq/okToolCalls，**无 status/result/steps**——Utility 恢复已收尾任务一律重建为 completed 可继续追问态，展示真源在 Main 缓存）；协议版本不一致 → Utility 发 fatal(protocol_mismatch) → Manager 直接 unavailable **不消耗重启预算**。
- **Utility 入口 `electron/hermes/hermesUtilityEntry.ts`**：只承载 Agent Loop（复用 `hermesAgentCore`，唯一 Loop 真源）+ 任务运行时（内存 Map，上限 50 FIFO）；**零数据库访问、零模型出网、零持久化**——模型补全与工具执行一律 `host.request` 回宿主（requestId 关联 + 超时 + abort 兜底）；`init` 下发九工具清单仅公开元数据（run 占位永不本地调用）；每任务一个 Core 实例（completion/executeTool 闭包绑定 taskId，多任务并发不串线）；Utility 侧 maskText/maskId 恒等（**不掌握脱敏函数与规则**）；parentPort 关闭或收到 shutdown → 自行退出。**测试注入缝**：`runHermesUtility(port)` 纯函数 + `process.parentPort` 自动引导；`scripts/hermes-utility-child-shim.cjs`（仅动态测试经 `--require` 预载）用 child_process IPC 模拟 parentPort 的 MessageEvent 形态，同一入口 TS 被真实 fork。
- **Main Manager `electron/hermes/hermesUtilityManager.ts`（零 electron 依赖，fork 经 `HermesUtilityFork` 注入）**：`utilityProcess.fork` + ready 握手 + 请求关联/超时 + start/continue/cancel/get + 进度转发 + 心跳（15s ping，35s 无回应判异常）+ checkpoint 保存（**≤50 份 FIFO**）+ 异常退出检测 + **每应用生命周期至多一次重启**（500ms 延迟）+ shutdown（通知 → 至多等 2s → kill）；状态固定四态 starting/ready/unavailable/stopped；快照缓存 ≤50。**宿主三闸**：①模型走现有 `ConfigService`/`getAiModelConfig`/`callChatCompletion`（**API Key 绝不进 Utility**），出网前 `maskOutboundTextForBridge` 最终隐私检查 + sessionId 精确替换，每请求独立 AbortController；②工具执行重校验工具名（白名单外拒绝）+ 参数 + capabilityContextId（无映射/不匹配 → forbidden），**只有具体数据库读取进现有 `enqueueSalesTask`（Agent Loop 绝不整体入队）**，结果回传前 `maskDataCopyForBridge` 再脱敏 + 证据条目显式重建（messageKey 结构性排除）；③`capabilityContextId` 是不透明 ID，**真实 identity/sessionId 映射只存 Main `capContexts` Map**（`accountId` 按协议作为工具锚点随上下文进 Utility；identity/sessionId/API Key 绝不进）。取消：abort 在途模型请求 + 通知 Utility + **在途工具结果丢弃**（回传 cancelled、不登记证据、不产生完成步骤）。
- **接线 `electron/main.ts` + `vite.config.ts`**：四 IPC handler + `hermes:task:progress` 事件改调 Manager（渲染层/preload/`electron.d.ts` 零改动）；whenReady 时 `hermesUtilityManager.start()`（未就绪期报 `agent_starting`）；`shutdownAppServices` **第一步**结束 Utility（铁律：Utility 必须在数据库服务关闭前结束）；vite 新增 `hermesUtilityEntry` 入口（`entryFileNames: 'hermesUtilityEntry.js', codeSplitting: false`，产物仅 Core+协议——已验证产物零 salesDbService/callChatCompletion/apiKey/better-sqlite 痕迹）。
- **错误文案分层**：Manager 级 `MANAGER_ERROR`（`agent_starting`「Hermes 正在启动，请稍后再试。」/`agent_unavailable`「Hermes 暂时不可用，请重启应用后再试。」/`protocol_mismatch`「Hermes 组件版本不一致，请重新安装或升级应用。」/`timeout`「本次分析超时，请稍后重试。」）与 Core 级 `FRIENDLY_ERROR` 分层。
- **动态测试 `scripts/hermes-utility-test.ts`（113 断言 / 13 场景，全部真 fork Utility）**：①ready+v1 握手 ②start→工具→模型→complete（prompt 零 wxid 真值、工具 ctx 拿到真实 identity/sessionId）③progress 顺序（planning→running→completed）④白名单外工具 Main 拒绝（forbidden 改道）⑤畸形消息/错误版本拒绝 ⑥模型期间取消（AbortController 中断）⑦工具期间取消+结果丢弃（在途请求回传 cancelled、零证据零完成步骤）⑧首次崩溃自动重启回 ready（旧子进程退出、新子进程存活、服务继续）⑨已收尾任务跨重启恢复+继续追问（checkpoint 还原对话/证据，追问走新模型脚本）⑩运行中任务崩溃 → failed/agent_unavailable ⑪二次崩溃 fail closed → unavailable、startTask/continueTask 拒绝、不启第三个子进程 ⑫shutdown 无孤儿进程、之后拒绝新任务 ⑬静态红线（入口零 electron/DB/AI/配置/队列/日志/旧服务壳 import；main.ts 构造 Manager、不 import 旧 Agent；vite 含新入口）。harness 捕获 Main→Utility 消息序列支撑协议断言。
- **协议测试**：`hermes-protocol-test` 175→**176**（i3c 改为无 ref 在途证据通过 + i3d 工具结果证据带 ref 拒绝——修复任务 2 遗留的桥接期矛盾：`isHermesProtocolEvidence` 曾要求 ref，而桥接工具结果证据在 Utility 分配 ref 前不可能携带）。
- **刻意行为注记（边界终态见 §2.88）**：跨进程一切任务文本与证据均为脱敏形态——原文 goal/contextLabel 与原始证据锚点（含 messageKey）只存 Main，UI 快照由 Main 合并恢复原貌；进程边界即信任边界（宿主与 Utility 同机同用户）。
- **验证**：`npx tsx scripts/hermes-utility-test.ts` **113/113**；`hermes-protocol` **176/0**；`hermes-agent` **95/0**；hermes-ask 40 / hermes-ask-data 42 / knowledge-governance 57 / owner-filter 28 / customer-workspace-simple 37 / settings-nav 59 全绿；tsc root **0 错误** / node **158 基线零新增**（hermes 新文件零报错）/ `npx tsc -b tsconfig.node.json` 报错均为未触碰的基线文件 / `npx vite build` ✓ 产物 `dist-electron/hermesUtilityEntry.js`（25.6KB，含 Core+协议、引用面干净）。

## 2.88 Hermes Utility 宿主边界补修：任务文本脱敏过界 + 证据锚点回查 + 在途操作收尾 + 版本 fail closed（2026-09-08，commit `fix: close Hermes utility host boundaries`）

> 基于 §2.87（e5a3af1）的四项宿主边界缺口闭合。协议仍为 v1（`evidenceHandle` 为可选新增字段，严格键集校验放行；`HERMES_PROTOCOL_VERSION` 不变）。

- **任务文本脱敏后才过进程边界**：`task.start`/`task.continue` 的 goal/question 在 Main 经 `maskOutboundTextForBridge`（maskText + 该任务宿主 sessionId 精确替换）后下发；Utility 侧 `context.label` 恒为通用「全局/当前会话/当前客户」，客户名/会话标识不入 Utility。原文 goal/contextLabel 只存 Main `rawTextByTask`，progress 快照合并时恢复原文供 UI——**UI 永不显示脱敏文本**；任务淘汰同步删除原文。
- **证据锚点（messageKey 真源回查）**：Main 桥对每条原始证据分配不透明 `evh-*` `evidenceHandle`，原始证据（含 messageKey）存 `evidenceAnchorsByTask`；跨进程证据只带 handle（messageKey 结构性排除 + 校验器拒绝 messageKey 形态/路径分隔符形态的 handle 值）。Utility 以 eN ref 消费并回传 ref+handle；Main `uiSnapshot` 按 ref/handle 从锚点表恢复原始证据（label 原文 + messageKey 本地跳转锚点，本地回查能力与进程内模式一致），无锚点条目只保留脱敏展示面。checkpoint 永不携带 handle/messageKey——Main 的 ref 锚点在 Main 内存存活，跨 Utility 崩溃恢复后仍按 ref 恢复；任务淘汰删全部锚点表。
- **shutdown 等待在途宿主操作**：`shutdown()` 幂等（memoized promise）；顺序 = 拒新 host.request（shuttingDown 守卫）→ abort 全部在途模型 AbortController → 通知 Utility → 至多 2s 宽限 → kill → **等全部在途宿主操作（`hostOps` 跟踪）落定才返回**；卡死的工具读库依赖 main.ts 既有 5s `app.exit` 兜底，shutdown 不提前返回、不早关数据库。**child 亲和**：宿主响应只回给发起请求的 child（`respondHost` 校验 child 一致），崩溃/替换后旧请求的延迟结果一律丢弃，绝不发给新 child。
- **协议版本 fail closed**：`onChildMessage` 在严格校验前先检查数值 `protocolVersion` ≠ 当前 → 立即 `enterUnavailable` + kill 当前 child，**不自动重启、不消耗重启预算**（版本不一致重试无用）；unavailable 状态一切 host.request 被拒（回 `agent_unavailable`，在途请求可收尾不悬挂）。消息/退出监听按 child+generation 绑定，旧进程迟到消息（含错误版本消息）一律在监听层忽略，不误触 fail closed。
- **测试 `hermes-utility-test` 113→161 断言 / 13→17 场景**：t2 反转（UI 证据经锚点恢复 messageKey 原值；Main→Utility 与 Utility→Main 双向消息全量扫描零 messageKey）；新增 t2b（goal 含手机号/身份证/wxid/sessionId/客户名 → task.start 零敏感值 + 通用标签 + UI 快照保留原文 + 模型出站零原值）；t5 反转（畸形消息不致命仍 ready；数值版本不一致 → 立即 fail closed：child 被 kill、不重启、startTask 拒绝）；t9 增补（restore checkpoint 无 messageKey/handle；崩溃恢复后 Main 锚点仍恢复 messageKey）；新增 t14（模型在途 shutdown → 请求被 abort；工具在途 → shutdown 不提前 resolve、收尾后完成）/t15（崩溃重启后旧请求延迟结果零回传、重启后零宿主响应）/t16（假 child 模拟旧版本 ready → 立即 fail closed + kill + 不重启 + unavailable 拒绝工具执行）/t17（旧 child 迟到的 progress 与旧版本消息一律忽略）。**4 项突变验证**（去 child 亲和 / 去版本 fail-closed / 去 hostOps 等待 / 去 handle 分配）分别被对应场景捕获。
- **协议测试 `hermes-protocol-test` 176→182**（i3e-i3j：桥接/快照证据允许不透明 handle；messageKey 形态与路径分隔符 handle 拒绝；快照证据 messageKey 仍拒绝；checkpoint 证据携带 handle 拒绝）。
- **验证**：utility **161/161**、protocol **182/0**、agent **95/0**；tsc root **0 错误** / node **158 基线零新增**（hermes 零报错）/ `npx vite build` ✓ / `git diff --check` 干净。

## 2.89 Hermes 任务生命周期边界加固：capability↔指纹绑定 + runId 轮次门禁 + 双向统一出口扫描（2026-09-08，commit `fix: harden Hermes task lifecycle boundaries`）

> 基于 §2.88（边界终态）的第三轮补修：闭合「账号/身份变化后旧 capability 仍可用」「取消/续轮后迟到消息覆盖终态」「出口扫描未接真实协议出口」三类缺口。**协议升级 v2**（runId 必填 + evidenceHandle 格式收紧，属线上格式变更；两侧同应用成对分发，版本号 fail closed 保证半升级时拒绝而非静默丢消息）。定位：本地展示范围/任务上下文隔离，非安全沙箱。

- **P1-1 capability 与上下文指纹绑定**：Manager 可注入 `contextFingerprint?: () => string`（生产缺省 = 清洗后 myWxid + 身份姓名 + 身份角色 的 JSON 序列化；**真实值绝不入 Utility 消息或 checkpoint**）。`startTask` 定格指纹入 CapContext；每次 `host.request` 与 `continueTask` 都重读比对——不一致 → 拒模型/工具（稳定错误码 `context_expired`，文案「当前账号或身份已经变化，请重新发起 Hermes 任务。」）+ `expireTask` 封禁 capability + abort 在途模型 + 快照置 `failed/context_expired`，此后 continue/host.request/迟到 progress 均不能复活。`config:set myWxid` 切库后 Main 主动调 `hermesUtilityManager.invalidateCapabilities('account_changed')`（本地身份更新依赖指纹重校验兜底）。`expireTask(taskId, errorCode, force=false)` 为单点终态写入：删 cap 映射 → expiredTasks → abort → 非终态（或 force）复写快照并广播。
- **P1-2 runId 轮次号防乱序**：协议 v2 为 `task.start`/`task.continue`/`task.progress`/`task.response`/`task.checkpoint` 增加 `runId`（安全整数 ≥1）。start=1，Main `continueTask` 递增（`taskRunGeneration` Map）并等待**带同轮次 runId 的受理回执**（not_found/busy/cancelled 回执也回显收到的 runId；回执轮次不匹配不解除等待）；Utility 回传 progress/checkpoint 必带当前轮次，Main 三处门禁只收当前轮次——旧轮次迟到消息一律拒收（日志只记 taskId/runId/原因）。配合终态门禁：取消任务只接受 cancelled 状态、已终态任务拒绝异状态 progress、checkpoint 一律拒收取消任务（恢复面只剩 Main 快照）；未知 taskId 不凭空创建。崩溃恢复后旧 child/旧轮次消息同样无法覆盖新状态。
- **P2 双向唯一出口边界扫描**：Main→Utility 唯一出口 `Manager.sendToUtility`（返回 boolean）与 Utility→Main 唯一出口 `Entry.send` 均执行「协议运行时校验 + `findHermesBoundaryIssues`」双检——毒化 goal/question、禁止字段（messageKey/sessionId/apiKey 等结构键）、wxid_/@chatroom 值一律拒发，日志只含消息 type 与违规路径（不含违规值/prompt/模型响应/sessionId/Key）。调用点脱敏若被绕过，出口兜底：startTask/continueTask 返回受控错误（不再傻等 90s 超时），任务立即 `failed/boundary_violation`（文案「本次查询未能安全处理，请重新发起任务。」），host.request 拒发路径同样让任务快速落定。**模型响应二次脱敏**：模型返回文本是不可信外部输入，`hostModelComplete` 回传 Utility 前再过 `maskOutboundTextForBridge` + 宿主已知标识符精确替换 + 扫描。`evidenceHandle` 收紧为 `/^evh-[a-z0-9-]+$/`（协议 i3k/i3l）；Main 恢复锚点只认自己登记过的 handle，伪造 handle 无锚点只保留脱敏展示面（同状态终态幂等重发仍允许，异状态拒绝）。
- **Entry 侧贯通**：`HermesAgentTaskRuntime` 新增 `runId`（宿主构建/续轮时赋值，Core 本体不读）；Entry `send` 出口双检 + executeTool 对 `cancelled/context_expired/boundary_violation` 抛受控错误让 Core 安全点静默停轮；checkpoint/progress/task.response 全带 runId。
- **测试 `hermes-utility-test` 161→244 断言 / 17→26 场景**：t18（假 child：姓名/角色/账号任一变化 → host.request 拒绝 context_expired + 任务终止 + continue/二次 request/迟到 progress 均不可复活 + 指纹组件零入 Utility 消息）、t19（真 fork：工具在途时账号变化 → 工具不再执行 + failed/context_expired；新上下文新任务正常全链路 + 跨进程消息零指纹原值）、t20（取消后 runId 匹配的 running/completed progress 与 checkpoint 均被拒、伪造结论不入快照）、t21（第二轮开启后旧轮次 running/failed/checkpoint 被拒 + 第二轮正常完成 + 未知 taskId 不创建）、t22（首次崩溃恢复后旧 runId 消息无法覆盖 failed/agent_unavailable）、t23（毒化 goal/question 出口拒发 + messageKey 禁止字段拒绝 + 脱敏被删时 startTask/continueTask 立即 boundary_violation + 日志零原值）、t24（模型文本手机号/wxid/宿主 sessionId 回传前脱敏为 ***）、t25（模型响应脱敏被删 → 快速 boundary_violation + Utility 收受控错误；伪造 evidenceHandle 不恢复锚点，真实 handle 恢复 messageKey）。**3 项突变验证**：移除 host.request 指纹重校验 → t18/t19 红；移除 progress/checkpoint runId 门禁 → t21 红（t20/t22 由取消/终态门禁双层防护）；绕过出口扫描 → t23/t25 红。均已还原复绿。
- **协议测试 `hermes-protocol-test` 182→195**（f2a-f2k：runId 缺失/0/1.5/MAX_SAFE_INTEGER 及 start/continue/response/checkpoint/restore 全形态校验；i3k/i3l：`opaque-handle-123`/`evh-Abc_123` 格式外 handle 拒绝；fixtures 补 runId、错误版本 2→3）。
- **验证**：utility **244/0**（26 场景）、protocol **195/0**、agent **95/0**；knowledge-governance 57 / hermes-ask 40 / hermes-ask-data 42 / persist-guard 36 / settings-nav 59 / customer-workspace-simple 37 / owner-filter 28 全绿；tsc root **0 错误** / node **158 基线零新增**（hermes 零报错）/ `npx vite build` ✓ / `git diff --check` 干净。

## 2.90 Hermes Utility 异步生命周期竞态补修：二次 capability 校验 + 跨轮 checkpoint + 合法回执 runId（2026-09-08）

> 基于 §2.89，继续只修 UtilityProcess 生命周期边界：模型/工具 await 返回后的旧上下文结果不得回流，跨轮终态不得因“零新工具”漏存，cancel/get 错误回执不得因 `runId=0` 被自身出口拒发。协议继续 v2，不涉及任务 4 打包。

- **异步返回后二次统一校验**：`HermesUtilityManager.validateHostOperation()` 在模型或工具 await 返回后、构造任何结果前统一复验 shutdown、child 亲和、task 存在、cancelled/expired、task→capability 映射、capability fingerprint、当前上下文 fingerprint 与当前 task runId；失败统一转为 `context_expired` / `cancelled` / `stale_run`。模型链固定为 `await → 二次 capability/指纹校验 → 二次脱敏 → host.response → Utility progress/checkpoint/UI`；工具链固定为 `await enqueueSalesTask → 二次校验 → maskToolResult → evidenceHandle/anchor → host.response`。指纹在途变化时旧模型原文与旧工具结果均不进入 Utility、证据表、checkpoint 或 UI；工具过期路径不会分配 handle 或写 `evidenceAnchorsByTask`。取消优先于指纹变化，仍保持 `cancelled`。
- **身份修改主动失效**：`identity:set` 注册支持兼容旧调用方的可选 `onIdentityChanged`；Main 接线 `hermesUtilityManager.invalidateCapabilities('identity_changed')`。既有 `myWxid` 的 `account_changed` 快速失效不变，await 返回后二次 fingerprint 校验仍是最终兜底；新身份/上下文任务可重新创建。
- **checkpoint 跨轮完整性**：Utility `checkpointMark` 最终结构为 `{ runId, okToolCalls, status }`；成功工具计数变化保存 checkpoint，每个 runId 第一次进入 completed/failed/cancelled 终态都保存一次，即便本轮零新工具且上一轮也是 completed。恢复时 Main 只发送 `checkpoint.runId === taskRunGeneration.get(taskId)` 的 checkpoint，Utility 同时以恢复 checkpoint seed `checkpointMark`，避免第三轮 running 更新覆盖第二轮终态。第二轮直接引用历史 e1 完成后保存 `runId=2`；杀 Utility 自动恢复后，第三轮模型输入保留第一轮对话、第二轮问题与结论、历史证据 e1；注入 `runId=1` 旧 checkpoint 不得覆盖 Main 当前 `runId=2`。
- **cancel/get 回执协议**：`task.cancel`/`task.get` 请求携带正整数 `runId`；未知任务回显请求 runId 的 `not_found`，已知任务只接受当前轮次，旧轮次返回 `stale_run` 且不得取消/读取当前任务；当前轮次 cancel/get 正常生效/返回。响应协议删除没有生产者的 `op:'start'` 死分支，`runId=0` 继续被运行时校验拒绝。
- **新增动态覆盖**：`hermes-utility-test` 新增 t26（模型 await 指纹竞态）、t27（第二轮零新工具 checkpoint + 崩溃恢复第三轮）、t28（cancel/get 合法/旧轮次回执）、t29（identity:set 主动失效）、t30（工具 await 指纹竞态与 evidenceHandle/anchor 不分配）、t31（failed/cancelled 终态 checkpoint 各 runId 只发一次）；高保真真实 fork 共 **32 场景 / 291 通过 / 0 失败**。`hermes-protocol-test` 新增 cancel/get 缺失/非法 runId 与 `task.response op=start` 拒绝，**198/0**。
- **突变验证**：临时移除模型/工具 await 后复验，t26/t30（并连带 t7）变红，结果 **282/5**；临时忽略 checkpoint runId，t27 变红，结果 **277/2**；临时忽略 cancel/get runId，t28 回执等待超时，结果 **286/1**。三类突变均在恢复实现后复绿。
- **本轮验收**：`npx tsc --noEmit` **0**；`npx tsc -b tsconfig.node.json --force` 保持 **158 条既有基线错误**、Hermes 相关 **0 条新增**；`hermes-agent-test` **95/0**；knowledge-governance **57/0**；hermes-ask **40/0**；hermes-ask-data **42/0**；persist-guard **36/0**；settings-nav **59/0**；customer-workspace-simple **37/0**；owner-filter **28/0**；`npx vite build` 成功；`git diff --check` 干净。


## 2.91 Hermes 任务 4 最终补修与交付验收（2026-09-08，工作区未提交）

> 本节严格区分静态结构、staging app、DMG/ZIP 提取物、真实模型和签名门槛。当前结论：**代码完成，试点门槛未全部通过。** 未执行 commit/push，原因是真实模型联调未完成且 macOS 签名/公证门槛未通过。

- **联调驱动修复**：`node_modules/.cache/hermes-real-driver-entry.ts` 直接复用 `getAiModelConfig(config)` / `isAiConfigured(config)`，不读取 ConfigService 内部 store、不解析 `safe:`、不二次 `safeStorage.decryptString()`，不输出或保存 Key、前缀、长度或解密原文。`hermes-driver-main.cjs` 在加载 ConfigService 前完成 `app.setName('weflow')` 与 `app.setPath('userData', ...)` 两段式预入口。Manager 通过受控 `log` 回调只接收状态、任务/工具、错误码及隐私计数；完整 Electron stdout 不作为联调证据。
- **Utility 状态/文案**：`hermesUtilityManager.ts` 持久区分 `agent_missing` / `protocol_mismatch` / `agent_unavailable`；协议不一致立即 kill、不重启、不消耗崩溃预算；`onReady` 只接受 `starting → ready` 握手——`unavailable` / `stopped` / shutdown 中迟到或重复的 `ready`（含旧 child 退出前补发的合法 v2 `ready`）一律丢弃，服务恢复只有 `start()` 一条路，随后的旧 child `exit` 不触发自动重启、不消耗崩溃预算。fail-closed 时在途任务保留稳定失败原因：协议不一致终止为 `failed/protocol_mismatch`，普通首次/二次崩溃仍为 `failed/agent_unavailable`。`shared/hermesErrorMessages.ts` 是 Main/Renderer 唯一错误文案源，开始与继续追问共用，继续失败保留上一轮结论并显示错误条。模型 findings v2/空结果纠偏次数进入安全快照计数，且为「本轮」语义：`start` / `restore` / `continue` 开新轮次一律归 0，旧 runId 迟到快照不影响新轮次。
- **静态结构验证**：root `npx tsc --noEmit` **0 错误**；Node `npx tsc -b tsconfig.node.json --force` **158 条既有基线错误**，Hermes 相关 **0 条新增**；`hermes-error-message-test` **16/16**；`hermes-package-test` **79/79**；`npx vite build` 成功；`git diff --check` 通过。`dist-electron/hermesUtility.js` 存在，旧 `hermesUtilityEntry.js` 不存在；构建产物无 DB/AI Key/网络服务导入；app Resources 中只有 `hermes/hermesUtility.js` 一份，`app.asar` 无 Utility 副本。
- **staging app 冒烟**：仅作为结构/启动参考，不冒充安装包验收；入口资源与 Utility 结构由 package test 覆盖。
- **DMG/ZIP 提取物真机冒烟**：从 `release/WeFlow-1.0.0-Setup.dmg` 挂载并复制独立 app，从 `release/WeFlow-1.0.0-Setup.zip` 解压独立 app。两种提取物均启动成功；验证 Utility ready、Hermes 开始/取消入口、app.asar 无 Utility 副本、首崩自动重启、二崩 fail closed、退出无孤儿、再次启动 ready、缺 Utility 资源返回 `agent_missing`。交付审查复核（原临时脱敏脚本及其输出已按清理约定删除、无存档可追溯，不以「30/30」或「31/31」任何一方沿用；**不写聚合总数，分项列出**）：
  - **结构断言 14/14 通过**（7 项 × 2 提取物）：重新提取两包后 `npx asar list` 实测——hermes 资源存在 / app.asar 存在 / asar 内无 Utility 副本 / main、preload、apiMessageWorker、wcdbWorker 照常入 asar。
  - **隐私扫描 14/14 通过**（7 形态 × 2 段日志）：wxid / 手机号 / 身份证 / messageKey / API Key / 绝对路径 / sessionId 形态在两段 Hermes 相关日志行零出现。
  - **生命周期核验按轮次逐项取证**（每项以销售日志时间戳为证）：
    - DMG 轮 2026-09-08 **18:44:33–18:44:52**（6/6）：Utility ready 18:44:33；首崩自动重启 18:44:39 → 18:44:40 ready；二崩 fail closed 18:44:41「重启预算已用尽」；干净退出 18:44:41；打包态启动 4 次（:33/:39/:44/:47）；缺资源 agent_missing 18:44:52。
    - ZIP 轮 2026-09-08 **19:25:51–19:26:10**（6/6，跨 19:25/19:26 两个分钟段）：Utility ready 19:25:51；首崩自动重启 19:25:57 → 19:25:58 ready；二崩 fail closed 19:25:58；干净退出 19:25:58 / 19:26:06；打包态启动 4 次（19:25:51、19:25:57、19:26:02、19:26:05）；缺资源 agent_missing **19:26:10**——只切 19:25 单分钟会漏掉此项与后两次启动，复核须按 19:25:51–19:26:10 整轮取。
  - 口径说明：「退出无孤儿」属进程级检查、由验收方独立复验（孤儿 0），「Hermes 开始/取消入口」属原轮 UI 冒烟观察、无日志时间戳可追溯，两者均不计入上述分项计数。
- **真实模型联调**：配置 `configured=true`、模型名为 `deepseek-v4-flash`、Utility ready=true；六个场景均实际启动了真实 Manager/Utility，但模型端首请求均返回 HTTP **402**，所以结果为：global / customer-accountId / chat-by-session / empty-result / protocol-v2 / cancel 全部 `failed/ai_error`，工具顺序均为空，evidence=0、findings=0、protocolCorrection=false；取消场景因模型尚未进入首步，未能达到 `cancelled`。安全结果计数：跨进程消息 51、模型出口诊断 6；raw sessionId/wxid/手机号/身份证/messageKey/API Key/绝对路径均为 **false**。HTTP 402 属模型服务配额/计费外部阻塞，未伪造通过结果。
- **动态回归**：`hermes-agent-test` **95/95**；`hermes-protocol-test` **198/198**；`hermes-utility-test` **324/324**（36 场景，含 t33 fail-closed ready 门禁 / t34 在途任务保留 protocol_mismatch / t35 纠偏计数按轮次重置）；`knowledge-governance-test` **57/57**；`hermes-ask-test` **40/40**；`hermes-ask-data-test` **42/42**；`persist-guard-test` **36/36**；`settings-nav-test` **59/59**；`customer-workspace-simple-test` **37/37**；`owner-filter-test` **28/28**。
- **打包路径**：`release/WeFlow-1.0.0-Setup.dmg`、`release/WeFlow-1.0.0-Setup.zip`、staging `release/mac-arm64/WeFlow.app`。本轮 builder 明确跳过 macOS 签名（无 Developer ID/公证凭据）。对同一 DMG 提取物执行 `codesign --verify --deep --strict --verbose=2`：**失败，exit 1**（code has no resources but signature indicates they must be present）；`spctl --assess --type execute --verbose=4`：**失败，exit 1**。因此必须写明：**功能冒烟通过，但 macOS 签名/公证门槛未通过，当前产物不能视为正式可分发安装包。**
- **平台范围与清理**：macOS arm64 完成 DMG/ZIP 提取物冒烟；Windows **未真机实测**，静态/交叉构建不能替代真机测试。所有 `node_modules/.cache/hermes-*` 临时驱动、产物、日志、截图和临时 Worker 副本均应在交付前删除；不得提交 release 产物、联调 JSON 或日志。当前未 push，且因真实模型/签名门槛未通过不提交 commit。

## 2.92 GLM-5.3-Flash 真实联调 + 全局模型兼容（2026-09-08，工作区未提交）

> 本节覆盖 §2.91 的 DeepSeek HTTP 402 外部阻塞。用户随后明确本轮只交付 Windows 版本，Mac 不需要打包；因此本轮停止 Mac builder，不以 DMG/ZIP、Developer ID 签名或公证作为交付门槛，Windows 包结构、隐私边界和数据安全门槛不降级。

- **模型可用性**：智谱 OpenAI 兼容端点 `https://open.bigmodel.cn/api/paas/v4` + 模型 `glm-5.3-flash` 鉴权探针 HTTP 200；Key 仅经无回显 stdin 注入本轮进程，未写配置、源码、日志或测试产物。
- **Hermes 六场景真实 Manager/Utility 联调**：global / customer-accountId / chat-by-session / empty-result / protocol-v2 均 `completed`；每项真实调用唯一只读工具 1 次、证据 1 条、findings 1–2 条，模型调用 2 次（工具决策 + 最终结论），`protocolCorrectionCount=0`。cancel 在首个真实模型请求进入在途后立即取消，105ms 落 `cancelled/cancelled`，零工具、零证据、零 findings；底层请求被 AbortSignal 中止。
- **协议与隐私**：六项跨进程消息全部为 protocol v2；逐场扫描 API Key、测试 sessionId、wxid、手机号、身份证、messageKey 均零出现。
- **发现并修复 GLM 全局兼容问题**：`glm-5.3-flash` 始终思考，向 `/chat/completions` 发送 DeepSeek 扩展字段 `enable_thinking:false` 会返回 HTTP 400 / code 1210。`aiApiClient.buildDisableThinkingPayload` 现按服务商生成扩展参数：GLM 模型名或 `*.bigmodel.cn` 端点省略该字段（保持模型默认思考），DeepSeek/现有兼容端点保持原行为。共享调用层带 `disableThinking:true` 的 GLM 真实 JSON 请求已通过。
- **新增回归与本轮复验**：`scripts/ai-provider-compat-test.ts` **4/4**，覆盖 GLM 官方域名、GLM 代理模型名、DeepSeek 保持与通用端点保持；Hermes agent **95/95**、protocol **198/198**、Utility **324/324**、package **79/79**、错误文案 **16/16**；action-rules **36/36**、report-review **37/37**、knowledge-governance **57/57**、insight-noise **32/32**、Hermes ask **40/40**、ask-data **42/42**；root tsc 0、Node tsc 保持 158 条既有基线且本轮相关新增 0；`npx vite build`、`git diff --check` 通过；临时 GLM/Hermes 驱动零残留、孤儿 Utility 进程 0。
- **Windows x64 交付物**：按 Node tsc → Vite → electron-builder 顺序重新构建 `release/WeFlow-1.0.0-Setup.exe`（142,207,982 bytes，SHA-256 `6ad93475eb9794dcac19d7b7628e6f5af64b0df9322b0835c8055a373c7a8189`）。`win-unpacked/WeFlow.exe` 为 PE32+ x86-64；安装器、`app.asar`、外置 `resources/hermes/hermesUtility.js`、Koffi win32-x64、`wx_key.dll` 与 4 个 VC 运行库均存在；ASAR 中 Utility 副本为 0，main/preload/apiMessageWorker/wcdbWorker 各 1，且从实际 ASAR 提取的 main 已确认包含 GLM 兼容逻辑。
- **当前试点结论**：Hermes 真实模型门槛与 Windows x64 交叉打包结构门槛已通过；Mac 按用户要求不打包。Windows 安装、启动、WCDB 读取和 Hermes 生命周期仍须在公司 Windows 真机完成最终验收；NAS/电脑主机部署与告警评测开闸属于后续部署/运营阶段。

## 2.93 真实多人线索分配九刀：同步定向投递 + SLA 哨兵 + 查重完善 + 主管通知闭环（2026-09-09，工作区未提交）

> **依据**：任务书九项（docs/规划/Phase1-内网同步最小版-设计.md 定向投递修订 + shared/leadSla.ts 哨兵约定 + 宪法 §1.3）。SSOT 纪律：notify_inbox 新表先入 DATA-CONSTITUTION §3 登记再动 schema；测试 /tmp 副本隔离零碰 live。

- **① 同步定向投递（lanSyncService 重写）**：下行从公共 `down/` 全员消费改为 `down/<投递键>/` 每销售身份独立队列（投递键=姓名安全化，`deliveryKey` 两端可重复计算），终端只读自己的队列；ACK 协议：终端单事务「业务写+syncApplied/syncOutcome 标记」→ 写 ACK（`up/<终端>/ack/`，基名=幂等键+投递角色，与文件名解耦）→ 中枢 `processUpAcks` 记 `syncAck:` 标记 → `settleDownDeliveries` 结算：全部 applied→outbox sent，任一 conflict/invalid→failed+audit(action='sync_down_fail')，nolead 不结算保留重试；transfer 双投递（新销售 apply + 原销售 remove 只移除不建行）；transfer-apply 目标终端无 lead 时随事件建档（修 nolead 卡死）；主管通知路由中枢本机队列 `consumeSupervisorNotifications` 落地。测试：lan-sync-test **60/60**、lan-sync-e2e-test **37/37**（重写为三库隔离真实多终端：中枢/销售甲/销售乙，九项验收全覆盖——乙轮询碰不到甲事件（字节级断言）、甲离线积压、transfer 双 ACK 不提前结算、重启恢复、重复投递/ACK 零重复）。
- **② SLA 哨兵**：importLeads 不再导入即起计时，新导入未分配线索 `first_contact_deadline=LEAD_SLA_UNASSIGNED_SENTINEL`；scanLeadSla 显式哨兵排除；分配后才起计时（assignLeads 既有链路），claim 不重置、绑定停表、recycle 回哨兵、transfer 重算。测试 lead-sla-unassigned-test **21/21**。
- **③ 已回收列表修复**：`buildMyCards` 纯函数（leadAssignmentView）——待跟进/跟进中按当前有效权属过滤，已回收按最新分配行 sales_name+recycled 过滤（旧实现集合只来自有效 owner 导致恒空）；转派给他人的线索三段全排除。CrmLeadPage 接入。测试 lead-assignment-view-test **64/64**（新增 I 组 8 断言）。
- **④ 好友检测多分库**：`runFriendDetectScan(accounts)` 接收逐账号快照（contacts=null=该库不可用跳过），多库标识先到先得归一幂等；chatService 新增 `getContactsForAccount`（当前账号走常规路径；其他账号在 wcdb 单连接上做全局串行只读轮换「开→读→恢复」）；main.ts 枚举 myWxid∪wxidConfigs 全部账号；命中账号标识过 maskContact 脱敏入审计（friendAccount）。测试 friend-detect-multi-account-test **10/10**。
- **⑤ 主管通知闭环**：runSla1Recycle 第三次回收保持事务语义，escalate payload 富化 reason/recycledAt；DOWN_TYPES 接入 sla1_escalate_supervisor → 中枢队列 → notify_inbox（新表，宪法 §3 登记：idempotency_key UNIQUE、status unread/read 单向、写者唯一=consumeSupervisorNotifications）+ audit sla1_supervisor_notify + outbox sent；IPC crm:notify:list/markRead；资源分配页「回收改派」页签新增「升级提醒」列表（未读徽标/已读/看线索）。测试 sla1-supervisor-notify-test **13/13**。
- **⑥ 导入查重跨 contactType**：crmLeadImportCore `dedupeRows` 改双标识集合（手机号键/微信号键分别跨类型，phone/both/wechat 全参与）+ 重复明细（行号+原因）；importLeads 库内预查重四分类（同批 dupSameBatch/线索池已有 dupExistingLead/正式客户已有 dupExistingCustomer/双标识冲突 conflicts——冲突不合并不插入待人工）；明细脱敏落 lead_import_dedupe 审计，IPC crm:import:dedupeDetail；UI 导入结果分类展示+查重明细弹窗+CSV 导出（BOM，源端已脱敏）。测试 import-dedupe-cross-type-test **14/14**。
- **⑦ SLA2 证据查看打通**：新服务 crmSla2EvidenceService（createSla2EvidenceReader 注入式 + sla2EvidenceGetForLead 单例，main.ts 注入 evidenceResolver）——scanRef 可解析才回查（合成锚点 llm:/rule: → no_anchor），found 返回 maskPrivateText 脱敏摘要+时间+方向+来源；**出口零敏感字段**（无 messageKey/sessionId/wxid/绝对路径/API Key，测试断言 JSON 序列化不含）；cleaned/error/no_evidence 明确状态不伪造；IPC crm:sla2:evidence + preload/d.ts；详情弹窗「查看依据」按钮+证据面板。测试 sla2-evidence-view-test **14/14**。
- **⑧ 批量分配计数**：assignBatchLeads 改按 `res.data.assignments.length` 实际新增计数（旧 `res.ok` 口径把 E201/E301 跳过也计入 assigned/perSales），跳过落 skipped 带 code/reason。测试 assignment-batch-count-test **7/7**。
- **⑨ 过期文案清理**：main.ts「SLA2 规则占位版/真实 LLM 是后续刀」、crmSla2Service 头部「LLM 扫描未实现缺口」、crmOutboxService/crmAssignmentService「抄送主管占位（只记录不发送）」、CrmLeadPage「待 SLA 起算规则上线」——全部改为与现状一致。
- **验证**：root `npx tsc --noEmit` 0 错误；九刀相关 13 个测试脚本全绿（上列 + friend-detect-test 33/33、assignment-test 28/28、assignment-full-test 91/91、identity-test 25/25、sla2-llm-scan-test 26/26、crm-lead-test 59/59、crm-claim-test 17/17、crm-sla-action-test 11/11、owner-filter-test 28/28、evidence-resolver-test 45/45）；lead-sla-reset-test 14/4 与 lead-tag-cleanup-test 10/3 为 live 库快照漂移的存量红测（HEAD 基线 worktree 复跑同败，与本刀无关，同 §2.74 live 数据耦合性质）。

## 2.94 自动备份收尾五缺口：密钥封装/恢复密钥跨机、刷盘失败门禁、删除墓碑、manifest 严格验证、恢复两阶段回滚（2026-09-10，工作区未提交）

> **依据**：任务书五节（密钥安全与新机器恢复 / 刷盘失败不能产生成功备份 / 增量删除墓碑 / manifest 严格验证 / 恢复一致性）。不推倒重写：v2 格式向前兼容（早期无 tombstones 字段的产物按空墓碑处理，HMAC 校验通过后才归一化）。

- **① 密钥安全与新机器恢复**：新增 `autoBackupKeyVault.ts`（零 Electron 可 tsx 单测）——明文 `auto-backup.key` 读取后立即封装迁移并粉碎删除，明文主密钥不再长期落盘；本机封装经注入式 `SecretBox`（`autoBackupSecretBox.ts` 适配 Electron safeStorage：Windows DPAPI / macOS 钥匙串；不可用回退 local-wrap，`backup:auto:status.keyProtection` 如实展示）。恢复密钥导出/导入：口令（≥8 位）scrypt（N=32768/r=8/p=1，参数写入文件，导入限界防 DoS）派生 KEK + AES-256-GCM 封装主密钥，文件含 magic/版本/KDF 参数/salt/nonce/tag/data/指纹；错误口令在 GCM 认证处明确失败且不动本机密钥；本机已有不同密钥拒绝覆盖（封装件零变更）。新机器流程=导入恢复密钥 → `backup:auto:restore` source='network' 从网络层恢复旧机器备份。IPC 四端点 + preload + d.ts + 设置页「恢复密钥（换电脑恢复用）」区块（导出/导入按钮 + 口令输入）。
- **② 刷盘失败门禁**：`crmDbService.persistNowStrict` / `salesDbService.flushNowStrict` 严格变体（失败抛出）；`executeAutoBackup` 任一库刷盘失败 → 立即终止本轮备份：不进 core、不生成 manifest、不更新成功时间（lastAutoBackupSuccessAt 不动），结果带 `stage`（flush_crm/flush_sales/backup）+ 明确错误文案，审计 detail 带阶段；旧的「吞错仅打日志继续备份」已删除。
- **③ 删除墓碑**：manifest 增 `tombstones[]`（logicalName/originalName/deletedAt），增量节点对「基线有、现无」的逻辑库记墓碑；`effectiveEntries` 按链序先应用墓碑再应用文件（重建后同逻辑库取新文件）；恢复组合链应用墓碑——已删除库不从基线复活，目标目录残留同名旧库一并清理（`removedFiles` 返回），按基线时点恢复仍含当时存在的库（墓碑自其节点起生效）。
- **④ manifest 严格验证**：新增 `validateAutoBackupManifestStructure`（导出），`readVerifiedManifest` 在 HMAC 之后执行——schema/version 完整、backupType 合法、logicalName 唯一且与 kind/accountSafeId 一致、文件名白名单（`weflow-(crm|sales)(-<wxid>)?.db`，artifactName 必须=originalName+'.enc'，天然封死路径穿越）、文件条目与墓碑禁重名、nonce(12B)/tag(16B)/sha256(64hex)/plaintextLength(>0) 格式校验；基线引用与链条连续由 chainFor 把守；全部消费口（组链/轮转/网络复制/恢复）统一走该验证。
- **⑤ 恢复一致性**：两阶段替换——全部密文解密+GCM/长度/SHA-256 校验→全部写临时目录并逐一 `validateDatabase`→**所有**目标旧内容先快照→才开始替换/清理；任一步失败按快照回滚全部旧文件（回滚失败也如实并入错误），不出现半新半旧；快照失败（如目标被目录占用）发生在任何替换之前，天然零副作用。
- **测试**：`scripts/auto-backup-test.ts` 重扩至 **111/111**（原 37 断言保留；新增 F service 导出导入/G 封装迁移与错误封装拒绝/H 口令·篡改·防覆盖/I 新机器网络恢复+错误主密钥/J 刷盘失败三轮验证/K 墓碑四态/L 结构验证 9 类拒绝+2 类直接验证/M 前序指针断裂/N fs.renameSync 注入中途失败全回滚+目录占用零替换）。回归 `npx tsc --noEmit` 0 错误；`npx vite build` ✓（产物含新 IPC 端点与设置页区块）；`git diff --check` ✓。
- **⚠️ 平台边界（当前 macOS 开发环境）**：safeStorage 封装、Windows DPAPI、NAS/SMB 网络层真实挂载、应用重启后 sql.js 内存态重载，均属 **Windows 真机待验证项**，本机仅以注入式 SecretBox / 合成目录等价验证，不得声称 Windows 已验证。

## 2.95 自动备份新机恢复三缺口收尾：首次恢复门禁与采用隔离、设置页网络恢复入口、明文密钥清理失败注入（2026-09-10，工作区未提交）

> **依据**：§2.94 交付后复核出的三个真实缺口（新机补跑抢先生成密钥导致跨机恢复被拒 / 设置页无网络恢复入口 / 明文密钥清理失败被吞）。不扩大范围：备份格式版本、AES-GCM/HMAC/scrypt 参数、墓碑与增量链、manifest 校验与恢复回滚算法均未改动。

- **① 新机首次恢复门禁 + 显式采用（隔离而非覆盖）**：`loadOrCreateAutoBackupKeyCore` 生成的新密钥在封装件写入 `origin`（`generated` / `legacy-migrated` / `imported`；旧封装件缺该字段读作 null，一律按门禁关闭处理）。`canAdoptImportedMasterKey(userData)` = `origin === 'generated'`，经 `backup:auto:status.recovery` 暴露给前端。
  - `installImportedMasterKey` **默认行为不变**：本机已有不同密钥一律拒绝覆盖（错误文案现在会指出新机恢复的正确入口）。
  - `opts.adopt=true`（仅门禁开放 + 前端确认弹窗后由 IPC 传入）→ **采用**：本机密钥三件套（`auto-backup.key.wrapped` / `auto-backup.wrap` / 残留 `auto-backup.key`）与本地备份链**整体 rename** 到 `backups/auto-quarantine/<时间戳>-<rand>/`（`key/` + `local-backups/` + `README.txt` + `quarantine.json`，均不含密钥材料）；任一步失败逆序回滚已移动项并抛错，不留半迁移状态；**永不删除**本机旧密钥与旧备份。隔离件可用原 SecretBox 原样解出，人工按 README 即可回到采用前状态。
  - 采用后置位**等待恢复**标记（`backups/auto-recovery-pending.json`）：每日 tick 与启动补跑一律拒绝执行——否则本机空库会被推成网络层最新基线、顶掉旧机器的链，「恢复最新有效链」将恢复出空数据（该场景已由测试实证）。成功网络恢复或用户主动「立即备份」清除标记。
  - `recoveryRunning` 硬门禁覆盖「采用」与「网络恢复」全过程：`executeAutoBackup` 是唯一会调用 `loadOrCreateAutoBackupKey` 的备份入口，被挡住即保证恢复期间不生成新密钥、不建新备份。
- **② 设置页网络恢复入口**：自动备份区块新增「从网络备份恢复」——确认弹窗（明确「将替换本机业务数据库 / 成功后应用自动重启 / 校验失败不替换任何文件」）→ `window.electronAPI.backup.autoRestore({ source: 'network' })`（省略 backupId = 最新有效链）。恢复中禁用重复点击、「立即备份」与恢复密钥导入导出；失败信息（网络路径未配置 / 密钥错误 / 备份链损坏 / 数据库校验失败 / 恢复失败）行内常驻展示 + toast；成功只提示，**重启由主进程 IPC 负责**，前端不调用任何 relaunch API。另新增「采用恢复密钥」确认弹窗与「等待从网络备份恢复」状态行。
- **③ 明文密钥清理失败注入**：`installImportedMasterKey` 的旧明文分支仍引用已改名的 `shredLegacyKeyFile`（悬空引用，`tsc -b` 报 TS2552）→ 统一为 `purgeLegacyKeyFile`。该函数语义：覆写与删除**分别**在独立 try 中（覆写失败仍必须尝试删除）→ 结束后终检存在性 → 明文仍在则**明确抛错**（不报成功）；错误信息只含文件名，不含密钥材料。`wrapped` 命中分支同样执行残留明文清场，不因 wrapped 优先而跳过。
- **测试**：`scripts/auto-backup-test.ts` 111 → **149/149**。新增 O（新机真实启动顺序：启动补跑先生成密钥与初始备份 → 默认导入仍拒绝覆盖 → 显式采用并隔离 → 采用后调度拒绝补跑且配置网络路径也不推空基线 → 从网络恢复最新链成功且旧机器链未被顶掉，24 断言）、P（fs.writeFileSync / rmSync 定向注入：覆写失败仍删除、删除失败明文残留必须失败且不泄密钥、故障解除后重试自愈、wrapped 与 legacy 并存仍清理，9 断言）、Q（设置页静态断言：确实调用 `autoRestore({ source: 'network' })`、不带 backupId、前端无 relaunch、导入带 adopt 开关、展示恢复失败信息，5 断言）。**变异验证**：去掉 `purgeLegacyKeyFile` 存在性终检 → 2 项失败；去掉等待恢复门禁 → 6 项失败（含「恢复内容为旧机器链末端状态」），证明断言真实生效而非空转。
- **⚠️ 残留边界（已由 §2.96 修复）**：若用户在**导入恢复密钥之前**就把新机器的网络备份路径指向旧机器共享目录，新机器首次启动补跑会向该目录写入一份本机空库基线，之后从网络恢复会整体失败。**该缺口已在 §2.96 以「网络目录异密钥预检」堵死**，不再需要用户手动删除目录。此处保留原始记录仅作历史说明。
- **⚠️ 平台边界**：safeStorage / DPAPI / 钥匙串、NAS/SMB 真实挂载、重启后 sql.js 内存态重载仍为 Windows 真机待验证项，本机仅以注入式 SecretBox 与合成目录等价验证。

## 2.96 自动备份两处主流程修复：local-wrap 采用后重启无法解封、异密钥网络目录被写入（2026-09-10，工作区未提交）

> **依据**：§2.95 交付后复核出的两个确定影响真实主流程的问题。不扩大范围：未加磁盘故障注入、未加事务、未加额外回滚或其他防御性保护；备份格式版本、AES-GCM/HMAC/scrypt 参数、墓碑与增量链、manifest 结构验证与数据库恢复替换算法均未改动；已有设置页网络恢复入口与显式 adopt 确认保持不变。

- **① local-wrap 采用恢复密钥后重启无法解封（密钥永久解不开）**：无 safeStorage 的环境下 `importAutoBackupRecoveryKey` 会先 `localWrapSecretBox(userData)`，该对象**闭包持有旧包装密钥**；`adoptImportedMasterKey` 随后把 `auto-backup.key.wrapped` 与 `auto-backup.wrap` **一起**移入隔离目录，却继续用这个旧 box 封装导入密钥——新封装件由已被搬走的旧包装密钥加密，根目录已无对应 `auto-backup.wrap`；重启时 `localWrapSecretBox` 重新生成一把包装密钥，GCM 认证必然失败。
  - **修法**：`adoptImportedMasterKey` 在隔离完成后、写入导入密钥之前，判定 `box.name === LOCAL_WRAP_PROVIDER` 则**为新环境重建** `localWrapSecretBox(userData)`（生成新的 `auto-backup.wrap`），再用它 `writeWrappedKey`。根目录 `auto-backup.key.wrapped` 与 `auto-backup.wrap` **成对匹配**；隔离目录里旧 wrapped + 旧 wrap **也是一对**（同时被 rename 走），旧环境仍可人工恢复。safeStorage 正常路径不受影响（密钥材料由系统设施保管，与 userData 目录无关）；主密钥始终不明文落盘；未新增任何密钥抽象。
  - `LOCAL_WRAP_PROVIDER` 常量抽出（封装件 provider 名唯一真源），README 同步改为「先删除根目录下采用后新生成的两件，再把 key/ 下的两件**一起**移回」——与最终文件结构一致。
- **② 异密钥网络备份根目录被写入（污染旧机器备份链）**：新机在导入恢复密钥前把 `autoBackupNetworkPath` 指向旧机共享目录时，startup-catchup 会用本机新生成的密钥把空库基线写进去，之后即使采用了旧机恢复密钥，`restoreAutoBackup` 也会因根目录存在无法通过旧密钥 HMAC 校验的节点而整体失败，且只能手动删目录。
  - **修法**：`autoBackupCore` 新增 `findForeignBackupDirs(root, key)`，在 `runAutoBackup` **向网络目录写入任何文件之前**（回填旧节点、本轮目录、manifest 写入、轮转删除全部在其后）逐个用当前主密钥完成 manifest HMAC + 结构 + 备份节点（GCM/长度/SHA-256）验证。目录非空且任一节点验证失败 → 本轮网络层 `status='failed'`，错误信息为「网络备份目录包含不属于当前备份密钥的备份（…），已拒绝写入…」；**本地备份照常成功**；不建新目录、不写 manifest、不轮转、不删除、不改写、不忽略任何异密钥节点。下游所有网络写入本就以 `layers.network.status === 'ok'` 为门，无需额外改造。`restoreAutoBackup` 的整根链验证**未放宽**。
  - 正常同密钥网络目录的复制与轮转行为完全不变（同密钥节点全部通过预检，走原路径）。
- **测试**：`scripts/auto-backup-test.ts` 149 → **175/175**。
  - **R（12 断言，真实重启）**：真实 local-wrap 回退（不传 secretBox）生成本机密钥与初始备份 → 保留旧 box 与旧 wrap 字节 → 显式 adopt → 断言隔离目录同时含旧 wrapped 与旧 wrap → 断言根目录重新生成配对的两件且包装密钥已换新 → **用旧闭包对象解根目录新封装件必须失败**（证明旧包装密钥确实失效）→ 断言隔离的旧 wrapped 仍由旧包装密钥解出原密钥 → **丢弃旧 SecretBox，重新 `localWrapSecretBox(userData)`，`loadOrCreateAutoBackupKey` 必须成功并等于导入密钥**（另附不传 box 的应用真实回退路径同样解出）→ origin 保持 `imported` → README 与最终结构一致。**不使用内存 makeTestBox**，因此能真实暴露包装密钥文件被移走的问题。
  - **S（18 断言，真实顺序）**：老机用 oldKey 在共享目录建全量+增量链并取**目录树全量快照**（相对路径 + 每个文件 SHA-256）→ 新机**在导入前就已配置同一网络路径** → startup-catchup → 断言本机层成功、网络层 failed 且文案含「不属于当前备份密钥 / 已拒绝写入」→ 断言**快照逐字节相等**（目录集合与全部文件内容零改动）、未新增本轮目录、未回滚本机备份 → 显式 adopt oldKey → **从共享目录恢复最新链成功且内容为老机链末端状态**，全程**未手动删除任何目录** → 恢复后快照仍逐字节相等。
  - **变异验证**：还原 `writeWrappedKey(..., box, ...)` → R 的 4 项失败，含「重启后重新解封成功」报 `本机备份密钥解封失败（local-wrap-v1）：Unsupported state or unable to authenticate data`（与问题描述完全一致）；去掉异密钥预检 → S 的 8 项失败，含「采用密钥后从共享目录恢复最新链成功」报 `manifest 哈希认证失败`（污染后的下游症状）。两处源文件已还原并复跑 175/175。

## 2.97 认领满 24h AI 首次分类 + 信息缺口反问卡（PRD 2.4，2026-09-10，工作区未提交）

> **依据**：PRD v3.4 需求项 2.4（触发=认领满 24h + 手动按钮；B 档 proposed→confirmed 才可上行；间接信号带证据出提案；信息缺口反问卡；unknown 合法）。与新消息阶段分类（salesStageClassifier，A 档直写）是**两条独立链路**——触发轴是 assignment 生命周期而非消息流，未改名复用。

- **assignment.claimed_at**（宪法 §1.3 修订）：认领时刻毫秒列，`claimLead` 是本机业务写入口（同事务），`lanSyncService.applyUpEventTx` 是中枢复制落点（上行 claim 回放携带 claimedAt 落库，非新人工业务入口）；转派新行 NULL 重新计时；存量 NULL 不回填不触发（§2.54 时间纪律）。**禁止用 updated_at 反推认领时间**。
- **first_classification 表**（宪法 §3 登记行，crmDb + ENTITIES 注册）：认领轮次级提案事实表，`assignment_id` UNIQUE = 轮次幂等键（转派新建 assignment 行 = 新轮次，旧轮次永不改写）。状态机 `pending → proposed → confirmed/rejected`，`failed` 可重试**不写假结果**；proposed/confirmed/rejected 行存在时不重复调模型。
- **服务** `crmFirstClassifyService.ts`（+ 纯核 `crmFirstClassifyCore.ts`：固定 prompt/容错解析/缺口检测/source_id 编解码，零 electron 可单测）：
  - 触发：`scanClaimed24h`（claimed 且 claimed_at 满 24h 且无轮次行；调度器 60s 首扫 + `crmFirstClassifyScanIntervalMin` 间隔，terminal 角色不跑）+ 手动「立即分析」（`crm:firstClassify:run`，不受 24h 限制）。扫描/手动同一执行函数。
  - 材料：聊天记录 + 昵称/备注（chatService.getContacts，尽力而为）+ 已确认收货地址（shipping_info）+ 已有客户档案 + 线索登记信息；缺啥不编啥，sourcesUsed 进 evidence_json。
  - **证据硬门**：字段缺（evidence_key 或 evidence_text）→ 丢弃记 droppedNoEvidence；stage/customer_type 非 unknown 必须带依据否则降级 unknown；昵称/模糊关键词只形成疑似提案。
  - confirm 落正式事实边界：customer_type → `customer.type`（仅已关联 customer，走 setCustomerType 带审计）；stage → `customer_profile.stage` **仅当前 unknown 才落**（不覆盖新消息分类 A 档结果，intent_tag_log source='first_classification_confirmed'）；intent_score 无正式字段只留 confirmed 行；画像字段 → account enrich 字段集（不覆盖已有值与 manual/locked）。reject 零正式写入、拒绝原因进审计。裁决均写 proposal_event（entity_type='first_classification'）。
- **信息缺口反问卡**：follow_up_task `trigger_type='info_gap_ask'`（稳定枚举，宪法 §3 登记），`source_id = assignment_id*10 + gapIndex`（1-6：客户类型/公司行业/需求型号/数量/预算/采购时间），配 `idx_ft_sla_once` partial unique 双保险——同轮次同缺口只一张 pending。卡内容 = 静态话术模板（建议自然提问，**不自动发消息**），analysis 记缺口判定依据。字段确认钩子（新增零依赖 `crmLifecycleHooks.ts`：applyInfoField accept / setAccountFieldManual / setCustomerType / registerOpportunityDeal emit）→ `reevaluateInfoGapCards` 双向往返：已满足关 pending 卡（done + closedReason + audit `info_gap_autoclose`，历史保留），当前轮次仍缺的补出卡。
- **前端**：线索池销售卡（claimed 态）新增「AI 首次分类」按钮 → 弹窗展示轮次状态/提案字段与证据/缺口/失败原因，支持立即分析、确认写入、拒绝（可填原因）。
- **修复的既有缺陷**（本刀测试暴露）：`todoUpdate` 签名有 `analysis` 但实现不落库（已补）；——反问卡依据全靠它。
- **缺口事实口径注意**：数量/需求型号看 `status IN ('active','won')` 商机（成交登记即关单转 won，只看 active 会让已成交数量永远判缺）。
- **测试**：`scripts/claimed-24h-classification-test.ts` **75/75**（A 未认领不触发 / B 不足 24h / C 满 24h+幂等 / D 转派重计时 / E 手动 / F 只进 proposed / G 确认落事实+关卡 / H 拒绝留痕 / I 证据硬门 / J unknown 合法 / K 六缺口卡 / L 去重 / M 钩子自动关闭 / N 失败重试 / O AI 未配置）。AI 经 `setFirstClassifyAiRunner` 注入（仅替换 HTTP 层，状态机/落库/审计全真）。回归：assignment-full 91/91、crm-enrich 61/61、action-funnel 25/25、tsc 零错误、vite build 通过。
- **配置**：`crmFirstClassifyEnabled`(true) / `crmFirstClassifyDelayHours`(24) / `crmFirstClassifyScanIntervalMin`(30)。

## 2.98 AI 简报六态 + 按需识别 + 关闭白天自动链路 + 日调用上限（PRD《AI简报与按需识别》，2026-09-12，工作区未提交）

> **依据**：`docs/规划/AI简报与按需识别-PRD-v1.0.md`（实施契约）。三批一次落地：§5.1 简报六态与持久化游标、§5.2「AI 识别这个客户」按钮 + §5.4 关闭白天自动链路（不可拆）、§5.3 全局重新生成 + §5.5 用量打标/价格表/上限预警。**产品纪律**：AI 只做"提取与建议"，合并/归属变更/发布永不自动执行。

- **§5.1 简报六态**（`morningDigestService.decideState`）：`pending_data` / `crm_only` / `all_covered_clear` / `empty_account` / `failed_or_blocked`，裁决**顺序即优先级**——扫描失败与额度阻断永远压过"看起来没事"。硬约束：任何失败/阻断不得渲染成「无风险/无需跟进/全部跟完」（`scripts/morning-digest-test.ts` e 组按禁用词表穷举守）；新账号空态**不调 AI 凑摘要**，正文直接说「尚未核验」。事实版降级保留**全部信号**（不再 top3），正文只报条数不报结论。
- **持久化游标 `ai_scan_cursor`**（salesDb 直建，宪法 §3 已登记）：`(scope, session_id)` 联合主键，`last_processed_at` 单位**秒**（WCDB 口径，与 JS 毫秒的换算收敛在服务层）。scope 现为 `'digest'` / `'manual'` 两个；`cursorSet` **单调只进不退**（非正数、回退值直接忽略，不写假进度）。取代了原 `lastSeenTimestamp` 内存游标（重启即失忆 → 重复付费）。
- **§5.2 按需识别**：`salesFollowUpService.identifyCustomer` 是唯一入口。流程 `trim sessionId → isAiConfigured → wcdbService.isConnected → cursorGet('manual') → nowSec - 7天 兜底 → getMessages(30)`；**无新消息即 `noNewContent` 且零模型调用**（可重复点击不重复付费）。有产出时落 `trigger_type='ai_detected'` + `created_by` 记当前销售，账本 `purpose='manual_identify'` / `trigger='manual_button'`。
- **全局单飞 `identifyCoordinator`**：识别/简报**共用一把锁**，任一进行中所有入口按钮全禁用（`sales:identify:activity` 广播 + 订阅）。这不是"每个按钮各锁各的"——是全局互斥。
- **§5.4（R）删除白天自动链路**（"抽取逻辑原样保留，只换扳机"）：沉默扫描 `runSilenceScan`、活跃会话分析 `analyzeRecentActivity`、催办识别 `scanUrgeFollowUps`、DB 变更监听 + 2s debounce、4h 沉默扫描定时器、启动预热、`salesFollowUpService.scan()` 及其 120min 冷却全部移除。**保留** `startActionEngineScheduler()`：`runFullScan` 是纯本地规则计算、零 AI 调用，删掉会连带毁掉今日行动清单。
  - **顺带修掉的既有缺陷**：`if (this.processing) return` 会在扫描进行中**静默丢弃**新触发（无日志无补偿）；随链路删除一并消失，当前设计不存在"丢弃"路径。
- **§5.5 用量打标 + 价格表 + 日上限**：
  - **唯一采集层** `electron/services/ai/aiApiClient.ts`，三职责 = 记帐 / 额度闸门 / 统一错误语义。调用点清单与 `purpose` 对照表见 `docs/规划/AI调用入口与消费清单.md`（**新增 purpose 必须同步登记**；`grep -rn "callChatCompletion(\|simpleCompletion(" electron | grep -v usageContext` 可查漏标）。
  - **价格表** `electron/services/ai/aiBudget.ts`（`PRICE_TABLE_AS_OF` / `PRICE_TABLE_SOURCE` 随表落库）。未收录模型 `priceFor` 返回 **null**，`estimateCost` 也记 **null 而非 0**（"算不出"与"没花钱"必须可区分），另有 `unpricedCalls` 计数上界面。
  - **硬拦截按调用次数、不按金额**：刊例价对未收录模型为 null，按金额拦截会把"算不出"读成"没花钱"→ 静默超支。`aiDailyCallLimit`(默认 60) 是硬闸门，80% 预警（`WARN_RATIO`），阻断发生在 HTTP 之前并落一行 `status='blocked'` 账本（`used = calls - blockedCalls`，避免阻断自我累加锁死）。阻断错误 `AiBudgetBlockedError` 的文案含「额度/上限」，界面据此判定额度类错误。
  - **闸门全局注入**（`configureAiBudget`）：`main.ts` 启动时注入上限 provider，手工拼的 config 也受约束——不依赖各调用点自觉传参。
  - **偏差记录**：PRD §5.5 按「⌈活跃会话数/20⌉ 次调用」估，但抽取是**逐会话**的，一轮 ≤20 会话实际可达 20 次调用，公式**低估最多 20 倍**。已按"抽取逻辑原样保留"实现轮次（`ROUND_SESSION_LIMIT = 20`），默认上限 60 并把算式写进配置注释；未改抽取语义。
- **§5.3 全局「重新生成简报」**：`regenerateToday()` 覆盖同日行（同日**仅一行**、`generateTodayDigest` 命中既有快照即幂等返回）。
- **清理 R 产生的死旋钮**：设置页原有 5 个控制项（活跃触发冷却期 / 沉默联系人扫描间隔 / 沉默阈值 / 沉默上限 / 每次扫描上限）在链路删除后**已无任何消费者**，但仍在界面上承诺"有新消息时触发活跃分析""超过此天数触发沉默类见解"——属误导，已随本刀移除；对应的 4 个配置键（`aiInsightSilenceDays` / `aiInsightSilenceMaxDays` / `aiInsightScanLimit` / `aiInsightCooldownMinutes` / `aiInsightScanIntervalHours`）同步从主进程 schema 与渲染侧 `CONFIG_KEYS`/getter/setter 删除。**「立即触发测试见解」按钮保留**（用户显式触发，非自动链路）。
- **新增文件**：`electron/services/ai/aiBudget.ts`、`docs/规划/AI调用入口与消费清单.md`、`scripts/ai-identify-test.ts`。
- **测试**：`scripts/morning-digest-test.ts` **40/0**（六态穷举 + 禁用词表 + `crm_only` 文案分流 3 条）、`scripts/ai-identify-test.ts` **48/0**（中立默认 / 游标单调与 scope 隔离 / 零调用短路 / 调用点契约 / 单飞 / 价格表与闸门 / 阻断记账）。改写：`insight-noise-test.ts` **35/0**（d1/d3 由"旧链路接线"改为"不得重新引入自动分派"）、`insight-unnamed-session-test.ts` **9/0**（锁定删除结果 + 保留 `isSessionIdLike` 调用形式护栏；若将来重新引入扫描类入口，必须同时带回客户档案门控）。
- **未实测项（如实标注）**：Windows 打包态、真机点击穿透、真实模型调用端到端 —— 本刀未验证。
- **复核修复（2026-09-12，同一工作区）**：① `insightProfileService.callProfileApi` 原直连 `/chat/completions`，**不过日上限闸门、不入用量账本**，已改走 `callChatCompletion`（`purpose: 'profile'`）；② 设置页「工作原理」仍在承诺已删除的自动链路（2s 防抖分析 / 每 4 小时沉默扫描 / 冷却期），已改写为「AI 只做三件事」；③ `salesActionEngine.onNewMessage` 拆线没拆弹（调用方已删、函数体含 AI 调用仍在），已连 `salesStageClassifier.classifyStage` 及其 prompt/解析一并删除并加静态护栏（`insight-noise-test` d10-d12）；④ `crm_only` 文案在「有聊天」时说「暂无聊天数据」，已按 `activeSessions` 分流；⑤ 死桥接 `sales:todo:scan`（preload + 类型 + 主进程 handler）已删；⑥ 客户工作台空队列态去掉 🎉 与「都处理完了」。逐项改动与实测输出见 `docs/实施记录/AI简报与按需识别-实施记录-claude-20260912.md` §6。

---

## 2.99 「AI 自动判定非客户」重定义为「AI 见解屏蔽名单」（2026-09-13，工作区未提交）

> 详细改动清单 / 决策落点 / 验证输出 / 遗留项见 `docs/实施记录/AI简报与按需识别-实施记录-claude-20260912.md` **§6.8**。

- **背景**：`aiInsightNonCustomerBlacklist` 的自动写入链路（AI 输出【阶段=未知】→ `blacklistNonCustomer`）已在 §2.98 随 `applyParsedStageSignal` 降级一并删除，但配置键、类型与设置页 UI 仍沿用「非客户」语义——留下一个**没有写入方、却仍能屏蔽用户**的名单。本刀重定义为纯手动管理的「AI 见解屏蔽名单」。用户拍板三项：显式单客户触发绕过屏蔽 / 加入入口放客户工作台「…」菜单带二次确认 / 存量条目全部视为旧版自动判定产物。
- **⚠️ 开工核实证伪（影响改动面，勿据旧描述理解现状）**：开工单称「手动触发也走这道闸门、批量仍受挡」，**两句均与源码不符**。`isSessionAllowed` 全仓**只有 1 个调用点**（`insightService.ts:419`，`triggerTest()` 选会话处，仅决定挑哪个私聊做测试）；`triggerSessionInsight`（`:482` 传 `'manual'`）与 `batchProfile` **都不调用它**——即批量原本**完全不受名单约束**，名单此前只在「挑测试会话」时生效。故本刀的闸门是**新增**在 `generateInsightForSession`，不是修改既有拦截。
- **闸门按「触发方式」裁决**：`EXPLICIT_MANUAL_TRIGGER_REASONS = {manual, test, message_analysis}` 放行；其余（`activity` / `silence` / `alert:*` 等自动与批量类）命中名单即返回 `skipped: true` 且**不调模型**。放行时结果文案追加 `blacklistBypassNote` 轻提示——**不静默**（六态纪律）。判定依据是 triggerReason 而非调用点硬编码名单，避免重蹈原设计覆辙。
- **「AI 识别这个客户」不经此闸门（核实结论）**：`identifyCustomer` → `salesFollowUpService.extractForSession`，该文件 `triggerReason` **零引用**，直接调 `aiApiClient` 并自带游标（`purpose: 'manual_identify' / 'digest'`），**从不经过 `generateInsightForSession`**——名单从来没有拦截过识别。本刀**未**为其补闸门（识别是用户显式单客户动作，按拍板决策本就应放行）。
- **存储升级**：`string[]` → `{sessionId, addedAt: number|null, source: 'legacy_auto'|'manual'}[]`。**兼容读旧格式**，读时经新增的 **SSOT 模块 `shared/insightBlacklist.ts`**（主进程与渲染进程共用，杜绝第二套事实源）归一到新形态；`addedAt: null` 在 UI 显示「时间无记录」，**不伪造日期**；重复加入不覆盖既有来源（防 legacy 被洗成 manual）。写入路径统一走同一归一函数。
- **UI**：设置页区块改名「AI 见解屏蔽名单」+ 卡片化（`--radius-card`/`--shadow-card`）+ 按来源分组（manual 在前，legacy 组带「以下条目来自已下线的自动判定，可能存在误判」提示）；每条 = 头像首字 + 显示名（经 `customer_profile` 解析，解析不到回落 wxid 不留空白）+ 来源 + 加入时间 + 「解除屏蔽」；空态「名单为空 · 所有联系人都会正常触发 AI 识别」。客户工作台「…」菜单新增加入/解除（按当前状态切换），二次确认 → toast。
- **死代码清理**：`blacklistNonCustomer()` 及其私有声明残留已删，全仓 `blacklistNonCustomer` 在 `electron/` `src/` `shared/` `scripts/` **零残留**（仅剩 `docs/HANDOVER.md:249` 与归档 AGENTS 的历史流水，按文档治理规则不回改历史）。顺带修正 `insightService.ts` 内一处描述已删行为的过期注释。
- **测试**：`insight-noise-test.ts` **39/0**（+d13–d16：自动写入零残留 / 按触发方式裁决 / 名单读写走共享 SSOT / `isNonCustomerBlacklisted` 恰好 2 次——锁死不得把黑名单判定加回 `isSessionAllowed`）、`insight-dedup-test.ts` **19/0**（c 组扩至 c1–c9：旧 `string[]` 兼容归一、`legacy_auto` 标注且 `addedAt=null`、手动加入记毫秒时间戳、重复加入不覆盖来源、解除屏蔽、闸门源码接线）。**c1 写旧格式继续通过**——存量用户升级不丢名单。
- **验证**：`npx tsc --noEmit` **0 错误**；`tsc -p tsconfig.node.json --noEmit --composite false` **156**（= 基线，0 新增）；HANDOVER §11 基线 11 个套件**全绿**。
- **未实测（如实标注）**：真机点击（解除屏蔽 / 菜单加入解除）、存量真实名单的 legacy 组观感、`blacklistBypassNote` 的端到端渲染——均未在真实 GUI / 真实数据下确认，覆盖来自纯函数断言 + 源码接线断言 + 类型契约。
- **遗留**：① 配置键名仍为 `aiInsightNonCustomerBlacklist`，与新语义不完全对应；改名需迁移层（读旧写新 + 回滚预案），本刀未做；② **设计稿 `weflow-设置页美化设计稿-20260913.html` §03 文案与拍板决策①冲突**（设计稿称「AI 识别」也被屏蔽），已按决策①改写为真实语义，设计稿本节待产品侧同步修订。


## 2.100 设置页「身份档案」「内网同步」卡片化（2026-09-13，工作区未提交）

> 纯 UI 改造：**不改 IPC、不改 state 字段名、不改保存时机**。设计稿 `weflow-设置页美化设计稿-20260913.html` 的 §01 / §02 已标注「已落地 2026-09-13」。

- **身份档案**（`SettingsPage.tsx`）：区块改为 `.s-card`（图标色块 + 标题 + 副标题 + 状态 pill「已建档 / 未建档」），内嵌身份可视化卡 `.identity-card`（头像取姓名首字，未建档时占位 `<UserRound>`；下方显示「当前署名：{identityActorLabel} · 本机档案」，`identityActorLabel` 为空则该行不渲染）。姓名输入、保存按钮的禁用逻辑（姓名为空即禁用）**逐字保留**。
- **角色控件：自绘 `.custom-select` → 内联 `SegmentedControl`**（radio 语义，←/→/↑/↓ 循环移动且点选即生效——与原下拉「选择即存」一致；未选中态无任何分段高亮）。**保留第 4 项「暂不选择」**，与设计稿的三项不符——`identityRole=''` 是已持久化的真实取值，删掉该项将无法清除角色（属行为变更），且 `settings-nav-test` 的 A9 把此处枚举与 `SettingsNavShell.IDENTITY_ROLE_OPTIONS` 逐字锁定。取值枚举、保存时机未变。
- **内网同步**：区块改为 `.s-card` + 状态 pill（未启用 / 同步中 / 同步中 · 有积压）；新增同步拓扑图（本机节点 ⇄ 共享目录节点 + 上/下双车道，车道方向文案沿用原 hub/terminal 两套口径——中枢=下行产出/上行消费，终端=下行消费/上行产出）；车道流动动画为纯 CSS（`@keyframes s-sync-flow`），**未启用时车道保留但不流动**（拓扑仍可读，不假装正在同步）并显示「同步未启用（共享目录或角色未配置）」；`prefers-reduced-motion: reduce` 下关闭动画。积压改为两张指标卡（待发出 / 待消费，0 正常色、>0 warning 色）。共享目录输入（blur 保存）、角色分段选择器（未配置 / 中枢·主管机 / 终端·销售机，立即保存）、终端标识（等宽 `.s-mono`）、「立即同步」（loading / 反馈逻辑保留）均照旧。
- **⚠️ 时间戳单位证伪（开工单有误，勿据其理解）**：开工单称 `LanSyncStatus` 的四个「最近时间」是**秒级**时间戳、需 ×1000。核实源码后**证伪**——`K_LAST_DOWN_EMIT` / `K_LAST_DOWN_APPLY` / `K_LAST_UP_EMIT` / `K_LAST_UP_APPLY` 四处均由 `lanSyncService.ts` 以 `setScanState(key, Date.now())` 写入毫秒值（`setScanState` 的形参名即 `ms`，读回无任何量纲转换）。按其字面执行会得到约公元 57000 年的日期。故新增的 `formatRelativeTime()` **未做 ×1000**。`src/types/electron.d.ts` 中 `LanSyncStatus` 的字段注释同样误写为「秒级时间戳」——**本次未改该文件**（属类型注释，改动面超出本刀 UI 范围），此处如实登记为待修项。
- **相对时间心跳**：新增 30s `setInterval`（仅在 `lanSyncStatus.enabled` 时启动），只为让「N 分钟前」随时间推进重算，不参与任何判断、不写盘。0 值显示「—」，时钟回拨不显示负数。
- **控件收口**：`.field-input` 原先只在 `WelcomePage.scss:403` 定义，设置页经懒加载 chunk 引用该样式很脆弱。本次在 `SettingsPage.scss` 的 `.settings-page` 作用域内**复刻**该规则（尺寸对齐既有 `.snav-input`，`SettingsNavShell.scss:274` 已有同款处理先例）。**作用域限定**保证 WelcomePage 表现不受影响。图标全部 lucide SVG（无 emoji），按钮沿用设置页 `.btn` 体系，控件键盘可操作且 `:focus-visible` 有可见焦点。
- **⚠️ 令牌不一致（如实登记，未统一）**：本节新增的 §01/§02 样式使用新版 `--color-*` token 集（`--color-bg-surface` / `--color-border` / `--color-text-*` 等），而更早落地的 §03「AI 见解屏蔽名单」区块用的是旧版别名（`--bg-primary` / `--text-primary` / `--border-color` / `--warning`）。两套 token 在 `src/styles/main.scss` 中并存且均有深浅色定义，**渲染结果一致**，故本次未做统一——统一令牌属跨区块重构，超出本刀范围。
- **SCSS 踩坑（已修，留档防复现）**：`.sync-lane { &--up &__track::after { … } }` 会编译成 `.settings-page .sync-lane--up .settings-page .sync-lane__track::after`（一行两个 `&` 时后一个把完整祖先链再展开一遍），**永远匹配不到**。已改为 `.settings-page` 下的完整后代选择器，代码内留注释。排查手段：`npx sass --no-source-map src/pages/SettingsPage.scss /tmp/x.css` 后 grep 选择器。
- **测试**：`settings-nav-test.ts` **73/0**。A9 守卫（角色选项须与 `SettingsNavShell` 一致）的**源码定位标记**随控件形态更新（`{ value: '', label: '暂不选择' }` → `ariaLabel="身份角色"`），**断言口径与等价保证不变**（仍是两处枚举逐字比对，含「暂不选择」空值项）。其余 12 个 §11 套件全绿未受影响。
- **验证**：`npx tsc --noEmit` **0 错误**；`tsc -p tsconfig.node.json --noEmit --composite false` **156**（= 基线，0 新增）；HANDOVER §11 全部 13 套件绿（crm-workbench 89/0、crm-golden 47/0、crm-claim 17/0、crm-autoconfirm 58/0、crm-lead 59/0、buyer-header 76/0、crm-docgen 81/0、morning-digest 47/0、ai-identify 48/0、insight-noise 39/0、insight-dedup 19/0、insight-unnamed-session 9/0、settings-nav 73/0）；SCSS 编译通过且全部新选择器验证可匹配。
- **未实测（如实标注）**：真实 GUI 下的观感与动画、深色主题实际配色、相对时间心跳长跑表现、`prefers-reduced-motion` 在真机上的生效——均未在真实运行的应用中确认，覆盖来自类型检查 + 测试套件 + 编译期选择器核对。
- **遗留**：① `src/types/electron.d.ts` 中 `LanSyncStatus` 四个时间戳的「秒级」注释是错的（实为毫秒），未改；② 设置页新旧两套 token 集并存未统一；③ `docs/CURRENT.md` 与 `docs/归档/README.md` 仍未纳入版本控制（`??`）。


## 2.101 商机 + 漏斗合并（v2.1）：阶段分析 + 优先处理 + 汇入统一信号流（2026-09-13，工作区未提交）

> 实施契约：`/Users/yang/weflow优化/weflow-商机合并设计稿-v2-20260913.html`（五状态 + 附页「字段来源与交互规则」）。完整实施记录见 `docs/实施记录/商机合并与优先处理-实施记录-claude-20260913.md`（含设计稿附页**逐条**落点对照表、真实验证输出、遗留项）。

- **页面合并**：`OpportunityPage` 增加双视图分段控件（列表 / 阶段分析），**列表视图行为不变**；视图态走 URL `?view=analysis`。`SalesFunnelPage` 退役——侧栏 CRM 组移除「漏斗」，`/sales-funnel` → `RouteStateRedirect to="/opportunities?view=analysis"`（**旧链接/书签不失效**）。切换视图**保留各自筛选与滚动位置**（滚动容器是 App shell 的 `.content`，由 `scrollParentOf()` 向上查找，不归页面所有）。报表组「行动漏斗」未动。
- **漏斗退役引用清零**：删除 `src/pages/SalesFunnelPage.{tsx,scss}`、`src/utils/funnelSummary.ts`、`scripts/funnel-test.ts`；`salesDbService.funnelStats()` 失去全部调用方后一并删除（连同其独占的 `dayKey()`/`orderedDays()`），`sales:funnel:stats` IPC + `preload.funnelStats` + `electron.d.ts` 类型同步移除。
- **事实源单一**：`shared/opportunitySignals.ts`（纯函数、零 IO、零 AI）= 阶段阈值 / 理由归类 / 优先层排序 / 候选资格 / 视图载荷类型。`electron/services/opportunityAnalysisService.ts` 只读跨库装配（crmDb + salesDb），新增只读 IPC `crm:opportunity:analysis`。
- **口径纪律（本刀的核心约束，逐条见实施记录 §2）**：① 管道与阶段分析**仅统计 active**，won/lost 只进「近 30 天成交」独立指标；② 「报价发出后未获回复」**唯一合法来源是 `quote_signal`**（`quoted_at` / `customer_replied_at=0`），`quotation` 只证明记录创建——无 quote_signal 关联时文案**降级为「报价记录创建 X 天」**且不标热、来源明写「不断言「未回复」」；③ `follow_up_task.due_at` = **销售自己承诺的截止**，≠ 客户承诺答复时间（该字段不存在，本刀不使用）；④ 阈值 了解 7 / 比价 3 / 决策 2 天，成交段不适用；⑤ 排序用优先层（逾期时点 → 确定性紧迫信号 → 价值与意向 → 沉默时长），**界面不展示公式**，每条理由带来源标注。
- **最大卡点**：滞留数与滞留金额**双指标并列**，`isMaxStuck` 仅当两项**同时最大**才为真（滞留数并列时由滞留金额决胜），**不输出单一综合分**（防巨单劫持）。
- **汇入单一聚合链**：`salesActionEngine.getUnifiedSignals()` 新增「4c 商机确定性信号汇入」遍——先按 `session_id` 并入同客户既有卡（同商机幂等跳过），无既有卡才新建 `opp:<id>` 兜底卡；**未新增第二套候选/排序/落库管线**，TOP N 只是 `priorityScore` 降序结果的视图截取。`SignalSource` 增加 `opportunity` 变体（带 `sourceRef` 可追溯）。
- **按需 AI（唯一 AI 出口）**：行内「生成跟进建议」点击才调用，**复用既有 `sales.actionSuggest` → `simpleCompletion({ usageContext: { purpose: 'action' } })`**——`action` 的既有语义即「行动建议生成 · 手动 · salesActionEngine」，按任务规则**不新增近义 purpose**，消费清单无需增行。顺带补齐 `electron.d.ts` 中一直缺失的 `actionSuggest` 类型声明（此前调用方走 `(window as any)`，运行时行为未变）。
- **「去跟进」落点**：有有效会话（`isSessionIdLike` 微信号三形态校验）→ 应用内聊天页；**无有效会话 → 降级**打开商机详情 + toast「未找到与 TA 的聊天会话，已打开商机详情」（**不静默**）。微信 deep-link **未核实，未做**，列实施记录 §5 遗留项。
- **测试**：新增 `scripts/opportunity-analysis-test.ts` **72/0**（已纳入 §11），覆盖 active-only 口径、quote_signal 判定与降级文案、优先层排序、汇入合并去重、聚合只读与 TOP N 即排序前缀；相邻套件复跑全绿（crm-opportunity 110/0、today-action-consumer 14/0、insight 系 39/19/16/9、action-rules 36/0、action-analysis-judgment 37/0、action-funnel 25/0）。
- **验证**：`npx tsc --noEmit` **0 错误**；`tsc -p tsconfig.node.json --noEmit --composite false` **156**（= 基线，0 新增）；`npx tsc -b tsconfig.node.json` 重建产物 + `npx vite build` ✓；HANDOVER §11 全部 13 套件绿（计数同 §11 所列）。
- **未实测（如实标注）**：真实 GUI 观感/深色主题/键盘 Tab 与 `:focus-visible` 真机表现、双视图滚动位置回填在长列表上的实际效果——均未在真实运行的应用中人工确认。
- **遗留**：① 微信 deep-link 待验证；② 「查看待办」落 `/home`（设计稿未指定，未新增第二套待办视图）；③ 生成建议无复制按钮；④ 候选行主标题用 `displayName`（多条 active 商机 `product` 为空，强行展示会出现空标题）；⑤ active 商机 `amount_cny` 恒为 0 属既有数据现状，金额口径 `amount_cny > 0 ? amount_cny : amount` 与列表页既有展示一致。


## 2.102 审计流水 + 存量迁移报告人话化（纯展示层，2026-09-13，工作区未提交）

> 设计契约：`/Users/yang/weflow优化/weflow-审计与迁移报告人话化-设计稿-20260913.html` §01–§04。完整实施记录（含 **50 条 action 全量枚举表**、真实验证输出、遗留项）见 `docs/实施记录/审计与迁移报告人话化-实施记录-claude-20260913.md`。
>
> **纯展示层改造**：不改 `audit_event` / `migration_report` 的表结构与任何写入路径（本刀 `electron/` 侧唯一改动是只读查询多返回一个 `labels` 字段）。

- **人话词典 = 单一事实源**：新增 `shared/auditDict.ts`（React-free、零 IO，主进程与渲染进程共用）+ 手工维护的 `shared/auditDict.d.ts`（本仓 `shared/*.ts` 的既有约定，缺失会报 TS6305）。50 条 action 各含 `{ 人话动作名, pill 色调, 细节模板函数 describe }`；`system:*` 操作人一律显示「系统自动」。
- **词典覆盖护栏（本刀的核心防线）**：新增 `scripts/audit-dict-test.ts`（**203/0**，已纳入 §11）。`collectActions` 静态扫描全部 `electron/**/*.ts` 的**四种写入形态**——① `auditAppend(actor,'action',…)` ② `INSERT INTO audit_event` 后随数组 ③ `create('audit_event',{action:'…'})` ④ `writeAudit('action',…)` 调用点——断言「源码里出现的每个 action 都在词典里」。未命中词典的 action **不静默**：渲染为原始 key + 灰色「未翻译」标签，并附静态断言锁死 `[object Object]` 不得复活。
- **修复的真实缺陷**：① `assignment_weight_change` 的 `diff:[{…}]` 经旧 `detailSummary` 的 `String(v)` 拍平 → `[object Object]`（真 bug，已按 `diff`/`weights` 两种存储形态分别渲染为「杨青 95→100」）；② `sla1_remind` 的毫秒时间戳 `deadline` 被旧整行拍平后的手机号正则吞成 `178****899431`（**已实测毫秒**：`{"deadline":1788580272923}`）。
- **脱敏口径（与 `scripts/audit-query-test.ts` 既有断言调和）**：`maskContact` / `redactPii` 落在共享词典，**只对字符串叶子**打码——数字（时间戳）原样保留，故「人话整句」里不再出现被打码的长整数；实体名解析后同样经 `maskContact`（与线索列表 `maskLead` 同形，`138****0219`），解析不到回落 `type #id`，**不留空白**。`技术细节` 折叠内保留 raw 原值（按设计稿）。
- **实体名解析（只读新增）**：`crmAssignmentService.resolveEntityLabels()` 批量解析 `lead`/`account`/`customer` 显示名（`lead` 按 `name → contact_raw → contact_normalized → wechat` 逐级回落，因约 48% 的 `name` 为空），**每类一条查询、无 N+1**；`crm:audit:query` 响应新增 `labels`（key = `` `${entity_type}:${entity_id}` ``）。渲染层把 `lead #12` 换成人话名字并深链到 `/leads?leadId=<id>`（`CrmLeadPage` 新增该深链消费）。
- **批量合并**：同 action + 同操作人 + 同一分钟**连续**行折叠为「批量 … N 条」（渲染层折叠，**不丢行**，展开即逐条）。时间戳打码逻辑按设计稿删除。
- **迁移报告**：副标题去术语（「幂等执行（scan_state 仅记游标）· 结果落 migration_report」→「启动时自动执行的存量数据整理结果 · 只读」）；模块名与失败原因人话化（`no_identity_anchor` → 「缺少手机号和微信会话，系统无法自动核对身份，需要人工处理」）；raw 字段收进「技术细节」折叠；统计 chips 原样保留。
- **⚠️ 开工单与源码不符处（如实登记，未按字面执行）**：任务提示里的 `sla1_recycle` **全仓不存在**，真实 action 是 `lead_recycle`——未造死别名充当已实现；提示里的「action 词典约 40 条」实际落为 **50 条**（含护栏扫出的 4 条 `writeAudit` 包装写入：`diff_task_autoclose` / `warranty_reminder_autoclose` / `trade_in_proposal_accept` / `trade_in_proposal_reject`，此前无一处被翻译）。
- **测试**：新增 `scripts/audit-dict-test.ts` **203/0**；`settings-nav-test.ts` **74/0**（73→74，A10l/A10m 原断言内联 `ACTION_LABELS`/`ACTION_SEMANTIC` 映射表，随形态改指 `shared/auditDict.ts`，**断言口径与等价保证不变**）；`audit-query-test.ts` **32/0**（a13–a16 新增 `labels` 契约、解析不到不返回、零写回归）。
- **验证**：`npx tsc --noEmit` **0 错误**；`tsc -p tsconfig.node.json --noEmit --composite false` **156**（= 基线，0 新增）；`npx vite build` ✓，新选择器（`.arow*`/`.agroup*`/`.tech__body`/`.migration-report__issue*`）全部编译进 `dist/assets/SettingsNavShell-*.css`，旧 `audit-trail__table`/`migration-report__table` 零残留；**真实库目检**：对 `weflow-crm-wxid_wen24wq8ojio22.db` 按 action 分层采样 29 行（覆盖**全部 15 种**在库 action），`sla1_remind` / `assignment_weight_change` / `lead_assign_batch` 三类均为整句人话、无 raw key、无 `[object Object]`、无被打码时间戳。
- **未实测（如实标注）**：真实 GUI 下的观感、深色主题配色、键盘 Tab 与 `:focus-visible` 真机表现、批量折叠展开的交互手感——均未在真实运行的应用中人工确认，覆盖来自纯函数断言 + 源码接线断言 + 真实数据渲染 + 编译期选择器核对。
- **遗留**：① `account`/`customer` 的显示名解析按设计稿实现但**真实库暂无对应 entity_type 的审计行**（写入方存在），未在真实数据下端到端目检；② 深链 `/leads?leadId=<id>` 的真机跳转未实测；③ 迁移报告的失败原因/模块名映射只覆盖当前已知码，**出现新码时直接显示原始 key**（`migrationIssueReason` / `migrationModuleLabel` 的 `|| raw` 回落，非空白、非编造，raw 值另在「技术细节」折叠内），但**没有**审计流水那样的「未翻译」标签——迁移侧未知码不会在 UI 上显式标注未翻译。

## 2.103 设置页人话化 P0–P3：档位化 / 折叠 / 术语清扫（纯展示层，2026-09-13，工作区未提交）

> 开工单：`/Users/yang/weflow优化/设置页人话化-任务提示.md`。完整实施记录（改动清单按 P0–P3、档位映射表、真实验证输出、遗留项）见 `docs/实施记录/设置页人话化-实施记录-claude-20260913.md`。
>
> **纯展示层改造**：目标用户是一线销售（非技术人员）。**不改 config 键名 / 默认值 / 读写时机，不改 IPC，不改行为逻辑**——所有档位只是展示层映射，选中档位 = 写入同一组既有键。`electron/**` 与 `shared/**` 本刀零改动。

- **P0 自动化程度档位化**：新增 `src/utils/settingsTiers.ts`（纯函数、零 IO、无 React，**单一事实源**）。三个阈值滑杆（`crmEnrichAutoApply` / `crmEnrichThreshold` / `crmAutoConfirmThreshold`）合并为一个三档分段选择器：保守 `0.90/0.80/0.85`、**标准（推荐）= 落库默认 `0.85/0.70/0.80`**、积极 `0.75/0.60/0.70`；每档带一句话后果（口径对齐总开关「高置信直接写入，中置信进跟单中心待你打勾」）。三个滑杆**迁入**（非删除）「高级 · 微调」折叠，各带 `aria-label`。**交叉校验**：`applyEnrichThreshold` 在待确认下限高于直接写入阈值时 clamp 并**即时 toast**（不静默改值），`applyEnrichAutoApply` 反向调低时一并下移。跟单中心区块的原滑杆位置换成带当前真实值的指向说明；`tax_no` 字段名不再直出。
- **P1 数据库连接密钥区**：新增 `src/utils/backupStatusLabel.ts`（`backupLayerLabel` / `keyProtectionLabel`，未命中一律「未知状态」，**不泄露原始英文状态码、不假装成功**）。「自动获取/自动识别」按钮保留为唯一主路径，手填输入（微信数据库密钥 / 账号 wxid / 图片解密密钥 XOR·AES）收进「高级 · 手动填写（一般不需要）」折叠。术语去行话：WCDB 调试日志→诊断日志（排查问题时使用）、SMB 共享目录→办公室共享文件夹（SMB）、待发出/待消费→待上传/待接收、「本机不再跑 SLA 回收器」→「超时未跟进的线索不再由这台电脑自动回收」。
- **P2 AI 基础配置 + API 服务**：新增 `src/utils/aiServicePresets.ts`。通用 API 地址→「AI 服务地址」（DeepSeek / OpenAI 兼容 / 自定义三预设，非自定义时只读展示当前地址），**删掉「末尾不要加斜杠 / 程序自动拼接 `/chat/completions`」等实现细节**；通用 Max Tokens→「单次回答长度上限」三档（短 512 / **标准 1024 = `useState` 默认值** / 长 2048），数字输入收进「高级 · 自定义长度」。API 服务 tab 正文整体收进默认收起的「高级 / 开发者」折叠——**tab 本身仍留在左侧导航**（`settings-nav-test` 的 17-tab 基线）。
- **⚠️ 折叠的边界（踩坑点）**：API 服务 tab 的两个确认弹窗（`showApiWarning` / `adoptKeyConfirmOpen`）**必须留在折叠之外**——`<details>` 收起时子树不渲染，弹窗放进去会点不出来。已加静态断言锁死。
- **P3 折叠与术语清扫**：四处提示词文本框（AI 见解 / 足迹总结 / 群聊总结 / 消息解析，各带 `aria-label`）统一收进「高级 · 自定义提示词」；「调试工具」→「故障自检」收进高级；微博标实验性并折叠配置（Cookie 弹窗原有标注未回退）；模型管理去掉与实际不符的「(Whisper)」（实为 `SenseVoiceSmall`）；「首触 SLA（小时）」→「新线索跟进时限（小时）」。**「更新」tab 开发版描述（`SettingsPage.tsx:6791`）未回退。**
- **⚠️ 开工单与源码不符处（如实登记）**：任务单写「**三处**提示词文本框」，实际有**四处**——漏了足迹总结（`:5214`）。四处一并收进折叠，未按字面只做三处。任务单「API 服务 tab 整体收进折叠」只能落在**内容**上，不能折叠 tab 本身（导航基线锁死 17 tab）。
- **测试**：新增 `scripts/settings-tiers-test.ts` **68/0**（已纳入 §11）。核心是两条**默认值防漂移**断言：自动化「标准」档 == `useState` 初值 `0.85/0.70/0.80`、回答长度「标准」档 == `useState` 初值 `1024`——任一单边改动（改档位常量不改初值，或反之）都会让**升级用户在未做任何操作的情况下被静默改掉阈值**，这两条就是防那件事的。另有 SegmentedControl 复用、clamp 调用点与非静默 toast、滑杆「迁入而非删除」的区块级断言、弹窗留在折叠之外、`&` 二次展开防回归。
- **验证**：`npx tsc --noEmit` **0 错误**；`tsc -p tsconfig.node.json --noEmit --composite false` **156**（= 基线，0 新增）；`npx vite build` ✓；`settings-nav-test` **74/0**（未削弱、未改断言），另有 audit-dict 203/0、audit-query 32/0、crm-workbench 89/0、crm-golden 47/0、crm-claim 17/0、crm-autoconfirm 58/0、insight-noise 39/0、insight-dedup 19/0、opportunity-analysis 72/0 全绿。新选择器 `.settings-page .s-adv*` 全部编译进 `dist/assets/SettingsNavShell-*.css`，**旧踩坑形态（`&` 二次展开）零残留**。
- **未实测（如实标注）**：真实 GUI 观感、深色主题配色、键盘 Tab 与 `:focus-visible` 真机表现、折叠交互手感、SegmentedControl 窄窗口换行——均未在真实运行的应用中人工确认。
- **遗留**：① 微博「数字 UID」是白名单表格的**一整列**，折叠它需重构表格栅格，超出本刀安全边界——已替代为表头/placeholder/空态三处加「实验」字样，**列的折叠未做**；② `AdvancedFold` 内容未重新缩进（避免 300+ 行纯空白 diff），代价是这几处 JSX 缩进浅一级；③ `src/utils/backupStatusLabel.ts` 与 `shared/auditDict.ts` 的 `BACKUP_LAYER` 是两份同词汇词典（`shared/` 不能反向依赖 `src/`，语境不同），改词需两处一起看。

## 2.104 Phase 3a 首轮实现：中央服务 + Electron 双向事件同步（2026-09-14，已提交 `160786e`/`b295155`/`ae6903b`）

> 完整实施记录（改动清单 / 端点契约 / 逐项验证 / 部署边界）见 `docs/实施记录/中央节点同步通道-实施记录-claude-20260914.md`。
> 端点级契约见 `docs/API-CONTRACT.md` §3；中央投影对象入宪见 `docs/DATA-CONSTITUTION.md` §3.1。
>
> **⚠️ 本节为历史首轮实现。** 该三刀暴露的八类 P0/P1 阻断项已于 2026-09-15 修复（见 **§2.105**），
> 复核又发现的 5 个代码/测试缺口以 **§2.106** 收口。本节中的测试计数为**首轮值**
> （client 24 / adapter 50 / e2e 尚未建立 / app 55 / projection 19），
> 当前值为 client 24 / adapter 86 / e2e 61 / app 136 / projection 36。
> 措辞纪律：**Phase 3a 代码侧仍未收口**——部署与真机验收一条未做，不得写成「Phase 3a 已收口」或「全项目代码已完成」。
>
> **本刀只做代码侧**：用户已确认中央机基础安装部署由负责人完成，但**完整部署、真机、Windows、SSE、真实消息推送、
> 反向代理与证书、备份恢复演练、告警验收统一放到代码完成之后**——本节的「✅」一律指**代码 + 自动化验证**，
> 不指部署或真机。**不得把「中央机安装完成」写成「中央业务服务、反向代理、证书、备份恢复、告警及端到端验收全部完成」。**

### 新增：中央服务 `central/`（Fastify 5 + PostgreSQL，Docker Compose）

- **形态**：独立 Node 服务（`central/src/`），`type: module` + NodeNext + tsx；**未换技术栈**（沿用既定 Fastify / PostgreSQL / node-postgres）。
- **文件**：`index.ts`（入口）/ `app.ts`（路由与鉴权）/ `config.ts`（环境变量，缺失即拒绝启动）/
  `crypto.ts`（`createSecret` / `secretHash` / `safeSecretEqual`）/ `permissions.ts`（角色→能力表驱动矩阵）/
  `projections.ts`（显式投影注册表）/ `store.ts`（接口）/ `postgresStore.ts`（生产实现）/ `memoryStore.ts`（测试实现）。
- **迁移**：`central/migrations/001_initial.sql`（工作区/员工/设备/邀请码/事件/回执/审计）、
  `002_central_projections.sql`（10 张显式投影表）。`migrate()` 在单事务内按序应用并逐条登记 `schema_migration`，可重复执行。
- **11 个端点**（`GET /health`、`GET /ready`、`POST /api/v1/bindings/invitations`、`POST /api/v1/bindings/claim`、
  `POST /api/v1/devices/rotate`、`POST /api/v1/devices/revoke-self`、`POST /api/v1/devices/:deviceId/revoke`、
  `POST /api/v1/sync/push`、`GET /api/v1/sync/pull`、`POST /api/v1/sync/ack`、`POST /api/v1/sync/commands`）。
- **安全**：设备令牌与邀请码**只存 sha256 哈希**（明文只在响应体出现一次）；Fastify logger `redact` 排除
  `authorization` 与 `idempotency-key`；错误处理只记 `message/stack/code`（不整体打印 pg 异常，其 `parameters` 可能带业务值）；
  日志级别真正传给 Fastify logger；错误码结构 `{ok:false, code, message, requestId}`。
- **部署件**：`docker-compose.central.yml`（build context = 仓库根）+ **仓库根 `.dockerignore`**（排除 `node_modules`/`dist`/`.git`/
  `.env`/`central/secrets/`/日志/`*.db`/`src`/`electron`/`docs`/`resources`/`release`；显式放行 `central/.env.example`），
  防止构建上下文把客户库、密钥、构建产物拖进镜像。

### 新增：协议与客户端

- `shared/centralSync.ts`：**跨端协议唯一真源**——协议版本 1、`CentralSyncEvent` 信封、10 类实体枚举
  `CENTRAL_ENTITY_TYPES`、`validateCentralSyncEvent`、`findForbiddenCentralField`（**递归**扫描
  `chat*` / `message*` / `conversation` / `session_id` / `wcdb_path`，命中即拒收）。
- `electron/services/centralSyncClient.ts`：HTTP 客户端。HTTPS 强制（仅 `http://127.0.0.1` / `localhost` 例外）、
  `Bearer` 鉴权、`Idempotency-Key`、超时、非 2xx 与非 JSON 响应响亮报错、**错误串里不出现令牌**。
  `claim()` 保留返回的设备令牌；新增 `revokeSelf()`。
- `electron/services/centralProjection.ts`：**上行投影注册表**——只读既有结构化表（customer / customer_identity /
  assignment / account.owner_sales / opportunity / quotation+contract / audit_event / customer_judgment /
  knowledge_base(source=proposal)），**绝不扫聊天表**。身份值只上行 `identityHash`（sha256）+ `identityMasked`；
  judgment 的 `session_id` 先经 `customer_profile.customer_id` 映射，**映射不到的行直接跳过**（session_id 不出本机）；
  `evidence_text`（客户原话）不上行，只上行 `evidenceKey`。

### 新增：Electron 同步适配 `electron/services/centralSyncService.ts`

- **上行**：复用既有 `outbox_event`（幂等键原样沿用）+ 投影游标（存 `scan_state`）；仅当中央接受后才标记 `sent`；
  被中央拒绝的事件标 `failed` 并计数 + 写 `sync_push_rejected` 审计（**不静默吞掉、不无限重试**）；
  命中禁字段的事件标 `failed` + 审计 `sync_forbidden_field_blocked`。
  `entityId` / `idempotencyKey` 一律加设备前缀（`<deviceId>/<ref>`），避免各机自增 id 相撞。
- **下行**：复用 Phase 1 已封板的 assignment 状态机——**新增 `lanSyncService.applyDownEventDirect()`**，
  走同一 `applyDownEventTx` 与同一套 `scan_state` 幂等标记，只是不经 SMB 文件系统（「只换传输 adapter」）。
  `supervisor_correction` **不静默覆盖**：落 `notify_inbox` 待人工确认，本机事实行字节不变；
  `permission_change` 只记声明与审计，**不当作访问控制**。未知类型立即回 `invalid`（不卡队列）；
  `nolead` 连续 `retry` 上限 5 次后改判 `invalid` 并前移游标（**有界重试**）。
- **调度器**：绑定成功必启动；解绑后安全空转（`isConfigured` 为假时不发任何请求）；轮巡间隔每次心跳实时读取；
  `restartCentralSyncScheduler()` 先停后起，**不产生重复定时器**；成功清错误、失败记录（遮罩 + 截断 300 字）。
- **传输互斥**：`getLanSyncConfig()` 在 `centralSyncEnabled` 时直接返回 `{enabled:false}`——**同一 outbox 不被两个传输层竞争结算**；
  中央同步关闭时 Phase 1 SMB 行为完全不变。
- **解绑三态如实**：先请服务端吊销（`revoke-self`），成功才清本地；网络失败时**保留令牌与绑定**并如实报「解绑未完成」；
  「仅清除本机凭证」是显式的 force 选项，且返回值区分 `revoked` 与 `localCleared`——**不假装服务端已撤销**。
- **设置页**：新增中央同步卡片——绑定状态、服务地址、员工与角色、设备标识、上行/下行游标、待上传数、最近同步时间、
  最近错误；操作含「绑定 / 立即同步 / 解绑（服务端同步吊销）/ 仅清除本机凭证」。设备令牌存 **safeStorage**（`ENCRYPTED_STRING_KEYS`）。

### 新增：审计词典

`shared/auditDict.ts` 增 5 条 Phase 3a 词条：`central_unbind` / `sync_push_rejected` /
`sync_forbidden_field_blocked` / `central_supervisor_correction_pending` / `central_permission_change_recorded`。
（`scripts/audit-dict-test.ts` 的「词典覆盖源码 action」硬门禁要求：新增审计写点必须同步补词条，本刀未放宽该断言。）

### 测试

- 新增 `scripts/central-sync-client-test.ts` **24/0**（传输约束 / 鉴权 / 失败语义 / 不泄令牌 / 端点契约；注入假 fetch，**不发真实网络请求**）。
- 新增 `scripts/central-sync-adapter-test.ts` **50/0**（上行投影与禁字段 / 推送语义 / 下行状态机 / 中央专有下行 /
  有界重试 / 解绑三态 / 调度器与 SMB 互斥）。
- 新增 `central/test/*`：`app-test.ts` **55/0**、`projection-test.ts` **19/0**、`migration-test.ts` **23/0**、`context-test.ts` **6/0**。
- `central/package.json`：`typecheck` / `test` / `build` 三条命令齐备（`test` 串联四个套件，含 `.dockerignore` 上下文校验）。

### 验证（2026-09-14 实测）

`npm run typecheck` **0 错误**；`node scripts/typecheck-node-ratchet.cjs` **electron/ 类型错误 0（基线 0）**；
`npx tsx scripts/p0-3-closed-gate.ts` **6/0**；`git diff --check` 干净；
central 侧 `npm run typecheck` / `npm test`（55+19+23+6 全 0 失败）/ `npm run build`（`dist/central/src/*.js`）全部通过。
Phase 0/1/2 既有套件（canonical / customer-event 四套 / assignment 系列 / audit 两套 / knowledge-governance 112 /
lan-sync 两套 / auto-backup / hermes 系列）全部保持通过。

### ⚠️ 未实测 / 未验收（如实标注，不得写成通过）

- **`docker build` 未执行**：本机 Docker daemon 不可用；`.dockerignore` 正确性由 `central/test/context-test.ts`
  按 Docker `filepath.Match` 语义做静态等价验证，**不等于镜像构建过**。镜像体积与构建产物为部署验收项。
- **无真机联调**：无两台真实机器之间的 HTTP 同步演练；无反向代理 / 证书 / HTTPS 真实终结；
  无 SSE 与真实微信消息推送验收；无 Windows 打包验证；无公证签名验证。
- **无真实 PostgreSQL 运行态数据**：`app-test` 走内存 store（与 `postgresStore` 同款语义），
  `migration-test` 只做 DDL / 迁移执行校验，**未在真实 pg 实例上跑过端到端同步**。
- **冲突裁决未细化**：当前为「服务端版本闸门 + 客户端 `conflict` 回执」，多写者合并策略留待 3a 演练。
- **WeKnora / 中央 MCP 未做**：属 Phase 3b。

### 遗留（与既有技术债一致，非本刀引入）

`scripts/assignment-correction-test.ts` **15/2**：A2/A3 两条断言比对的是 2026-09-05 冻结的真实库快照分布
（`许丽娟:1511 / 李林辉:1356 / 杨青:981`，现为 `1527/1373/998`），属**既有 live 数据漂移**，
非本刀改动所致（本刀在未绑定状态下零分配写入）。**未放宽断言**，如实登记为已知红项。
## 2.105 Phase 3a 阻断项修复：封死敏感字段出机与跨设备越权（2026-09-15，已提交 `8e757f7`/`7a4c5fa`/`5024030`/`79fe517`/`0be636b`）

> 完整对照表、两处真实缺陷的复盘与残留清单见 `docs/audit/中央同步-阻断项修复-审计报告-claude-20260915.md`；
> 实施记录见 `docs/实施记录/中央节点同步通道-实施记录-claude-20260914.md` §8。
> 本轮**只修阻断项**，不扩功能，不改 P0/P1/P2 既有业务语义与状态机；`160786e` / `b295155` / `ae6903b` 三刀**未被改写**，修复以追加提交落地。

### 修了什么（八类，逐条）

1. **敏感字段出机（P0）**：每个上行 `eventType` 走**显式最小字段白名单**，不再整包投递 outbox 载荷。
   `bind_wx` 只出 `identityType`/`identityHash`/`identityMasked`/`customerRef`/`source`（原始 wxid 不出机，
   哈希复用既有身份归一规则）；`first_touch` 不出手机号 / 微信号 / `contactNormalized` / `contactRaw`；
   `claim` 从 canonical 分配行构造合法安全投影。服务端投影载荷**严格白名单，多字段即拒收**
   （`unknown_field:<名>`，prefer reject 而非静默裁剪）；禁字段识别加强（`rawChat`/`chatHistory`/`messages`/
   `messageRaw`/`contactRaw`/`contactNormalized`/原始 wxid …），同时**不误伤** `evidenceKey`/`messageKey` 锚点。
   日志 / 错误 / 审计**只记字段路径与稳定错误码，不记被拦字段的值**。
2. **同工作区内跨设备越权（P0）**：上行 `entityId` 必须落在 `principal.deviceId` 命名空间（否则
   `entity_id_not_owned`）；既有投影**只允许原 `source_device_id` 更新**，跨设备改写一律显式冲突
   （**更高的 `aggregateVersion` 也不能覆盖**）；`customer_identity` 唯一身份冲突落**冲突记录**；
   `sales` 角色只能上传销售设备能合法产出的结构化投影（`ownership` 等分配侧类别被服务端拒收）；
   本机自报角色**仍只作展示**；bootstrap 管理员 `workspaceId` 为空时不得调用常规 push/pull/ack（400 E101）。
3. **既有 outbox 真正接通中央（P0）**：逐事件（`assign`/`transfer`/`recycle`/`claim`/`bind_wx`/`first_touch`/
   `sla1_escalate_supervisor`）定义方向、中央端点、目标员工/设备、白名单载荷、ACK 终态与重试语义；
   `assign`/`transfer`/`recycle` 走 `command` 下发，**不再伪装成 `direction=up` 的投影**经 `/sync/push`；
   目标解析失败**显式报错并保持 pending**，**绝不按显示姓名猜人**；队列查询先按类型过滤再取批（不再 `LIMIT 50` 后过滤）；
   **只有中央确认接收后才结算本机 outbox 行**；临时网络错误保持 pending，永久契约错误转 `failed` + 审计。
4. **增量投影漏更新（P1）**：可变表改 **(updated_at, id) 复合水位**（append-only 表仍用 id 游标）；
   同毫秒多行更新不漏；幂等键带实体版本（同一实体新版本 → 幂等键不同、`entityId` 稳定、`aggregateVersion` 严格递增）；
   删除 / 状态 / 归属 / 金额 / 阶段变化均产生新版本；不做每分钟全表重传。
5. **被过滤行卡游标（P1）**：投影读返回 `{drafts, watermark, scanned, skipped, full}` 与跳过原因；
   暂不可投影的行**不阻塞后续合法行**；被跳过的可变行补齐后经台账**重新入扫**；禁字段拦截**不每分钟重写同一条审计**；
   永久拒收与临时失败分离（永久可推水位并留审计，临时**不得**推水位）。
6. **中央引用统一（P1）**：统一 `scopedRef(deviceId, localRef)`；
   `entityId` 与全部本机投影引用同一命名空间规则；`customer_identity.customerRef` 精确 join
   `central_customer.entity_id`，`customer_judgment.customerRef` 同理；归属 / 商机不再把 `account:<id>` 当作中央客户；
   报价引用可解析到真实中央实体；**不新建第二套客户/账户平行语义**；数据模型确实缺映射的，登记为待合并，不编造。
7. **下行命令校验（P1）**：`shared/centralDownCommand.ts` 提供**类型级契约 + 可复用纯校验器**
   （SMB 与 HTTP 共用同一份）：逐类型声明合法 `entityType`、必填载荷、`deliveryRole`、目标、枚举与长度上限、版本前置；
   `eventType`/`entityType` 不匹配服务端拒收；员工+设备双指定必须同属一人；畸形目标 UUID 返 **400**（不是 pg 500）；
   `applyDownEventDirect` 不再绕过业务校验；畸形指令**不写** lead / assignment / notify_inbox / audit / 幂等标记。
8. **真实端到端契约测试（P0 证据）**：新增 `scripts/central-sync-e2e-test.ts`（**44/0**，首轮值；现为 **61/0**，
   见 §2.106）——真实业务生产者 →
   `outbox_event` → `CentralSyncService` → `CentralSyncClient` → Fastify `app.inject` → `MemoryCentralStore` →
   投影/指令 → `pull` → 本机既有状态机 → ACK → outbox 结算。**无 Docker 依赖**。

### 本轮修掉的两处真实缺陷

- **`readVersioned` 的 AND/OR 优先级错误**：原 `extraWhere` 扫描级谓词拼成
  `ts > ? OR (ts = ? AND id > ? AND 谓词)`，`AND` 优先于 `OR` → 所有晚于水位的行绕过谓词出机。
  后果：`owner_sales` 为空的归属投影照常上行，被中央以 `missing_required:ownerSales` **永久拒收**，
  对应 outbox 行永远结算不掉。处置：该类规则下沉到投影自身的 draft 构造（`ownershipDraftOf`），
  扫描与台账 recheck 共用，`extraWhere` 机制整体删除。
- **上行审计投影泄漏原始 wxid**：`audit_event.detailMasked` 曾出现 `{"wxid":"wxid_…"}` 原样出机
  （原擦洗只内联手机号与密钥正则，未复用 `maskContact`）。处置：改为**字段名驱动 + JSON 感知**的擦洗器，
  字段名谓词直接复用 `shared/centralSync.ts` 新导出的 `isForbiddenChatFieldName`/`isForbiddenIdentityFieldName`，
  本机与中央**共用同一份禁字段清单**。

### 附带修复：中央把客户端 4xx 记成 500

缺 `content-type` 的请求体触发 Fastify `FST_ERR_CTP_INVALID_MEDIA_TYPE`(415)，全局错误处理器不看
`statusCode` 一律回 500 并按「中央服务内部错误」记日志——调用方错误污染服务端监控。
已按 `statusCode` 区分请求侧 4xx 与真实 5xx，日志只对 5xx 记 error；补 `app-test` L1/L2 正反断言。

### 新增设置项

| 键 | 默认 | 说明 |
|---|---|---|
| `centralSyncSupervisorCode` | `''` | **SLA1 升级主管的稳定工号**（`sla1_escalate_supervisor` 的中央投递目标）。按工号解析，解析不到即显式报错并保持 pending——**绝不按姓名猜人**。已登记于 `docs/API-CONTRACT.md` §3 与设置页 |

### 验证（2026-09-15 实测）

见本文档「测试命令」一节与 `docs/实施记录/中央节点同步通道-实施记录-claude-20260914.md` §8.3。

### ⚠️ 如实披露的残留

- **下行指令的线索档案面**（措辞已由 §2.106 校正）：**只有 `assign` / `transfer` 携带 `lead` 子对象**，
  `recycle` 与通知/声明类指令不带（携带即整事件拒收）。中央 HTTP 通道固定 6 个字段
  （`CENTRAL_LEAD_FIELDS`：`leadId`/`name`/`contactType`/`contactNormalized`/`source`/`note`），
  `contactRaw` / `wechat` 一律 400；SMB 内网文件通道保留 Phase 1 的 8 字段历史口径。
  接收端 Phase 1 状态机按 `(contact_type, contact_normalized)` 定位或建线索，故 `contactNormalized`
  **必然过网**——聊天正文两个方向都拦，该线索档案面**为已披露残留**，不声称「下行零身份值」。
  本行原写「`assign`/`transfer`/`recycle` 必带 6 个线索字段」，与代码不符，已在 §2.106 更正。
- **冲突裁决**：服务端版本闸门 + 跨设备改写拒绝 + 唯一身份冲突记录 + 客户端 `conflict` 回执；
  多写者合并策略仍未定。
- **未做的验收一条未变**：`docker build`、真实 PostgreSQL 端到端、反向代理与证书、双机同步演练、
  离职移交演练、上行延迟 ≤5 分钟实测、Windows 打包态、SSE 与真实消息推送 —— **全部未执行**。
- **WeKnora / 中央 MCP**（Phase 3b）未实现；**PRD 2.10 / 2.11** 未完成；**Phase 4** 仍是未启动的 Backlog。

### 结论措辞

本轮关闭的是**八类阻断项**，不是 Phase 3a 整体。**Phase 3a 代码侧仍未收口**。

## 2.106 Phase 3a 复核收口：移交双目标投递、下行 lead 白名单分档、引用闸门与中央操作审计（2026-09-15，已提交 `6646338`/`862f0fc`/`57a9714`）

> 完整对照见 `docs/audit/中央同步-阻断项修复-审计报告-claude-20260915.md` §5；
> 实施记录见 `docs/实施记录/中央节点同步通道-实施记录-claude-20260914.md` §9；端点契约见 `docs/API-CONTRACT.md` §3。
> 前 8 个提交未被改写，本刀以追加方式落地。

复核在 §2.105 之后又发现 5 个代码/测试缺口，逐一收口：

1. **`transfer` 中央指令链此前是断的**。`commandPayloadOf()` 没有 `transfer` 分支、返回 `{}`，
   投递时被 `validateDownCommand()` 以缺字段拦下 → 该 outbox 行直接落 `failed`；
   而 e2e 头部却写着「覆盖 transfer」，实际从未调用 `transferAssignment()`——属**覆盖声明不实**。
   本刀补齐分支（复用既有 `commandLeadOf()`，不另建一份线索构造），一条 outbox → **两条**下行指令：
   新归属 `deliveryRole=apply`、原归属 `deliveryRole=remove`，幂等键各带投递角色与目标员工
   （`…#apply#<员工>` / `…#remove#<员工>`），互不顶替、可分别判重。
   **部分成功语义**：只有**两个目标都被中央受理**才置 `sent`；任一目标 4xx → 整行 `failed`
   （如实记 `failedRole` / `delivered`）；网络类失败**保持 pending**，交由下一轮顺序重试——
   已受理目标由中央幂等去重、未受理目标继续补投，故**无需另建发送状态表**（J9–J11 实证）。
2. **下行 lead 白名单分档**。`shared/centralDownCommand.ts` 原先只有一份 8 字段白名单，中央 HTTP
   实际接受 `contactRaw` / `wechat`，与「中央只允许 6 字段」的文档说法不符；持 `command.issue`
   权限者可直接向 `/sync/commands` 提交这些字段绕过客户端。改为**按传输上下文分档**
   （`leadFieldsFor(transport)`）：`central-http` = 6 字段（`CENTRAL_LEAD_FIELDS`），
   `smb` = Phase 1 历史 8 字段口径（`SMB_LEAD_FIELDS`，**未被收窄**）。两档**共用同一份指令状态机**
   （roles / required / allowed / enums / maxLength），仅在 lead 子对象字段集分叉，避免两套规则漂移；
   lead 子对象补类型/长度/枚举约束（`contactType ∈ {phone,wechat,both}`、`name ≤ 120` 等），
   错误码**只带字段名不带值**。
3. **服务端实体引用闸门**。`/sync/push` 此前只查 `entityId` 是否属本机命名空间，未调
   `validateCentralEntityId()`，于是 `entityType=customer` + `entityId=<本机>/assignment:1` 能污染客户表。
   现逐条补实体引用类别校验，并对 `payload` 内已登记的 `*Ref`（`customerRef` / `leadRef` /
   `opportunityRef` / `employeeRef`）校验形态、类别与命名空间归属（`ref_not_scoped` /
   `ref_not_concrete` / `ref_kind_mismatch` / `ref_not_owned`），**借用同工作区他机命名空间同样拒绝**；
   `employeeRef` 是身份声明（显示名/工号），裸值放行。
4. **中央 append-only 审计补齐**。`invite_create`（与签发**同一事务**，不记邀请码明文/哈希）与
   `down_command`（指令**首次**受理，只记 `eventId` / `eventType` / 投递目标，**不记载荷**）此前
   只有宪法声明、没有实现。`MemoryCentralStore` 与 `PostgresCentralStore` 同步补齐；
   **幂等重放不追加审计、被拒请求不留痕**，审计条数不随重放或探测增长。
5. **管理员吊销的畸形 UUID**。`/devices/:deviceId/revoke` 原先 schema 只限字符串长度，畸形标识会进
   `$1::uuid` 让 PostgreSQL 抛 `22P02` 变成 500，把「调用方拼错 URL」记成「中央服务内部错误」。
   现 schema 用 UUID format + 进 store 前显式复判，畸形返 **400 E101**，
   **不碰数据库、不写审计、不影响任何设备**。

**本刀边界（不夸大）**：中央侧仍是**真实 Fastify 路由 + `MemoryCentralStore`**，**没有真实 PostgreSQL**——
`central/test` 的 P7/P8 只是**源码级契约断言**（锁住「同事务 / 只在首次写入 / SQL 参数化 / 不记载荷」四条纪律），
DDL 约束、并发与事务隔离、`$n::uuid` 的运行时行为**均未验证**。Docker、双机、Windows、SSE、真实消息推送、
反向代理与证书、真实 AI 调用**全部未执行**。**Phase 3a 代码侧仍未收口。**

## 2.107 Phase 3a 中央同步契约修复：移交 SLA 保全 + SMB 接入共享校验 + 建档字段强制（2026-09-15）

三个相互关联的中央同步契约问题（任务口径见当日任务提示）：

1. **transfer 丢失 SLA1（真实缺陷修复）**：`transferAssignment()` 算了新 `sla1` 并写进新 assignment，
   但 outbox payload 不带 `sla1Deadline`/`mode`，`commandPayloadOf('transfer')` 也不透传，
   接收端 `applyDownEventTx` 拿到 `p.sla1Deadline=undefined` → 新行 `sla1_deadline` 落 NULL、
   lead 首触期限回退哨兵。修复：发起端**同事务**把本轮真实 `sla1Deadline`/`mode` 写进 outbox；
   注册表 `transfer` 将两字段列为**必填**（`sla1Deadline` 必须 number 类型有限正整数，
   字符串数字同样拒收）；接收端**精确按指令值落地**（`assignment.sla1_deadline` =
   `lead.first_contact_deadline` = 指令值，`mode` 与发起端一致），**不按接收端配置/时钟重算**；
   `remove` 分支不建行也不动 SLA；重放命中幂等标记零业务写、SLA 不漂移。
2. **SMB 真正接入共享下行校验器**：`validateDownEventFile()` 此前只查 to/eventSeq/deliveryRole/
   文件名，合法信封配 `payload={}` 也能进状态机。现 SMB 专属检查通过后、进入任何业务事务前调用
   `validateDownCommand(subject, 'smb')`：payload 白名单/必填/类型/lead 建档契约全部走共享规则；
   SMB 保留历史 8 字段 lead（含 `contactRaw`/`wechat`），中央 HTTP 仍严格 6 字段不放宽；
   SMB 无中央 UUID 目标字段，「目标存在」由**已验证的本机投递键**（`localDeliveryKey`）证明，
   不伪造业务 UUID、不复制第二套规则；SMB `recycle` 历史信封（带 lead + `slaHours`）仅 `smb` 档放行
   （`smbAllowsLead` / `smbAllowedExtra`）。**行为变更**：缺 lead 资料的 SMB assign 不再走 `nolead`
   重试，而是校验层拒收 + `.failed` 隔离（缺建档资料的事件重试永远不会自愈）。
3. **中央 assign/transfer 建档字段强制**：`validateLeadObject` 此前只强制 `lead.leadId`，
   `lead: { leadId: 1 }` 会让接收端 `createLeadFromInfoTx` 以空 `contact_normalized` 建档并可能撞
   `UNIQUE(contact_type, contact_normalized)`。现两条通道都强制最小身份（`leadId` 正整数 +
   `contactType` 枚举 + `contactNormalized` 非空）；中央 HTTP 按「固定 6 字段」要求**全部存在**
   （`name`/`source`/`note` 允许空串但必须是字符串）；顶层 `leadId` 与 `lead.leadId` 不一致即
   `lead_id_mismatch` 拒收，禁止按其中一个猜。被拒指令不写 sync_event、不留成功审计、
   **不消耗幂等键**（修正后同 key 可受理）、不动本机 lead/assignment。
4. **双目标 4xx 部分成功边界（验证 + 最小补强）**：现有「任一目标 4xx → 整行 failed + 审计」语义
   保持不变（绝不标 `sent`）；审计 detail 增补 `failedTarget`（失败目标的稳定员工标识），
   与既有 `failedRole`/`delivered` 一起支撑人工修复，防止两个销售设备各持有效归属而无人知晓。
   网络/5xx 仍保持 `pending` 靠幂等重试收敛。

**验证（2026-09-15 实测，全部隔离临时目录、无真实网络/DB）**：`npm run typecheck` ✅；
`scripts/central-sync-adapter-test.ts` **90/0**（C 段夹具补齐固定 6 字段；E4–E7 建档契约负例：
只有 leadId / 空 contactNormalized / leadId 不一致 / 缺 sla1Deadline+mode 全部终态 invalid 且零业务写）；
`scripts/central-sync-e2e-test.ts` **69/0**（J 段补强：J1b outbox 携带真实 sla1Deadline/mode、
J3b 指令值与本地新行逐值相等、J11b–J11d 第一目标受理+第二目标 4xx → failed + 审计 + 修复后收敛、
J12b remove 不动 SLA、J14b 接收端两个 deadline 精确等于指令值、J15 重放零漂移）；
`scripts/lan-sync-test.ts` **90/0**（J 段新增：14 类非法 SMB 载荷逐项拒收 + `.failed` 零副作用隔离、
合法 8 字段 assign/transfer 继续通过、transfer 缺 sla1Deadline/mode 拒收、SMB recycle 历史信封放行）；
`scripts/lan-sync-e2e-test.ts` **42/0**（LAN 同步不回归）；
中央侧 `npm --prefix central run typecheck` / `npm test`（app **148** / projection 36 / migration 23 /
context 6，全 0 失败；M11–M23 建档契约与 transfer SLA 正反用例）/ `npm run build` ✅。
`git diff --check` 通过。**边界不变**：中央侧跑在 `MemoryCentralStore` 上，真实 PostgreSQL、Docker、
双机、Windows、SSE、真实消息与 AI 调用**均未验证**；下行仍携带 `contactNormalized`，
**不声称「下行零身份值」**；**Phase 3a 代码侧仍未收口**。
（`scripts/lead-sla-reset-test.ts` 14/4 为基线既红——本刀前后结果一致，与本改动无关，归因归技术债 3。）

## 2.108 Phase 3a 中央同步收口：升级兼容 + 失败重投入口 + 契约收紧 + 门禁脱敏（2026-09-15 第四轮）

第三轮（§2.107）把 `mode` / `sla1Deadline` 列为 transfer 必填后，暴露了五个此前未登记的收口项。

### 1. 升级前 pending 移交的兼容（真实缺陷）

**根因**：`DOWN_COMMAND_SPECS.transfer` 自 §2.107 起把 `mode` / `sla1Deadline` 列为必填，但**升级前**
就已写进 `outbox_event` 的 pending 行携带的是旧格式载荷（无这两字段）。升级后调度器重放这些历史行，
必然被共享校验器判 `missing_field` / `invalid_timestamp`——一次升级把机器上所有未发完的移交**永久卡死**
（每轮都被拒，永不收敛），而拒绝原因只有字段名，人工无从判断该补什么。

**修法**：新增 `electron/services/crmDownPayloadCompat.ts#healLegacyDownPayload(type, payload)`——
**发送时惰性补齐**的唯一实现，两条通道共用：

- **不做全表 UPDATE**（不做破坏性迁移，不给历史行「猜」一个值）；
- `transfer` 的 `mode` 与 `sla1Deadline` 从**本机 assignment 行**（`payload.assignmentId`）读回
  `assignment.mode` / `assignment.sla1_deadline`，即**移交事实产生时就写死的绝对值**；
- **严禁按当前时间、当前 `crmLeadSlaHours` 或接收端配置重新计算 SLA**——重算会随设备时钟与配置漂移，
  那正是 §2.107 修掉的同一个缺陷换个位置复现。恢复值只能是库里已存的绝对值；
- 只处理 `transfer`；已合法载荷**原对象原样返回**（不复制、不改写，避免给正常路径引入差异）。

**不可恢复即显式失败，绝不猜**：`assignmentId` 非法 / assignment 行不存在 / `mode` 不在枚举内 /
`sla1_deadline` 不是正整数时间戳 → 该行 outbox 显式置 `failed` + 脱敏审计（`detail` 只有
`{type, reason}` 两个稳定错误码，**不含客户数据**）。稳定错误码：`legacy_transfer_bad_assignment_id` /
`legacy_transfer_assignment_missing` / `legacy_transfer_mode_unrecoverable` /
`legacy_transfer_sla_unrecoverable`。

**幂等键不变**：补齐只改 payload，**不动 `event_seq` / `idempotency_key` / `assignmentId` /
`oldAssignmentId`**——否则中央会把它当成新事件，重投变成重复移交。

**已落盘的旧 SMB 文件**：走既有隔离语义。旧文件被 `.failed/` 隔离（不在队列目录），
`isolateInvalidDownFile` 已释放该路径，下一轮 `writeEventFile` 会在**同一路径**写入补齐后的合法文件 →
**最多两轮收敛，不是永久死锁**；隔离件由人工按 `.failed/` 归档处置。

### 2. 双目标 4xx 的正式恢复入口（替换测试里的 SQL 翻转）

**根因**：双目标部分成功的恢复路径此前**只有测试能走**——`scripts/central-sync-e2e-test.ts` 的 J11d
直接 `UPDATE outbox_event SET status='pending'` 把失败行掰回去。这是测试在改数据库，**不是产品能力**：
真实用户在设置页没有任何入口能把 `failed` 行重新送出去，只能等人工改库。

**修法**：把「失败重投」做成正式、受限的服务层能力，并删掉测试里的 SQL 翻转。

- **服务层**：`centralSyncService.retryFailedOutbox(rowId)`——事务内 `SELECT status` 判定 → 只允许
  `status='failed'` 的行 → 按 `routeOutboxRow` 判定类型已注册 → 原子
  `UPDATE ... SET status='pending' WHERE id=? AND status='failed'`（**条件更新，重复点击第二次匹配 0 行，
  天然幂等**）→ 追加 `audit_event(action='sync_outbox_retry')`。**不改 payload、不改 `event_seq`、
  不改 `idempotency_key`**。稳定返回码：`ok` / `invalid_row_id` / `not_found` / `not_failed` /
  `unsupported_type`；**不接受任何 SQL 或任意状态迁移**。
- **只读列表**：`listFailedOutbox(limit=50)` 返回**裁剪字段**（行号 / 类型 / 稳定原因码 / 时间一类定位
  信息），**不回传 payload 原文**；失败原因经 `SAFE_FAILURE_CODE`（`/^[A-Za-z0-9_:.\-]{1,80}$/`）过滤，
  形态不符一律降级为通用码，防止把客户数据当「原因」回显。
- **IPC 与 UI**：新增 `centralsync:failed`（只读）与 `centralsync:retryFailed`；preload 与
  `src/types/electron.d.ts` 同步；设置页同步状态区新增「失败同步项」列表与逐项**重试**按钮，
  状态栏补 `backlogFailed` 计数。重试只翻状态，真正的投递交给既有 `runCentralSyncOnce()`。
- **审计脱敏**：`sync_outbox_retry` 只记 actor / 行号 / 类型，**不记客户联系方式、聊天正文、
  完整线索资料与令牌**。
- **双目标部分成功的语义不变**：已受理的 apply 目标重投时由中央判 duplicate（`eventId` 只由
  `deviceId + idempotency_key` 决定，重投后身份不变），原先 4xx 的 remove 目标重新投递，
  **两个目标都被受理才结算 `sent`**——与网络类失败靠重放收敛是同一条路径。

**测试不再碰数据库**：J11d 改为调用 `service.retryFailedOutbox(...)`。另补 J11d0 / J11e–J11j 边界：
非法 rowId、不存在的行、`pending` / `sent` 行（`not_failed`）、重复点按幂等、审计只增一条。

### 3. `mode` 收紧为枚举（不再「非空即通过」）

**根因**：`validateDownCommand` 此前对 `mode` 只做「必填非空」判断，没有形状与取值约束——
`mode: {a:1}` / `mode: []` / `mode: 1` / `mode: true` **全部通过**，落进业务状态机后被 `String()`
拍成 `[object Object]` 这类值写进 `assignment.mode`。

**修法**：`shared/centralDownCommand.ts` 新增**唯一枚举源**
`ASSIGNMENT_MODES = ['manual','weight','round_robin','load']`（口径 = 本机真实写入语义），
`assign` 与 `transfer` 的 spec 都挂 `enums: { mode: ASSIGNMENT_MODES }`；枚举循环**出现即必须是字符串
字面量**，**不允许先 `String(value)` 再比对**——对象 / 数组 / 数字 / 布尔 / 空串 / 未知字符串一律
`invalid_enum:mode`。`transfer` 保持 `mode` 必填（缺 → `missing_field:mode`），`assign` 上 `mode` 可选
（缺省合法，**发送方应省略而不是发空串**）。错误码只带字段名，**不带字段值**。
`electron/services/crmAssignmentService.ts` 的批量模式改由该枚举派生
（`BatchAssignmentMode = Exclude<AssignmentMode,'manual'>`），不再另写一份字面量数组。
中央 HTTP 发送前自检、SMB 消费入口、中央服务端建指令**三处共用同一份约束**。

### 4. `entityId` 必须是具体引用

**根因**：`validateCentralEntityId()` 此前只调 `refKindOf()`，只要「有类别」就放行——
`device/customer:`（只有类别、没有行号）能过闸，中央无法跨表关联到任何一行；
`device/customer:   `（空白行号）同理。

**修法**：复用 `shared/centralSync.ts#isConcreteRef()`（**不新造第三个解析器**），并同时把该函数本身
收紧为「冒号后必须是**非空白**内容」。现在 `validateCentralEntityId` 分三步：① 必须含设备命名空间且
`localRef` 有 `kind:`（裸 `customer:1` → `entity_id_not_scoped`）；② 冒号后必须有非空白行号
（`entity_id_not_concrete`）；③ kind 必须与 `entityType` 相符
（`entity_id_kind_mismatch:<kind>≠<expected>`）。既有合法 scoped 引用不受影响；`/sync/push` 仍
**逐事件**处理，一条坏事件不会污染同批合法事件。正反用例补在 `scripts/central-sync-adapter-test.ts`
（J7–J11）与 `central/test/app-test.ts`（K7–K10）。

### 5. p0-3 收口门禁的输出脱敏

**根因**：`scripts/p0-3-closed-gate.ts` 会读**真实客户库**，却把 `session_id`、判断正文（`value` 与
`summary`）、`message_key` 逐行打印到终端，还会打印真实库的绝对路径——等于把客户私有内容与机器目录
结构写进任何一份终端留存（日志、截图、CI 记录）。

**修法**：脚本仍是**只读**（sql.js 字节进内存，不写回），输出只保留**聚合计数、通过/失败与结构性
结论**：总览计数、四类型分布、`stale` 计数、`message_key` 可解析计数、孤儿计数、四类全齐**客户数**。
不再打印 `session_id` / 客户姓名 / 联系方式 / 判断正文与摘要 / `evidence_text` / `messageKey` 原文 /
库绝对路径；库文件不存在时只报「不存在」，该行**不插路径**。逐行「判断样例」转储整段删除。

**守卫**：新增 `scripts/p0-3-closed-gate-test.ts`（**20/0**）——① 静态守卫 S1–S7 在**剥离注释后**的 gate
源码上禁止「取出来起别名再打印」与「把库路径塞进 console」的回归写法；② 输出捕获守卫 O0–O12 用
**合成库**（哨兵值全是编造字符串，与任何真实客户无关，建在 `/tmp` 一次性目录、跑完即删）起子进程真跑
gate，断言七类哨兵与合成库绝对路径**一个都不出现**，同时断言**聚合计数仍在**（脱敏不等于把验收输出
砍空，否则 gate 失去验收价值）。

**验证（2026-09-15 实测，全部隔离临时目录、无真实网络/DB）**：`npm run typecheck` ✅（electron 棘轮 0）；
`scripts/central-sync-client-test.ts` **24/0**；`scripts/central-sync-adapter-test.ts` **97/0**；
`scripts/central-sync-e2e-test.ts` **84/0**；新增 `scripts/central-down-compat-test.ts` **31/0**
（升级兼容全链：A0–A10 补齐语义含「把当前 `crmLeadSlaHours` 改成 999 后恢复值一字不变」、
A11–A15 不可恢复稳定码、B1–B3 两条通道静态共用同一 helper、C1–C4 SMB 落地且幂等键与文件名不变、
D1–D5 隔离件同路径重写后两轮收敛、E1–E2 `failed` + 脱敏审计键集恰为 `{reason,type}`、F1）；
`scripts/lan-sync-test.ts` **93/0**；`scripts/lan-sync-e2e-test.ts` **42/0**；新增
`scripts/p0-3-closed-gate-test.ts` **20/0**；`scripts/p0-3-closed-gate.ts` **6/0**（153 文件）；
`assignment-test` 28/0、`assignment-batch-count-test` 7/0、`assignment-full-test` 91/0、
`lead-assignment-view-test` 64/0、`crm-sla-action-test` 11/0、`sla1-supervisor-notify-test` 23/0、
`lead-sla-unassigned-test` 21/0、`aftersales-transfer-outbox-test` 60/0；中央侧
`npm --prefix central run typecheck` / `npm test`（app **159** / projection 36 / migration 23 / context 6，
全 0 失败；K7–K10 引用具体性、M24–M27c `mode` 枚举正反用例）/ `npm run build` ✅；`git diff --check` 通过。
**边界不变**：中央侧仍跑在 `MemoryCentralStore` 上，真实 PostgreSQL / Docker / 双机 / Windows / SSE /
真实消息推送与 AI 调用**均未验证**；下行仍携带 `contactNormalized`，**不声称「下行零身份值」**；
**Phase 3a 代码侧仍未收口**。
（`scripts/lead-sla-reset-test.ts` 14/4 为基线既红——本刀前后结果一致，与本改动无关。）

## 2.110 下行指令顶层字段的严格运行时契约（2026-09-15 第六轮）

**根因**：`validateDownCommand()` 的顶层必填只做 `isBlank()` 判定，**形态完全不判**。于是
`assignmentId: 0`、`assignmentId: {}`、`leadId: "41"`、`remindCount: {}` 全部被判为合法并返回 `null`。
中央 `/sync/commands` 依赖该共享校验器，校验通过即保存指令；本机接收状态机随后对部分值 `Number()`
转换、或根本不使用远端 `assignmentId` —— 畸形指令在业务写入前**不被终止**，产生真实的分配 / 移交 /
回收 / 通知。同一条缺陷也在 `crmDownPayloadCompat.healLegacyDownPayload()`：transfer 的 mode/SLA
已合法时，非正整数或指向不存在行的 `assignmentId` 会被放行。

**修法**：`DOWN_COMMAND_SPECS` 新增 `fields?: Record<string, DownFieldRule>`，与 eventType 同处一个
注册表，**HTTP 与 SMB 共用同一份规则，不新增第二套校验器、不引入新依赖**。
`DownFieldKind = 'positive_int' | 'non_negative_int' | 'string'`。

- **`kind` 自带自然下界**：`checkNumberField` 此前只在显式登记 `min` 时才判下界，而
  `leadId` / `assignmentId` / `oldAssignmentId` 都没登记 `min` —— 于是 `0` 与负数仍然通过。
  现在 `positive_int` ≥ 1、`non_negative_int` ≥ 0 由 kind 承担，显式 `min` / `max` **只用于收窄**
  （`remindCount` → 3、`slaHours` → 72）。`Number.isInteger` 同时覆盖小数 / `NaN` / `Infinity`。
- **值域的业务依据（读生产者与消费者得到，非猜测）**：`remindCount` **0–3** ——
  `assignment.sla1_remind_count` 的语义是「已提醒次数」（0 = 从未提醒），三次提醒制下生产者
  `crmAssignmentService` 恒发 `3`、接收端 `crmNotifyService` 按 `N/3` 渲染；越界会让主管看到假次数。
  `slaHours` **1–72** —— 口径 = `crmLeadSlaHours` 可接受区间（`crmAssignmentService.sla1Hours()` 与
  `lanSyncService.slaHoursNow()` 同口径，缺省 24）。
- **顶层 `leadId` 与 `lead.leadId` 按原始值直接比较**（原先 `Number(a) !== Number(b)`）：
  `Number("41") === Number(41)` 会让 `leadId: "41"` + `lead.leadId: 41` 这种「上层字符串、下层数字」
  的自相矛盾载荷通过。跨类型现已先被 `invalid_type:leadId` 拦下，不会走到一致性判定。
- **注册表自相矛盾即拒收**：`required` 里的顶层标量字段若既无 `fields` 规则、又不归 `lead` 子对象
  （`validateLeadObject`）或 `spec.enums` 的专门校验器管，返回 `unregistered_field_rule:<字段>` ——
  不给「只判非空就放行」留后门。
- **`requiredTimestamps` 与 `fields` 并存**（未合并）：`invalid_timestamp:` 系列码被既有测试断言，
  合并会制造码漂移；反之 `recycledAt: 0` / 字符串 `sla1Deadline` 现在会先命中 `fields` 的
  `invalid_integer:` / `invalid_type:`。**两者都是稳定拒绝码、HTTP 状态码同样 400**，断言接受任一。
  这是刻意的：字段规则先于版本前置生效，语义是「先判形态，再判版本前置的取值」。

**历史移交（`healLegacyDownPayload`）**：`assignmentId` 形态非法 → 无条件拒；**assignment 行不存在 →
无条件拒**（`legacy_transfer_assignment_missing`）。依据：本机 assignment 只软删 / 只改 status
（宪法 §1.3，append-only；全仓无硬删路径，`DELETE FROM assignment` 只在测试夹具），
因此一条正常产生的 outbox 行**永远能定位到自己的来源行**；定位不到只可能是库被外部改动。
「载荷自足」不构成放行理由 —— 契约要求 transfer 的每个身份字段都可核对（`leadId` 对线索、
`toSales` 对目录），`assignmentId` 对来源行是同一组核对里的一项，缺一项就不能声称这条指令描述的
移交事实在本机成立。身份核对（`lead_id` / `sales_name`）**总是执行**，含「不需要补齐」的载荷。

**新增测试**：`scripts/central-down-fields-test.ts`（41 项，四层）。A 层共享校验器逐字段负例；
B 层真实 Fastify `/sync/commands`（**签发者必须是有 `command.issue` 的主管**，销售设备只作投递目标
——用销售身份签发会在 preHandler 403，测到的是权限而不是字段契约）；C 层真实 `consumeDownEvents`
→ `.failed/` 隔离（**SMB 根目录与业务库根必须分开**，否则 `up/` 与 `down/` 扫描互相干扰）；
D 层历史 transfer 富化（**合法载荷的来源行 = 新行**，即 `sales_name === toSales`，与
`crmAssignmentService.transferAssignment()` 的写法一致）。每个负例都要求零副作用：不写
lead / assignment / audit_event / notify_inbox，不写成功幂等标记，不生成可被中枢接受的成功 ACK。

## 2.109 Phase 3a 中央同步收口：富化一致性 + 字符串 SLA 拒收 + 本机 mode 契约 + 重投结果口径 + 守卫补真（2026-09-15 第五轮）

第四轮（§2.108）收口后第 5 项仍未闭合：**历史移交富化只按 `assignmentId` 取行，不核对线索与目标销售**，
且把「字符串数字的 SLA」当成了已合法值；**本机分配端**（`assignLeads`）对 `mode` 只做 `String()` 兜底，
与同步接收端的四值契约不是同一条；**重投回包**用整轮 `pushed` / `rejected` 反推单行结果；
**p0-3 脱敏守卫的 `S_CONTACT` 从未写进合成库**（O7 是恒真空断言）；**适配器测试仍在直接
`UPDATE outbox_event SET status`**。五项本轮一并收口。

### 1. 历史移交富化必须先核对一致性（真实缺陷）

**根因**：`healLegacyDownPayload` 此前只用 `payload.assignmentId` 查一行，取回 `mode` / `sla1_deadline`
就补齐。但 `assignmentId` 只要是个存在的行号就通过——**跨线索串档**：A 线索的 assignment 行会把
A 的 `mode` 与 SLA 富化到 B 线索的 transfer 指令上，接收端据此建出的移交事实（谁、何时到期）是错的，
而且**看起来一切正常**。

**修法**：读到 assignment 行后**先核对四项再补齐**——`payload.leadId` 为正整数、
`assignment.lead_id === payload.leadId`、`payload.toSales` 为非空字符串、
`assignment.sales_name === payload.toSales`；任一不符即拒收，稳定码 `legacy_transfer_lead_mismatch` /
`legacy_transfer_target_mismatch`。

- **核对总是执行**：只要 assignment 行读到了就核对，**包括「两个字段都已合法、本不需要补齐」的载荷**
  ——已合法的载荷同样可能是串档来的，不能因为「不需要补齐」就跳过。
- **`assignmentId` 形态非法 → 无条件拒**（`legacy_transfer_bad_assignment_id`），与 `mode` / SLA 是否
  已完整无关；**assignment 行不存在 → 同样无条件拒**（`legacy_transfer_assignment_missing`），
  不因「载荷自足」而放行。**「读不到行则按是否需要补齐决定放行」的口径已作废**（见 §2.110）。
- **错误码只带稳定码**：不含客户值、销售姓名、联系方式；审计 `detail` 仍只有 `{type, reason}`。

### 2. 字符串 SLA 不是合法绝对时间戳

**根因**：`sla1Deadline` 的合法性判定此前没有限定**原始类型**，`"1735689600000"` 这种字符串数字会被
当成已合法而**原样透传**。而两条通道对它口径不同：中央 HTTP 侧 `commandPayloadOf` 会做 `Number()`、
SMB 侧 `requiredTimestamps` 会拒字符串 —— 同一个载荷在两条通道上一个通过一个被拒，**口径漂移**。

**修法**：`isAbsoluteDeadline` 要求**原始类型为 `number`** 且为**有限正整数**；字符串数字、
小数、`NaN`、`Infinity`、`0`、负数、对象、数组、布尔、空串一律按「**未合法**」处理，
走「从 assignment 行读回 `number` 覆盖」这条唯一出口 —— **绝不存在把字符串时间戳透传出去的分支**。
恢复值仍然只能是库里已存的绝对值，**不按当前时间 / 当前 `crmLeadSlaHours` / 接收端配置重算**（§2.108 纪律不变）。

### 3. 本机生产端与同步接收端共用同一条四值 `mode` 契约

**根因**：`assignLeads()` 的 `const m = String(mode || 'manual')` 把一切类型都兜成字符串——
`assignLeads(..., 'teleport')` 会**成功返回**并把 `assignment.mode = 'teleport'` 写进本机库。
这条行本机「成功」，随 outbox 上行时被中央的 `ASSIGNMENT_MODES` 拒收 → **本机成功 / 中央失败的脏数据**。
`assignBatchLeads()` 则对非法 `mode` **静默回退 `weight`**，用户显式传错却被当成没传。

**修法**：**唯一枚举源仍是 `shared/centralDownCommand.ts#ASSIGNMENT_MODES`，不自建第二套枚举。**

- `assignLeads`：缺省 `manual`；`mode` 出现时必须是 `manual` / `weight` / `round_robin` / `load` 之一，
  **非法值在开事务前返回 `{ok:false, code:'E101'}`**，零 `assignment` / `ownership_history` /
  `audit_event` / `outbox_event` 写入 —— **不存在「本机写成功、中央才拒」的窗口**。
- `assignBatchLeads`：只接受 `weight` / `round_robin` / `load`；**显式非法值返回 `E101`，不再静默回退
  `weight`**；缺省回退**仅在 `undefined` / `null`** 时生效（前端既有合法调用不受影响）。
- **IPC 不再收窄类型**：`crm:assignment:assign` / `assignBatch` 原值以 `unknown` 交给服务层做运行时校验，
  **不得先 `String()` 再传**（`{}` 会被拍成 `[object Object]` 从而「看起来合法」）。
- 前端类型（preload + `src/types/electron.d.ts`）改用同一份 `AssignmentMode`，合法调用保持兼容。

### 4. 重投结果按「该行自己的最终状态」判定（「重新排队」≠「同步成功」）

**根因**：`centralsync:retryFailed` 此前一律回 `success: true`；设置页只看整轮的 `pushed` / `rejected`，
**完全忽略 `result.error`**。于是**网络故障**时会出现绿色「已重投」，而那一行其实还躺在 `pending` 里。
「重新排队成功」被当成了「同步成功」。

**修法**：判定依据只能是**该 `rowId` 自己的最终状态**（整轮计数是**所有行**的合计——别的行成功会把它
顶上去，网络故障时全都没发出去也证明不了这一行没成功）。

- 新增纯函数 `outboxDeliveryStatusOf(rowId)`（**只读**回读单行状态，非法行号返回 `unknown`）与
  `retryOutcomeOf(deliveryStatus, syncConfigured)`（`unconfigured` 优先于行状态）。
- 新增 `safeSyncError(error)`：走**既有脱敏**（`maskAuditText` 手机号打码 + 令牌隐藏）后截断 300 字；
  IPC **不再回传未脱敏的 `result.error`**。
- 设置页四种语义：`sent` → 绿色「已完成同步」；`unconfigured` → 警告「已重新排队，但中央同步未配置」
  （**绝不显示为成功**）；`failed` → 红色「重投后仍被拒绝，请查看审计」；`pending` → 警告
  「已重新排队，等待网络/下一轮同步」。失败清单与同步状态的既有刷新（`finally`）保持不动。
- **不变式**：重投仍**不改 payload / `event_seq` / `idempotency_key`**，只做状态机迁移。

### 5. p0-3 脱敏守卫的哨兵必须真的落库

**根因**：`S_CONTACT` 只被定义、**从未写进合成库**，所以 O7「输出不含联系方式哨兵」是**恒真的空断言**
——它证明不了任何事，因为库里本来就没有那个值。而 `customer_profile.contact_normalized` 这个字段
在真实 schema 里**并不存在**（联系方式列在 crmDb 的 `lead.contact_normalized`）。

**修法**：合成 `customer_profile` 改按 `salesDbService` 的**真实生产 DDL** 建表（不再自造窄表），
联系方式哨兵写进**两个真实承载列**：`notes`（备注里粘手机号）与第二行客户的 `display_name`
（微信备注常常直接就是手机号）；跑 gate 之前先**只读回查**（P1–P3）断言哨兵确实在库里，
否则立即失败。这样 O7 才是在「值真实存在」的前提下证明「输出里没有它」。

### 6. 适配器测试不再直接改 outbox 状态

**根因**：宪法 §1.11 明令「测试与任何调用方都不得直接 `UPDATE outbox_event SET status=...`」，
但 `scripts/central-sync-adapter-test.ts` 仍有**两处**裸 `UPDATE outbox_event SET status='pending'`
把已结算的行掰回去——那会绕过权限、审计与状态机。

**修法**：两处全删，**没有放宽任何行为断言**：

- **B9**（同一事实重放不产生第二条指令）改为**新建一条 pending 投递行**承载同一 `eventId`/幂等键
  （投影路由的 `eventId` 只由 `deviceId + entityType/localRef + aggregateVersion` 决定，**与哪条 outbox 行投递无关**），
  断言两次 `claimEvent()` 得到**同一把 key**；**B9b** 再断言那条重放行是由状态机自己结算为 `sent` 的。
- **B10** 改为新建一条合法 pending fixture，让**真实服务路径**把它驱动到 `failed`。
- 仓库内**已无任何测试直接改 outbox 状态**；剩余的 `UPDATE outbox_event` 只出现在
  `centralSyncService.ts`（2 处）与 `lanSyncService.ts`（7 处）的**生产状态机**里（条件更新，
  `WHERE id=? AND status=...`），**未删任何一条合法迁移**。

### 7. 本轮验证（仅计数）

根 `npm run typecheck` 通过（electron 棘轮基线 0）；`central-down-compat-test` **44/0**、
`central-sync-adapter-test` **98/0**、`central-sync-e2e-test` **88/0**、新增 `central-retry-outcome-test` **20/0**、
`lan-sync-test` **93/0**、`lan-sync-e2e-test` **42/0**、`p0-3-closed-gate-test` **23/0**、
`assignment-test` **28/0**、`assignment-batch-count-test` **7/0**、`assignment-full-test` **100/0**、
`lead-assignment-view-test` **64/0**、`aftersales-transfer-outbox-test` **60/0**；
`p0-3-closed-gate` **6/0**（真实库运行态，本机只报告计数）；中央侧 `npm --prefix central run typecheck` /
`npm test`（app 159 / projection 36 / migration 23 / context 6，全 0 失败）/ `npm run build` 通过；
`git diff --check` 通过。

### 8. 边界与残留（不得描述为通过）

- **Phase 3a 部署、真实 PostgreSQL、双机同步、Windows、SSE、真实消息推送、真实 AI 调用、
  签名与公证：全部仍未验证。** 中央侧所有测试仍跑在 `MemoryCentralStore` 与 `app.inject` 上，
  本机侧全部跑在隔离临时目录上。
- **下行仍携带 `contactNormalized`**（中央 HTTP 固定 6 字段，`contactRaw`/`wechat` 一律 400），
  **不声称「下行零身份值」**；冲突裁决仍未细化。
- **升级兼容只覆盖 `transfer`**；历史行若其 `assignmentId` 指向的行已被清理且确实需要补齐，
  则永久置 `failed` 等人工处置（刻意的：**宁可显式失败，也不猜一个 SLA**）。
- **`scripts/lead-sla-reset-test.ts` 14/4 为基线既红**，与本轮改动无关，归技术债。
- **`scripts/assignment-correction-test.ts` 与 `scripts/lead-assignment-restore-test.ts` 本轮未运行**
  （会复制真实生产库，不得作为中央同步的回归证明）。
- **本轮结论仍只指代码**：**Phase 3a 代码侧仍未收口**，也不得写成「整个项目已完成」。

## 3. 已交付功能清单

| # | 功能 | 入口 | 关键文件 | 状态 |
|---|------|------|----------|------|
| 1 | **今日行动清单** | 首页 `/` `/home` | `salesActionEngine.ts` + `TodayActionPage.tsx` | ✅ |
| 2 | ~~自动阶段分类~~ **已移除**（2026-09-12 复核） | — | `salesStageClassifier.ts`（现为纯本地：阶段写库 + 证据提取，**无 AI 调用**） | ❌ |
| 3 | **触发规则引擎** | 每 60 秒 tick（当天首次 `runFullScan` 全量，其后 `lazyScan` 增量），**纯本地零 AI** | `salesActionEngine.ts`（6条规则） | ✅ |
| 4 | **周复盘** | 每周日20:00自动 | `salesReportService.generateWeeklyReview()` | ✅ |
| 5 | **知识库 CRUD + CSV导入** | 侧边栏「知识库」 | `salesKnowledgeService.ts` + `KnowledgeBasePage.tsx` | ✅ |
| 6 | **AI 话术建议（引用知识库）** | 行动卡片 + 聊天页 | `salesReplyService.ts` + `SalesContextStrip.tsx` | ✅ |
| 7 | **聊天页上下文条** | 聊天页顶部（非群聊） | `SalesContextStrip.tsx` | ✅ |
| 8 | **客户列表 + 导出Excel** | 侧边栏「客户」 | `CustomerListPage.tsx` | ✅ |
| 9 | **客户画像卡片** | 聊天详情面板 | `CustomerCard.tsx` | ✅ |
| 10 | **AI 意向分析** | 画像卡片 + 自动扫描 | `salesIntentService.ts` | ✅ |
| 11 | **跟进待办** | 今日行动右侧「待办清单」（已收敛） | `salesFollowUpService.ts` + `TodoSidebar.tsx`（散任务视图，§2.19 职责分工；老 FollowUpPage 已归档 `1aefef4`） | ✅ |
| 12 | ~~销售仪表盘~~ **已移除**（2026-09-13 `d2303b0` 代码收口） | —（`/dashboard` 路由一并移除） | `SalesDashboardPage.tsx`（已删除） | ❌ |
| 13 | **销售复盘（周报/月报/周复盘）** | 侧边栏「复盘」 | `SalesReportPage.tsx` + `salesReportService.ts`（周复盘=热/冷/放弃经营分析，`9a9fbaf` 打通；排除同事/朋友等非销售联系人，`ed510df`） | ✅ |
| 14 | **Windows 适配** | 打包配置 | koffi asarUnpack + dbPathService 多路径检测 | ✅ |
| 15 | **v3 客户级去重** | 全量扫描 `runFullScan()` | 同客户多规则命中仅保留最高分一条 | ✅ |
| 16 | **v3 R6 独立清理** | 首页折叠区 | R6 不入主队列 15 条，独立"待清理"视图 | ✅ |
| 17 | **v3 懒扫描** | `lazyScan()` 首页打开触发 | R1/R2/R4/R5 补扫，缩短最坏发现延迟 | ✅ |
| 18 | **v3 AI 深度分析** | `generateActionAnalysis()` | WCDB 上下文 + 结构化 5 字段 + 降级 + 缓存 | ✅ |
| 19 | **话术提炼（单选）** | 知识库页「提炼话术」按钮 | 选联系人→AI提取→预览编辑→导入 | ✅ |
| 20 | **一键提炼（批量）** | 知识库页「一键提炼」按钮 | 扫描候选→确认→排队提炼→统一预览导入 | ✅ |
| 21 | **话术提炼 v2 — AI销售教练** | 同上 | 分析诊断+原话保留+优化版+普通/专业/逼单三版本 | ✅ |
| 22 | **提炼日期区间筛选** | 提炼弹窗日期输入 | 按时间段筛选历史聊天记录提炼话术 | ✅ |
| 23 | **知识库产品数据导入** | CSV批量导入 | 353条叉车产品参数（淘宝竞品/外调车型/整车价格） | ✅ |
| 24 | **AI 见解→CRM 自动导入** | AI 见解生成后自动 | `insightService` + `crmImportService`（中文阶段标签→CRM 阶段） | ✅ |
| 25 | **私域成交检测** | 私聊扫描自动 | `crmParseRules.isDealSignal` + `createDealContract` | ✅ |
| 26 | **客户档案一屏 + 深度分析** | CRM 客户 tab | `crm:customer:profile` + `crmDeepAnalysisService` 七板块报告 | ✅ |
| 27 | **AI 报价辅助** | CRM 客户档案「AI 报价」 | `crmQuoteService.aiGenerateQuotation`（需求→选型→报价草稿） | ✅ |
| 28 | ~~**销售漏斗**~~ **已并入商机「阶段分析」视图**（2026-09-13，§2.101） | 商机页 `/opportunities?view=analysis`（旧链接 `/sales-funnel` 重定向至此） | `shared/opportunitySignals.ts` + `electron/services/opportunityAnalysisService.ts` + `OpportunityStageAnalysis.tsx` | ✅ |
| 29 | **CRM 级联删除（自动备份）** | 工作台/跟单中心每行删除 | `deleteContract`/`deleteAccount` + `crm-backups/` 备份 | ✅ |
| 30 | **行动卡自带 AI 分析** | 今日行动 high/urgent 卡 | `follow_up_task.analysis` 预热渲染（A1） | ✅ |
| 31 | **今日行动分页** | 今日行动信号卡片流底部 | `TodayActionPage.tsx`（`.signal-pagination`，10 条/页） | ✅ |
| 32 | **客户信息 AI 自动填充** | 导入后自动 / 档案「AI 补全」/ 批量回填 | `crmEnrichService.ts` + `crmEnrichCore.ts` | ✅ |
| 33 | **信息待确认队列** | 工作台客户 tab 顶部（`57c4e0f` 自跟单中心迁入） | `crmDbService.infoPendingQueue` + CrmWorkbenchPage | ✅ |
| 34 | **客户 360 单屏视图** | CRM 客户 tab | `CrmWorkbenchPage.tsx`（字段卡+时间线+手改锁定+深链） | ✅ |
| 35 | **CRM 可视化** | 工作台顶部 | `statsOverview` + ECharts 三图；原「漏斗页下钻」随 §2.101 并入商机「阶段分析」视图 | ✅ |
| 36 | **报价跟进 R7（事实驱动）** | 今日行动（私聊扫描自动） | `parseQuoteSignal` + `quote_signal` 表 + R7 规则 | ✅ |
| 37 | **销售数据备份** | 备份页勾选项 | `backupService.collectSalesData` | ✅ |
| 38 | **AI 准确率面板** | CRM 工作台 | `aiAccuracyStats` + 折叠面板 | ✅ |
| 39 | **产品库图片编辑** | CRM 产品库操作列 | 换图/删图（saveImage+image_path）+ 复制摘要嵌套展开 | ✅ |
| 40 | **商机模块（AI 采购信号）** | `/opportunities` 侧边栏「商机」 | `parseBuySignal` + opportunity 闭环 + ECharts 漏斗 + 阶段联动 | ✅ |
| 41 | **意向评分 0-100** | 商机列表/详情 | `intentScore.ts` 纯核心 + 跨库装配 + factors 评分依据展开 | ✅ |
| 42 | **风险预警（竞品/价格/服务）** | 商机详情 | `parseRiskSignal` + crm_risk 表 + 确认处理 | ✅ |
| 43 | **侧边栏导航收口 7 模块** | 左侧导航 | `Sidebar.tsx`（NAV_GROUPS 数据驱动 + 可展开分组，`09d5600`） | ✅ |
| 44 | **Customer 360 统一时间线** | 工作台客户档案「动态时间线」 | `crmDbService.accountTimeline` 8 分支聚合 + 前端四色混排，`6c439bf` | ✅ |
| 45 | **SLA/Action 接通** | 今日行动右侧「待办清单」（SLA 首触卡自动出现，`c90e6c9` 起只右侧展示） | `scanLeadSla` 挂入 runFullScan + getUnifiedSignals 扫描周期；散任务视图 + 完成闭环 `crm:lead:slaComplete`，`5ba531b`+`678e3f0`+`c90e6c9` | ✅ |
| 46 | **AI 回写 model/sourceId 溯源** | enrich_meta 每条记录（PRD§23 可追溯） | `mergeEnrichFields` 透传 + `enrichCustomer` 打 `{model,sourceId}` 标签 + `gatherMaterials` 记最近消息 messageKey，`223c158` | ✅ |
| 47 | **今日行动/待办职责分工** | 今日行动主卡流 + 右侧散任务清单 | `getUnifiedSignals` 唯一动作入口；`TodoSidebar` 只留散任务（无 session 手动/SLA/物流）；FollowUpPage 归档，`1aefef4`+`d5b9f62` | ✅ |
| 48 | **客户名称统一 + 同名防护 + logi 闭环** | 工作台/周报客户名 + AI enrich + 物流侧栏卡 | 读取侧 `profile.display_name` 优先（工作台/周报）；`enrichCustomer` 同名不跨会话；`completeTodo` logi: 走签收闭环，`068a403` | ✅ |
| 49 | **AI 客户工作台（Customer Action Workspace）** | 侧边栏「客户」/customers + 「合同」/crm | 两客户入口合并：`CustomerWorkspacePage`（行动区值得跟进/AI 新发现/全部客户卡片流 + 360 档案）；`CrmWorkbenchPage` 瘦身为合同页；CustomerListPage 归档；深链迁移 `/customers?`；复用 `getUnifiedSignals` 闭环，本期（见 §2.21） | ✅ |
| 50 | **物流认领到客户（无合同可认领）** | 跟单中心物流区 + 客户 360 时间线 | `logistics` 增加 `account_id`、合同可选；手动/自动匹配/扫描均可认领无合同客户；`crm:logistics:link` 签名升级 `(id, {accountId?, contractId?, ownerSales?})`；确认中心引擎铁律保持需合同（见 §2.22） | ✅ |
| 51 | **客户名真相源修复（微信号名回填真实备注）** | 客户工作台客户名 + AI 见解显示名 | `shared/wechatId.ts` 判别三类微信号形态；`resolveInsightSessionDisplayName` 微信号格式优先查 WCDB 备注；`crm:customers` 惰性回填 13 个 account（双轨写 account.name + profile.display_name，见 §2.25） | ✅ |

---

## 4. 架构数据流

```
微信本地库 (WCDB, 只读)
    │
    ├─ DB Monitor (新消息检测)
    │       │
    │       └─► messagePushService（消息推送）+ 渲染进程 wcdb-change 广播
    │           ⚠️ 新消息**不再**触发任何 AI 调用、阶段判定或增量规则检查（PRD §5.4 / R）
    │
    │   （阶段语义层 shared/salesStage.ts：normalizeStage 中英→canonical 幂等，
    │     funnelBucket/stageToFunnel 归桶；DB 存原值，UI/统计统一归桶。
    │     salesStageClassifier 现为**纯本地**：persistClassification 写库 + extractEvidence 取证据，无 AI 调用）
    │
    ├─ 每 60 秒本地规则扫描（startActionEngineScheduler）
    │       │
    │       ▼
    │   salesActionEngine.runFullScan()（当天首次）/ lazyScan()（其后） ──► 6条规则 ──► 今日行动（≤15条）
    │       （纯本地计算，零 AI 调用）
    │
    ├─ 每周日 20:00
    │       │
    │       ▼
    │   salesReportService.generateWeeklyReview() ──AI──► report_snapshot
    │
    └─ 用户打开首页
            │
            ▼
        TodayActionPage ──► 行动卡片（谁/为什么/说什么/打勾）
            │
            ├─ "AI话术" 按钮 ──► generateSuggestion() ──► 引用知识库 ──AI──► 话术
            └─ 早间简报（每天首次打开自动 1 轮；同日可手动「重新生成」）──AI──► report_snapshot
                （AI 只做三件事：早间简报 / 「AI 识别这个客户」按钮 / 客户画像按钮，见 §2.98）

销售自有数据 (weflow-sales.db, sql.js/WASM, 读写)
    ├─ knowledge_base    知识库
    ├─ customer_profile  客户画像
    ├─ intent_tag_log    意向日志
    ├─ follow_up_task    跟进待办
    └─ report_snapshot   报表/复盘
```

---

## 5. 数据模型（5张表）

### knowledge_base（知识库）
| 列 | 类型 | 说明 |
|----|------|------|
| id | INTEGER PK | 自增 |
| category | TEXT NOT NULL | product/script/faq |
| product_line | TEXT | 产品线（电动叉车/内燃叉车等） |
| title | TEXT NOT NULL | 标题 |
| content | TEXT NOT NULL | 内容 |
| tags | TEXT | JSON数组 |
| scene | TEXT | 适用场景 |
| status | TEXT NOT NULL DEFAULT 'staging' | 刀 1 治理列：staging/published/rejected（宪法 §3 登记行；一切新增先落 staging，AI 永不发布） |
| authority | TEXT NOT NULL DEFAULT 'community' | 刀 1 治理列：official（主管审定）/community（默认） |
| version | INTEGER NOT NULL DEFAULT 1 | 引用展示版号（vN），本批无自增规则 |
| ttl_date | TEXT | 到期日（可空），Phase 3b 前不做自动过期处置 |
| reviewed_by | TEXT | 审核署名（actor=身份档案姓名） |
| reviewed_at | INTEGER | 审核时间 |
| reject_reason | TEXT | 拒因（拒绝必填，沉底留档不删） |
| created_at | INTEGER | 毫秒时间戳 |
| updated_at | INTEGER | 毫秒时间戳 |

> 注：PRD v0.2 设想的 status/source 列——status 于 2026-09-06 刀 1 知识治理落地（§2.79，7 治理列幂等 ALTER + 存量迁移置 staging/community，治理版上线后存量默认不可被问答引用）；source 列随刀 4 知识提案（source=proposal）再入。

### customer_profile（客户画像）
| 列 | 类型 | 说明 |
|----|------|------|
| id | INTEGER PK | |
| session_id | TEXT NOT NULL | 微信会话ID |
| display_name | TEXT | 显示名 |
| customer_id | TEXT | 预留CRM |
| external_source | TEXT | 预留来源 |
| stage | TEXT | new/contacted/quoted/negotiating/won/lost/dormant（**中英混存**：classifier 英文 / AI 见解与手动纠正中文；不迁移存量，语义层 `shared/salesStage.ts` 归桶） |
| tags | TEXT | JSON数组 |
| notes | TEXT | 备注 |
| last_contact_at | INTEGER | 秒时间戳 |
| last_stage_change_at | INTEGER | 毫秒时间戳（migration列） |
| created_at / updated_at | INTEGER | 毫秒时间戳 |

### intent_tag_log（意向日志）
| 列 | 类型 | 说明 |
|----|------|------|
| session_id | TEXT | 微信会话（= customer_id，去重单位） |
| stage | TEXT | 阶段（中英混存，见 customer_profile 注） |
| confidence | REAL | 0-1 |
| source | TEXT | auto_message_trigger / manual / ai |
| reason | TEXT | AI判断依据 |
| created_at | INTEGER | 毫秒（`intentCreate` 可传 `createdAt` 回填历史） |

> 口径：**append-only 阶段变更日志**，部分写入方（AI/手动）不跳过未变化会重复记录，统计必须按 `session_id` 去重，绝不按行数。（原消费方 `funnelStats` 已于 2026-09-13 随销售漏斗页退役删除，见 §2.101；本表**保留**——`customer_profile.stage` 仍是阶段唯一真源。）

### follow_up_task（跟进待办）
| 列 | 类型 | 说明 |
|----|------|------|
| session_id | TEXT | |
| display_name | TEXT | |
| trigger_type | TEXT | rule_r1~r6 / ai_detected / manual |
| title | TEXT | 任务描述 |
| status | TEXT | pending/done/skipped/overdue |
| priority_score | REAL | 排序权重 |
| created_by | TEXT | action_engine / ai / user |
| due_at | INTEGER | |
| created_at / completed_at | INTEGER | |
| analysis | TEXT | （migration列）A1 预热 AI 分析 JSON（whyNow/opportunity/riskSignal/script/nextMove） |

### report_snapshot（报表/复盘）
| 列 | 类型 | 说明 |
|----|------|------|
| period_type | TEXT | week/month/weekly_review |
| period_start / period_end | INTEGER | |
| stats | TEXT | JSON统计 |
| ai_summary | TEXT | AI生成的摘要/建议 |
| created_at | INTEGER | |

---

## 5.1 CRM 独立库 weflow-crm.db（sql.js/WASM，2026-08 增量）

> 销售数据主库 `weflow-sales.db` 之外的**第二库**，承接微信群自动解析 + 业务闭环（合同/回款/物流/发票）。路径 `userData/weflow-crm.db`。表：account / contract / quotation / invoice / logistics / allocation / payment_record / shipping_info / group_config / alias_map / activity_log / contract_status_history / product / **lead**（2026-08 §2.12 新增）/ **opportunity + opportunity_event + crm_risk**（2026-08 §2.14 商机/评分/风险新增，opportunity 由空壳表转商机实体）/ contact / scan_state / processed_msg / crm_field_meta / **auto_confirm_log**（2026-08 §2.6 新增）/ **customer / customer_identity / assignment / ownership_history / outbox_event / audit_event**（2026-09 Phase 0 D3 新增，§2.42）。跟单中心四队列各加 `auto_*` 标记列（allocation.auto_confirmed_by/auto_reason、payment.auto_approved_by、logistics.auto_linked_by、invoice.auto_updated_by），记录自动来源，前端可区分 人工 vs 自动。自动处理前每批一次快照 `crm-backups/weflow-crm-before-auto-*.db`（滚动留 20 份）。

### account（客户，核心）
| 列 | 说明 |
|----|------|
| id / name | 自增 / 客户名 |
| session_id | AI 导入联动（私聊会话） |
| sales_stage | contacted/quoted/negotiating/won/new/unknown（AI 见解中文标签映射） |
| last_contact_at / imported_at | 毫秒时间戳 |
| industry/province/city/phone/owner_sales | 基础字段 |
| company/position | AI 自动填充正式列（公司/职位） |
| enrich_meta | 字段级填充元数据 JSON：fields{source/confidence/evidence/locked} + pending（待确认值） |
| customer_id | 客户主档挂接（Phase 0 D3 可空补列，指向 customer.id，§2.42） |

### quote_signal（报价信号，R7 事实表）
| 列 | 说明 |
|----|------|
| msg_key | 消息唯一键（幂等） |
| session_id / account_id / display_name | 客户定位 |
| amount / model | 报价金额 / 型号（可空） |
| quoted_at / customer_replied_at | 报价时间 / 客户回复时间（0=未回复） |

### lead（线索池，§2.12 新增）
| 列 | 说明 |
|----|------|
| name / contact_phone / contact_wechat | 姓名标签 / 手机号（both 时为主） / 微信号 |
| contact_normalized | 归一化键（手机号 11 位，微信号小写），跨批去重索引 |
| source | 来源（抖音/视频号/小红书/自定义） |
| status | NEW / CONTACTED / WX_ADDED / ACCOUNT / DEAD（5 态，推进动作走 activity_log） |
| first_contact_deadline | 首触 SLA 截止，导入时锁定（改配置不回溯） |
| first_contacted_at / first_contact_channel | 首触时间 / 渠道（微信/电话） |
| dead_reason / account_id | 死因 / 转客户后的 account 引用 |
| owner_id / pool_id / assigned_at / private_deadline | 团队版预留，单机恒 0/NULL |

> 关联：contract.account_id；allocation.payment_record_id+contract_id+account_id；activity_log(entity,entity_id)（lead 流水 entity='lead'）。删除为级联（§2.5），删前自动备份 `userData/crm-backups/`。SLA 卡跨库写 salesDb.follow_up_task（trigger_type='sla_lead'，source_id=lead.id，partial unique index 幂等）。

### Phase 0 D3 六新表（2026-09-02，§2.42；字段权威 = docs/DATA-CONSTITUTION.md §1）
| 表 | 角色 | 关键列 / 约束 |
|----|------|---------------|
| customer | 客户主档（§1.1） | name/type/brand/vehicle_age/modified + 通用五列 |
| customer_identity | 身份锚点（§1.2） | identity_type（phone/wxid，CHECK）+ identity_value **UNIQUE 复合键** + customer_id + confidence |
| assignment | 资源分配（§1.3，取代群扫 tag 归属） | lead_id + sales_name + mode + sla1_deadline + status（assigned/claimed/recycled/transferred，CHECK） |
| ownership_history | 归属变更流水（§1.8，append-only） | entity_type + entity_id + old/new_owner + reason + actor；无 deleted/version 死列 |
| outbox_event | 出站事件发件箱（§1.11，append-only） | idempotency_key **UNIQUE** + payload + status（pending/sent/failed，CHECK） |
| audit_event | 审计流水（§1.12，append-only） | actor + action + entity_type + entity_id + detail；无 version/deleted |

> 存量表补列（幂等 ALTER，逐列吞错）：opportunity +14 列（source/type/amount_cny/币种/型号/台数/发运窗口/交付日/quote_version_id/customer_id，§1.5）；quotation +4 列（version/effective_from/effective_to/pdf_hash，§1.6）；contract +quote_version_id；account +customer_id。quotation.contract_id 双写拍板：Phase 1 版本链写入路径上线起同事务双写，Phase 2 读路径切换后退役。

---

## 6. 文件地图（二创新增/改动）

### 前后端共享 `shared/`
| 文件 | 说明 |
|------|------|
| `salesStage.ts` | **阶段语义层**（§2.24 新建，零依赖纯模块）：`STAGE_CANONICAL`/`FUNNEL_ORDER`、`normalizeStage`（中英→canonical 幂等）、`stageLabel`/`funnelBucket`/`stageToFunnel`。DB 不迁移，UI/统计统一归桶 |
| `customerEvent.ts` | **客户事件唯一语义源**（§2.35 E3.1 新建，零依赖纯模块）：`CUSTOMER_EVENT_TYPES` 五类型（customer_replied/quote_asked/script_copied/chat_opened/follow_up_done）+ `isCustomerEventType` 守卫（防万能日志表，DB CHECK 之外第一道 TS 拦截）+ `customerEventCategory` 分类派生（customer/action，只读不加列）+ `CustomerEventRecord`（message_key 复用 P0-2B 证据锚点；**§2.36 P0-4.2.1 加 `task_id` 行动轴**——correlation key 非合法性前置，无任务上下文 NULL 不伪造） |
| `hermesProtocol.ts` | **Hermes 跨进程协议 v2 唯一真源**（§2.87/§2.89）：Main↔Utility 两消息族 + 严格键集递归校验器 + `HermesBridgeEvidence`（工具结果在途证据，无 ref 无 messageKey）+ `evidenceHandle` 不透明锚点回查句柄（`/^evh-[a-z0-9-]+$/` 收紧，messageKey 形态值拒绝）+ runId 轮次号必填（start/continue/progress/response/checkpoint）+ 脱敏 checkpoint 形态（无 handle） |
| `hermesErrorMessages.ts` | **Hermes 生命周期错误文案唯一真源**（§2.91）：Main/Renderer 共用 `agent_starting` / `agent_unavailable` / `agent_missing` / `protocol_mismatch` / `timeout` / `not_configured` 等稳定错误码的人话映射 |
| `crmRepeat.ts` | **复购归并口径与等级唯一语义源**（交付售后配套，零依赖纯模块）：`crmCustomerKey`（customer_id 优先退 account_id）+ `crmCustomerKeyForOpportunity` + `computeRepeatLevel`（≥3 高频复购·升A / =2 复购老客 / 否则首购）+ `crmRepeatLevel`（旧名兼容）。前端 `src/utils/crmDealKey.ts` re-export 收敛到此，后端 crmAftersalesService.wonDeals / crmDeliveryService.recomputeRepeatLevel 同用，禁止各自手写阈值 |
| `centralSync.ts` | **中央同步协议唯一真源**（§2.104 + §2.105，零依赖纯模块）：协议版本 1、`CentralSyncEvent` 信封、10 类实体 `CENTRAL_ENTITY_TYPES`、`validateCentralSyncEvent`、`findForbiddenCentralField`（**递归**命中 `chat*`/`message*`/`conversation`/`session_id`/`wcdb_path` 即拒收）、**`scopedRef(deviceId, localRef)` / `isRefOwnedByDevice`（引用命名空间唯一规则）**、**导出的字段名谓词 `isForbiddenChatFieldName` / `isForbiddenIdentityFieldName`（本机审计擦洗与中央校验共用同一份清单）**。中央服务与 Electron 两端共用，禁字段规则只此一处，不得各写一套；**§2.108**：`isConcreteRef` 收紧为「`<deviceId>/<kind>:` 之后必须是非空白行号」，`device/customer:` 与空白行号一律 false（具体引用判定唯一实现，不新造第二个解析器） |
| `centralDownCommand.ts` | **下行指令业务校验唯一真源**（§2.105）：`DOWN_COMMAND_SPECS` 逐类型声明合法 `entityType` / 必填载荷 / `deliveryRole` / 目标 / 枚举与长度上限 / 版本前置；**§2.110**：新增 `fields?: Record<string, DownFieldRule>`（`positive_int` / `non_negative_int` / `string`），**HTTP 与 SMB 共用同一份顶层字段形态规则**；`kind` 自带自然下界（`positive_int` ≥ 1、`non_negative_int` ≥ 0），显式 `min`/`max` 只用于收窄（`remindCount` ≤ 3、`slaHours` 1–72）；`leadId`/`assignmentId`/`oldAssignmentId` 必须是**原始 number 正整数**，禁止校验前 `Number()`/`String()`；顶层 `leadId` 与 `lead.leadId` **按原始值直接比较**（原 `Number()` 相等会让跨类型自相矛盾载荷通过）；`required` 里既无 `fields` 又不归 `lead`/`enums` 专门校验器的字段返回 `unregistered_field_rule:<字段>`；`validateDownCommand()` 与 `validateCentralEntityId()` 为纯函数，**SMB 与 HTTP 两条传输共用同一份校验**，禁止各写一套；**§2.108**：新增**枚举唯一源 `ASSIGNMENT_MODES`**（manual / weight / round_robin / load），`assign` 与 `transfer` 的 `mode` **出现即必须是枚举内字符串**（对象 / 数组 / 数字 / 布尔 / 空串 / 未知字符串全拒，**禁止先 `String()` 再比对**）；`validateCentralEntityId` 改为经 `isConcreteRef` 要求「设备命名空间 + 类别与 entityType 相符 + 非空白行号」 |

### 后端 `electron/services/`
| 文件 | 说明 |
|------|------|
| `salesActionEngine.ts` | **核心**：触发规则引擎 + 今日行动生成 + 增量检查（阶段归一化已改用 shared `normalizeStage`）；**§2.35 E3.3**：`recordUserActionEvent` 行动事件写入（白名单 + WARN 容错 + source=manual）+ `completeAction` before 状态检查幂等写 follow_up_done（R7 业务路径零直接事件引用）；**§2.36 P0-4.2.1**：四参 `recordUserActionEvent(sessionId, eventType, messageKey, taskId)`，completeAction 直写 `before.id` |
| `salesStageClassifier.ts` | **核心**：轻量AI阶段分类（7阶段，≤500token/次） |
| `salesDbService.ts` | 销售库CRUD + migration（原 `funnelStats(days)` 历史累计流转漏斗已于 2026-09-13 随销售漏斗页退役删除，见 §2.101；`intentCreate` 仍支持 `createdAt`）+ **§2.35 E3.1 `customer_event` 表与事件原语**（CHECK 五类型门禁 / message_key 幂等 partial unique / `customerEventAdd`（守卫+幂等返回 null） / `customerEventsBySession` / `customerEventsByType(sinceMs?)`；**§2.36 P0-4.2.1 加 `task_id INTEGER` 列**——CREATE 直含 + 幂等 ALTER 兜底旧库，INSERT 支持 task_id；**P0-4.2.2 加 `tasksCreatedSince(ms)` 原语**——窗口内任务，Action Funnel created 段数据源） |
| `actionFunnel.ts` | **P0-4.2.2 Action Funnel 只读组装层**（read model，同 customerCurrentView 先例；零判断零写入）：`getActionFunnel(days?, now?)`——六段 Task-level 去重（executed=task 至少一个执行事件 task_id 关联 / responded=task 产生后 session 有客户响应 / progressed=last_stage_change_at / won=stage=won）/ superseded 不重复计 / 分母 0 → rate null / days 只过滤 created / sources 逐段事实来源（exposed=unmeasured，G1 不可测）/ 不调 LLM 不消费 customer_judgment |
| `salesKnowledgeService.ts` | 知识库CRUD + n-gram检索 + CSV导入 + **话术提炼引擎**（extractScriptsFromChat/generateActionAnalysis） |
| `salesReportService.ts` | 周报/月报 + **周复盘**（weekly_review） |
| `salesIntentService.ts` | AI意向分析 |
| `salesReplyService.ts` | 回复建议（引用知识库） |
| `salesFollowUpService.ts` | 两段式待办提取 |
| `salesQueue.ts` | 串行队列（防WCDB段错误） |
| `centralSyncClient.ts` | **中央 HTTP 客户端**（§2.104 + §2.105）：HTTPS 强制（仅 `http://127.0.0.1`/`localhost` 例外）、`Bearer` 鉴权、`Idempotency-Key`、超时、非 2xx/非 JSON 响亮报错、**错误串不带令牌**；`claim()` 保留返回的设备令牌，`revokeSelf()` 供解绑先吊销后清本地。**错误按「临时网络失败」与「永久契约错误」分流**（前者保持 pending，后者转 `failed` + 审计） |
| `centralProjection.ts` | **上行投影注册表**（§2.104 + §2.105）：只读既有结构化表的 9 类投影；**每个 `eventType` 走显式最小字段白名单**；**可变表按 `(updated_at, id)` 复合水位**（append-only 表仍用 id），幂等键带版本 `#[v]<rev>`，`entityId` 由 `scopedRef(deviceId, localRef)` 生成；读返回 `{drafts, watermark, scanned, skipped, full}`，暂不可投影的行**不阻塞后续合法行**且补齐后经台账重扫；客户身份只上行 sha256 哈希 + 展示掩码；审计 `detailMasked` 按**字段名驱动**擦洗（复用 `centralSync.ts` 的禁字段谓词）；judgment 的 `session_id` 先经 `customer_profile.customer_id` 映射，**映射不到直接跳过**（session_id 与客户原话永不出本机） |
| `centralSyncService.ts` | **Phase 3a 双向同步适配 + 调度器**（§2.104 + §2.105）：上行复用 `outbox_event`（**只有中央确认接收后才结算本机行**；被拒标 failed + 计数 + 审计）；**逐事件定义方向/端点/目标/白名单/终态/重试**——`assign`/`transfer`/`recycle` 走 `command` 下发（**不伪装成上行投影**），其余走投影；`sla1_escalate_supervisor` 按 `centralSyncSupervisorCode` 工号解析目标，**解析不到显式报错并保持 pending，绝不按姓名猜人**；队列先按类型过滤再取批（不再 `LIMIT 50` 后过滤）；跳过台账 `centralSync:skip:`；下行复用 `lanSyncService.applyDownEventDirect()` 的既有状态机与幂等标记，**且不绕过 `shared/centralDownCommand.ts` 的业务校验**；`supervisor_correction` 落 `notify_inbox` 不静默覆盖、`permission_change` 只记声明不作鉴权；未知类型立即 `invalid`、`nolead` 有界重试 5 次后 `invalid`；**`transfer` 一条 outbox → 两条下行指令**（接收方 `apply` / 原归属 `remove`，幂等键各带投递角色与目标员工），**两个目标都被中央受理才结算 `sent`**，任一目标 4xx 整行 `failed`、网络类失败保持 `pending` 靠顺序重试收敛（已受理目标由中央幂等去重，**不另建发送状态表**）；`payload.lead` 白名单按传输上下文分档（`leadFieldsFor`：中央 HTTP 6 字段 / SMB 8 字段）；绑定必启调度器、解绑安全空转、轮巡间隔实时读取、不重复定时器；**§2.108**：发送前对历史载荷调 `healLegacyDownPayload`（失败即 `failed` + 稳定码，不猜不发）；新增**正式失败重投入口** `retryFailedOutbox(rowId)`（服务层事务内条件更新 failed→pending，重复点击幂等，改状态不改 payload/event_seq/idempotency_key，追加 `sync_outbox_retry` 脱敏审计）与只读 `listFailedOutbox(limit)`（裁剪字段、不回传 payload 原文、原因码经 `SAFE_FAILURE_CODE` 过滤）；**§2.109**：新增 `outboxDeliveryStatusOf(rowId)`（**只读**回读单行状态，非法行号返回 `unknown`）、`retryOutcomeOf(deliveryStatus, syncConfigured)`（纯函数，`unconfigured` 优先于行状态）与 `safeSyncError(error)`（走既有 `maskAuditText` + 令牌隐藏 + 截断 300 字） |
| `centralSyncIpcHandlers.ts` | 中央同步 IPC（状态 / 绑定认领 / 立即同步 / 解绑，解绑可带 `force` 走「仅清本机凭证」）；**§2.108** 新增 `centralsync:failed`（只读失败列表）与 `centralsync:retryFailed`（逐项重投，只翻状态，投递交由既有 `runCentralSyncOnce()`）；**§2.109**：重投回包改为**回读该 rowId 的最终状态**后按 `retryOutcome` 如实回传（`sent` / `pending` / `failed` / `unconfigured` / `unknown`）+ `deliveryStatus` + `syncConfigured` + **脱敏后**的 `syncError`，**不再用整轮 `pushed`/`rejected` 反推单行结果，也不再回传未脱敏的 `result.error`** |
| `crmDownPayloadCompat.ts`（§2.108 新建） | **历史下行载荷惰性兼容唯一实现**（发送时补齐，不做全表 UPDATE）：`healLegacyDownPayload(type, payload)` 只为 `transfer` 补齐 `mode` / `sla1Deadline`，**从本机 assignment 行（`payload.assignmentId`）读回移交事实产生时写死的绝对值**，**严禁按当前时间 / 当前 `crmLeadSlaHours` / 接收端配置重算**；不可恢复（assignmentId 非法 / 行不存在 / mode 不在枚举 / sla 非正整数时间戳）返回稳定码，调用方置 `failed` + 脱敏审计；补齐**不动 `event_seq` / `idempotency_key` / `assignmentId` / `oldAssignmentId`**；已合法载荷原对象原样返回。中央 HTTP 发送前自检与 SMB 发送共用此一处。**§2.109**：补齐前**核对一致性**（`payload.leadId` 正整数 + `assignment.lead_id` 相等 + `payload.toSales` 非空 + `assignment.sales_name` 相等，不符即 `legacy_transfer_lead_mismatch` / `legacy_transfer_target_mismatch`，**读到行时总是核对，已合法载荷也拦跨线索串档**）；**字符串 SLA 不是合法绝对时间戳**——`sla1Deadline` 只有原始类型为 `number` 且有限正整数才算已合法，字符串数字一律按「未合法」处理并从 assignment 行读回 `number` 覆盖（HTTP 会 `Number()`、SMB 会拒字符串，原样透传会口径漂移）|
| `salesLogger.ts` | 落盘日志 |
| `ai/aiApiClient.ts` | 统一AI调用层 |
| `insightService.ts`（改） | 销售prompt + 高意向预警（P0-2A.4 起 stage 解析仅写 signal 不覆盖 stage）。**沉默扫描/活跃分析/催办识别已按 PRD §5.4（R）删除**，见 §2.98。**AI 见解屏蔽名单闸门在此按 `triggerReason` 裁决**（显式单客户放行、自动/批量受挡，见 §2.99）；`isSessionAllowed` 只管手动 whitelist/blacklist，**不得把黑名单判定加回** |
| `shared/insightBlacklist.ts` | **AI 见解屏蔽名单条目归一化 SSOT**（§2.99）：主进程与渲染进程共用，旧 `string[]` → `{sessionId, addedAt, source}[]` 的唯一实现；导出 `normalizeInsightBlacklist` / `isInsightBlacklisted` / `addInsightBlacklistEntry` / `removeInsightBlacklistEntry` |
| `salesInsightWrite.ts`（P0-2A.4 新建） | insightService 阶段 signal 写路径（不依赖 Electron，可单测）：`applyParsedStageSignal` = customerUpsert 建档 + intentCreate(source=ai)，**不写 stage** |
| `customerUpsertPolicy.ts`（P0-2A.5 新建） | 通用 upsert 阶段剥离（不依赖 Electron，可单测）：`stripStageFromUpsert` —— IPC 入口运行时剥离 stage，tags/notes/display_name 等其余字段原样保留 |
| `legalStageWriters.ts`（P0-2A.6 新建） | **合法 stage 写者元数据收口**（不依赖 Electron，可单测）：`applyManualStageCorrection`（校验值合法性拒绝非枚举值+dormant + intent_tag_log(source=manual) + 阶段变更写 last_stage_change_at）；`applyDealStageWon`（stage=won + intent_tag_log(source=deal_rule) + 阶段变更写 changedAt） |
| `dbPathService.ts`（改） | Windows多路径检测 + 注册表查询 |
| `wcdbCore.ts`（改） | -2302错误信息改善 |
| `crmDbService.ts` | **CRM 数据层**（weflow-crm.db）：客户/合同/回款/物流/发票 CRUD + 级联删除 + 自动备份 |
| `crmDeliveryService.ts` | **交付售后专用后端**（交付登记/数量差异任务/设备档案/改装质保/以旧换新/复购等级，§1.1/§1.5/§3 登记 2026-09-10）：`registerDelivery`（专用写入替代通用 crm.update，硬校验实发量非负整数/超发带原因/日期合法 + audit_event）、`syncDiffTask`（order>shipped 出卡 / 幂等唯一 pending / 补齐自动关闭+关闭原因 / 差异再现重出卡不覆盖历史）、`saveEquipment`（7 设备字段 + 质保字段，人工确认后写 + 审计）、`runWarrantyReminderScan`（warranty_start_date+warranty_days 临期/到期出卡，无真实日期不猜）、`proposeTradeIn`/`decideTradeIn`（真实证据硬门，只出提案不改客户事实，裁决写 proposal_event+审计）、`recomputeRepeatLevel`（等级变化写审计）、`listDeliveryTasks`/`suggestDeliveryDate`/`runDeliveryScan`（页面事实源 + 幂等扫描）。挂 `onOpportunityDealRegistered` 钩子（成交登记→出差异卡+重算复购） |
| `crmParseService.ts` | CRM 群扫描：银行到款/认领归属/物流批量/发票归档/截图OCR/私聊报价信号；**§2.35 E3.2**：报价信号成功块双写 `quote_asked` + 回复关闭报价双写 `customer_replied`（`recordCustomerEventSafe` 失败只 WARN 不阻断原链，复用 canonical key，evidence 只取原话） |
| `crmEnrichService.ts` | **客户信息自动填充引擎**（置信分级写入/pending/存量回填；绝不创建客户） |
| `crmEnrichCore.ts` | 填充纯核心：提取 prompt + AI 输出解析 + 本地校验（零 electron，可单测） |
| `crmParseRules.ts` | 纯规则库：银行文本/物流批量/发票名/归属简语/私聊成交词表 |
| `crmImportService.ts` | AI 意向判断→CRM 自动导入 + 历史回填 + 内部群成员收集 |
| `crmDeepAnalysisService.ts` | 资深销售助理七板块深度分析（用户自研 prompt 固化） |
| `crmQuoteService.ts` | AI 报价：私聊需求→产品库选型→报价单草稿 |
| `crmDocGenCore.ts` | **文档生成纯核心**（§2.7，零 electron，可单测）：renderDocx + buildInvoiceAppWorkbook + 数据装配 + generateDocBuffer（quotation/contract/invoice-info/**invoice-app**→.xlsx） |
| `moneyCn.ts` | **金额大写纯函数**：`amountToChinese`（零壹贰…元角分整，四位分组 + 组间补零） |
| `crmDocGenService.ts`（改） | **electron 薄壳**：模板路径三候选 + 落盘 `userData/crm-docs` + 写回 attachment_path；generateDoc 为 async |
| `crmAutoConfirmService.ts` | **自动确认引擎**（§2.6）：纯判定 evaluate×4 + applyDecision/runAutoConfirm/undo + 60s 调度器 |
| `crmLeadImportCore.ts` | **线索导入纯核心**（§2.12，零 electron 可单测）：行清洗/批量分类/同批跨批去重/来源预设 |
| `crmLeadService.ts` | **线索流转装配层**（§2.12）：importLeads/listLeads/leadDetail/leadOverview/updateLeadStatus/toAccount/scanLeadSla/complete·skipLeadFirstContact + setLeadConfig shim |
| `intentScore.ts` | **意向评分纯核心**（§2.14，零 electron 可单测）：`computeIntentScore`（阶段基数+近期事件+衰减+商机加权，0-100 封顶） |
| `crmParseRules.ts`（改） | §2.14 新增 `parseBuySignal`（采购信号）+ `parseRiskSignal`（竞品/价格/服务风险） |

### 中央服务 `central/`（独立部署，§2.104）

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 入口：读环境变量配置 → 建 store → `buildCentralApp` → listen；配置缺失即拒绝启动（不静默降级） |
| `src/app.ts` | 路由与鉴权：免认证端点（`/health`、`/ready`、`bindings/claim`）、bootstrap-admin 令牌、设备凭证 Bearer、统一 `require_(capability)` 权限闸门、`redact` 日志、错误码信封 |
| `src/permissions.ts` | **角色→能力表驱动矩阵**（sales/supervisor/allocator/admin/service）；端点只查 `can()`，不散落 role 比较 |
| `src/projections.ts` | **显式投影注册表**：每个实体一张表 + 明确列，缺注册项拒收；SQL 全参数化（只产 `$n`）；版本闸门 upsert |
| `src/store.ts` / `postgresStore.ts` / `memoryStore.ts` | store 接口 + 生产（node-postgres）/ 测试（内存，同款语义）双实现 |
| `src/crypto.ts` | `createSecret`（明文一次性）/ `secretHash`（**只存 sha256 哈希**）/ `safeSecretEqual`（定时安全比较） |
| `src/config.ts` | 环境变量读取与校验（含 `CENTRAL_LOG_LEVEL` 真正传给 Fastify logger、`CENTRAL_TLS_TERMINATED` 影响 `trustProxy`） |
| `migrations/001_initial.sql` / `002_central_projections.sql` | 初始表（工作区/员工/设备/邀请码/事件/回执/审计）+ 10 张显式投影表；单事务按序应用并登记 `schema_migration` |
| `test/*.ts` | `app-test` 55 / `projection-test` 19 / `migration-test` 23 / `context-test` 6（后者校验仓库根 `.dockerignore` 的构建上下文） |

> 部署件在仓库根：`docker-compose.central.yml` + `.dockerignore`。**尚未执行 `docker build`**（本机无 Docker daemon），
> 镜像构建与体积属部署验收项。

### 后端 `electron/hermes/`（§2.87 UtilityProcess 架构）
| 文件 | 说明 |
|------|------|
| `hermesUtilityEntry.ts` | Utility 入口：Agent Loop 宿主（Core+运行时，零 DB/零模型出网，一律 host.request 回宿主；快照透传 evidenceHandle；runId 贯通回传）；U2M 唯一出口 `send` 执行协议校验 + `findHermesBoundaryIssues` 双检（§2.89）；`runHermesUtility(port)` 纯函数 + parentPort 自动引导 |
| `hermesUtilityManager.ts` | Main Manager（唯一可信宿主，§2.88/§2.89）：fork/握手/心跳/至多一次重启/四态 + 宿主三闸（Key 不出 Main、白名单与 capId 重校验、结果再脱敏）+ 任务文本脱敏过界与原文锚点（rawTextByTask/evidenceAnchorsByTask/refAnchorsByTask）+ capability↔contextFingerprint 绑定（startTask 定格 + host.request/continueTask 每次重校验，失效即 `expireTask` 封禁；`invalidateCapabilities` 批量失效）+ runId 轮次门禁（progress/checkpoint/ack 只收当前轮次）+ M2U 唯一出口 `sendToUtility` 双检 + 模型响应二次脱敏 + boundary_violation/context_expired 快速落定 + shutdown 等在途宿主操作 + child 亲和 + 版本 fail closed（不重启）+ generation 绑定；零 electron 依赖（fork 注入） |

### 前端 `src/`
| 文件 | 说明 |
|------|------|
| `pages/TodayActionPage.tsx` | **首页**：今日行动卡片流 |
| `components/sales/SalesContextStrip.tsx` | 聊天页上下文条 |
| `components/sales/CustomerCard.tsx` | 客户画像卡片 |
| `components/sales/ReplySuggestion.tsx` | 回复建议 |
| `pages/CustomerListPage.tsx` | 客户列表+导出 |
| `pages/KnowledgeBasePage.tsx` | 知识库管理 |
| `pages/SalesReportPage.tsx` | 复盘/报表 |
| ~~`pages/SalesDashboardPage.tsx`~~ | **已删除**（2026-09-13 `d2303b0` 代码收口；`/dashboard` 路由一并移除） |
| `components/sales/ExtractScriptDialog.tsx` | **话术提炼弹窗**（单选/批量双模式，三步流程） |
| `components/sales/AIActionCard.tsx`（改） | 行动卡：**打开聊天**（跳转微信会话）+ **复制话术**（无话术先生成再复制）+ AI 面板话术行内复制；P0-3.4 折叠面板改 `item.judgments` 四卡（总结/机会/风险/下一步 + 较旧/人工徽标 + 证据点击回查 P0-2B），不再渲染 analysis JSON 五字段 |
| `pages/CrmWorkbenchPage.tsx` | **CRM 工作台**：合同+客户双 tab、档案一屏、深度分析/AI 报价/建合同/删除、阶段筛选、**打开聊天**、客户 tab 顶部**信息待确认**折叠区块（采纳/放弃/查看档案，`57c4e0f` 自跟单中心迁入） |
| `pages/CrmReviewPage.tsx` | **跟单中心**：归属/物流/到款/发票四队列 + 扫描群配置（含来源显示/金额输入）+ **自动确认摘要块**（运行/历史/撤销） |
| ~~`pages/SalesFunnelPage.tsx` + `.scss`~~ | **已删除（2026-09-13，§2.101）**：销售漏斗（§2.24 历史累计流转 + §2.38 P0-4.4 视觉）已并入商机「阶段分析」视图（`/opportunities?view=analysis`，旧路由 `/sales-funnel` 重定向）；能力对应 `shared/opportunitySignals.ts` + `electron/services/opportunityAnalysisService.ts` + `components/crm/OpportunityStageAnalysis.tsx` |
| `shared/funnelPalette.ts` | **漏斗图表色板单一真源**（2026-08-24 UI 地基）：Apple 蓝渐变五档 + 中性档，供 `FunnelCylinder`（行动漏斗）、商机页、CRM 工作台、复盘页共用；页面禁硬编码品牌色，将来跟主题只改本文件 |
| `docs/DESIGN-SPEC-MINI.md` | **Mini Design Spec**（2026-08-24 UI 美化地基）：token 双套/品牌/主题/暗色/控件惯例/五条红线/四波次 |
| `pages/ActionFunnelPage.tsx` + `.scss` | **行动漏斗**（P0-4.3 §2.37 + **P0-4.4 §2.38**）：五段 Task-level 漏斗（行动产生→销售执行→客户响应→有效推进→成交，**P0-4.4 起 HTML/CSS 自绘梯形替代 ECharts**——四档窗口默认 7 + 蓝系渐变 + 段间箭头 + 段内转化率 + 推进/成交 Info tooltip 弱化映射说明）+ 曝光 N/A 未埋点提示 + 6 KPI（执行率/响应率★北极星/推进转化率）+ KPI/漏斗段点击下钻弹层（事件类型计数 + 最近任务样本 ≤10） |
| `pages/CustomerWorkspacePage.tsx` | **AI 客户工作台**（§2.21）：`rowStage(c)=stageToFunnel(profile_stage||sales_stage)` 统一归桶——阶段筛选/下拉/徽章/深链过滤与漏斗同源（修复英文阶段下钻空白，§2.24） |
| `stores/todayActionStore.ts` | 行动清单store（P0-3.4：不再解析 sig.analysis JSON 注入卡片，判断改消费主进程组装的 `item.judgments`；fetchSuggestion 成功后重读 currentView 刷新） |
| `pages/CrmLeadPage.tsx` + `.scss` | **线索池页**（§2.12，路由 /leads）：导入 modal（来源下拉/文件/文本粘贴）/ 统计卡 / 筛选 chips / 表格（脱敏+超时徽章+行内操作）/ 详情 + dead modal |
| `pages/OpportunityPage.tsx` + `.scss` | **商机页**（§2.14 基建 + **§2.101 双视图**，路由 `/opportunities`）：**列表视图**（ECharts 漏斗下钻 + 统计卡 + 商机卡片（意向评分条）+ 详情 modal（阶段推进/成交丢单/事件时间线/评分依据/风险预警区），行为未变）+ **阶段分析视图**（`?view=analysis`：管道总览 + active-only 漏斗分段 + 最大卡点双指标 + 选中段优先处理名单含三动作）；两视图各自保留筛选与滚动位置 |
| `components/crm/OpportunityStageAnalysis.tsx` + `.scss`（部分在 OpportunityPage.scss） | **商机阶段分析视图**（§2.101）：管道总览三指标、分段条（阈值/滞留数/滞留额/最大卡点标记）、优先处理名单（排名徽章 + 理由带「来源：…」+ 去跟进/建待办·查看待办/生成跟进建议）；**界面不展示任何公式或分值** |
| `shared/opportunitySignals.ts` | **商机确定性信号唯一事实源**（§2.101，纯函数、零 IO、零 AI）：`STAGE_DWELL_DAYS`（了解 7/比价 3/决策 2，成交段不适用）、`deriveOppAssessment()`、`compareByUrgency()`（优先层排序）、`rankCandidates()`、视图载荷类型 |
| `electron/services/opportunityAnalysisService.ts` | **商机只读跨库装配**（§2.101）：`collectOpportunityAssessments()`（`WHERE status='active'`）/ `wonInWindow(30)` / `buildOpportunityAnalysis()`；IPC `crm:opportunity:analysis` |
| `utils/settingsTiers.ts` | **设置页「自动化程度」三档映射唯一事实源**（§2.103，纯函数、零 IO、无 React，放 `src/` 以绕开 `shared/**` 的伴生 `.d.ts` 约定）：`AUTO_TIERS`（保守/标准/积极）、`tierOf()`（反推，未命中返回 `''` 未选择态）、`valuesOfTier()`、`clampEnrichThreshold()` / `isClamped()`（交叉校验）。**标准档必须逐字等于落库默认值**，否则升级用户被静默改阈值 |
| `utils/aiServicePresets.ts` | **AI 接入档位映射**（§2.103）：`AI_SERVICE_PRESETS`（DeepSeek / OpenAI 兼容 / 自定义）、`normalizeBaseUrl()`（去尾斜杠）、`presetOfBaseUrl()`、`MAX_TOKENS_TIERS`（短 512 / 标准 1024 / 长 2048）、`maxTokensTierOf()` / `tokensOfTier()` |
| `utils/backupStatusLabel.ts` | **备份状态人话映射**（§2.103）：`backupLayerLabel()` / `keyProtectionLabel()`，取值口径 = `autoBackupCore.AutoBackupLayerStatus`，未命中一律「未知状态」。⚠️ 与 `shared/auditDict.ts` 的 `BACKUP_LAYER` 同词汇两语境，改词需两处一起看 |
| `stores/crmStore.ts`（改） | **autoSummary** state + runAutoConfirm/fetchAutoSummary/undoAutoConfirm |
| `stores/` (其他5个) | dashboard/customerList/customerProfile/followUp/knowledge/salesReport |

### 测试脚本 `scripts/`
| 文件 | 说明 |
|------|------|
| `hermes-utility-test.ts` | **Hermes UtilityProcess 动态测试**（§2.87-88，**161 断言/17 场景**，真 fork Utility 入口 TS）：握手/全链路+锚点恢复/文本脱敏过界/progress/白名单/畸形消息+版本 fail closed/取消×2/崩溃重启×2/恢复+锚点存活/shutdown 等在途操作/child 亲和/旧版本假 child/迟到消息忽略/静态红线 |
| `hermes-utility-child-shim.cjs` | 动态测试专用 IPC shim（`--require` 预载）：child_process IPC 模拟 parentPort 的 MessageEvent 形态，生产不加载 |
| `crm-workbench-test.ts` | CRM 业务闭环单测（**48 项**：归属/签约/导入/聚合/成交/删除/到款审核/去重） |
| `crm-golden-test.ts` | 规则 golden 测试（**31 项**，含 isDealSignal） |
| `crm-claim-test.ts` | 货款认领测试（17 项） |
| `crm-autoconfirm-test.ts` | **自动确认引擎单测**（**56 项**：归属 A1-A10 / 到款 P1-P8 / 物流 L1-L6 / 发票 I1-I5 / 金额 F1-F4 / docgen 注入 / 引擎 E1-E5 / 撤销 U1-U6） |
| `crm-enrich-test.ts` | **自动填充引擎单测**（**48 项**：合并规则 / 核心解析校验 / 落库链路 / pending 裁决 / 填充度 / statsOverview） |
| `crm-docgen-test.ts` | **文档生成单测**（**68 项**：金额大写 18 / docx 渲染 / 端到端 quotation/contract/invoice-app 合并+公式+大写 / 型号输出 / invoice-info 落点） |
| `crm-cleanup-orphans.ts` | 孤儿客户清理 + 备份（一次性脚本） |
| `crm-lead-test.ts` | **线索流转单测**（**53/53**：清洗/去重/SLA/闭环，2026-08 §2.12） |
| `crm-opportunity-test.ts` | **商机/评分/风险单测**（**110/0**：意向评分 / parseBuySignal / 商机累积 / 阶段联动 / 漏斗 / 风险 / 成交登记 / 报价版本链，2026-08 §2.14 起） |
| `opportunity-analysis-test.ts` | **商机阶段分析 + 统一信号流单测**（**72/0**，2026-09-13 §2.101）：active-only 口径（won/lost 不进管道）、quote_signal 判定与降级文案、优先层排序、最大卡点双指标、汇入 getUnifiedSignals 的合并去重、聚合只读与 TOP N = 排序前缀 |
| `settings-tiers-test.ts` | **设置页人话化档位与折叠单测**（**68/0**，2026-09-13 §2.103）：a–c 三档映射/clamp 纯函数，d 组 P0 接线（含 `useState` 初值防漂移、滑杆「迁入而非删除」区块级断言），e 组 P2 AI 接入（含默认 1024 防漂移、**弹窗留在折叠之外**），f 组 P3 术语与折叠（含 `&` 二次展开防回归） |
| ~~`funnel-test.ts`~~ | **已删除（2026-09-13，§2.101）**：测的是随销售漏斗页一并退役的 `funnelSummary` |
| `intent-score-test.ts` | **intentScore 两 bug 回归**（**17/17**，P0-2A.1 `6bf1ff6`）：STAGE_BASE 改 canonical 键 / normalizeStage 输入 / lastContactAt 秒→毫秒 |
| `canonical-state-test.ts` | **canonical read model 回归**（**37/37**，P0-2A.2 `a3f3479`）：getCanonicalState / stateMeta 来源置信度证据 / unknown 异常位 |
| `action-rules-test.ts` | **action rules 阶段口径归一回归**（**32/32**，P0-2A.3 `308d5d9`）：R0-R6 中英统一过 normalizeStage / dormant 走 activityState |
| `insight-stage-ban-test.ts` | **insight 禁写 stage 回归**（**16/16**，P0-2A.4 `53ee94b`）：扫描前后 stage 不变 + intent_tag_log 新 signal |
| `upsert-stage-ban-test.ts` | **通用 upsert 禁 stage 回归**（**24/24**，P0-2A.5 `2933a2d`）：strip 保留其余字段 / tags-notes 更新 stage 保持原值 / 新客户=unknown / 负向控制底层仍可写 |
| `legal-stage-writers-test.ts` | **合法写者元数据收口回归**（**25/25**，P0-2A.6 `3ff3f1f`）：manual 校验拒绝非法值 + changedAt / deal_rule 补写 + 幂等不刷 changedAt / read model 集成 |
| `customer-judgment-test.ts` | **AI 判断基础设施单测**（**40/40**，P0-2C.1 `07241f4`）：建表列 / CHECK 禁 stage / append-only / projection + id 兜底 / CurrentAll 跨 session / 历史 / 去重窗口 / 证据字段 round-trip / 证据诚实 / stage 抛错硬门禁 |
| `summary-judgment-test.ts` | **summary 判断落库单测**（**33/33**，P0-2C.2 `fc654b2`）：6 验收——正常生成落库 / messageKey 保存 / evidenceText 是客户依据非 AI 结论 / 无可靠 key→unavailable 不伪造 / 持久化去重 + 手动覆盖 / 现场生成路径不变 |
| `action-analysis-judgment-test.ts` | **action analysis 三调用点落库单测**（**37/37**，P0-2C.3 `057f8aa`）：三类型映射 / 任务 source_message_id 锚点证据 / 兜底链路 / unavailable 不伪造 / 24h 按类型去重 + suggest 手动覆盖 / 三层分离 |
| `p0-2-real-db-audit.ts` | **P0-2 收口真实库只读盘点**（sql.js 内存加载，纯只读可重复）：stage 分布 / 判断覆盖率 / evidence 可用性 / 去重健康度 / 冲突观察 / 锚点覆盖 |
| `current-view-test.ts` | **P0-3 客户当前视图单测**（**30/30**，P0-3 第一刀 `7950ca6`）：无客户 null / 空态四类型 null / 投影 + type 映射 / freshness 24h 窗口（stale 仍返回）/ 缺 summary 不补 / analysis JSON 不并入 / evidenceStatus / state 透传 / generated_at 回退 |
| `customer360-consumer-test.ts` | **P0-3.2 360 消费 currentView 护栏**（**13/13**，`9a375b3`）：静态（handler 无现场 LLM / 无 360 生产者 / UI 无 advice 直读 / UI 不直读真源）+ 行为（空态 / 投影字段完备 / 证据状态 / stale 并存） |
| `sales-context-strip-test.ts` | **P0-3.3 状态条消费 currentView 护栏**（**10/10**，`14eaa07`）：静态（消费 currentView / suggest 保留 / 不直读真源 / item 带 sessionId / 生成后重读顺序）+ 行为（落库→立即可见闭环 / 无 sessionId 断链复现 / manual 跳过去重保留覆盖） |
| `today-action-consumer-test.ts` | **P0-3.4 今日行动卡消费 currentView 护栏**（**14/14**，`03d994d`）：静态（AIActionCard 消费 judgments / 不渲染 analysis 五字段 / 不直读真源 / 证据走 evidenceGetByKey / store 无 JSON.parse(sig.analysis) / fetchSuggestion 重读顺序 / engine 组装 judgments / 收件箱历史语义）+ 行为（signal.judgments 组装 / 任务字段保留 / 无判断四类 null / 虚拟卡 null / append 后重跑反映最新） |
| `p0-3-closed-gate.ts` | **P0-3 收口验收**（**6/6 静态 + 真实库运行态**，P0-3 CLOSED）：全仓 src/ 137 文件剥离注释扫描（无 customer_judgment/insight_record/follow_up_task/现场 LLM 直读 + 消费统一走 currentView + 三消费者四卡一致）+ sql.js 只读真实库（判断覆盖/freshness/evidence 可解析/冲突观察）。**§2.108 输出脱敏**：终端只出聚合计数 / 通过失败 / 结构性结论，**不再打印 `session_id` / 判断正文与摘要 / `evidence_text` / `messageKey` 原文 / 客户姓名 / 联系方式 / 库绝对路径**，逐行样例转储整段删除（脚本仍只读）；红线由 `p0-3-closed-gate-test.ts` 强制 |
| `p0-3-closed-gate-test.ts`（§2.108 新建） | **p0-3 门禁输出脱敏守卫**（**23/0**）：静态 S1–S7 在**剥离注释后**的 gate 源码上禁止「取出来起别名再打印」与「把库路径塞进 console」的回归写法；输出捕获 O0–O12 用**合成库**（哨兵全是编造字符串，建在 /tmp 一次性目录跑完即删）起子进程真跑 gate，断言七类哨兵与合成库绝对路径一个都不出现，**同时断言聚合计数仍在**（脱敏不等于把验收输出砍空）。**§2.109 消除空断言**：合成 `customer_profile` 改按**真实生产 DDL**（salesDbService）建表，联系方式哨兵同时写进两个真实承载列（`notes` 备注 / 第二行 `display_name` 微信备注），并在跑 gate 前**只读回查**（P1–P3）证明哨兵真的在库里——此前 `S_CONTACT` 只定义、从未落库，O7 是一条**恒真的空断言**。**仍然不打开真实业务库** |
| `central-down-compat-test.ts`（§2.108 新建） | **升级前 pending 移交兼容全链**（**44/0**）：A0–A10 补齐语义（含「把当前 `crmLeadSlaHours` 改成 999 后恢复值一字不变」）/ A11–A15 不可恢复稳定码 / B1–B3 两条通道静态共用同一 helper / C1–C4 SMB 落地且文件名与幂等键不变、载荷带恢复值且过 `validateDownEventFile` / D1–D5 隔离件同路径重写后两轮收敛 / E1–E2 `failed` + 脱敏审计键集恰为 `{reason,type}` / F1；**§2.109 新增 G1–G13**：字符串数字 SLA **不得**算「已合法」（`"1735689600000"` 被读回为 `number` 覆盖，小数 / `NaN` / `Infinity` / `0` / 负数 / 对象 / 数组 / 布尔 / 空串同样不合法且**无一能把字符串透传出去**）/ 字符串 SLA + 行不可用 → `legacy_transfer_sla_unrecoverable` / 跨线索（`assignment.lead_id ≠ payload.leadId`）→ `legacy_transfer_lead_mismatch` / `toSales` 不匹配与形态非法 → `legacy_transfer_target_mismatch` / **已合法载荷但身份不符同样拒收**（已合法也要拦串档）/ 行不存在且载荷自足 → **原对象原样返回** / 拒收码**不含任何客户值** / 零业务写。隔离临时目录，不读真实生产库 |
| `central-retry-outcome-test.ts`（§2.109 新建） | **失败行重投的结果口径**（**20/0**）：注册**真实 IPC 处理器**（`registerCentralSyncIpcHandlers` 只依赖 `type IpcMain` 与无 electron 依赖的 salesQueue，可用假 ipcMain 驱动），假 fetch 按路径路由（**不发真实网络请求**）：A `sent`（回读确认行已由状态机结算 `sent`，且该行真的进入中央请求）/ B `pending`（网络故障：翻转被接受但**绝不报成功**，行仍 `pending`，`syncError` 手机号打码 `138****2222` + 令牌显示为 `[已隐藏令牌]`）/ C `failed`（重投后再次 4xx：行回终态 `failed` + 新增本机审计）/ D `unconfigured`（本机零请求，**绝不是成功**）+ 纯函数格（`retryOutcomeOf` / `outboxDeliveryStatusOf` 只读、非法行号 `unknown`）/ E 稳定拒收（非法 rowId / `sent` 行 `not_failed` 不可复活 / 不存在 `not_found`）/ F 静态契约（IPC 回读 rowId、`safeSyncError` 脱敏、设置页四分支且不再读整轮计数、`finally` 仍刷新）。布置用 `INSERT` 终态行，**绝不 `UPDATE ... SET status`** |
| `customer-event-test.ts` | **P0-3 E3.1 CustomerEvent 基础设施护栏**（**16/16**）：静态 8（五类型枚举完整 / shared 无越界类型（防万能日志表）/ 建表 CHECK 五类型 / message_key 幂等 partial unique / 原语命名 / 类型守卫被引用 / customerEventAdd 单表写四者不互相冒充 / Scope Lock 文档同步）+ 行为 8（append 可读 / 同 key 幂等拒绝 / 无 key 手动事件可重复 / 非法类型抛错 / bySession 倒序 / byType+sinceMs / metadata 往返 / 与判断意向三表独立） |
| `customer-event-producer-test.ts` | **P0-3 E3.2 最小生产者护栏**（**14/14**）：静态 8（quote_asked/customer_replied 双写点 / closed>0 门控 / 复用 canonical key 不拼 key / evidence 原话非 AI 结论 / helper try/catch+WARN 不阻断 / customerEventAdd 仅 1 处且在 recordUserActionEvent 内（R7 路径零直接事件引用，E3.3 收窄） / crmDbService 零事件污染 / intent_tag_log 零新写点）+ 行为 6（报价双写一致 / 同 key 双幂等 / 回复闭环 customer_replied_at 更新+事件 / closed=0 门控不写 / 写失败不阻断原链仍成功 / metadata 报价详情） |
| `customer-event-action-test.ts` | **P0-3 E3.3 销售行动事件护栏**（**20/20**）：静态 11（recordUserActionEvent 导出+白名单 / completeAction before 状态检查+follow_up_done 写入 / **P0-4.2.1** follow_up_done 携带 before.id（四参）/ IPC sales:action:recordEvent + taskId 透传（typeof number 才传）/ preload actionRecordEvent 签名含 taskId / AIActionCard 成功点接入 chat_opened+script_copied + **rawTaskId 提取上报** / follow_up_done 不经 IPC / 无第二套 action log / source=manual）+ 行为 9（pending→done 恰好一条 + **task_id=task.id** / 重复完成幂等不新增 / skipped 不写 / script_copied 带 taskId 落库 / 白名单外拒绝不抛 / 空 sessionId 容错 / **无 taskId 上报 → NULL 不伪造**） |
| `action-funnel-test.ts` | **P0-4.2.2 + P0-4.3 Action Funnel 护栏**（**25/25**）：静态 4（导出+纯只读零 judgment/LLM / sources 六段逐段正确 / rate=null 分母守卫 / tasksCreatedSince 原语）+ 行为 15（空库全 null / 组合场景六段+转化率+窗口全量 / executed task-level 去重（2 事件 → 1）/ 无 task_id 不归入 / superseded 不重复计 / 时序守卫（task 前事件不计）/ responded 去重 / progressed 前后时序 / won 中文口径 / 响应率公式 / days 窗口）+ **breakdown 6（P0-4.3）**（计数与聚合严格一致 / executed.eventTypeCounts 精确 script_copied=2+chat_opened=2+follow_up_done=0 / responded 精确 customer_replied=2+quote_asked=1 / samples createdAt 降序 + t1 双类型去重 / samples 含 taskId/sessionId/title / breakdown 窗口传递） |
| `action-funnel-closed-gate-test.ts` | **P0-4.2.3 + P0-4.3 Action Funnel 收口护栏**（**17/17**）：静态 8（导入白名单零 judgment/LLM / **全文件零写方法 + 读访问仅白名单三原语（P0-4.3 起 A2 升级整文件检查**——collectTaskRows 提取后读方法移出函数体，限定体内检查不再成立）/ 执行+响应事件白名单不膨胀 / sources 六段不变量 exposed=unmeasured / divRate 分母守卫 / tasksCreatedSince 唯一消费者 / 无第二套 action log / task_id 非空写点仅 E3.3）+ 真实库运行态 7（customer_event 0 基线 / created 口径闭合 1217+1601=2818 / won=26 normalizeStage 同口径 / 7d<=30d<=全量窗口结构 / executed+responded=0 / last_stage_change_at 非空 0 / 六段事实来源字段齐全），验收文档 `docs/实施记录/P0-4.2-收口-契约验收.md` |
| `customer-event-closed-gate-test.ts` | **P0-3 E3 收口护栏**（**16/16**）：静态 13（customerEventAdd 出现点恰 3 / 事件查询原语仅 Action Funnel 消费（**P0-4.2.2 更新**：getActionFunnel 为唯一正当只读消费者，四消费者仍不迁）/ 无绕过 DDL 直接 SQL / 五类型写点归属 A4a-d / follow_up_done 不经 IPC / 单表写四层边界 / quote_signal 不迁移 / 无第二套 action log / R7 零事件消费 / 文档同步）+ 真实库 3（customer_event 0 基线 / quote_signal 分流兼容 / DDL 无损建表+CHECK 拒绝越界） |

### 资源/脚本（§2.7 新增）
- `resources/crm-templates/{quotation,contract}.docx` —— 真实模版（docxtemplater 标签已注入，**提交进仓库**，随 extraResources 打包）；改模版用 `python3 scripts/build-crm-templates.py [源目录]`（默认读 `/tmp/crm-tpl-inspect/`）
- `scripts/build-crm-templates.py` —— python-docx 一次性注入脚本（真实样板 → 仓库模版）

### 已删除
- `cloudControlService.ts`（向上游上报使用统计，隐私风险）
- `salesAlertService.ts`（废弃死代码）

---

## 7. 已知坑铁律（摘要，详见 MAINTENANCE.md）

1. **永不 push origin**（origin=上游），只用 backup
2. **不加 `app.disableHardwareAcceleration()`**（会导致闪退）
3. **WCDB 时间戳是秒**，JS Date 是毫秒
4. **`enqueueSalesTask` 只加最外层**，内部绝不再 enqueue（死锁）
5. **`ELECTRON_RUN_AS_NODE=1` 让 Electron 当 Node 跑**（GUI 消失、--version 报 Node 版本）；vite 已自动清除，勿再删 dist 重建
5. **单一固定 system prompt**，差异放 user prompt（API缓存）
6. **win 只打 x64**，交叉编译前必须 `npm install @koromix/koffi-win32-x64@3.1.0 --force`
7. **koffi 版本必须精确匹配**（当前 3.1.0），`^` 会导致 Mismatched native Koffi modules
8. **打包前必杀残留进程**（否则 packaging 阶段死锁）
9. **ffmpeg 缺失会崩**：用户需自备 `~/bin/ffmpeg`
10. **WCDB 消息字段是 snake_case**：`is_send`/`create_time`/`message_content`/`sender_username`（不是 camelCase），用错字段名全部读到 undefined
11. **`chatService.getSessions()` 返回 `{success, sessions[]}`** 而非裸数组，`Array.isArray()` 永远 false，需解包 `.sessions`

---

## 8. 打包发布

详见 MAINTENANCE.md §3。快速参考：

```bash
# 清理
pkill -9 -f "vite|esbuild|rolldown|WeFlow|Electron|electron-builder|app-builder"; sleep 3
rm -rf release dist dist-electron

# Mac
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64

# Windows（交叉编译）
npm install @koromix/koffi-win32-x64@3.1.0 --save-optional --force
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --x64
```

---

## 9. 配置项

| 键 | 默认 | 说明 |
|----|------|------|
| aiModelApiBaseUrl | — | DeepSeek API 地址 |
| aiModelApiKey | — | API Key |
| aiModelApiModel | deepseek-chat | 模型名 |
| aiDailyCallLimitEnabled | true | 每日 AI 调用上限总开关 |
| aiDailyCallLimit | 60 | 每日 AI 调用**次数**硬上限（按次数不按金额，见 §2.98）；80% 预警 |
| aiInsightNonCustomerBlacklist | [] | **AI 见解屏蔽名单**（纯手动管理，2026-09-13 由「AI 自动判定非客户」重定义，见 §2.99）。存 `{sessionId, addedAt, source}[]`，`source` 为 `manual`（客户工作台「…」菜单加入，带二次确认）或 `legacy_auto`（旧版自动判定存量，`addedAt` 为 `null` 显示「时间无记录」）。**兼容读旧 `string[]`**，读时经 `shared/insightBlacklist.ts` 归一到新形态，写入路径统一走同一归一函数。**闸门按触发方式裁决**：命中者跳过 `activity`/`silence`/`alert:*` 等自动与批量类见解（不调模型），用户显式单客户触发（`manual`/`test`）放行且结果带轻提示 |
| crmAutoConfirmEnabled | true | 跟单中心自动确认总开关 |
| crmAutoConfirmThreshold | 0.8 | 自动确认置信阈值 0.5-1.0（低于留人工） |
| crmAutoConfirmInvoiceDocgen | false | 发票自动关联后自动生成开票信息单（需合同含 tax_no） |
| crmEnrichEnabled | true | CRM 客户信息 AI 自动填充总开关 |
| crmEnrichThreshold | 0.7 | 自动填充：进 pending 队列的置信下限（低于丢弃） |
| crmEnrichAutoApply | 0.85 | 自动填充：直接写入档案的置信阈值 |
| crmEnrichBackfillLimit | 20 | 自动填充：单次存量回填客户数上限 |
| crmLeadSlaHours | 24 | 线索首触 SLA 小时数（1-72，导入时锁定不回溯） |
| crmLeadSourcePreset | 抖音,视频号,小红书 | 线索来源预设（逗号分隔，导入/筛选下拉） |
| centralSyncEnabled | false | **Phase 3a 中央同步总开关**（§2.104）。为 true 时 Phase 1 SMB 同步自动停用（同一 outbox 不被两个传输层竞争结算）；为 false 时 Phase 1 行为完全不变 |
| centralSyncBaseUrl | — | 中央服务地址（必须 HTTPS；仅 `http://127.0.0.1` / `localhost` 放行用于本机联调） |
| centralSyncDeviceToken | — | 设备凭证，**存 safeStorage（`ENCRYPTED_STRING_KEYS`），不明文持久化**；服务端只存 sha256 哈希 |
| centralSyncWorkspaceId / centralSyncEmployeeId / centralSyncDeviceId | — | 绑定后的工作区 / 员工 / 设备标识（设备标识经 `scopedRef()` 统一生成 `entityId` 与 `idempotencyKey` 前缀） |
| centralSyncSupervisorCode | `''` | **§2.105**：SLA1 升级主管的**稳定工号**（`sla1_escalate_supervisor` 的中央投递目标）。按工号解析，**解析不到即显式报错并保持 pending，绝不按姓名猜人** |
| centralSyncDisplayName / centralSyncRole | — | 员工显示名与服务端角色（**仅署名与展示；权限一律以服务端 employee.role 为准**） |
| centralSyncPollIntervalMin | 1 | 轮巡间隔（分钟）；**每次心跳实时读取**，改配置即时生效，不需要重启调度器 |
| centralSyncLastError / centralSyncLastErrorAt | '' / 0 | 最近一次同步失败的遮罩后原因与时刻（设置页「最近错误」行数据源；成功即清空） |

---

## 10. 未完成 / 待办

> **2026-08-23 重组**：下一阶段主线 = **§2.26 P0 路线**（AI 销售副驾驶）。已核销：话术提炼优化（基础版已交付）、行动卡深链客户档案（§2.17 一键闭环+深链已实现）、漏斗深链（§2.24 已实现）；已合并：零操作闭环实测 + 线索池实测 → 「实测反馈驱动迭代」；已定决策：触发规则配置 UI 冻结（L0-L3 文档化）、跟单中心增强拆分保留发票解析（到款/归属合并暂缓）、灵感信箱保留暂缓。**（2026-09-12 更新：主线已切换为 `docs/规划/weflow-hermes-PRD-v3.4.md`，本表 P0 行转为历史索引）**

| 优先级 | 项目 | 说明 |
|--------|------|------|
| 已收口（历史） | **§2.26 P0-1 → P0-5** | AI 销售副驾驶主线（2026-08-23 定稿，**2026-08-24 P0-4 CLOSED 后收口；成果仍在主干运行**，权威记录见 §2.26）：P0-1 E4 证据链 UI（**第一刀已实现并提交**：intent_tag_log 证据列 + 透传 + source_message_id；运行时验证三件事通过，见 §2.26）→ P0-2 客户「AI 当前判断」（**2026-08-23 数据契约盘点完成，见 docs/实施记录/P0-2-数据契约盘点.md**；**P0-2A Canonical State 设计已定稿，见 docs/P0-2A-Canonical-State-设计.md**：canonical 6 值 + activityState 拆 dormant + unknown 异常位；写者资格 classifier/intent/manual/deal ✅、insightService ❌ 降 signal、generic upsert ❌ 移除、dormant 规则写 activityState；intentScore 只修两 bug；**六刀已全部提交**：`6bf1ff6` 两 bug / `a3f3479` read model / `308d5d9` 规则口径归一 / `53ee94b` insightService 禁写 stage / `2933a2d` generic upsert 移除 stage / `3ff3f1f` manual+deal 补元数据；下一步 = P0-2B Evidence Resolver）→ P0-2B Evidence Resolver（**已提交** 两刀 `04dbaec`+`21fd148`）→ P0-2C AI Judgment Persistence（**盘点定稿 + 三刀已提交**：`07241f4` + `fc654b2` + `057f8aa`，见 §2.28）→ **P0-2 收口 CLOSED**（静态契约验收 + 真实库只读盘点 + 护栏封死，见 §2.29）→ P0-3 Current Judgment Consumer Layer（**第一刀已提交** `7950ca6` getCustomerCurrentView 只读组装层 + 独立 IPC + 30 断言，见 §2.30；**P0-3.2 已提交** `9a375b3` Customer 360 判断卡消费 currentView——删除现场 generateActionAnalysis，13 护栏断言，见 §2.31；**P0-3.3 已提交** `14eaa07` SalesContextStrip 消费 currentView + suggest 主动生成保留（sessionId 断链修复 + 生成后立即重读闭环），10 护栏断言，见 §2.32；**P0-3.4 已提交** `03d994d` 今日行动卡判断展示消费 currentView（getUnifiedSignals 组装 judgments / store 删 analysis JSON merge / AIActionCard 面板 judgments 四卡 / 收件箱保留历史语义），14 护栏断言，见 §2.33；**P0-3 已收口 CLOSED**（全仓静态护栏 6/6 + 真实库运行态验收，见 §2.34））→ P0-3 E3 CustomerEvent（扩展 intent_tag_log，复用 12h 节流）→ P0-4 Action 埋点（新增 script_copied/chat_opened/customer_replied）→ P0-5 L0-L3 文档化 |
| **P0 主线** | **北极星埋点验收锚点** | 六段漏斗「发现→生成→采纳→执行→响应」：**先埋点 → 验证数据 → 后看板**（硬原则）。前置：opportunity 表加 `source` 字段（区分 AI 发现 vs 手动）；「有效响应」第一版只记 `customer_replied` 不判有效。闭环完成判定 = 北极星各段有真实数据 |
| P1 | **实测反馈驱动迭代** | 原「零操作闭环实测」+「线索池实测」合并：用户实测自动确认判定（阈值可调）、行动卡打开聊天/复制话术/撤销、线索池清洗去重，有反馈再迭代 |
| P1 | **发票金额自动解析** | 跟单中心增强拆分保留项（PDF/文本）；到款/归属两队列合并**暂缓**（§2.26 冻结范围） |
| P1 | 深度分析结果缓存 | 同客户 N 小时内不重复调 AI（避免反复点重复花费），可加缓存列 |
| P1 | CRM 客户黑名单 | 删除后的客户若会话还在、AI 见解再标有意向会被重新导入——需黑名单机制 |
| P2 | 优先级公式重设计 | 等 customer_value_score 有真实数据源后 |
| P2 | 知识库增量补充 | 已有353条产品参数，需持续补充叉车行业话术/FAQ |
| **P1 收口** | **§2.41 UI 线提交 + Windows 包** | 工作区攒了：分库（§2.40）+ 七页 UI 美化（§2.41）+ 线索归属管理 + 4 个 bug 修复，全部未 commit——先提交，再重打 Windows x64 包（分库+新 UI 一起带），用户机装包后首次启动自动迁移 → 设置页点一次「归档」得干净库，另跑商机修复 SQL |
| P1 | 复盘页限宽居中 | §2.41 七页中唯一未做（.sr-page 全高滚动布局，需验证后改） |
| 暂缓 | 触发规则配置 UI | **§2.26 L0-L3 文档化决策**：v1 硬编码，先验证有效再评估，P0 闭环前冻结 |
| 暂缓 | 灵感信箱合并到今日行动 | 等 insightService 与规则引擎产生实际冲突后再评估 |
| **P3a 收口** | **中央节点 Phase 3a 部署验收** | **Phase 3a 代码侧仍未收口。** 首轮实现（§2.104）+ 阻断项修复（§2.105）+ 复核收口（§2.106）+ 契约修复（§2.107：移交 SLA 保全 / SMB 接入共享校验 / 建档字段强制 / 4xx 部分成功审计补强）已完成并通过自动化验证：中央服务 + HTTP 双向同步 + 绑定/吊销/权限 + 显式投影 + 敏感字段出机封锁 + 跨设备越权拒绝 + 版本化增量 + 移交双目标投递 + 服务端引用闸门 + 中央操作审计 + 移交 SLA 精确落地。已披露残留：**下行指令的线索档案面**（中央 HTTP 固定 6 字段，`contactNormalized` 必然过网；`contactRaw`/`wechat` 一律 400）、冲突裁决未细化。**尚未做**：`docker build` 与镜像体积、真实 PostgreSQL 端到端、反向代理与证书、双机同步演练（改→断网→改→恢复无丢无误）、离职移交全流程演练、档案上行延迟 ≤5 分钟——均为部署/真机验收项。**§2.108（第四轮）另收口**：升级前 pending 移交的惰性兼容（沿用 assignment 里已存的 SLA 绝对值，**不重算**）、失败 outbox 的**正式重投入口**（服务层 + IPC + 设置页；e2e 不再直改数据库）、`mode` 收紧为四值枚举、`entityId` 必须具体引用、p0-3 门禁输出脱敏 + 守卫测试 ；**§2.109（第五轮）另收口**：历史移交富化的**一致性核对**（lead/目标销售不符即拒收，已合法载荷也拦跨线索串档）与**字符串 SLA 不算合法绝对时间戳**（一律读回 `number` 覆盖，绝不透传字符串）、本机分配 `mode` 与同步接收端**共用同一四值契约**（`assignLeads` 非法值零写入、批量**不再静默回退** `weight`）、重投结果按**该行自己的最终状态**判定（「重新排队」≠「同步成功」，`syncError` 脱敏）、p0-3 文案哨兵**真的写进合成库**（消除恒真空断言）、适配器测试**不再直接改 outbox 状态** |
| 大后期 | CRM 双向同步（业务面） | 传输层已由 §2.104 Phase 3a 打通；此处指更上层的双向业务编排，仍仅预留 |
| 大后期 | 向量数据库 | 知识库>1000条时考虑 |

---

## 11. 给接手者的下一步

1. **读本文档** → 读 `MAINTENANCE.md` → 读 AGENTS.md
2. **跑起来**：`npm install && npm run dev`（开发模式）。⚠️ 若 `--version` 报 v24.17.0 且无 GUI，先 `unset ELECTRON_RUN_AS_NODE`（见 MAINTENANCE §4.8，vite 已自动防御）
3. **跑单测确认基线**（2026-09-13 实测计数，旧文档的 48/31/17/56/53 与 09-12 的 74/40/161 已过期）：
   `npx tsx scripts/crm-workbench-test.ts`（89/0）、`npx tsx scripts/crm-golden-test.ts`（47/0）、`npx tsx scripts/crm-claim-test.ts`（17/0）、`npx tsx scripts/crm-autoconfirm-test.ts`（58/0）、`npx tsx scripts/crm-lead-test.ts`（59/0）；
   合同与报价录入相关：`npx tsx scripts/buyer-header-test.ts`（76/0，抬头粘贴解析）、`npx tsx scripts/crm-docgen-test.ts`（81/0，含续跑复用判定）；
   AI 简报/按需识别改动相关：`npx tsx scripts/morning-digest-test.ts`（47/0）、`npx tsx scripts/ai-identify-test.ts`（48/0）、`npx tsx scripts/insight-noise-test.ts`（39/0）、`npx tsx scripts/insight-dedup-test.ts`（19/0）、`npx tsx scripts/insight-unnamed-session-test.ts`（9/0）、`npx tsx scripts/settings-nav-test.ts`（**74/0**）；
   商机阶段分析/统一信号流相关：`npx tsx scripts/opportunity-analysis-test.ts`（**72/0**，2026-09-13 新增）、`npx tsx scripts/crm-opportunity-test.ts`（110/0）、`npx tsx scripts/today-action-consumer-test.ts`（14/0）；
   审计流水 / 存量迁移报告展示层：`npx tsx scripts/audit-dict-test.ts`（**203/0**，2026-09-13 新增——人话词典覆盖护栏）、`npx tsx scripts/audit-query-test.ts`（32/0，同批扩充实体显示名断言）；
   设置页人话化档位（自动化程度 / AI 接入 / 术语与折叠）：`npx tsx scripts/settings-tiers-test.ts`（**68/0**，2026-09-13 新增——含两条**默认值防漂移**核心断言：自动化「标准」档 == 落库默认 0.85/0.70/0.80、回答长度「标准」档 == 默认 1024）
   （计数含 2026-09-12/13 两轮新增断言：六态 `crm_only` 文案 3 条、`salesActionEngine`/`salesStageClassifier` 自动分派护栏 3 条、AI 上限变更审计 13 条、抬头解析与页面接线 76 条、工作台改价审计与创建链幂等 15 条、docgen 续跑复用 3 条、商机合并 72 条、人话词典全量覆盖 203 条、设置页档位映射与折叠接线 68 条）
   今日行动 / 统一信号流 / 物流闭环（2026-09-13 红测试归因收口后**全部入基线**）：`npx tsx scripts/todo-followup-test.ts`（**16/0**）、`npx tsx scripts/crm-sla-action-test.ts`（**11/0**）、`npx tsx scripts/customer-event-producer-test.ts`（**15/0**）、`npx tsx scripts/customer-event-closed-gate-test.ts`（**16/0**）、`npx tsx scripts/crm-logistics-test.ts`（**37/0**）
   迁移失败项人工闭环（2026-09-14 新增）：`npx tsx scripts/migration-dismissal-test.ts`（**14/0**——dismissal 往返/幂等、模块② 扫描过滤、词典覆盖、IPC 接线、ENTITIES 白名单）
   消息推送会话类型分类（2026-09-14 新增）：`npx tsx scripts/message-push-session-type-test.ts`（**22/0**——sessionId 形态分类、单聊跳过分支生效与撤回例外、旧写法死路成因反证与防回退静态锁）
   **Phase 3a 中央同步（2026-09-14 新增 §2.104；2026-09-15 阻断项修复 §2.105、复核收口 §2.106、契约修复 §2.107、收口 §2.108 后复测）**：`npx tsx scripts/central-sync-client-test.ts`（**24/0**——传输约束/鉴权/失败语义/不泄令牌/端点契约，注入假 fetch 不发真实网络）；`npx tsx scripts/central-sync-adapter-test.ts`（**97/0**（§2.108 补 J7–J11 引用具体性正反例）——上行投影与显式白名单/成功才结算/下行状态机/有界重试/解绑三态/调度器与 SMB 互斥/版本化增量与跳过台账；E4–E7 建档契约负例：只有 leadId / 空 contactNormalized / 顶层与子对象 leadId 不一致 / transfer 缺 sla1Deadline+mode 全部终态 invalid 且零业务写零幂等标记）；`npx tsx scripts/central-sync-e2e-test.ts`（**84/0**（§2.108：J11d 改走正式入口 `retryFailedOutbox`，不再直改数据库；补 J11d0/J11e–J11j 边界与 K1–K8 中央 HTTP 历史兼容）——真实业务生产者→outbox→适配器→Fastify `app.inject`→`MemoryCentralStore`→投影/指令→pull→本机状态机→ACK→结算的**完整契约闭环**。除敏感字段不出机、跨设备越权、网络失败重放、幂等、游标跳过外，**J 段是真实移交链**：调用真实 `transferAssignment()` → 一条 outbox（携带本轮真实 `sla1Deadline`/`mode`）→ 两条下行指令（新归属 `apply` / 原归属 `remove`）→ 双目标都受理才置 `sent` → 重放判 duplicate 不新增指令与审计 → 第二目标先瞬时失败保持 `pending`、恢复后补齐；**4xx 部分成功**（第一目标受理 + 第二目标永久 400 → 整行 `failed` + `sync_outbox_failed` 审计带 `failedRole`/`failedTarget`/`delivered`，修复后重投收敛 `sent`）；两个接收端各经既有状态机落地并回 ACK，**sla1Deadline 精确等于发起端指令值、remove 不动 SLA、重放零漂移**；E5–E7 补真实 `runSla1Recycle()` 的 recycle 链（`recycle` **不携带** `lead` 子对象）；**无 Docker 依赖**）。中央服务侧另跑：`cd central && npm run typecheck && npm test`（app **159** / projection 36 / migration 23 / context 6，全 0 失败；M11–M23 = 建档契约与 transfer SLA 正反用例，K7–K10 = `entityId` 具体引用，M24–M27c = `mode` 枚举）与 `cd central && npm run build`。`central/test/app-test.ts` 跑在 **MemoryCentralStore** 上，**不能替代真实 PostgreSQL 验证**——PG 侧只有 P7/P8 源码级契约断言（同事务 / 只在首次写入 / SQL 参数化 / 不记载荷），DDL 约束、并发与事务隔离、`$n::uuid` 运行时行为均未验证。**注意**：`central/` 是独立包，**不在根 `npm run typecheck` 的覆盖范围内**，改中央代码必须另跑这两条。**另注意**：`scripts/central-sync-e2e-test.ts` 与适配器测试均用 `WEFLOW_WORKER` / `WEFLOW_USER_DATA_PATH` / `WEFLOW_CONFIG_CWD` 指向临时目录，**不读真实生产库**；`scripts/assignment-correction-test.ts` 与 `scripts/lead-assignment-restore-test.ts` 会复制真实生产库做基线比对，**不得作为中央同步的回归证明**；**§2.108 新增**：`scripts/central-down-compat-test.ts`（**44/0**（§2.109 补 G1–G13 字符串 SLA 拒收与赋值身份核对）——升级前 pending 移交惰性兼容全链）、`scripts/p0-3-closed-gate-test.ts`（**23/0**（§2.109 补 P1–P3 哨兵落库前置断言）——门禁输出脱敏静态 + 输出捕获守卫）；**§2.109 新增**：`scripts/central-retry-outcome-test.ts`（**20/0**——重投四种结果的真实 IPC 级验证）；`scripts/central-sync-adapter-test.ts` 复测 **98/0**、`scripts/central-sync-e2e-test.ts` 复测 **88/0**、`scripts/assignment-full-test.ts` **100/0**（§2.109 补 I1–I9 本机 `mode` 契约）、`scripts/lan-sync-test.ts` 复测 **93/0**、`scripts/lan-sync-e2e-test.ts` **42/0**、`scripts/p0-3-closed-gate.ts` **6/0**（真实库运行态，仅计数）
   ✅ **2026-09-13 红测试归因收口**：上述 5 个套件此前长期红色、被当作「已知恒定失败」接受（其中 `todo-followup`／`crm-logistics` 启动即死）。已逐套归因并全部修复入基线，**本仓库不再有「红了但没人知道为什么」的套件**。归类为：测试滞后于有意变更 2 套（W2a 拒绝按客户批量完成、F1 统一信号流改纯读）、测试基建 2 套（A7 静态断言误伤 SQL 注释、B11 断言开发者真实库 0 行——一次性迁移快照）、真实回归 1 套（W2a 重写误删 `completeUnifiedSignal` 的 `logi:` 分支，已恢复）。逐套根因（含 git 证据）、分类处置与实测输出见 `docs/实施记录/红测试归因与收口-实施记录-claude-20260913.md`
   ⚠️ **`npx tsc --noEmit` 只检查 `src/**` 与 `shared/**`，不覆盖 `electron/`**（根 tsconfig 仅 include 这两个目录）。检查主进程需另跑 `npx tsc -p tsconfig.node.json --noEmit --composite false`（现为 **0 错误**，见下条棘轮门禁）。历史：2026-09-13 实测存量 156 个（旧记的 161 系不同命令口径），当日**不能以"零错误"为门禁**、只能比对"不新增"。详见 §2.98。
   ✅ **2026-09-14 棘轮门禁落地**：`npm run typecheck` 现已串联 root 零错误 + `scripts/typecheck-node-ratchet.cjs`（electron/ **棘轮基线 0**，只准保持 0）。基线史：156（09-13 实测）→ 8 → 7（存量消肿）→ 3 → **0**（同日真 bug 修复与类型清零，见 `docs/实施记录/技术债收口-实施记录-kimi-20260914.md` §4）。单独跑主进程门禁：`npm run typecheck:node`。
4. **测试零操作闭环**：跟单中心（自动确认摘要块/运行按钮/历史撤销、设置页阈值）、今日行动（打开聊天/复制话术）、CRM 工作台客户（打开聊天）
5. **测试话术提炼**：知识库页 → 选联系人设日期区间 → 提炼 → 看效果
6. **测试线索池**：/leads → 导入 Excel/CSV 或粘贴文本（来源下拉）→ 验证清洗/去重/统计 → 等 SLA 超时后今日行动出现「首触提醒」卡 → 完成/跳过 → 转客户
7. **继续开发**：需求见 **`docs/规划/weflow-hermes-PRD-v3.4.md`**，按 Phase 0/1/2 推进（`AGENTS.md`「需求」条同指）。§2.26 AI 销售副驾驶已于 2026-08-24 收口，仅作历史路线参考；其余按 §10 待办优先级

---

## 12. 文档索引

| 文件 | 用途 |
|------|------|
| `docs/HANDOVER.md` | 本文件（全局交接） |
| `docs/规划/weflow-hermes-PRD-v3.4.md` | **当前需求文档（开发执行依据）** |
| `docs/规划/AI简报与按需识别-PRD-v1.0.md` | AI 简报/按需识别的实施契约（§2.98 的依据） |
| `docs/实施记录/技术债收口-实施记录-kimi-20260914.md` | 迁移失败项人工闭环 + tsc 棘轮门禁与存量消肿（含疑似真 bug 清单） |
| `docs/实施记录/中央节点同步通道-实施记录-claude-20260914.md` | **§2.104 的实施记录 + §2.105 的追补记录**：改动清单 / 11 端点契约 / 逐项验证输出 / 明确区分「已实现且自动化验证」与「需部署或真机才能完成」；§8 = 2026-09-15 八类阻断项修复（改动 / 测试 / 残留披露 / 结论措辞）；**§10 = 同日第三轮契约修复**、**§11 = 同日第四轮收口（§2.108）** |
| `docs/audit/中央同步-阻断项修复-审计报告-claude-20260915.md` | **§2.105 的审计报告**：八类阻断项处置对照 / 两处真实缺陷复盘（`readVersioned` 优先级错误、审计投影泄漏 wxid）/ 明确残留清单 / 本轮真实验证输出；**§6 = 同日第三轮**、**§7 = 同日第四轮（§2.108）的缺陷复盘与验证输出** |
| `docs/规划/AI调用入口与消费清单.md` | **AI 调用点与 purpose 对照表**（唯一采集层、价格表与上限规则；新增 AI 调用点必读） |
| `docs/实施记录/AI简报与按需识别-实施记录-claude-20260912.md` | §2.98 的实施记录（验收逐条自查 / 真实输出 / 遗留项）＋ §6.8 = §2.99 屏蔽名单重定义（含开工前提证伪核实、闸门决策落点、遗留项） |
| `docs/实施记录/合同与报价录入加速-实施记录-claude-20260912.md` | 合同/报价录入加速（PRD v1.4）的实施记录（改动清单 / §10 逐条自查 / 真实输出 / 未实测项） |
| `docs/实施记录/审计与迁移报告人话化-实施记录-claude-20260913.md` | 审计流水 + 存量迁移报告人话化（纯展示层）的实施记录（改动清单 / **50 条 action 全量枚举表 + 写入点 + 来源标注** / 硬性约束自查 / 真实数据目检输出 / 遗留项）；`shared/auditDict.ts` 词典与覆盖护栏的权威说明（§2.102） |
| `docs/实施记录/设置页人话化-实施记录-claude-20260913.md` | 设置页人话化 P0–P3（纯展示层）的实施记录（改动清单按 P0–P3 / **档位映射表** / 验证真实输出 / 遗留项）；`src/utils/settingsTiers.ts` + `aiServicePresets.ts` + `backupStatusLabel.ts` 三份映射常量的权威说明（§2.103） |
| `docs/实施记录/商机合并与优先处理-实施记录-claude-20260913.md` | 商机 + 漏斗合并（v2.1）的实施记录（改动清单 / **数据语义落点对照表（设计稿附页逐条）** / 硬性约束自查 / 真实输出 / 遗留项）；漏斗退役与统一信号流汇入的权威说明 |
| `docs/实施记录/红测试归因与收口-实施记录-claude-20260913.md` | 5 个长期红色套件的归因与收口（**逐套根因 + git 证据** / 分类处置 (a)(b)(c) / 断言等价性说明 / 修复后实测输出 / §11 基线更新）；`completeUnifiedSignal` 的 W2a 契约与 `logi:` 分支的权威说明 |
| `docs/MAINTENANCE.md` | 操作手册（打包/坑/安全） |
| `docs/归档/prd旧版/PRD-v2-销售行动驱动器.md` | v2 产品规划（已被 v3 取代） |
| `docs/归档/prd旧版/PRD-v0.2-AI销售助手.md` | 历史需求（已取代） |
| `docs/HTTP-API.md` | HTTP API 文档 |
| `docs/MAC-KEY-FAQ.md` | Mac 密钥 FAQ |
| `docs/产品库导入模板.csv` | 知识库导入模板 |
| `AGENTS.md` | Agent 启动指南（本地，gitignore） |
| `docs/实施记录/PLAN-CRM零操作改造.md` | CRM 零操作改造方案（已实施，含提交映射） |
| `docs/归档/交接旧版/HANDOVER-20260818-CRM零操作改造与产品库.md` | 2026-08-18 阶段交接（零操作改造/R7/三优化/产品库导入指引） |
| `docs/设计-单机线索流转模块.md` | 线索流转 PRD+技术设计（**最终定稿，已实现**，2026-08 §2.12） |
| `docs/归档/prd旧版/PRD-团队版-WeFlow+Twenty底座.md` | 团队版演进预留（Twenty 底座，线索映射为自定义对象） |
| `DEVELOPMENT.md` | AI Agent 软件工程开发规范（项目级开发规则） |
| 微信文件 | `今日行动-优化PRD-v3.md` / `今日行动-第一期PRD.md` |

---

## 13. 提交历史（47条，分组）

### 话术提炼 v2 + 批量 + 日期筛选（2026-07-29）
- `d40cd4d` fix: 日期区间变化时触发重新扫描
- `e8ae71d` fix: scanExtractCandidates 真正使用 beginDate/endDate
- `b14479b` refactor: 删除「最近N个月」筛选，统一用日期区间
- `4fb4b91` fix: 月份筛选0=不限制（cutoffSec=0跳过时间过滤）
- `63c9b8f` feat: 话术提炼加日期区间筛选
- `d719e4a` feat: 话术提炼升级为「AI销售教练」— 分析+诊断+优化+多版本
- `a6287db` fix: WCDB消息字段改为snake_case（is_send/create_time/message_content）
- `32aacdf` fix: salesKnowledgeService.ts 补 salesLog import
- `c2c4429` fix: main.ts 补 salesLog import
- `e335ffc` fix: 加 log:debug IPC handler
- `d71255c` fix: ExtractScriptDialog 加防御性检查
- `7b54454` debug: ExtractScriptDialog 加前端诊断日志
- `13e35e0` debug: 话术提炼加完整消息字段诊断
- `d9a191c` fix: senderUsername 优先于 talker
- `f461532` feat: 一键提炼全部私聊话术（批量模式）
- `1cd37df` feat: 一键提炼增加「扫描候选」步骤
- `aacc36f` fix: 一键提炼改用 username 特征过滤
- `b7def7d` fix: 一键提炼改用 chatService.getSessions()

### v3 第一期 — 今日行动引擎（2026-07-29）
- `39bd7a2` fix: 代码审查修复 — 5个bug（R6守卫/retry竞态/错误处理/timer/命名）
- `f60b5bd` feat: 今日行动v3第一期 — 客户去重+R6独立+懒扫描+AI深度分析升级
- `8ad9e29` fix: 恢复灵感信箱独立入口（Sidebar + RouteGuard）
- `b1f4295` fix: AI话术崩溃根因 + 代码类型清理

### PRD v2 核心（2026-07-28~29）
- `145395d` fix: salesLogger 导入修复 + salesReportService 语法
- `0784417` feat: P2 聊天页销售上下文条
- `94f71bb` feat: P1 周复盘引擎 + 知识库批量导入 + 话术联动
- `8756e79` feat: P0 今日行动引擎（PRD v2 核心）

### Windows 适配（2026-07-28）
- `05e7ce4` fix: koffi 版本锁定 + 错误提示误判修复
- `9ba4a82` fix: 修复 Windows 数据库连接失败（koffi 未打包 + 路径检测）

### v1.0.0 发布（2026-07-26）
- `5f6f9bc` release v1.0.0: 版本号独立线+移除上游publish配置
- `6686dd1` chore: 维护性清理 + MAINTENANCE.md

### 销售功能开发（2026-07-24~25）
- `5f8b2f2` feat: 催办自动识别 + 客户导出 Excel + WCDB 串行队列
- `93494c2` fix: 知识库真正接入 AI 回复
- `f692d47` feat: 核心三件套（仪表盘+客户列表+高意向预警）
- `5a1aa14` feat: 批量画像 + AI见解同步提取
- `2a088ea` feat: 灵感信箱销售化改造
- `c9fc722` feat: 跟进待办 V1 重做
- `fc9649d` feat: AI 自动识别跟进待办
- `bc79055` feat: 第四阶段⑨⑩ 跟进待办 + 高意向预警
- `5c8e62a` feat: 第三阶段⑧ 智能回复建议
- `7c519ff` feat: 第三阶段⑦ 意向分级
- `e29a451` feat: 第三阶段⑥ 客户画像卡片
- `72a3122` feat: 第二阶段 P0 功能（知识库+周报月报）

### Bug 修复（2026-07-24~25）
- `9443ad5` fix: 批量画像方法位置
- `294936c` perf: 统一 system prompt
- `9bda5be` fix: 沉默扫描防刷屏
- `d03461d` fix: AI扫描消息时间字段兼容
- `c6382b3` fix: AI扫描改为消息层日期过滤
- `8c461b3` fix: AI扫描时间戳单位修复
- `dc3d1a2` feat: AI 扫描支持日期范围
- `ad56227` fix: 周报/月报改用原生 API
- `3d3cadf` fix: 放宽周报会话过滤
- `fb394a3` fix: 移除 GPU 禁用代码（闪退真凶）
- `762ec5e` fix: messages 变量作用域
- `d8ae652` fix: 禁用 salesAlertService + 并发锁
- `b394464` fix: ffmpeg 回退路径
- `dcf834e` fix: 移除 chatService 依赖
- `38d7370` fix: 消息读取和会话过滤
- `380dd40` fix: main.ts 多余括号
