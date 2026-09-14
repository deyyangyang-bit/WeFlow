-- 002_central_projections.sql —— 用「数据宪法登记的显式中央投影表」替换通用 JSONB 数据桶。
--
-- 背景：001_initial.sql 里的 central_record 是一个 (workspace_id, entity_type, entity_id, payload JSONB)
-- 的通用桶。它无法约束任何业务字段，等于在中央侧凭空造出第二套模糊业务语义，违反 SSOT 与
-- 「禁止用无法约束的数据桶冒充业务模型」。本迁移改用每类实体一张显式表：列名、类型、唯一键、
-- 版本号、软删标记、更新时间、工作区隔离全部落到 DDL 上。
--
-- 前向迁移（forward-only）：central_record 在 Phase 3a 业务服务上线前从未被真实写入，
-- 因此直接 DROP，不做数据搬迁。
--
-- 时间列口径：投影中的业务时间列统一为**本机 epoch 毫秒（BIGINT）**，与 CentralSyncEvent 信封一致，
-- 避免中央侧对同一时刻做二次时区解释；表自身的 created_at/updated_at 用 TIMESTAMPTZ（中央侧时钟）。
--
-- 聊天正文 / 消息正文 / session_id / WCDB 路径 / 原始聊天数据在本文件的任何列里都不存在。
-- 本机 customer_judgment.session_id 不落中央：判断行只通过 customer_ref 关联到 canonical 客户。

DROP TABLE IF EXISTS central_record;

-- ── 客户（数据宪法 customer）────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS central_customer (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  customer_ref TEXT,
  display_name TEXT NOT NULL,
  stage TEXT,
  customer_type TEXT CHECK (customer_type IS NULL OR customer_type IN ('dealer', 'end_user')),
  owner_sales TEXT,
  source TEXT,
  updated_by TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_central_customer_owner ON central_customer(workspace_id, owner_sales) WHERE deleted = false;
CREATE INDEX IF NOT EXISTS idx_central_customer_stage ON central_customer(workspace_id, stage) WHERE deleted = false;

-- ── 客户身份（数据宪法 customer_identity）──────────────────────────────────
-- identity_hash = 归一化后身份值的不可逆哈希；identity_masked 只留展示用掩码。
-- 手机号 / 微信号原文不出本机（PRD §10 R4 上行脱敏清单）。
CREATE TABLE IF NOT EXISTS central_customer_identity (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  customer_ref TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  identity_masked TEXT,
  confidence NUMERIC,
  source TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id),
  -- 同一工作区内同一身份值只能指向一个客户：跨号归并的唯一性由中央侧强制
  UNIQUE (workspace_id, identity_type, identity_hash)
);
CREATE INDEX IF NOT EXISTS idx_central_identity_customer ON central_customer_identity(workspace_id, customer_ref);

-- ── 分配（数据宪法 assignment；线索归属真源）────────────────────────────────
CREATE TABLE IF NOT EXISTS central_assignment (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  customer_ref TEXT NOT NULL,
  lead_ref TEXT,
  sales_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('assigned', 'claimed', 'recycled', 'transferred')),
  mode TEXT,
  sla1_deadline BIGINT,
  sla2_deadline BIGINT,
  assigned_at BIGINT,
  updated_by TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_central_assignment_sales ON central_assignment(workspace_id, sales_name, status) WHERE deleted = false;
CREATE INDEX IF NOT EXISTS idx_central_assignment_customer ON central_assignment(workspace_id, customer_ref);

-- ── 归属（数据宪法 ownership = account.owner_sales 列语义，不建本机表）──────
CREATE TABLE IF NOT EXISTS central_ownership (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  customer_ref TEXT NOT NULL,
  owner_sales TEXT NOT NULL,
  reason TEXT,
  effective_from BIGINT,
  updated_by TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_central_ownership_owner ON central_ownership(workspace_id, owner_sales) WHERE deleted = false;

-- ── 商机（数据宪法 opportunity；成交额/型号/数量/交期字段级规格见 PRD §5.1）──
CREATE TABLE IF NOT EXISTS central_opportunity (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  customer_ref TEXT NOT NULL,
  name TEXT,
  stage TEXT NOT NULL,
  status TEXT,
  opp_type TEXT CHECK (opp_type IS NULL OR opp_type IN ('vehicle', 'retrofit')),
  amount_cny NUMERIC(14, 2),
  original_currency TEXT,
  original_amount NUMERIC(14, 2),
  order_qty INTEGER,
  shipped_qty INTEGER,
  expected_ship_start BIGINT,
  expected_ship_end BIGINT,
  delivery_date BIGINT,
  updated_by TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_central_opportunity_stage ON central_opportunity(workspace_id, stage) WHERE deleted = false;

-- ── 报价（数据宪法 quote = 本机物理表 quotation；append-only 一单一版）──────
CREATE TABLE IF NOT EXISTS central_quote (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  customer_ref TEXT,
  opportunity_ref TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  amount_cny NUMERIC(14, 2),
  currency TEXT,
  effective_from BIGINT,
  effective_to BIGINT,
  doc_hash TEXT,
  updated_by TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id),
  UNIQUE (workspace_id, opportunity_ref, version_no)
);

-- ── 上行审计投影（本机 audit_event 的只读副本）─────────────────────────────
-- 与 central_audit_event（中央自身操作审计）职责分离：本表只由设备上行写入，
-- central_audit_event 只由中央服务端动作写入，两者互不冒充。
CREATE TABLE IF NOT EXISTS central_audit_projection (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  source_audit_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  detail_masked TEXT,
  occurred_at BIGINT,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id),
  -- 同设备同审计行只落一次：断网重放不产生重复审计
  UNIQUE (workspace_id, source_device_id, source_audit_id)
);
CREATE INDEX IF NOT EXISTS idx_central_audit_projection_actor ON central_audit_projection(workspace_id, actor, occurred_at);
CREATE INDEX IF NOT EXISTS idx_central_audit_projection_action ON central_audit_projection(workspace_id, action);

-- ── AI 客户判断（数据宪法 customer_judgment；双存档的中央副本）──────────────
-- 沿用判断类型 / 证据锚点 / 版本，不另造 evidence ID 体系。
-- evidence_text（客户原话）不上行，只保留 messageKey 锚点与其证据状态。
CREATE TABLE IF NOT EXISTS central_customer_judgment (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  customer_ref TEXT NOT NULL,
  judgment_type TEXT NOT NULL CHECK (judgment_type IN ('summary', 'opportunity', 'risk', 'next_action')),
  value TEXT NOT NULL,
  confidence NUMERIC,
  source TEXT,
  model TEXT,
  generated_at BIGINT,
  evidence_key TEXT,
  evidence_status TEXT CHECK (evidence_status IS NULL OR evidence_status IN ('available', 'unavailable', 'unparseable')),
  deleted BOOLEAN NOT NULL DEFAULT false,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_central_judgment_customer ON central_customer_judgment(workspace_id, customer_ref, judgment_type);

-- ── 知识提案 / 治理态（数据宪法 knowledge_base 治理列 + 提案列）────────────
-- status 与 authority 沿用本机治理枚举；AI 无 publish 权在中央侧同样成立。
CREATE TABLE IF NOT EXISTS central_knowledge_proposal (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  category TEXT,
  product_line TEXT,
  scene TEXT,
  authority TEXT CHECK (authority IS NULL OR authority IN ('official', 'community')),
  version_no INTEGER,
  status TEXT NOT NULL CHECK (status IN ('staging', 'published', 'rejected', 'closed')),
  source TEXT,
  evidence_key TEXT,
  ttl_date TEXT,
  reviewed_by TEXT,
  reviewed_at BIGINT,
  deleted BOOLEAN NOT NULL DEFAULT false,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_central_knowledge_status ON central_knowledge_proposal(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_central_knowledge_logical ON central_knowledge_proposal(workspace_id, logical_id, version_no);

-- ── 权限声明（仅署名与展示）────────────────────────────────────────────────
-- declared_role 来自本机身份档案（需求 1.2a 自我声明），authority_source 固定标记其来源。
-- ⛔ 铁律：本表**永不**作为访问控制依据；服务端权限只由 employee.role + device 绑定决定。
CREATE TABLE IF NOT EXISTS central_permission (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  employee_ref TEXT NOT NULL,
  declared_role TEXT NOT NULL CHECK (declared_role IN ('sales', 'supervisor', 'allocator')),
  authority_source TEXT NOT NULL DEFAULT 'local_declaration' CHECK (authority_source = 'local_declaration'),
  display_name TEXT,
  revoked_at BIGINT,
  deleted BOOLEAN NOT NULL DEFAULT false,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id)
);

-- ── 重试计数（复用既有 sync_ack，不另建第二套 ACK 语义）───────────────────
-- 需要计数才能实现「有限重试」：达到上限后客户端必须给出显式 invalid 终态，
-- 否则队列会被一条永远无法执行的指令永久卡住（PRD「不能无限 retry」）。
ALTER TABLE sync_ack ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);
