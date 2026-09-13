<!-- 本文件由 2026-07-24 Codex 会话中的 PRD 原文提取保存，供后续会话读取 -->

# WeFlow AI 销售助手 — 产品需求文档（PRD）v0.2

> 状态：已归档（原文件即位于归档目录）
> 归档日期：2026-09-13
> 替代文档：链条为 `PRD-v2-销售行动驱动器.md` → `weflow-hermes-PRD-v3.1.md`（均在归档内）→ 当前权威 `docs/规划/weflow-hermes-PRD-v3.4.md`
> 本文仅供历史追溯，不得作为当前开发或设计依据。

## 摘要

基于 WeFlow v5.0.0 源码（Electron 43 + React 19 + Vite 8 + TypeScript + Zustand）进行二次开发，在现有微信数据读取和 AI Insight 体系基础上，扩展销售辅助能力。本文档为 v0.1 草案的优化版，核心改动：明确复用现有 AI 基础设施、采用独立 SQLite 存储、调整功能优先级、补充技术细节。

**适用范围**：个人非商用场景，叉车/工业设备 B2B 销售  
**基线版本**：WeFlow v5.0.0（`deyyangyang-bit/WeFlow` fork，不依赖上游更新）

---

## 一、需求背景与目标

### 1.1 背景

现有链路：WeFlow 导出聊天记录 → DeepSeek 打标 → 人工审核 → 导入 CRM（月度批处理）。解决了"数据能不能拿到"的问题，但缺少主动介入销售动作的能力。

WeFlow 源码中已具备：
- **AI Insight 服务**（`insightService.ts`）：DB 变更监听 → 聊天上下文拉取 → AI 生成见解 → 通知推送
- **AI 画像服务**（`insightProfileService.ts`）：按月汇总聊天 → AI 生成客户画像
- **年度报告引擎**（`annualReportService.ts`）：Worker 线程中运行，消息统计、Top 联系人、活跃度热力图
- **通知窗口**（`notificationWindow`）：右下角弹窗通知
- **ECharts 图表组件**：已集成 echarts 6 + echarts-for-react

### 1.2 目标

在 WeFlow 现有基座上扩展：
1. 话术/产品知识沉淀与检索
2. 周期性经营分析（周报/月报）
3. 客户画像与意向识别
4. 智能回复辅助
5. 主动提醒与预警

### 1.3 非目标（本期不做）

- 多账号/团队协同
- 商业化/多租户
- 向量数据库
- CRM 双向同步（仅预留扩展字段）

---

## 二、功能模块与优先级

| 优先级 | 模块 | 功能说明 | 依赖 |
|--------|------|----------|------|
| **P0** | 话术/产品知识库 | 产品参数、话术、FAQ 的增删改查 + 关键词搜索 + 分类标签 | 无 |
| **P0** | 周报/月报分析 | 消息量、活跃客户、意向分布统计 + ECharts 图表 + AI 文字摘要 | aiApiClient |
| **P1a** | 客户画像卡片 | 聚合单客户历史互动、标签、跟进记录；改造现有 insightProfileService | SQLite |
| **P1b** | 客户意向分级与标签 | 对聊天记录按阶段打标（了解/比价/决策/流失），支持人工修正 | aiApiClient + 画像 |
| **P1c** | 智能回复建议 | 知识库检索 + 当前对话上下文 → 生成可选回复草稿 | 知识库 + aiApiClient |
| **P2** | 跟进提醒/待办 | 识别"约定时间联系""问价未回复"等场景，生成待办 | 画像 + 意向 |
| **P2** | 高意向实时预警 | 新消息触发意向判断，达阈值即时通知（复用现有通知窗口） | 意向分级 |

**CRM 集成**（含双向同步、转化归因）由后续自行添加，本期仅在数据结构上预留 `customer_id`、`external_source` 字段。

---

## 三、详细功能设计

### 3.1 话术/产品知识库（P0）

**功能点**：
- 知识条目管理：新增/编辑/删除
- 分类体系：按产品线、场景（初次接触/报价/异议处理/售后）、常见问题
- 搜索：关键词 LIKE 匹配 + tags JSON 过滤（数据量 <1000 条，无需 FTS）
- 与 AI 打通：生成回复建议时，自动检索匹配条目拼入 prompt

**数据表 `knowledge_base`**：
```sql
CREATE TABLE knowledge_base (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,          -- 分类：product/script/faq
  product_line TEXT,               -- 产品线（如"电动叉车""内燃叉车"）
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT DEFAULT '[]',          -- JSON 数组
  scene TEXT,                      -- 适用场景
  created_at INTEGER NOT NULL,     -- Unix 时间戳（毫秒）
  updated_at INTEGER NOT NULL
);
```

### 3.2 周报/月报分析（P0）

**功能点**：
- 统计维度：消息总量、活跃联系人数、新增联系人数、Top N 高互动客户
- 展示：ECharts 图表（柱状图/折线图/饼图）+ AI 自然语言摘要
- 周期选择：支持按"周/月"任意周期取数
- 触发方式：手动生成（点击按钮）；暂不做定时自动生成（桌面应用不保证在线）

**实现方式**：
- 新建 `salesReportWorker.ts`（Worker 线程），复用 `wcdbService` 读取聊天数据
- 统计逻辑参考 `annualReportService.ts` 的模式
- AI 摘要调用 `aiApiClient`

**数据表 `report_snapshot`**：
```sql
CREATE TABLE report_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL,       -- 'week' | 'month'
  period_start INTEGER NOT NULL,   -- Unix 时间戳
  period_end INTEGER NOT NULL,
  stats TEXT NOT NULL,             -- JSON：各维度统计数据
  ai_summary TEXT,                 -- AI 生成的文字摘要
  created_at INTEGER NOT NULL
);
```

### 3.3 客户画像卡片（P1a）

**功能点**：
- 聚合单客户的：历史消息统计、互动时间线、AI 画像文本、意向标签、跟进记录
- 改造现有 `insightProfileService`，新增销售相关字段

**数据表 `customer_profile`**：
```sql
CREATE TABLE customer_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,        -- 微信会话 ID（关联 WCDB）
  display_name TEXT,
  customer_id TEXT,                -- 预留：CRM 客户 ID
  external_source TEXT,            -- 预留：数据来源标识
  stage TEXT DEFAULT 'unknown',    -- 意向阶段：了解/比价/决策/成交/流失
  tags TEXT DEFAULT '[]',          -- JSON 数组
  notes TEXT,                      -- 手动备注
  last_contact_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 3.4 客户意向分级（P1b）

**功能点**：
- AI 分析聊天记录，输出意向阶段（了解/比价/决策/流失）+ 置信度
- 支持人工修正标签
- 标签变更记录可追溯

**数据表 `intent_tag_log`**：
```sql
CREATE TABLE intent_tag_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  confidence REAL,                 -- AI 置信度 0-1
  source TEXT NOT NULL,            -- 'ai' | 'manual'
  reason TEXT,                     -- AI 判断依据 / 人工修正原因
  created_at INTEGER NOT NULL
);
```

### 3.5 智能回复建议（P1c）

**功能点**：
- 在聊天页面提供"AI 建议回复"入口
- 检索知识库匹配条目 + 当前对话最近 N 条消息 → 组装 prompt → 生成 2-3 条可选回复草稿
- 用户可一键复制或编辑后发送

### 3.6 跟进提醒/待办（P2）

**数据表 `follow_up_task`**：
```sql
CREATE TABLE follow_up_task (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  customer_profile_id INTEGER,
  trigger_type TEXT NOT NULL,      -- 'promise_contact' | 'unanswered_quote' | 'manual' | 'ai_detected'
  title TEXT NOT NULL,
  due_at INTEGER,
  status TEXT DEFAULT 'pending',   -- 'pending' | 'done' | 'dismissed'
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

### 3.7 高意向实时预警（P2）

- 监听 DB 变更（复用 insightService 的 debounce 模式）
- 新消息触发意向判断，达到"决策"阶段阈值时通过现有 `showNotification` 弹窗提醒

---

## 四、技术方案

### 4.1 整体架构

沿用 WeFlow 现有 Electron + React 技术栈，增量模块方式：

```
┌─────────────────────────────────────────────────────────┐
│  渲染进程 (React)                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │KnowledgeBase│ │SalesReport│ │CustomerCard│ │ReplySuggest│ │
│  │  Page.tsx  │ │  Page.tsx  │ │  组件      │ │  组件      │ │
│  └─────┬────┘ └─────┬────┘ └─────┬────┘ └─────┬────┘   │
│        │             │             │             │        │
│  ┌─────┴─────────────┴─────────────┴─────────────┴────┐  │
│  │         Zustand Stores (knowledgeStore, etc.)       │  │
│  └─────────────────────┬───────────────────────────────┘  │
│                        │ window.electronAPI.sales.xxx()   │
├────────────────────────┼──────────────────────────────────┤
│  preload.ts            │ (contextBridge)                  │
├────────────────────────┼──────────────────────────────────┤
│  主进程                │                                  │
│  ┌─────────────────────┴───────────────────────────────┐  │
│  │  ipcMain.handle('sales:xxx')                        │  │
│  └──┬──────────────┬──────────────┬────────────────────┘  │
│     │              │              │                        │
│  ┌──┴───┐   ┌──────┴──────┐  ┌───┴────────────┐         │
│  │Sales │   │salesReport  │  │ aiApiClient    │         │
│  │KB    │   │Worker.ts    │  │ (共享AI调用层) │         │
│  │Service│  │(Worker线程) │  └───┬────────────┘         │
│  └──┬───┘   └──────┬──────┘      │                      │
│     │              │              │                      │
│  ┌──┴──────────────┴──┐    ┌─────┴─────┐               │
│  │ weflow-sales.db    │    │ DeepSeek  │               │
│  │ (better-sqlite3)   │    │ API       │               │
│  └────────────────────┘    └───────────┘               │
│                                                         │
│  ┌────────────────────┐                                 │
│  │ wcdbService        │ ← 只读访问微信聊天数据          │
│  │ (Worker → WCDB)    │                                 │
│  └────────────────────┘                                 │
└─────────────────────────────────────────────────────────┘
```

### 4.2 关键技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 业务数据存储 | 独立 SQLite 文件（`weflow-sales.db`），使用 `better-sqlite3` | 与微信 WCDB 解耦，支持 SQL 查询/聚合，单文件备份，利于未来 CRM 迁移 |
| AI 调用层 | 抽取共享 `aiApiClient.ts`（从 insightService 提取 HTTP 调用逻辑） | 消除现有两份重复代码，统一配置（复用 `aiModelApiBaseUrl` 等），新业务服务共用 |
| 知识库检索 | 关键词 LIKE + tags JSON 过滤 | 数据量 <1000 条，无需 FTS5 或向量检索 |
| 报表引擎 | 新建 `salesReportWorker.ts`（Worker 线程），复用 wcdbService 读数据 | 与年度报告同模式，不阻塞主进程 |
| AI 配置 | 复用现有设置页的 `aiModelApiBaseUrl/ApiKey/ApiModel` | 用户已配置，无需重复设置 |
| 状态管理 | Zustand（沿用现有方案） | 项目已有 9 个 store，模式成熟 |
| 图表 | ECharts（沿用现有依赖） | 已集成 echarts 6 + echarts-for-react |
| 定时任务 | 暂不引入 | 桌面应用不保证在线，报表改为手动触发；P2 预警复用 insightService 的 DB 监听 |

### 4.3 AI 服务层重构

**新增 `electron/services/ai/aiApiClient.ts`**：
- 从 `insightService.ts` 和 `insightProfileService.ts` 中提取公共 HTTP 调用逻辑
- 接口：`callChatCompletion(messages, options?) → Promise<string>`
- 配置读取：`aiModelApiBaseUrl`、`aiModelApiKey`、`aiModelApiModel`、`aiModelApiMaxTokens`
- 错误处理：超时（45s）、重试（可配置）、静默降级
- 使用 Node 原生 `https/http`，不引入额外依赖

**改造现有服务**：
- `insightService.ts`：内部 `callApi()` 改为调用 `aiApiClient`
- `insightProfileService.ts`：同上

**新增业务服务**（均调用 `aiApiClient`）：
- `salesReportService.ts`：报表 AI 摘要
- `salesIntentService.ts`：意向分级判断
- `salesReplyService.ts`：回复建议生成

### 4.4 数据库设计

- 文件位置：`app.getPath('userData')/weflow-sales.db`
- 初始化：主进程启动时检查并执行 migration
- 访问方式：主进程同步 API（`better-sqlite3`），通过 `ipcMain.handle('sales:xxx')` 暴露
- 与微信数据关联：通过 `session_id`（微信会话 ID）外键关联，只读访问 WCDB

### 4.5 IPC 通道设计

在 `electron/main.ts` 中注册（沿用现有模式）：

```typescript
// 知识库
ipcMain.handle('sales:kb:list', ...)
ipcMain.handle('sales:kb:create', ...)
ipcMain.handle('sales:kb:update', ...)
ipcMain.handle('sales:kb:delete', ...)
ipcMain.handle('sales:kb:search', ...)

// 报表
ipcMain.handle('sales:report:generate', ...)
ipcMain.handle('sales:report:list', ...)
ipcMain.handle('sales:report:get', ...)

// 客户画像
ipcMain.handle('sales:customer:get', ...)
ipcMain.handle('sales:customer:update', ...)

// 意向标签
ipcMain.handle('sales:intent:analyze', ...)
ipcMain.handle('sales:intent:correct', ...)
ipcMain.handle('sales:intent:history', ...)

// 回复建议
ipcMain.handle('sales:reply:suggest', ...)

// 待办
ipcMain.handle('sales:todo:list', ...)
ipcMain.handle('sales:todo:create', ...)
ipcMain.handle('sales:todo:update', ...)
```

在 `electron/preload.ts` 中暴露 `window.electronAPI.sales` 命名空间。

---

## 五、目录结构

```
electron/
├── services/
│   ├── ai/
│   │   └── aiApiClient.ts          # 新增：共享 AI API 调用层
│   ├── salesKnowledgeService.ts    # 新增：知识库 CRUD + 搜索
│   ├── salesReportWorker.ts        # 新增：周/月报统计 Worker
│   ├── salesIntentService.ts       # 新增：意向分级
│   ├── salesReplyService.ts        # 新增：回复建议
│   ├── salesDbService.ts           # 新增：weflow-sales.db 管理 + migration
│   ├── insightService.ts           # 改造：callApi → aiApiClient
│   └── insightProfileService.ts    # 改造：callApi → aiApiClient
├── main.ts                         # 新增 sales:xxx IPC handler 注册
└── preload.ts                      # 新增 sales 命名空间

src/
├── pages/
│   ├── KnowledgeBasePage.tsx       # 新增：知识库管理页面
│   ├── KnowledgeBasePage.scss
│   ├── SalesReportPage.tsx         # 新增：周报/月报页面
│   └── SalesReportPage.scss
├── components/
│   ├── sales/
│   │   ├── KnowledgeForm.tsx       # 知识条目编辑表单
│   │   ├── KnowledgeSearch.tsx     # 搜索框 + 过滤
│   │   ├── ReportChart.tsx         # 报表图表组件
│   │   ├── CustomerCard.tsx        # 客户画像卡片（P1）
│   │   └── ReplySuggestion.tsx     # 回复建议面板（P1）
├── stores/
│   ├── knowledgeStore.ts           # 新增
│   └── salesReportStore.ts         # 新增
├── services/
│   └── ipc.ts                      # 新增 sales 相关封装
└── types/
    └── electron.d.ts               # 新增 sales API 类型声明
```

---

## 六、开发顺序

```
第一阶段：基础设施（1-2 周）
  ① salesDbService.ts + migration 框架（建表）
  ② aiApiClient.ts（从 insightService 抽取）
  ③ preload.ts + main.ts 注册 sales IPC 通道
  → 验收：跑通一个最简单的 IPC 调用（如 sales:kb:list 返回空数组）

第二阶段：P0 功能（2-3 周）
  ④ 知识库：后端 CRUD + 前端页面（列表/表单/搜索）
  → 验收：手动录入 10 条产品知识，搜索可用
  ⑤ 周报/月报：Worker 统计 + ECharts 图表 + AI 摘要
  → 验收：生成本周报告，数据与聊天记录一致

第三阶段：P1 功能（2-3 周）
  ⑥ 客户画像卡片（改造 insightProfileService + 销售字段）
  ⑦ 意向分级（prompt 工程 + 标签存储 + 修正 UI）
  ⑧ 智能回复建议（知识库检索 + 上下文 + 草稿生成）

第四阶段：P2 功能（1-2 周）
  ⑨ 跟进提醒/待办
  ⑩ 高意向实时预警（复用通知窗口）
```

每完成一个阶段做一次实际业务场景验证，确认功能可用后再推进下一阶段。

---

## 七、风险与应对

| 风险 | 应对 |
|------|------|
| 上游停更（WeFlow 官方仓库已清空） | 基于 v5.0.0 fork 独立维护 |
| 数据结构耦合 | 业务表独立 SQLite，仅通过 session_id 关联 WCDB，不修改原始表 |
| AI 调用成本与延迟 | 非实时场景（周月报）异步生成；实时场景（回复建议）控制上下文长度 ≤2000 字 |
| AI 不可用降级 | 知识库搜索纯本地不依赖 AI；回复建议在 AI 不可用时提示"仅显示知识库匹配结果" |
| better-sqlite3 打包 | Electron 生态成熟，需 `electron-rebuild`；已有 postinstall 脚本处理 |
| 单人开发节奏 | 严格按阶段推进，每阶段先跑通闭环 |

---

## 八、假设与默认选择

- AI 模型配置复用现有设置页（用户已配置 DeepSeek API）
- 知识库数据量 <1000 条，无需全文检索引擎
- 报表为手动触发生成，暂不做定时任务
- 意向分级标签体系初始为：了解/比价/决策/成交/流失（5 级），后续可扩展
- 回复建议生成 2-3 条草稿供选择
- 本期不做数据加密（本地个人使用）
- `better-sqlite3` 作为新依赖引入（~2MB）