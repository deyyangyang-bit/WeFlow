-- 003_duplicate_group.sql —— 撞客方案一期：重复组中央投影表（宪法 §3.1 duplicate_group 登记行）。
--
-- 背景：身份锚点闸门（§二.4）拒收「同一 identity_type+identity_hash 指向第二个客户」的上行
-- customer_identity 事件，并留 sync_entity_conflict 审计；但审计只有定位元数据，各端无从得知
-- 「自己的客户和谁的客户撞了」。本表把已发生的客观冲突事实显式登记为重复组，随 /sync/pull
-- 广播下发（shared/centralSync.DOWN_PROJECTION_ENTITY_TYPES 白名单第一员）。
--
-- 隐私边界（PRD §10 R4 / 宪法 §2.1）：列里只有身份哈希（不可逆）+ 展示掩码 + 双方客户引用
-- （设备命名空间 ref）+ 各自归属销售姓名。聊天正文 / 消息正文 / session_id / WCDB 路径 /
-- 对方资料明细（昵称、头像、消息）在本表任何列里都不存在。
--
-- 表形态与其他投影表同构（migration-test B2/B3/B4）：(workspace_id, entity_id) 主键 + 版本号 +
-- 来源设备 + 软删列；entity_id = 重复组业务键 `dupgroup:<anchor_type>:<anchor_hash>`；
-- (workspace_id, anchor_type, anchor_hash) 唯一索引承载 upsert 幂等。
-- 本表由中央自产（设备永不上行 duplicate_group 实体）；写者 = postgresStore 身份锚点冲突分支单点。

CREATE TABLE IF NOT EXISTS central_duplicate_group (
  workspace_id UUID NOT NULL REFERENCES workspace(id),
  entity_id TEXT NOT NULL,
  anchor_type TEXT NOT NULL CHECK (anchor_type IN ('phone', 'wechat')),
  anchor_hash TEXT NOT NULL,
  anchor_masked TEXT,
  members_json TEXT NOT NULL DEFAULT '[]',
  member_count INTEGER NOT NULL DEFAULT 2 CHECK (member_count >= 2),
  registered_by UUID REFERENCES device(id),
  deleted BOOLEAN NOT NULL DEFAULT false,
  aggregate_version BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  source_device_id UUID REFERENCES device(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_central_dup_group_anchor ON central_duplicate_group(workspace_id, anchor_type, anchor_hash);
