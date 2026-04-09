import { nextTestSequence } from '../builders';

export interface HcmBalancePayload {
  employeeId: string;
  locationId: string;
  availableUnits: number;
  sourceVersion: string;
  sourceUpdatedAt: string;
}

export interface HcmBalanceAdjustmentRequest {
  idempotencyKey: string;
  requestId: string;
  employeeId: string;
  locationId: string;
  deltaUnits: number;
  reasonCode: string;
  occurredAt: string;
}

export interface HcmBalanceAdjustmentAcceptedResponse extends HcmBalancePayload {
  accepted: true;
}

export interface HcmBalanceAdjustmentRejectedResponse {
  accepted: false;
  code: string;
  message: string;
}

export interface HcmBatchBalanceSnapshotRequest {
  runId: string;
  sentAt: string;
  records: HcmBalancePayload[];
}

export function buildHcmBalancePayload(
  overrides: Partial<HcmBalancePayload> = {},
): HcmBalancePayload {
  const sequence = nextTestSequence('hcm_balance_payload');
  const sourceUpdatedAt = overrides.sourceUpdatedAt ?? '2026-04-08T15:00:00.000Z';

  return {
    employeeId: overrides.employeeId ?? `emp_${sequence}`,
    locationId: overrides.locationId ?? 'loc_ny',
    availableUnits: overrides.availableUnits ?? 10_000,
    sourceVersion: overrides.sourceVersion ?? `${sourceUpdatedAt}#${sequence}`,
    sourceUpdatedAt,
  };
}

export function buildHcmBalanceAdjustmentRequest(
  overrides: Partial<HcmBalanceAdjustmentRequest> = {},
): HcmBalanceAdjustmentRequest {
  const sequence = nextTestSequence('hcm_balance_adjustment');

  return {
    idempotencyKey: overrides.idempotencyKey ?? `idem-hcm-${sequence}`,
    requestId: overrides.requestId ?? `req_${sequence}`,
    employeeId: overrides.employeeId ?? `emp_${sequence}`,
    locationId: overrides.locationId ?? 'loc_ny',
    deltaUnits: overrides.deltaUnits ?? -2_000,
    reasonCode: overrides.reasonCode ?? 'TIME_OFF_APPROVAL',
    occurredAt: overrides.occurredAt ?? '2026-04-08T15:05:00.000Z',
  };
}

export function buildAcceptedHcmBalanceAdjustmentResponse(
  overrides: Partial<HcmBalanceAdjustmentAcceptedResponse> = {},
): HcmBalanceAdjustmentAcceptedResponse {
  return {
    accepted: true,
    ...buildHcmBalancePayload(overrides),
    ...overrides,
  };
}

export function buildRejectedHcmBalanceAdjustmentResponse(
  overrides: Partial<HcmBalanceAdjustmentRejectedResponse> = {},
): HcmBalanceAdjustmentRejectedResponse {
  return {
    accepted: false,
    code: overrides.code ?? 'INSUFFICIENT_BALANCE',
    message:
      overrides.message ??
      'Available balance is lower than requested deduction.',
  };
}

export function buildHcmBatchBalanceSnapshotRequest(
  overrides: Partial<HcmBatchBalanceSnapshotRequest> = {},
): HcmBatchBalanceSnapshotRequest {
  const sequence = nextTestSequence('hcm_batch_balance_snapshot');

  return {
    runId: overrides.runId ?? `sync_run_${sequence}`,
    sentAt: overrides.sentAt ?? '2026-04-08T15:10:00.000Z',
    records: overrides.records ?? [buildHcmBalancePayload()],
  };
}

