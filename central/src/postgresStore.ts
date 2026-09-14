import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import type { CentralAckRequest, CentralPullResult, CentralSyncEvent } from '../../shared/centralSync.js'
import { buildProjectionUpsert, projectionOf, validateProjectionPayload } from './projections.js'
import type { CentralStore, DevicePrincipal, InviteInput, PushResult } from './store.js'

type DbRow = Record<string, unknown>

export class PostgresCentralStore implements CentralStore {
  private readonly pool: Pool

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 })
  }

  async migrate(): Promise<void> {
    const dir = resolve(process.env.WEFLOW_CENTRAL_MIGRATIONS_DIR || 'migrations')
    const files = (await readdir(dir)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE TABLE IF NOT EXISTS schema_migration (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())')
      for (const file of files) {
        const exists = await client.query('SELECT 1 FROM schema_migration WHERE version=$1', [file])
        if (exists.rowCount) continue
        await client.query(await readFile(resolve(dir, file), 'utf8'))
        await client.query('INSERT INTO schema_migration(version) VALUES($1)', [file])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async ping(): Promise<void> { await this.pool.query('SELECT 1') }
  async close(): Promise<void> { await this.pool.end() }

  async createInvite(input: InviteInput, codeHash: string): Promise<{ inviteId: string }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO workspace(id,name) VALUES($1,$2)
         ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name`,
        [input.workspaceId, 'WeFlow Workspace']
      )
      const employee = await client.query(
        `INSERT INTO employee(workspace_id,employee_code,display_name,role)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(workspace_id,employee_code) DO UPDATE
           SET display_name=EXCLUDED.display_name, role=EXCLUDED.role, updated_at=now()
         RETURNING id`,
        [input.workspaceId, input.employeeCode, input.displayName, input.role]
      )
      const invite = await client.query(
        `INSERT INTO binding_invite(workspace_id,employee_id,code_hash,expires_at)
         VALUES($1,$2,$3,to_timestamp($4 / 1000.0)) RETURNING id`,
        [input.workspaceId, employee.rows[0].id, codeHash, input.expiresAt]
      )
      await client.query('COMMIT')
      return { inviteId: String(invite.rows[0].id) }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async claimInvite(codeHash: string, deviceName: string, tokenHash: string): Promise<DevicePrincipal> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const invite = await client.query(
        `SELECT i.id,i.workspace_id,i.employee_id,e.display_name,e.role
         FROM binding_invite i JOIN employee e ON e.id=i.employee_id
         WHERE i.code_hash=$1 AND i.used_at IS NULL AND i.expires_at>now() AND e.status='active'
         FOR UPDATE`, [codeHash]
      )
      if (!invite.rowCount) throw new Error('INVITE_INVALID')
      const row = invite.rows[0]
      const device = await client.query(
        `INSERT INTO device(workspace_id,employee_id,device_name,token_hash,last_seen_at)
         VALUES($1,$2,$3,$4,now()) RETURNING id`,
        [row.workspace_id, row.employee_id, deviceName, tokenHash]
      )
      await client.query('UPDATE binding_invite SET used_at=now() WHERE id=$1', [row.id])
      await client.query('COMMIT')
      return {
        workspaceId: String(row.workspace_id), employeeId: String(row.employee_id),
        deviceId: String(device.rows[0].id), displayName: String(row.display_name), role: row.role
      } as DevicePrincipal
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async authenticate(tokenHash: string): Promise<DevicePrincipal | null> {
    const result = await this.pool.query(
      `UPDATE device d SET last_seen_at=now(),updated_at=now()
       FROM employee e,workspace w
       WHERE d.token_hash=$1 AND d.status='active' AND e.id=d.employee_id AND e.status='active'
         AND w.id=d.workspace_id AND w.status='active'
       RETURNING d.workspace_id,d.employee_id,d.id AS device_id,e.display_name,e.role`, [tokenHash]
    )
    if (!result.rowCount) return null
    const row = result.rows[0]
    return {
      workspaceId: String(row.workspace_id), employeeId: String(row.employee_id), deviceId: String(row.device_id),
      displayName: String(row.display_name), role: row.role
    } as DevicePrincipal
  }

  async rotateDeviceToken(principal: DevicePrincipal, tokenHash: string): Promise<void> {
    await this.pool.query('UPDATE device SET token_hash=$1,updated_at=now() WHERE id=$2 AND status=\'active\'', [tokenHash, principal.deviceId])
  }

  async revokeDevice(workspaceId: string, deviceId: string, actor: string): Promise<boolean> {
    // workspaceId 为空 = 中央 bootstrap-admin（跨工作区）；否则严格限定在本工作区内
    const scope = workspaceId ? ' AND workspace_id=$3' : ''
    const params: unknown[] = workspaceId ? [deviceId, actor, workspaceId] : [deviceId, actor]
    return this.revokeAndAudit(
      `WITH changed AS (
         UPDATE device SET status='revoked',updated_at=now() WHERE id=$1 AND status='active'${scope} RETURNING workspace_id,id
       )
       INSERT INTO central_audit_event(workspace_id,actor,action,entity_type,entity_id)
       SELECT workspace_id,$2,'device_revoke','device',id::text FROM changed RETURNING id`, params)
  }

  async revokeSelf(principal: DevicePrincipal): Promise<boolean> {
    return this.revokeAndAudit(
      `WITH changed AS (
         UPDATE device SET status='revoked',updated_at=now()
         WHERE id=$1 AND workspace_id=$3 AND status='active' RETURNING workspace_id,id
       )
       INSERT INTO central_audit_event(workspace_id,actor,action,entity_type,entity_id)
       SELECT workspace_id,$2,'device_revoke_self','device',id::text FROM changed RETURNING id`, [principal.deviceId, principal.displayName, principal.workspaceId])
  }

  private async revokeAndAudit(sql: string, params: unknown[]): Promise<boolean> {
    const result = await this.pool.query(sql, params)
    return Boolean(result.rowCount)
  }

  async pushEvents(principal: DevicePrincipal, events: CentralSyncEvent[]): Promise<PushResult> {
    const client = await this.pool.connect()
    const accepted: PushResult['accepted'] = []
    const rejected: PushResult['rejected'] = []
    try {
      await client.query('BEGIN')
      for (const [index, event] of events.entries()) {
        // 每条事件一个 SAVEPOINT：任何一条语句失败只回滚该事件，绝不作废同批其它有效事件。
        // PostgreSQL 里语句出错会让整个事务进入 aborted 状态，没有 SAVEPOINT 就没有真正的事件级隔离。
        const savepoint = `event_${index}`
        await client.query(`SAVEPOINT ${savepoint}`)
        try {
          const result = await this.insertEvent(client, principal, event)
          if (!result.duplicate) await this.applyProjection(client, principal, event)
          await client.query(`RELEASE SAVEPOINT ${savepoint}`)
          accepted.push({ eventId: event.eventId, ...result })
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          await client.query(`RELEASE SAVEPOINT ${savepoint}`)
          rejected.push({ eventId: event.eventId, code: 'event_rejected', message: describePushError(error) })
        }
      }
      await client.query('COMMIT')
      return { accepted, rejected }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  /** 把事件写进数据宪法登记的显式投影表；缺注册项/缺必填字段/命中禁字段一律拒收该事件。 */
  private async applyProjection(client: PoolClient, principal: DevicePrincipal, event: CentralSyncEvent): Promise<void> {
    const projection = projectionOf(event.entityType)
    const invalid = validateProjectionPayload(projection, event.payload)
    if (invalid) throw new Error(invalid)
    const statement = buildProjectionUpsert(projection, principal.workspaceId, principal.deviceId, event)
    await client.query(statement.sql, statement.values)
  }

  private async insertEvent(client: PoolClient, principal: DevicePrincipal, event: CentralSyncEvent): Promise<{ centralSeq: number; duplicate: boolean }> {
    const inserted = await client.query(
      `INSERT INTO sync_event(workspace_id,event_id,event_seq,idempotency_key,source_device_id,direction,
        entity_type,entity_id,event_type,aggregate_version,payload,evidence_key,target_employee_id,target_device_id,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_timestamp($15 / 1000.0))
       ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING central_seq`,
      [principal.workspaceId, event.eventId, event.eventSeq, event.idempotencyKey, principal.deviceId, event.direction,
        event.entityType, event.entityId, event.eventType, event.aggregateVersion, event.payload, event.evidenceKey || null,
        event.targetEmployeeId || null, event.targetDeviceId || null, event.occurredAt]
    )
    if (inserted.rowCount) return { centralSeq: Number(inserted.rows[0].central_seq), duplicate: false }
    const existing = await client.query(
      'SELECT central_seq,event_id FROM sync_event WHERE workspace_id=$1 AND idempotency_key=$2',
      [principal.workspaceId, event.idempotencyKey]
    )
    if (!existing.rowCount || String(existing.rows[0].event_id) !== event.eventId) throw new Error('idempotency_key_conflict')
    return { centralSeq: Number(existing.rows[0].central_seq), duplicate: true }
  }

  async pullEvents(principal: DevicePrincipal, cursor: number, limit: number): Promise<CentralPullResult> {
    const result = await this.pool.query(
      `SELECT * FROM sync_event WHERE workspace_id=$1 AND direction='down' AND central_seq>$2
       AND (target_device_id IS NULL OR target_device_id=$3)
       AND (target_employee_id IS NULL OR target_employee_id=$4)
       AND NOT EXISTS (
         SELECT 1 FROM sync_ack a WHERE a.device_id=$3 AND a.central_seq=sync_event.central_seq AND a.outcome<>'retry'
       )
       ORDER BY central_seq LIMIT $5`,
      [principal.workspaceId, cursor, principal.deviceId, principal.employeeId, limit + 1]
    )
    const hasMore = result.rows.length > limit
    const rows = result.rows.slice(0, limit)
    const events = rows.map((row: DbRow) => this.rowToEvent(row))
    return { events, nextCursor: events.at(-1)?.centralSeq ?? cursor, hasMore }
  }

  private rowToEvent(row: DbRow): CentralSyncEvent & { centralSeq: number } {
    return {
      protocolVersion: 1, centralSeq: Number(row.central_seq), eventId: String(row.event_id),
      eventSeq: Number(row.event_seq), idempotencyKey: String(row.idempotency_key), direction: row.direction as 'up' | 'down',
      entityType: row.entity_type as CentralSyncEvent['entityType'], entityId: String(row.entity_id),
      eventType: String(row.event_type), aggregateVersion: Number(row.aggregate_version),
      payload: row.payload as Record<string, unknown>, evidenceKey: row.evidence_key ? String(row.evidence_key) : undefined,
      targetEmployeeId: row.target_employee_id ? String(row.target_employee_id) : undefined,
      targetDeviceId: row.target_device_id ? String(row.target_device_id) : undefined,
      occurredAt: new Date(String(row.occurred_at)).getTime()
    }
  }

  async ackEvents(principal: DevicePrincipal, acknowledgements: CentralAckRequest['acknowledgements']): Promise<number> {
    let count = 0
    for (const ack of acknowledgements) {
      const result = await this.pool.query(
        `INSERT INTO sync_ack(device_id,central_seq,event_id,outcome,local_version,detail)
         SELECT $1,e.central_seq,$3,$4,$5,$6 FROM sync_event e
         WHERE e.central_seq=$2 AND e.event_id=$3 AND e.workspace_id=$7 AND e.direction='down'
         ON CONFLICT(device_id,central_seq) DO UPDATE
           SET outcome=EXCLUDED.outcome,local_version=EXCLUDED.local_version,detail=EXCLUDED.detail,
               attempts=CASE WHEN EXCLUDED.outcome='retry' THEN sync_ack.attempts+1 ELSE sync_ack.attempts END,
               acknowledged_at=now()
         RETURNING central_seq`,
        [principal.deviceId, ack.centralSeq, ack.eventId, ack.outcome, ack.localVersion ?? null,
          String(ack.detail || '').slice(0, 500) || null, principal.workspaceId]
      )
      count += result.rowCount || 0
    }
    return count
  }

  async isTargetInWorkspace(workspaceId: string, targetDeviceId?: string, targetEmployeeId?: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT
         (NOT $2::text IS NULL AND EXISTS (SELECT 1 FROM device WHERE id=$2::uuid AND workspace_id=$1)) AS device_ok,
         (NOT $3::text IS NULL AND EXISTS (SELECT 1 FROM employee WHERE id=$3::uuid AND workspace_id=$1)) AS employee_ok`,
      [workspaceId, targetDeviceId || null, targetEmployeeId || null]
    )
    const row = result.rows[0] as { device_ok: boolean; employee_ok: boolean } | undefined
    if (!row) return false
    // 指定了哪一侧就校验哪一侧；两侧都没指定的话路由层已拒绝
    if (targetDeviceId && !row.device_ok) return false
    if (targetEmployeeId && !row.employee_ok) return false
    return true
  }

  async recordPolicyViolation(principal: DevicePrincipal, event: CentralSyncEvent, fieldPath: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO central_audit_event(workspace_id,actor,action,entity_type,entity_id,detail)
       VALUES($1,$2,'sync_forbidden_field',$3,$4,$5::jsonb)`,
      [principal.workspaceId, `device:${principal.deviceId}`, event.entityType, event.eventId,
        JSON.stringify({ eventId: event.eventId, eventType: event.eventType, fieldPath })]
    )
  }

  async appendDownEvent(actor: DevicePrincipal, event: CentralSyncEvent): Promise<{ centralSeq: number; duplicate: boolean }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await this.insertEvent(client, actor, { ...event, direction: 'down' })
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}

/** 拒绝原因只回传稳定短码 + 截断信息，避免把 SQL/参数原文透给客户端或日志。 */
function describePushError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/^(unregistered_entity_type|forbidden_field|missing_required):/.test(message)) return message
  if (message === 'idempotency_key_conflict') return message
  const code = (error as { code?: string } | null)?.code
  return code ? `projection_rejected:${code}` : 'projection_rejected'
}
