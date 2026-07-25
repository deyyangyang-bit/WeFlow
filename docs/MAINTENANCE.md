# WeFlow AI 销售助手 · 维护与打包手册

> 二次开发交接文档。配合 `docs/PRD-v0.2-AI销售助手.md` 阅读。
> 基线：WeFlow v5.0.0 fork（`deyyangyang-bit/WeFlow`，**origin 指向上游，禁止 push**）。

## 0. 一句话定位
单机 AI 销售助手（叉车/仓储设备，B 端约 20% + C 端约 80%）。**只读**微信本地库（WCDB），销售自有数据存独立库 `weflow-sales.db`（sql.js / WASM，跨平台无原生编译）。AI 走 DeepSeek 兼容接口。

## 1. 我们新增 / 改动的文件地图
**后端 `electron/services/`**
- `salesDbService.ts` — 销售库 5 表 + CRUD + `getDashboardStats`(仪表盘聚合) + `customerList`(支持 search/sortBy)。
- `salesKnowledgeService.ts` — 知识库 CRUD + **中文 n-gram 检索** `retrieveForPrompt` + **全量注入** `buildKnowledgeContext`（小库全喂模型自挑，大库退回检索）。
- `salesReportService.ts` — 周/月报，统计走原生 `getAnnualReportStats`。
- `salesIntentService.ts` — AI 意向分析（带并发锁）。
- `salesReplyService.ts` — 回复建议，注入 `buildKnowledgeContext`。
- `salesFollowUpService.ts` — 两段式待办提取 + 自动核验 + `scanUrgeFollowUps`(催办)。
- `salesQueue.ts` — **串行队列** `enqueueSalesTask`，杜绝并发调原生 WCDB 段错误。
- `aiApiClient.ts` — 统一 AI 调用层。
- `insightService.ts`（改）— 销售 prompt + 沉默上限/限量/优先级排序 + 高意向预警 `shouldAlert` + `batchProfile`/`batchProfileCore` + 自动回填 + 调催办。
- `main.ts`（改）— 全部 `sales:*` IPC handler；**已移除** `salesAlertService` 的 import/setConfig/start。
- `salesAlertService.ts` — **已废弃死代码**（功能并入 insightService，无任何引用，可直接删除；保留仅作历史参考）。

**前端 `src/`**
- `pages/SalesDashboardPage.tsx` — 仪表盘，**接管 `/` 与 `/home`**（原品牌页移到 `/welcome`）。
- `pages/CustomerListPage.tsx` — 客户列表 + 搜索/阶段 tab/排序 + **导出 Excel** + 画像抽屉（复用 CustomerCard）。
- `pages/FollowUpPage.tsx` — 待办 + AI 扫描 + 批量画像。
- `pages/KnowledgeBasePage.tsx` / `SalesReportPage.tsx`。
- `stores/` — dashboardStore / customerListStore / customerProfileStore / followUpStore / knowledgeStore / salesReportStore。
- `components/sales/` — CustomerCard / ReplySuggestion。

## 2. 数据流
```
WCDB(只读) ──► 各 service 读聊天/会话/统计
weflow-sales.db ──► 知识库/报表/客户画像/意向日志/待办
aiApiClient ──► DeepSeek（统一 system prompt 以命中缓存）
DB变更/定时器 ──► insightService(沉默扫描+活跃分析) ──► 见解+预警+回填+催办
所有"调WCDB+AI"的重操作 ──► salesQueue 串行（排队不拒绝）
```

## 3. 启动与打包（最常踩坑，务必照做）
- **调试**：`npm run dev` —— 仅开发期。3011 会话规模下渲染进程易崩，**不要用于验收/日常**。
- **正式运行/验收**：用打包版，不用 dev。
- **打包前必杀残留**（否则 electron-builder 的 packaging 阶段死锁、2 分钟不写盘）：
  ```bash
  pkill -9 -f "vite|esbuild|rolldown|WeFlow|Electron|electron-builder|app-builder"; sleep 3
  rm -rf release dist dist-electron
  ```
- **mac（Apple Silicon）**：`CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac` → 出 dmg+zip（未签名，单机自用足够）。快速验证可加 `--dir` 只出 .app。
- **win（在 mac 上交叉编译）**：`CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --x64` → 出 nsis 安装包 `.exe`。**win 只打 x64**（`resources/key/win32/` 只有 x64 的解密 key，arm64 缺 key 会解密失败）。需联网下载 electron + nsis 资源。
- **一套源码、两个产物**，无法一个包通吃两平台。
- **打包后必查 asar 含新接口**（吸取过 preload 漏打包的亏）：
  `grep -a -o "<新ipc或方法名>" release/*/WeFlow.app/Contents/Resources/app.asar`

## 4. 已知坑（血泪清单）
1. **闪退真凶曾是误加 `app.disableHardwareAcceleration()`**：原版 GPU 渲染正常，禁用反而触发 SharedImage 崩溃。**不要加任何 GPU 禁用开关**。
2. **WCDB 时间戳单位**：会话 `lastTimestamp` 是**秒**，JS `Date` 是**毫秒**；消息时间字段名不统一（`createTime`/`create_time`/`msg_time`），需兼容。
3. **API 缓存**：必须用**单一固定 system prompt**，销售差异放 user prompt；多套 system prompt 交替会让缓存命中率崩、费用飙升。
4. **ffmpeg 缺失会崩**：已加 `~/bin/ffmpeg` 回退路径；用户需自备 ffmpeg 放到 `~/bin/`。
5. **origin 是上游 fork，禁止 push**；备份用独立 remote（见 §8）。
6. **队列死锁**：`enqueueSalesTask` 只加在最外层入口；被排队函数内部**绝不能再 enqueue**。故 `batchProfile` 拆成 enqueue 外壳 + `batchProfileCore` 内核，`runSilenceScan` 内部回填调内核。
7. **诊断代码勿留**：`process.on('uncaughtException')` 会让进程该死不死、掩盖真崩溃。维护时若见 main.ts 含 `[CRASH]`/`[PROCESS EXIT]` 或 salesIntentService 含 `console.log('[SalesIntent]'`，请删除（这些是历史排查残留）。

## 5. 配置项（设置 → AI 见解）
`aiInsightSilenceDays`(沉默下限,默认3) · `aiInsightSilenceMaxDays`(上限,默认30) · `aiInsightScanLimit`(每次扫描上限,默认50) · `aiInsightCooldownMinutes`(冷却,**建议 10080=7天**) · `aiInsightScanIntervalHours`(扫描间隔,默认4)。高意向动态阈值硬编码：决策 1 天 / 比价 2 天。

## 6. 降级与未做项
- **P2「回复建议填入输入框」**：WeFlow 是只读工具，**无发送输入框**，不做；一键复制剪贴板即只读场景最佳体验。
- **话术自动提炼**（从真实聊天总结话术入库）：待做，与已接通的知识库闭环。
- **首次使用引导**：不做。

## 7. 技术债
- `any` 集中在 WCDB 返回边界（salesFollowUpService 等），难消除，可接受。
- `tsconfig` 的 `noUnusedLocals/Parameters=false`，未用 import 不报错；清理依赖时注意。
- `salesAlertService.ts` 废弃死代码，可直接删。

## 8. 备份到 GitHub 私人仓库
- `.gitignore` 已护住 `node_modules`/`dist`/`release`/`*.db`/`.env` 等；销售库与含 API key 的配置在 userData、不在仓库，**推送安全**。
- 仓库约 200M（含跨平台二进制），单文件均 <100M 不触限，首次 push 较慢。
- 流程（origin 不动，用独立 remote）：
  1. 网页建 **private 空仓库**（勿勾选初始化 README）。
  2. `git remote add backup https://github.com/<你的用户名>/<仓库名>.git`
  3. `git push -u backup main`
  - 或修复 gh 登录（`gh auth login`）后一条：`gh repo create <用户名>/<仓库名> --private --source=. --remote=backup --push`

## 9. 后续路线图
P1 话术自动提炼 · 客户列表「打开聊天」跳转 · P2 知识库向量化（仅当知识量超过全量塞上下文时）· 回复建议增强（若未来 WeFlow 增加发送能力）。

## 10. 安全与发布红线（上传/分发前必读）
- **无硬编码密钥**：代码里没有数据库密码、API key、解密 hex key 的字面量。`config.ts` 里的 `decryptKey`/`aiModelApiKey` 等只是**配置键名**；真实密钥值在用户本机 `userData/WeFlow-config.json`（`safe:` 加密存储，**不在 git 仓库**）。
- **`auth` 模块是"本地应用锁"，不是付费激活**：`enableLock/unlock/changePassword` 给 app 加本地密码防他人查看，纯本地、不联网、无 license/注册码/付费墙。**不存在付费激活逻辑**，无需担心上传泄露。
- **`resources/key/*.{dll,dylib}` 是解密微信库的原生二进制程序**（wx_key 等），**不是密钥文本**，是 win/mac 解密微信数据库所必需，**必须保留在仓库**，切勿当"密钥"误删。
- **`.gitignore` 已护住** `node_modules`/`dist`/`release`/`*.db`/`.env`/`*.log`；销售库与配置在 userData，本就不进仓库 → push 安全。
- **🚨 已删除 `build.publish` 上游配置**：原 `package.json` 的 `build.publish` 指向上游作者 `hicccc77/WeFlow`，已移除。**严禁运行 `electron-builder --publish`**（无 publish 目标，手滑也推不出去）。若将来要自动更新，请配置**自己的**私人仓库并加 `"private": true`。
- **`origin` 是上游 fork，禁止 `git push origin`**；备份只用独立 remote（见 §8）。

## 11. 版本号规则
- 二创采用**独立版本线**，与上游 WeFlow 的 5.0.0 脱钩，当前 **1.0.0**。
- **改版本只改一处**：`package.json` 顶层 `"version"`。改后：设置页"关于"与启动闪屏自动显示 `v{version}`（读 `app.getVersion()`，无需改 UI）；产物文件名自动变 `WeFlow-{version}-Setup.{exe|dmg|zip}`。
- 遵循 semver：修 bug → patch（1.0.0→1.0.1）；加功能 → minor（1.0.0→1.1.0）；不兼容大改 → major。用户报问题先核对版本，确认其是否已更新。
- 改版本后**必须重打包**两平台，新版本号才进安装包与界面。

## 12. 日志与配置文件
- **配置文件**：`userData/WeFlow-config.json`（ConfigService 持久化，设置页可改，**不进 git**）。销售相关配置项复用其机制：`aiInsightSilenceMaxDays`/`aiInsightScanLimit`/`aiInsightCooldownMinutes` 等（详见 §5）。配置已写好，无需新增存储。
- **销售日志**：`userData/logs/weflow-sales.log`（`salesLogger.ts`），**2MB 单备份轮转**（超限翻成 `.old`）。`insightLog` 双写 console+文件，故销售 AI 调用、沉默扫描、高意向预警、自动回填、催办识别的 INFO/WARN/ERROR 均落盘，打包版可查。日志**不记录密钥与聊天原文全文**，仅记操作摘要。
- WeFlow 主流程日志在 `userData/logs/wcdb.log`（`log:getPath`，设置页可查看/清空）。
