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

export interface HcmAcceptedAdjustmentResponse extends HcmBalancePayload {
  accepted: true;
}

export interface HcmRejectedAdjustmentResponse {
  accepted: false;
  code: string;
  message: string;
}

export type HcmBalanceAdjustmentResponse =
  | HcmAcceptedAdjustmentResponse
  | HcmRejectedAdjustmentResponse;

export interface HcmBatchBalanceSnapshotResponse {
  runId: string;
  sentAt: string;
  records: HcmBalancePayload[];
}

export interface HcmBatchQuery {
  employeeId?: string;
  locationId?: string;
}

