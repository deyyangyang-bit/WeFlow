# WeFlow Hermes · Phase 0 启动细化（W1-W2，9/7-9/18）

> 状态：2026-09-02 定稿。本文档 = Phase 0 执行层唯一依据，与下列文档配套：
> - `docs/规划/weflow-hermes-PRD-v3.4.md`（需求权威）
> - `WeFlow/docs/DATA-CONSTITUTION.md`（数据权威，D1 已定稿）
> - `docs/规划/weflow-hermes-开发流程计划.md` §6（Phase 0 总排期）
> - `WeFlow/docs/UI设计稿-Phase1-资源分配.html`（前端验收标准，9/2 拍板）
>
> 冲突裁决顺序：PRD v3.4 ≥ DATA-CONSTITUTION ≥ 本文档 ≥ 其他历史文档。

---

## 一、D1 · 数据宪法（已定稿，不再返工）

产出 = `WeFlow/docs/DATA-CONSTITUTION.md`。已定案要点（详见原文）：

- 术语表三组撞名裁决：assignment(资源分配) ≠ allocation(到款归属)；customer(人/公司锚点) ≠ account(单微信号客户档案)；quote(宪法对象) = quotation(物理表)。
- 11+1 对象契约：每对象五要素（定义/字段级规格/合法写入者/AI 三档/实现映射），通用五列 source/updated_by/updated_at/version/删除标记。
- **决策 B（9/2 拍板）**：群资源扫描整功能下线，录入只走分配员 Excel/粘贴导入；lead.tag 归属语义退役（仅保留需求标签语义）；`leadReassignOwner` 整链路删除；存量约 4,680 条群扫线索回资源池重新分配（先试 200 条），历史归属留 note 备查。
- lead 分配状态放 assignment，lead 状态机不动；四个死列（owner_id/pool_id/assigned_at/private_deadline）永久禁用。
- customer×account 挂接：account 加可空 customer_id，不动本体；customer_profile.customer_id 既有列对齐新 customer 表；跨库只做逻辑外键。

## 二、D2-D5 任务界定

### D2 · 两项 Policy + 七问补全 —— ✅ 已定稿（2026-09-02，宪法 §2.3/§2.4/§2.5；Stage 矩阵 🔶 格待 D8 主管签字）

宪法 §2 目前只有 SSOT / Soft Delete / 七问占位——PRD 要求的 Identity Resolution 和 Stage Transition 两项 Policy 还没写。这是 D2 的真正工作量：

**① Identity Resolution Policy（写进宪法 §2.4）**
- 身份优先级：手机号 > wxid > 昵称（仅显示，永不作匹配依据）
- 归并规则：同手机号 → 同 customer；一人多 wxid → 多 identity 行挂同一 customer（R7）
- 后补关联：资源池线索（customer_id 为 NULL）在绑定/认领时后补关联
- 冲突处理：同手机号挂在不同 customer 下 → 只能走合并提案 → 人工审批执行
- AI 边界：AI 只可提合并提案（B 档），永不执行合并

**② Stage Transition Policy（写进宪法 §2.5，继承 P0-2A 不翻案）**
- canonical 6 值状态机 + activityState 拆出 + unknown 异常位
- from × to 转移矩阵：每格标注 直接合法 / 需人工确认 / 禁止，落实 PRD 四规则（允许跳级、回退受限、成交禁直连、流失复活需确认）
- 写入资格：P0-2A 四写者（classifier/intent/manual/deal）原样收编

**③ Feature Gate 七问（§2.3 占位补全）**：直接收录开发流程计划纪律第 11 条的七问原文（属哪个 Phase？/ 为什么现在必须做？/ 会不会引入未来架构？/ 会不会改变数据宪法？/ 会不会新增事实源？/ 会不会新增权限边界？/ 挤掉什么？）+ 裁决流程（答不过 → Backlog），不新写。

### D3 · 执行细化（清单已定 + 三个裁决）

宪法 §4.1 清单完整（6 新表 + 2 组 ALTER + ENTITIES 注册）。三个裁决：

1. **leadReassignOwner：退役删除（9/2 拍板，推翻早期"推荐改道"口径）**——整链路移除，范围见宪法 §4.2 与坑清单 #6。1.9 离职移交需要的批量调派能力届时在分配服务内重做（直接写 assignment + ownership_history 同事务），不复活旧工具、不复活 tag 归属语义。
2. **outbox_event pending 崩溃语义（已定）**：sql.js 500ms 防抖落盘，崩溃丢失的 pending 行 = 事件未发生；1.10 只记录不发送阶段无业务后果；Phase 3a 上行阶段升级为同步落盘；idempotency_key 保证业务侧可重放。
3. **CHECK 硬门禁范围（已定）**：新表有穷枚举一律加 CHECK（assignment.status / customer_identity.identity_type / outbox_event.status），沿用 customer_event 先例；存量表（如 lead.status）不动。

唯一剩余口子：quotation.contract_id 双写起止时间，D3 执行时定。

### D4 · 迁移脚本骨架（scripts/migration/，只写不跑）—— ✅ 已完成（2026-09-02，GLM 实现 + Kimi 验收：dryRun 副本试跑 总计 9,565 项 / 预演 9,368 / 失败 19 条均带原因 / 冲突 0；双 tsc 零新增）

四个映射模块骨架 + 统一迁移报告结构（总数/成功/失败/冲突清单）：

1. **决策 B 存量处置**：4,680 条 tag 归属清理（note 留痕）+ scan_state `leadScan:*` 游标清理
2. **account → customer** 回填 + customer_id 挂接（phone/wxid 查重）
3. **lead → customer_identity** 归并
4. **历史成交 → opportunity 补列 + quote 首版本**

⚠️ 铁律写入骨架注释：迁移走应用自身链路，禁止直接改库文件（sql.js 内存库覆盖前科）。

### D5 · 接口契约（docs/API-CONTRACT.md，**9/2 拍板收缩版**）—— ✅ 已完成（2026-09-02，GLM 实现 + Kimi 验收：现有 113 通道从代码梳理 + 9 个 Phase 0/1 新端点规范级 + 中央主机/MCP 占位规范，未超纲）

| 层 | 深度 | 理由 |
|---|---|---|
| IPC 层 | 端点级完整 | Phase 0/1 立即要用（分配/绑定/审计查询） |
| 本机 HTTP 只读 | 端点级（延续 HTTP-API.md） | 已有基础 |
| 中央主机内网 API | 只定规范（认证/版本/幂等/错误码）+ Phase 3a 端点占位清单 | Phase 3 才开工，现在写细节 = 猜需求 |
| MCP 工具面 | 只定规范 + Phase 2 工具占位 | 同上 |

## 三、D6 · AGENTS.md 权威修正与开闸（9/7 第一个任务，半天）

这是当务之急——不修它，任何 agent 9/7 开工读到的第一份权威就是错的：

- **必读顺序修正**：需求权威改为 PRD v3.4（`docs/规划/`）+ DATA-CONSTITUTION.md（数据权威）；PRD-v2 标注「已被 PRD v3.4 取代」归档，不删。
- **观察期正式关闭**：「真实运行观察期」条款整体收档，写明结论已进 PRD v3.4 实测基线（行动卡执行率 0.6% → 分配制路线依据）。
- **铁律区追加**：SSOT / AI 无 publish / Feature Gate 七问 / AI 三档 / 宪法映射表指针（对象名↔物理表名对照，防 agent 自建第二套表）。
- **下一步区重写**：Phase 0 D2-D8 任务列表。
- ⚠️ **解除冻结的措辞要精确**：解除的是「P0 工程冻结」，漏斗/行动卡口径仍以 PRD v3.4 为准——防止 agent 把开闸读成随便改。
- 文档已分区（9/2）：规划类权威在 `docs/规划/`，被取代版本在 `docs/归档/`；D6 写必读顺序时一律用新路径。
- ⚠️ AGENTS.md 是 gitignore 的**本地文件**（不进 git）：改完后分配端那台机器开工前**手动同步一次**，防止两台机器规矩不一致。

## 四、D7 · 商机评测集落库（依据宪法 §1.10 evidence 规范）—— ✅ 技术部分已完成（2026-09-02）

- 新表 `opportunity_eval_case`（**已入宪法 §3 特许扩展**，非业务事实表）：session_id / label（有商机/无商机/不确定）/ evidence_message_keys（JSON 数组，纯 key 引用）/ evidence_text（原话快照 ≤200 字）/ annotated_by / source（回溯标注=现有 5 条商机+历史对话）/ status + 通用五列。
- **放 salesDb**（与 intent_tag_log 同库，message_key 证据引用同库闭环，不走跨库逻辑外键）；salesDb **无 ENTITIES 白名单机制**（该机制仅 crmDbService 有），无需注册，直接建表。
- AI 预标注辅助：GLM 预填 label 建议 + 证据片段候选 + 导出会话上下文（前后文 N 条），主管只做复核确认——**预标注与人工确认分开存，防锚定偏差**。
- 主管时间压到「确认级」；纯手标 100 条不现实。
- 时机：Phase 0 只落表结构 + 标注指引（1 页）+ 导出脚本；标注跨 W1-W2 持续，**W8 前 ≥100 条**（Phase 2 前置门槛，2.10）。

## 五、D8 · 评审包（30 分钟可过的形态，对冲「主管时间后定」）

- 1 页决策清单（需主管签字的业务裁决 5-7 条）：Identity 归并规则 / Stage 矩阵中「需确认」格 / owner_sales 三处口径 / 决策 B 存量处置 / 术语表业务名词。
- 术语表 + 对象契约一页表随包附上。
- **边写边对**：W1 中就把 Identity/Ownership 两章发主管预览，不等全宪法定稿——D8 不再是「约不到时间」的单点。

## 六、排期（W1-W2，9/7-9/18）

| 日 | 任务 | 模型 |
|---|---|---|
| 9/7 上午 | D6 AGENTS.md 开闸 + 权威修正 | GLM |
| 9/7 下午-9/9 | D2 两项 Policy + 七问补全（宪法 §2） | Kimi 设计 → GLM 落稿 |
| 9/9-9/11 | D3：6 表 DDL + 2 组 ALTER + ENTITIES 注册 + 决策 B 下线执行 + 回归 | GLM |
| 9/11-9/12 | D4 迁移骨架 + D5 契约文档（**收缩版口径，见本文 §二-D5**） | GLM |
| 9/12-9/15 | D7 评测集落库 + 指引 + 导出脚本，标注启动 | GLM + 主管 |
| 9/15-9/18 | D8 评审包 + 评审会 + 缓冲/修宪法 | 人 + Kimi |

W1 中：Identity/Ownership 章节发主管预览。周五节奏照流程计划 §9 不变。

**Phase 0 出口**：D8 评审通过 = 宪法冻结，W3 开工 Phase 1。不通过改到过，不带病进入。

## 七、坑清单（执行 agent 开工前必读）

1. **文档权威冲突**（D6 修复前 agent 会被 PRD-v2 带偏）——D6 第一优先。
2. **assignment ≠ allocation** 术语撞车——术语表已裁决，代码命名注意。
3. **sql.js**：迁移/回填必须走应用链路，禁直改库文件；500ms 防抖落盘。
4. **新表必注册 ENTITIES 白名单**（crm_risk 漏注册静默失败前科）。
5. **WCDB 秒 ≠ JS 毫秒**。
6. **群扫下线删除范围要查干净**：service 两个文件（crmLeadScanService/crmLeadScanCore）、UI 按钮弹窗、设置项（crmLeadScanGroup/crmLeadScanWhitelist）、IPC、preload/d.ts、`leadReassignOwner` 整链路（含「⚙ 管理归属」弹窗）、scan_state 游标 `leadScan:*`——防半删状态。
7. **幂等 ALTER 双路径**（crmDbService.ts:337 模式），列一经发布不得改名。
8. **PIPL**：evidence_text 只存原话快照 ≤200 字，聊天原文不出本机。
9. **构建劫持**：electron/** 下 tsc 编译产物（*.js/*.d.ts，gitignore）会劫持 vite 构建——dev/build 读旧代码，典型现象「No handler registered for 'crm:xxx'」。改 electron 代码后先删产物再构建；**删除前必须 `git ls-files electron | grep -E '\.(js|d\.ts)$'` 对照白名单**（上次误删 5 个 git 跟踪文件：sql-js.d.ts 等，已恢复）。
10. **tsc 双 gate**：`npx tsc --noEmit` 只查 root（src/shared）；electron/ 错误必须 `npx tsc -p tsconfig.node.json --noEmit` 单独 grep 新错（既有基线容忍，新增即算你的）——`this.isSessionIdLike` 整链 TypeError 前科。
