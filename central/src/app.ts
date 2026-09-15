import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  CENTRAL_ENTITY_TYPES, CENTRAL_SYNC_PROTOCOL_VERSION, findForbiddenCentralField, findForbiddenDownlinkField,
  isRefOwnedByDevice, validateCentralRefFields, validateCentralSyncEvent,
  type CentralAckRequest, type CentralEntityType, type CentralPushRequest, type CentralSyncEvent
} from '../../shared/centralSync.js'
import {
  downCommandSpec, isDownDirection, validateCentralEntityId, validateDownCommand
} from '../../shared/centralDownCommand.js'
import { createSecret, safeSecretEqual, secretHash } from './crypto.js'
import { can, type Capability } from './permissions.js'
import { projectionRegistryGaps } from './projections.js'
import type { CentralConfig } from './config.js'
import type { CentralStore, DevicePrincipal, EnterpriseRole } from './store.js'

declare module 'fastify' {
  interface FastifyRequest { principal?: DevicePrincipal }
}

const roles: EnterpriseRole[] = ['sales', 'supervisor', 'allocator', 'admin', 'service']

/** 日志里永不出现的请求头：设备凭证即长期凭据，写进日志等于泄漏。 */
const REDACTED_HEADERS = ['req.headers.authorization', 'req.headers["idempotency-key"]', 'request.headers.authorization']

function bearer(request: FastifyRequest): string {
  const value = String(request.headers.authorization || '')
  return value.startsWith('Bearer ') ? value.slice(7).trim() : ''
}

/**
 * 中央运维动作的 actor 标识。用 `device:<deviceId>` 而不是显示名：显示名可重复，
 * 设备 id 才能在「谁签发了这张邀请码 / 谁吊销了这台设备」的追溯里唯一定位。
 */
function actorOf(request: FastifyRequest): string {
  return `device:${request.principal!.deviceId}`
}

function error(code: string, message: string, requestId: string) {
  return { ok: false as const, code, message, requestId }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 目标标识必须是 UUID 形态。放在路由层做，是为了让非法目标返回 400 而不是
 * 让 `$2::uuid` 在 PostgreSQL 抛错变成 500（§七.5）。
 */
function isUuid(value: unknown): boolean {
  return UUID_PATTERN.test(String(value ?? ''))
}

/**
 * §二.5：sales 角色的设备只能上传其本职业务产生的投影。
 * `ownership`（账号归属）与 `permission`（权限声明）分别由分配侧与主管侧产生，
 * 销售设备上传这两类即越权，直接拒收而不是静默丢弃。
 */
const SALES_UPLINK_ENTITY_TYPES: readonly CentralEntityType[] = [
  'customer', 'customer_identity', 'assignment', 'opportunity', 'quote',
  'audit_event', 'customer_judgment', 'knowledge_proposal'
]

const syncEventSchema = {
  type: 'object', additionalProperties: false,
  required: ['protocolVersion', 'eventId', 'eventSeq', 'idempotencyKey', 'direction', 'entityType', 'entityId', 'eventType', 'aggregateVersion', 'payload', 'occurredAt'],
  properties: {
    protocolVersion: { type: 'integer', const: CENTRAL_SYNC_PROTOCOL_VERSION },
    eventId: { type: 'string', minLength: 1, maxLength: 160 },
    eventSeq: { type: 'integer', minimum: 1 },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 240 },
    direction: { type: 'string', enum: ['up', 'down'] },
    entityType: { type: 'string', enum: [...CENTRAL_ENTITY_TYPES] },
    entityId: { type: 'string', minLength: 1, maxLength: 160 },
    eventType: { type: 'string', minLength: 1, maxLength: 100 },
    aggregateVersion: { type: 'integer', minimum: 0 },
    payload: { type: 'object', additionalProperties: true },
    evidenceKey: { type: 'string', maxLength: 600 },
    targetEmployeeId: { type: 'string', minLength: 1, maxLength: 100 },
    targetDeviceId: { type: 'string', minLength: 1, maxLength: 100 },
    occurredAt: { type: 'number', exclusiveMinimum: 0 }
  }
} as const

export interface BuildAppOptions { store: CentralStore; config: CentralConfig; logger?: boolean }

export function buildCentralApp(options: BuildAppOptions): FastifyInstance {
  const { store, config } = options
  // 启动自检：协议实体清单与投影注册表必须一一对应，缺一项就拒绝启动。
  const gaps = projectionRegistryGaps()
  if (gaps.length) throw new Error(`中央投影注册表不完整：${gaps.join(', ')}`)

  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel, redact: REDACTED_HEADERS },
    trustProxy: config.tlsTerminated
  })

  app.setErrorHandler((error_, request, reply) => {
    // 只记 message/stack/错误码：pg 异常的 parameters 可能带业务值，绝不整体落日志。
    const err = error_ as Error & { code?: string; statusCode?: number }
    const validation = typeof err === 'object' && err !== null && 'validation' in err && Boolean((err as { validation?: unknown }).validation)
    // 请求侧的 4xx（如缺 content-type 的 FST_ERR_CTP_INVALID_MEDIA_TYPE=415）是调用方错误，
    // 必须按原状态码回，否则畸形请求会被记成「中央服务内部错误」的 500，污染服务端监控（§七.5 同类）。
    const clientStatus = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 0
    // 5xx 才按服务端故障记 error 级：调用方畸形请求不占用错误告警
    if (!validation && !clientStatus) request.log.error({ err: { message: err.message, stack: err.stack, code: err.code } }, 'request failed')
    if (validation) return void reply.code(400).send(error('E101', '请求参数不合法', request.id))
    if (clientStatus) return void reply.code(clientStatus).send(error('E400', '请求无法处理', request.id))
    void reply.code(500).send(error('E500', '中央服务内部错误', request.id))
  })

  app.get('/health', async () => ({ ok: true, data: { service: 'weflow-central', protocolVersion: CENTRAL_SYNC_PROTOCOL_VERSION } }))
  app.get('/ready', async (_request, reply) => {
    try { await store.ping(); return { ok: true, data: { database: 'ready' } } }
    catch { return reply.code(503).send(error('E503', '数据库未就绪', String(reply.request.id))) }
  })

  app.addHook('onClose', async () => { await store.close() })

  app.register(async (api) => {
    api.addHook('preHandler', async (request, reply) => {
      if (request.url === '/api/v1/bindings/claim') return
      const token = bearer(request)
      if (token && safeSecretEqual(token, config.adminToken)) {
        request.principal = { workspaceId: '', employeeId: 'bootstrap-admin', deviceId: 'bootstrap-admin', displayName: 'bootstrap-admin', role: 'admin' }
        return
      }
      if (!token) return reply.code(401).send(error('E401', '缺少设备凭证', request.id))
      const principal = await store.authenticate(secretHash(token))
      if (!principal) return reply.code(401).send(error('E401', '设备凭证无效或已吊销', request.id))
      request.principal = principal
    })

    /** 统一权限闸门：端点只声明需要哪个能力，角色→能力映射只存在于 permissions.ts。 */
    const require_ = (capability: Capability) => async (request: FastifyRequest, reply: FastifyReply) => {
      if (!can(request.principal!.role, capability)) {
        return reply.code(403).send(error('E403', `当前角色无权执行 ${capability}`, request.id))
      }
    }

    /**
     * §二.7：bootstrap-admin 是运维身份，不属于任何工作区。
     * 常规 push/pull/ack 必须带工作区上下文，否则「空 workspaceId」会绕过工作区隔离。
     */
    const requireWorkspace = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.principal!.workspaceId) {
        return reply.code(400).send(error('E101', 'bootstrap-admin 无工作区上下文，不得调用常规同步接口', request.id))
      }
    }

    api.post('/bindings/invitations', {
      preHandler: require_('invite.create'),
      schema: { body: { type: 'object', additionalProperties: false, required: ['workspaceId', 'employeeCode', 'displayName', 'role'], properties: {
        workspaceId: { type: 'string', format: 'uuid' }, employeeCode: { type: 'string', minLength: 1, maxLength: 80 },
        displayName: { type: 'string', minLength: 1, maxLength: 80 }, role: { type: 'string', enum: roles },
        expiresInMinutes: { type: 'integer', minimum: 5, maximum: 1440 }
      } } }
    }, async (request, reply) => {
      const body = request.body as { workspaceId: string; employeeCode: string; displayName: string; role: EnterpriseRole; expiresInMinutes?: number }
      // 工作区隔离：非 bootstrap-admin 只能在自身工作区签发邀请码
      const workspaceId = request.principal!.workspaceId || body.workspaceId
      if (request.principal!.workspaceId && request.principal!.workspaceId !== body.workspaceId) {
        return reply.code(403).send(error('E403', '只能为自身工作区签发邀请码', request.id))
      }
      const inviteCode = createSecret(24)
      const expiresAt = Date.now() + (body.expiresInMinutes || 30) * 60_000
      // §四：签发人进审计（与签发同事务）。审计不记邀请码明文，也不记 code_hash。
      const created = await store.createInvite({ ...body, workspaceId, expiresAt }, secretHash(inviteCode), actorOf(request))
      // 邀请码只在此响应体里出现一次；服务端只存哈希，日志已按 redact 规则排除
      return reply.code(201).send({ ok: true, data: { ...created, inviteCode, expiresAt } })
    })

    api.post('/bindings/claim', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['inviteCode', 'deviceName'], properties: {
        inviteCode: { type: 'string', minLength: 16, maxLength: 200 }, deviceName: { type: 'string', minLength: 1, maxLength: 120 }
      } } }
    }, async (request, reply) => {
      const body = request.body as { inviteCode: string; deviceName: string }
      const deviceToken = createSecret()
      try {
        const principal = await store.claimInvite(secretHash(body.inviteCode), body.deviceName, secretHash(deviceToken))
        return reply.code(201).send({ ok: true, data: { deviceToken, principal } })
      } catch {
        return reply.code(409).send(error('E409', '邀请无效、已使用或已过期', request.id))
      }
    })

    api.post('/devices/rotate', { preHandler: require_('device.rotate') }, async (request) => {
      const token = createSecret()
      await store.rotateDeviceToken(request.principal!, secretHash(token))
      return { ok: true, data: { deviceToken: token } }
    })

    // 自助解绑：客户端「先请求服务端撤销，再清本地凭证」的服务端半边。
    // 只作用于调用者自己的设备，不需要额外权限位之外的授权。
    api.post('/devices/revoke-self', { preHandler: require_('device.revokeSelf') }, async (request) => {
      const revoked = await store.revokeSelf(request.principal!)
      return { ok: true, data: { revoked, deviceId: request.principal!.deviceId } }
    })

    api.post('/devices/:deviceId/revoke', {
      preHandler: require_('device.revoke'),
      schema: {
        // §五：deviceId 直接进 `$1::uuid`。schema 层限死 UUID 形态，非法路径参数在路由层就 400，
        // 绝不落到 PostgreSQL 的 22P02（那会把调用方拼错 URL 记成中央服务 500）。
        params: { type: 'object', required: ['deviceId'], properties: { deviceId: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', additionalProperties: false, properties: { workspaceId: { type: 'string', format: 'uuid' } } }
      }
    }, async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string }
      // schema 的 format 依赖 ajv-formats 已加载；这里再显式判一次，保证「非法标识绝不碰数据库」
      // 这条纪律不依赖校验器实现细节（也是 MemoryStore 契约测试能覆盖的那一层）。
      if (!isUuid(deviceId)) return reply.code(400).send(error('E101', '设备标识格式非法：deviceId', request.id))
      const body = (request.body || {}) as { workspaceId?: string }
      if (body.workspaceId !== undefined && !isUuid(body.workspaceId)) {
        return reply.code(400).send(error('E101', '工作区标识格式非法：workspaceId', request.id))
      }
      const workspaceId = request.principal!.workspaceId || String(body.workspaceId || '')
      // 无工作区上下文的 bootstrap-admin 必须显式指定目标工作区，否则越权吊销无法追责
      if (!workspaceId) return reply.code(400).send(error('E101', 'bootstrap-admin 吊销设备时必须指定 workspaceId', request.id))
      const revoked = await store.revokeDevice(workspaceId, deviceId, request.principal!.displayName)
      return { ok: true, data: { revoked } }
    })

    api.post('/sync/push', {
      preHandler: [require_('sync.push'), requireWorkspace],
      schema: { body: { type: 'object', additionalProperties: false, required: ['events'], properties: {
        events: { type: 'array', minItems: 1, maxItems: 100, items: syncEventSchema }
      } } }
    }, async (request, reply) => {
      const idem = String(request.headers['idempotency-key'] || '').trim()
      if (!idem) return reply.code(400).send(error('E101', '缺少 Idempotency-Key', request.id))
      const body = request.body as CentralPushRequest
      const principal = request.principal!
      const acceptable: CentralSyncEvent[] = []
      const rejected: Array<{ eventId: string; code: string; message: string }> = []
      for (const event of body.events) {
        // 逐条判定，不做整批拒绝：一条坏事件不得让同批有效事件一起卡在 outbox 里。
        if (event.direction !== 'up') { rejected.push({ eventId: event.eventId, code: 'wrong_direction', message: '上行接口只接受 direction=up' }); continue }
        const protocolError = validateCentralSyncEvent(event)
        if (protocolError) { rejected.push({ eventId: event.eventId, code: protocolError, message: '事件信封不合法' }); continue }
        // §二.2：上行 entityId 必须是「本设备命名空间/localRef」，客户端不得冒充他机前缀
        if (!isRefOwnedByDevice(principal.deviceId, event.entityId)) {
          rejected.push({ eventId: event.eventId, code: 'entity_id_not_owned', message: '上行 entityId 不属于本设备命名空间' })
          continue
        }
        // §二.5：销售设备不得上传越权类别的投影
        if (principal.role === 'sales' && !SALES_UPLINK_ENTITY_TYPES.includes(event.entityType)) {
          rejected.push({ eventId: event.eventId, code: `role_not_allowed_entity:${event.entityType}`, message: '当前角色不得上传该类别投影' })
          continue
        }
        // §三.1：光有设备前缀还不够——`entityType=customer` + `entityId=<dev>/assignment:1` 会污染
        // 客户表。引用类别必须与 entityType 语义一致，且必须是完整 scoped 引用。
        const entityKindError = validateCentralEntityId(event.entityType, event.entityId)
        if (entityKindError) {
          rejected.push({ eventId: event.eventId, code: entityKindError, message: '上行实体引用与 entityType 不符' })
          continue
        }
        // §三.2/§三.3：载荷内登记过的 `*Ref` 字段同样要闸：类别必须与字段语义一致，
        // 且本地上行投影不得借用他机命名空间（同工作区内也不行）。
        const refError = validateCentralRefFields(event.payload, principal.deviceId)
        if (refError) {
          rejected.push({ eventId: event.eventId, code: refError, message: '上行载荷引用字段非法' })
          continue
        }
        const forbidden = findForbiddenCentralField(event.payload)
        if (forbidden) {
          rejected.push({ eventId: event.eventId, code: 'forbidden_field', message: `载荷包含禁止上行的字段：${forbidden}` })
          // 命中禁字段是策略违规，必须留中央审计；只记字段路径，不记值
          await store.recordPolicyViolation(principal, event, forbidden)
          continue
        }
        acceptable.push(event)
      }
      const result = acceptable.length ? await store.pushEvents(principal, acceptable) : { accepted: [], rejected: [] }
      return { ok: true, data: { accepted: result.accepted, rejected: [...rejected, ...result.rejected] } }
    })

    api.get('/sync/pull', {
      preHandler: [require_('sync.pull'), requireWorkspace],
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        cursor: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 }
      } } }
    }, async (request) => {
      const query = request.query as { cursor?: number; limit?: number }
      return { ok: true, data: await store.pullEvents(request.principal!, Number(query.cursor || 0), Number(query.limit || 100)) }
    })

    api.post('/sync/ack', {
      preHandler: [require_('sync.ack'), requireWorkspace],
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['acknowledgements'],
          properties: {
            acknowledgements: {
              type: 'array', minItems: 1, maxItems: 200,
              items: {
                type: 'object', additionalProperties: false, required: ['centralSeq', 'eventId', 'outcome'],
                properties: {
                  centralSeq: { type: 'integer', minimum: 1 },
                  eventId: { type: 'string', minLength: 1, maxLength: 160 },
                  outcome: { type: 'string', enum: ['applied', 'conflict', 'invalid', 'retry'] },
                  localVersion: { type: 'integer', minimum: 0 },
                  detail: { type: 'string', maxLength: 500 }
                }
              }
            }
          }
        }
      }
    }, async (request) => {
      const body = request.body as CentralAckRequest
      return { ok: true, data: { acknowledged: await store.ackEvents(request.principal!, body.acknowledgements) } }
    })

    api.post('/sync/commands', {
      preHandler: [require_('command.issue'), requireWorkspace],
      schema: { body: syncEventSchema }
    }, async (request, reply) => {
      const event = request.body as CentralSyncEvent
      const reject = (code: string, message: string) => reply.code(400).send(error(code, message, request.id))
      // ① 信封层：协议字段、禁字段（下行只拦聊天正文，见 findForbiddenDownlinkField）
      if (!isDownDirection(event)) return reject('E102', '下行指令必须 direction=down')
      const envelopeError = validateCentralSyncEvent(event)
      if (envelopeError) return reject('E102', `下行事件不合法：${envelopeError}`)
      const chatLeak = findForbiddenDownlinkField(event.payload)
      if (chatLeak) return reject('E102', `载荷包含禁止下行的字段：${chatLeak}`)

      // ② 目标格式：非法 UUID 必须在碰数据库之前就 400，而不是让 pg 抛错变 500（§七.5）
      for (const field of ['targetEmployeeId', 'targetDeviceId'] as const) {
        const value = event[field]
        if (value !== undefined && value !== null && value !== '' && !isUuid(value)) {
          return reject('E101', `目标标识格式非法：${field}`)
        }
      }

      // ③ 业务层：共享校验器（与 Phase 1 SMB 同一份规则，不在服务端复制一遍）
      // transport 显式写 'central-http'：lead 子对象只允许 6 个字段，contactRaw / wechat 一律 400。
      // SMB 文件通道的历史口径（8 字段）走 leadFieldsFor('smb')，不得与中央 HTTP 混用同一份白名单。
      const businessError = validateDownCommand({
        eventType: event.eventType, entityType: event.entityType,
        payload: event.payload, targetEmployeeId: event.targetEmployeeId, targetDeviceId: event.targetDeviceId
      }, 'central-http')
      if (businessError) return reject('E103', `下行指令业务校验失败：${businessError}`)
      const entityIdError = validateCentralEntityId(event.entityType, event.entityId)
      if (entityIdError) return reject('E103', `下行指令实体引用非法：${entityIdError}`)

      // ④ 投递范围：目标员工/设备必须同属一个工作区，且同时指定时属于同一员工（§七.4）
      const workspaceId = request.principal!.workspaceId
      if (!(await store.isTargetInWorkspace(workspaceId, event.targetDeviceId, event.targetEmployeeId))) {
        return reply.code(403).send(error('E403', '目标员工或设备不在当前工作区', request.id))
      }
      if (event.targetDeviceId && event.targetEmployeeId &&
        !(await store.deviceBelongsToEmployee(workspaceId, event.targetDeviceId, event.targetEmployeeId))) {
        return reject('E103', '目标设备与目标员工不属于同一员工')
      }
      // ⑤ 落库前再确认一次事件类型在册（downCommandSpec 已查过，这里防止注册表与路由漂移）
      if (!downCommandSpec(event.eventType)) return reject('E103', `未登记的下行事件类型：${event.eventType}`)
      try {
        return reply.code(201).send({ ok: true, data: await store.appendDownEvent(request.principal!, { ...event, direction: 'down' }) })
      } catch (thrown) {
        // 幂等键被另一条 eventId 占用：语义冲突，必须 409 而不是静默改写成重复
        const message = thrown instanceof Error ? thrown.message : String(thrown)
        if (message === 'idempotency_key_conflict') return reply.code(409).send(error('E409', '同幂等键已存在不同指令', request.id))
        throw thrown
      }
    })

    // 员工目录：本地显示名 → 稳定员工标识的唯一解析依据（PRD §3.1 身份行）。
    // 只回目录，不回任何客户数据；sales 角色无 directory.read，按名字猜人的成本被挡在权限层。
    api.get('/directory/employees', { preHandler: require_('directory.read') }, async (request) => {
      return { ok: true, data: { employees: await store.listEmployees(request.principal!.workspaceId) } }
    })
  }, { prefix: '/api/v1' })

  return app
}
