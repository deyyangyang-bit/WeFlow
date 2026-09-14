import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import {
  CENTRAL_ENTITY_TYPES, CENTRAL_SYNC_PROTOCOL_VERSION, findForbiddenCentralField,
  validateCentralSyncEvent, type CentralAckRequest, type CentralPushRequest, type CentralSyncEvent
} from '../../shared/centralSync.js'
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

function error(code: string, message: string, requestId: string) {
  return { ok: false as const, code, message, requestId }
}

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
    const err = error_ as Error & { code?: string }
    request.log.error({ err: { message: err.message, stack: err.stack, code: err.code } }, 'request failed')
    const validation = typeof err === 'object' && err !== null && 'validation' in err && Boolean((err as { validation?: unknown }).validation)
    void reply.code(validation ? 400 : 500).send(error(validation ? 'E101' : 'E500', validation ? '请求参数不合法' : '中央服务内部错误', request.id))
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
      const created = await store.createInvite({ ...body, workspaceId, expiresAt }, secretHash(inviteCode))
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
        params: { type: 'object', required: ['deviceId'], properties: { deviceId: { type: 'string', minLength: 1, maxLength: 100 } } },
        body: { type: 'object', additionalProperties: false, properties: { workspaceId: { type: 'string', format: 'uuid' } } }
      }
    }, async (request, reply) => {
      const { deviceId } = request.params as { deviceId: string }
      const workspaceId = request.principal!.workspaceId || String((request.body as { workspaceId?: string } | undefined)?.workspaceId || '')
      // 无工作区上下文的 bootstrap-admin 必须显式指定目标工作区，否则越权吊销无法追责
      if (!workspaceId) return reply.code(400).send(error('E101', 'bootstrap-admin 吊销设备时必须指定 workspaceId', request.id))
      const revoked = await store.revokeDevice(workspaceId, deviceId, request.principal!.displayName)
      return { ok: true, data: { revoked } }
    })

    api.post('/sync/push', {
      preHandler: require_('sync.push'),
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
      preHandler: require_('sync.pull'),
      schema: { querystring: { type: 'object', additionalProperties: false, properties: {
        cursor: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 }
      } } }
    }, async (request) => {
      const query = request.query as { cursor?: number; limit?: number }
      return { ok: true, data: await store.pullEvents(request.principal!, Number(query.cursor || 0), Number(query.limit || 100)) }
    })

    api.post('/sync/ack', {
      preHandler: require_('sync.ack'),
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
      preHandler: require_('command.issue'),
      schema: { body: syncEventSchema }
    }, async (request, reply) => {
      const event = request.body as CentralSyncEvent
      const validation = validateCentralSyncEvent(event) || findForbiddenCentralField(event.payload)
      if (validation) return reply.code(400).send(error('E102', `下行事件不合法：${validation}`, request.id))
      if (!event.targetDeviceId && !event.targetEmployeeId) return reply.code(400).send(error('E101', '下行指令必须指定员工或设备', request.id))
      // 工作区隔离：只能向本工作区内的员工/设备下发指令
      if (request.principal!.workspaceId) {
        const inScope = await store.isTargetInWorkspace(request.principal!.workspaceId, event.targetDeviceId, event.targetEmployeeId)
        if (!inScope) return reply.code(403).send(error('E403', '目标员工或设备不在当前工作区', request.id))
      }
      return reply.code(201).send({ ok: true, data: await store.appendDownEvent(request.principal!, { ...event, direction: 'down' }) })
    })
  }, { prefix: '/api/v1' })

  return app
}
