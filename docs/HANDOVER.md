# WeFlow AI 销售助手 · 交接文档（HANDOVER）

> 给**任何接手者 / 新会话 / clone 本仓库的人**看的全局交接文档。
> 基线 commit `d40cd4d`；最近提交 `66c54b5`。
> ⚠️ **当前工作树有 30 个文件未提交**（§2.4 / §2.5 本次增量 + 本交接文档，待 `git add` + 提交到 `backup`）。
> `npx tsc --noEmit` 零错误；`crm-workbench-test.ts` **48/48**、`crm-golden-test.ts` **31/31**、`crm-claim-test.ts` **17/17**。
> Mac + Windows 双平台打包验证通过。
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
- **坑**：重启 Electron 需 `env -u ELECTRON_RUN_AS_NODE npm run electron:dev`；主进程代码（services/preload/main）改动后 vite 只重建 main.js 不重启进程，必须手动 pkill；`pkill -f "electron:dev"` 杀不掉 Electron 主进程（命令行不含该串），需按 PID `kill -9`（Electron 偶发卡 UE 不可中断睡眠，不影响新实例）

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
| 11 | **跟进待办** | 侧边栏（已合并入今日行动） | `salesFollowUpService.ts` + `FollowUpPage.tsx` | ✅ |
| 12 | **销售仪表盘** | `/dashboard`（原首页） | `SalesDashboardPage.tsx` | ✅ |
| 13 | **周报/月报** | 侧边栏「复盘」 | `SalesReportPage.tsx` | ✅ |
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
| 28 | **销售漏斗** | 侧边栏「漏斗」 | `SalesFunnelPage` + `salesDbService.funnelStats` | ✅ |
| 29 | **CRM 级联删除（自动备份）** | 工作台/确认中心每行删除 | `deleteContract`/`deleteAccount` + `crm-backups/` 备份 | ✅ |
| 30 | **行动卡自带 AI 分析** | 今日行动 high/urgent 卡 | `follow_up_task.analysis` 预热渲染（A1） | ✅ |

---

## 4. 架构数据流

```
微信本地库 (WCDB, 只读)
    │
    ├─ DB Monitor (新消息检测)
    │       │
    │       ▼
    │   salesStageClassifier ──AI──► customer_profile.stage 自动更新
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
| stage | TEXT | new/contacted/quoted/negotiating/won/lost/dormant |
| tags | TEXT | JSON数组 |
| notes | TEXT | 备注 |
| last_contact_at | INTEGER | 秒时间戳 |
| last_stage_change_at | INTEGER | 毫秒时间戳（migration列） |
| created_at / updated_at | INTEGER | 毫秒时间戳 |

### intent_tag_log（意向日志）
| 列 | 类型 | 说明 |
|----|------|------|
| session_id | TEXT | |
| stage | TEXT | 阶段 |
| confidence | REAL | 0-1 |
| source | TEXT | auto_message_trigger / manual |
| reason | TEXT | AI判断依据 |
| created_at | INTEGER | |

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

> 销售数据主库 `weflow-sales.db` 之外的**第二库**，承接微信群自动解析 + 业务闭环（合同/回款/物流/发票）。路径 `userData/weflow-crm.db`。表：account / contract / quotation / invoice / logistics / allocation / payment_record / shipping_info / group_config / alias_map / activity_log / contract_status_history / product / lead / opportunity / contact / scan_state / processed_msg / crm_field_meta。

### account（客户，核心）
| 列 | 说明 |
|----|------|
| id / name | 自增 / 客户名 |
| session_id | AI 导入联动（私聊会话） |
| sales_stage | contacted/quoted/negotiating/won/new/unknown（AI 见解中文标签映射） |
| last_contact_at / imported_at | 毫秒时间戳 |
| industry/province/city/phone/owner_sales | 基础字段 |

> 关联：contract.account_id；allocation.payment_record_id+contract_id+account_id；activity_log(entity,entity_id)。删除为级联（§2.5），删前自动备份 `userData/crm-backups/`。

---

## 6. 文件地图（二创新增/改动）

### 后端 `electron/services/`
| 文件 | 说明 |
|------|------|
| `salesActionEngine.ts` | **核心**：触发规则引擎 + 今日行动生成 + 增量检查 |
| `salesStageClassifier.ts` | **核心**：轻量AI阶段分类（7阶段，≤500token/次） |
| `salesDbService.ts` | 销售库5表CRUD + migration |
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
| `crmParseService.ts` | CRM 群扫描：银行到款/认领归属/物流批量/发票归档/截图OCR |
| `crmParseRules.ts` | 纯规则库：银行文本/物流批量/发票名/归属简语/私聊成交词表 |
| `crmImportService.ts` | AI 意向判断→CRM 自动导入 + 历史回填 + 内部群成员收集 |
| `crmDeepAnalysisService.ts` | 资深销售助理七板块深度分析（用户自研 prompt 固化） |
| `crmQuoteService.ts` | AI 报价：私聊需求→产品库选型→报价单草稿 |
| `crmDocGenService.ts` | docx 生成（docxtemplater，报价单/合同/开票信息单） |

### 前端 `src/`
| 文件 | 说明 |
|------|------|
| `pages/TodayActionPage.tsx` | **首页**：今日行动卡片流 |
| `components/sales/SalesContextStrip.tsx` | 聊天页上下文条 |
| `components/sales/CustomerCard.tsx` | 客户画像卡片 |
| `components/sales/ReplySuggestion.tsx` | 回复建议 |
| `pages/CustomerListPage.tsx` | 客户列表+导出 |
| `pages/FollowUpPage.tsx` | 跟进待办 |
| `pages/KnowledgeBasePage.tsx` | 知识库管理 |
| `pages/SalesReportPage.tsx` | 复盘/报表 |
| `pages/SalesDashboardPage.tsx` | 仪表盘（移至/dashboard） |
| `components/sales/ExtractScriptDialog.tsx` | **话术提炼弹窗**（单选/批量双模式，三步流程） |
| `pages/CrmWorkbenchPage.tsx` | **CRM 工作台**：合同+客户双 tab、档案一屏、深度分析/AI 报价/建合同/删除、阶段筛选 |
| `pages/CrmReviewPage.tsx` | **确认中心**：归属/物流/到款/发票四队列 + 扫描群配置（含来源显示/金额输入） |
| `pages/SalesFunnelPage.tsx` | **销售漏斗**：阶段分布 + 转化率 + 近 7 天意向趋势 |
| `stores/todayActionStore.ts` | 行动清单store（解析 sig.analysis JSON 注入卡片） |
| `stores/` (其他5个) | dashboard/customerList/customerProfile/followUp/knowledge/salesReport |

### 测试脚本 `scripts/`
| 文件 | 说明 |
|------|------|
| `crm-workbench-test.ts` | CRM 业务闭环单测（**48 项**：归属/签约/导入/聚合/成交/删除/到款审核/去重） |
| `crm-golden-test.ts` | 规则 golden 测试（**31 项**，含 isDealSignal） |
| `crm-claim-test.ts` | 货款认领测试（17 项） |
| `crm-cleanup-orphans.ts` | 孤儿客户清理 + 备份（一次性脚本） |

### 已删除
- `cloudControlService.ts`（向上游上报使用统计，隐私风险）
- `salesAlertService.ts`（废弃死代码）

---

## 7. 已知坑铁律（摘要，详见 MAINTENANCE.md）

1. **永不 push origin**（origin=上游），只用 backup
2. **不加 `app.disableHardwareAcceleration()`**（会导致闪退）
3. **WCDB 时间戳是秒**，JS Date 是毫秒
4. **`enqueueSalesTask` 只加最外层**，内部绝不再 enqueue（死锁）
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

---

## 10. 未完成 / 待办

| 优先级 | 项目 | 说明 |
|--------|------|------|
| **P0** | **提交未提交改动** | 工作树 28 个文件（§2.4/§2.5）→ `git add` + 提交到 `backup`（⛔ 永不 push origin） |
| **P1** | **确认中心 P2 增强** | 用户审出的剩余项：已处理历史列表、到款/归属两队列合并为一个入口、发票金额自动解析（PDF/文本） |
| **P1** | **验证确认中心修复** | 用户用几天实测 approvePayment/自动挂合同/来源显示是否顺畅，有反馈再迭代 |
| P1 | 深度分析结果缓存 | 同客户 N 小时内不重复调 AI（避免反复点重复花费），可加缓存列 |
| P1 | CRM 客户黑名单 | 删除后的客户若会话还在、AI 见解再标有意向会被重新导入——需黑名单机制 |
| P1 | 今日行动卡深链客户档案 | 行动卡客户名点击 → 跳 CRM 客户档案一屏 |
| P1 | 话术提炼优化 | v2已完成基础版，待优化：提炼结果反馈闭环、提炼历史去重 |
| P1 | 触发规则配置UI | v1硬编码，验证有效后开放 |
| P1 | 灵感信箱合并到今日行动 | 等 insightService 与规则引擎产生实际冲突后再评估 |
| P2 | 优先级公式重设计 | 等 customer_value_score 有真实数据源后 |
| P2 | 知识库增量补充 | 已有353条产品参数，需持续补充叉车行业话术/FAQ |
| 大后期 | CRM双向同步 | 仅预留字段 |
| 大后期 | 向量数据库 | 知识库>1000条时考虑 |

---

## 11. 给接手者的下一步

1. **读本文档** → 读 `MAINTENANCE.md` → 读 AGENTS.md
2. **跑起来**：`npm install && npm run dev`（开发模式）
3. **先提交**：工作树 28 个未提交文件（§2.4/§2.5 增量）→ 提交到 `backup`
4. **跑单测确认基线**：`npx tsx scripts/crm-workbench-test.ts`（48/48）、`npx tsx scripts/crm-golden-test.ts`（31/31）、`npx tsx scripts/crm-claim-test.ts`（17/17）
5. **测试今天的新功能**：CRM 工作台（深度分析/阶段筛选/删除）、确认中心（确认到款→自动归属、卡片来源、发票金额）、销售漏斗页
6. **测试话术提炼**：知识库页 → 选联系人设日期区间 → 提炼 → 看效果
7. **继续开发**：按 §10 待办优先级推进

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
