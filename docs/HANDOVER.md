# WeFlow AI 销售助手 · 交接文档（HANDOVER）

> 给**任何接手者 / 新会话 / clone 本仓库的人**看的全局交接文档。
> 基线 commit `d40cd4d`；**AI 销售副驾驶产品/开发主线**（下一阶段北极星「有效销售行动」漏斗 + P0 路线 + L0-L3 边界 + 冻结范围）见 §2.26（规划定稿，未提交）；客户名真相源修复（微信号名回填微信真实备注）见 §2.25（未提交）；漏斗改造（历史累计流转 + canonical 语义层 + 下钻修复）见 §2.24（未提交）；物流群扫描失效修复见 §2.23（getMessages 升序 + 传 startTime 扫增量，未提交）；最近提交 `068a403`（2026-08-20 客户名称读取侧统一 + 同名不跨会话 + logi 签收闭环，见 §2.20；SLA 首触卡移出主卡流 `c90e6c9`，见 §2.17；今日行动/待办职责分工 `d5b9f62`，归档 FollowUpPage，见 §2.19；AI 回写 model/sourceId 溯源 `223c158`，见 §2.18；SLA 卡置顶+提分 `678e3f0`，见 §2.17；线索池排序 `3156910`；SLA/Action 接通 `5ba531b`，见 §2.17；Customer 360 统一时间线 `6c439bf`，见 §2.16；侧边栏导航收口 7 模块 `09d5600`，见 §2.15；信息待确认迁至工作台客户 tab `57c4e0f`；跟单中心物流卡两行化 `bfed14d`；新建合同选型号 `3e44a12`；复盘排除非销售联系人 `ed510df`；销售复盘改造 `9a9fbaf`；AI 见解 24h 去重+非客户黑名单 `f02b13c`；今日行动新建待办 `8085dc2`；漏斗深链 `11359fe`；漏斗数据 `c719678`；P0 见 `0eab71f`；阶段性交接见 docs/HANDOVER-20260818-CRM零操作改造与产品库.md）。
> `npx tsc --noEmit` 零错误；crm 全系单测：workbench **48/48**、golden **45/45**、claim **17/17**、autoconfirm **58/58**、docgen **68/68**、enrich **55/55**、lead **53/53**、logistics **37/37**、opportunity **45/45**、funnel **31/31**（历史累计流转漏斗）、todo-followup **11/11**（手动待办）、report-review **33/33**（销售复盘）。
> Mac + Windows 双平台打包验证通过。
> **2026-08-13 增量**：确认中心零操作化（自动确认引擎 + 三触发点 + 前端摘要/历史/撤销）+ 行动卡一键闭环（打开聊天/复制话术）+ Electron 闪退真因修正（见 §2.6）。
> **2026-08-20 增量**：客户名真相源修复（微信号名回填微信真实备注 + 显示名解析优先微信备注，见 §2.25，未提交）；漏斗改造（历史累计流转 + 逐级转化率 + canonical 语义层 + 下钻修复，见 §2.24，未提交）；AI 销售助手 V1 P0 三缺口落地——商机闭环（采购信号→商机→阶段联动→漏斗）、意向评分 0-100、风险预警结构化（见 §2.14）；漏斗数据修复（转化率相对顶部 + 近7天去重，commit `c719678`，已被 §2.24 取代）；漏斗深链修复（阶段统一 customer_profile.stage，commit `11359fe`）；今日行动新建待办（手动待办进信号流 + 侧栏可勾选，commit `8085dc2`）；AI 见解 24h 去重 + 非客户自动黑名单（commit `f02b13c`）；销售复盘改造（周复盘打通 + 非客户过滤 + 崩溃兜底，commit `9a9fbaf`）；复盘排除非销售联系人（手动排除名单，同事/朋友聊天剔除出统计，commit `ed510df`）；新建合同选型号（工作台从产品库勾选，创建即自动生成报价单，commit `3e44a12`）；跟单中心物流卡两行化（信息/时间与操作分区，commit `bfed14d`）；信息待确认迁至工作台客户 tab（裁决与 AI 补全同页闭环，跟单中心不再展示，commit `57c4e0f`）；侧边栏导航收口 7 模块（今日行动/聊天/CRM/跟单/AI·知识/报表/系统，数据驱动 NAV_GROUPS，commit `09d5600`）；Customer 360 统一时间线（客户档案时间线聚合合同/到款/物流/报价/线索流转/商机事件/AI 见解一条流，前端四色混排并删重复「最近见解」块，commit `6c439bf`）；SLA/Action 接通（首触 SLA 扫描接入 Action 引擎每日 08:00 + 今日行动页打开周期，长时间运行不漏卡；lead:/logi: 虚拟卡隐藏无效「打开聊天」，commit `5ba531b`）。
> **2026-08-23 增量**：**落 §2.26「AI 销售副驾驶」为下一阶段产品/开发主线**（规划定稿）。定位：AI 观察/理解/判断/准备，销售最终判断与对外执行，L3 自动对客回复明确不做。固化三个关键事实：① P0-1 前置已确认——微信消息读取统一走**应用读取层 `chatService`**（解密 WCDB 只读，产品核心能力；HTTP API 是同一读取层的 HTTP 封装，非独立数据源），无需新增读取层，真正缺口是 AI 记录侧持久化 `messageKey`，`evidenceText` 作历史兜底；② CustomerEvent（P0-3）AI 节流必须复用 `insightService` 12h 机制；③ 自动扫描循环已存在（runFullScan + lazyScan + 每日全量 + 增量），真正缺的是**行动结果回流**（Agent Action → Outcome → Re-evaluation）。北极星升级为「有效销售行动」六段漏斗（发现→生成→采纳→执行→响应），先埋点后看板。§10 待办已按 P0 路线核销/合并/新增。**P0-1 第一刀已提交**：`intent_tag_log` 加 `message_key`/`evidence_text` 两列（幂等 ALTER），透传链路落地（classifier/intentService/actionEngine/insightService urge），`follow_up_task` 用 `source_message_id` 存 messageKey；`funnel-test` 增 9 条 P0-1 证据断言；运行时三件事验证通过（① 新日志带 message_key ✓ ② message_key 回查命中原消息 ✓ ③ evidence_text 为原话非 AI 结论 ✓）。
>
> **文档分工**：
> - **本文件** = 项目是什么 / 做了什么 / 架构 / 数据模型 / 进度 / 待办（全局视图）
> - **`MAINTENANCE.md`** = 怎么打包 / 怎么避坑 / 安全红线 / 版本规则（操作手册）
> - **`PRD-v2-销售行动驱动器.md`** = v2 原始需求（已被 v3 第一期取代）
> - **微信文件** = `今日行动-优化PRD-v3.md` / `今日行动-第一期PRD.md`（最新需求来源）
> - **`PRD-v0.2-AI销售助手.md`** = 历史需求（已被 v2 取代，仅供参考）

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

## 2.14 AI 销售助手 V1 P0：商机 + 意向评分 + 风险预警（2026-08-19~20，PRD `docs/PRD-V1-AI销售助手.md`）

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

## 2.23 物流群扫描失效修复：getMessages 升序 + 传 startTime 扫增量（2026-08-20，未提交）

> 现象：crmParse 自动扫描「艾驱安能物流跟踪群」自 8月5日 18:50 起失效（`last_scan` 卡在 `1785927053000`），日志一直 `[CrmParse] ... scanned=0`。数据源本身正常（HTTP API 直拉物流群，最新消息全是 8月5日后）。

- **根因**：`chatService.getMessages` 内部经 `collectVisibleMessagesFromCursor` 末尾 `normalizeMessageOrder` 把消息**升序重排（旧在前）**；而 `crmParseService.scanAll` 原实现假设倒序返回，「遇 `ms <= lastScan` 即 break」——第一页第一条恰是最旧的 7月20日消息，`ms <= lastScan` 直接 break → 排在数组后方的 8月5日 后增量（60 条）被漏掉 → scanned=0。
- **修复**（`crmParseService.ts`，群扫描 + 私聊扫描同步）：`getMessages(gid, offset, BATCH, lastScan)` 传 **startTime=lastScan**，让原生游标（`beginTimestamp`，内部自动毫秒→秒）只读 lastScan 之后的增量；遇旧消息改 `continue` 跳过（不再 break）。翻页上限 MAX_PAGES=20（群）/10（私聊），页满记 WARN；处理完按 `maxMs` 推进 `last_scan`（`updateGroup` / `setScanState`）。
- **验证**：重启 dev 后日志 `group=艾驱安能物流跟踪群 page=1 msgs=61 hasMore=false` + `scan done scanned=60`（一次补齐 60 条积压）；下一轮 `msgs=1 scanned=0`（`processed_msg` 幂等，无重复）。
- **不受影响**：HTTP API（`collectRawRows` 直接 `mapRowsLite`，**不经过 normalizeMessageOrder**，保持原生降序）；前端 ChatPage（走 `getLatestMessages` → `getMessagesByOffsetStable` 独立查询）。WCDB 时间戳是秒，`lastScan` 是毫秒（`ms = createTime * 1000` 换算）。

## 2.24 漏斗改造：历史累计流转 + 逐级转化率 + canonical 语义层 + 下钻修复（2026-08-20，未提交）

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
- **验证**：`npx tsc --noEmit` 零错误；`npx tsx scripts/funnel-test.ts` **31/31**；回归（crm-workbench 48 / crm-claim 17 / todo-followup 11）全过；`npx vite build` 通过

---

## 2.25 客户名真相源修复：微信号名回填 + 显示名解析优先微信备注（2026-08-20，未提交）

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
- **P0-2 客户「AI 当前判断」**：把已有字段 + 意向评分 + 时间线聚合成「AI 对客户当前状态的解释」卡（高意向/决策期 + 最近变化 + 当前机会 + 当前风险 + 下一步 + 查看证据）。重点是**理解层**，不是加字段
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

> 销售数据主库 `weflow-sales.db` 之外的**第二库**，承接微信群自动解析 + 业务闭环（合同/回款/物流/发票）。路径 `userData/weflow-crm.db`。表：account / contract / quotation / invoice / logistics / allocation / payment_record / shipping_info / group_config / alias_map / activity_log / contract_status_history / product / **lead**（2026-08 §2.12 新增）/ **opportunity + opportunity_event + crm_risk**（2026-08 §2.14 商机/评分/风险新增，opportunity 由空壳表转商机实体）/ contact / scan_state / processed_msg / crm_field_meta / **auto_confirm_log**（2026-08 §2.6 新增）。跟单中心四队列各加 `auto_*` 标记列（allocation.auto_confirmed_by/auto_reason、payment.auto_approved_by、logistics.auto_linked_by、invoice.auto_updated_by），记录自动来源，前端可区分 人工 vs 自动。自动处理前每批一次快照 `crm-backups/weflow-crm-before-auto-*.db`（滚动留 20 份）。

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

---

## 6. 文件地图（二创新增/改动）

### 前后端共享 `shared/`
| 文件 | 说明 |
|------|------|
| `salesStage.ts` | **阶段语义层**（§2.24 新建，零依赖纯模块）：`STAGE_CANONICAL`/`FUNNEL_ORDER`、`normalizeStage`（中英→canonical 幂等）、`stageLabel`/`funnelBucket`/`stageToFunnel`。DB 不迁移，UI/统计统一归桶 |

### 后端 `electron/services/`
| 文件 | 说明 |
|------|------|
| `salesActionEngine.ts` | **核心**：触发规则引擎 + 今日行动生成 + 增量检查（阶段归一化已改用 shared `normalizeStage`） |
| `salesStageClassifier.ts` | **核心**：轻量AI阶段分类（7阶段，≤500token/次） |
| `salesDbService.ts` | 销售库5表CRUD + migration + **`funnelStats(days)` 历史累计流转漏斗**（窗口过滤→session 去重→相邻转化率→逐日补零→当前快照；`intentCreate` 支持 `createdAt`） |
| `salesKnowledgeService.ts` | 知识库CRUD + n-gram检索 + CSV导入 + **话术提炼引擎**（extractScriptsFromChat/generateActionAnalysis） |
| `salesReportService.ts` | 周报/月报 + **周复盘**（weekly_review） |
| `salesIntentService.ts` | AI意向分析 |
| `salesReplyService.ts` | 回复建议（引用知识库） |
| `salesFollowUpService.ts` | 两段式待办提取 |
| `salesQueue.ts` | 串行队列（防WCDB段错误） |
| `salesLogger.ts` | 落盘日志 |
| `ai/aiApiClient.ts` | 统一AI调用层 |
| `insightService.ts`（改） | 销售prompt + 沉默扫描 + 高意向预警 |
| `dbPathService.ts`（改） | Windows多路径检测 + 注册表查询 |
| `wcdbCore.ts`（改） | -2302错误信息改善 |
| `crmDbService.ts` | **CRM 数据层**（weflow-crm.db）：客户/合同/回款/物流/发票 CRUD + 级联删除 + 自动备份 |
| `crmParseService.ts` | CRM 群扫描：银行到款/认领归属/物流批量/发票归档/截图OCR/私聊报价信号 |
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
| `components/sales/AIActionCard.tsx`（改） | 行动卡：**打开聊天**（跳转微信会话）+ **复制话术**（无话术先生成再复制）+ AI 面板话术行内复制 |
| `pages/CrmWorkbenchPage.tsx` | **CRM 工作台**：合同+客户双 tab、档案一屏、深度分析/AI 报价/建合同/删除、阶段筛选、**打开聊天**、客户 tab 顶部**信息待确认**折叠区块（采纳/放弃/查看档案，`57c4e0f` 自跟单中心迁入） |
| `pages/CrmReviewPage.tsx` | **跟单中心**：归属/物流/到款/发票四队列 + 扫描群配置（含来源显示/金额输入）+ **自动确认摘要块**（运行/历史/撤销） |
| `pages/SalesFunnelPage.tsx` + `.scss` | **销售漏斗**（§2.24 改造）：时间窗口 toggle（30/90/全部）+ ECharts 真漏斗（4 档，label 带相邻转化率）+ 当前客户状态小卡片 + 窗口每天进入各档位去重客户数堆叠趋势 |
| `pages/CustomerWorkspacePage.tsx` | **AI 客户工作台**（§2.21）：`rowStage(c)=stageToFunnel(profile_stage||sales_stage)` 统一归桶——阶段筛选/下拉/徽章/深链过滤与漏斗同源（修复英文阶段下钻空白，§2.24） |
| `stores/todayActionStore.ts` | 行动清单store（解析 sig.analysis JSON 注入卡片） |
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
| `funnel-test.ts` | **漏斗数据单测**（**31/31**：英文 classifier 阶段 / 中英归一 / 独立去重 / 跳级 >100% / 时间窗口 30·90·全部 / 当前快照归桶 / 逐日补零 / 除零，2026-08 §2.24） |

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
| **P0 主线** | **§2.26 P0-1 → P0-5** | AI 销售副驾驶主线（2026-08-23 定稿，权威规划见 §2.26）：P0-1 E4 证据链 UI（**第一刀已实现并提交**：intent_tag_log 证据列 + 透传 + source_message_id；运行时验证三件事通过，见 §2.26）→ P0-2 客户「AI 当前判断」→ P0-3 E3 CustomerEvent（扩展 intent_tag_log，复用 12h 节流）→ P0-4 Action 埋点（新增 script_copied/chat_opened/customer_replied）→ P0-5 L0-L3 文档化 |
| **P0 主线** | **北极星埋点验收锚点** | 六段漏斗「发现→生成→采纳→执行→响应」：**先埋点 → 验证数据 → 后看板**（硬原则）。前置：opportunity 表加 `source` 字段（区分 AI 发现 vs 手动）；「有效响应」第一版只记 `customer_replied` 不判有效。闭环完成判定 = 北极星各段有真实数据 |
| P1 | **实测反馈驱动迭代** | 原「零操作闭环实测」+「线索池实测」合并：用户实测自动确认判定（阈值可调）、行动卡打开聊天/复制话术/撤销、线索池清洗去重，有反馈再迭代 |
| P1 | **发票金额自动解析** | 跟单中心增强拆分保留项（PDF/文本）；到款/归属两队列合并**暂缓**（§2.26 冻结范围） |
| P1 | 深度分析结果缓存 | 同客户 N 小时内不重复调 AI（避免反复点重复花费），可加缓存列 |
| P1 | CRM 客户黑名单 | 删除后的客户若会话还在、AI 见解再标有意向会被重新导入——需黑名单机制 |
| P2 | 优先级公式重设计 | 等 customer_value_score 有真实数据源后 |
| P2 | 知识库增量补充 | 已有353条产品参数，需持续补充叉车行业话术/FAQ |
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
| `docs/PRD-v2-销售行动驱动器.md` | v2 产品规划（已被 v3 取代） |
| `docs/PRD-v0.2-AI销售助手.md` | 历史需求（已取代） |
| `docs/HTTP-API.md` | HTTP API 文档 |
| `docs/MAC-KEY-FAQ.md` | Mac 密钥 FAQ |
| `docs/产品库导入模板.csv` | 知识库导入模板 |
| `AGENTS.md` | Agent 启动指南（本地，gitignore） |
| `docs/PLAN-CRM零操作改造.md` | CRM 零操作改造方案（已实施，含提交映射） |
| `docs/HANDOVER-20260818-CRM零操作改造与产品库.md` | 2026-08-18 阶段交接（零操作改造/R7/三优化/产品库导入指引） |
| `docs/设计-单机线索流转模块.md` | 线索流转 PRD+技术设计（**最终定稿，已实现**，2026-08 §2.12） |
| `docs/PRD-团队版-WeFlow+Twenty底座.md` | 团队版演进预留（Twenty 底座，线索映射为自定义对象） |
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
