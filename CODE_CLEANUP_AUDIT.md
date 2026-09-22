# CODE_CLEANUP_AUDIT.md —— 代码收口审计报告

> **阶段：第一阶段（只审计，未删除任何代码）**
> 审计日期：2026-09-12
> 审计范围：`src/` 255 文件 / 116,104 行、`electron/` 354 文件 / 123,641 行、`shared/` 32 文件 / 2,157 行、`scripts/` 106 文件 / 23,120 行
> 排除：`node_modules/ dist/ dist-electron/ release/ out/ .git/ weflow-web-offical/ resources/ packages/`
>
> **2026-09-21 补注（S8，不改写原文）**：本报告是 2026-09-12 基线的一次性审计记录，其余结论仍按当时基线理解。
> 其中涉及旧社交年度报告链路（`/annual-report`、`/dual-report` 及 `annualReport:*`/`dualReport:*`）的判读——
> 尤其「**是活路由，不要删**」（见「不是孤儿」表）与模板字符串入口那条方法论备注——**已随该产品链路于 S8 整体
> 删除而失效**：该链路不再存在，其「入口隐藏但可达」的事实与本文当时的「不要删」结论均不再适用。处置见
> `docs/设计-年度经营复盘-规格.md` §11；当前报告链路为 `/annual-review`（`annualReview:*`）。

---

## 0. 审计方法与边界

本次审计由五个独立方向并行执行，**每个方向均要求实际读取代码、做引用分析，禁止按文件名推断**：

| 方向 | 覆盖内容 |
|---|---|
| A. 依赖审计 | `package.json` 41 个依赖的源码引用计数 |
| B. 重复代码审计 | 函数/常量/类型级逐行比对 |
| C. 架构重复审计 | 服务/链路级同构实现识别 |
| D. 调试残留与遗留代码 | TODO / 注释代码 / debugger / 命名审计 |
| E. 死代码审计 | 自建解析器构建 463 个 ts/tsx 的引用图 + 393 个 IPC 通道双向比对 |

补充：**F. 仓库血缘与上游残留**（git 历史归属分析）、**G. 网络暴露面**、**H. 工程基线**。

### 引用分析方法

- **模块引用**：正则覆盖 `from './x'`、裸 `import './x'`、`import()`、`require()`，解析 `.js` 后缀与目录 `index.ts`。
- **IPC 双向闭合**：从 `electron/**` 抽 393 个 `ipcMain.handle/on`，与 `preload.ts` 421 个方法、`src/` 调用点三方比对，同时检查「前端调用不存在的通道」的反向问题。
- **动态引用兜底**：`React.lazy(() => import())` 39 处、`import.meta.glob` / `require.context`（全仓 0 命中）、electron-builder `files`/`asarUnpack`/`extraResources`。
- **已知解析陷阱**（本轮踩到并修正）：带 `.js` 后缀的 import（`'../utils/LRUCache.js'`）、无 `from` 的裸副作用导入（`import './preload-env'`）会被简易解析器漏判；`scripts/` 目录必须纳入扫描范围（本报告已修正一处因漏扫 scripts/ 导致的误判，见 P1-1）。

### 分级定义

| 级别 | 含义 | 动手前提 |
|---|---|---|
| **P0** | 零引用、零风险，可直接删除 | 无需额外验证，跑 `tsc` 即可 |
| **P1** | 高置信死代码/废弃功能，但需一处伴随改动或安全确认 | 需完成前置改动 |
| **P2** | 重复实现收敛，机械但需回归验证 | 需业务链路冒烟 |
| **P3** | 架构级重复，涉及数据模型或产品语义 | **必须人工拍板** |
| **白名单** | 看起来可疑但**明确不可动** | — |

---

## 1. 执行摘要

### 1.1 核心结论

**代码库的收口纪律异常干净**，本次没有发现"一团乱麻"式的技术债：

- 全仓 `debugger` **0 处**、`FIXME` **0 处**、`TODO` **仅 1 处**（且指向外部 C++ 依赖，属长期已知项）
- 5 行以上的注释代码块 **0 处**（所有连续注释块经逐块确认为设计说明）
- `src/` 侧 `console.log` 仅 **6 处**（CLAUDE.md「禁止 console.log 留在生产代码中」基本被遵守）
- 硬编码测试数据 / 真实隐私数据 **0 处**（工作树 PII 已于本轮清洗）
- 遗留 dev server 地址 **0 处**

真正的问题不是"乱"，而是**三层叠加**：

1. **上游遗骸**：项目是 `hicccc77/WeFlow`（微信聊天记录查看/导出工具）的衍生品。228 个文件 / 123,315 行（约占代码量 **46%**）**从未被本轮开发者触碰过**，属纯上游代码。
2. **新老并存**：多处"新实现已接管、旧实现还留着"，最久的已死 6 个月。
3. **收敛做了一半**：单一语义源（SSOT）已经建立（`shared/salesStage.ts`、`shared/crmRepeat.ts`、`aiApiClient.ts` 等），但调用方迁移未完成——**已存在共享源、调用方仍各写一套**。

### 1.2 数量总览

| 级别 | 项数 | 主要构成 |
|---|---|---|
| P0 | 15 | 11 个零引用文件/资产 + 2 行调试注释 + 3 条死路由链（含 1 条 6 层垂直死链） |
| P1 | 8 | 8 个未使用依赖、1 个需先改测试的组件、1 个死 IPC、AI 调用层三套实现等 |
| P2 | 20 | 重复函数收敛（多数函数体已逐字符相同）、死函数、死类型 |
| P3 | 9 | 架构级重复，涉及备份/客户模型/日志体系，删任一项会丢能力或破坏数据 |

### 1.3 最高价值的三个发现

1. **`/dashboard` 的 6 层垂直死链** —— 一条路由牵出「页面 → store → preload 方法 → IPC 通道 → handler → service 方法 → 类型声明」全层悬空，每层都只被彼此引用。**整链无入口**。这是本轮最干净、收益最大的一刀。
2. **AI 调用层三套实现** —— `aiApiClient.ts` 是 SSOT，但 `insightService` / `insightProfileService` / `groupSummaryService` 各自用 Node 原生 `https` 重写了一遍。**后果是这 5 个服务的 token 消耗完全不进 `aiUsageLedger` 用量账本**。
3. **销售阶段「标签+颜色」映射 6 份，中文文案已分叉** —— 同一个 `contacted` key 在 6 处被翻译成 4 种不同中文（了解/已沟通/沟通/已接触）。这是**用户可见的语义分裂**，不只是代码重复。

---

## 2. P0 —— 零引用，可直接删除

> 全部经引用分析确认为 0 引用。建议一次提交，统一验证 `npx tsc --noEmit` 零错误。

### P0-1 `temp_assets.json`

| 字段 | 内容 |
|---|---|
| **路径** | `/temp_assets.json`（仓库根，9.7 KB） |
| **问题类型** | 上游遗留资产文件 |
| **判断依据** | UTF-16LE + CRLF 的 GitHub Releases API 原始响应体，内容为 WeFlow 4.1.8 的 10 个发布产物清单（含 `hicccc77/WeFlow` 的 assets 路径）。由上游作者 `cc` 于 2026-03-26 提交（`d605474`），2026-06-30 再次改动（`fa4edeb`）。全仓含 `.cjs/.nsh/.md/.json` grep `temp_assets` **零引用**；不参与 `prepare-electron-runtime.cjs` |
| **当前引用关系** | 无（`git ls-files` 确认 TRACKED，`.gitignore` 的 `*info` 规则不覆盖它） |
| **推荐处理** | `git rm temp_assets.json` |
| **删除风险** | 极低 |
| **验证** | 删除后 `npm run build` 走通 |

> **附带价值**：该文件同时是**派生自上游仓库的物证**，与许可证议题直接相关（见附录 A）。

### P0-2 `electron/services/exportContentStatsCacheService.ts`

| 字段 | 内容 |
|---|---|
| **路径** | `electron/services/exportContentStatsCacheService.ts`（229 行） |
| **问题类型** | 孤儿服务类（两个方向独立确认） |
| **判断依据** | class `ExportContentStatsCacheService` 仅在自身文件内定义（`:91`），全仓无 `new ExportContentStatsCacheService()`、无 import。不在 vite entry 列表；`electron/services/export/index.ts` 只导出 `ExportContext / ExportOrchestrator / ExportStatsService`，未含它 |
| **当前引用关系** | 0 |
| **推荐处理** | 整文件删除（同名伴生 `.d.ts` 是 tsc 中间产物，一并删） |
| **删除风险** | 无（`import.meta.glob`/`require.context` 全仓 0 命中，不在 electron-builder 打包清单） |
| **验证** | `npx tsc --noEmit`；`npm run electron:dev` 启动无 "Cannot find module" |

> ⚠️ **勿误删**：`src/pages/Export/constants.ts` 的 `EXPORT_SNS_STATS_CACHE_STALE_MS` 等常量是**另一套缓存**，与本项无关。

### P0-3 `src/types/analytics.ts` + `AnalyticsData`

| 字段 | 内容 |
|---|---|
| **路径** | `src/types/analytics.ts`（92 行）、`src/types/models.ts:156 AnalyticsData` |
| **问题类型** | 死文件 + 死类型链 |
| **判断依据** | `grep -rn "types/analytics" --include=*.ts --include=*.tsx src` → **0 命中**（已排除 `export type { X } from` 转发形式）。文件内 `getMessageTypeDistribution` / `getChatDurationDays` / `getAverageMessagesPerDay` / `MESSAGE_TYPE_LABELS` 三个导出函数全仓计数 = 1（仅声明行）。`WEEKDAY_NAMES` 有 2 次命中但均在 `src/stores/analyticsStore.ts` **自持的同名副本**内，非引用本文件 |
| **当前引用关系** | 0。`analyticsStore.ts:4/20/30` 自己重新定义了 `ChatStatistics` / `ContactRanking` / `TimeDistribution`，**未 import 本文件** |
| **推荐处理** | 整文件删除 + 删 `models.ts` 的 `AnalyticsData` |
| **删除风险** | 低。`AnalyticsData` 名字较通用，已核查无重导出 |
| **验证** | `npx tsc --noEmit` |

### P0-4 `src/stores/imageStore.ts`

| 字段 | 内容 |
|---|---|
| **路径** | `src/stores/imageStore.ts`（173 行） |
| **问题类型** | 死文件 |
| **判断依据** | `grep -rn "imageStore" . --exclude-dir=node_modules` → **0 命中**（连字符串都没有）。`src/stores/` 下无 barrel `index.ts`，排除间接导出；最后改动 2026-06-30 |
| **当前引用关系** | 0 |
| **推荐处理** | 整文件删除 |
| **删除风险** | 无 |
| **验证** | `npx tsc --noEmit`；`npm run build` |

### P0-5 `src/utils/reportExport.ts`

| 字段 | 内容 |
|---|---|
| **路径** | `src/utils/reportExport.ts`（36 行） |
| **问题类型** | 死文件 |
| **判断依据** | `grep -rn "reportExport" . --exclude-dir=node_modules` → 0 命中；唯一导出 `drawPatternBackground` 全仓计数 = 1 |
| **当前引用关系** | 0。**与 `src/pages/SalesReportPage.tsx` 的报表导出功能无关**（那是另一套 IPC 路径），勿混淆 |
| **推荐处理** | 整文件删除 |
| **删除风险** | 无 |
| **验证** | `npx tsc --noEmit` |

### P0-6 `src/components/BatchImageDecryptGlobal.tsx`

| 字段 | 内容 |
|---|---|
| **路径** | `src/components/BatchImageDecryptGlobal.tsx`（133 行） |
| **问题类型** | 死组件（已被内联实现替代） |
| **判断依据** | 全仓 grep 仅命中定义行自身。从主链路摘除于 2026-04-15（commit `ab1d64e`），现 `App.tsx` / `main.tsx` 已无该 import。功能由 ChatPage 内联进度 + `ChatHeader` 进度徽章接管 |
| **当前引用关系** | 0 |
| **推荐处理** | 整文件删除。**注意**：`useBatchImageDecryptStore` 可能因此变成无消费者，需二次评估（属另一轮） |
| **删除风险** | 低。已死约 5 个月 |
| **验证** | `npx tsc --noEmit` |

### P0-7 `src/components/BatchTranscribeGlobal.tsx`

| 字段 | 内容 |
|---|---|
| **路径** | `src/components/BatchTranscribeGlobal.tsx`（148 行） |
| **问题类型** | 死组件（同上，同 commit） |
| **判断依据** | 全仓 grep 仅命中定义行 + `src/styles/batchTranscribe.scss:2` 的注释文案提及。摘除于 2026-04-15（`ab1d64e`）；`ChatHeader.tsx:106` 改为渲染 `runningBatchVoiceTaskType` + `batchVoiceProgress` |
| **当前引用关系** | 0 |
| **推荐处理** | 删除组件文件。⚠️ **不要删 `src/styles/batchTranscribe.scss`** —— 它仍被 `ChatPage.scss` 引用 |
| **删除风险** | 低。已死约 5 个月 |
| **验证** | `npx tsc --noEmit` |

### P0-8 `src/components/ImagePreview.tsx`

| 字段 | 内容 |
|---|---|
| **路径** | `src/components/ImagePreview.tsx` |
| **问题类型** | 死组件 |
| **判断依据** | `grep -rn "ImagePreview" --include=*.ts --include=*.tsx src` → 仅命中自身 + `src/pages/ResourcesPage.tsx` 的 `onImagePreviewAction`——**那是不同标识符**，属 ResourcesPage 内部回调 prop，与本组件无关 |
| **当前引用关系** | 0 |
| **推荐处理** | 整文件删除 |
| **删除风险** | 低。注意区分同名 prop |
| **验证** | `npx tsc --noEmit` |

### P0-9 `src/components/JumpToDateDialog.tsx` + `.scss`

| 字段 | 内容 |
|---|---|
| **路径** | `src/components/JumpToDateDialog.tsx`（306 行）+ 同名 `.scss` |
| **问题类型** | 死组件（被同目录 Popover 取代） |
| **判断依据** | `Dialog` 仅命中自身 4 处；同目录 `JumpToDatePopover` 被 `src/pages/ChatPage.tsx:17` 与 `src/pages/SnsPage.tsx:10,2155` 使用。`git log -S` 命中 commit `4b57e3e feat(chat): replace jump date modal with inline calendar popover`（2026-03-04）——**已死约 6 个月，是本次最久的死代码** |
| **当前引用关系** | 0 |
| **推荐处理** | 删除组件 + scss |
| **删除风险** | 低 |
| **验证** | `npx tsc --noEmit`；ChatPage / SnsPage 的跳转日期功能回归 |

### P0-10 `src/pages/Export/components/SessionDetail/index.tsx`

| 字段 | 内容 |
|---|---|
| **路径** | `src/pages/Export/components/SessionDetail/index.tsx` |
| **问题类型** | 死组件 |
| **判断依据** | `grep -rn "<SessionDetail\b" src/pages/Export src/components/Export` → 0。`ExportPage.tsx` 的 import 清单只有 `ExportTopBar / SessionTable / ExportDialog / TaskCenter / AutomationModal / AutomationTaskForm`，**不含 SessionDetail** |
| **当前引用关系** | 0。⚠️ 同名干扰项：`src/pages/Export/types.ts:182 interface SessionDetail` 与 electron 侧 `getSessionDetail*` IPC 通道均为**无关符号**，勿连带删除 |
| **推荐处理** | 删除组件目录 |
| **删除风险** | 低 |
| **验证** | `npx tsc --noEmit`；进 `/export` 页面无变化 |

### P0-11 `src/stores/knowledgeAskStore.ts`

| 字段 | 内容 |
|---|---|
| **路径** | `src/stores/knowledgeAskStore.ts`（21 行） |
| **问题类型** | 死文件（已被显式取代） |
| **判断依据** | 全仓 grep 仅命中自身文件注释 + `src/stores/hermesStore.ts:5` 注释「取代 knowledgeAskStore 的纯布尔开关」+ docs。`docs/HANDOVER.md:1455` 明确记录取代关系 |
| **当前引用关系** | 0 |
| **推荐处理** | 整文件删除 |
| **删除风险** | 低 |
| **验证** | `npx tsc --noEmit` |

### P0-12 `electron/windows/notificationWindow.ts:243,254` 调试注释

| 字段 | 内容 |
|---|---|
| **路径** | `electron/windows/notificationWindow.ts:243`、`:254` |
| **问题类型** | 调试残留（注释掉的配置项） |
| **判断依据** | `:243` 为 `// devTools: true // Enable DevTools`（处在 `webPreferences` 对象**内部**，注释掉的是真配置项）；`:254` 为 `// notificationWindow.webContents.openDevTools({ mode: 'detach' }) // DEBUG: Force Open DevTools`。两行均为一次性调试后未清理 |
| **当前引用关系** | 无（注释状态） |
| **推荐处理** | 删除这两行注释 |
| **删除风险** | 无。生效逻辑是 `setIgnoreMouseEvents` / `setContentProtection` |
| **验证** | 通知窗弹窗行为不变 |

> **对照（已核实为合规，不要动）**：`electron/main.ts` 的 5 处 `openDevTools()`（`:1216/1564/1622/1707/1782`）**全部**位于 `if (process.env.VITE_DEV_SERVER_URL)` 块内，是**合规的开发期守卫，不是残留**。

### P0-13 `/dashboard` 死路由及其 6 层垂直死链 ⭐ 本轮最高价值项

| 字段 | 内容 |
|---|---|
| **路径** | 见下表 7 层 |
| **问题类型** | 完整垂直死链（从路由到数据库方法全层无入口） |
| **判断依据** | `/dashboard` 严格全词检索（路径须被引号包裹且以引号/`?`/`$` 结尾，以排除 `dashboardStore` 这类子串误命中）→ **0 命中入口**，唯一"命中"是路由定义自身 |

**死链逐层拆解**（每层都只被下一层或自身引用，最上层无入口）：

| 层 | 位置 | 符号 | 证据 |
|---|---|---|---|
| 1 | `src/App.tsx:742` | `<Route path="/dashboard" .../>` | 严格全词 refs = **0** |
| 2 | `src/App.tsx:48,742` | `SalesDashboardPage` | 全仓仅 App.tsx 两行 + 自身文件 |
| 3 | `src/stores/dashboardStore.ts` | `useDashboardStore` | 全仓**唯一消费者**是 `SalesDashboardPage.tsx:10` |
| 4 | `src/stores/dashboardStore.ts:22` | `window.electronAPI.sales.dashboardStats()` | 全 src **唯一调用点** |
| 5 | `electron/preload.ts:890` / `electron/main.ts:4905` | `sales:dashboard:stats` 通道 | 全仓仅 preload + handler 两行 |
| 6 | `electron/services/salesDbService.ts:1324` | `getDashboardStats()` | 仅定义 + `main.ts:4907`（handler 体内） |
| 7 | `src/types/electron.d.ts:2190,2412` | `dashboardStats` / `DashboardStats` | 同上 |

| 字段 | 内容 |
|---|---|
| **当前引用关系** | 整条链**只有彼此互相引用**，从 `/dashboard` 路由向上无任何入口（无 Sidebar 项、无 `navigate`、无 `window.open`、无主进程建窗） |
| **推荐处理** | **整链一次性删除**（路由 + lazy import + 页面 + store + IPC 通道 + handler + service 方法 + 类型声明）。这是最干净的一刀 |
| **删除风险** | 无动态引用（`import.meta.glob`/`require.context` 全仓 0 命中） |
| **验证** | `npx tsc --noEmit` 0 错误；`grep -c "sales:dashboard:stats" src electron` = 0；启动应用进 `/dashboard` 应回落 `*` → `/home`（符合既有兜底设计） |

> **背景**：`SalesDashboardPage.tsx` 头注释仍写「接管首页 / 与 `/home`」，但 `/` 与 `/home` 现在都指向 `TodayActionPage`（09-12 重写）——该页被新首页顶掉，只剩无人链的路由，同时整条数据链变成了悬空实现。

### P0-14 `/welcome` 死路由 → `HomePage` 用户不可达

| 字段 | 内容 |
|---|---|
| **路径** | `src/App.tsx:743`（路由）、`src/pages/HomePage.tsx` + `.scss`、`src/components/RouteGuard.tsx:9` |
| **问题类型** | 死路由 + 死页面 |
| **判断依据** | 严格全词检索 `/welcome` → 仅 `App.tsx:743` 路由定义 + `RouteGuard.tsx:9` 的 `PUBLIC_ROUTES` 白名单。**白名单是放行名单不是入口**。`HomePage` 仅被 `App.tsx:6`(import) 与 `:743`(该路由) 引用 |
| **当前引用关系** | 0 个入口 |
| **推荐处理** | 删除 `/welcome` 路由 + `HomePage.tsx` + `HomePage.scss`；同步从 `RouteGuard.tsx:9` 的 `PUBLIC_ROUTES` 移除 `'/welcome'` |
| **删除风险** | 低。`RouteGuard` 白名单是**未连接数据库时**的放行名单，删除 `'/welcome'` 前需确认无书签/深链依赖（`App.tsx:435` 有 `window.location.hash === '#/'` 兜底） |
| **验证** | `tsc`；启动应用确认首屏仍落 `/home`（TodayActionPage）；断开数据库连接测试重定向仍落 `/` |

> ⚠️ **易混淆**：`src/pages/HomePage.tsx`（→ `/welcome`，**死**）与 `src/pages/WelcomePage.tsx`（→ `/onboarding-window`，**活跃**）是**两个不同组件**，勿混删。

### P0-15 `/biz` 死路由 + `BizPage` 默认导出是死 import

| 字段 | 内容 |
|---|---|
| **路径** | `src/App.tsx:773`（路由）、`src/App.tsx:37`（lazy import）、`src/pages/BizPage.tsx`、`src/pages/ChatPage.tsx:21` |
| **问题类型** | 死路由 + 死默认导出（但**命名导出活跃**） |
| **判断依据** | `/biz` 严格全词 refs = **0**。`<BizPage` 全仓**仅 `App.tsx:773`**（死路由自身）。**但** `ChatPage.tsx:21` `import BizPage, { BizAccountList, BizMessageArea, BizAccount } from './BizPage'` —— 默认导出 `BizPage` **被 import 却从未渲染** |
| **当前引用关系** | 命名导出 `BizAccountList`(:36) / `BizMessageArea`(:222) / `BizAccount`(:6) 在 `ChatPage.tsx:8106/8124/1704` **活跃使用**；默认导出 `BizPage`(:430,442) 仅被死路由与一个未使用的 import 引用 |
| **推荐处理** | **分层处理**：① 删 `/biz` 路由 + `BizPage` 默认导出组件体；② **保留** `BizAccountList`/`BizMessageArea`/`BizAccount`（ChatPage 公众号视图依赖）；③ 清理 `ChatPage.tsx:21` 的默认导入 → 改为 `import { BizAccountList, BizMessageArea, type BizAccount } from './BizPage'` |
| **删除风险** | 低。⚠️ `BizPage.scss` 若同时被保留的两个组件使用，**不要删样式**，核对后再动 |
| **验证** | `tsc`；`grep -rn "<BizPage" src` = 0；进 `/chat` 切公众号视图（`bizView`）功能正常 |

---

## 3. P1 —— 高置信废弃，需一处伴随改动

### P1-1 `src/components/sales/KnowledgeAskPanel.tsx` —— ⚠️ 不能直接删

| 字段 | 内容 |
|---|---|
| **路径** | `src/components/sales/KnowledgeAskPanel.tsx`（220 行）+ `.scss` |
| **问题类型** | 死组件，但**被测试脚本静态引用** |
| **判断依据** | `src/` 内 **0 引用**（`App.tsx` 无 `<KnowledgeAskPanel>`）。但 `scripts/hermes-ask-test.ts:91` 与 `:141` 用 `readFileSync(join(ROOT, 'src/components/sales/KnowledgeAskPanel.tsx'), 'utf8')` **读取该源文件做静态断言**（g4/g5/g6：无发送类 IPC、文案检查）。另 `scripts/hermes-agent-test.ts:890-891` 断言「App.tsx 恰一个 HermesPanel、零 KnowledgeAskPanel」 —— 反证组件确已从应用摘除 |
| **当前引用关系** | 仅 `scripts/hermes-ask-test.ts` 两处 `readFileSync`；`scripts/hermes-agent-test.ts:890` 为注释提及 |
| **推荐处理** | **必须先改测试再删组件**：把 `hermes-ask-test.ts` 的断言目标改为读 `HermesPanel.tsx`，或删除这两组断言；改完测试全绿后，再删组件 |
| **删除风险** | **直接删会让 `hermes-ask-test.ts` 抛 ENOENT，整个测试脚本中断** |
| **验证** | 删除前先 `npx tsx scripts/hermes-ask-test.ts` 确认当前全绿；改断言后再跑应仍全绿 |

> **审计过程修正记录**：本项一度被另一方向判为 P0（"外部引用 0"），因其扫描范围只覆盖 `src/electron/shared` 而漏了 `scripts/`。经复核确认 **`scripts/` 是其真实引用方**，故降级为 P1。这也说明"零引用"结论必须声明扫描范围。

### P1-2 8 个未使用依赖

| 字段 | 内容 |
|---|---|
| **路径** | `package.json` |
| **问题类型** | 未使用依赖 |
| **判断依据** | 41 个依赖中 8 个全源码 0 引用（已独立复核） |

| 包 | package.json 行 | 级别 |
|---|---|---|
| `html2canvas` | :38 | P0 |
| `jszip` | :40 | P0（与 `pizzip` :43 功能重复） |
| `jieba-wasm` | :39 | P0 |
| `react-markdown` | :46 | P0 |
| `remark-gfm` | :49 | P0 |
| `sharp` | :65 | P0 |
| `esbuild` | :63 | P1 |
| `vite-plugin-electron-renderer` | :70 | P1 |

| 字段 | 内容 |
|---|---|
| **当前引用关系** | 全部 0 个源码引用 |
| **推荐处理** | 移除。⚠️ **`echarts` 必须保留** —— 它虽显示 0 个直接引用，但是 `echarts-for-react` 的运行时对等依赖 |
| **删除风险** | 低，但触及流程约束 |
| **验证** | 移除后 `npx tsc --noEmit` + `npm run build` |

> ⛔ **流程阻塞**：仓库规则为「**禁止修改 lock 文件**」。移除依赖必然会改动 `pnpm-lock.yaml`。**本项需先由用户确认如何处理该约束**（例如：授权本次 lock 变更 / 或本项暂缓）。在获得明确指示前不要执行。

### P1-3 死 IPC 通道 `sns:debugResource` ⚠️ 安全相关

| 字段 | 内容 |
|---|---|
| **路径** | `electron/main.ts:3304`（handler）、`electron/preload.ts:612`（暴露）、`electron/services/snsService.ts:1325`（实现） |
| **问题类型** | 死 IPC + **最小权限问题** |
| **判断依据** | `debugResource(url)` 对**任意 URL** 发起 https GET（带 `Range: bytes=0-10`）并回传 status/headers。`grep -rn debugResource src/` **只命中 `src/types/electron.d.ts:1901` 的类型声明**——渲染层从不调用 |
| **当前引用关系** | 仅一个自动生成的类型声明，无调用点 |
| **推荐处理** | 连同 preload 暴露面、handler、实现、类型声明一起删除 |
| **删除风险** | 低。但**安全视角值得单独提**：这是一个"渲染层可让主进程代发任意 https 请求"的通道。即便当前无调用点，也不应长期保留在 API 面上（若渲染层被 XSS 或恶意内容注入，该通道即为 SSRF 跳板） |
| **验证** | 删后 `npx tsc --noEmit` 通过（同步移除 `electron.d.ts:1901` 声明） |

### P1-4 `electron/services/keyServiceLinux.ts` 的 `[Debug]` 跟踪日志

| 字段 | 内容 |
|---|---|
| **路径** | `electron/services/keyServiceLinux.ts:66,70,73,77,79,81,119,123,125,139,143...`（全文件 15 处 `console.log`，其中 18 处带 `[Debug]` 前缀） |
| **问题类型** | 调试残留（排障期打印） |
| **判断依据** | 逐步骤英文跟踪日志：`'[Debug] 开始执行进程清理逻辑...'`、`'[Debug] killall 成功退出. stdout: ...'`、`'[Debug] 尝试使用备用命令 pkill...'`、`'[Debug] 第 N 秒，通过 pidof 成功获取 PID: ...'`。**不属于** `salesLogger.ts` 的结构化落盘日志体系 |
| **当前引用关系** | `main.ts:22` 导入、`:723` 实例化 → **Linux 平台可达**（macOS/Windows 走其他分支，不触发） |
| **推荐处理** | 改为走该文件已有的 `onStatus?.()` 回调上报；或降级为受环境变量控制的开关 |
| **删除风险** | 低。⚠️ Linux 密钥提取是排障高发路径，建议**只删成功路径的 trace，保留失败信息** |
| **验证** | Linux 环境跑一次自动获取密钥，UI 状态回调仍正常 |

### P1-5 AI 调用层三套实现（安全/数据相关）

| 字段 | 内容 |
|---|---|
| **路径** | SSOT：`electron/services/ai/aiApiClient.ts:58`(`AiApiError`) `:72`(`buildApiUrl`) `:78`(`normalizeMaxTokens`) `:104`(`callChatCompletion`)<br>绕过方 1：`electron/services/groupSummaryService.ts:66`(`ApiRequestError`) `:138`(`callChatCompletions`) `:78`(`buildApiUrl`)<br>绕过方 2：`electron/services/insightProfileService.ts:134`(`ApiRequestError`) `:250`(`callProfileApi`) `:186`(`buildApiUrl`) `:180`(`normalizeApiMaxTokens`)<br>另有 `insightService.ts`（`https.request`，`:533/:914/:1828/:2030`）、`snsService.ts`、`social/weiboService.ts` |
| **问题类型** | 工具层重复实现 + **用量统计漏记** |
| **判断依据** | `callProfileApi` 与 `callChatCompletion` 是同一份非流式 `/chat/completions` 实现：同样的 payload 组装、同样的 `requestOptions`(hostname/port/path/Authorization)、同样的 `statusCode >= 400 → reject`、同样的 `data.slice(0, 200)` 截断、同样的 `JSON.parse(data)` + `choices[0].message.content`。`ApiRequestError` 与 `AiApiError` **字段完全相同**（`statusCode`/`responseBody`）。`normalizeApiMaxTokens` 与 `normalizeMaxTokens` 边界值同为 1 / 2,000,000。`insightService.ts` 头部甚至注释了 `new URL("chat/completions", ".../v1")` 丢 `v1` 的坑——**正是 `aiApiClient.buildApiUrl` 已解决的同一个坑** |
| **当前引用关系** | `aiApiClient` 已被 20+ 服务导入；但 `groupSummaryService` / `insightProfileService` **完全未导入它**（grep 0 命中）。`insightService.ts:1` 已导入 `callChatCompletion`，是"迁到一半"的中间态 |
| **推荐处理** | 把这 5 处改为 `callChatCompletion`。需逐个核对 `responseFormatJson` / `disableThinking` / 自定义超时温度的对等性 |
| **删除风险** | **中**。① 两者都缺 `usage` 台账上报，切过去会**让 AI 用量统计口径变化**；② `callProfileApi` 的 abort 语义走 `AbortRequestError`（靠 `name === 'AbortError'` 判断），`aiApiClient` 返回 `AiApiError('请求已取消')`——依赖错误类型区分的调用方需同步 |
| **验证** | `grep -rn "https.request\|http.request" electron/services \| grep -v ai/aiApiClient` 归零；账本 `readAiUsage` 出现 `purpose: 'insight'/'profile'/'groupSummary'` 记录；画像生成 + 群总结两条链路比对失败分支文案（超时/400/JSON 解析失败） |

> **业务影响**：当前 `aiUsageLedger` 全仓只有 `aiApiClient.ts` 与 `main.ts` import，因此**上述 5 个服务的 token 消耗完全不进用量账本**——成本看不见。

### P1-6 「今日行动」两套读 API，一套已死

| 字段 | 内容 |
|---|---|
| **路径** | `electron/services/salesActionEngine.ts:725`(`getUnifiedSignals`) vs `:961`(`getTodayActions`)；`electron/main.ts:5178/5188`；`electron/preload.ts:923/927`；`src/stores/todayActionStore.ts:206` |
| **问题类型** | 新旧并存，旧链完整死掉 |
| **判断依据** | 同一文件里两个并行读口都返回「今日待办」：`getTodayActions` 基于 `follow_up_task`（旧），`getUnifiedSignals` 是 v4 统一信号流（新，聚合 `todo:`/`logi:`/`lead:` 虚拟前缀）。`TodayActionPage.tsx` 与 `TodoSidebar.tsx`（注释自述「主卡流 `getUnifiedSignals` 是唯一动作入口」）**只用新的**。`actionGetToday` IPC 在 preload+main 仍在，但 **renderer 侧 grep 零调用**——完整死链 |
| **当前引用关系** | `getTodayActions` / `actionGetToday`：renderer 0 调用 |
| **推荐处理** | 删除 `getTodayActions` + `sales:action:getToday` IPC + preload `actionGetToday`。保留 `completeAction` 前先确认无人用（grep 显示无 renderer 调用） |
| **删除风险** | 低，纯读路径 |
| **验证** | `grep -rn "actionGetToday\|getTodayActions" src electron` 归零；首页刷新正常、待办勾选仍可用 |

> **附带**：同文件 `:1183 generateSuggestion` 已自标 `@deprecated` 并内部转发 `generateActionAnalysis` —— **作者已自行收口，不用管**。但 `getTodayActions`/`completeAction` 这对旧口**没有标废弃**。

### P1-7 AI 客户阶段分类有两套实现

| 字段 | 内容 |
|---|---|
| **路径** | `electron/services/salesIntentService.ts`（`analyzeIntent` :123，落库 :195）vs `electron/services/salesStageClassifier.ts`（`classifyStage` :72、`persistClassification` :145） |
| **问题类型** | 架构重复（同一能力两实现） |
| **判断依据** | 两者做的是**同一件事**：拉最近 N 条聊天 → `simpleCompletion` 固定 system prompt → 容错解析 JSON 出 `{stage, confidence, reason}` → `salesDbService.customerUpsert({session_id, stage})` + `intent_tag_log`。`salesIntentService` 甚至已 `import { toMessageSnippets, extractEvidence } from './salesStageClassifier'`（是薄壳）。差异仅两点：① 阶段词汇——intent 用旧中文 `['了解','比价','决策','成交','流失']`，classifier 用 canonical 英文 `new/contacted/quoted/negotiating/won/lost/dormant`；② 取消息方式（chatService 直拉 vs 外部传入 snippets） |
| **当前引用关系** | **两者都还活着**。classifier 被 `salesActionEngine:614`、`insightService`、`salesActionAnalysisJudgment` 调用（新链路）；intent 只有 `main.ts:5087` → preload → `customerProfileStore.analyzeIntent` → `CustomerCard.tsx:366` 一个按钮（旧链路） |
| **推荐处理** | 删除 `salesIntentService.analyzeIntent`，`CustomerCard` 改调 classifier 链路（需把「分析意向」按钮语义映射到 `persistClassification`） |
| **删除风险** | 低。旧中文 stage 值可能已存在于历史 `intent_tag_log` / `customer_profile.stage`，**删代码不删数据**，`normalizeStage` 仍在（`shared/salesStage.ts`），历史数据仍可归一看板 |
| **验证** | `grep -rn "salesIntentService" electron src` 应只剩 0 命中；跑 `scripts/` 下 stage 相关测试；打开客户卡「分析意向」按钮确认阶段写入且 `intent_tag_log` 有行 |

> **旁证（已发生的 bug）**：`electron/services/intentScore.ts` 头部专门写「P0-2A.1：STAGE_BASE 键改 canonical + 输入过 `normalizeStage`（**修复分类器英文 stage 基础分恒 0**）」——旧中文键就是 intent 这条链留下的。`customerUpsertPolicy.ts` 也把两者并列为「stage 合法写者」。

### P1-8 38 个零调用的 preload IPC 方法

| 字段 | 内容 |
|---|---|
| **路径** | `electron/preload.ts`（421 个方法中的 38 个） |
| **问题类型** | 死 API 面 |
| **判断依据** | 从 `preload.ts` 抽 421 个方法，命名空间限定回查 `src`+`electron`+`scripts`，剔除误报后逐名二次核验 `grep -rn "<method>" src \| grep -v types/electron.d.ts` → **38 个为 0 命中**。同时确认主进程 393 个 handler 与通道**完全闭合**，无反向问题 |
| **当前引用关系** | 主进程 handler 全部存在，仅渲染层无调用点 |

**分布（节选）**：

| 命名空间 | 零调用方法 | 建议 |
|---|---|---|
| `diagnostics.*` | `getExportCardLogs` / `clearExportCardLogs` / `getResourceStats` / `exportExportCardLogs` | **明显残留，下线** |
| `window.*` | `openAgreementWindow` / `setTitleBarOverlay` | **明显残留，下线** |
| `dbPath.getDefault`、`wcdb.open` | src 只用 `wcdb.close/log/testConnection` | **明显残留，下线** |
| `chat.*` | `getExportTabCounts` / `getSessionMessageCounts` / `getSessionDetail` / `getResourceMessages` / `clearCurrentAccountData` | 逐个确认 |
| `export.*` | `getExportStats` / `exportSession`（src 只用 `exportSessions`） | 注意 `sns.getExportStats` **在用**，命名空间不同 |
| `sns.*` | `getExportStatsFast` / `debugResource`（见 P1-3）/ `downloadImage` | 下线 |
| `insight.*` | `getTodayStats` / `clearRecords` | 下线 |
| `crm.*` | `formGet` / `fieldMetaSave` / `opportunityGet` / `allocationConfirm` / `allocationReject` / `paymentApprove` / `aliasLearn` / `leadSlaSkip` / `leadDeadReasons` / `sla2Mark` / `deliveryProposeTradeIn` / `deliveryRecomputeRepeat` | ⚠️ 疑似 **API 面预留**，后端服务被其他路径调用（如 `crm:alias:learn` 实际由 `crmParseService.ts:296` 内部直调）→ **保留** |
| `sales.*` | `kbGet` / `reportGet` / `customerList` / `todoScan` / `profileBatch` / `profileProgress` / `actionGetToday`（见 P1-6）/ `actionComplete` / `aiUsageGet` | ⚠️ 疑似预留 → **保留** |

| 字段 | 内容 |
|---|---|
| **推荐处理** | **分层处理**：`diagnostics.*` / `window.*` / `wcdb.open` / `export.*` / `sns.*` / `insight.*` 属明显残留，连同 handler 一起下线；`crm.*` / `sales.*` 保留（疑似 API 面预留） |
| **删除风险** | 低。`src/types/electron.d.ts` 有同名声明需**同步清理**；无字符串形式通道引用 |
| **验证** | 删 handler 后 `npx tsc --noEmit`；`grep -c "ipcMain.handle" electron/**` 计数应等于剩余 preload 通道数 |

---

## 4. P2 —— 重复实现收敛（机械但需回归）

> 本组多数项**函数体已逐字符相同**，属纯 import 替换。统一验证：`npx tsc --noEmit` 零新增错误 + 对应业务链路 smoke。

| # | 路径与符号 | 类型 | 判断依据（引用分析） | 引用关系 | 推荐处理 | 删除风险 | 验证方法 |
|---|---|---|---|---|---|---|---|
| **P2-1** | `electron/services/export/utils/fileNaming.ts:70`(`pathExists`) ← `electron/services/export/media/fileCopy.ts:11` | 重复函数 | 两处**逐字符相同**（同为 `fs.promises.access` try/catch），后者已 export | 各自文件内使用 | 保留 `fileCopy.ts` 的导出，`fileNaming.ts` 改为 import | 低 | `tsc`；导出文件命名冲突分支手工触发一次 |
| **P2-2** | `salesDbService.ts:23` / `crmDbService.ts:20`(`dbGuardLog`)；`src/pages/Export/utils/format.ts:28,39` ← `ChatPage.tsx:871,879` ← `ContactSnsTimelineDialog.tsx:39` | 重复函数 | `dbGuardLog` 两处**逐字符相同**（同 import `GuardLogLevel`，注释都是「§2.52 启动守卫日志桥」）；`formatYmdDateFromSeconds`/`formatYmdHmDateTime` 三份**逐字符相同**，连空值返回 `'—'` 都一致 | `dbGuardLog` 各自 DB 服务内多处调用；`Export/utils/format.ts` 已 export 但**全仓 0 import**（"已抽好但没人用"） | `dbGuardLog` 移到 `atomicPersist.ts`（已导出 `GuardLogLevel`，同一边界）；时间格式化保留 `Export/utils/format.ts` 导出，另两处改为 import | 低 | `tsc`；Chat 会话详情「更新于/首条/末条」与 SNS 时间线渲染比对 |
| **P2-3** | `groupMyMessageCountCacheService.ts:25` / `sessionStatsCacheService.ts:47` / `exportContentStatsCacheService.ts:29`(`toNonNegativeInt`) | 重复函数 | 三处**逐字符相同**；三者都是「带 `updatedAt` 的缓存条目 normalize」结构 | 各缓存服务文件内自用 | 与 `cacheMapStore.ts`（已有缓存基础设施）或 `electron/utils/` 合并 | 低 | 三处缓存读写的脏值（负数/小数/非 number）行为不变 |
| **P2-4** | `OpportunityPage.tsx:67,74,86,92` ← `components/crm/DeliveryAftersales.tsx:65,71,74,80`(`fmtDate`/`fmtQty`/`toDateInput`/`fromDateInput`) | 重复函数 | 4 个函数**逐字符相同**（`fmtDate` 同为 `Number(ms\|\|0)`→0 返「未登记」→`YYYY-MM-DD`） | 各文件内多处使用，无共享 | 上提到 `src/utils/`（并入 `deliveryAftersalesView.ts` 或新建 `formatBiz.ts`） | 低。注意「未登记」是硬编码中文常量，抽离时保持字面量 | 两页日期显示/日期输入双向回写回归 |
| **P2-5** | `salesFollowUpService.ts:137,147,154` ← `salesIntentService.ts:50,63,68` ← `salesReplyService.ts:59` | 重复函数（含**改名复制**） | `extractContent`/`getIsSend` 在前两者**逐字符相同**（同 XML 前缀正则、同 `<content>` 提取）；`formatMessages` 三份同构，仅截断 `150` vs `200` 与 `MAX_CONTEXT_CHARS` 不同；第 3 处把函数**改名为** `extractMsgContent`/`getMsgIsSend` | 各服务内自用（意向分级/SLA 核验/回复建议） | 抽到 `salesMessageText.ts`，三处 import；截断长度作为入参 | 低。唯一差异是截断长度，作为参数保留即可 | 三条 AI 链路对同一会话生成 prompt，比对文本除长度外完全一致 |
| **P2-6** | `insightService.ts:189,195,201,205,214,220,226,279,285,318,113` / `groupSummaryService.ts:78,84,95,101,107,119,126,43` / `insightProfileService.ts:23,180,186,192,201,206` | 重复函数 + 重复类型 | **逐字符相同**的函数对：`buildApiUrl`(×3)、`clampText`(×3)、`stripJsonFence`(×2，连 `indexOf('{')`/`lastIndexOf('}')` 兜底都一样)、`shouldFallbackJsonMode`、`normalizeSessionIdList`、`formatPromptCurrentTime`+`appendPromptCurrentTime`。类型 `SharedAiModelConfig` 三处重复且**字段已分叉**（groupSummaryService 缺 `maxTokens`） | 全部文件内私有使用，无导出复用；`aiApiClient.ts:26` 已有等价类型 `AiModelConfig`（字段完全一致，含 `maxTokens`） | 纯工具函数上提到 `ai/promptUtils.ts`；`SharedAiModelConfig` 三处删除，统一用 `AiModelConfig` | 低。仅 `getStartOfDay`(ms) 与 `getStartOfDaySeconds`(s) 单位不同，需保留两个名字 | `tsc --noEmit` + AI 摘要/画像链路 smoke |
| **P2-7** | `src/pages/Export/utils/*`（`constants.ts:29`、`automation.ts` 7 个、`format.ts` 5 个、`performance.ts` 3 个、`progress.ts` 7 个、`session.ts` 5 个） | 死函数（28 个） | 全仓计数均 = 1。**文件本身有被 import（非孤儿），但上列函数连文件内都不用** | 0 | 逐个删除。`progress.ts`/`session.ts`/`format.ts` 中"仅自身文件引用"的只是多余 `export`，**去掉 `export` 关键字而非删函数** | 低 | `tsc`；进 `/export` 跑一次导出 + 自动化任务 |
| **P2-8** | `crmLeadImportCore.ts:32` / `crmParseRules.ts:35,116` / `crmEnrichCore.ts:36` / `crmSla2Service.ts:41` / `crmParseService.ts:288` / `hermesUtilityManager.ts:998` / `AuditTrailSection.tsx:68` | 重复常量 + 重复函数 | 正则字面量 `1[3-9]\d{9}` 在 **7 个文件出现 8 次**（crmParseRules 同文件内两份）。`maskContact`(`crmLeadImportCore.ts:142`) 与 `maskLead`(`CrmLeadPage.tsx:57`) **逐字符相同**；`AuditTrailSection.tsx:67` 是**第三种**（微信号脱敏 `slice(0,7)+'****'+slice(-2)` vs 前两者 `slice(0,2)+'***'+slice(-1)`） | `crmLeadImportCore.maskContact` 供今日行动卡/线索列表；`CrmLeadPage.maskLead` 供线索绑定提示；AuditTrailSection 供审计详情 | `shared/phone.ts` 导出 `CN_MOBILE_RE`/`isValidCnMobile`/`normalizeCnMobile`/`maskPhone` | **中**。微信号脱敏口径三处不一致，统一会**改变审计页/线索页的展示位数**；手机号正则本身语义一致，替换零风险 | 对 11 位/带+86/带横杠/10 位/12 位样本跑三处脱敏，列出变更清单 |
| **P2-9** | `src/services/config.ts`（264 个导出函数中的 47 个） | 死访问器 | 按名全仓计数 ≤1 的有 47 个。代表：`getLastSession`/`setLastSession`(:324/:330)、`getAuthEnabled`(:1730)、`getAuthPassword`(:1739)、`getHttpApiEnabled`(:2058)、`getIgnoredUpdateVersion`(:1760)、`getAiInsightApiKey/setAiInsightApiKey`(:2156/:2160)、`getAiInsightWhitelist*`(:2276-2288)、`getExportSessionMessageCountCache`(:1073)、`getAutoBackupTime/setAutoBackupTime`(:2033/:2037) 等 | 0。实际消费一律走 `configService.get('<key>')` 泛型访问器，具名包装层被架空 | 整批删除（同文件内同构）；保留仍有引用的 `configService` 对象方法 | 低 | `tsc`；重点回归设置页各 tab（`/settings`） |
| **P2-10** | `autoBackupService.ts:508 stopAutoBackupScheduler`、`salesReportService.ts:490 stopWeeklyReviewScheduler` | 死函数（只有 start 没有 stop） | 对应的 `start*` 分别被 `main.ts:80`、`main.ts:5876` 使用；`stop*` 全仓 0 引用 | 0 | 删除（进程退出即回收）；若未来要在 `before-quit` 优雅停机则保留并接线 | 低 | `grep -n "stopAutoBackupScheduler\|stopWeeklyReviewScheduler" electron/main.ts` → 0；`tsc` |
| **P2-11** | 10 个零引用导出类型/类/枚举 | 死类型 | `^export (interface\|type\|enum\|class)` 扫描，全仓计数 ≤1 | 0 | 删除 | 低 | `tsc` |
| **P2-12** | `src/pages/Export/types.ts:27,29,243,267,274,296`（`ContentCardType`/`SessionLayout`/`TimeRangeBounds`/`SessionLoadTraceState`/`SessionDataSource`/`AutomationTaskDraft`）、`models.ts:156 AnalyticsData`、`crmCustomerService.ts:15 CustomerType`、`crmDbService.ts:378 EnrichField`、`salesDbService.ts:77 KnowledgeStatus` | 死类型 | 同上 | 0。`Export/types.ts` 是类型中心，删前已核无 `export type { X } from` 转发 | 删除 | 低 | `tsc` |
| **P2-13** | `shared/salesStage.ts:32`(`CANONICAL_TO_CN`) vs `AIActionCard.tsx:16` / `SalesContextStrip.tsx:22` / `TodayActionPage.tsx:26,31` / `CrmWorkbenchPage.tsx:138,151` / `CrmLeadPage.tsx:35` / `CustomerCard.tsx:30` | 重复常量，**文案已分叉** | 同一个 canonical key 在 6 处被翻译成**不同中文**：`contacted` → shared「了解」/ AIActionCard「已沟通」/ TodayActionPage「沟通」/ CrmWorkbench「已沟通」/ CrmLead「已接触」；`quoted` → shared「比价」/ 其余「已报价」「报价」。颜色也各写一套（`#8b5cf6` vs `#4a9eff`）。`OpportunityPage.tsx:25` 与 `CrmWorkbenchPage.tsx:151` 已正确改用 `shared/funnelPalette.ts`——**收敛路径已存在，只覆盖了一部分页面** | 各文件内自用，无跨文件复用 | 全部改读 `shared/salesStage.ts` 的 `CANONICAL_TO_CN`/`stageLabel()`；颜色统一走 `shared/funnelPalette.ts` 的 `salesStageColor()` | **低（技术）／中（业务）**。技术上纯替换；但会把 5 种现存文案统一成 1 种，**属可见 UI 变更，必须产品确认** | 逐页截图比对阶段标签文案变化清单 |
| **P2-14** | `export/utils/htmlEscape.ts:34` ← `apiMessageMapping.ts:339` ← `MyFootprintPage.tsx:208`(`decodeHtmlEntities`) | 重复函数，**实体表不一致** | 三处都是链式 `replace`，但实体集合不同：`htmlEscape` 版多 `&#39;`/`&#96;`，另两版用 `&apos;`。三者都不支持数字实体通用形态 | `htmlEscape` 版被 export 格式化器使用；另两版各供发送者名解析/足迹文本清洗 | 以 `htmlEscape.ts:34` 为基础（补 `&apos;`），另两处 import | 低。补齐实体后输出只会更正确 | 含 `&apos;`/`&#39;` 的群昵称、发送者名样本 |
| **P2-15** | `apiMessageMapping.ts:393,399,405,444,480` ← `export/parsers/contentDecoder.ts:1,6,11,34,61` | 重复函数 | 两者都是「zstd magic `0xFD2FB528` → fzstd 解压 → UTF-8 判替换字符比例 `< 0.2` → latin1 兜底」。**差异**：① apiMessageMapping 版额外支持 `Buffer/Uint8Array` 入参与 `fallbackValue`，还会先 `compactEncodedPayload` 去空白；② magic 判定 LE/BE 都判 vs 只判 `readUInt32LE`；③ base64 正则不同。**grep 证实 apiMessageMapping 未 import contentDecoder（0 命中）** | contentDecoder 被 export 子系统 parsers 使用；apiMessageMapping 的 5 个副本为文件内自用 | 以 `contentDecoder.ts` 为基线，把 Buffer/fallback 分支并入作为可选参数 | **中高**。两者正则与 fallback 行为不一致，直接替换会改变边界样本的解码结果——尤其"解码出二进制垃圾"时的返回值（`fallbackValue` vs latin1） | 对同一批 `compress_content` 样本（含 BE magic、短 base64、纯 latin1 二进制）**双跑两版函数，diff 输出** |
| **P2-16** | `crmDbService.ts`(:855,874,1068,1120,1151,1350,1485,2035,2247 等 10+ 处)、`crmFirstClassifyService.ts:105,182,377,499`、`crmDeliveryService.ts:185,223,329,550`、`crmEnrichService.ts:158`、`lanSyncService.ts:308,393,467,715,903`、`CrmWorkbenchPage.tsx:203,262,341,385,486`、`CrmLeadPage.tsx:716,942,970,1250-1252`、`CrmProductPage.tsx:124,176` | 重复模式（内联） | 全仓 52 处 `try { … = JSON.parse(…) } catch { … }`，其中 **22 处是同一形态** `try { X = JSON.parse(String(row.custom_fields \|\| '{}')) } catch { X = {} }`，横跨 7 个文件。已有具名版本 `ChatPage.tsx:783 safeParseJson<T>` 与 `crmDocGenCore.ts:34 parseCrmRow` 但无人共用 | 各调用点局部 | 新增 `shared/safeJson.ts`（`parseJsonObject`/`parseJsonArray`），前后端共用；`ChatPage.safeParseJson` 并入 | 低。但需**逐个核对兜底值不同**（`{}` vs `[]` vs `null` vs 保留旧值），**不能一把 `replace_all`** | 对脏数据（非 JSON 字符串、`null`、缺字段）跑受影响用例 |
| **P2-17** | `electron/services/chatService.ts:4120,4193` / `groupAnalyticsService.ts:493,711` / `export/parsers/transferParser.ts:3,13,17,26` ← `export/contacts/groupNickname.ts:1,11,15,24`（规范版） | 重复函数，**语义已分叉** | `buildGroupNicknameIdCandidates`/`normalizeGroupNicknameIdentity`/`normalizeGroupNickname` 在 groupNickname.ts 与 transferParser.ts **逐字符相同**。`resolveGroupNicknameByCandidates` 三处行为分叉：规范版命中第一个即 `return`（**不校验一致性**），另三处**多候选不一致时返回 `''`**（共识校验）。`normalizeGroupNickname` 亦分叉：两处会剥离控制字符，`groupAnalyticsService.ts:493` **不剥离** | groupNickname.ts 被 export 子系统 11 处导入；另三处各持 private 副本 | 以 `export/contacts/groupNickname.ts` 为唯一源并**补齐共识校验分支**（合并更严格语义） | **高**。4 份里 3 份有共识校验、1 份没有；若统一为"无校验版"，会让原本返回空串（拒绝展示）的场景改为展示首个昵称，**直接改变群名显示结果** | 构造「同一群多个候选昵称不一致」样本，对比统一前后三处群名输出是否仍一致 |
| **P2-18** | `opportunity-eval-pack-20260902.ai.jsonl` 等 5 个仓库根运行时文件 | 本地垃圾（**未入库**） | `.gitignore:98-103` 有明确注释：「PIPL：评测集/标注包/分析报告含聊天原文与客户数据，永不入库」「运行期产物…出现在仓库根目录说明是本地跑测试漏下的」。`git status` 确认全部 untracked+ignored | 0（未污染 git） | **本地**删除：`weflow-insight-records.json`、`opportunity-eval-pack-20260902.jsonl`、`.for-review.jsonl`、`opportunity-eval-标注表-20260902.xlsx`、`logs/wcdb.log`(813KB) | — | ⚠️ **`opportunity-eval-pack-20260902.ai.jsonl` 是生产输入，切勿删** —— `evalIpcHandlers.ts:19` 硬编码 `AI_PACK_NAME`，`resolveAiPackPath()` 会在 `app.getAppPath()` 与 `process.cwd()` 找它。删掉只是让 AI 预标注降级（`ai_*` 留空、不报错），但属功能损失 |
| **P2-19** | `electron/services/crmAutoConfirmService.ts:286 startAutoConfirmScheduler` | **功能未装配**（非死代码） | `grep -rn "startAutoConfirmScheduler"` → 仅定义行 1 处。`main.ts` **完全不 import 该模块**；`crmIpcHandlers.ts:13` 只导入 `setDocgenRunner, runAutoConfirmNow, undoAutoConfirm`。而 `.d.ts:6` 明写触发点「② 独立 60s 调度器」——该分支**从未接通** | 0 | ⚠️ **不要当死代码删**。这更像"功能未装配"，删前需确认是否属**待接线** | 中（可能丢功能） | `grep -n "startAutoConfirmScheduler" electron/main.ts` 为 0；确认放弃调度器再删 |
| **P2-20** | `electron/services/export/core/ExportContext.ts:4412 _legacyCursorFallbackFlag` | 死参数（只写不读） | 全文件仅 2 处：`:4412` 形参声明、`:4763` 递归透传；**函数体内无任何读取**。`:4747` 另以位置参数传 `false` | 12 个调用点全部未传该位，均走默认 `true` | 删除形参（含 `.d.ts:402`）；若属预留则改名去掉 `_` 前缀并加 TODO | 低。⚠️ **位置参数删除会左移后续 3 个参数**（`allowRangeFallback`/`useCursorTimeRange`/`allowModeFallback`），必须同步改 `:4747` 递归调用处 | `tsc`；跑一次带日期范围的导出应无行为差异 |

---

## 5. P3 —— 架构级，必须人工决策

> **以下各项删除会丢能力或破坏数据，本阶段一律不动。**

| # | 路径与符号 | 类型 | 判断依据 | 推荐 | 风险 |
|---|---|---|---|---|---|
| **P3-1** | `backupService.ts`（`createBackup`:746/`inspectBackup`:893/`restoreBackup`:1025）vs `autoBackupService.ts` + `autoBackupCore.ts`（`runAutoBackup`:432/`restoreAutoBackup`:561） | 两套备份系统并存 | 目标不同：前者=导出微信原始库/媒体为 tar 包给用户带走；后者=业务库 AES-256-GCM 加密链式备份+新机恢复。但**对用户是同一件事**：`preload.ts:196-211` 同一个 `backup` 命名空间下同时暴露两套；`BackupPage.tsx` **两个都调**（:74/114/138 与 auto 系列）；`main.ts:2863-2871` 与 `:5777` 分别接线 | 不是简单合并（数据面不同）。建议**划清边界并在 UI 上分栏**：「导出给外部 / 本机自动备份恢复」；或把 `backupService` 降为 `autoBackupCore` 的一种 export adapter | **高**。删除任何一个都会丢能力 |
| **P3-2** | `insightRecordService.ts`（文件存储）vs `salesSummaryJudgment.ts` + `salesActionAnalysisJudgment.ts`（写 `customer_judgment` 表，定义 `salesDbService.ts:284`） | AI 判断历史存两份 | `salesSummaryJudgment.ts` 头部自认：「`insight_record` = AI 见解的生成过程与展示载体（原有系统，不动）；`customer_judgment` = 结构化的 AI 判断历史（P0-2C 新容器）……**两表不合并、不互相取代**」。两份都存 `message_key/evidence_text/confidence/source`，都是 append-only AI 判断，且各自实现去重窗口 | 确认新容器是否要最终接管；若长期双存，至少把去重窗口抽成共享常量 | **高**。`insight_record` 是信箱/告警视图的事实源，`alertService` 依赖其 `hasRecentAlert` |
| **P3-3** | `crmDbService.ts`（`lead`:28/`account`:69/`contact`:74/`customer`:202/`customer_identity`:216）与 `salesDbService.ts`（`customer_profile`:236）+ `insightProfileService.ts`（JSON 画像） | 「客户」概念 6 套模型 | 同一个「客户」字段被拆到不同表不同库：`crmFirstClassifyService.ts` 头部明写落库边界「`customer_type` → `customer.type`；`stage` → `customer_profile.stage`；画像字段 → `account` enrich 字段集」。`lead` 用手机号/微信号，`customer` 用 `customer_identity(phone\|wxid)`，`customer_profile` 用 `session_id`——**三种主键语义**。且两库无跨库事务（`crmLeadService.ts` 头部铁律：「两库独立 sql.js 连接，无法单事务……先 crmDb 后 salesDb + 扫描自愈」） | 不合并库（隔离是刻意设计），但需**明确 `customer`(crmDb) 与 `customer_profile`(salesDb) 的单一主键映射**，并把 4 个自动建档入口收口到一个 service | **极高，不可删** |
| **P3-4** | `insightService.ts` / `crmEnrichService.ts` / `salesFollowUpService.ts` / `crmFirstClassifyService.ts` / `crmDeepAnalysisService.ts` | 5 个服务重复同一机制 | 语义输出确实不同（见解/字段/待办/分类/报告），**但机制逐字重复**：`enqueueSalesTask` 串行 + `chatService.getMessages` 取最近 N 条 + `maskPrivateText` 脱敏 + 固定 prompt + `simpleCompletion` + JSON 容错解析 + `extractEvidence` + 「24h 去重窗口」（三个文件头部互相引用来对齐窗口值）。且各自维护一份 `*Core.ts` 纯逻辑壳——**说明作者已识别"纯核心可测"的模式，却没抽公共基类** | 抽 `runChatExtraction({prompt, schema, persist, dedupeWindowMs})` 编排器 | 中。prompt 与解析器差异大，抽编排器时必须**原样保留每个 prompt** |
| **P3-5** | `insightRecordService.ts` / `groupSummaryRecordService.ts` / `insightProfileService.ts` | 三个 JSON 记录存储同构复制 | 三者结构逐字同构：`resolveFilePath()` → `path.join(userData, 'weflow-*.json')`、`ensureLoaded()`、`persist()` 写 `{version:1, records:[]}`、`getCurrentAccountScope()`、`getScopedRecords()`、`addRecord/listRecords/getRecord/clearRecords`、`backupLegacyFile()`。`groupSummaryRecordService` 只多 `writeLogFile/readLogFile` | 抽 `jsonRecordStore<T>` 基类/工厂（`atomicWriteFileSync` + account scope + 版本迁移已具备共性） | 中。三者 record 类型与 legacy 迁移路径不同，抽基类时若把 `backupLegacyFile` 语义统一可能**破坏旧数据升级**；需保留各自迁移分支 |
| ~~P3-6~~ | ~~死路由~~ | — | **本项已作废并升级**：`/dashboard`、`/welcome`、`/biz` 三条死路由经严格全词复核后确认为**零引用**，已升级至 **P0-13 / P0-14 / P0-15**。 | — | — | — |
| **P3-7** | `electron/main.ts:554 AUTO_UPDATE_ENABLED = false` | 已下线 flag 的残留分支 | grep → 定义 + 3 处守卫（`:2512 app:checkForUpdates`、`:2539 app:downloadAndInstall`、`:5467 checkForUpdatesOnStartup`）。三处守卫之后的大段 `autoUpdater.checkForUpdates()` / feed 应用 / 下载逻辑（含 Issue #294 修复、`isDownloadInProgress` 状态机）**运行时永不可达** | ⚠️ **不要删 flag 本身** —— `main.ts:551` 注释说明这是防止二创被上游覆盖的**主动防御**（「此常量是共同守卫」），守卫必须留。建议只删守卫之后的死体，或整体保持现状 | 中。删除守卫会**破坏防线** |
| **P3-8** | `electron/services/chatService.ts`(134) / `main.ts`(51) / `wcdbCore.ts`(24) / `httpService.ts`(21) / `keyServiceLinux.ts`(19) / `ExportContext.ts`(19) / `snsService.ts`(17) | 日志体系半收口 | `electron/` 共 488 处 `console.*`（111 处 log/debug/info）。`salesLogger.ts` 是**唯一**落盘日志实现（写 `userData/logs/weflow-sales.log`，2MB 轮转），有 10+ 消费方，`main.ts:2446` 还提供 `log:debug` IPC 把渲染层日志接进来。**但这套体系只覆盖 Sales 域**，其余 400+ 处仍是裸 `console`，**打包后不可见**——与 `salesLogger.ts` 头注释描述的痛点完全同构 | 决策：**推广 `salesLogger` 到全 electron 主进程**（工作量大、有收益：打包版可排障），还是**接受现状** | — |
| **P3-9** | `src/pages/ChatPage.tsx:10150,10153,12475,10538,3729,3740,3808,3837,5022,5178`；`src/components/GlobalSessionMonitor.tsx:118,160,167,180` | 调试味道的日志残留 | `ChatPage`：`[Video Debug] Failed to parse MD5`、`[Transfer Debug] Parse error`、`console.info('[UI] image decrypt click (force HD)', {...})`（带对象快照的交互 trace）、`[性能监控]` 耗时打印 ×4、`[GlobalMsgSearch] shadow compare mismatch/failed`（灰度校验，上线后应摘）。`GlobalSessionMonitor` 的 4 处是 `if (window.electronAPI.log?.debug) {...} else { console.log(...) }` 兜底分支——生产环境走 IPC 写日志，**意味着每一次通知过滤判断都会落一条 DEBUG 日志**（持续性噪音） | 清理 `ChatPage` 的 Debug/性能监控/shadow-compare 日志；`GlobalSessionMonitor` 的通知日志降级或抽到受控开关 | 低 |
| **P3-10** | `scripts/migration/01-decision-b-cleanup.ts`、`02-account-to-customer.ts`、`03-lead-to-identity.ts` | 已执行完的历史迁移脚本 | 逐个查 importer：**01/02/03 各 0 引用**；`04-history-deal-opportunity.ts` 有 2 个（被 `crm-opportunity-test.ts:17` import）；`types.ts` 有 1 个。决定性证据：`docs/HANDOVER.md:980`「2026-09-04 后续注记（live 已真实执行）：用户重启应用后 live 库已由启动链路真实跑完 02/03」 | **归档而非删除** —— 移入 `docs/archive/` 或加 `@historical` 头注。它们是迁移口径的唯一可追溯记录 | 中（会丢失迁移口径溯源） |

---

## 6. 白名单 —— 看起来可疑但**明确不可动**

> 本组一项都不要做。列出是为了阻止后续（含 AI Agent）误删。

| 项 | 位置 | 为何不动 |
|---|---|---|
| **`.tmp` / `temp` 命名（35 处）** | `atomicPersist.ts:51`（`${targetPath}.tmp-${process.pid}` → `fsync` → `renameSync`）、`autoBackupCore.ts:153`、`autoBackupKeyVault.ts:98`、`ExportContext.ts:478`、`lanSyncService.ts:12` | **原子写模式**，名字诚实且是刻意设计（「消费者只认 `*.json`，`.tmp` 半截文件永不入眼」）。**改名会破坏原子性契约** |
| **`legacy` 命名（57 处）** | `businessDbPath.ts`（12 处，文件头完整说明「空 wxid 回退 legacy 名」迁移语义）、`autoBackupKeyVault.ts`、`salesDbService.ts:427`、`autoBackupCore.ts:135/187` | 微信号分库（§2.40）的**向后兼容回退**。删掉会导致**未完成引导的用户库文件找不到** |
| **`electron/**/*.d.ts`（123 个文件）** | — | `.gitignore:37` 有显式规则与注释（tsc 原位 emit 的中间态）。`git check-ignore -v` 证实被忽略；`git ls-files \| grep -c '\.d\.ts$'` = 0。**这是有意为之** |
| **5 处 `openDevTools()`** | `electron/main.ts:1216,1564,1622,1707,1782` | **全部**位于 `if (process.env.VITE_DEV_SERVER_URL)` 块内，是合规的开发期守卫 |
| **硬编码 UA 串** | `avatarFileCacheService.ts:119`、`main.ts:1110`、`snsService.ts:1336`、`voiceTranscribeService.ts:462/505/541`、`social/weiboService.ts:9` | 刻意伪装微信 PC 客户端 UA，**功能性必需** |
| **`127.0.0.1` / 端口 `5031`** | `httpService.ts:130,156,357`、`config.ts:298` | **安全默认值**（仅本机绑定），非残留。见附录 C |
| **`mockGlobal` 等 12 处 "mock"** | `electron/services/wasmService.ts:57-122` | Node `vm.createContext` 里模拟浏览器全局对象的**生产代码**，非测试桩 |
| **`154618822705: '[小程序]'`** | `chatService.ts:7452` | 微信消息类型常量的魔数映射 |
| **`13800138000`/`13900139000`** | `CrmLeadPage.tsx:1048` | textarea 的 `placeholder` 示例文案，非数据 |
| **`electron/utils/LRUCache.ts`** | 被 `chatService.ts:23`、`ExportContext.ts:20`、`ExportOrchestrator.ts:18`、`ExportStatsService.ts:19` 以 `'../utils/LRUCache.js'`（**带 `.js` 后缀**）导入 | **不是孤儿** —— 简易解析器会漏判 |
| **`electron/preload-env.ts`** | `main.ts:2` 以**裸副作用形式** `import './preload-env'`（无 `from`） | 同上，**不是孤儿** |
| **`src/styles/batchTranscribe.scss`** | 被 `ChatPage.scss` 引用 | 即使 `BatchTranscribeGlobal.tsx`（P0-7）被删，**此 scss 仍要保留** |
| **`/dual-report` + `/dual-report/view`** ⚠️ | `App.tsx:755-756` | **是活路由，不要删**。可达链：`Sidebar.tsx:446 to="/annual-report"` → `AnnualReportPage.tsx:226 navigate(\`/dual-report?year=${yearParam}\`)` → `DualReportPage.tsx:67 navigate(\`/dual-report/view?username=...\`)`。**入口是模板字符串**，按 `'/dual-report'` 字面量 grep 会漏判——本报告初稿即因此误判，已修正 |
| **`/analytics/view`、`/group-analytics`** | `App.tsx:751-752` | **不是死路由** —— 两者是 `<RouteStateRedirect>` **遗留书签重定向垫片**，有意保留（老书签兼容） |
| **`crmSla2*` 三层 / `hermesAgent` 双轨 / `keyService*` 平台分派 / `*Core.ts` + `*Service` 分层** | — | 逐项读过两边，**判定不是重复**：分别是规则/LLM/证据三层、in-process 测试 adapter vs UtilityProcess（注释明确「旧进程内 Agent 只能作测试 adapter，严禁作为运行时回退」）、平台分派、刻意的纯逻辑核+装配壳分层 |

---

## 7. 建议执行顺序

```
第 1 批（零风险，一次提交）
  P0-1 ~ P0-15  全部                           验证：npx tsc --noEmit + npm run build
  ⭐ 其中 P0-13（/dashboard 6 层死链）建议单独一个 commit，便于回溯
  
第 2 批（同构批量清理，单独提交便于回滚）
  P2-1 ~ P2-6、P2-7、P2-9 ~ P2-12、P2-14      验证：tsc + 对应链路 smoke

第 3 批（需伴随改动）
  P1-1（先改 scripts/hermes-ask-test.ts 断言）
  P1-3（死 IPC，含安全项）
  P1-4（Linux Debug 日志）
  P1-6（今日行动死链）
  P1-7（阶段分类两套实现）
  P1-8（38 个 preload IPC，分层处理）

第 4 批（需先补差异再合并，逐项 diff 验证）
  P2-15（消息编解码，双跑 diff）
  P2-17（群昵称，共识校验样本比对）
  P2-16（内联 JSON 解析，逐处核对兜底值）
  P1-5（AI 调用层，需核对 usage 口径与 abort 语义）
  P2-8（手机号/脱敏，需列展示位数变更清单）

第 5 批（需产品拍板）
  P2-13（阶段文案统一 —— 可见 UI 变更）
  P2-7 中涉及「去掉多余 export」的部分

第 6 批（架构级，必须人工决策后才动）
  P3-1 ~ P3-10
  
第 7 批（流程阻塞，待用户指示）
  P1-2（移除依赖 —— 触碰 lock 文件约束）
```

**每批统一验证**：`npx tsc --noEmit` 零错误 → 相关 `scripts/*-test.ts` 通过 → 手工 smoke 对应页面。

---

## 附录 A：仓库血缘与许可证（**独立事项，优先级可能高于本审计全部内容**）

### A.1 血缘

WeFlow 是 **`hicccc77/WeFlow`**（开源微信聊天记录查看/导出工具）的衍生作品。

| 项 | 值 |
|---|---|
| 上游最后提交 | 2026-07-07（PR #1140） |
| 本仓库首次提交 | 2026-07-24（作者 `yang`） |
| 贡献者 | cc(565) / yang(303) / xuncha(253+186) / tisonhuang(156) / aits2026(141) / hicccc77(135) / H3CoF6(65) / Jason(64+61) |

**代码归属统计**（按新增行，不含合并提交）：

| 作者 | 新增行 | 占比 |
|---|---|---|
| cc | 358,548 | 56.5% |
| **yang（本项目 CRM 改造）** | **122,912** | **19.4%** |
| xuncha | 52,259 | 8.2% |
| 其余 6 人 | 101,310 | 15.9% |

→ **上游社区合计 80.6%，本项目改造仅 19.4%。**

**文件级归属**：`src/` + `electron/` + `shared/` + `scripts/` 中，**228 个文件 / 123,315 行从未被 `yang` 触碰**（当前最后修改者为上游作者）——约占代码量 **46%**。

### A.2 许可证

`LICENSE` = **CC BY-NC-SA 4.0**（署名-非商业性使用-相同方式共享 4.0 国际），由上游作者 `cc` 于 2026-06-30 添加，**本仓库从未修改**。

关键约束：
- **NC（非商业性使用）** —— 禁止商业用途
- **SA（相同方式共享）** —— 衍生作品须以相同许可证发布

### A.3 状态

⚠️ **此事尚未由用户答复。** 已向用户说明：我不是律师，不构成法律意见。三条可能路径：① 联系上游获取商业授权；② 接受 ShareAlike 以同许可证发布；③ 剥离上游代码。

**建议：在许可证问题明确前，不要公开发布含上游代码的仓库。**

### A.4 上游残留清单（与许可证剥离相关）

| 项 | 位置 | 说明 |
|---|---|---|
| `LICENSE` | 根目录 | CC BY-NC-SA 4.0，上游作者 `cc` 添加 |
| `README.md` | 根目录 | **仍在描述上游产品**（「微信聊天记录查看、分析与导出工具」），最后修改 2026-07-11，作者 "lily Sally" |
| `.github/workflows/*.yml` | 5 个 | `anti-spam` / `dev-daily-fixed` / `issue-auto-assign` / `preview-nightly-main` / `release` —— 上游社区 CI，**自 fork 起从未改动**，对私有仓库无意义 |
| `docs/MAC-KEY-FAQ.md` | 1 个 | 上游文档（`cc`, 2026-06-30） |
| `docs/HTTP-API.md` | 1 个 | 上游文档（`cc`, 2026-07-06） |
| `temp_assets.json` | 根目录 | 上游 WeFlow 4.1.8 发布产物清单（见 P0-1） |
| `electron/services/httpService.ts` | 2,702 行 | 上游 HTTP API 服务（见附录 C） |
| `src/pages/` 22 个、`electron/services/` 227 个 | — | 自 CRM 工作（2026-07-24）以来未被改动，最后修改时间均 ≤ 2026-07-07 |

`docs/` 目录共 70 个文件，其中**仅 2 个是上游的**，其余 68 个均为 `yang` 创建。

---

## 附录 B：PII 与历史改写状态

| 项 | 状态 |
|---|---|
| 工作树清洗 | ✅ **已完成** —— 13 个文件中的真实客户数据（手机号、地址、税号、银行账号、姓名、公司名）已替换为合成值；`npx tsc --noEmit` 退出码 0；7 个受影响测试脚本全部通过 |
| 替换映射表 | `/tmp/scrub-map.json`（57 条规则） |
| 清洗引擎 | `/tmp/scrub.py`（`worktree` / `blobmap` 两种模式） |
| **git 历史改写** | ❌ **未执行** —— blob map 生成到一半被中断。工作树已干净，但历史提交中仍含真实数据 |
| 清理文件 | `docs/UI美化-报表与CRM-设计稿.html`(5 个手机号+姓名)、`scripts/crm-claim-test.ts`(6 个真实收货地址)、`scripts/crm-docgen-test.ts`、`electron/services/crmParseRules.ts:34` 等 |
| **刻意不清洗** | `electron/services/config.ts:339 crmSalesList: ['杨青','李林辉','许丽娟']` —— 真实**员工**姓名，作为默认配置值使用，属业务数据非客户 PII |

---

## 附录 C：网络暴露面（安全审计结论）

**全仓仅一处网络监听**：`electron/services/httpService.ts`。

| 项 | 值 |
|---|---|
| 默认状态 | **关闭**（`config.ts:296 httpApiEnabled: false`；`autoStart()` 读该配置，关闭时**根本不启动**） |
| 绑定地址 | `127.0.0.1`（可配置；设置页说明可改 `0.0.0.0` 供 Docker/N8N 场景） |
| 端口 | `5031` |
| 鉴权 | ✅ 除健康检查外全部 `/api/v1/*` 受 `access_token` 保护；支持 Header / Query / Body 三种传参 |
| 功能 | 读取聊天记录、会话、联系人、群成员、媒体文件；SSE 消息推送 |
| 规模 | 2,702 行（上游代码） |

**结论**：不是活跃漏洞（默认关闭 + 仅本机 + 有鉴权）。但**对 CRM 是无用功能面**——它服务于上游的"外部脚本读取聊天数据"场景，CRM 版不需要。

**其他**：`electron/services/lanSyncService.ts`（1,198 行）走**共享目录文件交换**（`readdirSync`/`renameSync`），**不开监听端口**。

---

## 附录 D：工程基线

| 项 | 现状 |
|---|---|
| **测试框架** | ❌ **完全没有** —— 27 个 dependencies + 14 个 devDependencies 中，**无 vitest / jest / mocha / playwright / cypress / @testing-library** |
| **实际测试** | `scripts/` 下有 **92 个 `*-test.ts`** 手写断言脚本（约 3,092 个 `ok()` 断言），但**只有 2 个接入 npm**：`test:autoconfirm`、`test:docgen` |
| **类型检查** | ✅ `npm run typecheck` → `tsc --noEmit` |
| **脚本目录** | 106 文件 / 23,120 行。67 个涉及 DB/文件系统，但仅 **4 个触及真实 userData 路径**（`canonical-state-validate.ts`、`p0-3-closed-gate.ts`、`p0-2-real-db-audit.ts`、`p01-evidence-inspect.ts`）；74 个使用临时目录 |
| ⚠️ **破坏性脚本** | `scripts/crm-cleanup-orphans.ts` —— 会**备份后**从真实 `weflow-crm.db` 删除行 |
| **零引用脚本** | 仅 1 个：`scripts/hermes-error-message-test.ts` |
| **相似命名文件对** | 0 组 |

> **建议（超出本次收口范围）**：92 个手写测试脚本是实际存在的测试资产，但未接入 CI。**不要删除它们**（符合用户「不要删除正式单元测试、集成测试、E2E 测试」的约束）。若要提升可维护性，可考虑后续用 Vitest 包一层，但**不属本次收口范畴**。

---

## 附录 E：审计边界声明

1. 本报告**未删除、未修改任何代码**（除工作树 PII 清洗，该项独立进行且已完成）。
2. 所有"零引用"结论均已声明扫描范围。**本报告在成稿后修正了两处误判**，记录如下（两者都是"假阳性删除建议"，值得后来者引以为戒）：
   - **漏扫 `scripts/` 目录** → `src/components/sales/KnowledgeAskPanel.tsx` 一度被判为 P0 零引用，实际被 `scripts/hermes-ask-test.ts:91,141` 以 `readFileSync` 引用。已降级为 P1-1。
   - **模板字符串入口逃过字面量检索** → `/dual-report` 一度被判为死路由，实际入口是 `AnnualReportPage.tsx:226` 的 `` navigate(`/dual-report?year=${yearParam}`) ``。按 `'/dual-report'` 字面量 grep 无法命中。已从死路由清单移除并列入白名单。
   - 教训：**"零引用"结论必须同时声明「扫描范围」与「检索方式」**（全词/字面量/正则），否则模板字符串、`.js` 后缀导入、裸副作用导入、`scripts/` 目录这四类都会造成漏判。
3. 所有重复代码判定均基于**实际读取两处实现并逐行比对**，非文件名相似推断。
4. 明确排除在审计外的目录：`node_modules/ dist/ dist-electron/ release/ out/ .git/ weflow-web-offical/ resources/ packages/`。
5. **`electron/**/*.d.ts`（123 个）为构建中间产物，未纳入审计**（见白名单）。
6. 本次审计**不包含**运行时性能分析、依赖漏洞扫描（CVE）、许可证合规的完整法律分析。

---

**审计结束。等待确认后再进入第二阶段（执行清理）。**
