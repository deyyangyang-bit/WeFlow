# GPT-6 适配变更说明

原 AGENTS.md 完整备份，仅作历史证据，不作为当前执行指令。历史测试和阻塞不能代替当前验证。

# AGENTS.md — WeFlow AI 销售助手 · Agent 启动指南

> **本文件被 .gitignore，仅本地存在。** 新会话/新 agent 打开后先读本文件，再接手。
> 最后更新：**2026-09-08（Hermes 任务 4 交付验收）**——任务 4 代码补修完成，但真实模型 HTTP 402、macOS 签名/公证仍是发布阻塞；当前结论必须写「代码完成，试点门槛未全部通过」。需求权威 = `docs/规划/weflow-hermes-PRD-v3.4.md`，数据权威 = `docs/DATA-CONSTITUTION.md`。P0 时代历史进度详见 `docs/HANDOVER.md`。

## 必读顺序（3分钟接上）

1. **本文件**（你正在读）— 铁律 + 进度 + 下一步
2. `docs/规划/weflow-hermes-PRD-v3.4.md` — **需求权威**（PRD-v2 已归档 `docs/归档/prd旧版/`，仅供参考）
3. `docs/DATA-CONSTITUTION.md` — **数据权威**（11+1 对象契约 / 术语表 / SSOT / 写入资格；撞名与口径以它裁决）
4. `docs/规划/weflow-hermes-Phase0-启动细化.md` — Phase 0 执行依据（D2-D8 任务 / 排期 / 坑清单 10 条）
5. `docs/HANDOVER.md` — 全局交接百科（架构/数据模型/文件地图/功能清单）
6. `DEVELOPMENT.md` + `docs/MAINTENANCE.md` — 工程规范 / 打包避坑

## 铁律（违反任何一条都会出事）

- ⛔ **永不 `git push origin`**（origin=上游 WeFlow），只用 `git push backup main`
- ⛔ **不加 `app.disableHardwareAcceleration()`**（闪退真凶）
- ⛔ **`enqueueSalesTask` 只加最外层入口**，被排队函数内部绝不再 enqueue（死锁）
- ⚠️ **`ELECTRON_RUN_AS_NODE=1` 会让 Electron 当 Node 跑**（GUI 消失、`--version` 报 v24.17.0）。vite.config 已自动清除；**勿再删 node_modules/electron/dist 重建**（那是误判，见 HANDOVER-20260731 §四）
- ⚠️ WCDB 时间戳是**秒**，JS Date 是**毫秒**
- ⚠️ 单一固定 system prompt，差异放 user prompt（API 缓存命中率）
- ⚠️ koffi 版本精确锁定 3.1.0，win 交叉编译前必须 `npm install @koromix/koffi-win32-x64@3.1.0 --force`
- ⚠️ 打包前必杀残留进程（否则 packaging 死锁）

- ⛔ **SSOT 单一事实源**：字段语义与对象映射只认 `docs/DATA-CONSTITUTION.md`（对象名↔物理表对照：quote=quotation 等）；禁止自建第二套表/第二套语义；新表先入宪（宪法 §3 登记）再建
- ⛔ **AI 三档写入纪律**：A=auto / B=proposed→人工 confirm / C=request→审批；AI 无 publish 权限，合并/归属变更/发布永不自动执行
- ⛔ **Feature Gate 七问**：不在当前 Phase 清单的需求先答七问（`docs/规划/weflow-hermes-开发流程计划.md` 纪律 #11），答不过进 Backlog
- ⚠️ crmDb 新表必须注册 ENTITIES 白名单（crmDbService.ts:194，漏注册静默失败前科）；salesDb 无此机制，直接建表
- ⛔ **落盘必须原子写**：sql.js persist 及任何写 .db 文件一律走 `atomicWriteFileSync`（tmp → fsync → rename，electron/services/atomicPersist.ts）；**禁止 writeFileSync 直写目标文件**（先截断为 0 再写入，窗口期被 kill = 磁盘 0 字节 → 数据全灭，2026-09-03/04 sales 库两次实证，HANDOVER §2.52）；db 文件存在但 0 字节/打不开时禁止静默初始化空库，必须走启动守卫（留证 → 自动备份恢复 → 无备份才空库 + ERROR 日志）

- ⚠️ **Hermes 任务 4 交付门槛**：Utility 正式产物是 `dist-electron/hermesUtility.js`，打包后只允许出现在 `Contents/Resources/hermes/hermesUtility.js`；协议版本不一致必须 `protocol_mismatch` fail closed，二次崩溃才是 `agent_unavailable`，缺资源是 `agent_missing`。真实联调必须复用 `getAiModelConfig` / `isAiConfigured`，禁止读取底层 store、解析 `safe:` 或二次解密；完整 Electron stdout 不得保存为证据。DMG/ZIP 必须从提取物启动；本机能启动不等于 codesign/spctl 通过。Windows 未真机实测时必须如实标注。

## 进度（PRD v2 三周计划）

| 周 | 内容 | 状态 |
|---|---|---|
| P0 | 今日行动引擎 + 阶段分类 + 侧边栏瘦身 + 删死代码 | ✅ 完成 |
| P1 | 周复盘 + 知识库CSV导入 + 话术联动 | ✅ 完成 |
| P2 | 聊天页上下文条 (SalesContextStrip) | ✅ 完成 |
| 打包 | Mac + Windows 验证 | ⚠️ 代码OK，electron-builder 环境死锁需手动 |

## 2026-08 增量（跟单中心零操作化 + 行动卡一键闭环）

- **自动确认引擎** `crmAutoConfirmService.ts`：纯判定 evaluate×4（归属/到款/物流/发票），高置信自动、低置信留人工；硬前提=挂 active contract（**钱不消失**），引擎从不创建实体；三触发点（扫描完成钩子 + 60s 调度器 + 前端按钮）——**2026-08-24 起三者均已移除/停用**，仅保留 `crm:autoConfirm:run` IPC（无前端调用者，不调度）；每批一次快照 + `auto_confirm_log` 审计；可撤销；**2026-08-24 起前端入口移除（不设计 AI 判断），销售手动认领——自动确认历史行（confirmed 未挂客户合同）在每日到款清单标「请补认领」**
- **行动卡一键闭环**：AIActionCard「打开聊天」+「复制话术」；CrmWorkbenchPage 客户列表/档案「打开聊天」
- **Electron 闪退真因修正**：是 `ELECTRON_RUN_AS_NODE=1` 环境变量（见上铁律），不是 dist 损坏
- 新增测试 `scripts/crm-autoconfirm-test.ts`（56 项）；`npm run test:autoconfirm` 或 `npx tsx scripts/crm-autoconfirm-test.ts`
- 配置：`crmAutoConfirmEnabled`(true) / `crmAutoConfirmThreshold`(0.8) / `crmAutoConfirmInvoiceDocgen`(false)，设置页可改

## 2026-08 增量（文档模版复刻 §2.7）

- **真实模版**：`resources/crm-templates/{quotation,contract}.docx`（docxtemplater 标签已注入，提交进仓库）；改动用 `python3 scripts/build-crm-templates.py`（读 `/tmp/crm-tpl-inspect/` 真实样板副本）
- **新 doc 类型 `invoice-app`**：exceljs 生成开票申请单 `.xlsx`（合并单元格 + `=H{r}*G{r}` 公式 + 合计大写/小写），`electron/services/crmDocGenCore.ts` 纯核心 + `moneyCn.ts` 金额大写，`crmDocGenService.ts` 降为 electron 薄壳（`generateDoc` 已 async）
- **甲方开票信息 = 系统录入**：工作台新建合同表单 + 合同详情「甲方开票信息」编辑块，存 `contract.custom_fields`（`buyer_addr/buyer_bank/buyer_account/tax_no/buyer_phone`）；跟单中心发票待开有「开票申请」按钮
- 新增测试 `scripts/crm-docgen-test.ts`（68 项）；`npm run test:docgen`
- 坑：exceljs 4.4 `ws.model.merges` 是范围**字符串**数组；改主进程代码后 vite 不自动重启 Electron，需手动重启

## 2026-08 增量（CRM 零操作改造）

- **信息自动填充引擎** `crmEnrichService.ts`（装配）+ `crmEnrichCore.ts`（纯核心，零 electron）：AI 从聊天/见解/画像提取 12 字段；≥`crmEnrichAutoApply`(0.85) 自动写入，[`crmEnrichThreshold`(0.7), autoApply) 进 CRM 工作台客户 tab「信息待确认」队列，<0.7 丢弃；每字段带 来源+置信度+证据（`account.enrich_meta`）
- **信息待确认迁至工作台**（57c4e0f）：裁决入口与 AI 补全同页闭环（补全 → 待确认 → 采纳/放弃），跟单中心不再展示；工作台客户 tab 顶部可折叠区块，行内采纳/放弃/查看档案，`openInfoCustomer` 深链到客户档案
- **铁律**：引擎绝不创建客户（只充实已导入 account）；手动编辑过的字段锁定，AI 永不覆盖（`crm:enrich:manualSet`）；执行入口一律 enqueueSalesTask
- **触发点**：见解导入后（insightService）+ 画像导入后（main.ts）+ 档案「AI 补全」按钮 + 「批量 AI 补全」存量回填（限额）
- **客户 360**：字段卡（AI/手动角标，点击编辑即锁定）+ 动态时间线（CRM 操作+AI 见解混排）+ 深链 `/crm?tab=customer&id=` 与 `?stage=`（漏斗下钻）；新建合同零操作化（选客户自动带出，不重复建 account）
- **可视化**：`statsOverview` + 工作台统计卡 + ECharts 三图 + 漏斗真图下钻
- 新增测试 `scripts/crm-enrich-test.ts`（48 项）；`npx tsx scripts/crm-enrich-test.ts`

## 2026-08 增量（侧边栏导航收口 7 模块，09d5600）

- **产品收口第一步**：20 项平铺 → 7 个一级模块（今日行动/聊天/CRM/跟单/AI·知识/报表/系统）
- **数据驱动** `Sidebar.tsx`：`NAV_GROUPS` 模块级数组；多子项组（CRM/AI·知识/系统）可展开分组（`openGroups` state，CRM+AI 默认展开、系统收起），单子项组直接渲染；collapsed 态 flatMap 平铺图标不变
- **改侧边栏前先看 `Sidebar.tsx` 的 `NAV_GROUPS`**——新增/调整导航入口改数组即可，不手写 NavLink

## 2026-08-20 增量（Customer 360 统一时间线，6c439bf）

- **客户档案「动态时间线」一条流**：合同/到款/物流/报价/归属（activity_log 六实体）+ 线索流转（lead_activity）+ 商机事件（opportunity_event）+ AI 见解
- **`crmDbService.accountTimeline(accountId)`**：8 个 UNION ALL 分支聚合（经 contract→account、allocation→payment_record 关联链），按时间升序返回 `{ at, kind, text }`；**不建统一表**，改查哪张表先看这个方法的 UNION 分支
- **handler**（`crm:customer:profile`）：activities 用 `accountTimeline().reverse().slice(0, 40)` 倒序 40 条
- **前端**：`CrmWorkbenchPage.tsx` 时间线四类标签 `TIMELINE_KIND_LABEL`（crm 绿/lead 橙/opportunity 蓝/insight 紫）；原「最近见解」块已删（并入时间线）
- **测试** `scripts/crm-timeline-test.ts`：10 项聚合/排序/隔离验证，跑 `npx tsx scripts/crm-timeline-test.ts`

## 2026-08-20 增量（SLA/Action 接通，5ba531b + 678e3f0 置顶/提分）

- **首触 SLA 卡自动进今日行动**：`scanLeadSla` 挂入 `runFullScan`（每日 08:00）+ `getUnifiedSignals`（今日行动页主数据源，**不是** getTodayActions）两个扫描周期——改 SLA 相关先看这两处的调用；SLA 卡 `created_by='sla'` 独立于 `action_engine`，runFullScan 重扫不误伤
- **虚拟卡去无效按钮**：`AIActionCard` 的 `isVirtualTodo` = `todo:`/`lead:`/`logi:` 前缀 → 隐藏「打开聊天」（无真实微信会话）；SLA 卡联系方式在 displayName（脱敏）
- **排序埋没修复（678e3f0）**：`getUnifiedSignals` 排序对 `lead:` 前缀 +1000 置顶；`scanLeadSla` 提分 `min(140, 80+min(hours,30))`——SLA 卡不再被 110+ 分库存卡埋没（前端 PAGE_SIZE=10 分页）
- **展示策略再收敛（c90e6c9）**：SLA 首触卡**移出主卡流**，只在右侧 TodoSidebar 散任务清单展示（用户实测反馈左右重复）——`getUnifiedSignals` 跳过 `sla_lead`、删 `lead:` 虚拟卡与置顶 boost；完成闭环走 `completeTodo`→`crm:lead:slaComplete`（卡 done + lead→CONTACTED + 流水），普通待办仍 todoUpdate
- **测试** `scripts/crm-sla-action-test.ts`：11 项（触发/幂等/不误伤/主卡流不含 lead: 卡/回写），跑 `npx tsx scripts/crm-sla-action-test.ts`

## 2026-08-20 增量（AI 回写 model/sourceId 溯源，223c158）

- **PRD§23 可追溯**：enrich_meta 每条记录带 `model`（生成模型名，读 `getAiModelConfig(cfg).model`）+ `sourceId`（依据的聊天消息 messageKey）——改 enrich 相关先看 `EnrichFieldMetaEntry`（crmDbService.ts）+ `mergeEnrichFields` 四处透传
- **注入点**：`enrichCustomer` 置信分级循环给每条 AI 结果打 `{model, sourceId}` 标签；`gatherMaterials` 遍历聊天时记最后一条有效消息 messageKey；`applyEnrichment` JSON 序列化自动落库
- **测试** `scripts/crm-enrich-test.ts`：61 项（新增 1d/1e/4b/5b/10e/10f 断言透传+落库），跑 `npx tsx scripts/crm-enrich-test.ts`

## 2026-08 增量（报价跟进 R7）

- **报价信号** `crmParseRules.parseQuoteSignal`：销售侧消息 金额+(报价意向词|设备词)；排除询价/闲聊小额/型号数字；语音走转写缓存（未转写不识别）
- **quote_signal 表**（crmDb）：私聊扫描记录（msg_key 幂等），客户回复自动关闭
- **R7 规则**：[24h, 7d] 未回复报价 → 高优先级行动卡（含金额/型号/时长）；R1 阈值 3→2 天兜底
- 修复：批量 AI 补全失败（AI 配置注入 shim 缺全量键 → setEnrichAiConfig）；回填失败逐客户记 WARN

## 2026-08 增量（单机线索流转 §2.12）

- **线索池** `/leads`：Excel/CSV 导入 + 文本粘贴 → 手机号/微信号清洗 → 同批/跨批去重 → 首触 SLA 24h（配置 `crmLeadSlaHours`，导入时锁定）→ 今日行动 SLA 卡（虚拟 sessionId `lead:<id>` 进统一信号流）→ 完成/跳过 → 转客户
- **lead 表**（crmDb）：`contact_normalized`（手机号归一）+ `wechat` 双轨（both 时手机号为主；⚠️ `contact_wechat` 仅是旧壳表迁移兼容回退，非现行列名）；转化时写 `account_id` 硬链接 + 置 status=ACCOUNT；状态机 NEW→CONTACTED→WX_ADDED→ACCOUNT + DEAD（死因必填，REOPEN 回 NEW）；activity_log 全链路
- **跨库铁律**：先 crmDb 后 salesDb；SLA 卡 `follow_up_task(trigger_type='sla_lead', source_id=lead.id)` + partial unique index `idx_ft_sla_once` 幂等 + 启动兜底 scanLeadSla 自愈
- **死因预设** `DEFAULT_DEAD_REASONS`（无效/未接通/加微未回/竞品/价格）；来源预设 `crmLeadSourcePreset`（抖音,视频号,小红书，逗号分隔可配）
- 新增测试 `scripts/crm-lead-test.ts`（53 项）；`npx tsx scripts/crm-lead-test.ts`；tsc 零错误 + vite build + mock-electron IPC smoke 14/14
- 设计稿：`docs/设计-单机线索流转模块.md`（已实现）；团队版演进见 `docs/归档/prd旧版/PRD-团队版-WeFlow+Twenty底座.md`

## 2026-08 增量（跟单中心 + 物流跟单闭环 §2.13）

- **改名**：确认中心 → **跟单中心**（侧边栏/页面/设置页/Workbench 通知文案；`/crm-review` 路由、`crmAutoConfirm*`/`crmEnrich*` 键名不变）
- **物流跟单闭环**：物流群发货列表落库（单号幂等）→ 跟单中心待认领（认领销售输入 + 选合同/自动匹配）→ 已认领待签收（超期标红「超期 N 小时」+ 确认签收）→ 已签收（折叠）
- **今日行动 R8**：发货超 `crmLogisticsOverdueHours`(24，1-168 可调) 未签收 → 物流跟进卡（虚拟 sessionId `logi:<id>`，点完成=确认签收，三一致）
- **启动补扫**：物流群 last_scan 回退昨天 00:00，`processed_msg` 幂等补扫前一天
- 新增测试 `scripts/crm-logistics-test.ts`（25 项）；`npx tsx scripts/crm-logistics-test.ts`
- **二期预留**：`markLogisticsSigned` + 超期阈值就位，接快递 100 API 自动查签收
- **2026-08-19 增量**：物流解析尾部容忍（催单/备注同行可识别，`LOGI_LINE_RE` 尾随 `(?:\s+\S.*)?`）；物流三区分页每页 10 条 + 待认领改最新在前；认领/签收行内反馈 + 无合同引导横幅 + 未选合同按钮禁用（修复「点击认领没有反应」）；golden 45/45 + 全系回归通过

## 2026-08 增量（AI 销售助手 V1 P0：商机 + 意向评分 + 风险预警 §2.14）

- **商机闭环**：`parseBuySignal` 私聊采购信号（吨位/设备/数量/金额）→ `opportunityUpsertBySignal` 同产品累积/新建（name=`<产品>采购`）→ 阶段顺推（了解→比价→决策）→ 成交 won / 流失 lost 自动关单；`insightService` 客户阶段联动 `syncOpportunityStageByAccount`
- **意向评分 0-100**：`intentScore.ts` 纯核心（阶段基数+近期事件+14天衰减+商机加权，封顶 100）→ `salesDbService.intentScore` 跨库装配 → 前端分数条 + 详情「评分依据」factors
- **风险预警**：`parseRiskSignal`（竞品/价格/服务，仅客户消息）→ `crm_risk` 表（同类型幂等累积 + severity 取高）→ 商机详情风险区 + 确认处理
- 新页面 `/opportunities`（三处必改已做：App.tsx / Sidebar.tsx / RouteGuard.tsx）；IPC `crm:opportunity:*` + `crm:risk:*`
- ⚠️ **坑**：`create()` 走 `isEntity` 白名单，新表必须注册进 `ENTITIES`（`crm_risk`/`opportunity_event` 漏注册会静默失败，本次已修）
- 新增测试 `scripts/crm-opportunity-test.ts`（**45/45**）；`npx tsx scripts/crm-opportunity-test.ts`
- **已处理（11359fe）**：销售漏斗深链 bug（customer_profile 中文 stage vs account.sales_stage 英文双轨 → 漏斗点「比价」空列表），统一 customer_profile.stage 为唯一阶段真源

## 2026-08-20 增量（漏斗数据修复）

> ⚠️ **已被下方「漏斗改造」取代**（转化率口径从「相对顶部」改回「相邻相除」、阶段语义收口到 `shared/salesStage.ts`）。本节仅作历史留档。

- **转化率口径**：改为相对漏斗顶部「了解」的比例（比价 87% / 决策 11% / 成交 34% = 赢单率）。原算法阶段间相除，快照非队列，成交(24)>决策(8) 时会算出 300% 失真
- **近 7 天**：由「AI 扫描标签条数」改为「新增进漏斗客户数」（`intentTimeline` 按客户首次打标日期去重）。原统计同客户重复扫描重复计数（08-17 一天 81 条是扫描量，实为 41 个新客）
- **顺带修复**：`salesDbService.initialize` wasm 路径加根 node_modules 兜底（同 crmDbService 模式），修复 dev/测试态独立初始化 salesDb 失败
- 新增测试 `scripts/funnel-test.ts`（**5/5**）；`npx tsx scripts/funnel-test.ts`
- **深链 bug 已修（11359fe）**：漏斗点「比价」→ CRM 筛「已报价」空列表（account.sales_stage 无 quoted，是 contacting/negotiating 英文双轨）。统一为 customer_profile.stage 唯一真源：`crm:customers` 附带 `profile_stage`（session_id 关联），CrmWorkbenchPage `stageLabel` 优先取 profile_stage，SalesFunnelPage 下钻传原始中文阶段名。实测 customer_profile 了解71/比价62/成交24/决策8 全部命中，旧口径 sales_stage 无 quoted 必空

## 2026-08-20 增量（客户名真相源修复：微信号名回填微信真实备注，已提交 `ee4ce2f`）

> 背景：客户工作台反馈「重复客户 + 客户名不对」。调查结论——数据层 100% 无重复（「一路向钱」仅 1 条 account id=75，重复观感来自该客户 enrich_meta 的 2 条 pending 信息在顶部「信息待确认」区与列表卡同时出现）；「名称不对」根因 = 系统显示名是微信号，WCDB 里有真实微信备注但没被取到。用户确认修复方向：**回填真实备注，保留原样**（保留日期前缀等微信备注原样）。

- **根因**：`resolveInsightSessionDisplayName` 旧 `looksLikeWxid` 只匹配 `^wxid_[a-z0-9]+` 与 `@chatroom`，**漏掉自定义微信号**（字母开头 5-20 位，如 `wan923121735`）→ fallback 为微信号时被直接采用，不查 WCDB 备注
- **共享判别层 `shared/wechatId.ts`**（新建）：`isSessionIdLike(text)` 覆盖三类微信号形态（wxid_ 前缀号含下划线后缀 / 自定义微信号 / 群号），中文名/日期前缀/电话/数字开头/超短/空均不命中
- **源头修复**：`resolveInsightSessionDisplayName` 微信号格式优先查 `chatService.getContactAvatar`（`remark || nickName || alias`）再查 sessions 缓存，判断全用 `isSessionIdLike`
- **存量回填**：`crm:customers` handler 惰性触发 `backfillWxidDisplayNames()`，幂等——只处理 name 为微信号格式的 account（真实库 dry-run 确认 **13 个**，全部有 WCDB 真实备注）；回填写 `account.name` + `customer_profile.display_name` 双轨；WCDB 未连接返回 -1 不置位，下次打开重试
- **回填安全**：sql.js 内存库 persist 只在写操作后 500ms 落盘、外部改文件会被应用内存库覆盖 → 回填必须走应用自身链路，禁止直接改库文件
- 新增测试 `scripts/wechat-id-test.ts`（**18/18**）；`npx tsx scripts/wechat-id-test.ts`

## 2026-08-20 增量（漏斗改造：历史累计流转 + canonical 语义层，已提交 `ef100ed`）

- **B（核心）历史累计流转漏斗**：`funnelStats(days)` 重写为「窗口内**曾进入过**某档位的去重客户数」，统计单位永远是 `session_id`（customer_id），**绝不按 `intent_tag_log` 行数**。时间窗口可切换（近30天/近90天/全部，`days=0`=全部历史）。
- **C 逐级转化率**：相邻档位相除（了解→比价→决策→成交），客户可跳级进入故可 >100%，除零为 0。
- **canonical 语义层 `shared/salesStage.ts`**（前后端共用，零依赖）：`normalizeStage`（中英→canonical 幂等）、`stageLabel`、`funnelBucket`（new→了解 / dormant→流失 / unknown→未知）、`stageToFunnel`。DB 仍存原值不迁移；UI/统计统一归桶。`salesActionEngine`/`salesReportService` 已改从 shared 导入（本地映射删除）。**「比价」定标 `quoted`**；CRM 侧 `STAGE_TO_CRM`/`BACKFILL_STAGE_TO_CRM` 把比价→negotiating 是 CRM `sales_stage` 简并枚举，保持不动。
- **A 下钻修复（统一归桶）**：漏斗点阶段 → 传中文档位名；`CustomerWorkspacePage` 新增 `rowStage(c)` = `stageToFunnel(profile_stage || sales_stage)`，过滤/下拉/徽章全部走它（英文 `quoted` 客户也能命中「比价」）；深链过滤前再过一次 `stageToFunnel`（幂等防御旧值）。**语义**：历史漏斗计「曾进入」，下钻列表是「当前阶段为该档位」，穿过但已流失/删除的客户不在列表属正常。
- **前端漏斗页**：窗口 toggle + ECharts 真漏斗（4 档 sort:'none'，label 带相邻转化率）+ 当前客户状态小卡片（`currentDistribution` 6 档）+ 每天进入各档位去重客户数堆叠趋势。
- 新增断言 `scripts/funnel-test.ts` **40/40**（英文阶段/中英归一/独立去重/跳级 >100%/时间窗口/当前快照/逐日补零/除零 + P0-1 证据 9 条）；`npx tsx scripts/funnel-test.ts`

## 2026-08-20 增量（今日行动新建待办）

- **手动待办进信号流**：`getUnifiedSignals` 加 manual 分支——手动待办绕过沉默天数过滤（事实驱动），无客户用虚拟 `todo:<id>` 独立卡（动态计算不落库）、绑客户并入客户卡；`completeUnifiedSignal` 加 `todo:` 前缀分支按 `getTask` 关单。老页面 FollowUpPage 保留（后于职责分工 §2.19 归档）
- **今日行动「新建待办」**：header 按钮 + 弹窗（标题必填 + 客户搜索下拉可选 + 截止时间可选）；`todayActionStore` 加 todos 状态 + `createTodo`/`completeTodo`/`fetchTodos`，主卡流与侧栏同源同步（fetchToday 顺带刷新）
- **TodoSidebar 可勾选完成 + 分页**：数据源切 store，checkbox 点击即完成；主卡流完成也同步侧栏；列表分页 10 条/页；进度条改纯视觉轨道（原窄段内嵌 nowrap 文字溢出重叠，真实库 pending 106/done 73/total 1389 必现），分母排除 superseded/ignored 防虚高
- **AIActionCard 适配**：`todo:` 虚拟卡隐藏「打开聊天」+「AI 分析」（无客户无上下文），保留完成/跳过
- 新增测试 `scripts/todo-followup-test.ts`（**11/11**）；`npx tsx scripts/todo-followup-test.ts`
- ⚠️ 坑：`todoUpdate` 白名单不含 session_id → 虚拟 key 必须在 getUnifiedSignals 动态计算，不能靠回填 session
- **跟进待办页同客户去重 + 分页**（`95c9dd6`）：FollowUpPage 同 session_id 多条待办合并一组（主卡=最高优，其余折叠展开逐条操作），无 session 手动待办独立；按去重后组数分页 10 条/页；纯函数 `src/utils/followUpGroup.ts` + `scripts/followup-group-test.ts`（**10/10**；随职责分工 §2.19 一并归档删除）

## 2026-08-20 增量（今日行动/待办职责分工，1aefef4 + d5b9f62）

- **去重**：同一批 `follow_up_task` 曾三处展示（主卡流按客户合并 / TodoSidebar 逐条平铺含 R1-R8 / FollowUpPage 老页）。收敛为：**主卡流 = 客户动作唯一入口；TodoSidebar = 散任务清单**
- **散任务判定**：`TodoSidebar` 的 `isScatteredTask` = `!session_id`（无客户手动/SLA 卡）或虚拟前缀 `todo:`/`lead:`/`logi:`（物流卡）；有客户会话的行动任务只在主卡流。统计口径同步只统计散任务。**SLA 卡已在主卡流排除（`getUnifiedSignals` 跳过 sla_lead，`c90e6c9`）**，完成闭环走侧栏 `completeTodo`→`crm:lead:slaComplete`
- **FollowUpPage 归档**：删组件 + `/follow-up` 路由 + PUBLIC_ROUTES 项 + `followUpGroup.ts` + 孤儿 `followUpStore` + 失效测试 `followup-group-test`；老页唯一价值「新建待办」今日行动 header 已有
- **跳转收口**：Dashboard 两卡跳 `/home`；Sidebar 删 follow-up 死代码；App 加 `path="*"` fallback 回落 `/home` 防旧链接空白

## 2026-08-20 增量（客户名称统一 + 同名不跨会话 + logi 闭环，068a403）

- **名称双轨读取侧统一**：`account.name` 导入时刻冻结 vs `customer_profile.display_name` 持续刷新 → 各展示点统一「profile 名优先、account.name 兜底」。工作台客户表格/下拉（`crm:customers` 附加 `profile_display_name`）+ 周报 topContacts 兜底链换序；主卡流/客户列表本就读 profile 名
- **同名不跨会话**：`matchAccountByName(name, { excludeSessionId })` 新增参数，**仅 `enrichCustomer` 使用**（AI 充实只写已存在客户，防多个「张总」串客户——A 会话误充实 B）；`importCustomerFromProfile` 名称兜底**保留幂等合并语义**（同人多微信号合并，workbench 测试 7d 约束，勿再加排除）
- **logi 物流卡签收闭环**：`completeTodo` 对 `logi:` 卡走 `sales.actionCompleteUnified`（复用 `completeUnifiedSignal` logi 分支：卡 done + `markLogisticsSigned` + activity），与跟单中心「确认签收」一致；此前只标卡 done、物流单仍是 shipped
- 新增测试 `scripts/crm-name-fix-test.ts`（**5/5**）；`npx tsx scripts/crm-name-fix-test.ts`

## 2026-08-20 增量（AI 客户工作台收口，本轮未提交）

- **两客户入口合并**：`CustomerWorkspacePage`（/customers）取代 CustomerListPage + CrmWorkbenchPage 客户 tab。行动优先三视图——「值得跟进」= `getUnifiedSignals` 全量 signals（过滤 `todo:`/`logi:`/`lead:` 虚拟前缀）按 priorityScore 排序；「AI 新发现」= 仅 24h 未读洞察信号；「全部客户」= 有信号置顶 + 搜索/阶段筛选。客户卡片流 + 一键「完成」（`sales.actionCompleteUnified` 闭环）+ 点击展开 360 档案（字段编辑锁定/AI 画像/时间线/AI 下一步/待办/合同回款/深度分析/AI 报价/删除）
- **CrmWorkbenchPage 瘦身为合同页**：删客户 tab/handlers/深链（`id`/`sid`/`stage` 迁至 /customers）；新增 `/crm?account=<id>&new=1` 深链（工作台「建合同」跳入预选客户 + 带出开票信息）
- **归档**：`CustomerListPage.tsx` + `customerListStore.ts` + `CustomerListPage.scss` 删除（git 历史保留）；`CustomerCard` 保留（ChatPage 用）；`sales.customerExport` 保留（工作台「更多 → 导出全部客户 Excel」）
- **深链迁移**：`/crm?tab=customer` → `/customers`（AIActionCard `?sid=` / SalesFunnelPage `?stage=` / InsightInboxPage `?id=`，参数名不变）
- **Customer 360 Timeline 验证结论**：现有 `accountTimeline` 8 分支 + 前端 activities+insights 混排已满足，仅搬页保留不重写
- 验证：`npx tsc --noEmit` 零错误 + `npx vite build` + 全系回归通过（详见 HANDOVER §2.21）；后端无改动、无新增 IPC

## 2026-08-20 增量（物流认领到客户：无合同客户可认领物流，本轮未提交）

- **数据模型**：`logistics` 表新增 `account_id INTEGER` 可空列，与 `allocation`（到款归属）同构——`account_id`=归属客户（核心），`contract_id`=可选上下文。Migration 在 `logisticsTrackCols` 追加
- **认领路径全接入**：①手动认领（客户下拉必选 + 关联合同可选 + 新客户名 input「新建客户并认领」→ `accountEnsure` 去重建档）；②自动匹配按钮（`logisticsCandidates` 返回按 `cand_kind` 标记的 contract/account 候选，viaShip 确定性收件人命中无合同客户 → 账户级候选）；③扫描自动认领（`autoLinkLogisticsByReceiver` 无合同也认领到客户，顺带补写 `auto_linked_by` + 记 activity）
- **确认中心自动确认保持保守**：`evaluateLogistics` 过滤 `cand_kind='contract'`——无合同物流保持「无候选合同」待人工（铁律：自动确认必须挂 active contract，与到款归属一致）
- **下游覆盖**：`pendingLogisticsOverdue` JOIN 改 `COALESCE(c.account_id, l.account_id)`（R8 超期信号覆盖账户级物流）；`accountTimeline` 物流分支加 account_id 匹配（客户 360 出现「单号 X → 客户 Y」）；`undoLogistics` 清 account_id；`deleteAccount` 级联清理账户级物流
- **IPC**：`crm:logistics:link(id, opts)` 签名升级（`accountId?`/`contractId?`/`ownerSales?`），preload + electron.d.ts 同步；无新增 IPC
- 验证：`npx tsc --noEmit` 零错误 + `npx vite build` + 全系回归通过（logistics 37/37、autoconfirm 58/58，详见 HANDOVER §2.22）

## 2026-08-20 增量（物流群扫描失效修复：getMessages 升序 + 传 startTime 扫增量，未提交）

- **现象**：crmParse 扫「艾驱安能物流跟踪群」自 8月5日 18:50 起失效，日志一直 `scanned=0`（数据源正常，HTTP API 直拉全是新消息）
- **根因**：`chatService.getMessages` 内部 `normalizeMessageOrder` 会把消息**升序重排（旧在前）**（chatService.ts:3205），而 `crmParseService.scanAll` 假设倒序返回、`if (ms <= lastScan) break`——第一页第一条就是最旧的 7月20日消息 → 直接 break，把排在后面的 8月5日 后增量全漏掉
- **修复**（crmParseService.ts，群/私聊同步）：`getMessages(gid, offset, BATCH, lastScan)` 传 **startTime=lastScan** 只读增量（原生游标 beginTimestamp 过滤）+ 遇旧 `continue` 跳过（不 break）；翻页上限 20/10，页满 WARN；按 maxMs 推进 `last_scan`
- **验证**：重启 dev 后 `page=1 msgs=61 scanned=60`（一次补齐 60 条积压），下一轮 `msgs=1 scanned=0`（幂等无重复）
- **不受影响**：HTTP API（`collectRawRows` 直接 `mapRowsLite` 不经 normalize，保持原生降序）；前端 ChatPage（独立 `getLatestMessages`→`getMessagesByOffsetStable` 查询）；WCDB 时间是秒、lastScan 是毫秒（`ms=createTime*1000`）
- 坑：**任何消费 `chatService.getMessages` 的地方都不能假设返回顺序**（会被 normalizeMessageOrder 升序重排）；需要按时间增量扫请走 startTime 参数

## 2026-08-20 增量（AI 见解 24h 去重 + 非客户黑名单）

- **数据源调查结论**：今日行动（TodayActionPage）与灵感邮箱（InsightInboxPage）**同源**——都读 `insightRecordService`（JSON 落盘 `weflow-insight-records.json`），今日行动只取最近 24h 未读记录；加"新建待办"后由 `getUnifiedSignals` 统一合并
- **24h 去重**：`INSIGHT_RECORD_DEDUP_MS` 12h→**24h**（同客户 24h 内不重复触发 AI 分析）；`hasRecentRecord` 加 `sourceType==='insight'` 过滤，手动消息解析（`message_analysis`）**不阻塞**后续自动 AI 见解
- **非客户自动黑名单**：AI 输出【阶段=未知】→ `blacklistNonCustomer` 自动加入 `aiInsightNonCustomerBlacklist`（electron-store 持久化，与手动 whitelist/blacklist 名单**完全独立**）→ `isSessionAllowed` 先查黑名单硬屏蔽，不再触发任何见解
- **设置页可解除**：SettingsPage AI 见解 tab 底部展示黑名单（头像+名称+解除按钮），防 AI 误判后永久沉默；前端 `src/services/config.ts` 加 get/set API
- 新增测试 `scripts/insight-dedup-test.ts`（**6/6**，环境变量 `WEFLOW_USER_DATA_PATH`/`WEFLOW_CONFIG_CWD` 隔离落盘路径）；`npx tsx scripts/insight-dedup-test.ts`

## 2026-08-20 增量（销售复盘改造）

- **周复盘前端打通**（commit `9a9fbaf`）：复盘页（原「销售报表」，标题改「销售复盘」）加「生成周复盘」按钮 + `weekly_review` 专属视图（管道/热/冷/放弃 4 统计卡 + 阶段分布条 + 热/冷/放弃明细列表 + AI 复盘正文）。preload 早已暴露的 `sales.reviewGenerate` **此前前端从未调用**（周复盘只能靠周日 20:00 定时器静默生成，前端看不到），现首次接线
- **热了改基线对比**：原逻辑 `本周有新 intent 且阶段∈{quoted,negotiating,won}` 就算热（无对比基线，won 客户误报）；现改为**本周 vs 上周**——`intentBefore` 查上周最终阶段，本周阶段前进才热（新进入管道也算），后退/无变化/已成交/已流失不算
- **修复中英混存漏判**：customer_profile/intent_tag_log 的 stage 是**中英混存**（insightService 写中文，classifier 写英文），原复盘用英文列表匹配中文 stage **永不命中**；现统一 `normalizeStage`（已导出复用 salesActionEngine 版）归一化
- **非客户过滤**：周报/月报的 topContacts/活跃客户过滤非客户会话（命中 CRM account 或 AI 画像保留，剔除家人/同事等高消息量会话），Top 客户名优先用 CRM 客户名
- **崩溃兜底**：viewReport 按 period_type 分派 + 结构校验——历史脏 `weekly_review`（旧 stats 结构无明细数组）点开曾 `dailyMessageCounts.length` TypeError 整页白屏，现仅保留报告头不崩
- 纯函数化：`computeWeeklyReviewStats` / `filterCustomerSessions`（salesReportService 导出，可单测）；`salesDbService` 加 `intentBefore`
- 新增测试 `scripts/report-review-test.ts`（**28/28**：热/冷/放弃/阶段归一/过滤/集成）；`npx tsx scripts/report-review-test.ts`

## 2026-08-20 增量（复盘排除非销售联系人）

- **手动排除名单**（commit `ed510df`）：新增 `reportExcludedSessions` 配置（electron-store + 前端 config API `get/setReportExcludedSessions`）。现有非客户过滤只剔除「既非 CRM account 也无 AI 画像」的会话，但同事/朋友被 AI 误打标建画像后仍混进复盘——排除名单是**人工兜底**，命中一律剔除
- **两处生效**：`generate`（周报/月报）经 `filterCustomerSessions` 第四参剔除（activeContacts/Top 列表）；`computeWeeklyReviewStats` 循环顶部跳过（阶段分布/热/冷/放弃/管道数/活跃全部不含），pipelineTotal 计算也排除（曾漏）
- **两个入口**：① 复盘页「排除联系人」弹窗——`chat.getSessions` 全量单聊（过滤群聊/公众号/placeholder），搜索 + 已排除置顶 + checkbox 保存；② Top 互动客户每条「排除」快捷按钮——前端本地过滤 currentStats（不重复调 AI）+ 写配置
- 排除名单存 config，与其他功能（AI 见解黑名单）独立
- report-review-test 扩到 **33/33**（A5 排除不进任何统计 / B6 排除优先于 account 命中）

## 2026-08-20 增量（新建合同选型号）

- **工作台新建合同加型号选择**（commit `3e44a12`）：新建合同表单加「型号」区——从产品库搜索勾选产品（可多选，行显示 名称·型号·单价，数量可调，同产品去重），勾选合计实时显示；合同金额**手填优先、未填取型号合计**；有勾选型号 → `quotationCreate` 自动生成报价单行项（单价取产品库）。解决「新建合同无型号入口」：型号原只在建合同后的「新建报价单」里可选，且报价单选择弹窗不显示型号
- 下一步实测：新建合同 → 勾选型号填数量 → 创建 → 合同详情出现报价单（行项带型号）；金额未填时自动取型号合计

## 2026-08-20 增量（跟单中心物流卡两行化）

- **物流卡两行布局**（commit `bfed14d`）：主行=物流信息 + 发货/签收时间 + 超期徽章，副行=操作（认领销售/合同/确认认领/自动匹配/确认签收）。原一行挤 5 元素、信息与功能无分区，窄屏易溢出
- 下一步实测：跟单中心物流区三态（待认领/待签收/已签收）卡片信息与操作分区清晰、窄窗口不溢出

## 2026-08-23 增量（AI 销售副驾驶：产品/开发主线 §2.26）

- **定位**：AI 观察/理解/判断/准备，销售最终判断与对外执行；**L3 自动对客回复明确不做**。不是堆功能，是把现有 AI 能力串成闭环：「发现 → 判断 → 证据 → 准备 → 人工执行 → 结果回流」。现状：骨架 85% / AI 能力 70% / 产品闭环 65%；**自动扫描循环已存在**（runFullScan + lazyScan + 每日 8:00 全量 + 新消息增量），真正缺的是**行动结果回流**（Agent Action → Outcome → Re-evaluation）
- **北极星**升级为「有效销售行动」六段漏斗：发现（intent_tag_log ✅）→ 生成行动（follow_up_task.created_at ✅）→ 销售采纳（script_copied ❌新增）→ 销售执行（chat_opened ❌新增）→ 客户响应（customer_replied ❌新增）。**先埋点 → 验证数据 → 后看板**；前置：opportunity 表加 `source` 字段。「有效响应」第一版只记 customer_replied 不判有效
- **P0 路线**（§2.26，按序）：P0-1 E4 证据链 UI（**读取路径定标**：微信消息读取统一走**应用读取层 `chatService`**（解密 WCDB 只读，产品核心能力，销售功能复用不新增读取路径）；HTTP API `/api/v1/messages` 是同一读取层的 HTTP 封装（127.0.0.1+token），非独立数据源。**第一刀已实现并提交**（`4338921`）：`intent_tag_log` 加 `message_key`/`evidence_text` 两列（幂等 ALTER，历史不动）+ 透传链路 classifier/intentService/actionEngine/insightService urge + `follow_up_task.source_message_id`；`evidence_text` 只存判断依据句客户原话 ≤200 字，非 AI 结论；funnel-test 40/40 含 9 条证据断言；**三件运行时验证已通过**（新日志真带 message_key / message_key 回查命中「价格多少」原话 / evidence_text 确为客户原话）→ P0-2 客户「AI 当前判断」（**2026-08-23 数据契约盘点完成**：docs/实施记录/P0-2-数据契约盘点.md；**P0-2A 设计已定稿**：docs/P0-2A-Canonical-State-设计.md——canonical stage 6 值 + activityState 拆 dormant + unknown 异常位，insightService 禁写 stage 降 signal；拆三刀：P0-2A Canonical State（先修 STAGE_BASE 断链 + 建 read model）→ P0-2B Evidence Resolver（getEvidenceByKey 统一入口 + source_message_id 统一 messageKey）→ P0-2C AI Judgment Persistence（summary/opportunity/risk/nextAction 持久化，不再现场调 LLM）→ P0-2 UI）→ P0-3 E3 CustomerEvent（**扩展 intent_tag_log 不重写**，最小模型 {event_type, summary, messageKey, source, created_at}，动手前评估 4 个消费者：漏斗/意向评分/周报/今日行动；**AI 节流必须复用 insightService 12h 机制**）→ P0-4 Action 埋点（新增 3 个）→ P0-5 L0-L3 文档化（只文档不建权限系统）
- **冻结范围**（P0 闭环完成前暂缓）：自动回复 / 触发规则配置 UI / 更多 CRM 字段 / 更多 AI 标签 / 复杂 Agent / 向量数据库 / 大量新报表
- §10 待办已按主线重组（核销话术提炼/行动卡深链/漏斗深链；合并零操作+线索池实测为「实测反馈驱动迭代」；跟单中心拆分保留发票解析）

## 2026-09-02 增量（Phase 0 D3：建表 DDL + 决策 B 群扫描下线，未提交）

- **6 新表**（crmDb，宪法 §1.1-1.3/§1.8/§1.11/§1.12）：`customer` / `customer_identity` / `assignment` / `ownership_history` / `outbox_event` / `audit_event`，全部入 SCHEMA_SQL（CREATE IF NOT EXISTS）+ 注册 ENTITIES 白名单；CHECK 硬门禁三处（assignment.status / customer_identity.identity_type / outbox_event.status）；append-only 表按宪法 §2.2 无删除标记（沿 intent_tag_log 先例只带 source+created_at，不设 version/updated_by 死列）
- **幂等 ALTER 2 组**：`account.customer_id`（可空挂接）；opportunity 补列 14 项（§1.5）+ quotation 版本模型 4 列 + `contract.quote_version_id`（§1.6；quotation.contract_id 双写起止已写入 crmDbService 迁移注释：Phase 1 写入路径上线起双写、Phase 2 读路径切换后退役）
- **决策 B 下线**（宪法 §4.2）：删 `crmLeadScanService.ts` + `crmLeadScanCore.ts`、线索页「扫描群资源」按钮/模态与「⚙ 管理归属」弹窗、`leadReassignOwner` + `crm:lead:reassign` IPC + preload/d.ts 桥接、设置项 `crmLeadScanGroup`/`crmLeadScanWhitelist`（electron+前端两层）、scan_state `leadScan:*` 游标（initialize 时幂等 DELETE）；**lead.tag 仅保留需求标签语义**（线索页筛选 chips 文案同步改「标签」）
- 验证：`scripts/phase0-d3-ddl-test.ts`（新增）fresh 36/36 + 真实库副本 real 21/21 + 已迁移库二次初始化复验 21/21（幂等）；tsc root 0 错误 / node 158 条零新增（既有基线不动）；回归 crm-lead 55 + crm-workbench 50 + payments-claim 18 + crm-golden 45 全过；electron/ 产物对照白名单零陈旧产物
- 存量 4,680 条群扫线索的 tag 归属清理与回资源池 = **D4 迁移脚本**的事（骨架只写不跑），本刀未动任何 lead 数据

## 2026-09-02 增量（Phase 0 D4+D5：迁移脚本骨架 + 接口契约，未提交）

- **D4 迁移骨架**（`scripts/migration/`，只写不跑）：`types.ts` 统一迁移报告结构（总数/将迁移/已迁移/失败/冲突 + 逐条失败原因，幂等 alreadyDone 为必填项）+ 四模块——`01-decision-b-cleanup`（群扫 tag 归属清理预演：note 留痕「曾归属:X（日期）」+ tag 置空；leadScan:* 游标核验）、`02-account-to-customer`（§2.4 手机号优先 / session_id wxid 兜底查重归并 + customer_id 挂接）、`03-lead-to-identity`（(identity_type, identity_value) 唯一约束归并，资源池 NULL 合法态）、`04-history-deal-opportunity`（won 商机补建 + quotation 首版本核验 + contract.quote_version_id 挂接预演）+ `dry-run-all.ts` 试跑入口（真实库复制 /tmp 副本只读统计，绝不碰 live 库）。每模块头部写死铁律：迁移走应用链路（crmDbService），禁直改库文件（sql.js 覆盖前科）
- **dryRun 试跑**（真实库副本）：① 4,680 群扫线索（tag 分布 秒变1513/李林辉1355/杨青981/静候653/未分配178——与 §2.39 入库记录完全吻合；游标 leadScan:*=0、priv:* 168 不动）② account 205 → 将建 customer 186（手机号锚 11 / wxid 锚 175；19 个无锚公司名 account 进失败清单人工处理）③ 线索身份 4,680 行全唯一（9 条命中 account 锚 / 4,671 条资源池 NULL）④ 签约/发货合同 0 张、quotation 0 行（无可迁成交）——总计 wouldApply 9,368 / failed 19 / conflicts 0
- **D5 接口契约**（`docs/API-CONTRACT.md`，9/2 收缩版）：IPC 层**端点级完整**——现有 113 通道（crm:71 + sales:42，全部从 preload.ts/handler 实码梳理）+ Phase 0/1 新增 9 端点规范（assignment assign/claim/recycle/transfer/list、identity:bind、customer:mergeProposal、audit:query、ownership:history；统一信封 `{ok,data}` + 错误码 E1xx-E5xx；分配/归属类同事务写 assignment + ownership_history + audit_event）；本机 HTTP 只读层摘要（15 端点，详情指向 HTTP-API.md）；NAS / MCP 两层**占位规范**（认证/版本/幂等/错误码 + 空表头，Phase 3a / Phase 2 再补）；已下线通道防复活清单（`crm:lead:scanGroup` / `crm:lead:reassign`）
- 验证：`npx tsc --noEmit` **0 错误** + node 侧 158 条与基线一致**零新增**；dryRun 全链路只读试跑通过（`npx tsx scripts/migration/dry-run-all.ts`）

## 2026-09-02 增量（Phase 0 D7：商机评测集落库 + 标注工具，未提交）

- **新表 `opportunity_eval_case`**（salesDb，宪法 §3 特许扩展行，非业务事实表）：session_id / anchor_key（P0-2B messageKey 锚点）/ label+ai_label（has/none/uncertain，CHECK 硬门禁，AI 预标注与人工确认**分存互不覆盖**防锚定偏差）/ evidence_message_keys（纯 key 引用，§1.10）/ evidence_text（原话快照 ≤200 字，PIPL）/ status（pending/prelabeled/confirmed，CHECK）+ 通用五列 + created_at；UNIQUE (session_id, anchor_key) 供幂等 upsert。salesDb 无 ENTITIES 白名单，直接建表（SCHEMA_SQL + 幂等迁移块兜底索引）
- **service 方法**（salesDbService，纯新增）：`evalCaseUpsert`（幂等键命中更新、未命中插入；只更新显式提供字段，updated_at/version 恒推进；插入按内容推导 status）/ `evalCaseGet` / `evalCaseList` / `evalCaseCount` / `intentWithEvidence`（导出候选①数据源）
- **标注工具 `scripts/opportunity-eval.ts`**：`export` 生成 JSONL 待标注包（候选三路：intent_tag_log 商机相关阶段带锚点 / crmDb quote_signal / 随机无信号对照样本 --sample 默认 30；/tmp 副本隔离只读试跑，源库 sha256 零写核验）；`import <file>` 主管确认回写（按 UNIQUE 键幂等 upsert、status=confirmed、写 annotated_by，非法 label/evidence_text>200 字/缺 annotated_by 进失败清单不静默；⚠️ 导入前须退出 WeFlow 应用）。AI 预标注（GLM 预填）不在本刀——Phase 0 只落表结构+指引+导出脚本（Feature Gate）
- **标注指引 `docs/支撑材料/评测集标注指引.md`**（1 页给非技术主管）：三档判定标准 / 操作流程 / AI 预标注用法（先自己判再对 AI 答案）/ 目标量（W8 前 ≥100 条，无商机对照 ≥30%）
- 验证：`scripts/phase0-d7-eval-test.ts` fresh **25/25**（建表空表/通用五列/CHECK 拒非法+全枚举可写/幂等 upsert/ai_* 与人工分存/export 副本零写+三路计数/import 幂等回写）；tsc root 0 错误 / node 158 条零新增；回归 funnel 40/40 + report-review 33/33；真实库副本 export 试跑 76 条候选（quote_signal 46 + 对照 30，intent 带锚点商机阶段 0 条）

## 2026-09-03 增量（UI 美化第二波：全局组件 + 高频页，未提交）

- 37 个 SCSS 迁移到前进视觉 tokens（全局弹窗组件 11 / 今日行动+sales 卡片 8 / AI·知识与人脉 6 / 分析系统页 9 / 低频展示页 3），纯样式；唯一 TSX 改动 = AIActionCard.tsx 2 处 CSS 变量值
- 细节/取舍/遗留清单见 `docs/HANDOVER.md` §2.44；巨石三页（Chat/Settings/Sns）+ Export 模块 + 年报双报窗口留到下一波
- 验证：vite build ✓ / tsc root 0 / node 158 零新增；视觉验收（light/dark 截图）待做

## 2026-09-03 增量（线索分配 Phase 1 最小可用：assign + list，未提交）

- **新 service `crmAssignmentService.ts`**（零 electron 依赖，`crmDbService` 唯一依赖）：`assignLeads(leadIds, salesName, actor, mode='manual')` 单事务逐条校验（E301 不存在 / E201 已有有效分配 → 进 skipped 不阻塞其余）+ 三表同事务落行（assignment status='assigned'/mode='manual'/source='manual' + ownership_history reason='分配' + audit_event action='lead_assign'）；`listAssignments` 按 leadId/salesName/status 过滤 + 分页；`currentAssignment` 当前归属查询。统一信封 `{ ok, data }` / `{ ok:false, code, message }`（API-CONTRACT §1.14）。lead 表零写入（分配状态永不入 lead 表，宪法 §1.3）
- **IPC 两端点**：`crm:assignment:assign` / `crm:assignment:list`（crmIpcHandlers + preload `assignmentAssign`/`assignmentList` + electron.d.ts `AssignmentRow` 三处同步）；claim/recycle/transfer 本刀不实现
- **actor 兜底**：过渡期无身份系统，未传 actor 时服务层兜底「分配员」（仅署名，宪法 §1.12）
- **销售名单**：config 新键 `crmSalesList: string[]`（schema + 默认值 [] + 前端 `getCrmSalesList`/`setCrmSalesList`），在线索页分配弹窗内加名/删名，不动 SettingsPage
- **线索页 UI**（CrmLeadPage）：NEW 行行首勾选框（含表头全选本页）→ 顶部「分配给…(N)」→ 弹窗选销售/现场加名；归属筛选 chips「全部归属/未分配(默认)/各销售名」（当前归属 = 该 lead 最新一条 status∈(assigned,claimed) 的 assignment 行，前端 `assignmentList(pageSize:100000)` 一次性拉取建映射）；姓名列下小字「归属：X」、详情弹窗加归属行；哨兵 deadline 行已归属后显示「待首触」而非「待分配」
- **⚠️ 遗留**：分配后 lead.first_contact_deadline 保持 2100 哨兵不动，SLA 不起计时（assignment.sla1_deadline 留 NULL，待「SLA 从分配起算」后续刀）；存量 4,680 条仍全部未分配
- **测试** `scripts/assignment-test.ts`（副本隔离，28/28：三表落行/E201/E301/E101/list 过滤分页/通用五列/lead.status 不变）；验证：tsc root 0 错误 / node 158 条零新增 / vite build ✓ / 回归 crm-lead 55/55

## 2026-09-03 增量（Phase 0 D7 续：商机评测标注应用内化，替代 Excel 流程，未提交）

- **新页面「评测标注」**（侧边栏 AI / 知识 组，`/eval-annotate`；三处必改已做：App.tsx / Sidebar.tsx / RouteGuard.tsx）：顶部 标注人输入（localStorage 记忆）+「生成/刷新候选」按钮 + 进度 N/M + 人机一致率；卡片流 = 客户名 + 会话最近 15 条消息（`chat.getLatestMessages` 应用读取层，销售右蓝/客户左灰，原话就地展示不出机）；三个大按钮 有商机/无商机/不确定 点击即写库（status=confirmed + annotated_by）自动跳下一卡；**AI 预标注在人工标注前不可见**，已标注卡可展开比对 AI 答案（防锚定，宪法 §1.10 / 评测集标注指引口径）
- **新 service `evalService.ts`**（零 electron 依赖）：`generateEvalCandidates`（三路逻辑复用 opportunity-eval.ts 口径 + **三处数据质量修正**：过滤 @chatroom 群聊 / 同 session 只留最新锚点一行 / 对照样本改确定性抽样——随机洗牌会让刷新按钮每轮膨胀候选池，破坏幂等）+ AI 预标注回填（读 `opportunity-eval-pack-20260902.ai.jsonl`，(session,anchor) 精确匹配优先、session 兜底，匹配不上留空；已存在行缺 ai_* 只回填 ai_* 绝不动人工字段）+ `evalListCases` / `evalLabelCase` / `evalStats`
- **IPC 四端点** `eval:candidates:generate / eval:list / eval:label / eval:stats`（新 `evalIpcHandlers.ts`，写库端点 enqueueSalesTask 最外层串行化；preload + electron.d.ts 三处配齐）；salesDbService 加 `evalCaseGetById`
- **导出脚本同修**：`scripts/opportunity-eval.ts` 三路补 @chatroom 过滤（对照池曾混入 48186608819@chatroom）；脚本降级为备用通道
- 验证：`scripts/eval-annotate-test.ts`（副本隔离，**22/22**：过滤群聊/session 去重/三路计数/幂等零增/AI 回填匹配+补齐/标注写回+非法拒绝/进度+一致率独立重算）；tsc root 0 错误 / node 158 零新增 / vite build ✓；回归 phase0-d7-eval 25/25 + crm-lead 55/55

## 2026-09-04 增量（本地身份档案 PRD §1.2a，分配前置）

- **薄服务 `identityService.ts`**（electron/services/，零 electron 之外依赖、只读 config）：`getIdentity()` / `getActorLabel()`（署名「姓名（角色）」，角色未选只写姓名，未建档 null）/ `setIdentity` / `shouldPromptOnboarding` / `dismissOnboarding`——**未来所有 audit/ownership 写点统一从 `getActorLabel()` 取署名**；⚠️ 角色仅署名用途，绝不做访问控制（宪法 §1.12）
- **config 三键**：`identityName` / `identityRole`（销售/主管/分配员/空）/ `identityOnboardingDismissed`（schema + 默认值，127940a 已入库）；与应用锁完全独立
- **actor 兜底链**（`crmAssignmentService.assignLeads`）：显式 actor > 身份档案 > 兜底「分配员」；`system:migration` 显式值不受影响
- **首次启动引导**：`IdentityOnboardingDialog.tsx`（LiquidGlass 弹窗）——App.tsx 锁检查完成且未锁定后才弹（新 `lockChecked` 状态），不挡应用锁；每次启动最多一次，「稍后再填」落 dismissed 幂等不反复弹
- **设置页**：数据库 tab 底部「身份档案」区块（自动备份之后）——姓名 + 角色下拉 + 保存 + 当前署名预览
- **IPC**：新 `identityIpcHandlers.ts` 三端点 `identity:get/set/onboarding:dismiss`（注册在 main.ts config:set 旁，只写配置不 enqueue）；preload `identity.*` + electron.d.ts 三处同步
- **测试** `scripts/identity-test.ts`（落盘环境变量隔离 + fresh crmDb，**25/25**：署名三格式/角色归一/兜底链四级/跳过幂等）；验证：tsc root 0 / node 158 零新增 / vite build ✓ / 回归 crm-lead 55/55 + assignment 28/28；.js 产物已重建

## 2026-09-04 增量（Phase 1 存量迁移执行器 02/03，副本验证完，live 待重启生效）

- **新服务 `crmMigrationService.ts`**（零 electron 依赖）：模块② account→customer 回填挂接 + 模块③ lead→customer_identity 归并，入口 `runStockDataMigration()` 挂 main.ts 启动链路（紧随群扫旧归属恢复块）；归一化三函数（normalizePhone/normalizeWxid/accountAnchor）为本服务导出 = dry-run 骨架与执行器**口径唯一真源**（scripts/migration/02·03 已改从服务导入）
- **幂等双保险**：scan_state 一次性标记 `migration:02/03-*`（与数据同事务）+ 数据级判重（customer_id 已挂 / identity 对已存在即跳过）；**同事务 + 审计**：每模块 runTx 单事务 + audit_event（actor='system:migration'，detail=报告摘要+逐条失败/冲突清单）；**冲突不静默**：无锚 account/多名多归属组/跨客户身份冲突进清单不动数据
- **有意偏离**：owner_sales 全空 account 不回写「归销售本人」（C 档人工动作，宪法 §1.7，只在报告计数）；salesDb customer_profile.customer_id 对齐留独立后续刀；模块①已 live 完不碰；模块④ 0 数据只核验
- **验证** `scripts/migration-live-test.ts`（fresh 构造 + live 副本，**46/46**）：live 副本实绩 customer 188 / account 挂接 188 / identity 4857（挂 188 + 资源池 NULL 4669）/ 03 幂等命中 11 / 失败 19（无锚 account，逐条清单）/ 冲突 0，与 dryRun 预测逐项相等；重跑零副作用；基线 tsc root 0 / node 158 零新增；回归 crm-lead 55/55 + assignment 28/28 + identity 25/25
- ⛔ **未在 live 执行**：live 生效 = 用户先确认一次成功自动备份 → 重启应用由启动链路自动跑（详见 HANDOVER §2.51）

## 2026-09-04 增量（⛔ SLA1 误扫事故纠正：3,848 条存量分配被首扫全灭 → 补偿性恢复，HANDOVER §2.54）

- **事故**：backfill 初版口径「分配时刻+24h」→ 存量 3,848 条补写完即全部过期 → 回收器首扫全灭（actor='system:sla'）。**铁律级教训：给存量补截止时间，基点必须是「补写执行时刻」，绝不用过去的时间基点**
- **backfill 修正**：`backfillAssignmentSla1` 改为执行时刻 + crmLeadSlaHours；测试 F2b 加回归防线
- **纠正块 `correctSla1Misrecycle()`**（挂 main.ts backfill 之后、回收器之前）：命中 `recycled + updated_by='system:sla'`（live 副本核实 3,848）→ **方案 B 插入新 assigned 行**（source='system:correction'，不改写回收行，保留事故链路可对账）+ 补偿流水（ownership reason='分配' / audit detail 含纠正说明+原行 id，**append-only 零删改**）+ lead 期限恢复；幂等双保险（scan_state 标记 `migration:sla1-misrecycle-correction` + 数据级判重）
- **测试**：新 `scripts/assignment-correction-test.ts`（live 副本实跑 **24/24**）；assignment-full 扩 G 组 → **71/71**；assignment-test 样本收紧为「从未有分配行」（28/28，事故后 live 带历史行）
- 验证：tsc root 0 / node 158 零新增 / crm-lead 55/55 + identity 25/25 + migration-live 44/44（已迁移口径 a33c8b9）+ persist-guard 36/36 + auto-backup 32/32；产物已重建；**live 未碰，下次启动自动纠正**

## 2026-09-04 增量（线索池页 Phase 1 完整交互：认领闭环 + 调派/回收 + 销售视角，前端 UI，HANDOVER §2.55）

- **纯判定层 `src/utils/leadAssignmentView.ts`**：`buildOwnerMap`（含 assignmentId，供调派/回收）/ `isSalesView` / `canClaimLead`（本人姓名+assigned 态）/ `canManageAssignment`（已归属+角色≠销售）/ `filterLeadsForView` / `visibleOwnerChips`——行按钮显隐与视角过滤全走这里，⚠️ 展示层便利过滤非安全边界（宪法 §1.12）
- **认领闭环**：行内「认领」（本人+assigned 可见）→ 弹窗确认 + 可选填客户微信号/昵称 → `assignmentClaim`（actor 不传，服务端身份档案判本人）→ 填了的复用 `leadUpdate` 落 lead（只传非空字段；不写 customer_identity，1.4a 的事）→ fetchAll 刷新列表+chips 计数
- **调派/回收**（角色≠销售可见）：调派弹窗选新销售（排除当前归属人）+原因 → `assignmentTransfer`；回收二次确认 → `assignmentRecycle`（回资源池+期限回哨兵）
- **销售视角**：只见「当前归属=本人」的线索；归属 chips 只留「我的」，未分配 chip 不渲染不混入；「分配给…」同步隐藏；空身份=管理视角看全部且认领不出现
- **测试** `scripts/lead-assignment-view-test.ts`（**32/32**）；验证：tsc root 0 / vite build ✓ / 回归 crm-lead 55/55 + assignment 28/28 + assignment-full 71/71 + identity 25/25；electron/ 零改动
- 有意偏离：「分配给…」对销售隐藏（池子不可见必空转）；认领弹窗预填现有 wechat/name（同 ✏️ 编辑习惯）；三动作 actor 全不传走服务端兜底链

## 2026-09-04 增量（线索分配 Phase 1 完整版：claim/recycle/transfer + SLA 起计时 + SLA1 回收器，后端+IPC）

- **契约五端点补齐**（API-CONTRACT §1.14）：`crmAssignmentService` 新增 `claimLead`（assigned→claimed，E201 非本人/非 assigned 态、E301 无分配行；**不写 ownership_history**，只 assignment + audit `lead_claim`；actor 空时按 `getIdentity().name` 判本人）/ `recycleAssignment`（E202 已回收、E201 已移交；同事务四写 = assignment 状态 + ownership reason=回收类 + audit `lead_recycle` + **lead.first_contact_deadline 重置回 2100 哨兵**，回池后可再 assign）/ `transferAssignment`（旧行 transferred + 新行 assigned source='transfer' 重起 SLA1；E203 目标销售不在 config `crmSalesList`；ownership reason=移交类 + audit `lead_transfer`；**离职移交批量=循环调本端点**，不复活旧 reassign）
- **assign 起计时**：`assignLeads` 写 `sla1_deadline = now + crmLeadSlaHours`（默认 24h）+ 同事务覆盖 lead.first_contact_deadline 哨兵为同一期限——「分配状态永不入 lead 表」唯一例外（写的是 SLA 计时列）；scanLeadSla 不动；**第二段 sla2 本刀不做**（等 LLM 扫描，PRD 1.4）
- **SLA1 回收器** `runSla1Recycle` + `startSlaRecycleScheduler`（main.ts 挂自动备份调度器旁，延迟 60s 首扫 + 间隔轮巡）：status='assigned' 且 sla1_deadline 过期 → 逐条 recycle（reason='SLA超时回收'，actor='system:sla'，A 档审计照写）；**claimed 不动**。间隔新 config 键 `crmSlaRecycleIntervalMin`（5-1440 分钟，默认 30）
- **存量补写** `backfillAssignmentSla1()`（main.ts 紧随群扫恢复块、**必须在回收器启动前**）：~~补 = updated_at + 24h~~ **⚠️ 口径错误，9/4 首启动引爆 §2.54 误扫事故，已修正为「执行时刻+24h」**（见上方事故增量节）；幂等（NULL 才补），实绩落汇总审计（actor='system:migration'，action='assignment_sla1_backfill'）
- **IPC 三处**：crmIpcHandlers + preload（`assignmentClaim/Recycle/Transfer`）+ electron.d.ts 同步
- **测试** `scripts/assignment-full-test.ts`（WEFLOW_WORKER 隔离 + fresh 库，**55/55**）；验证：tsc root 0 / node 158 零新增 / 回归 assignment 28/28 + crm-lead 55/55 + identity 25/25 + persist-guard 36/36 + auto-backup 32/32；产物已重建
- ⚠️ **环境性失败**：migration-live-test 现 38/8（HEAD 同样）——live 库已被重启应用执行过存量迁移 02/03（markers 已置位，customer 188/identity 4857 实证），测试的「预迁移副本」口径失效，恢复需改「已迁移副本幂等重跑」口径（后续刀）

## 2026-09-04 增量（⛔ 事故根因修复：sql.js 原子落盘 + 启动守卫，§2.52）

- **事故**：旧 persist `writeFileSync` 直写 db 文件（先截断为 0 再写），窗口期被 kill → 0 字节 → 启动静默空库 → 空库写回，sales 库两次全灭（9/3 + 9/4，详见 HANDOVER §2.52 事故档案）
- **新模块 `electron/services/atomicPersist.ts`**（零 electron）：`atomicWriteFileSync`（tmp→fsync→rename 原子替换）+ `loadBusinessDbWithGuard`（0 字节/解析失败禁止静默空库 → `.corrupt-<时间戳>` 留证不覆盖 → 最新 `backups/auto/we-flow-auto-*` 恢复，manifest size 校验 + sql.js 实跑探活，逐级回退 → 无备份才空库 + ERROR 日志）；**写 .db 落盘点全收口 5 处**（两服务 persist/persistNow + crmDb exportSnapshot）
- **crmDb 恢复成功补写 `audit_event`**（action=`db_recover`，actor=`system:persist-guard`）；salesDb 无审计表只打日志（有意偏离）
- **测试** `scripts/persist-guard-test.ts`（36/36，/tmp 隔离）；顺带修 `auto-backup-test.ts` 审计断言补 `ORDER BY id DESC`（live 副本带入历史审计行的环境性误伤，HEAD 上即 31/1）
- 验证：tsc root 0 / node 158 零新增 / 回归 crm-lead 55/55 + identity 25/25 + migration-live 46/46 + auto-backup 32/32；`tsc -b tsconfig.node.json` 产物已重建


## 2026-09-04 增量（加好友判定双路 PRD 1.4a：手动绑定 + 自动检测停 SLA1 表，HANDOVER §2.56）

- **停表方案**：assignment 幂等 ALTER 加 `sla1_met_at`（NULL=计时中；命中写停表时刻）——不复用 status（分配生命周期语义不承载「加了没有」）；回收器 `runSla1Recycle` 只扫 `sla1_met_at IS NULL` 的行
- **新服务 `crmFriendDetectService.ts`**：`bindLeadWxid`（契约 `crm:identity:bind` 实现；单事务四件套 = customer_identity(source=manual/auto, confidence=1.0) + 停表 + lead→WX_ADDED + audit `identity_bind`；E101/E301/E204；customer_id 按宪法 §2.4 能挂则挂、冲突不改挂；幂等短路 alreadyBound 零重复写）+ `runFriendDetectScan`（联系人注入式；username/alias 精确等值，昵称永不匹配，群/公众号排除，宁缺毋滥）+ `startFriendDetectScheduler`（main.ts 回收器旁，90s 首扫，新键 `crmFriendDetectIntervalMin` 默认 30 分钟；fetcher=chatService.getContacts lite，WCDB 只读）
- **前端**：线索行「绑微信」（canBindWxid：已归属 + 销售仅本人行）→ 搜本机联系人（头像/备注/昵称/微信号）→ 确认绑定；认领弹窗可选微信号接同一链路（失败回退仅落资料）；期限列「已加好友 ✓」
- **测试** `scripts/friend-detect-test.ts`（/tmp 隔离，**33/33**）；验证：tsc root 0 / node 158 零新增 / vite build ✓ / 回归 crm-lead 55 + assignment 28 + assignment-full 71 + identity 25 + lead-assignment-view 32 全过；产物已重建

## 2026-09-04 增量（两段 SLA 第二段 + 客户类型：PRD §1.4/§1.5，HANDOVER §2.57）

- **SLA2 落法**：不内嵌计时器——标记列 `assignment.sla2_scan_ref`（JSON verdict/confidence/scanRef/source/at），统一写入口径 `crmSla2Service.markSla2ScanResult`（规则/LLM/人工三路共用 + 审计 `sla2_scan_result`）；规则骨架 `runSla2RuleScan` 只认「停表后客户有回复」事实（confidence=1.0），调度器 `startSla2ScanScheduler` 挂加好友检测旁（新键 `crmSla2ScanIntervalMin` 默认 30 分钟）；**LLM 对话判定是缺口**（后续刀：结论走同一写点，出机内容先过 `maskPrivateText` 脱敏，宪法 §2.6）
- **客户类型**：新服务 `crmCustomerService.setCustomerType`（dealer/end_user/'' 清除 + 审计 `customer_type_set`）；IPC `crm:sla2:mark` / `crm:customer:setType`；客户 360「客户信息」区块顶部下拉编辑；`crm:customer:profile` 附挂 customer 行
- **测试** `scripts/sla2-customer-type-test.ts`（**41/41**）；验证：tsc root 0 / node 158 零新增 / vite build ✓ / 回归 crm-lead 55 + assignment-full 71 + friend-detect 33 + lead-assignment-view 32 全过；产物已重建

## 2026-09-04 增量（售后规则 + 离职移交 + outbox：PRD §1.6/§1.7/§1.7a/§1.7b/§1.9/§1.10，HANDOVER §2.58）

- 售后 `crmAftersalesService.ts`（R9 经销商拿货 10/15 天 / R10 成交回访 15·30·90 天一次性·老客加 60 天档 / R11 阶段停滞 14·21 天 / 设备周期 180·365·1095 天 / R12 经销商 60 天未拿货）→ follow_up_task 卡（created_by='aftersales'），`runAftersalesScan` 挂 runFullScan；离职移交 `crmOwnershipService.departureHandoff`（lead 循环 transfer reason='离职' + owner 三列同事务直改 + 流水/审计），IPC `crm:ownership:departure`，入口在线索池页 header；outbox `crmOutboxService.recordOutboxTx` 五写点（assign/transfer/recycle/claim/bind_wx）同事务登记只记录不发送。顺带修 todoUpdate priority_score 不落库。
- **测试** `scripts/aftersales-transfer-outbox-test.ts`（**53/53**）；验证：tsc root 0 / node 158 零新增 / vite build ✓ / 回归六套全绿；产物已重建

## 2026-09-04 增量（Phase 1 内网同步最小版三刀全落 + 模拟双机验证，HANDOVER §2.59）

- `lanSyncService.ts`（SMB 共享目录通道：hub=emitDown+consumeUp / terminal=consumeDown+emitUp，tmp+rename 原子写，幂等键 scan_state `syncApplied:<key>`，audit 上行游标 `syncUp:auditCursor`+Q4 五字段裁剪+脱敏）+ Q2 拦截（recycleAssignment 已挂 account → E205+审计 converted_skip 不下发）+ first_touch outbox 写点（`first_touch:<leadId>` 幂等）+ 终端角色不跑 SLA1 回收器 + 设置页「内网同步」区块（lanSyncSharedDir/lanSyncRole/lanSyncPollIntervalMin 三键）；测试 `scripts/lan-sync-test.ts`（42/42）+ `scripts/lan-sync-e2e-test.ts`（30/30 模拟双机闭环：分配下行→认领上行→claimed→重复投递幂等→销售视角过滤→半截 tmp 不消费）；跑 `npx tsx scripts/lan-sync-test.ts` / `lan-sync-e2e-test.ts`；回归十一套全绿（assignment-correction 14/10 系 HEAD 既有环境性失败）

## 2026-09-05 增量（启动链 bug 修复：resetLegacyGroupScanSla 误清已分配线索期限 + 存量对齐，HANDOVER §2.60）

- `resetLegacyGroupScanSla` 加「NOT EXISTS 有效分配」排除（旧版每次启动把 3,837 条 assigned 群扫 lead 期限打回哨兵）；新增 `syncLeadDeadlineFromAssignment()` 启动链对齐修复（live 已生效 3,837 条）；⚠️ `runTx` 的 `tx.run` 返回 last_insert_rowid 非修改行数，UPDATE 命中数用前后 COUNT 差；assignment-correction-test / lead-sla-reset-test 改已迁移口径（17/17、18/18）；全量回归 14 脚本全绿

## 2026-09-05 增量（客户工作台 360 档案改右侧抽屉，HANDOVER §2.61）

- 档案面板从内联长面板改 `.cws-drawer` 右侧抽屉（遮罩/✕ 关闭、sticky 头、独立滚动），样式全新类不动共用的 `.crm-detail`；⚠️ 不在已打好的 Windows 包（009de01）内，UI 收敛后需重打

## 2026-09-05 增量（切号重查 + 脏金额清理，HANDOVER §2.62/§2.63）

- §2.62：CRM 六页（客户/商机/漏斗/合同/今日行动/线索池）经 `src/utils/useWxidRefresh.ts` 监听 wxid-changed 自动重查，切微信号不再残留上一账号数据
- §2.63：doInitialize 幂等清理 `amount ≥ 1e8` 的 opportunity/quote_signal 存量脏行（旧版把手机号误识别为金额；护栏已于 86b3ece 上线，此刀只清存量），归零=待人工确认 + amount_reset/audit_event 留痕；销售机器免手动清，新包首启自动执行
- 两笔均 ⚠️ 不在 009de01 包内，与 §2.61 一起待重打

## 2026-09-05 增量（晨间摘要：每日一条「今天先跟谁」，HANDOVER §2.65）

- **新服务 `morningDigestService.ts`**（设计-AI见解重定位 §3.1 阶段二 a）：每日 08:05-08:35 一条「今天先跟谁」——getUnifiedSignals top 10 → 单次 LLM（prompt 只含卡片清单不含聊天原文，parseAiDigest 只认清单内 sessionId 防幻觉）→ 失败降级 top3 规则拼接（摘要永远有）；落 report_snapshot（period_type='morning_digest'，stats={items,aiUsed} + ai_summary 正文），同日幂等 + regenerate 删当天旧行重建；调度 30 分钟轮询窗口错开 08:00 全量扫描
- **salesDbService 加 `reportLatestByType`/`reportDeleteByTypeAndDate`**（⚠️ salesDb 的 `this.all<T>`/`this.get<T>` 是泛型的，与 crmDb 非泛型坑不同）；main.ts 接 IPC `sales:morningDigest:get/regenerate`（写库走 enqueueSalesTask）+ setConfig/startScheduler；preload + electron.d.ts 同步
- **前端 TodayActionPage**：digest banner（`.signal-notice--digest`）取代高意向提示条（互斥），条目深链 `/customers?sid=`；⟳ 刷新小按钮手动重生成（测试入口，不必等 8 点）；切号重查并复位收起态
- **测试** `scripts/morning-digest-test.ts`（**22/22**）；验证：tsc root 0 / node 158 基线零新增 / vite build ✓ / 回归 insight-noise 32/32 + funnel 40/40 + report-review 33/33；产物已重建

## 2026-09-05 增量（散装见解降级 + 信箱改「重要提醒」，HANDOVER §2.66）

- **sourceType 三分**（设计-AI见解重定位 §3.2/§3.3 阶段二 b）：insightService 自动见解（activity/silence/test/批量）addRecord 改落 `sourceType='archive'`（档案标注，继续生成——customer_judgment/enrich 的上游）；message_analysis 不变；`'insight'` 预留阶段三告警（triggerReason='alert:*'）。语义：「记录=分析事实 SSOT，信箱=告警视图」
- **⚠️ 去重配套修（两行必须一起改的地雷）**：`hasRecentRecord` 过滤 `=== 'insight'` → `!== 'message_analysis'`——archive 计入 24h 去重，否则每条客户消息重触发一次 LLM 调用
- **卡流零 insight**：salesActionEngine 删 insight 合流分支 + INSIGHT_BOOST + completeUnifiedSignal 的 read 标记；`stats.insightOnly/merged` 保留字段恒 0（防前端引用断裂）；前端 todayActionStore SignalSource/SignalFilter 去 'insight'，TodayActionPage 删「有动向」chip + 高意向提示条（已被晨间摘要 banner 取代），AIActionCard 删 teal 洞察块；**TodoSidebar 盘点结论：不消费 insight 记录，未动**（设计稿 §3.2 记载有误）
- **隐藏消费点 `includeArchive` 开关**：crmEnrichService 素材【AI 见解记录】与 `crm:customer:profile` 客户 360 时间线都靠 listRecords 读记录（「进档案」全靠这两处），默认过滤会误伤——两处显式 `includeArchive: true` 保持原行为；信箱列表默认隐藏 archive，标题改「重要提醒」
- **测试**：insight-dedup-test 6→**11**（archive 计入去重/信箱列表不含 archive/显式 archive 视图可查）；todo-followup-test 11→**14**（archive 不出卡/卡流零 insight 来源/stats 恒 0）；回归 insight-noise 32 + morning-digest 22 + funnel 40 + report-review 33 + crm-enrich 61 + customer360 13 + today-action-consumer 14 + customer-event 20 + insight-stage-ban 16 + insight-unnamed 6 全绿；tsc root 0 / node 158 基线零新增 / vite build ✓ / 产物已重建
- **遗留**：阶段三告警白名单（设计稿 §4，**先入宪法 §3 登记再建 alert_eval_case 表**）；存量垃圾 insightRecord 手动清 `weflow-insight-records.json`

## 2026-09-07 增量（Hermes 智能体：Agent Core 提取 + UtilityProcess 化，HANDOVER §2.85-87）

- **生产架构定案**：Renderer → preload（接口零改动）→ Main（Manager=唯一可信宿主）→ UtilityProcess（只跑 Agent Loop）；**旧进程内 Agent 仅留作测试 adapter，生产严禁回退**。main.ts 已改调 Manager，四 IPC + progress 事件语义不变
- **新文件**：`shared/hermesProtocol.ts`（协议 v1 唯一真源 + 严格键集校验器）、`electron/hermes/hermesUtilityEntry.ts`（Utility 入口：Loop+运行时，零 DB/零模型出网）、`electron/hermes/hermesUtilityManager.ts`（Main Manager：fork/心跳/至多一次重启/fail closed + 宿主三闸）、`scripts/hermes-utility-test.ts`（113 断言/13 场景真 fork 动态测试）、`scripts/hermes-utility-child-shim.cjs`（测试 IPC shim）
- **安全边界**：API Key/ConfigService/工具白名单/真实 identity·sessionId 全在 Main；capabilityContextId 不透明 ID 跨进程；模型出网前最终隐私检查；工具结果回传前再脱敏；messageKey 绝不过进程边界；只有具体数据库读取进 enqueueSalesTask（Agent Loop 不整体入队）；Utility 在数据库服务关闭前结束
- **验证**：utility 113/113 + protocol 176/0 + agent 95/0 + ask 40 + ask-data 42 + governance 57 + owner-filter 28 + workspace 37 + settings-nav 59 全绿；tsc root 0 / node 158 基线 / vite build ✓（产物 hermesUtilityEntry.js 零 DB/AI 痕迹）
- **下一步**：任务 4（验证收尾与交付报告）；`docs/设计-Hermes-MVP.md` 任务书为需求权威

## 2026-09-08 增量（Hermes Utility 宿主边界补修，HANDOVER §2.88，commit `fix: close Hermes utility host boundaries`）

- **四项边界闭合**（基于 e5a3af1）：①任务文本（goal/question）Main 脱敏后才进 task.start/task.continue，Utility 侧标签恒通用「全局/当前会话/当前客户」，原文只存 Main 供 UI 快照恢复（UI 永不显示脱敏文本）；②证据锚点——Main 按原始证据分配不透明 `evh-*` evidenceHandle，原始 messageKey 只存 Main 锚点表，跨进程证据只带 handle，UI 快照按 ref/handle 恢复原始证据（含 messageKey 本地回查锚点），checkpoint 永不携带 handle/messageKey；③shutdown 幂等 + 拒新请求 + abort 全部在途模型 + 等全部在途宿主操作落定才返回 + **child 亲和**（旧请求延迟结果绝不发给重启后的新 child）；④协议版本 fail closed——数值版本 ≠ 当前 → 立即 unavailable + kill + 不重启不耗重启预算，unavailable 拒一切 host.request，消息/退出监听按 child+generation 绑定（旧进程迟到消息一律忽略）
- **accountId 口径修正**：`accountId` 按协议作为工具锚点**允许进 Utility**（HermesUtilityContext 携带）；identity/sessionId/API Key 绝不进
- **测试**：utility 113→**161 断言/17 场景**（新增 t2b 文本脱敏过界、t14 shutdown 等在途操作、t15 child 亲和、t16 旧版本假 child fail closed、t17 迟到消息忽略；t2/t5/t9 反转或增补）+ 4 项突变验证各自被捕获；protocol 176→**182**（handle 形态校验 i3e-i3j）
- **验证**：utility 161/161 + protocol 182/0 + agent 95/0；tsc root 0 / node 158 基线零新增 / vite build ✓ / `git diff --check` 干净

## 2026-09-08 增量（Hermes 任务生命周期边界加固，HANDOVER §2.89，commit `fix: harden Hermes task lifecycle boundaries`）

- **三项边界闭合**（基于 §2.88 终态，协议升级 **v2**）：①capability↔contextFingerprint 绑定——startTask 定格指纹（生产缺省 = 清洗后 myWxid+身份姓名+角色；真实值绝不入 Utility 消息/checkpoint），host.request 与 continueTask 每次重读比对，不一致拒模型/工具并以 `context_expired` 终止（文案「当前账号或身份已经变化，请重新发起 Hermes 任务。」），`config:set myWxid` 切库后 Main 主动 `invalidateCapabilities('account_changed')`；②runId 轮次号——task.start=1、continue 递增、progress/checkpoint/受理回执必带当前轮次，旧轮次迟到消息一律拒收，取消/终态/未知任务各有门禁不复活不凭空创建；③双向唯一出口扫描——`Manager.sendToUtility` 与 `Entry.send` 均协议校验 + `findHermesBoundaryIssues` 双检，调用点脱敏被绕过时出口兜底让任务立即 `failed/boundary_violation`（不傻等 90s），模型返回文本回传 Utility 前二次脱敏；evidenceHandle 收紧 `/^evh-[a-z0-9-]+$/`
- **测试**：utility 161→**244 断言/26 场景**（t18/t19 指纹失效与不可复活、t20/t21/t22 迟到消息与轮次门禁、t23 出口拒发与快速落定、t24 模型响应二次脱敏、t25 出口兜底 + 伪造 handle）；protocol 182→**195**（f2a-f2k runId 全形态 + i3k/i3l handle 格式）；**3 项突变验证**（去指纹重校验→t18/t19 红 / 去轮次门禁→t21 红 / 去出口扫描→t23/t25 红）各自被捕获后还原
- **验证**：utility 244/0 + protocol 195/0 + agent 95/0 + governance 57 + ask 40 + ask-data 42 + persist-guard 36 + settings-nav 59 + workspace 37 + owner-filter 28 全绿；tsc root 0 / node 158 基线零新增 / vite build ✓ / `git diff --check` 干净

## 2026-09-10 增量（认领满 24h AI 首次分类 + 信息缺口反问卡，PRD 2.4，HANDOVER §2.97，工作区未提交）

- **assignment.claimed_at**（宪法 §1.3 修订）：claimLead 单点写入，转派新行 NULL 重新计时，存量 NULL 不回填；禁止用 updated_at 反推认领时间
- **first_classification 表**（宪法 §3 登记，crmDb+ENTITIES）：assignment_id UNIQUE=轮次幂等键；状态机 pending→proposed→confirmed/rejected，failed 可重试不写假结果；B 档——proposed/confirmed/rejected 存在时不重复调模型
- **服务** `crmFirstClassifyService.ts` + 纯核 `crmFirstClassifyCore.ts`：扫描器（满 24h，terminal 角色不跑）+ 手动「立即分析」（`crm:firstClassify:run/list/confirm/reject`）；证据硬门（无证据字段丢弃、stage/customer_type 无依据降级 unknown）；confirm 边界=customer.type 走 setCustomerType / stage 仅 unknown 才落 / 画像字段走 enrich 口径 / intent_score 只留提案行
- **反问卡**：follow_up_task trigger_type='info_gap_ask'，source_id=assignment_id*10+gapIndex（1-6），idx_ft_sla_once 双保险；字段确认钩子（新 `crmLifecycleHooks.ts`：applyInfoField/setAccountFieldManual/setCustomerType/registerOpportunityDeal）→ reevaluateInfoGapCards 关卡+补卡，done 历史保留
- **顺手修复**：todoUpdate 签名有 analysis 但实现不落库（已补）；缺口数量/型号口径含 won 商机
- **测试**：`scripts/claimed-24h-classification-test.ts` 75/75（npx tsx 直跑）；回归 assignment-full 91/91 + crm-enrich 61/61 + action-funnel 25/25 + tsc 0 + vite build ✓

## 阶段状态（2026-09-02 D6 开闸）

- **真实运行观察期已关闭**（9/1 复盘点到期收档）：结论已进 PRD v3.4 实测基线（行动卡执行率 0.6% → 分配制路线依据）。
- **解除的是「P0 工程冻结」**——漏斗/行动卡口径仍以 PRD v3.4 + DATA-CONSTITUTION 为准，**开闸 ≠ 随便改**。
- 当前主线 = **Phase 0**（宪法冻结 + 接口契约骨架 + 开工准备）；排期与坑清单以 `docs/规划/weflow-hermes-Phase0-启动细化.md` 为准。
- 文档分区（9/2）：规划类权威 `docs/规划/`，被取代版本 `docs/归档/`，工程文档 `docs/` 根。

## 下一步（Phase 0，原定 9/7 起；D6 已提前完成）

1. ~~D6 AGENTS.md 开闸 + 权威修正~~ ✅ 2026-09-02 完成（本节即产出）
2. ~~**D2** 两项 Policy + 七问补全~~ ✅ 2026-09-02 落稿（宪法 §2.3/§2.4/§2.5；Stage 矩阵 🔶 格待 D8 主管签字）
3. ~~D3 建表 DDL：6 新表 + 2 组幂等 ALTER + ENTITIES 注册 + 决策 B 群扫下线执行 + 回归~~ ✅ 2026-09-02 完成（见上方 2026-09-02 增量；未提交）
4. ~~D4 迁移脚本骨架（只写不跑）+ D5 接口契约（9/2 拍板收缩版：IPC + 本机 HTTP 两层端点级）~~ ✅ 2026-09-02 完成（见上方 2026-09-02 D4+D5 增量；未提交）
5. ~~**D7** 商机评测集落库（salesDb，宪法 §3 特许扩展）+ 标注指引 + 导出脚本~~ ✅ 2026-09-02 技术部分完成（见上方 2026-09-02 D7 增量；未提交）；**2026-09-03 标注流程应用内化**（侧边栏「评测标注」页，替代 Excel；见上方 2026-09-03 D7 续增量；未提交）；标注 W8 前 ≥100 条（主管执行中）
6. **D8** 评审会：1 页决策清单主管签字 = 宪法冻结 → 开工 Phase 1

## 不做项（大后期）

- CRM 双向同步 / 多账号协同 / 向量数据库
- 自动发消息（WeFlow 只读，无发送能力）
- 实时辅助回复填入输入框（只做一键复制）

## 技术约定

- 后端服务链路：`electron/services/xxxService.ts` → `main.ts` 注册 → `preload.ts` 暴露
- 前端链路：Zustand store + 页面组件
- 新页面三处必改：`App.tsx` 路由 + `Sidebar.tsx` 入口 + `RouteGuard.tsx` PUBLIC_ROUTES
- 提交前必过：`npx tsc --noEmit` 零错误
- 每完成一个模块立即 `git commit`，避免丢失

## 环境

- 启动：`npm install && npm run dev`
- 打包：见 MAINTENANCE.md §3
- 日志：`userData/logs/weflow-sales.log`（salesLogger）
- 配置：`userData/WeFlow-config.json`（不进 git）
