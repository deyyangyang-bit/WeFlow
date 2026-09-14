CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migration (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employee (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  employee_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('sales', 'supervisor', 'allocator', 'admin', 'service')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'departed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, employee_code)
);

CREATE TABLE IF NOT EXISTS binding_invite (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  employee_id UUID NOT NULL REFERENCES employee(id),
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  employee_id UUID NOT NULL REFERENCES employee(id),
  device_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_event (
  central_seq BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  event_id TEXT NOT NULL,
  event_seq BIGINT NOT NULL CHECK (event_seq > 0),
  idempotency_key TEXT NOT NULL,
  source_device_id UUID REFERENCES device(id),
  direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_version BIGINT NOT NULL CHECK (aggregate_version >= 0),
  payload JSONB NOT NULL,
  evidence_key TEXT,
  target_employee_id UUID REFERENCES employee(id),
  target_device_id UUID REFERENCES device(id),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, event_id),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sync_event_pull
  ON sync_event(workspace_id, direction, central_seq);
CREATE INDEX IF NOT EXISTS idx_sync_event_target_employee
  ON sync_event(workspace_id, target_employee_id, central_seq);

CREATE TABLE IF NOT EXISTS sync_ack (
  device_id UUID NOT NULL REFERENCES device(id),
  central_seq BIGINT NOT NULL REFERENCES sync_event(central_seq),
  event_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'conflict', 'invalid', 'retry')),
  local_version BIGINT,
  detail TEXT,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, central_seq)
);

CREATE TABLE IF NOT EXISTS central_audit_event (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 中央事实副本保持与本机对象一一对应；payload 只承载宪法允许上行的结构化字段，聊天原文禁止进入。
CREATE TABLE IF NOT EXISTS central_record (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'customer', 'customer_identity', 'assignment', 'ownership', 'opportunity', 'quote',
    'customer_judgment', 'knowledge_proposal', 'permission'
  )),
  entity_id TEXT NOT NULL,
  aggregate_version BIGINT NOT NULL CHECK (aggregate_version >= 0),
  payload JSONB NOT NULL,
  source_device_id UUID REFERENCES device(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_type, entity_id)
);
