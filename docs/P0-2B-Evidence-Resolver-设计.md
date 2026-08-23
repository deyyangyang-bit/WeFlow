# P0-2B Evidence Resolver 设计

> 2026-08-23 · 设计定稿（只盘点 + 设计，未改任何代码 / schema / UI）
> 依据：docs/P0-2-数据契约盘点.md（硬伤② 证据链断点）+ docs/P0-2A-Canonical-State-设计.md
> 定位：**统一「AI 判断记录 → 证据（原消息 + 上下文）」的读入口**。复用现有 WeFlow 消息读取层，
> **不新增 WCDB 读取路径、不碰 wcdbCore、不改 `/api/v1/messages`、不迁移历史数据**。

---

## 0. 关键前提（来自盘点）

> 真实库实测（只读查询 weflow-sales.db）：`follow_up_task.source_message_id` 2523 空 + **1 条裸 serverId**；
> `intent_tag_log.message_key` 1130 空 + **1 条 canonical messageKey**（`…message_0.db:Msg_307f…3920:8`）。
> 历史双格式量极小，**只需兼容读取，无需任何迁移**。

**写点（3 个 `source_message_id` / 2 个 `message_key`）：**

| # | 写者 | 位置 | 格式 |
|---|---|---|---|
| 1 | actionEngine R3 跟进 | `salesActionEngine.ts:592` | ✅ canonical messageKey |
| 2 | insightService 催办 | `insightService.ts:2122` | ✅ canonical messageKey |
| 3 | salesFollowUpService AI 待办 | `salesFollowUpService.ts:329` | ❌ **裸 `msgId`**（`serverId \|\| localId`，:70）|
| 4 | classifier 意向日志 | `salesStageClassifier.ts:173` | ✅ canonical messageKey |
| 5 | salesIntentService 意向日志 | `salesIntentService.ts:190` | ✅ canonical messageKey |

**读点：`source_message_id` 0 个（纯写列，P0-2 UI 预留）；`message_key` 仅 canonicalState read model 暴露，无解析消费。**

**现有读取原语（resolver 复用，均走应用读取层 chatService / wcdbService，非 wcdbCore）：**

| 原语 | 能力 | 格式 |
|---|---|---|
| `chatService.getMessageById(sessionId, localId)` | 完整解析 Message（含 messageKey/createTime） | canonical / local |
| `wcdbService.getMessageByServerId(sessionId, svrid)` | 按 serverId 查（返回原生行；chatService 无公开包装） | 历史裸 ID / server: |
| `chatService.getMessagesAround(sessionId, {localId, createTime, messageKey}, 50)` | before/after 上下文（**不含目标本身**） | 命中后取上下文 |

---

## 1. API 契约（用户 2026-08-23 定稿）

```ts
getEvidenceByKey(
  sessionId: string,          // 判断记录自带，显式传入；不做 messageKey→session 反猜
  messageKey: string          // canonical / server: / 裸数字 均可
):
  | {
      status: 'found'
      message: Message        // chatService.Message（含 messageKey/parsedContent/rawContent）
      before: Message[]       // 目标之前的上下文（不含目标）
      after: Message[]        // 目标之后的上下文（不含目标）
    }
  | {
      status: 'unavailable'
      reason: 'unparseable' | 'message_not_found' | 'reader_error' | 'no_message_key'
      evidenceText?: string   // 调用方从判断记录的 evidence_text 透传，兜底展示用，不是"回查成功"
    }
```

**关键决策（已拍板）：主进程直接复用 `chatService`（= WeFlow HTTP API 的同一底层读取层，零回环、零新 API surface）；`sessionId` 显式传入。**

---

## 2. messageKey 格式与解析（`parseEvidenceKey`）

messageKey 由 `buildMessageKey` 构造（chatService + apiMessageMapping 各有一份**必须保持一致**的拷贝），段用 `encodeURIComponent` 编码，`: ` 分隔。4 种格式：

| 格式 | 形状 | 主定位字段 |
|---|---|---|
| **canonical**（主） | `encoded(dbPath):encoded(tableName):localId` | localId |
| `local:` | `local:encoded(scope):localId:createTime:sortSeq:sender:localType` | localId |
| `server:` | `server:encoded(scope):serverId:createTime:sortSeq:localId:sender:localType` | serverId |
| `fallback:` | `fallback:encoded(scope):createTime:sortSeq:localId:sender:localType` | localId |
| 裸数字（历史） | `7624353663315474928` | serverId（**字符串**，16+ 位超出 Number 精度） |

`parseEvidenceKey(messageKey)` 分类规则：

```
trim 后为空                                   → unparseable
/^\d+$/（纯数字）                              → { kind:'serverId', serverId: 原样字符串 }
parts = split(':')
parts[0]==='local'     且 parts[2] 为数字      → { kind:'localId', localId }
parts[0]==='server'    且 parts[2] 为数字      → { kind:'serverId', serverId: parts[2] }
parts[0]==='fallback'  且 parts[4] 为数字      → { kind:'localId', localId }
默认（canonical，3 段）且末段为数字            → { kind:'localId', localId: 末段 }
其余                                              → unparseable
```

⚠️ **serverId 必须保留字符串**（如 `7624353663315474928` > Number.MAX_SAFE_INTEGER，转 Number 丢精度）；localId 是安全整数可直接 Number。

---

## 3. Resolver 行为（`createEvidenceResolver(reader)`）

**reader 接口**（默认注入真实 `chatService`，测试注入 fake）：

```ts
interface EvidenceMessageReader {
  getMessageById(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }>
  getMessageByServerId(sessionId: string, svrid: string): Promise<{ success: boolean; message?: Message; error?: string }>
  getMessagesAround(sessionId: string, target: { localId?: number; createTime: number; messageKey?: string }, count?: number)
    : Promise<{ success: boolean; before: Message[]; after: Message[]; error?: string }>
}
```

**流程：**

```text
getEvidenceByKey(sessionId, messageKey, evidenceText?)
  ├─ parsed = parseEvidenceKey(messageKey)
  │    unparseable → unavailable(reason:'unparseable', evidenceText)     // 不发任何读取
  ├─ parsed.kind === 'localId'
  │    └─ reader.getMessageById(sessionId, localId)
  ├─ parsed.kind === 'serverId'
  │    └─ reader.getMessageByServerId(sessionId, serverId)               // 历史裸 ID 兼容路径
  ├─ 未命中 / reader 报错 → unavailable(reason:'message_not_found'|'reader_error', evidenceText)
  ├─ 命中 → context = reader.getMessagesAround(sessionId, {localId, createTime, messageKey}, 50)
  │    上下文失败非致命 → before/after 为空，仍返回 found
  └─ → { status:'found', message, before, after }
```

**失败语义**：找不到消息**绝不伪造**——明确返回 `unavailable` + 具体 reason；`evidenceText` 只是兜底展示（判断依据句，已有列），不冒充回查成功。

---

## 4. source_message_id 统一（只改未来写，不迁移历史）

1. **`shared/messageKey.ts`（新建）**：把 `buildMessageKey` 从 chatService 私有方法 + apiMessageMapping 拷贝**提取为共享纯函数**（单一真源，消掉"两处必须保持一致"的漂移风险）。chatService / apiMessageMapping / salesFollowUpService 三方共用。
2. **`salesFollowUpService.ts` 写点修复**（唯一非 canonical 写者）：`roughFilter` 从原生行（已带 `_db_path`/`table_name`/`local_id`）经 `buildMessageKey` 产出 canonical messageKey；`todoCreate` 改写 `messageKey`，**不再写裸 `msgId`**。
3. **历史**：1 条裸 serverId **不 UPDATE、不迁移**；由 resolver 的 serverId 分支兼容读取（真实库已实证分布，见 §0）。

---

## 5. 模块结构与可测性

| 文件 | 内容 | 依赖 |
|---|---|---|
| `shared/messageKey.ts`（新建） | `buildMessageKey` 纯构造 + 类型 | 零依赖（Node 可测） |
| `shared/evidenceKey.ts`（新建） | `parseEvidenceKey` 纯解析 + 类型 | 零依赖（Node 可测） |
| `electron/services/evidenceResolver.ts`（新建） | `createEvidenceResolver(reader)` + `getEvidenceByKey` | 无 Electron import（测试注入 fake reader） |
| `electron/services/chatService.ts`（改） | ① 改用共享 `buildMessageKey`；② **新增公开 `getMessageByServerId` 薄包装**（内部 `wcdbService.getMessageByServerId` → 私有 `parseMessage`，复用既有原语，非新增读取层） | — |
| `electron/services/apiMessageMapping.ts`（改） | 改用共享 `buildMessageKey`（删本地拷贝） | — |
| `electron/services/salesFollowUpService.ts`（改） | `roughFilter` 产出 canonical key；写点改 messageKey | — |
| `electron/main.ts`（改） | IPC `sales:evidence:getByKey(sessionId, messageKey)` → resolver（薄传输，无 UI） | — |
| `electron/preload.ts` + `src/types/electron.d.ts`（改） | 同步 IPC 类型 | — |

> 复用 P0-2A 的可测性模式：纯解析/构造抽到 `shared/`（Node 直接测），resolver 读路径靠 **reader 注入**（fake reader 在 Node 测编排逻辑），不加载 Electron。

---

## 6. 测试验收标准（`scripts/evidence-resolver-test.ts`）

| # | 用例 | 断言 |
|---|---|---|
| 1 | canonical 解析 | `%2F…%2Fmessage_0.db:Msg_307f…:8` → `{kind:'localId', localId:8}`，dbPath/tableName 正确 decode |
| 2 | local:/server:/fallback: 解析 | 各取对应定位字段；serverId 保持字符串 |
| 3 | 历史裸数字 | `7624353663315474928` → `{kind:'serverId', serverId:'7624353663315474928'}`（精度无损）|
| 4 | 垃圾/空值 | → `unparseable` |
| 5 | canonical 命中 | fake reader `getMessageById(sessionId, localId)` 被正确调用 → `found` + message + before/after |
| 6 | 历史裸 ID 命中 | fake reader `getMessageByServerId(sessionId, svrid)` 被正确调用 → `found` |
| 7 | miss | 读者返回失败 → `unavailable(message_not_found)`，**不伪造** |
| 8 | unparseable | 立即 `unavailable(unparseable)`，**reader 零调用** |
| 9 | evidenceText 兜底 | unavailable 返回里带传入的 evidenceText |
| 10 | 上下文失败非致命 | getMessagesAround 失败 → 仍 `found` + before/after 空 |
| 11 | **只读断言** | fake reader 记录全部调用：仅 getMessageById/getMessageByServerId/getMessagesAround，**无任何写方法**；resolver 不改 reader 状态 |
| 12 | sessionId 透传 | 读调用携带传入的 sessionId |
| 13 | buildMessageKey 4 分支 | 各格式构造 → parseEvidenceKey 回读一致（round-trip） |

回归：`todo-followup`（salesFollowUpService 改写后）11/11 + 视情况补 source_message_id=canonical 断言；其余销售套件全绿。

---

## 7. 执行边界

- ✅ 复用现有应用读取层（chatService / wcdbService 既有原语）
- ❌ 不新增 WCDB 读取层、不直接碰 wcdbCore
- ❌ 不改 `/api/v1/messages`、不加 HTTP 端点
- ❌ 不迁移/清洗历史数据（双格式兼容读取）
- ❌ 不改 evidence_text 语义、不做 AI Judgment UI、不引入 CustomerEvent
- ✅ 每刀独立提交独立验证（tsc 0 + 新测试 + 回归）
