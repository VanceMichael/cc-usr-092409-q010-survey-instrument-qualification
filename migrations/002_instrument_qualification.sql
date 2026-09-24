-- 仪器资格与借用链: 设备登记、组件组合、校准证书、维修状态、借用租约、
-- 观测资格快照、基线签署与风险、离线交接封签、可恢复任务。

CREATE TABLE IF NOT EXISTS instruments (
  id TEXT PRIMARY KEY,
  serial_no TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  custodian TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS component_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS component_set_members (
  set_id TEXT NOT NULL REFERENCES component_sets(id),
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  PRIMARY KEY (set_id, instrument_id)
);

CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  cert_no TEXT NOT NULL UNIQUE,
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  precision_class TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid',
  revoked_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance_records (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  conclusion TEXT,
  conclusion_ok INTEGER,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  crew TEXT NOT NULL,
  borrower TEXT NOT NULL,
  zone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'requested',
  lent_confirmed_by TEXT,
  lent_at TEXT,
  returned_confirmed_by TEXT,
  returned_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_leases_instrument_window ON leases(instrument_id, window_start, window_end);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  component_set_id TEXT,
  observed_at TEXT NOT NULL,
  zone TEXT NOT NULL,
  required_precision TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_reasons TEXT NOT NULL DEFAULT '[]',
  instrument_version INTEGER NOT NULL,
  certificate_id TEXT,
  certificate_version INTEGER,
  lease_id TEXT,
  lease_version INTEGER,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  adjudicated_at TEXT,
  adjudicated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_observations_instrument ON observations(instrument_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_observations_certificate ON observations(certificate_id);

CREATE TABLE IF NOT EXISTS observation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id TEXT NOT NULL REFERENCES observations(id),
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS baselines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  signed_at TEXT,
  signed_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS baseline_members (
  baseline_id TEXT NOT NULL REFERENCES baselines(id),
  observation_id TEXT NOT NULL REFERENCES observations(id),
  qualification_snapshot TEXT NOT NULL,
  PRIMARY KEY (baseline_id, observation_id)
);

CREATE TABLE IF NOT EXISTS baseline_risks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  baseline_id TEXT NOT NULL REFERENCES baselines(id),
  observation_id TEXT,
  risk TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS handovers (
  id TEXT PRIMARY KEY,
  seal_no TEXT NOT NULL UNIQUE,
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  confirmed_by TEXT NOT NULL,
  ledger_note TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  done_at TEXT
);
