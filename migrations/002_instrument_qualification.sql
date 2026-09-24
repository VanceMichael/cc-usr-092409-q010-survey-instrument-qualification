-- 仪器资格与借用链领域
-- 所有时间均为 UTC ISO8601 字符串，可直接按字典序比较。

-- 设备登记 ----------------------------------------------------------
CREATE TABLE devices (
  id                   TEXT PRIMARY KEY,
  serial_number        TEXT NOT NULL UNIQUE,           -- 序列号
  kind                 TEXT NOT NULL,                  -- total_station | prism | ...
  model                TEXT,
  accuracy_class       TEXT NOT NULL,                  -- 适用精度，如 2.0mm
  calibration_required INTEGER NOT NULL DEFAULT 1,     -- 是否需要校准证书
  status               TEXT NOT NULL DEFAULT 'active', -- active | maintenance | retired
  custodian            TEXT NOT NULL,                  -- 当前保管人
  handoff_seq          INTEGER NOT NULL DEFAULT 0,     -- 设备流水（按设备单调递增）
  version              INTEGER NOT NULL DEFAULT 1,     -- 资格版本，导入观测时冻结
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- 组件组合 ----------------------------------------------------------
CREATE TABLE combinations (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT,
  accuracy_class TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',       -- active | retired
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE combination_items (
  combination_id TEXT NOT NULL REFERENCES combinations(id),
  device_id      TEXT NOT NULL REFERENCES devices(id),
  role           TEXT NOT NULL,                        -- station | prism | ...
  PRIMARY KEY (combination_id, role),
  UNIQUE (combination_id, device_id)
);

-- 校准证书 ----------------------------------------------------------
CREATE TABLE calibration_certificates (
  id             TEXT PRIMARY KEY,
  certificate_no TEXT NOT NULL UNIQUE,
  device_id      TEXT NOT NULL REFERENCES devices(id),
  issued_at      TEXT NOT NULL,
  valid_from     TEXT NOT NULL,
  valid_until    TEXT NOT NULL,
  accuracy_class TEXT NOT NULL,                        -- 证书承诺的适用精度
  status         TEXT NOT NULL DEFAULT 'valid',        -- valid | expired | revoked
  revoked_at     TEXT,
  revoke_reason  TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_cert_device ON calibration_certificates(device_id, status);

-- 维修状态（开放期间设备锁定）---------------------------------------
CREATE TABLE maintenance_events (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id),
  opened_at    TEXT NOT NULL,
  closed_at    TEXT,
  conclusion   TEXT,
  status       TEXT NOT NULL DEFAULT 'open',           -- open | closed
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_maint_device ON maintenance_events(device_id, status);

-- 借用租约 ----------------------------------------------------------
CREATE TABLE leases (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  crew              TEXT NOT NULL,                     -- 班组
  work_area         TEXT NOT NULL,                     -- 工作区
  required_accuracy TEXT,
  purpose           TEXT NOT NULL,                     -- 用途
  starts_at         TEXT NOT NULL,                    -- 时间窗起（含）
  ends_at           TEXT NOT NULL,                    -- 时间窗止（不含）
  status            TEXT NOT NULL DEFAULT 'requested', -- requested | lent | returned | rejected | cancelled
  applicant         TEXT NOT NULL,                    -- 领用人（归还确认人）
  pickup_person     TEXT,
  custodian         TEXT,                             -- 出借确认的保管人
  lent_at           TEXT,
  returned_at       TEXT,
  return_confirmer  TEXT,
  overdue           INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE TABLE lease_items (
  lease_id  TEXT NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id),
  PRIMARY KEY (lease_id, device_id)
);
CREATE INDEX idx_lease_items_device ON lease_items(device_id);

-- 重叠租约原子拒绝：对同一设备，requested/lent 状态租约的半开时间窗
-- [starts_at, ends_at) 不得相交；边界相接允许。触发器在写入路径上拦截，
-- 配合 BEGIN IMMEDIATE，并发申请也只有一个事务能提交。
CREATE TRIGGER trg_lease_item_overlap_insert
BEFORE INSERT ON lease_items
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM lease_items li2
      JOIN leases l2 ON l2.id = li2.lease_id
      JOIN leases l1 ON l1.id = NEW.lease_id
     WHERE li2.device_id = NEW.device_id
       AND l2.id <> NEW.lease_id
       AND l1.status IN ('requested', 'lent')
       AND l2.status IN ('requested', 'lent')
       AND l2.starts_at < l1.ends_at
       AND l1.starts_at < l2.ends_at
  ) THEN RAISE(ABORT, 'OVERLAPPING_LEASE: device lease window conflicts') END;
END;

CREATE TRIGGER trg_lease_item_overlap_update
BEFORE UPDATE OF lease_id, device_id ON lease_items
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM lease_items li2
      JOIN leases l2 ON l2.id = li2.lease_id
      JOIN leases l1 ON l1.id = NEW.lease_id
     WHERE li2.device_id = NEW.device_id
       AND l2.id <> NEW.lease_id
       AND l1.status IN ('requested', 'lent')
       AND l2.status IN ('requested', 'lent')
       AND l2.starts_at < l1.ends_at
       AND l1.starts_at < l2.ends_at
  ) THEN RAISE(ABORT, 'OVERLAPPING_LEASE: device lease window conflicts') END;
END;

CREATE TRIGGER trg_lease_window_overlap_update
BEFORE UPDATE OF starts_at, ends_at, status ON leases
WHEN NEW.status IN ('requested', 'lent')
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM lease_items li1
      JOIN lease_items li2 ON li2.device_id = li1.device_id
      JOIN leases l2 ON l2.id = li2.lease_id
     WHERE li1.lease_id = NEW.id
       AND l2.id <> NEW.id
       AND l2.status IN ('requested', 'lent')
       AND l2.starts_at < NEW.ends_at
       AND NEW.starts_at < l2.ends_at
  ) THEN RAISE(ABORT, 'OVERLAPPING_LEASE: device lease window conflicts') END;
END;

-- 观测（原始采集包不可覆盖；导入即冻结资格快照）--------------------
CREATE TABLE observations (
  id                     TEXT PRIMARY KEY,
  packet_id              TEXT NOT NULL UNIQUE,
  observed_at            TEXT NOT NULL,
  crew                   TEXT NOT NULL,
  work_area              TEXT NOT NULL,
  required_accuracy      TEXT,
  combination_id         TEXT REFERENCES combinations(id),
  summary                TEXT,
  sequence_no            TEXT,
  easting                REAL,
  northing               REAL,
  elevation              REAL,
  complete               INTEGER NOT NULL,
  status                 TEXT NOT NULL,   -- candidate | review | quarantined
  decision               TEXT NOT NULL,   -- adopted | downgraded | isolated
  failure_reasons        TEXT NOT NULL DEFAULT '[]',
  qualification_snapshot TEXT,            -- 导入时冻结，永不更新
  rule_trace             TEXT,            -- 导入时冻结，永不更新
  current_trace          TEXT,            -- 最近一次重评结果（未签署观测）
  review_disposition     TEXT,            -- released | isolated
  reviewed_by            TEXT,
  reviewed_at            TEXT,
  review_note            TEXT,
  baseline_id            TEXT,
  signed_at              TEXT,
  version                INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX idx_obs_status ON observations(status);
CREATE INDEX idx_obs_baseline ON observations(baseline_id);

-- 观测实际使用的设备/角色（导入时冻结）
CREATE TABLE observation_devices (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  device_id      TEXT NOT NULL,
  role           TEXT NOT NULL,
  PRIMARY KEY (observation_id, role)
);
CREATE INDEX idx_obsdev_device ON observation_devices(device_id);

-- 基线版本与签署后的风险追加 ---------------------------------------
CREATE TABLE baselines (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT,
  component_mapping TEXT NOT NULL DEFAULT '{}', -- 构件对应关系，随版本发布
  status            TEXT NOT NULL DEFAULT 'draft', -- draft | signed
  signed_at         TEXT,
  signer            TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE TABLE baseline_items (
  baseline_id    TEXT NOT NULL REFERENCES baselines(id),
  observation_id TEXT NOT NULL REFERENCES observations(id),
  snapshot       TEXT NOT NULL,                    -- 签署时复制的资格快照
  PRIMARY KEY (baseline_id, observation_id)
);
CREATE TABLE baseline_risks (
  id             TEXT PRIMARY KEY,
  baseline_id    TEXT NOT NULL REFERENCES baselines(id),
  source         TEXT NOT NULL,                     -- certificate_revoked | maintenance_conclusion
  ref_id         TEXT NOT NULL,                     -- 证书/维修单 id
  observation_id TEXT NOT NULL,
  summary        TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '{}',
  acknowledged   INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  UNIQUE (baseline_id, source, ref_id, observation_id)
);
CREATE INDEX idx_baseline_risk ON baseline_risks(baseline_id);

-- 离线交接：按设备流水归位，封签一次性确认 --------------------------
CREATE TABLE device_handoffs (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id),
  sequence_no  INTEGER NOT NULL,                    -- 设备内单调流水
  seal_code    TEXT NOT NULL,                       -- 封签号
  direction    TEXT NOT NULL,                       -- outbound | inbound
  from_party   TEXT NOT NULL,
  to_party     TEXT NOT NULL,
  lease_id     TEXT REFERENCES leases(id),
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',     -- pending | confirmed
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (device_id, sequence_no),
  UNIQUE (seal_code)
);
CREATE INDEX idx_handoff_device ON device_handoffs(device_id, sequence_no);

-- 停服恢复任务：逾期归还 / 证书到期 / 复核，持久化、可认领、幂等 -----
CREATE TABLE due_tasks (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,                       -- overdue_return | certificate_expiry | review
  ref_type     TEXT NOT NULL,                       -- lease | certificate | observation
  ref_id       TEXT NOT NULL,
  due_at       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',     -- pending | claimed | done | cancelled
  payload      TEXT NOT NULL DEFAULT '{}',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  claimed_at   TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
-- 同一引用只允许一个活动任务，重建时幂等
CREATE UNIQUE INDEX idx_due_active
  ON due_tasks(type, ref_id)
  WHERE status IN ('pending', 'claimed');
CREATE INDEX idx_due_due ON due_tasks(status, due_at);

-- 统一领域事件流（审计与解释时间线）--------------------------------
CREATE TABLE domain_events (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  type         TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_subject ON domain_events(subject_type, subject_id, at);
