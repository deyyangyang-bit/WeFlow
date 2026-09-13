# HANDOVER-20260818 · CRM 零操作改造 + 报价跟进 + 产品库交接

> 状态：已归档
> 归档日期：2026-09-13
> 替代文档：`docs/HANDOVER.md`（§2.15-§2.20 已并入全局交接）；同期改造清单见 `docs/实施记录/PLAN-CRM零操作改造.md`
> 本文仅供历史追溯，不得作为当前开发或设计依据。

> 交接范围：2026-08-17 ~ 08-18 两天的全部改造。接手前先读 `docs/HANDOVER.md`（全局）+ `DEVELOPMENT.md`（开发规范），再读本文件。
> 基线：commit `8107625` 之前的所有提交已推送 `backup` 远端（永不推 origin）。

## 1. 本次做了什么（按提交顺序）

| Commit | 内容 |
|---|---|
| `ae4d4ea` | 今日行动分页（10 条/页） |
| `5568b47` | tsx 进 devDependencies（测试脚本干净 clone 可跑） |
| `d44f061` | DEVELOPMENT.md 开发规范入库 |
| `d8bb5d0` | **P0 信息自动填充引擎**（crmEnrichService + 来源溯源 + 双触发点 + 回填） |
| `cfe66a7` | **P1 确认中心「信息待确认」队列 + 灵感信箱联动 + 设置页** |
| `a104dbf` | **P2 客户 360 单屏视图 + 新建合同零操作化 + 深链协议** |
| `141736d` | **P3 CRM 可视化**（统计卡 + ECharts 三图 + 真漏斗下钻） |
| `b6b21fb` | 修复批量 AI 补全全部失败（AI 配置注入） |
| `1fd12d7` | **R7 报价跟进**（打字+语音信号检测，事实驱动）+ R1 阈值 3→2 天 |
| `abca441` | 行动卡深链 + 销售数据备份 + AI 准确率面板 |
| `8107625` | 文档同步 |

## 2. 核心机制说明

### 2.1 客户信息自动填充（crmEnrichService.ts + crmEnrichCore.ts）
- AI 从 聊天上下文 + 见解记录 + 关系画像 提取 **12 字段**（公司/职位/电话/行业/省市/需求/预算/意向型号/采购时间/竞品/价格敏感度）
- **置信分级**：≥`crmEnrichAutoApply`(0.85) 自动写入；[`crmEnrichThreshold`(0.7), 0.85) 进确认中心「信息待确认」；<0.7 丢弃
- **字段级溯源**：`account.enrich_meta` JSON = `{fields: {字段: {source: ai|manual, confidence, at, evidence}}, pending: {...}}`
- **手动锁定**：用户编辑过的字段 `source=manual + locked`，AI 永不覆盖（`crm:enrich:manualSet`）
- **触发点**：① 见解导入后（insightService）② 画像导入后（main.ts）③ 档案「AI 补全」按钮 ④ 「批量 AI 补全」存量回填（限额）
- **铁律**：引擎绝不创建客户（只充实已导入 account）；执行入口一律 enqueueSalesTask
- ⚠️ 教训：`setEnrichConfig` 注入的 shim 只代理 4 个 enrich 键，AI 调用必须走 `setEnrichAiConfig` 注入的完整 ConfigService（`b6b21fb` 修复）

### 2.2 R7 报价跟进（事实驱动，不靠 AI 猜阶段）
- `crmParseRules.parseQuoteSignal`：仅销售侧消息；**金额 + (报价意向词|设备词)** 双条件；排除客户询价/闲聊小额/型号内数字（CPD20 的 20）；支持万元/千分位；金额正则必须带 `/g`（matchAll 要求）
- 语音消息：走 `chatService.getCachedVoiceTranscript` 转写缓存，**未转写的语音识别不到**
- `quote_signal` 表（crmDb）：msg_key 幂等；客户任意回复 → `markQuoteReplied` 自动关闭
- **规则**：报价发出 24h~7d 内客户未回复 → 高优先级行动卡（含金额/型号/已过时长）；每日 08:00 全量扫描评估
- ⚠️ 新表必须加进 `ENTITIES` 白名单，否则 `update()` 被 isEntity 守卫静默跳过

### 2.3 深链协议（全应用通用）
- `/crm?tab=customer&id=<accountId>` 直达档案
- `/crm?tab=customer&sid=<sessionId>` 按微信会话定位（行动卡客户名用）
- `/crm?tab=customer&stage=<阶段标签>` 漏斗下钻筛选
- 调用方：灵感信箱徽章、确认中心、行动卡、漏斗图

### 2.4 客户 360 + 可视化
- 客户 tab 档案：12 字段卡（🤖AI/✍️手动角标 + 置信度 + 证据悬浮 + 点击编辑）+ 动态时间线（CRM 操作 + AI 见解混排，`crm:customer:profile` 返回 activities + insights 20 条）
- 新建合同零操作化：选客户自动带出名称 + 甲方开票信息，复用已有 account 不重复建
- `statsOverview()`：4 统计卡 + 到款趋势/阶段分布/合同管道三图（echarts-for-react）
- `aiAccuracyStats(days)`：AI 准确率面板（自动写入/采纳/放弃/采纳率/手动修正/修正率/报价信号 24h 回复率）——**跑一周后用它调阈值**

### 2.5 销售数据备份
- 备份页「销售数据」勾选（默认开）→ `backupService.collectSalesData` 打包 6 个文件进归档 `sales-data/`（备份前 crmDb.persistNow + salesDb.flushNow 强制落盘）
- 恢复：退出 app 后覆盖回 userData

## 3. 产品库导入（2026-08-18 已执行）

**脚本与源表已入库，导入已执行完成：**
- 脚本：`scripts/import-product-summary.py`（可重跑，整表替换）
- 源文件：`resources/product-data/产品汇总表_库叉自产+外调车型.xlsx`（4 sheet：汇总对比 21 车型 / 自产详细参数 52 项 / 性能特点 / 外调明细）
- **执行结果**：4 → 21 个产品（自产 6 / 外调 15），旧 4 条测试数据全部覆盖（T02C/X1c-Li/CBD 重复，X1-Li 并入 X1C-Li）；执行前 db 已备份至 `crm-backups/weflow-crm-before-product-import-*.db`
- ⚠️ **脚本默认 db 路径是大写 `Application Support/WeFlow/weflow-crm.db`，实际是小写 `weflow`**，重跑必须显式传 `--db "/Users/yang/Library/Application Support/weflow/weflow-crm.db"`
- **执行步骤**：① 停应用（数据库是 sql.js 内存模式，运行中写文件会被覆盖）② `python3 scripts/import-product-summary.py <xlsx> --db <db路径>` ③ 重启 `npm run dev`
- **用户确认的口径**：X1-Li = X1C-Li 同一产品；**库叉自产价格=含税运，外调车型=裸车价不含税运**（已写入每产品 specs.价格口径 + description）；定制款价格 5500-6000（源表 5500-600 是笔误，脚本内已修正）
- 映射：多规格价格（2T:620/3T:726…）→ `variants` JSON；「按车型报价(详询)」→ 价格留空；自产 6 车型的 52 项详细参数 → `specs` JSON（AI 报价选型直接引用）

### 3.1 产品库图片编辑 + 复制摘要（2026-08-18，CrmProductPage.tsx）

- **换图/删图**：操作列「换图」（ImagePlus）→ 选图 → `crm:file:saveImage` 存 `userData/crm-images/` → `crm:entity:update` 写 `image_path`；「删图」（Trash2，仅当有图时显示）→ `image_path` 置空。图片用 `Date.now()` 前缀命名不互覆；删图不删磁盘文件（无害残留）
- ⚠️ 踩坑：删图后**先 `fetchProducts` 再清 `imgCache`**，否则 useEffect 拿旧 `image_path` 重载，图片「删不掉」（UI 假象，数据库已删成功）
- **复制摘要**：specs 是嵌套 JSON（`参数`/`详细技术参数` 是对象），旧代码 `${v}` 输出 `[object Object]`；现递归展开 `k:v`，每对象最多 8 项 + `等N项` 收尾

## 4. 配置项（设置页可调）

| 键 | 默认 | 说明 |
|---|---|---|
| crmEnrichEnabled | true | 自动填充总开关 |
| crmEnrichThreshold | 0.7 | 进 pending 队列的置信下限 |
| crmEnrichAutoApply | 0.85 | 直接写入的置信阈值 |
| crmEnrichBackfillLimit | 20 | 单次回填客户数上限 |

## 5. 测试基线（提交前必过）

`npx tsc --noEmit` 零错误 + 6 个套件：crm-workbench 48 / golden 39（含报价信号 8 例）/ claim 17 / autoconfirm 56 / docgen 68 / **enrich 55**（合并规则+解析+落库+quote_signal+准确率统计）。运行：`./node_modules/.bin/tsx scripts/<name>.ts`

## 6. 下一步待办（按优先级）

1. **实测 AI 报价选型**：产品库已导入 21 个产品（§3），验证报价选型是否命中新产品
2. **实测一周后看 AI 准确率面板**：修正率高 → 调高 crmEnrichAutoApply；采纳率低 → 调低
3. 图片/文件报价识别（vision 通道 → quote_signal，补 R7 盲区）
4. 发票金额自动解析 + 到款/归属队列合并（确认中心 P2）
5. 话术反哺：从已成交客户聊天提炼话术入库
6. Windows 打包验证（AGENTS.md 遗留）；chatService/main.ts 大文件拆分；前端测试

## 7. 本次新增文件索引

| 文件 | 用途 |
|---|---|
| electron/services/crmEnrichService.ts | 自动填充引擎（装配层） |
| electron/services/crmEnrichCore.ts | 填充纯核心（零 electron，可单测） |
| scripts/crm-enrich-test.ts | 填充引擎单测（55 项） |
| scripts/import-product-summary.py | 产品汇总表导入脚本 |
| resources/product-data/产品汇总表_库叉自产+外调车型.xlsx | 产品源数据（微信临时目录备份件） |
| docs/实施记录/PLAN-CRM零操作改造.md | 改造方案（已实施，含提交映射） |
