export const APPROVAL_SYNC_RETRY_EVENT = 'time_off_request.approval_sync_retry.v1';

export interface ApprovalSyncRetryPayload {
  employeeId: string;
  locationId: string;
  managerId: string;
  reason: string | null;
  requestId: string;
  requestedUnits: number;
}

export interface OutboxProcessingSummary {
  failedPermanently: number;
  processed: number;
  releasedForReview: number;
  retried: number;
  succeeded: number;
}
