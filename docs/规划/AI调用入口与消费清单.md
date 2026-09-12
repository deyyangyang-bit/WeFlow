# AI 调用入口与消费清单

> 用途：PRD《AI简报与按需识别》§5.5 要求「产出 AI 调用入口/消费清单文档」。
> 本文件是**当前真实状态**的清单，随代码变更同步维护。
> 生成日期：2026-09-12

## 一、唯一收口层

所有 AI 调用必须经过 `electron/services/ai/aiApiClient.ts`：

| 能力 | 说明 |
| --- | --- |
| `callChatCompletion(config, messages, options)` | 底层调用（OpenAI 兼容 `/chat/completions`，非流式） |
| `simpleCompletion(config, system, user, options)` | 便捷封装，内部转调 `callChatCompletion` |
| `getAiModelConfig(config)` | 从配置读取 apiBaseUrl / apiKey / model / maxTokens / dailyCallLimit |
| `isAiConfigured(config)` | 是否有 URL + Key |

**收口层承担三件事，旁路调用会同时失去这三件事：**

1. **记账** — 每次调用写一行用量到 `userData/ai-usage/<sha256(accountScope)>.json`（`aiUsageLedger.ts`）；
2. **额度闸门** — 请求发出**之前**判定当日上限，达限则写一条 `status='blocked'` 行并抛
   `AiBudgetBlockedError`（`aiBudget.ts`），不静默超支；
3. **统一错误语义** — `AiApiError`（网络/模型/格式）与 `AiBudgetBlockedError`（额度）区分，
   调用方据此决定显示「失败」还是「被阻断」。

账本按 `accountScope`（账号库标识）分文件隔离，不记录任何客户内容。

## 二、`purpose` 取值表（账本打标）

`usageContext.purpose` 是成本归因的唯一依据，新增调用点必须打标，不得留空
（留空会记为 `unclassified`，见下）。

| purpose | 触发来源 | 触发方式 | 调用点 |
| --- | --- | --- | --- |
| `digest_scan` | 早间简报批量扫描 | 自动（每日 1 轮）+ 手动「重新生成简报」 | `salesFollowUpService.extractForSession` ← `scanSessionsForDigest` |
| `manual_identify` | 「AI 识别这个客户」按钮 | 手动，单次 | `salesFollowUpService.identifyCustomer` |
| `followup_verify` | 到期待办复核 | 随简报同轮 | `salesFollowUpService.verifyDueTasks` |
| `enrich` | CRM 客户信息补全 | 手动/流程内 | `crmEnrichService` |
| `insight` | AI 见解（会话分析） | 手动 | `insightService.callInsightApi`（`promptVersion: legacy-v1`） |
| `profile` | 客户画像生成 | 手动（设置页按钮） | `insightProfileService.callProfileApi` |
| `action` | 行动建议生成 | 手动 | `salesActionEngine` |
| `first_classify` | 首触分类 | 手动 | `crmFirstClassifyService` |
| `report` | 报表摘要 / 周复盘 | 手动 | `salesReportService`（两处） |
| `reply` | 回复建议 | 手动 | `salesReplyService` |
| `intent` | 采购意向分析 | 手动 | `salesIntentService` |
| `kb_extract` | 话术库抽取 | 手动 | `salesKnowledgeService` |
| `deep_analysis` | 客户深度分析 | 手动 | `crmDeepAnalysisService` |
| `quote` | 报价解析 | 手动 | `crmQuoteService` |
| `crm_import` | 导入意向判定 | 流程内 | `crmImportService` |
| `crm_parse` | 归属简语 / 收货信息解析 | 流程内 | `crmParseService`（两处） |
| `crm_parse_ocr` | 到账截图 OCR | 流程内（vision） | `crmParseService` |
| `payment` | 到款承诺抽取 | 流程内 | `crmParseService`（llm 注入） |
| `crm_copy` | 产品文案生成 | 手动 | `crmIpcHandlers` |
| `crm_meta` | 产品参数图提取 | 手动（vision） | `crmIpcHandlers` |
| `group_summary` | AI 群聊总结 | 手动/配置驱动 | `groupSummaryService`（两处，主调 + response_format 降级重试） |
| `hermes` | Hermes 助手 / 问数 / 工具调用 | 手动 | `hermesAgent`、`hermesAskService`、`hermesAskDataService`、`hermesUtilityManager` |
| `sla2` | SLA2 文本生成 | 流程内 | `main.ts` llm 注入 |
| `unclassified` | **兜底值**（调用点未打标） | — | 由 `aiUsageLedger` 在 `purpose` 为空时填入 |

> `stage` 为**已退役**取值：原调用点 `salesStageClassifier.classifyStage`（新消息 → AI 判定阶段 → 自动落库）
> 属无人触发的自动链路，已按 PRD §5.4（R）删除。历史账本行仍可能读到 `purpose: "stage"`（账本是追加式历史，
> 不做回溯改写），统计当日消费时会看到，属正常；新建调用点不得再使用该值。

> `unclassified` 非零即为缺陷信号：说明有调用点绕过了打标。排查方式：
> `grep -rn "callChatCompletion(\|simpleCompletion(" electron | grep -v usageContext`

### 调用点统计（复核口径）

| 项 | 值 | 口径 |
| --- | --- | --- |
| 含 AI 调用的文件 | **21** | 全文检索 `callChatCompletion(` / `simpleCompletion(`，排除收口层自身与 `.d.ts` |
| 调用点总数 | **28** | 逐行计数（同一文件多处分别计） |
| 已打 `usageContext` 的调用点 | **28 / 28** | 每个调用点起 10 行窗口内必须出现 `usageContext` |

> **本统计只覆盖「经过收口层」的调用**，看不见旁路——`insightProfileService` 修复前直连
> `/chat/completions`，既不出现在上面的 grep 里，也不在账本里，统计口径本身发现不了它。
> 因此每次复核必须**同时跑第六节的反向自查**，两个方向都干净才算收口成立。

## 三、后台自动链路盘点（PRD §5.4 / R）

**当前不存在任何「无人触发也调模型」的链路。** 逐条核对：

| 曾经的定时/事件触发 | 现状 |
| --- | --- |
| `insightService.startScheduler` / 静默联系人扫描（`scheduleSilenceScan`） | **已删除**（R） |
| `insightService.analyzeRecentActivity`（活跃会话分析） | **已删除**（R） |
| `insightService.scanUrgeFollowUps`（催办生成） | **已删除**（R） |
| `salesActionEngine` AI 预热（P3 落地后预调模型） | **已删除**（R） |
| `salesActionEngine.onNewMessage` → `salesStageClassifier.classifyStage`（新消息 → AI 判阶段 → 自动落库） | **已删除**（2026-09-12 复核补刀）。R 刀只删了调用方，函数体（含 `simpleCompletion`）留在原处，重新接线即复活该链路；现函数体与其 prompt / 解析一并移除，`insight-noise-test` d10-d12 锁死不得复活 |
| `salesFollowUpService.scan()`（原先仅由未被调用的 IPC 触达） | **已删除**，抽取逻辑保留并改由「按钮 + 简报」两个扳机驱动 |
| `morningDigestService.startScheduler`（定时生成简报） | **已删除**，改为渲染进程首屏按需触发 + 手动「重新生成简报」 |
| `startActionEngineScheduler()`（60s 本地规则扫描） | **保留**。`runFullScan` 只读本地事实、**不调用模型**，账本不会因此产生记录 |
| `groupSummaryService` 定时总结 | **保留**（受 `aiGroupSummaryEnabled` 开关控制）——它是用户显式开启的功能，且已纳入账本与额度闸门 |

结论：账本中不应出现由定时器产生的 `purpose` 记录；`digest_scan` 的触发仅来自首屏与手动按钮。

## 四、价格表与上限

- 价格表位置：`electron/services/ai/aiBudget.ts` 的 `PRICE_TABLE`（静态输入，含 as-of 日期与来源 URL）。
- **未收录的模型一律记为 `null`**，界面显示「未收录刊例价，金额未计入」，绝不用相似模型的价格臆造。
  当前默认模型 `deepseek-chat` 即属未收录（官方文档现列 `deepseek-flash` / `deepseek-v4-pro`）。
- 因为「算不出钱」不能等同于「没花钱」，**硬拦截按调用次数判定，不按金额判定**。
- 日上限：配置项 `aiDailyCallLimitEnabled` + `aiDailyCallLimit`（默认 60 次/天），
  用量达 80% 预警，达 100% 在请求前阻断。取值口径见设置页说明与 PRD §5.5。
- 阻断事件计入简报 coverage 的缺口展示（`DigestState = 'failed_or_blocked'`）。

## 五、维护要求

1. 新增 AI 调用点：必须打 `purpose`，并在本文件第二节补一行；
2. 新增后台自动触发：先对照 PRD §5.4 判断是否属于「无人触发也调模型」，是则不得引入；
3. 官方调价：更新 `PRICE_TABLE` 与 `PRICE_TABLE_AS_OF`，并在本节记录变更日期；
4. 每次复核：正向统计（第二节）+ 反向自查（第六节）都要跑，只有正向干净不算收口成立。

## 六、旁路反向自查

正向统计（第二节）只看得见「经过收口层」的调用，发现不了旁路。反向查直连 HTTP 与手拼接口地址：

```bash
# 直连 HTTP / 手拼 chat/completions（buildApiUrl 只用于日志与记录元数据时不算旁路）
grep -rnE "https?\.request|/chat/completions|buildApiUrl" electron | grep '\.ts:' | grep -v '\.d\.ts'
```

判断方法：看该处是否**真正发起 AI 请求**。命中项分三类，只有第三类是缺陷：

| 类别 | 例子 | 结论 |
| --- | --- | --- |
| 非 AI 的 HTTP（通知、下载） | `insightService.sendTelegram`、`snsService` / `weiboService` 的媒体请求 | 无关 |
| 只用于日志与落库元数据的 `endpoint` 变量 | `insightService` / `groupSummaryService` 的 `InsightRecordLog.endpoint` | 无关 |
| 真正打模型的直连 | `insightProfileService.callProfileApi`（修复前） | **缺陷**：不过闸门、不入账本 |

收口层自身（`ai/aiApiClient.ts`）与同目录的 `promptUtils.ts`（`buildApiUrl` 定义处）属正常命中。

**判定当前状态：** 2026-09-12 复核实测，第三类已清零（唯一一处 `insightProfileService` 已改走
`callChatCompletion`，`purpose: 'profile'`）；其余命中均为上表前两类，不构成旁路。
