# WeFlow AI 销售助手 · 交接文档（HANDOVER）

> 给**任何接手者 / 新会话 / clone 本仓库的人**看的全局交接文档。
> 基线 commit `d40cd4d`；**AI 销售副驾驶产品/开发主线**（下一阶段北极星「有效销售行动」漏斗 + P0 路线 + L0-L3 边界 + 冻结范围）见 §2.26（规划定稿，未提交）；客户名真相源修复（微信号名回填微信真实备注）见 §2.25（已提交）；漏斗改造（历史累计流转 + canonical 语义层 + 下钻修复）见 §2.24（已提交）；物流群扫描失效修复见 §2.23（getMessages 升序 + 传 startTime 扫增量，已提交）；最近提交 **P0-4.4 打磨修正**（`828b6bb` 固定比例梯形 + svg 圆角渐变 + 主题蓝箭头 + 映射 tooltip + 删跳级；`a21fc2e` 文档；见 §2.38）+ **P0-4.4 双漏斗 UI 统一视觉体系**（`e0736b3` 四档窗口 + 蓝系渐变 + 行动漏斗 HTML/CSS 自绘梯形 + 映射 tooltip，纯 UI，见 §2.38）+ P0-4.3 UI/KPI 消费（`94f1bbb` 五段漏斗 + 6 KPI + 点击下钻可追溯 + breakdown 下钻原语共享判定行，25/25，**P0-4 CLOSED**，见 §2.37）+ P0-4.2.3（`e431221` 护栏 17/17 + 验收文档 `docs/P0-4.2-收口-契约验收.md`，**P0-4.2 CLOSED**，见 §2.36）+ P0-4.2.2（`20ddc3f` getActionFunnel Task-level 只读组装层：六段去重 / sources 逐段 / rate null 守卫 / superseded 排除 / 时序守卫 / days 只过滤 created，19/19 + 真实库验收 5/5，见 §2.36）+ P0-4.2.1（`4292d06` correlation 补齐：customer_event.task_id + 三写点带 task_id，20/20，见 §2.36）+ E3 收口（`d97f663`，16/16，见 §2.35）+ P0-3 收口（`scripts/p0-3-closed-gate.ts` + `docs/P0-3-收口-契约验收.md`，**P0-3 CLOSED**，见 §2.34）+ `03d994d`（P0-3.4：今日行动卡判断展示消费 currentView，analysis JSON 不再冒充当前判断，见 §2.33）+ `14eaa07`（P0-3.3：SalesContextStrip 消费 currentView + suggest 主动生成保留 + 落库断链修复，见 §2.32）+ `9a375b3`（P0-3.2：Customer 360 判断卡消费 currentView，360 不再现场调 LLM，见 §2.31）+ `7950ca6`（P0-3 第一刀：customer current view 只读组装层 + 独立 IPC，见 §2.30）+ `2ce99fc`（P0-2 收口 runtime CLOSED）+ `2932195`（P0-3 Current Judgment Consumer 盘点）+ `35519a1`（P0-2 收口：真实库只读盘点 + 契约验收封板）+ `057f8aa`（P0-2C.3 action analysis 三调用点统一落 judgment）+ `fc654b2`（P0-2C.2 summary 判断落库）+ `07241f4`（P0-2C.1 customer_judgment 基础设施）+ `21fd148`（P0-2B evidence resolver）+ `04dbaec`（P0-2B messageKey 集中化）；`3ff3f1f`（P0-2A.6 manual/deal 写者元数据收口）；`ef100ed`（2026-08-23 漏斗改造：历史累计流转 + canonical 语义层 + 下钻修复，见 §2.24）；P0-1 AI 证据链 `4338921`——intent_tag_log 证据列 message_key/evidence_text + follow_up_task.source_message_id，三件运行时验证通过，见 §2.26；P0-2A 六刀已全部提交：`6bf1ff6` intentScore 两 bug → `a3f3479` canonical read model（真实库并行验证 0 漏斗变化）→ `308d5d9` action rules 阶段口径归一 → `53ee94b` insightService 禁写 stage 降 signal → `2933a2d` generic upsert 移除 stage 资格（IPC 运行时剥离 + TS 类型删除双保险，tags/notes 仍正常更新）→ `3ff3f1f` manual/deal rule 写者元数据收口（manual 校验值合法性 + changedAt；deal rule 补写 intent_tag_log + changedAt）；**P0-2 数据契约盘点完成**（`docs/P0-2-数据契约盘点.md`；**P0-2A Canonical State 设计已定稿**，`docs/P0-2A-Canonical-State-设计.md`——canonical stage 6 值 + activityState 拆 dormant + unknown 异常位；写者资格 classifier/intent/manual/deal 保留、insightService 禁写 stage 降 signal、generic upsert 移除、dormant 规则写 activityState；intentScore 只修两 bug 不重做算法；**六刀已全部提交**）；**P0-2B Evidence Resolver 两刀已提交**（`04dbaec` messageKey 构造集中 + `21fd148` 统一证据读入口，45 测试断言含只读验证，设计 docs/P0-2B-Evidence-Resolver-设计.md）；**P0-2C AI Judgment Persistence 三刀已全部提交**：`07241f4`（P0-2C.1 customer_judgment 基础设施，盘点 docs/P0-2C-AI-Judgment-Persistence-盘点.md）+ `fc654b2`（P0-2C.2 summary 落库，接入 generateInsightForSession）+ `057f8aa`（P0-2C.3 action analysis 三调用点统一落 judgment）；**P0-2 已收口 CLOSED**（静态契约验收全绿 + 真实库只读盘点 + 8 条架构护栏封死，见 §2.29，下一动作 = P0-3 Current Judgment Consumer Layer））；客户名称读取侧统一 + 同名不跨会话 + logi 签收闭环 `068a403`，见 §2.20；SLA 首触卡移出主卡流 `c90e6c9`，见 §2.17；今日行动/待办职责分工 `d5b9f62`，归档 FollowUpPage，见 §2.19；AI 回写 model/sourceId 溯源 `223c158`，见 §2.18；SLA 卡置顶+提分 `678e3f0`，见 §2.17；线索池排序 `3156910`；SLA/Action 接通 `5ba531b`，见 §2.17；Customer 360 统一时间线 `6c439bf`，见 §2.16；侧边栏导航收口 7 模块 `09d5600`，见 §2.15；信息待确认迁至工作台客户 tab `57c4e0f`；跟单中心物流卡两行化 `bfed14d`；新建合同选型号 `3e44a12`；复盘排除非销售联系人 `ed510df`；销售复盘改造 `9a9fbaf`；AI 见解 24h 去重+非客户黑名单 `f02b13c`；今日行动新建待办 `8085dc2`；漏斗深链 `11359fe`；漏斗数据 `c719678`；P0 见 `0eab71f`；阶段性交接见 docs/HANDOVER-20260818-CRM零操作改造与产品库.md）。
> `npx tsc --noEmit` 零错误；crm 全系单测：workbench **50/50**、golden **45/45**、claim **17/17**、autoconfirm **58/58**、docgen **68/68**、enrich **55/55**、lead **53/53**、logistics **37/37**、opportunity **45/45**、funnel **40/40**（历史累计流转漏斗 + P0-1 证据断言）、todo-followup **11/11**（手动待办）、report-review **33/33**（销售复盘）、message-key **17/17**（P0-2B messageKey 构造集中）、evidence-resolver **45/45**（P0-2B 证据统一读入口，含只读断言）、customer-judgment **40/40**（P0-2C.1 AI 判断基础设施，禁 stage 硬门禁 + 证据诚实）、summary-judgment **33/33**（P0-2C.2 summary 落库：证据诚实 / append-only 去重 / 手动覆盖权利）、action-analysis-judgment **37/37**（P0-2C.3 三调用点统一落 judgment：任务锚点证据 / 兜底链路 / 按类型去重 / suggest 手动覆盖 / 三层分离）、current-view **30/30**（P0-3 第一刀只读组装层：空态 / 投影 / freshness 窗口 / analysis 不并入）、customer360-consumer **13/13**（P0-3.2 360 消费 currentView：无现场 LLM / 无 advice 直读 / UI 不直读真源）、sales-context-strip **10/10**（P0-3.3 状态条消费 currentView：suggest 主动生成保留 / sessionId 断链修复 / 生成后立即重读闭环）、today-action-consumer **14/14**（P0-3.4 今日行动卡消费 currentView：analysis JSON 不再冒充 / 虚拟卡 judgments null / 生成后重读闭环 / 收件箱保留历史语义）、p0-3-closed-gate **6/6 静态 + 真实库运行态**（P0-3 收口：全仓 137 文件历史载体零冒充 / 真实库 18 判断 6 客户全 fresh 证据可解析，见 §2.34）、customer-event **16/16**（P0-3 E3.1 CustomerEvent 基础设施：五类型 CHECK 门禁 / message_key 幂等 / 单表写四者不互相冒充 / 无 key 手动事件可重复，见 §2.35）、customer-event-producer **15/15**（P0-3 E3.2 最小生产者：quote_asked/customer_replied 双写不改变原链路 / closed>0 门控 / 复用 canonical key / 写失败不阻断 / 三表零污染 / **无名 session 门控**（accountId=0 不写 customer_event——观察期防污染），见 §2.35）、insight-unnamed-session **6/6**（无名 session 跳过见解链：沉默扫描 + blacklist 活跃分析无客户档案会话不入队 + 零 this.isSessionIdLike 模块函数护栏，见 §2.37、2026-08-24 isSessionIdLike 修复）、customer-event-action **20/20**（P0-3 E3.3 销售行动事件：script_copied/chat_opened/follow_up_done 挂在动作成功点 / follow_up_done 状态转换幂等 / 写失败不阻断 UI / 无第二套 action log；**P0-4.2.1** 行动事件带 task_id correlation（before.id / 前端 rawTaskId / 无 task 上下文 NULL 不伪造），见 §2.35、§2.36）、customer-event-closed-gate **16/16**（P0-3 E3 收口：全仓静态 13 项契约 + 真实库运行态 3 项，E3 已 CLOSED，见 §2.35；**P0-4.2.2 起 A2 更新为「事件查询原语仅 Action Funnel 消费」**——getActionFunnel 为唯一正当只读消费者，四消费者仍不迁）、action-funnel **25/25**（P0-4.2.2 六段只读组装 + **P0-4.3 breakdown 下钻**：executed/responded 事件类型计数精确 + 最近任务样本降序去重 / 与聚合共享 collectTaskRows 判定行口径严格一致，见 §2.36、§2.37）、action-funnel-closed-gate **17/17**（P0-4.2.3 收口护栏：静态 8 + 真实库运行态 7——created 口径闭合 1217+1601=2818 / won=26 / 窗口结构不变量 / executed+responded+progressed 0 样本属部署时序，见 §2.36；**P0-4.3 起 A2 升级为整文件检查**——collectTaskRows 提取后读方法移出 getActionFunnel 体，改查全文件零写方法 + 读访问仅白名单三原语，更严格）。
> Mac + Windows 双平台打包验证通过。
> **2026-08-13 增量**：确认中心零操作化（自动确认引擎 + 三触发点 + 前端摘要/历史/撤销）+ 行动卡一键闭环（打开聊天/复制话术）+ Electron 闪退真因修正（见 §2.6）。
> **2026-08-20 增量**：客户名真相源修复（微信号名回填微信真实备注 + 显示名解析优先微信备注，见 §2.25，已提交）；漏斗改造（历史累计流转 + 逐级转化率 + canonical 语义层 + 下钻修复，见 §2.24，已提交）；AI 销售助手 V1 P0 三缺口落地——商机闭环（采购信号→商机→阶段联动→漏斗）、意向评分 0-100、风险预警结构化（见 §2.14）；漏斗数据修复（转化率相对顶部 + 近7天去重，commit `c719678`，已被 §2.24 取代）；漏斗深链修复（阶段统一 customer_profile.stage，commit `11359fe`）；今日行动新建待办（手动待办进信号流 + 侧栏可勾选，commit `8085dc2`）；AI 见解 24h 去重 + 非客户自动黑名单（commit `f02b13c`）；销售复盘改造（周复盘打通 + 非客户过滤 + 崩溃兜底，commit `9a9fbaf`）；复盘排除非销售联系人（手动排除名单，同事/朋友聊天剔除出统计，commit `ed510df`）；新建合同选型号（工作台从产品库勾选，创建即自动生成报价单，commit `3e44a12`）；跟单中心物流卡两行化（信息/时间与操作分区，commit `bfed14d`）；信息待确认迁至工作台客户 tab（裁决与 AI 补全同页闭环，跟单中心不再展示，commit `57c4e0f`）；侧边栏导航收口 7 模块（今日行动/聊天/CRM/跟单/AI·知识/报表/系统，数据驱动 NAV_GROUPS，commit `09d5600`）；Customer 360 统一时间线（客户档案时间线聚合合同/到款/物流/报价/线索流转/商机事件/AI 见解一条流，前端四色混排并删重复「最近见解」块，commit `6c439bf`）；SLA/Action 接通（首触 SLA 扫描接入 Action 引擎每日 08:00 + 今日行动页打开周期，长时间运行不漏卡；lead:/logi: 虚拟卡隐藏无效「打开聊天」，commit `5ba531b`）。
> **2026-08-23 增量**：**落 §2.26「AI 销售副驾驶」为下一阶段产品/开发主线**（规划定稿）。定位：AI 观察/理解/判断/准备，销售最终判断与对外执行，L3 自动对客回复明确不做。固化三个关键事实：① P0-1 前置已确认——微信消息读取统一走**应用读取层 `chatService`**（解密 WCDB 只读，产品核心能力；HTTP API 是同一读取层的 HTTP 封装，非独立数据源），无需新增读取层，真正缺口是 AI 记录侧持久化 `messageKey`，`evidenceText` 作历史兜底；② CustomerEvent（P0-3）AI 节流必须复用 `insightService` 12h 机制；③ 自动扫描循环已存在（runFullScan + lazyScan + 每日全量 + 增量），真正缺的是**行动结果回流**（Agent Action → Outcome → Re-evaluation）。北极星升级为「有效销售行动」六段漏斗（发现→生成→采纳→执行→响应），先埋点后看板。§10 待办已按 P0 路线核销/合并/新增。**P0-1 第一刀已提交**：`intent_tag_log` 加 `message_key`/`evidence_text` 两列（幂等 ALTER），透传链路落地（classifier/intentService/actionEngine/insightService urge），`follow_up_task` 用 `source_message_id` 存 messageKey；`funnel-test` 增 9 条 P0-1 证据断言；运行时三件事验证通过（① 新日志带 message_key ✓ ② message_key 回查命中原消息 ✓ ③ evidence_text 为原话非 AI 结论 ✓）。**P0-2B Evidence Resolver 两刀已提交**（`04dbaec` messageKey 构造集中 + `21fd148` 统一读入口 getEvidenceByKey，历史裸 ID 兼容只读、不迁移、不新增 WCDB 读取层，45 断言，见 §2.27）。**P0-2C AI Judgment Persistence 盘点定稿**（`docs/P0-2C-AI-Judgment-Persistence-盘点.md`，纯只读：四字段 summary/opportunity/risk/nextAction 无持久化、`crm_risk.source_msg` 空列、AI 判断无证据锚点；设计=append-only 判断历史 + 当前投影，证据统一走 P0-2B，禁 stage 双真源）。**P0-2C.1 已提交**（`07241f4` customer_judgment 基础设施：shared 类型 + 表 + 5 方法 + 禁 stage 硬门禁 CHECK，40 断言，见 §2.28）。**P0-2C.3 已提交**（`057f8aa` action analysis 统一落库：`generateActionAnalysis` 三调用点——预热 salesActionEngine / suggest main.ts / 客户 360 crmIpcHandlers——把 opportunity/riskSignal/nextMove 统一持久化到 customer_judgment，替代「预热写 analysis JSON + on-demand 丢弃」；证据=关联任务 source_message_id（P0-1 锚点）→ extractEvidence 兜底，无可靠 key 不伪造；suggest=manual 跳过去重 / 预热+360=ai 24h 按类型去重；basis 输入快照；不碰 follow_up_task.analysis 旧链路（三层真源分离），37 断言，见 §2.28）。**P0-2C.2 已提交**（`fc654b2` summary 落库：只接 generateInsightForSession，落库前绑定证据（复用 extractEvidence/toMessageSnippets，客户最近一条实质消息；无可靠 messageKey → evidence unavailable 不伪造），append-only + hasRecentJudgment 持久化去重（非手动沿用 24h 窗口，手动保留覆盖权利），保留现场生成路径不改 UI/prompt，insight_record 与 customer_judgment(summary) 两表不合并不取代，33 断言，见 §2.28）。**P0-3 第一刀已提交**（`7950ca6` `getCustomerCurrentView()` 只读组装层 + 独立 IPC `sales:customer:currentView`，30 断言，见 §2.30；只做投影不做判断——analysis JSON 不并入 / 无判断不现场调 LLM；Latest 与 Fresh 并存；UI 未迁移）。**P0-3.2 已提交**（`9a375b3` Customer 360 判断卡迁移：`crm:customer:profile` 删除现场 `generateActionAnalysis`（不再打开档案调 LLM）、删除 customer_360 生产者调用，改返回 `getCustomerCurrentView` 只读投影；UI advice 五字段卡 → `currentView.judgments` 四卡（总结/机会/风险/下一步）+ 空态不补生成 + stale 标「较旧」+ 证据点击走 `sales:evidence:getByKey` 回查原话；护栏测试 13/13，见 §2.31）。**P0-3.3 已提交**（`14eaa07` SalesContextStrip 迁移：展开面板新增 AI 当前判断四卡消费 `sales:customer:currentView`（与 360 同语义：空态不补/stale 标较旧/证据点击回查 P0-2B）；**suggest 主动生成保留**（用户主动触发不属"打开页面自动生成"）——修复断链 `item` 补 `sessionId`（缺失 → persist invalid_input 跳过，suggest 落库从未生效），并验证闭环：生成成功 → customer_judgment append → **立即重读 currentView → UI 显示新判断**（主动分析与 Current View 不形成两套真源）；护栏测试 10/10，见 §2.32）。**P0-3.4 已提交**（`03d994d` 今日行动卡判断展示消费 currentView：`getUnifiedSignals` 组装 signal 时主进程同步投影 `judgments`（虚拟卡 todo:/logi: 查无客户 → null）；store 删除 analysis JSON `Object.assign` 合并（历史快照不再进卡冒充当前判断），`fetchSuggestion` 成功后重读 currentView（生成 → 落库 → 重读 → 显示闭环在列表页成立）；AIActionCard 折叠面板改 judgments 四卡 + 较旧/人工徽标 + 证据点击回查（与 360/状态条同语义），话术 suggestion 保留；InsightInboxPage 保持历史收件箱语义未改（insight_record 继续存在不冒充当前判断）；护栏测试 14/14，见 §2.33）。**P0-3 收口已 CLOSED**（全仓静态护栏 6/6 + 真实库运行态验收通过，验收文档 `docs/P0-3-收口-契约验收.md`，见 §2.34）；**P0-3 E3 CustomerEvent 已拍板并启动**（用户拍板 = 建通用 customer_event 表 / quote_signal 分流不迁 / 四消费者全部不迁 / 硬门禁防万能日志表；第一刀只读盘点 `docs/P0-3E3-CustomerEvent-盘点.md` + Scope Lock 设计 `docs/P0-3E3-CustomerEvent.md`，见 §2.35）。**P0-3 E3.1 已提交**（CustomerEvent 基础设施：shared 类型 + customer_event 表（CHECK 五类型 + message_key 幂等）+ 三个原语 + 16 断言，见 §2.35）。**P0-3 E3.2 已提交**（最小生产者接入：crmParseService 报价/回复双写 quote_asked + customer_replied，写失败不阻断原链，14 断言，见 §2.35）。**P0-3 E3.3 已提交**（销售行动事件：recordUserActionEvent 白名单 + completeAction before 状态检查幂等写 follow_up_done + IPC sales:action:recordEvent + AIActionCard 成功点上报 chat_opened/script_copied，15 断言，见 §2.35；**E3 三刀齐，先 E3 收口 + 真实库运行态验证，再进入 P0-4 Action Funnel**）。**E3 收口已 CLOSED**（`d97f663` 护栏 16/16 + 验收文档，见 §2.35）。**P0-4.1 Action Funnel 盘点已提交**（零编码只读刀：`docs/P0-4-Action-Funnel-盘点.md`——真实六段漏斗 / 每段唯一事实来源 / correlation key 现状（task_id 缺失但补丁成本极低）/ 硬边界不新增第二套 Action Log，见 §2.36）。**P0-4.2.1 correlation 补齐已提交**（用户拍板三刀之一：customer_event 加 `task_id INTEGER NULL`（不改 event_type CHECK，幂等 ALTER 兼容旧库升级）；三行动写点全带 task_id——follow_up_done=completeAction 直写 before.id / script_copied+chat_opened=前端卡片 sources[].rawTaskId 经 IPC 透传（IPC typeof number 才传）；无任务上下文允许 NULL 禁止伪造——**task_id 是 correlation key，不是事件合法性的前置条件**；测试 20/20 + 真实库只读验收 7/7，见 §2.36）。**P0-4.2.2 getActionFunnel 只读组装层已提交**（用户拍板三刀之二：`getActionFunnel(days?, now?)` Task-level read model——六段 Task-level 去重 / sources 逐段事实来源 / 分母 0 → rate null / superseded 不重复计 + supersededCount / 时序守卫 / days 只过滤 created / **零 LLM 零 judgment 消费**；新原语 `tasksCreatedSince(ms)`；测试 19/19 + closed-gate A2 更新 + 真实库只读验收 5/5，见 §2.36）。**P0-4.2.3 收口护栏 + 真实库验收已提交**（用户拍板三刀之三：静态护栏 8 项——导入白名单 / 零写方法 / 事件白名单不膨胀 / sources 不变量 / divRate 守卫 / tasksCreatedSince 唯一消费者 / 无第二套 action log / task_id 非空写点仅 E3.3；真实库运行态 7 项——created 口径闭合 1217+1601=2818 / won=26 / 窗口结构不变量 / executed+responded+progressed 0 样本属部署时序；验收文档 `docs/P0-4.2-收口-契约验收.md`；**P0-4.2 三刀齐 CLOSED**，见 §2.36）；**P0-4.3 UI/KPI 消费已提交**（五段漏斗 + 6 KPI + 点击下钻可追溯，breakdown 与聚合共享判定行，25/25；**P0-4 CLOSED**，见 §2.37）；**P0-4 之后不马上 P0-5——进入真实运行观察期**：看 created/executed/responded/progressed/won 每段掉多少，4 场景诊断（A 执行高响应低 → Action Quality / B 执行低 → Action UX / C 响应高推进低 → Sales Process / D 全好 → Scale），找最大漏损点再决定 P0-5A/B/C；**Summary 覆盖率观察项**：真实库 summary=0 先不修，观察随正常见解链是否自然增长，仍 0 则开 P0-4.x Summary Production Coverage 小任务）。
>
> **2026-08-24 增量（UI 美化地基，观察期 UI 例外 #2，用户拍板）**：功能线（跟单中心到款认领）先独立提交 `b4f6252` 隔离后，UI 线做地基不扩页面——① `src/styles/main.scss` 前进视觉 tokens 立 light/dark 双套（表面/文本/线条/品牌 alias/语义/滚动条/圆角/阴影/字体），品牌 alias `--color-accent: var(--primary)` 定义一次、8 套旧主题 × 双模式自动继承；② 品牌色拍板 Apple 蓝 `#0071E3`（dark `#0A84FF`），回绿只改主题层；③ 旧主题保留但只经 token 映射，不做独立视觉；④ 漏斗色板散调收口 `shared/funnelPalette.ts` 单一真源（两漏斗页 tsx 改导入，纯视觉）；⑤ 已打磨页（Sidebar/App/两漏斗 scss）硬编码 hex 清零、暗色自动可用；⑥ 1 页规范 `docs/DESIGN-SPEC-MINI.md`（五条红线：不改业务逻辑/不新增第三套 token/不硬编码品牌色/light+dark 双验/不改交互结构与行动任务可见性——观察期指标归因不受污染）。暗色灰阶与旧页面同坡（#171717/#212121/#2F2F2F/#383838）无接缝。波次：W1 地基（本次）→ W2 Chrome → W3 高频页 → W4 低频页。
> **2026-08-24 增量（W1 双模式验收 PASS）**：2 页 × 2 模式四张 CDP 截图全过——销售漏斗 light/dark + 行动漏斗 light/dark（app 跟随系统外观，OS 切暗/切亮各截一轮）：暗色灰阶与旧页面同坡无接缝、无白底残留/对比度崩坏；行动漏斗色板已升级 Apple 蓝渐变族（旧 tailwind 蓝零残留）；亮色白卡 + 浅灰画布、蓝色分段选中。护栏 payments-claim-test 18/18、`npx tsc --noEmit` 零错误。W1 地基验收闭环，待进入 W2。
> **2026-08-24 增量**：**P0-4 全链路 CLOSED**（用户拍板 P0-4.3 只做三件事：① 五段直观漏斗——行动产生→销售执行→客户响应→有效推进→成交，曝光显示「N/A · 当前未埋点」不为好看硬算曝光率；② KPI 只放有意义的——行动数/执行率/客户响应率/执行→响应转化率★（北极星，第一个回答「销售做了动作以后客户有没有反应」的指标）/响应→推进转化率/成交数；③ 点击可解释——执行/响应率点击下钻到事件类型计数 + 最近任务样本，数字可追溯到事件）。P0-4.3 实现：`getActionFunnelBreakdown` 只读下钻原语 + `collectTaskRows` 共享判定行（getActionFunnel 与 breakdown 口径严格一致）+ 双 IPC + ActionFunnelPage（五段 ECharts 漏斗 + 6 KPI + 下钻弹层 + 口径脚注），25/25 测试。**P0-4 之后不马上 P0-5——进入真实运行观察期**：看 created/executed/responded/progressed/won 每段掉多少 + 4 场景诊断（A 执行高响应低 → Action Quality / B 执行低 → Action UX / C 响应高推进低 → Sales Process / D 全好 → Scale），找最大漏损点再决定 P0-5A/B/C；**Summary 覆盖率观察项**：真实库 summary=0（18 条 judgment 全是 opportunity/risk/next_action）先不修，观察是否随正常见解链自然增长，仍 0 则单独开 P0-4.x Summary Production Coverage 小任务（不动 P0-2C）。**P0-4.4 双漏斗 UI 统一视觉体系已提交**（`e0736b3`：两漏斗窗口统一 7/30/90/全部 四档（行动默认 7、销售默认 30）+ 蓝系渐变配色（浅蓝→藏青，流失灰）+ 行动漏斗 ECharts 换 HTML/CSS 自绘梯形（段间箭头 + 段内转化率 + 推进/成交映射 Info tooltip + 每段可点击下钻）+ 销售漏斗 rich label 双行转化率 + 点击态；纯 UI 改造，未动口径/事件/判断/推荐逻辑，见 §2.38）。**P0-4.4 打磨修正已提交**（`828b6bb` + `a21fc2e`：梯形固定比例收窄不绑数值（跳级/转化率>100% 形状不变）+ svg path 圆角渐变（clip-path 无法圆角）+ 段间主题蓝小三角箭头（行动漏斗=过程链路 vs 销售漏斗=状态分布）+ 推进/成交映射 Info tooltip + 数字层级（主数字 26px/16px 纯白 vs 转化率 70% 白）+ 卡片阴影/间距；跳级高亮验收后删除——两漏斗转化率 >100% 均不特殊处理；见 §2.38）。**无名 session 边界修复已落地并提交**（`76bf709` fix(gate): unnamed-session immunity）——观察期防污染（A1 清理 3 条污染后上保险，属冻结清单「埋点/数据完整性 Bug」唯一例外）：① crmParseService E3.2 双写 quote_asked/customer_replied 加 accountId 门控（无名 session=displayName/alias/contact 均未匹配到 CRM 联系人，不写 customer_event；quote_signal 业务真源不受门控影响）；② insightService 沉默扫描 + blacklist 活跃分析跳过无客户档案会话（customerGetBySession 判定，见解链只服务已识别客户；whitelist 显式配置不受影响）；③ 测试：customer-event-producer 15/15（A9 门控护栏）+ insight-unnamed-session 5/5 新增，closed-gate B11 更新为「0 行基线」（表已存在，A1 后归零）；④ 行为前提：修复落地前不在无联系人会话聊天（用户承诺）。**2026-08-24 验证期修复：isSessionIdLike 模块函数不走 this 已提交**（`3666f3e`，观察期数据完整性例外——活跃分析整链 TypeError）——`insightService.ts` 3 处 `this.isSessionIdLike(...)` 实为 `shared/wechatId` 模块级函数，运行时 TypeError `this.isSessionIdLike is not a function` 致白名单会话活跃分析全部失败（日志 18:39 起连续报错，见解链静默断供——非门控在拦，是整链抛错）；修复为直接调用 `isSessionIdLike(...)`，node tsc TS2339 清零（159 条既有基线不动），编译产物重建（`npx vite build`，dist-electron/main.js 内联 0 处 `this.zl(`），insight-unnamed-session 5/5→6/6 加护栏（防 this. 前缀回归）；教训：`npx tsc --noEmit` 只查 root（src/shared），node tsconfig 的 TS2339 被基线容忍——electron/ 编译错误必须靠 `npx tsc -p tsconfig.node.json --noEmit` 单独 grep 新错。**跟单中心认领模式改造（未提交）**：用户拍板「不设计 AI 判断」——跟单中心去掉自动确认区（前端 autoSummary/runAutoConfirm/undoAutoConfirm 引用清零，后端函数保留不调度）；到款区重做为「每日到款清单」（近 30 天按 pay_time 天分组，今天/昨天标签 + 当日合计）+ 销售手动认领（选客户或新客户名建档 + 选合同 + 销售名）+ 认领后显示开票状态（订单群 PDF 发票解析 → invoice.status='issued' 即「已开票」+ 发票号）；真实库盘点发现旧 AutoConfirm 遗留 35 行 confirmed 但未挂客户/合同（仅公司名）——前端标「旧自动认领遗留 · 请补认领」，claimPayment 支持对这类行补挂；新后端 `paymentsByDay(days)`（四轴 LEFT JOIN：allocation/account/contract/invoice 子查询非作废最近一张）+ `claimPayment(id, patch)`（approvePayment 兜底建归属 / 已认领拒绝 / 旧数据补挂 / confirmAllocation 到客户合同）+ IPC `crm:payments:byDay` / `crm:payment:claim`（preload/electron.d.ts 桥接）；测试 `scripts/payments-claim-test.ts` **9/9**（静态 5 + 真实库只读 4：四轴 JOIN / 三步闭环 / 前端零 AI / 每日三要素 / 桥接齐全 + 近 30 天 61 笔分布快照）；tsc root 0 / node 无新增（6 条既有基线不动）。**构建劫持 + 误删坑（已踩）**：electron/** 下 tsc 编译产物（`*.js`/`*.d.ts`，gitignore）会劫持 vite 构建——vite resolve.extensions 优先 `.js`，dev/build 全部读取旧编译代码，`npm run dev`/`vite build` 均不反映 electron/ 源码改动，现象是「No handler registered for 'crm:payments:byDay'」；修复必须先删产物：`find electron -name "*.js" -delete; find electron -name "*.d.ts" -delete`，**但删除前必须 `git ls-files electron | grep -E '\.(js|d\.ts)$'` 对照白名单**——本次误删了 5 个 git-tracked 真实文件（`sql-js.d.ts`（sql.js 声明，删了即 TS7016 回归）、`nodert.d.ts`、`types/sherpa-onnx-node.d.ts`、`types/whisper-node.d.ts`、`assets/wasm/wasm_video_decode.js`），已 `git checkout --` 恢复；node gate 的 TS7016 排查时不要新建 shared 声明，仓库已有 `electron/sql-js.d.ts`。**每日到款折叠 + 只看未认领（2026-08-24 用户拍板）**：页面太长——每日分组默认只展开今天，昨天及更早折叠成 header（日期 + 笔数 + 合计 + 未认领数红字），点 header 展开/收起（collapsedDays/expandedDays 双 Set + toggleDay）；「只看未认领」筛选按钮（onlyUnclaimed 过滤 isClaimable 行，开启时强制全展开）；财付通（企业微信收款码收单方，近 30 天 23 笔 7.27 万占三成）判定为对账项必须留账（钱不消失），但付款方永远无客户名（收单方吞名）、0 笔开票（发票 PDF 按客户名匹配天然断链）——不单列不弱化，靠折叠自然收敛；payments-claim-test 9/9→10/10。**认领表单瘦身（2026-08-24 用户拍板）**：① 认领销售输入框去掉——认领自动带当前登录账户显示名（新 IPC `crm:currentSalesName`：config myWxid → `wcdbService.getDisplayNames([myWxid])` 微信真实备注，取不到回退空不阻塞认领；历史遗留 94 条 sales_name 是裸 wxid 的旧数据不迁移）；② 客户选择改**输入客户名**（用户拍板，2026-08-24 再改）：原生 select 与「新客户名」输入框合并为一个客户名输入框（`CustomerPicker`，常驻 input + 输入即联想已有客户 + 点候选认领到该客户 + 无匹配提示「直接认领将新建」+ 认领时 `customerIdOf` 精确匹配、匹配不到 `accountEnsure(name)` 建档兜底——claimAccount/claimNewName/logiAccount/logiNewName 四 state 合并为 claimCustomer/logiCustomer 两文本 state），物流认领 + 每日到款认领两处共用；payments-claim-test 10/10→12/12（A7 零手动销售输入 + 客户名输入建档兜底、A8 currentSalesName 桥接）。**销售名与到账口径修正（2026-08-24 用户澄清「认领款项不一定是一个人的」）**：① 认领销售输入框回归——不填=默认本人（mySalesName 兜底），填了=记到该人（许丽娟/李林辉/杨青等多销售共用）；② 合同工作台「本月已确认到款」¥583,416 是旧 AutoConfirm 遗留假数——143 条 confirmed 全部无客户/合同（pay_time 5/16-8/24 横跨四月），`statsOverview.monthPaid`/`paidWeekly` 改为 `account_id IS NOT NULL` 过滤（只算人工认领），修正后显示本月真实人工认领额；payments-claim-test 12/12→13/13（A7 改默认本人可改 + A9 到账口径护栏）。**已确认到款罗列（2026-08-24 用户拍板「确认收到款项也得罗列出来」）**：每日到款清单下新增「已确认到款」区——把已认领且挂上客户/合同（confirmed + account_id/contract_id 非空）的到款集中罗列（付款方/金额/客户/合同/销售/开票状态/到账时间），与每日流水分开、不受折叠影响；数据复用 paymentsByDay 返回字段零新后端；payments-claim-test 13/13→14/14（A10 claimedPayments 过滤 + 罗列展示护栏）。**物流跟单按天分组（2026-08-24 用户拍板「物流跟踪可以和每日到款一样设计」）**：待认领 / 已认领待签收 / 已签收 三队列全部改按天分组（`LogiDayGroups` 模块级组件，按 latest_update_at 天分组，今天/昨天标签，默认只展开今天，header 日期 · 笔数点开/收起，各队列折叠状态独立互不干扰；dayKeyOf/dayLabelOf 提为模块级，每日到款与物流共用）；分页/空态/认领表单/签收按钮均保留；payments-claim-test 14/14→15/15（A11 三队列按天 + 今天默认展开护栏）。**销售团队下拉（2026-08-24 用户拍板「加个销售人员选项」，选了可管理方案）**：header「立即扫描群消息」旁新增「销售团队（N）」下拉——名单 = 真实库 allocation.sales_name 去重（非空非 wxid 裸号）+ 当前登录账户显示名，每人附单数/金额；点成员 = 设为认领默认销售（mySalesName 联动，认领表单默认值跟随）；底部可添加新销售、移除离职（丁帅已离职）；管理持久化走 config 两个新 key `salesTeamAdded`/`salesTeamRemoved`（ConfigSchema + defaults，重新添加即撤销离职）；真实库盘点：历史 4 个 wxid 裸号（94 条 36 万，其中 1 个是当前账户）+ 4 个人名词条（杨青 5/1.1万·李林辉 21/11万·许丽娟 21/5.7万·丁帅 1/2千已离职）→ 在职 3 人；新 IPC `crm:sales:team` / `crm:sales:team:add` / `crm:sales:team:remove`（resolveMySalesName 抽出与 currentSalesName 复用）；payments-claim-test 15/15→16/16（A12 名单过滤 + 管理 + 前端下拉联动护栏）。**拆单金额口径修复（2026-08-24 用户问「金额对不对」）**：真实库核账发现本月 20 笔已确认到款全部是「拆单认领」——银行聚合流水（财付通收单，amount_net 如 ¥12,524.90）被解析器从群消息拆成每客户实际付款 hint（5,100/3,150/1,900/2,400，20/20 hint==credited），统计卡口径 SUM(credited_amount)=¥47,310 正确，但跟单中心每日清单/已确认区显示 amount_net（聚合总额）——同一笔被 N 客户认领时重复显示全款，合计 ¥161,456 虚高 3.4 倍；修复：paymentsByDay SQL 补返回 `al.credited_amount`，前端新增 `shownAmountOf = credited_amount ?? amount_net`（拆单显示实际付款额，未认领/无拆单回退聚合额），每日分组合计/认领提示/已确认区五处统一换口径，与统计卡同源一致；另查实：本月 18 个认领客户全部 0 合同（全库 1 份）→ 合同回款统计空转是业务数据缺口非代码 bug；invoice 表 0 条 → 发票解析待观察；payments-claim-test 16/16→17/17（A13 拆单口径护栏）。**到账统计改按到款日口径（2026-08-24 用户拍板「改按到款日」）**：核账发现 20 笔本月确认 ¥47,310 中只有 5 笔（¥8,980）是 8 月真实到款——其余 15 笔（¥38,330）是 5-7 月历史到款（8/24 集中补扫入库 + 集中认领，confirmed_at 全是 8/24），「本月已确认到款」按认领时间归类虚高；修复：`statsOverview.monthPaid`/`paidWeekly` JOIN payment_record 改按 **pay_time**（到款日）归类（pay_time >= 月初 / 周窗口），前端卡片文案改「本月到账（已认领）」；payments-claim-test 17/17→18/18（A9 改 pay_time JOIN 断言 + B14 真实库验证到款日口径 ≤ 认领时间口径）。**跟单中心改 7 天一页（2026-08-24 用户拍板「七天一页，物流和款项认领」，澄清后重做）**：一页 = **7 个自然日**（第 0 页 = 今天往前 6 天，如「8/18 ~ 8/24」，跨窗口翻页上限 = 最老一条所在页），页内**每天一个折叠行**（默认折叠，header 显示日期（今天/昨天标签）· 笔数 · 合计 · 未认领数红字，点击展开当天明细；页内倒序展示，最新/今天在最上）；款项认领 + 物流三队列（待认领/待签收/已签收）统一走模块级组件 `WeekDayGroups`（按天分组 + 翻页 + 展开态独立）；翻页控件 = 上一页/下一页 + 「8/18 ~ 8/24 · 第 n / m 页」；「只看未认领」筛选强制全展开（forceOpen）；删除旧的物流 10 条分页（LogiPager/slicePage/logiPage/pendingPage/signedPage 及已签收整区开关 showSignedLogi 全部移除）；纯前端改动，测试 18/18（A6/A11 断言改一页七天 + 每天折叠 + 翻页护栏）。**SearchTable 表格骨架 + 合同列表试点（2026-08-25，未提交）**：借鉴 Arco Design Pro search-table（调研 5 个 admin 模板后唯一 React 栈匹配者，MIT，不搬代码只取模式）——受控组件 `src/components/crm/SearchTable.tsx`（WeFlow 无 axios 层，数据来自 IPC，故数据/分页由调用方持有）：props = columns（key/title/render/className/width）+ data + rowKey + page/onPageChange + pageSize=10 + total?（默认 data.length，后端分页可显式传）+ loading? + filterBar?/toolbar?（ReactNode 左右分布）+ onRowClick? + rowClassName? + emptyText?；内置 Pager（上一页/下一页 + 「第 n / m 页 · 共 N 条」，total ≤ pageSize 隐藏）+ 前端分页切片；合同工作台 `CrmWorkbenchPage` 试点：状态筛选下拉 + 合同名搜索（变更自动 setPage(1)）+ 7 列（合同/金额/已确认回款/全款进度条/状态/预警/操作）+ 行点击选中联动 + selected 高亮保留；crm-workbench-test 48/48→**50/50**（0a 工作台引入 + 筛选栏/分页/行点击、0b 骨架要素 + 前端切片 + 空态文案护栏）；tsc root 0。
> **2026-08-27 增量（工作区未提交，见 §2.39）**：线索模块「群资源扫描」上线（手动触发，8,912 条真实消息回放漏配 0，用户已在应用内正式扫描 **4,680 条**入库，归属分布 秒变1513/李林辉1355/杨青981/静候653/未分配178）+ 线索页归属筛选 chips + 商机识别三修复（手机号不当金额 / 无产品信号重复建商机 / 亿级金额格式化，Windows 打包版需重构建生效）。
> **2026-08-28/29 增量**：Mac live 库商机脏金额修复（opportunity id=10 的 ¥152 亿 = 手机号 15202635273 落库于修复前，清零 + 备份 `crm-backups/weflow-crm-before-opp-amount-fix-2026-08-28T17-28-50.db`）；**Windows x64 安装包已重打（2026-08-29 21:36 含 §2.40 分库）**（`release/WeFlow-1.0.0-Setup.exe` 142M，asar 探针验证：main.js 带 `weflow-crm-` 命名/迁移与切换日志串/`chat:archiveBusinessData` IPC/reopenForWxid + preload 桥接 + SettingsPage「归档当前账号业务数据」按钮 + koffi win32 3.1.0 一致；8/28 旧包**无分库**已覆盖）——Windows 侧还欠：**装新包（装完首次启动自动把 legacy 库归到当时 myWxid=amthi66 名下 → 设置→数据库→「归档当前账号业务数据」点一次得干净新库）+ 跑商机修复 SQL**；**§2.40 微信号分库已实施（2026-08-29，Mac live 迁移验证通过，工作区未提交，见 §2.40 实施记录）**。**§2.41 报表 & CRM 七页 UI 美化 + 线索归属管理已实施（2026-08-29~30 设计稿拍板后八轮落地，含默认主题棕金→Apple 蓝根因修复、限宽 1280 居中、线索归属管理功能，工作区未提交，冷启动交接见 §2.41）**。
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
- **Electron 闪退真因修正**：旧判断"dist 是 Node wrapper 混入的坏 Electron v24"是**误判**；真因是 `ELECTRON_RUN_AS_NODE=1` 环境变量让 Electron 以 Node 模式启动（`--version` 输出 v24.17.0）。防御已落地 `vite.config.ts`（spawn 前 `delete`），详见 `docs/HANDOVER-20260731…md` §四 修正版
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
- **商机闭环**（crmDbService）：`opportunityUpsertBySignal` 同客户同产品 active 机会累积（数量/金额/详情），否则新建（name=`<产品>采购`，stage=「了解」，事件留痕）；`opportunityUpdateStage`/`opportunityClose`（won/lost 关单 + 事件）；`syncOpportunityStageByAccount` 客户阶段顺推（了解→比价→决策），成交→won、流失→lost 自动关单；`opportunityStats` 漏斗聚合（stageDist/total/totalAmount，仅 active）；`opportunityList` JOIN 客户名
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

## 2.26 AI 销售副驾驶：产品/开发主线（2026-08-23，规划定稿）

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

- **P0-1 E4 证据链 UI**：数据层已备（§2.18 `sourceId/messageKey` 溯源）。做：点击 AI 判断 → 展开客户原话。**读取路径（2026-08-23 实证 + 用户定标）**：微信消息读取统一走**应用读取层 `chatService`**（主进程内 `decryptKey` 解密 WCDB，只读 + 游标分页；本产品核心能力，所有功能共用）；项目自身 HTTP API `/api/v1/messages`（返回 `localId/serverId/createTime/parsedContent`）**是同一读取层的 HTTP 封装**（`127.0.0.1` + `access_token` 鉴权），**不是独立数据源**——不存在"走 API = 不碰微信库"的路径。证据回查 = `messageKey → 应用读取层 → 原消息/上下文`。**第一刀（2026-08-23 已实现并提交，P0-1）**：AI 记录侧持久化 `messageKey` + `evidenceText`（`intent_tag_log` 加 2 列，幂等 ALTER，历史数据不动）；透传链路 = `onNewMessage → chatService.getLatestMessages → toMessageSnippets（保留 messageKey）→ salesStageClassifier → intent_tag_log`、`salesIntentService.analyzeIntent → chatService.getMessages → intent_tag_log`、`follow_up_task.source_message_id`（R3 / urge_customer）。证据约束：`evidence_text` 只存判断依据关键句（客户原话/转述，≤200 字），**不存 AI reason/结论、不存聊天摘要**。保持不动：insightService 聚合扫描 / crmLeadService / message_analysis。运行时验证三件事已通过（① 新日志带 message_key ✓ ② message_key 回查命中原消息 ✓ ③ evidence_text 为原话非 AI 结论 ✓）→ 进入 P0-2
- **P0-2 客户「AI 当前判断」**：把已有字段 + 意向评分 + 时间线聚合成「AI 对客户当前状态的解释」卡（高意向/决策期 + 最近变化 + 当前机会 + 当前风险 + 下一步 + 查看证据）。重点是**理解层**，不是加字段。**2026-08-23 数据契约盘点完成**（`docs/P0-2-数据契约盘点.md`，纯只读）：现有数据能稳定生成约 60%，三处硬伤——① Stage 无单一真源（6 写者中英混存、customer_profile/account.sales_stage/opportunity.stage 三口径零同步）② 证据链断点（insight 扫描路径不带 messageKey、source_message_id 双格式、无统一 resolver）③ AI 结论不持久化（summary/opportunity/risk/nextMove 现场生成不落库）。**据此 P0-2 拆为三刀 + UI**：P0-2A Canonical State（**设计已定稿**，`docs/P0-2A-Canonical-State-设计.md`：canonical stage 6 值 new/contacted/quoted/negotiating/won/lost + activityState active/dormant 拆 dormant + unknown 异常位；写者资格定稿 classifier/salesIntentService/manual/deal rule ✅ 保留、insightService ❌ 禁写 stage 降 signal（**暂不引入"高置信+阶段推进→覆盖"规则**，避免重新引入 stage 仲裁）、generic upsert ❌ 移除 stage 资格、dormant rule ❌ 不写 stage 改写 activityState；intentScore 定位综合意向分不重做算法，只修两 bug——`STAGE_BASE` 改 canonical 键 + 输入过 `normalizeStage()`、lastContactAt 秒→毫秒；**六刀已全部提交**：`6bf1ff6` intentScore 两 bug / `a3f3479` canonical read model / `308d5d9` action rules 阶段口径归一 / `53ee94b` insightService 禁写 stage 降 signal / `2933a2d` generic upsert 移除 stage 资格（IPC 运行时剥离 + 类型层删除双保险，tags/notes 仍更新、stage 保持原值） / `3ff3f1f` manual/deal rule 写者元数据收口（manual 校验值合法性 + changedAt；deal rule 补写 intent_tag_log + changedAt；写路径抽 legalStageWriters 不依赖 Electron）；P0-2B Evidence Resolver **已提交**（两刀 `04dbaec` + `21fd148`，见 §2.27）→ P0-2C AI Judgment Persistence（summary/opportunity/risk/nextAction 改为 事件→AI 判断→结构化结果→持久化→证据；不再打开档案现场调 LLM。**三刀已全部提交**：`07241f4` P0-2C.1 基础设施 + `fc654b2` P0-2C.2 summary 落库 + `057f8aa` P0-2C.3 action analysis 统一落库，见 §2.28；**P0-2 已收口 CLOSED**（见 §2.29）→ P0-3 Current Judgment Consumer Layer（`getCustomerCurrentView()` 组装三真源，UI 只消费该视图）→ P0-2 UI（最后一层呈现）。**边界**：P0-4 行动埋点（chat_opened/script_copied）不混入 P0-2；不建 AI Current Judgment schema、不动 UI；P0-2A 不膨胀成 CRM 状态机重构
- **P0-3 E3 CustomerEvent**：**扩展 `intent_tag_log`，不是重写**。最小模型 `{event_type, summary, messageKey, source, created_at}`。动手前先评估 **4 个现有消费者**：漏斗 / 意向评分 / 周报 / 今日行动
- **P0-4 Action 埋点**：**新增 3 个**——`script_copied`（采纳代理）/ `chat_opened`（执行准备）/ `customer_replied`（行动结果）。已有：`intent_tag_log` / `follow_up_task.created_at` / `follow_up_task.status`。最终形成：发现 → 行动生成 → 销售执行 → 客户响应
- **P0-5 L0-L3 文档**：只文档化，**不做权限系统**；顺手把 R1-R6 当前阈值整理成现状表

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

> 权威文档：`docs/P0-2-收口-契约验收.md`。A=State · B=Evidence · C=Judgment 三块基础设施封板；**P0-2 CLOSED**。下一阶段不再修改底层真源，进入 **P0-3 Current Judgment Consumer Layer**。

- **① 静态契约验收**（代码级，全绿）：A 无第二 stage 真源（4 合法写者 + import 投影列不碰 canonical / insight 禁写 / upsert 剥离 / CHECK 双拦截）；B 无裸 key 新写点（messageKey 唯一构造点 shared/messageKey.ts，无散落拼串）；C 四字段无现场生成不落库路径（summary 单入口 generateInsightForSession / 三判断单生产者 generateActionAnalysis 三调用点全落库 / UI 无 customer_judgment 直读）。**无重新出现的第二套真源。**
- **② 真实 DB 只读盘点 + 运行时验证**（脚本 `scripts/p0-2-real-db-audit.ts`，sql.js 内存加载纯只读）：**200 客户**，canonical stage 分布 contacted=76/quoted=67/won=26/lost=21/negotiating=9/**unknown=1**（六档齐全，存量脏值几乎清零）；intent_tag_log 1131 条，P0-1 透传真实生效（evidence=客户原话）；**应用以 P0-2C+ 代码重启后 → P0-2 runtime CLOSED**：`customer_judgment` 自动建表 + CHECK 硬门禁生效，**18 条判断真实产出**（6 客户 × opportunity/risk/next_action，source=ai，model 溯源，basis 含 taskId），evidence 100% 带 key 且 **6/6 P0-2B 可解析**、evidence_text=客户原话，去重 0 冲突 0 orphan；summary 0 条待见解链触发时机（非缺陷）；判断覆盖 6/200=预热高/紧急任务池，与设计一致。观察项：follow_up_task 新任务锚点仍 0（归 P0-4）；evidence 存在 `[视频]` 样本（P0-3 设计时图片/视频视为非文本证据）。
- **③ 架构护栏封死**（8 条 ❌ 条款，见收口文档 §③）：upsert 禁写 stage / insight 禁抢 stage / 禁 customer_judgment.stage / 判断必须能回答"为什么"（无 key 标 unavailable 不伪造）/ judgment append-only 不 UPDATE / 禁再造 messageKey / UI 禁直读 stage 与现场 LLM / 三层真源互不冒充。新代码不得违反。
- **观察（非本范围，记录不修复）**：`follow_up_task.source_message_id` 今日 0/15（P0-1 锚点写点在任务触发路径未实际生效；C.3 证据解析器已有兜底不影响判断链）→ 建议归入 P0-4 Action 埋点治理。
- **下一刀**：**P0-3 Current Judgment Consumer Layer**（盘点完成 `docs/P0-3-Current-Judgment-Consumer-盘点.md`：消费者清单——360 现场 advice / SalesContextStrip suggest / 今日行动 analysis JSON / 收件箱 JSON 文件四处分裂数据形态；**Current ≠ Latest** 语义设计——每类型最新一条 + freshness(24h 窗口)/evidenceStatus/source 三维派生，投影不做推理；API 契约草案 `getCustomerCurrentView()`；**5 项已拍板**（2026-08-23 用户拍板：freshness=24h / 空态不补生成 / evidence 卡片显示"有据可查"点击回查 / 独立 IPC `sales:customer:currentView` / summary 空态接受；铁则：只投影不推理 + Latest 与 Fresh 并存）。**第一刀已提交**（`7950ca6` 只读组装层 + 独立 IPC + 30 断言，见 §2.30），**下一动作 = P0-2 UI 迁移**（判断卡消费 currentView，放在验证通过之后）。

## 2.30 P0-3 Current Judgment Consumer Layer：第一刀 只读组装层（2026-08-23）

> 权威文档：`docs/P0-3-Current-Judgment-Consumer-盘点.md`。消费者盘点 + 5 项拍板（用户 2026-08-23 拍板）→ 第一刀 `7950ca6`：只做 `getCustomerCurrentView()` 只读组装层 + 独立 IPC + 测试，**不动任何 UI**。

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
- **P0-3 收口已 CLOSED**（见 §2.34）：`scripts/p0-3-closed-gate.ts` 全仓静态护栏 6/6（src/ 137 文件，历史载体零冒充）+ 真实库运行态（customer_judgment 18 行 / 6 客户 / 全 fresh / 证据 18/18 可解析 / 零冲突零孤儿）；验收文档 `docs/P0-3-收口-契约验收.md`。下一阶段选择权交回用户。

---

## 2.34 P0-3 收口：全仓静态护栏 + 真实库运行态验收（2026-08-23）

> **状态：P0-3 CLOSED**。四刀全部封板：`7950ca6` 只读组装层 → `9a375b3` 360 消费者化 → `14eaa07` 状态条消费者化 → `03d994d` 今日行动卡消费者化。验收脚本 `scripts/p0-3-closed-gate.ts`（静态 + 运行态），验收文档 `docs/P0-3-收口-契约验收.md`。

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
- **下一阶段**：**P0-4 Action Funnel 盘点完成**（`docs/P0-4-Action-Funnel-盘点.md`，零编码只读刀：六段漏斗真实定义 + 每段唯一事实来源 + correlation key 现状——task_id 完全缺失但补丁成本极低（前端 rawTaskId 已存在 + completeAction 持有 before.id），见 §2.36；待用户拍板 P0-4.2 Funnel 原语/read model）。

## 2.35 P0-3 E3 CustomerEvent：盘点 → 拍板 → E3.1 基础设施（2026-08-23）

> **E3.1 已提交**（code `f2bfb00` + docs）。E3 = 行为发生后的事件闭环（AI 建议 → 用户复制/打开聊天 → 客户回复 → 下一轮判断，缺回流）；用户拍板不做 P0-4（action 需先定义成事件一等公民，避免再造多套真源）。

- **第一刀只读盘点**（零编码，`docs/P0-3E3-CustomerEvent-盘点.md`）：四个问题全部有答案
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
- **E3 收口已 CLOSED**（`d97f663`，验收文档 `docs/P0-3E3-收口-契约验收.md`，护栏 `scripts/customer-event-closed-gate-test.ts` **16/16**）：静态全仓 13 项——customerEventAdd 出现点恰 3（定义+E3.2 helper+E3.3 recorder）/ 事件查询原语零消费者（Scope Lock ⑥ 四消费者不迁）/ 无绕过 DDL 直接 SQL / 五类型写点归属（A4a-d）/ follow_up_done 不经 IPC / 单表写不冒充 judgment-profile-intent / quote_signal 不迁移（recordQuoteSignal+markQuoteReplied+customer_replied_at 继续工作）/ 无第二套 action log（activity_log 仅遗留 crmDbService）/ R7 不迁移（completeUnifiedSignal 零事件消费）/ 文档同步；真实库运行态 3 项——customer_event 表 0 基线（待应用重启激活，部署时序）/ quote_signal 分流兼容（22 行全已回复）/ DDL 内存副本无损建表 + CHECK 拒绝越界
- **E3 三刀齐 + 收口 CLOSED**：下一步 = **P0-4 Action Funnel**（建立在已验证的 customer_event 事实事件之上）

## 2.36 P0-4 Action Funnel：只读盘点（2026-08-24）

> **P0-4.1 盘点已提交**（零编码只读刀）。核心问题：**销售今天做了什么？做完有没有产生客户响应？最终有没有推动商机？**

- **六问盘点**（`docs/P0-4-Action-Funnel-盘点.md`）：
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
> - **验收文档**：`docs/P0-4.2-收口-契约验收.md`（三刀回顾 / 口径契约 / 护栏全景 / 真实库快照 / 未做边界）
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
- **商机三修复**（Windows 打包版实测反馈，修复在源码需 `npm run build` 重打包生效）：① `parseQuoteSignal`/`parseBuySignal` 手机号不当金额（`PHONE_NUM_RE` 跳过 + `AMOUNT_MAX=1e8` 合理性上限；真实案例 ¥15,202,635,273 = 手机号 15202635273）② `opportunityUpsertBySignal` 无产品信号累积到最近一条无产品 active 商机（此前每条信号新建→重复商机）③ OpportunityPage 商机金额 ≥1e8 显示「亿」（此前 ¥3040527.4万 式畸形单位）
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
- **D8 评审包落稿**：`docs/规划/Phase0-D8-评审包.md`——决策清单（术语口径 / Identity 归并 / Stage 矩阵 🔶 格 / owner_sales 三处口径 / 决策 B 存量处置 / AI 三档边界 / PIPL 证据规范）+ 附件 A 术语表 + 附件 B 对象契约一页表；每条带通俗解释与签字栏，30 分钟可过。**9/3 经 GLM 评审修订一轮**：措辞三修（裁决 4 与 A 档分界=转客户那一刻 / 裁决 6 审计为系统自动写入+Hermes 固定模板推送措辞 / 裁决 7 云推理脱敏上云、原文不出本机=未脱敏原文）+ 新增裁决 8（AI 读边界：默认本账号 scope，跨账号仅最小身份字段）+ 裁决 3 补流失判定带证据规则 + 宪法 §2.2 补 PIPL 删除通道；现行 8 条，主管口头同意、约定试运行一周后复核，签字后宪法 §2.5 🔶 格生效
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
- **设置页区块**：数据库 tab 底部「自动备份」之后新增「身份档案」——姓名输入 + 角色 custom-select（暂不选择/销售/主管/分配员）+ 保存按钮 + 当前署名预览行
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
- **IPC/前端**：`lanSyncIpcHandlers.ts` 两端点 `lansync:status`（只读）/ `lansync:run`（enqueueSalesTask 串行，手动一轮）；preload `lanSync.*` + d.ts `LanSyncStatus` 三处配齐；config API `get/setLanSyncSharedDir`、`get/setLanSyncRole`；**设置页数据库 tab「内网同步」区块**（身份档案后）：共享目录路径（blur 保存）+ 角色下拉（立即保存）+ 状态行（最近同步时间/积压数/终端标识）+「立即同步」按钮，沿用自动备份区块同款样式。
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

> **问题**：Windows 机器商机页显示「商机金额 ¥304.05 亿」，王靖一条 ¥15,202,635,273——即手机号 15202635273 被当金额。**根因是存量**：护栏（`PHONE_NUM_RE` + `AMOUNT_MAX=1e8`，crmParseRules.ts:35/37）9/2 才随 86b3ece 上线，此前旧版本已把脏数据写进 Windows 本地库；覆盖安装只换程序不动数据，故新包仍看到旧脏数据。Mac 本机库是干净的（opportunity 仅 5 行 amount 全 0）。

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

## 3. 已交付功能清单

| # | 功能 | 入口 | 关键文件 | 状态 |
|---|------|------|----------|------|
| 1 | **今日行动清单** | 首页 `/` `/home` | `salesActionEngine.ts` + `TodayActionPage.tsx` | ✅ |
| 2 | **自动阶段分类** | 后台自动（新消息触发） | `salesStageClassifier.ts` | ✅ |
| 3 | **触发规则引擎** | 每天08:00全量+增量 | `salesActionEngine.ts`（6条规则） | ✅ |
| 4 | **周复盘** | 每周日20:00自动 | `salesReportService.generateWeeklyReview()` | ✅ |
| 5 | **知识库 CRUD + CSV导入** | 侧边栏「知识库」 | `salesKnowledgeService.ts` + `KnowledgeBasePage.tsx` | ✅ |
| 6 | **AI 话术建议（引用知识库）** | 行动卡片 + 聊天页 | `salesReplyService.ts` + `SalesContextStrip.tsx` | ✅ |
| 7 | **聊天页上下文条** | 聊天页顶部（非群聊） | `SalesContextStrip.tsx` | ✅ |
| 8 | **客户列表 + 导出Excel** | 侧边栏「客户」 | `CustomerListPage.tsx` | ✅ |
| 9 | **客户画像卡片** | 聊天详情面板 | `CustomerCard.tsx` | ✅ |
| 10 | **AI 意向分析** | 画像卡片 + 自动扫描 | `salesIntentService.ts` | ✅ |
| 11 | **跟进待办** | 今日行动右侧「待办清单」（已收敛） | `salesFollowUpService.ts` + `TodoSidebar.tsx`（散任务视图，§2.19 职责分工；老 FollowUpPage 已归档 `1aefef4`） | ✅ |
| 12 | **销售仪表盘** | `/dashboard`（原首页） | `SalesDashboardPage.tsx` | ✅ |
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
| 28 | **销售漏斗** | 侧边栏「漏斗」 | `SalesFunnelPage` + `salesDbService.funnelStats(days)`（历史累计流转 + 逐级转化率 + 当前快照卡 + 堆叠趋势，§2.24） | ✅ |
| 29 | **CRM 级联删除（自动备份）** | 工作台/跟单中心每行删除 | `deleteContract`/`deleteAccount` + `crm-backups/` 备份 | ✅ |
| 30 | **行动卡自带 AI 分析** | 今日行动 high/urgent 卡 | `follow_up_task.analysis` 预热渲染（A1） | ✅ |
| 31 | **今日行动分页** | 今日行动信号卡片流底部 | `TodayActionPage.tsx`（`.signal-pagination`，10 条/页） | ✅ |
| 32 | **客户信息 AI 自动填充** | 导入后自动 / 档案「AI 补全」/ 批量回填 | `crmEnrichService.ts` + `crmEnrichCore.ts` | ✅ |
| 33 | **信息待确认队列** | 工作台客户 tab 顶部（`57c4e0f` 自跟单中心迁入） | `crmDbService.infoPendingQueue` + CrmWorkbenchPage | ✅ |
| 34 | **客户 360 单屏视图** | CRM 客户 tab | `CrmWorkbenchPage.tsx`（字段卡+时间线+手改锁定+深链） | ✅ |
| 35 | **CRM 可视化** | 工作台顶部 + 漏斗页 | `statsOverview` + ECharts 三图 + 真漏斗下钻 | ✅ |
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
    │       ▼
    │   salesStageClassifier ──AI──► customer_profile.stage 自动更新
    │
    │   （阶段语义层 shared/salesStage.ts：normalizeStage 中英→canonical 幂等，
    │     funnelBucket/stageToFunnel 归桶；DB 存原值，UI/统计统一归桶）
    │       │
    │       ▼
    │   salesActionEngine.onNewMessage() ──► 增量规则检查 ──► follow_up_task
    │
    ├─ 每天 08:00 全量扫描
    │       │
    │       ▼
    │   salesActionEngine.runFullScan() ──► 6条规则 ──► 今日行动（≤15条）
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
            └─ "AI话术" 按钮 ──► generateSuggestion() ──► 引用知识库 ──AI──► 话术

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
| created_at | INTEGER | 毫秒时间戳 |
| updated_at | INTEGER | 毫秒时间戳 |

> 注：PRD v0.2 设想的 status/source 列未实现（话术提炼功能未做），当前 6 列 + 时间戳。

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
| session_id | TEXT | 微信会话（= customer_id，漏斗去重单位） |
| stage | TEXT | 阶段（中英混存，见 customer_profile 注） |
| confidence | REAL | 0-1 |
| source | TEXT | auto_message_trigger / manual / ai |
| reason | TEXT | AI判断依据 |
| created_at | INTEGER | 毫秒（`funnelStats` 窗口过滤/首次进入落日依据；`intentCreate` 可传 `createdAt` 回填历史） |

> 漏斗口径：**append-only 阶段变更日志**，部分写入方（AI/手动）不跳过未变化会重复记录，统计必须按 `session_id` 去重，绝不按行数。`funnelStats` 按窗口内 `MIN(created_at)` 首次进入该档位落日。

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

### 后端 `electron/services/`
| 文件 | 说明 |
|------|------|
| `salesActionEngine.ts` | **核心**：触发规则引擎 + 今日行动生成 + 增量检查（阶段归一化已改用 shared `normalizeStage`）；**§2.35 E3.3**：`recordUserActionEvent` 行动事件写入（白名单 + WARN 容错 + source=manual）+ `completeAction` before 状态检查幂等写 follow_up_done（R7 业务路径零直接事件引用）；**§2.36 P0-4.2.1**：四参 `recordUserActionEvent(sessionId, eventType, messageKey, taskId)`，completeAction 直写 `before.id` |
| `salesStageClassifier.ts` | **核心**：轻量AI阶段分类（7阶段，≤500token/次） |
| `salesDbService.ts` | 销售库CRUD + migration + **`funnelStats(days)` 历史累计流转漏斗**（窗口过滤→session 去重→相邻转化率→逐日补零→当前快照；`intentCreate` 支持 `createdAt`）+ **§2.35 E3.1 `customer_event` 表与事件原语**（CHECK 五类型门禁 / message_key 幂等 partial unique / `customerEventAdd`（守卫+幂等返回 null） / `customerEventsBySession` / `customerEventsByType(sinceMs?)`；**§2.36 P0-4.2.1 加 `task_id INTEGER` 列**——CREATE 直含 + 幂等 ALTER 兜底旧库，INSERT 支持 task_id；**P0-4.2.2 加 `tasksCreatedSince(ms)` 原语**——窗口内任务，Action Funnel created 段数据源） |
| `actionFunnel.ts` | **P0-4.2.2 Action Funnel 只读组装层**（read model，同 customerCurrentView 先例；零判断零写入）：`getActionFunnel(days?, now?)`——六段 Task-level 去重（executed=task 至少一个执行事件 task_id 关联 / responded=task 产生后 session 有客户响应 / progressed=last_stage_change_at / won=stage=won）/ superseded 不重复计 / 分母 0 → rate null / days 只过滤 created / sources 逐段事实来源（exposed=unmeasured，G1 不可测）/ 不调 LLM 不消费 customer_judgment |
| `salesKnowledgeService.ts` | 知识库CRUD + n-gram检索 + CSV导入 + **话术提炼引擎**（extractScriptsFromChat/generateActionAnalysis） |
| `salesReportService.ts` | 周报/月报 + **周复盘**（weekly_review） |
| `salesIntentService.ts` | AI意向分析 |
| `salesReplyService.ts` | 回复建议（引用知识库） |
| `salesFollowUpService.ts` | 两段式待办提取 |
| `salesQueue.ts` | 串行队列（防WCDB段错误） |
| `salesLogger.ts` | 落盘日志 |
| `ai/aiApiClient.ts` | 统一AI调用层 |
| `insightService.ts`（改） | 销售prompt + 沉默扫描 + 高意向预警（P0-2A.4 起 stage 解析仅写 signal 不覆盖 stage） |
| `salesInsightWrite.ts`（P0-2A.4 新建） | insightService 阶段 signal 写路径（不依赖 Electron，可单测）：`applyParsedStageSignal` = customerUpsert 建档 + intentCreate(source=ai)，**不写 stage** |
| `customerUpsertPolicy.ts`（P0-2A.5 新建） | 通用 upsert 阶段剥离（不依赖 Electron，可单测）：`stripStageFromUpsert` —— IPC 入口运行时剥离 stage，tags/notes/display_name 等其余字段原样保留 |
| `legalStageWriters.ts`（P0-2A.6 新建） | **合法 stage 写者元数据收口**（不依赖 Electron，可单测）：`applyManualStageCorrection`（校验值合法性拒绝非枚举值+dormant + intent_tag_log(source=manual) + 阶段变更写 last_stage_change_at）；`applyDealStageWon`（stage=won + intent_tag_log(source=deal_rule) + 阶段变更写 changedAt） |
| `dbPathService.ts`（改） | Windows多路径检测 + 注册表查询 |
| `wcdbCore.ts`（改） | -2302错误信息改善 |
| `crmDbService.ts` | **CRM 数据层**（weflow-crm.db）：客户/合同/回款/物流/发票 CRUD + 级联删除 + 自动备份 |
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
| `pages/SalesDashboardPage.tsx` | 仪表盘（移至/dashboard） |
| `components/sales/ExtractScriptDialog.tsx` | **话术提炼弹窗**（单选/批量双模式，三步流程） |
| `components/sales/AIActionCard.tsx`（改） | 行动卡：**打开聊天**（跳转微信会话）+ **复制话术**（无话术先生成再复制）+ AI 面板话术行内复制；P0-3.4 折叠面板改 `item.judgments` 四卡（总结/机会/风险/下一步 + 较旧/人工徽标 + 证据点击回查 P0-2B），不再渲染 analysis JSON 五字段 |
| `pages/CrmWorkbenchPage.tsx` | **CRM 工作台**：合同+客户双 tab、档案一屏、深度分析/AI 报价/建合同/删除、阶段筛选、**打开聊天**、客户 tab 顶部**信息待确认**折叠区块（采纳/放弃/查看档案，`57c4e0f` 自跟单中心迁入） |
| `pages/CrmReviewPage.tsx` | **跟单中心**：归属/物流/到款/发票四队列 + 扫描群配置（含来源显示/金额输入）+ **自动确认摘要块**（运行/历史/撤销） |
| `pages/SalesFunnelPage.tsx` + `.scss` | **销售漏斗**（§2.24 改造 + **§2.38 P0-4.4**）：时间窗口 toggle（**7/30/90/全部 四档，默认 30**）+ 副标题 + ECharts 真漏斗（4 档，**蓝系渐变配色 + rich label 双行：段名+人数大字/`转化 X%` 小字**，selectedMode 点击态）+ 当前客户状态小卡片（顶部色条随阶段色 + hover 上浮）+ 窗口每天进入各档位去重客户数堆叠趋势 |
| `shared/funnelPalette.ts` | **漏斗图表色板单一真源**（2026-08-24 UI 地基）：两漏斗共用 Apple 蓝渐变五档 + 中性档；页面禁硬编码品牌色，将来跟主题只改本文件 |
| `docs/DESIGN-SPEC-MINI.md` | **Mini Design Spec**（2026-08-24 UI 美化地基）：token 双套/品牌/主题/暗色/控件惯例/五条红线/四波次 |
| `pages/ActionFunnelPage.tsx` + `.scss` | **行动漏斗**（P0-4.3 §2.37 + **P0-4.4 §2.38**）：五段 Task-level 漏斗（行动产生→销售执行→客户响应→有效推进→成交，**P0-4.4 起 HTML/CSS 自绘梯形替代 ECharts**——四档窗口默认 7 + 蓝系渐变 + 段间箭头 + 段内转化率 + 推进/成交 Info tooltip 弱化映射说明）+ 曝光 N/A 未埋点提示 + 6 KPI（执行率/响应率★北极星/推进转化率）+ KPI/漏斗段点击下钻弹层（事件类型计数 + 最近任务样本 ≤10） |
| `pages/CustomerWorkspacePage.tsx` | **AI 客户工作台**（§2.21）：`rowStage(c)=stageToFunnel(profile_stage||sales_stage)` 统一归桶——阶段筛选/下拉/徽章/深链过滤与漏斗同源（修复英文阶段下钻空白，§2.24） |
| `stores/todayActionStore.ts` | 行动清单store（P0-3.4：不再解析 sig.analysis JSON 注入卡片，判断改消费主进程组装的 `item.judgments`；fetchSuggestion 成功后重读 currentView 刷新） |
| `pages/CrmLeadPage.tsx` + `.scss` | **线索池页**（§2.12，路由 /leads）：导入 modal（来源下拉/文件/文本粘贴）/ 统计卡 / 筛选 chips / 表格（脱敏+超时徽章+行内操作）/ 详情 + dead modal |
| `pages/OpportunityPage.tsx` + `.scss` | **商机页**（§2.14，路由 /opportunities）：ECharts 漏斗下钻 + 统计卡 + 商机卡片（意向评分条）+ 详情 modal（阶段推进/成交丢单/事件时间线/评分依据/风险预警区） |
| `stores/crmStore.ts`（改） | **autoSummary** state + runAutoConfirm/fetchAutoSummary/undoAutoConfirm |
| `stores/` (其他5个) | dashboard/customerList/customerProfile/followUp/knowledge/salesReport |

### 测试脚本 `scripts/`
| 文件 | 说明 |
|------|------|
| `crm-workbench-test.ts` | CRM 业务闭环单测（**48 项**：归属/签约/导入/聚合/成交/删除/到款审核/去重） |
| `crm-golden-test.ts` | 规则 golden 测试（**31 项**，含 isDealSignal） |
| `crm-claim-test.ts` | 货款认领测试（17 项） |
| `crm-autoconfirm-test.ts` | **自动确认引擎单测**（**56 项**：归属 A1-A10 / 到款 P1-P8 / 物流 L1-L6 / 发票 I1-I5 / 金额 F1-F4 / docgen 注入 / 引擎 E1-E5 / 撤销 U1-U6） |
| `crm-enrich-test.ts` | **自动填充引擎单测**（**48 项**：合并规则 / 核心解析校验 / 落库链路 / pending 裁决 / 填充度 / statsOverview） |
| `crm-docgen-test.ts` | **文档生成单测**（**68 项**：金额大写 18 / docx 渲染 / 端到端 quotation/contract/invoice-app 合并+公式+大写 / 型号输出 / invoice-info 落点） |
| `crm-cleanup-orphans.ts` | 孤儿客户清理 + 备份（一次性脚本） |
| `crm-lead-test.ts` | **线索流转单测**（**53/53**：清洗/去重/SLA/闭环，2026-08 §2.12） |
| `crm-opportunity-test.ts` | **商机/评分/风险单测**（**45/45**：意向评分 / parseBuySignal / 商机累积 / 阶段联动 / 漏斗 / 风险，2026-08 §2.14） |
| `funnel-test.ts` | **漏斗数据单测**（**40/40**：英文 classifier 阶段 / 中英归一 / 独立去重 / 跳级 >100% / 时间窗口 30·90·全部 / 当前快照归桶 / 逐日补零 / 除零 / P0-1 证据断言，2026-08 §2.24） |
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
| `p0-3-closed-gate.ts` | **P0-3 收口验收**（**6/6 静态 + 真实库运行态**，P0-3 CLOSED）：全仓 src/ 137 文件剥离注释扫描（无 customer_judgment/insight_record/follow_up_task/现场 LLM 直读 + 消费统一走 currentView + 三消费者四卡一致）+ sql.js 只读真实库（判断覆盖/freshness/evidence 可解析/冲突观察） |
| `customer-event-test.ts` | **P0-3 E3.1 CustomerEvent 基础设施护栏**（**16/16**）：静态 8（五类型枚举完整 / shared 无越界类型（防万能日志表）/ 建表 CHECK 五类型 / message_key 幂等 partial unique / 原语命名 / 类型守卫被引用 / customerEventAdd 单表写四者不互相冒充 / Scope Lock 文档同步）+ 行为 8（append 可读 / 同 key 幂等拒绝 / 无 key 手动事件可重复 / 非法类型抛错 / bySession 倒序 / byType+sinceMs / metadata 往返 / 与判断意向三表独立） |
| `customer-event-producer-test.ts` | **P0-3 E3.2 最小生产者护栏**（**14/14**）：静态 8（quote_asked/customer_replied 双写点 / closed>0 门控 / 复用 canonical key 不拼 key / evidence 原话非 AI 结论 / helper try/catch+WARN 不阻断 / customerEventAdd 仅 1 处且在 recordUserActionEvent 内（R7 路径零直接事件引用，E3.3 收窄） / crmDbService 零事件污染 / intent_tag_log 零新写点）+ 行为 6（报价双写一致 / 同 key 双幂等 / 回复闭环 customer_replied_at 更新+事件 / closed=0 门控不写 / 写失败不阻断原链仍成功 / metadata 报价详情） |
| `customer-event-action-test.ts` | **P0-3 E3.3 销售行动事件护栏**（**20/20**）：静态 11（recordUserActionEvent 导出+白名单 / completeAction before 状态检查+follow_up_done 写入 / **P0-4.2.1** follow_up_done 携带 before.id（四参）/ IPC sales:action:recordEvent + taskId 透传（typeof number 才传）/ preload actionRecordEvent 签名含 taskId / AIActionCard 成功点接入 chat_opened+script_copied + **rawTaskId 提取上报** / follow_up_done 不经 IPC / 无第二套 action log / source=manual）+ 行为 9（pending→done 恰好一条 + **task_id=task.id** / 重复完成幂等不新增 / skipped 不写 / script_copied 带 taskId 落库 / 白名单外拒绝不抛 / 空 sessionId 容错 / **无 taskId 上报 → NULL 不伪造**） |
| `action-funnel-test.ts` | **P0-4.2.2 + P0-4.3 Action Funnel 护栏**（**25/25**）：静态 4（导出+纯只读零 judgment/LLM / sources 六段逐段正确 / rate=null 分母守卫 / tasksCreatedSince 原语）+ 行为 15（空库全 null / 组合场景六段+转化率+窗口全量 / executed task-level 去重（2 事件 → 1）/ 无 task_id 不归入 / superseded 不重复计 / 时序守卫（task 前事件不计）/ responded 去重 / progressed 前后时序 / won 中文口径 / 响应率公式 / days 窗口）+ **breakdown 6（P0-4.3）**（计数与聚合严格一致 / executed.eventTypeCounts 精确 script_copied=2+chat_opened=2+follow_up_done=0 / responded 精确 customer_replied=2+quote_asked=1 / samples createdAt 降序 + t1 双类型去重 / samples 含 taskId/sessionId/title / breakdown 窗口传递） |
| `action-funnel-closed-gate-test.ts` | **P0-4.2.3 + P0-4.3 Action Funnel 收口护栏**（**17/17**）：静态 8（导入白名单零 judgment/LLM / **全文件零写方法 + 读访问仅白名单三原语（P0-4.3 起 A2 升级整文件检查**——collectTaskRows 提取后读方法移出函数体，限定体内检查不再成立）/ 执行+响应事件白名单不膨胀 / sources 六段不变量 exposed=unmeasured / divRate 分母守卫 / tasksCreatedSince 唯一消费者 / 无第二套 action log / task_id 非空写点仅 E3.3）+ 真实库运行态 7（customer_event 0 基线 / created 口径闭合 1217+1601=2818 / won=26 normalizeStage 同口径 / 7d<=30d<=全量窗口结构 / executed+responded=0 / last_stage_change_at 非空 0 / 六段事实来源字段齐全），验收文档 `docs/P0-4.2-收口-契约验收.md` |
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
| aiInsightSilenceDays | 3 | 沉默扫描下限 |
| aiInsightSilenceMaxDays | 30 | 上限 |
| aiInsightScanLimit | 50 | 每次扫描上限 |
| aiInsightCooldownMinutes | 10080 | 冷却（建议7天） |
| crmAutoConfirmEnabled | true | 跟单中心自动确认总开关 |
| crmAutoConfirmThreshold | 0.8 | 自动确认置信阈值 0.5-1.0（低于留人工） |
| crmAutoConfirmInvoiceDocgen | false | 发票自动关联后自动生成开票信息单（需合同含 tax_no） |
| crmEnrichEnabled | true | CRM 客户信息 AI 自动填充总开关 |
| crmEnrichThreshold | 0.7 | 自动填充：进 pending 队列的置信下限（低于丢弃） |
| crmEnrichAutoApply | 0.85 | 自动填充：直接写入档案的置信阈值 |
| crmEnrichBackfillLimit | 20 | 自动填充：单次存量回填客户数上限 |
| crmLeadSlaHours | 24 | 线索首触 SLA 小时数（1-72，导入时锁定不回溯） |
| crmLeadSourcePreset | 抖音,视频号,小红书 | 线索来源预设（逗号分隔，导入/筛选下拉） |

---

## 10. 未完成 / 待办

> **2026-08-23 重组**：下一阶段主线 = **§2.26 P0 路线**（AI 销售副驾驶）。已核销：话术提炼优化（基础版已交付）、行动卡深链客户档案（§2.17 一键闭环+深链已实现）、漏斗深链（§2.24 已实现）；已合并：零操作闭环实测 + 线索池实测 → 「实测反馈驱动迭代」；已定决策：触发规则配置 UI 冻结（L0-L3 文档化）、跟单中心增强拆分保留发票解析（到款/归属合并暂缓）、灵感信箱保留暂缓。

| 优先级 | 项目 | 说明 |
|--------|------|------|
| **P0 主线** | **§2.26 P0-1 → P0-5** | AI 销售副驾驶主线（2026-08-23 定稿，权威规划见 §2.26）：P0-1 E4 证据链 UI（**第一刀已实现并提交**：intent_tag_log 证据列 + 透传 + source_message_id；运行时验证三件事通过，见 §2.26）→ P0-2 客户「AI 当前判断」（**2026-08-23 数据契约盘点完成，见 docs/P0-2-数据契约盘点.md**；**P0-2A Canonical State 设计已定稿，见 docs/P0-2A-Canonical-State-设计.md**：canonical 6 值 + activityState 拆 dormant + unknown 异常位；写者资格 classifier/intent/manual/deal ✅、insightService ❌ 降 signal、generic upsert ❌ 移除、dormant 规则写 activityState；intentScore 只修两 bug；**六刀已全部提交**：`6bf1ff6` 两 bug / `a3f3479` read model / `308d5d9` 规则口径归一 / `53ee94b` insightService 禁写 stage / `2933a2d` generic upsert 移除 stage / `3ff3f1f` manual+deal 补元数据；下一步 = P0-2B Evidence Resolver）→ P0-2B Evidence Resolver（**已提交** 两刀 `04dbaec`+`21fd148`）→ P0-2C AI Judgment Persistence（**盘点定稿 + 三刀已提交**：`07241f4` + `fc654b2` + `057f8aa`，见 §2.28）→ **P0-2 收口 CLOSED**（静态契约验收 + 真实库只读盘点 + 护栏封死，见 §2.29）→ P0-3 Current Judgment Consumer Layer（**第一刀已提交** `7950ca6` getCustomerCurrentView 只读组装层 + 独立 IPC + 30 断言，见 §2.30；**P0-3.2 已提交** `9a375b3` Customer 360 判断卡消费 currentView——删除现场 generateActionAnalysis，13 护栏断言，见 §2.31；**P0-3.3 已提交** `14eaa07` SalesContextStrip 消费 currentView + suggest 主动生成保留（sessionId 断链修复 + 生成后立即重读闭环），10 护栏断言，见 §2.32；**P0-3.4 已提交** `03d994d` 今日行动卡判断展示消费 currentView（getUnifiedSignals 组装 judgments / store 删 analysis JSON merge / AIActionCard 面板 judgments 四卡 / 收件箱保留历史语义），14 护栏断言，见 §2.33；**P0-3 已收口 CLOSED**（全仓静态护栏 6/6 + 真实库运行态验收，见 §2.34））→ P0-3 E3 CustomerEvent（扩展 intent_tag_log，复用 12h 节流）→ P0-4 Action 埋点（新增 script_copied/chat_opened/customer_replied）→ P0-5 L0-L3 文档化 |
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
| 大后期 | CRM双向同步 | 仅预留字段 |
| 大后期 | 向量数据库 | 知识库>1000条时考虑 |

---

## 11. 给接手者的下一步

1. **读本文档** → 读 `MAINTENANCE.md` → 读 AGENTS.md
2. **跑起来**：`npm install && npm run dev`（开发模式）。⚠️ 若 `--version` 报 v24.17.0 且无 GUI，先 `unset ELECTRON_RUN_AS_NODE`（见 MAINTENANCE §4.8，vite 已自动防御）
3. **跑单测确认基线**：`npx tsx scripts/crm-workbench-test.ts`（48/48）、`npx tsx scripts/crm-golden-test.ts`（31/31）、`npx tsx scripts/crm-claim-test.ts`（17/17）、`npx tsx scripts/crm-autoconfirm-test.ts`（56/56）、`npx tsx scripts/crm-lead-test.ts`（53/53）
4. **测试零操作闭环**：跟单中心（自动确认摘要块/运行按钮/历史撤销、设置页阈值）、今日行动（打开聊天/复制话术）、CRM 工作台客户（打开聊天）
5. **测试话术提炼**：知识库页 → 选联系人设日期区间 → 提炼 → 看效果
6. **测试线索池**：/leads → 导入 Excel/CSV 或粘贴文本（来源下拉）→ 验证清洗/去重/统计 → 等 SLA 超时后今日行动出现「首触提醒」卡 → 完成/跳过 → 转客户
7. **继续开发**：先读 **§2.26「AI 销售副驾驶」产品/开发主线**，按其中 P0 路线（P0-1 → P0-5）推进；其余按 §10 待办优先级

---

## 12. 文档索引

| 文件 | 用途 |
|------|------|
| `docs/HANDOVER.md` | 本文件（全局交接） |
| `docs/MAINTENANCE.md` | 操作手册（打包/坑/安全） |
| `docs/归档/prd旧版/PRD-v2-销售行动驱动器.md` | v2 产品规划（已被 v3 取代） |
| `docs/归档/prd旧版/PRD-v0.2-AI销售助手.md` | 历史需求（已取代） |
| `docs/HTTP-API.md` | HTTP API 文档 |
| `docs/MAC-KEY-FAQ.md` | Mac 密钥 FAQ |
| `docs/产品库导入模板.csv` | 知识库导入模板 |
| `AGENTS.md` | Agent 启动指南（本地，gitignore） |
| `docs/PLAN-CRM零操作改造.md` | CRM 零操作改造方案（已实施，含提交映射） |
| `docs/HANDOVER-20260818-CRM零操作改造与产品库.md` | 2026-08-18 阶段交接（零操作改造/R7/三优化/产品库导入指引） |
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
