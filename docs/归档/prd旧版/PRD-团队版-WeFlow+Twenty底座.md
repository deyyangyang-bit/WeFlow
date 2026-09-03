# PRD · WeFlow 团队版（微信 AI 引擎 × Twenty CRM 底座）

> 状态：预研方案（2026-08-18 基于 Twenty 源码调研产出）
> 场景：**私有化部署，团队内部使用**（非对外商业产品）
> 关联：`HANDOVER-20260818`（现有 WeFlow CRM 现状）、`docs/archive/`（历史决策）
> 数据来源：Twenty 本地 clone（`ccode/third-party/open-source/twenty`）源码实读

---

## 1. 背景与目标

### 1.1 现状

WeFlow 是单机 Electron 桌面应用：读微信本地库(WCDB) → AI 分析 → 客户 360 / 自动填充 / 报价跟进 / 行动引擎。**价值全部在"微信数据 → 销售行动"管道**，但只有一个人能用。

### 1.2 目标

- 团队多人共用一个销售数据底座（客户/商机/产品/流程）
- 保留 WeFlow 独有的微信 AI 管道（护城河，不重写）
- 私有化部署在内网，数据 100% 自主可控
- 不做对外商业分发，内部使用即可

### 1.3 非目标

- 不做跨团队 SaaS 多租户商业化
- 不把 WeFlow 微信引擎重写为通用 CRM
- 移动端（列入远期）

---

## 2. 方案选型结论（已调研对比）

| 维度 | CordysCRM | **Twenty（选定）** |
|---|---|---|
| 哲学 | 开箱即用完整 CRM | 给你构建块，你自己 build |
| 技术栈 | Java + Vue + MySQL/Redis | **TS + React + PostgreSQL（与 WeFlow 同栈）** |
| 开箱功能 | 报价/合同/发票/回款/审批/BI 全 | 核心对象模型强，流程模块自建 |
| AI 生态 | MCP + Skills + MaxKB | **官方 Claude Skills / Codex 插件 / MCP** |
| 定制 | Java 二次开发 | **Code-first**：SDK/CLI 代码定义对象 |
| License | GPLv3 + 附加条款 | AGPL-3.0 + Enterprise 闭源部分 |
| 活跃度 | 飞致云，月更 | 社区头部，迭代快 |

**选择理由**：
1. 技术栈完全贴合（TS/React/PostgreSQL），WeFlow 开发者无学习成本
2. 官方 Claude Skills + MCP，AI 集成是原生设计
3. Code-first 自定义对象，微信特有数据（会话/报价信号/行动项）可声明式建模
4. 我们不需要 CordysCRM 开箱的完整流程——团队版核心是**微信 AI 管道 + 团队共享**，流程自建更能贴合叉车销售场景

> 对比细节见会话记录（CordysCRM 作为"开箱即用"备选保留，若后续要完整审批流可重评）。

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────┐
│ 采集机（内网 1 台）                                   │
│  WeFlow 微信引擎（现有，独立进程/独立仓库）             │
│   ├─ WCDB 读取（销售微信号）                          │
│   ├─ AI 见解 / 12 字段自动填充                        │
│   ├─ 报价信号检测（R7）/ 行动引擎                     │
│   └─ crmSyncAdapter（新增：GraphQL 写 Twenty）        │
└────────────────────────┬────────────────────────────┘
                         │ REST+GraphQL over HTTPS（API Key 鉴权）
                         ▼
┌─────────────────────────────────────────────────────┐
│ 团队服务器（内网 1 台）                                │
│  Twenty server（Docker）                             │
│   ├─ PostgreSQL（多租户 schema，1 workspace=团队）     │
│   ├─ Redis（缓存/会话）                               │
│   ├─ GraphQL API（Core/Metadata/AdminPanel 三层）     │
│   ├─ MCP Server（AI 可操作 CRM）                      │
│   └─ Webhook（数据变化 → 通知 WeFlow）                │
│  Twenty front（React，多用户浏览器访问）               │
└─────────────────────────────────────────────────────┘
```

- **边界铁律**：微信采集/AI 判断在 WeFlow（独立代码、独立 License）；团队协作/数据底座在 Twenty。**不 fork Twenty，不改其源码**，只走 API 互操作 → AGPL 不传染 WeFlow 代码。

---

## 4. Twenty 数据模型调研结论（源码实读）

### 4.1 标准对象（`twenty-server/src/modules/*/standard-objects/`）

| 对象 | 关键字段 | 用途 |
|---|---|---|
| **person** | name(fullName), emails, phones, jobTitle, company, timelineActivities, messageParticipants | 联系人（客户个体） |
| **company** | name, domainName, accountOwner, people, opportunities, timelineActivities | 公司（客户组织） |
| **opportunity** | name, amount, stage, closeDate, probability, company, owner | 商机（报价线索） |
| **task / note** | — | 行动项 / 笔记 |
| **timeline-activity** | 统一时间线 | 客户 360 时间线 |
| **attachment** | — | 附件/文件 |
| **workspace-member** | — | 团队成员 |
| message-participant | — | 消息参与方（邮件，可借鉴微信消息建模） |

### 4.2 自定义对象机制（`engine/metadata-modules/`）

- 通过 **Metadata GraphQL API** 动态创建对象/字段（object-metadata, field-metadata, relation-metadata）
- 支持字段类型：TEXT / NUMBER / CURRENCY / DATE_TIME / PHONES / EMAILS / RELATION / SELECT 等
- 自定义对象与标准对象同等能力（列表/视图/搜索/timeline/webhook）
- → **微信特有数据全部走自定义对象**，不污染标准模型

### 4.3 GraphQL API（`engine/api/graphql/`）

- 三层：
  - **Core GraphQL**（`/graphql`，workspace 数据 CRUD：`findMany/findOne/createOne/updateOne/deleteOne`）
  - **Metadata GraphQL**（对象/字段/视图/角色的元数据管理）
  - **AdminPanel GraphQL**（实例级管理）
- **鉴权**：用户 JWT（登录）+ **API Key token**（服务端到服务端，`core-modules/auth/api-key-token*`）+ MCP auth guard
- **MCP Server**（`engine/api/mcp/`）：AI 通过 MCP 协议直接操作 CRM

### 4.4 多租户与权限

- PostgreSQL schema 级多租户（core/metadata/workspace 分层 schema）
- `metadata-modules/role` + role-validation：角色/权限
- → 团队版：1 个 workspace + 若干 member + 角色（admin / sales）

---

## 5. 数据模型映射（WeFlow → Twenty）★核心

| WeFlow（现有） | Twenty 目标 | 说明 |
|---|---|---|
| account（客户，含微信 sessionId/wxid/12 字段） | **person + company + 自定义字段** | person=联系人、company=公司；微信标识（wxid/sessionId）→ person 自定义字段；12 字段（职位/电话/行业/省市/需求/预算/意向型号/采购时间/竞品/价格敏感度）→ person/company 字段或自定义字段 |
| insight / 见解记录 | **note + timeline-activity** | AI 见解挂到 person/company 时间线 |
| 自动填充字段溯源（enrich_meta） | person 自定义字段 + note | 置信度/来源/evidence 存 note 或自定义 JSON 字段 |
| quotation（报价单） | **opportunity + 自定义对象 quotation** | opportunity 管商机阶段；quotation 存报价明细（金额/型号/variants） |
| contract / invoice / payment / allocation | **自定义对象**（contract/invoice/payment） | 标准对象没有合同/发票/回款，全部自定义 |
| product（21 个产品 + specs/variants） | **自定义对象 product** | specs JSON、价格口径、variants 原样迁移 |
| action / 今日行动 | **task**（带 stage/优先级字段） | 团队可见待办 |
| quote_signal（报价信号） | **自定义对象 quoteSignal** | 信号 → 自动建 opportunity |
| 确认中心队列 | 自定义对象 pendingConfirm + 状态机 | 自动 vs 人工标记（沿用 auto_* 逻辑） |
| 销售数据备份 | Twenty DB 自身 + 备份策略 | 服务器 Postgres 定期备份 |

### 5.1 同步方向

- **MVP：单向**（WeFlow → Twenty）。微信 AI 产出灌入底座，团队在底座协作
- **迭代：双向**。底座中团队人工修改（如 stage/负责人）回传 WeFlow 校准行动引擎（通过 Twenty Webhook + 增量拉取）

---

## 6. 数据同步管道设计（crmSyncAdapter）

新增独立模块 `crmSyncAdapter`（WeFlow 仓库内，独立进程或 worker）：

```
WeFlow 微信引擎 ──► 变更队列（本地 sqlite，断点续传）
                        │ 批处理（≤100 条/批，API Key 鉴权）
                        ▼
                   Twenty GraphQL（Core API）
                        ▲
                   Webhook 回调（出向变更 → 回灌 WeFlow 增量）
```

- **幂等**：同步记录以 `wxid+eventType+seq` 为主键，重复投递安全
- **背压/限流**：Twenty API 限流保护，失败重试 + 死信队列
- **映射器**：`mapAccountToPerson` / `mapQuotationToOpportunity` / `mapProduct` 等纯函数（可单测）
- 复用现有 `crmEnrichService` 产出的结构化数据，不做二次 AI

---

## 7. 权限与多租户

| 角色 | 能力 |
|---|---|
| admin | 全部对象 CRUD + 成员管理 + 部署配置 + Webhook 配置 |
| sales | 本人 person/opportunity/task + 共享公司/产品只读 + 报价创建 |
| viewer（可选） | 只读报表 |

- 单 workspace（团队），成员通过 Twenty 前端登录（邮箱密码或 SSO）
- 微信采集机用一个服务账号（API Key，scope 限 write:person/opportunity/task）

---

## 8. 功能范围与分期

### P0 — 团队底座跑通（核心）
- [ ] Twenty 私有化部署（Docker：Postgres+Redis+server+front）
- [ ] 产品库同步：21 个产品 → 自定义对象 product（含 specs/variants/价格口径）
- [ ] 客户映射：account → person+company（含微信标识 + 12 字段）
- [ ] 单向同步管道（WeFlow → Twenty）+ 幂等 + 失败重试
- [ ] 多用户登录 + admin/sales 角色
- [ ] 团队看客户 360（Twenty front 标准视图 + 自定义字段展示）

### P1 — 销售流程闭环
- [ ] AI 见解 → note/timeline 同步
- [ ] 报价信号 → opportunity 自动建档 + 报价对象
- [ ] 报价 → 合同 → 发票 → 回款 自定义对象 + 状态流转（借鉴 CordysCRM 流程设计）
- [ ] 行动引擎 → task 同步，团队分配负责人
- [ ] 双向同步（Webhook 回传 + 人工修改回灌）

### P2 — 提效
- [ ] AI 通过 Twenty MCP/Claude Skills 直接操作 CRM（语音/对话式查客户、改 stage）
- [ ] 报表/BI（自建或引入 DataEase 对接）
- [ ] 移动端（Twenty 有 Web，可渐进）
- [ ] 微信多成员采集（多采集机 or 企微方案）

---

## 9. 部署方案（私有化）

- 内网服务器（2C4G 起步）：
  - `docker compose up -d`（Twenty 官方 docker 镜像）
  - PostgreSQL 15 / Redis 7 独立容器或宿主机
- 采集机：现有 WeFlow Electron 机器（同一局域网），运行 `crmSyncAdapter`
- 网络：内网 HTTPS（自签证书），API Key 存采集机本地
- 备份：Postgres 每日 `pg_dump` + Twenty 元数据导出；沿用现有"销售数据备份"思路
- **升级策略**：Twenty 镜像升级前，`database:migrate` 走官方命令；WeFlow 侧 crmSyncAdapter 兼容 API 版本

---

## 10. 风险与注意事项

| 风险 | 等级 | 应对 |
|---|---|---|
| **AGPL-3.0 传染** | 高 | 铁律：**不 fork/不改 Twenty 源码**，只走 API；crmSyncAdapter 独立仓库/独立 License。内部使用风险可控，一旦对外提供需重评 |
| Twenty Enterprise 闭源部分 | 中 | 深度定制前确认目标功能在 AGPL 覆盖范围；优先用标准对象+自定义对象组合 |
| 微信数据源形态 | 高 | 团队多成员微信数据来源必须先定（单采集机 vs 多机/企微），否则管道架构悬空 |
| Twenty 迭代快、API 变动 | 中 | 锁 Twenty 版本，升级走迁移流程；crmSyncAdapter 用稳定 GraphQL 端点 |
| 本地 clone 版本旧（0.2.1） | 中 | 实际部署用最新 release，本 PRD 调研结论针对当前源码，落地前重新核对 schema |
| 数据量/性能 | 低 | 团队级 CRM 数据量对 Postgres 无压力；微信见解灌入注意去重 |

---

## 11. 里程碑建议

1. **M1（1~2 周）**：Twenty 部署跑通 + 产品库/客户单向同步（P0 子集）
2. **M2（2~3 周）**：见解/报价信号/行动项同步 + 团队角色权限（P0 剩余 + P1 子集）
3. **M3（3~4 周）**：报价→合同→发票→回款对象 + 双向同步（P1）
4. **远期**：MCP/AI 助手 + BI + 移动端（P2）

> 若微信多成员采集需求先于团队底座，**先补"多采集机汇总"再上 Twenty**，避免管道返工。

---

## 附录 A：Twenty GraphQL API 调研要点

- 端点：Core `/graphql`、Metadata（对象/字段定义）、AdminPanel
- 标准 CRUD：`findMany` / `findOne` / `createOne` / `updateOne` / `deleteOne`
- 鉴权：JWT（用户）+ API Key（服务端）；Metadata API 用 token 区分权限
- MCP：`engine/api/mcp/`，AI 可经 MCP 协议操作对象
- Webhook：metadata-modules/webhook 支持对象事件出向回调
- 多租户：Postgres schema 隔离，1 workspace = 团队

## 附录 B：待验证项（落地前）

- [ ] 最新 Twenty release 的对象 schema 是否与本调研一致
- [ ] API Key 的创建/scope 限制实际用法
- [ ] Webhook 回调的签名与重试机制
- [ ] 自定义对象是否支持 `specs` JSON 字段类型或需拆字段
- [ ] Claude Skills 与 MCP 的操作权限边界
