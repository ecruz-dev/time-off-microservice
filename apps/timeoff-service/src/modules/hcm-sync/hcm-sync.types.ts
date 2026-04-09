import { SyncRunStatus } from '@prisma/client';

export interface HcmBalancePayload {
  employeeId: string;
  locationId: string;
  availableUnits: number;
  sourceVersion: string;
  sourceUpdatedAt: string;
}

export interface HcmBatchBalanceSnapshotPayload {
  runId: string;
  sentAt: string;
  records: HcmBalancePayload[];
}

export interface HcmBatchQuery {
  employeeId?: string;
  locationId?: string;
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

export interface BatchSyncSummary {
  syncRunId: string;
  externalRunId: string;
  source: string;
  status: SyncRunStatus;
  sentAt: string | null;
  startedAt: string;
  completedAt: string | null;
  recordsReceived: number;
  recordsApplied: number;
  reusedExistingRun: boolean;
}
