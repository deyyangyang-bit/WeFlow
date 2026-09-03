# WeFlow × Hermes 总体规划（修订版）

## 〇、定位与分层（新）

### 五层架构
- ⑤ AI / Hermes：理解、决策、生成、调用工具
- ④ Governance：RBAC / ACL / Audit / Approval
- ③ Business Fact：Customer / Lead / Owner / Stage / Deal / Quote / After-sale
- ② Knowledge：WeKnora / Published / Staging
- ① Data Source：WeFlow / 微信聊天 / 本地数据库

### 各层角色定位
- 微信聊天：数据源，不是企业共享数据库
- WeFlow：个人工作台，不是多人数据库
- PostgreSQL：企业事实层
- WeKnora：企业知识服务，不承担 CRM 主数据职责
- Hermes：行动 Agent，不直接操作数据库
- Governance：所有 Agent 与人工操作的闸门

### 多人协作核心原则
- 口诀：个人数据本地化、企业事实集中化、聊天原文不共享、业务事实可同步、企业归属集中管理
- WeFlow = 个人工作副本（原始聊天 + 个人工作状态）
- NAS PostgreSQL = 企业共享事实源（客户 / 归属 / 成交 / 报价）
- WeKnora = 企业知识服务，不承担 CRM 主数据
- Hermes 写操作必须走 Tool Gateway + RBAC + ACL + Risk Policy
- 高风险操作必须审批
- 客户 owner 只有企业层可最终确认
- AI 只能提议，不能成为最终事实来源
- 跨设备变化走事件同步，不同步数据库文件
- 企业事实必备 source / updated_by / updated_at / version / audit
- Backup 是 Sync 的技术基础，但 Backup ≠ Sync

## 一、现有能力（28 项已上线，不变）

### 数据底座
- 微信聊天解密存档（WCDB 只读）
- 防撤回 + 群聊分析
- 消息 / 联系人 / 朋友圈导出
- 本地 HTTP API（5031）+ SSE 推送
- AI 调用收口（aiApiClient · DeepSeek）
- 语音转写 + 中文分词
- 年度报告

### 获客与线索
- 线索池（群扫描入池 / 归属移交）
- 首触 SLA 24h（超期出卡）

### 跟进与转化（成交前）
- 客户 360 + 阶段分类（新客→了解→比价→决策→成交/流失）
- 意向评分 + 风险预警
- 今日行动引擎 R0–R8（规则出卡 + AI 分析预热）
- AI 回复建议 / 话术提炼
- 承诺提取待办（到期 AI 核验）
- 客户洞察画像（12 字段 + 证据溯源）

### 成交与交付
- 跟单中心 · 款项认领
- 跟单中心 · 物流认领
- R8 签收超期提醒（24h）

### 售后与复购
- 现状空白 → Phase 1 补齐

### 知识与 AI
- 知识库关键词版（产品参数 / 话术 / FAQ）
- AI 话术提炼入库

### 管理与团队
- 销售漏斗
- 周复盘报表
- 逾期任务统计
- 销售团队名单

### 架构
- 单机双库（销售库 + CRM 库，按微信号分库）
- Electron 主进程即后端（重活走 worker）
- 文档生成（报价 / 报表）

## 二、Phase 0 · 数据基线（新，插队 1~2 周）

- 目的：历史遗留问题收口，这是整个项目的地基
- Customer 唯一身份：手机号 → customer_identity
- Stage 唯一事实源：account.sales_stage；其余阶段表达降级为 proposal / history / signal
- Owner 唯一事实源：单机期本地直改，预留 Phase 3 切换为「企业层确认」
- Evidence 统一格式：所有证据链同一结构（message_key / 摘要 / 时间）
- AI / Human 分离：AI 可写字段加 source / status（仅 stage、customer_type、intent_score；owner 永远不允许 AI 写）
- Timeline 统一：客户时间线单一来源，事件按 source 标注

## 三、Phase 1 · 单机可靠性（原「迭代一 · 守护与补断崖」，约 2 周）

### 原则
- 纯规则与字段，零 AI 风险

### 原迭代一内容（保留）
- NAS 自动备份（最高优先，堵裸奔）
- customer_profile 加 owner + 离职客户移交
- 客户类型字段（dealer 经销商 / end_user 终端）
- 售后生命周期（成交→已交付→待回访→复购/老客）
- R9 经销商拿货提醒（签收后第 10 天预警，15 天 deadline）
- R10 定期回访（成交后 15 / 30 / 90 天）
- R11 阶段停滞卡（比价>14 天 / 决策>21 天）
- 成交登记结构化（成交额 / 型号 / 数量 / 交期）
- 报价版本管理（版本 / 生效期 / 证据链）

### local_outbox 事件队列（新）
- 做法：备份的同时写 outbox（backup + outbox）
- 字段：event_id / entity_type / entity_id / operation / payload / created_at / sync_status / retry_count
- 定位：本阶段只记录不发送；Phase 3 直接演进为同步队列
- 原因：Backup ≠ Sync，现在补事件结构，避免 Phase 3 返工

### 客户资源分配（原「新需求 · 功能一」，纯本地）
- 录入：分配人员角色（主管 / 销售助理），批量导入 Excel / 粘贴清单
- 查重：对已有客户手机号自动去重
- 分配引擎三模式：比例权重（可调，默认）/ 轮询 / 按负载均衡
- 生命周期：待分配池 → 已分配 → 认领（接首触 SLA 24h）→ 超时回收再分配
- 审计留痕：录入人 / 分配对象 / 认领时间 / 回收记录
- 数据模型升级（新）：lead → dedup → customer_identity → allocation → assignment → claim → owner
  - 建表：lead / customer / customer_identity / assignment / ownership_history
  - 原因：lead ≠ customer，同客户多来源线索要归并到一个身份
  - 原 lead 表 owner_id / pool_id / assigned_at 预留字段照常启用
- 归属移交（改）：单机期本地直改；Phase 3 起切换为「申请移交 → 主管批准 → 企业层落锤」

## 四、Phase 2 · Hermes 与知识治理（原「迭代二」，约 3~4 周）

### Hermes 三段式架构
- 触发层（何时做）
  - 事件触发：新消息增量（订阅现有机制）
  - 定时触发：挂入行动引擎每日 08:00 扫描
  - 人工触发：页面提问 / 一键处理
- 工具层（能做什么）
  - 读：查客户 / 查聊天（走 chatService）/ 查知识 / 查阶段历史
  - 写：建待办 / 打标签 / 提知识提案 / 生成草稿
  - 写操作约束（新）：不直接写库，一律走 Tool Gateway → 业务服务层（Phase 3 复用同一闸门）
- 判断层（理解与表达）：LLM 走 aiApiClient，只做理解 + 生成
- 人（落锤）：高风险操作确认队列

### 权限二维模型（改：三级风险 × RBAC 合流）
- 链路：User → RBAC 角色 → 数据范围 ACL → Tool Permission → Risk Level → 执行 / 审批
- 🟢 只读：自由调用
- 🟡 低风险写：可自动执行 + 全量审计日志
- 🔴 高风险写（改阶段 / 移交 / 发布知识 / 对外发送）：必须人工确认
- 分工：RBAC 判断「有没有权限」，风险分级判断「要多重确认」，ACL 判断「能不能看这条数据」

### 知识治理升级（保留）
- 治理字段：status / authority / version（版本链）/ TTL（保质期）
- published（已发布）过滤 + 审核 Tab
- 反哺回路：聊天发现 → proposal → 人审 → 发布
- AI 无 publish 权限（账号级硬约束）
- 效果回流：使用埋点 × 阶段结果归因（哪条话术在赚钱）
- TTL 主动巡检（到期问负责人「还成立吗」）

### 认领 24h 后 AI 首次分类（原「新需求 · 功能二」，改）
- 触发：认领满 24h 挂入每日扫描 + 手动立即初判按钮
- AI 输出：阶段初判 / 客户类型（经销商/终端）/ 意向评分 / 画像 12 字段（带证据链）
- 字段溯源结构（新）：field_value / source / confidence / evidence / status（proposed → confirmed）/ updated_by / updated_at
  - AI 产出 = proposed；销售确认或修正 = confirmed，全程留痕
  - 仅 stage / customer_type / intent_score 三个关键字段启用
- 人可修正：销售可改，改动留痕（AI 提议、人落锤）
- 上行 NAS 存档：结构化档案 JSON，聊天原文不上行（Phase 3 起转入 Postgres 表）
- 权限：条目级 ACL——归属销售本人 + 主管/管理员可见

## 五、Phase 3 · 企业事实层 + 多人（原「迭代四」+「多用户」章节合并）

### NAS 四层架构（新，展开见「七」）
- 企业事实库 PostgreSQL：客户档案库落地，集中式 CRM 的胚胎
- 企业知识库 WeKnora：只管知识检索，不做 CRM 主数据
- staging：AI proposal / 待审核知识
- backup：加密备份

### 双向同步（改：原「单向上行」）
- 上行（销售 → NAS）：成交登记 / 报价版本 / AI 客户档案 / 知识提案 / 审计事件
- 下行（NAS → 销售）：客户归属 / 移交结果 / 锁定状态 / 企业标签 / 企业知识 / 主管修正 / 权限变化
- 禁止：跨销售互写
- 通道：local_outbox → Sync Service → Change Feed → 各 WeFlow
- 仍不上行：原始聊天记录（默认）/ 未审核草稿与 proposal

### WeKnora 部署（原「迭代四」保留）
- 本机 → NAS，Docker 5 核心容器
- staging / published 双库物理隔离
- 模型配置：DeepSeek + bge-m3 向量 + bge-reranker 重排
- Hermes 经 MCP 接入企业知识库
- 100 条评测集验收（答案正确率 ≥85% / 过期命中 = 0 / 越权 = 0）
- 接口策略（改）：内置工具层与未来 API/MCP 同源，统一走 Tool Gateway

### 多人三大问题
- 撞单仲裁（改：提前到分配 / 认领阶段）
  - 手机号 → customer_identity 唯一 → owner 仲裁
  - 成交登记上行仍按手机号去重，同人跟进触发主管仲裁
- 离职交接升级
  - 流程：申请移交 → 主管批准 → NAS 落锤 owner → 同步 → A 失权 / B 获得
  - 移交记录上行留痕，新设备恢复归属，证据链不断
- 并发修改（新）
  - version / updated_by / updated_at，乐观锁防止互相覆盖

### Hermes 企业化（新）
- 原则：Hermes 不直接 UPDATE PostgreSQL
- 路径：Tool Gateway → Permission → Policy → Business Service → PostgreSQL
- 示例：request_transfer → 权限检查 → Risk=HIGH → 审批队列 → 主管确认 → CustomerService.transfer() → audit → 同步两端

### RBAC 权限矩阵
- 销售：本人客户全部 / 读 published 知识 / 不可见成本价 / 可提 proposal
- 销售主管：团队只读（阶段与成交，不看聊天原文）/ 审核发布 / 移交审批 / 可见成本
- 管理员：归属管理 / 账号角色 / 密钥 / 全部知识库
- 第四角色（新，待定义）：建议为系统 / AI 服务账号（只经 Gateway 调用，无人工登录）
- 落地：WeKnora workspace 隔离 + 四角色；敏感知识单独建库 + 网关层条目级 ACL

## 六、Phase 4 · 经营深化（原「迭代三」全部后移，约 3 周）

- 目标管理（目标 vs 达成）
- 售后工单（维修 / 保养 / 配件）+ 复购信号
- 沉默客户前兆预警（沉默前三轮对话模式）
- 竞对情报自动建档
- 知识缺口清单（答不上来的反哺产品部门）
- 客户公海（超期未跟进自动标红回收）
- 知识运营看板（待审积压 / 知识新鲜度）
- 多渠道线索录入（名片 / 展会 / 介绍）（改：并入 lead → customer_identity 模型）

## 七、NAS 四层架构（新）

- ① 企业事实库
  - 客户档案 / 成交记录 / 报价版本 / 归属 / 审计
  - 承载：PostgreSQL
- ② 企业知识库
  - 产品 / FAQ / 话术 / SOP / 竞品
  - 承载：WeKnora（知识检索）
- ③ staging
  - AI proposal / 待审核知识
- ④ backup
  - 加密备份
- 边界：WeKnora 不变成 CRM 数据库，业务事实只在 PostgreSQL

## 八、核心原则（保留 + 落字段）

- 规则负责「什么时候该行动」
- Hermes 负责「行动时带什么知识」
- 效果回流负责「下次行动更聪明」
- 知识是服务，不是文件
- 先审后发（Review-before-Publish）
- AI 可提议一切，落锤权在人（改：落到字段 status = proposed → confirmed）
- 底座可替换，治理逻辑是自己的资产
- 护城河 = 微信聊天数据 × 业务结果的配对

## 九、修订标记说明（微调后可删除此分支）

- （新）= 相对原版新增的分支
- （改）= 相对原版修改过的内容
- 无标记 = 原样保留
- 主要变化：原迭代三后移为 Phase 4；原迭代四与「多用户」合并为 Phase 3；原「新需求」功能一并入 Phase 1、功能二并入 Phase 2；单向上行升级为双向同步