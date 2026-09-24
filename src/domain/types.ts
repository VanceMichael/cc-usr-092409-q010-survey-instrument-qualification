// 领域行类型：与 migrations/002 的表一一对应。

export interface DeviceRow {
  id: string;
  serial_number: string;
  kind: string;
  model: string | null;
  accuracy_class: string;
  calibration_required: number;
  status: string;
  custodian: string;
  handoff_seq: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CombinationRow {
  id: string;
  code: string;
  name: string | null;
  accuracy_class: string;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CombinationItemRow {
  combination_id: string;
  device_id: string;
  role: string;
}

export interface CertificateRow {
  id: string;
  certificate_no: string;
  device_id: string;
  issued_at: string;
  valid_from: string;
  valid_until: string;
  accuracy_class: string;
  status: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MaintenanceRow {
  id: string;
  device_id: string;
  opened_at: string;
  closed_at: string | null;
  conclusion: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface LeaseRow {
  id: string;
  code: string;
  crew: string;
  work_area: string;
  required_accuracy: string | null;
  purpose: string;
  starts_at: string;
  ends_at: string;
  status: string;
  applicant: string;
  pickup_person: string | null;
  custodian: string | null;
  lent_at: string | null;
  returned_at: string | null;
  return_confirmer: string | null;
  overdue: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ObservationRow {
  id: string;
  packet_id: string;
  observed_at: string;
  crew: string;
  work_area: string;
  required_accuracy: string | null;
  combination_id: string | null;
  summary: string | null;
  sequence_no: string | null;
  easting: number | null;
  northing: number | null;
  elevation: number | null;
  complete: number;
  status: string;
  decision: string;
  failure_reasons: string;
  qualification_snapshot: string | null;
  rule_trace: string | null;
  current_trace: string | null;
  review_disposition: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  baseline_id: string | null;
  signed_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ObservationDeviceRow {
  observation_id: string;
  device_id: string;
  role: string;
}

export interface BaselineRow {
  id: string;
  code: string;
  name: string | null;
  component_mapping: string;
  status: string;
  signed_at: string | null;
  signer: string | null;
  created_at: string;
  updated_at: string;
}

export interface BaselineRiskRow {
  id: string;
  baseline_id: string;
  source: string;
  ref_id: string;
  observation_id: string;
  summary: string;
  detail: string;
  acknowledged: number;
  created_at: string;
}

export interface HandoffRow {
  id: string;
  device_id: string;
  sequence_no: number;
  seal_code: string;
  direction: string;
  from_party: string;
  to_party: string;
  lease_id: string | null;
  note: string | null;
  status: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
}

export interface DueTaskRow {
  id: string;
  type: string;
  ref_type: string;
  ref_id: string;
  due_at: string;
  status: string;
  payload: string;
  attempts: number;
  last_error: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainEventRow {
  id: string;
  at: string;
  type: string;
  subject_type: string;
  subject_id: string;
  detail: string;
}
