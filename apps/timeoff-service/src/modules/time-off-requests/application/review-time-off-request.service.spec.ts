import {
  AuditActorType,
  BalanceReservationStatus,
  IdempotencyStatus,
  TimeOffRequestStatus,
} from '@prisma/client';

import {
  BalanceReservationBuilder,
  BalanceSnapshotBuilder,
  EmployeeBuilder,
  IdempotencyKeyBuilder,
  TimeOffRequestBuilder,
} from '@app/testing';

import { PrismaService } from '../../../database/prisma.service';
import {
  AuditLogRepository,
  BalanceReservationRepository,
  BalanceSnapshotRepository,
  EmployeeRepository,
  IdempotencyKeyRepository,
  TimeOffRequestRepository,
} from '../../../database/repositories/interfaces';
import { HcmClient } from '../../hcm-sync/infrastructure/hcm.client';
import { ReviewTimeOffRequestService } from './review-time-off-request.service';

describe('ReviewTimeOffRequestService', () => {
  let prisma: Pick<PrismaService, '$transaction'>;
  let employeeRepository: jest.Mocked<EmployeeRepository>;
  let balanceSnapshotRepository: jest.Mocked<BalanceSnapshotRepository>;
  let balanceReservationRepository: jest.Mocked<BalanceReservationRepository>;
  let timeOffRequestRepository: jest.Mocked<TimeOffRequestRepository>;
  let auditLogRepository: jest.Mocked<AuditLogRepository>;
  let idempotencyKeyRepository: jest.Mocked<IdempotencyKeyRepository>;
  let hcmClient: jest.Mocked<Pick<HcmClient, 'applyBalanceAdjustment' | 'getBalance'>>;
  let service: ReviewTimeOffRequestService;

  beforeEach(() => {
    const transactionMock = jest.fn(
      async (callback: (client: never) => Promise<unknown>) =>
        callback({} as never),
    );

    prisma = {
      $transaction:
        transactionMock as unknown as Pick<
          PrismaService,
          '$transaction'
        >['$transaction'],
    };
    employeeRepository = {
      create: jest.fn(),
      upsert: jest.fn(),
      findById: jest.fn(),
      list: jest.fn(),
    };
    balanceSnapshotRepository = {
      findByEmployeeAndLocation: jest.fn(),
      upsert: jest.fn(),
      listByEmployee: jest.fn(),
    };
    balanceReservationRepository = {
      create: jest.fn(),
      findActiveByEmployeeAndLocation: jest.fn(),
      findByRequestId: jest.fn(),
      updateStatusByRequestId: jest.fn(),
    };
    timeOffRequestRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      updateDecision: jest.fn(),
    };
    auditLogRepository = {
      create: jest.fn(),
      listByRequestId: jest.fn(),
    };
    idempotencyKeyRepository = {
      create: jest.fn(),
      findByScopeAndKey: jest.fn(),
      markStatus: jest.fn(),
    };
    hcmClient = {
      applyBalanceAdjustment: jest.fn(),
      getBalance: jest.fn(),
    };
    service = new ReviewTimeOffRequestService(
      prisma as PrismaService,
      employeeRepository,
      balanceSnapshotRepository,
      balanceReservationRepository,
      timeOffRequestRepository,
      auditLogRepository,
      idempotencyKeyRepository,
      hcmClient as unknown as HcmClient,
    );
  });

  it('approves a request, consumes the reservation, and writes through to HCM', async () => {
    const manager = new EmployeeBuilder()
      .withId('mgr_sam')
      .withLocationId('loc_ny')
      .build();
    const employee = new EmployeeBuilder()
      .withId('emp_alice')
      .withLocationId('loc_ny')
      .withManagerId('mgr_sam')
      .build();
    const pendingRequest = new TimeOffRequestBuilder()
      .withId('req_approve_1')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withRequestedUnits(2000)
      .withStatus(TimeOffRequestStatus.PENDING)
      .build();
    const activeReservation = new BalanceReservationBuilder()
      .fromRequest(pendingRequest)
      .withStatus(BalanceReservationStatus.ACTIVE)
      .build();
    const refreshedSnapshot = new BalanceSnapshotBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withAvailableUnits(8000)
      .build();
    const approvedRequest = new TimeOffRequestBuilder()
      .withId('req_approve_1')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withRequestedUnits(2000)
      .withStatus(TimeOffRequestStatus.APPROVED)
      .withApprovedBy('mgr_sam')
      .build();
    const idempotencyRecord = new IdempotencyKeyBuilder()
      .withId('idem_approve_1')
      .withScope('timeoff.approve')
      .withIdempotencyKey('approve-1')
      .build();

    idempotencyKeyRepository.findByScopeAndKey.mockResolvedValue(null);
    idempotencyKeyRepository.create.mockResolvedValue(idempotencyRecord);
    employeeRepository.findById.mockResolvedValueOnce(manager);
    timeOffRequestRepository.findById.mockResolvedValue(pendingRequest);
    employeeRepository.findById.mockResolvedValueOnce(employee);
    balanceReservationRepository.findByRequestId.mockResolvedValue(
      activeReservation,
    );
    hcmClient.getBalance.mockResolvedValue({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
      sourceVersion: '2026-04-09T10:10:00.000Z#1',
      sourceUpdatedAt: '2026-04-09T10:10:00.000Z',
    });
    balanceSnapshotRepository.upsert
      .mockResolvedValueOnce(refreshedSnapshot)
      .mockResolvedValueOnce(
        new BalanceSnapshotBuilder()
          .withEmployeeId('emp_alice')
          .withLocationId('loc_ny')
          .withAvailableUnits(6000)
          .withSourceVersion('2026-04-09T10:11:00.000Z#2')
          .withSourceUpdatedAt(new Date('2026-04-09T10:11:00.000Z'))
          .build(),
      );
    balanceReservationRepository.findActiveByEmployeeAndLocation.mockResolvedValue([
      activeReservation,
    ]);
    hcmClient.applyBalanceAdjustment.mockResolvedValue({
      accepted: true,
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 6000,
      sourceVersion: '2026-04-09T10:11:00.000Z#2',
      sourceUpdatedAt: '2026-04-09T10:11:00.000Z',
    });
    timeOffRequestRepository.updateDecision.mockResolvedValue(approvedRequest);
    balanceReservationRepository.updateStatusByRequestId.mockResolvedValue(
      activeReservation,
    );
    auditLogRepository.create.mockResolvedValue({
      id: 'audit_approve_1',
      action: 'TIME_OFF_REQUEST_APPROVED',
      actorType: AuditActorType.MANAGER,
      actorId: 'mgr_sam',
      requestId: pendingRequest.id,
      syncRunId: null,
      entityType: 'time_off_request',
      entityId: pendingRequest.id,
      metadata: '{}',
      occurredAt: new Date(),
      createdAt: new Date(),
    });
    idempotencyKeyRepository.markStatus.mockResolvedValue(
      new IdempotencyKeyBuilder()
        .withId('idem_approve_1')
        .withScope('timeoff.approve')
        .withStatus(IdempotencyStatus.COMPLETED)
        .build(),
    );

    const result = await service.execute({
      actorId: 'mgr_sam',
      decision: 'APPROVE',
      idempotencyKey: 'approve-1',
      reason: 'Approved',
      requestId: pendingRequest.id,
    });

    expect(hcmClient.getBalance).toHaveBeenCalledWith('emp_alice', 'loc_ny');
    expect(hcmClient.applyBalanceAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: pendingRequest.id,
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        deltaUnits: -2000,
      }),
    );
    expect(timeOffRequestRepository.updateDecision).toHaveBeenCalledWith(
      pendingRequest.id,
      expect.objectContaining({
        status: TimeOffRequestStatus.APPROVED,
        approvedBy: 'mgr_sam',
      }),
      expect.anything(),
    );
    expect(balanceReservationRepository.updateStatusByRequestId).toHaveBeenCalledWith(
      pendingRequest.id,
      BalanceReservationStatus.CONSUMED,
      expect.anything(),
    );
    expect(result.status).toBe(TimeOffRequestStatus.APPROVED);
  });

  it('rejects a request and releases the reservation', async () => {
    const manager = new EmployeeBuilder()
      .withId('mgr_sam')
      .withLocationId('loc_ny')
      .build();
    const employee = new EmployeeBuilder()
      .withId('emp_alice')
      .withLocationId('loc_ny')
      .withManagerId('mgr_sam')
      .build();
    const pendingRequest = new TimeOffRequestBuilder()
      .withId('req_reject_1')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withStatus(TimeOffRequestStatus.PENDING)
      .build();
    const activeReservation = new BalanceReservationBuilder()
      .fromRequest(pendingRequest)
      .withStatus(BalanceReservationStatus.ACTIVE)
      .build();
    const rejectedRequest = new TimeOffRequestBuilder()
      .withId('req_reject_1')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withStatus(TimeOffRequestStatus.REJECTED)
      .withManagerDecisionReason('Coverage unavailable')
      .build();

    idempotencyKeyRepository.findByScopeAndKey.mockResolvedValue(null);
    idempotencyKeyRepository.create.mockResolvedValue(
      new IdempotencyKeyBuilder()
        .withId('idem_reject_1')
        .withScope('timeoff.reject')
        .withIdempotencyKey('reject-1')
        .build(),
    );
    employeeRepository.findById.mockResolvedValueOnce(manager);
    timeOffRequestRepository.findById.mockResolvedValue(pendingRequest);
    employeeRepository.findById.mockResolvedValueOnce(employee);
    balanceReservationRepository.findByRequestId.mockResolvedValue(
      activeReservation,
    );
    timeOffRequestRepository.updateDecision.mockResolvedValue(rejectedRequest);
    balanceReservationRepository.updateStatusByRequestId.mockResolvedValue(
      activeReservation,
    );
    auditLogRepository.create.mockResolvedValue({
      id: 'audit_reject_1',
      action: 'TIME_OFF_REQUEST_REJECTED',
      actorType: AuditActorType.MANAGER,
      actorId: 'mgr_sam',
      requestId: pendingRequest.id,
      syncRunId: null,
      entityType: 'time_off_request',
      entityId: pendingRequest.id,
      metadata: '{}',
      occurredAt: new Date(),
      createdAt: new Date(),
    });
    idempotencyKeyRepository.markStatus.mockResolvedValue(
      new IdempotencyKeyBuilder()
        .withId('idem_reject_1')
        .withScope('timeoff.reject')
        .withStatus(IdempotencyStatus.COMPLETED)
        .build(),
    );

    const result = await service.execute({
      actorId: 'mgr_sam',
      decision: 'REJECT',
      idempotencyKey: 'reject-1',
      reason: 'Coverage unavailable',
      requestId: pendingRequest.id,
    });

    expect(hcmClient.applyBalanceAdjustment).not.toHaveBeenCalled();
    expect(balanceReservationRepository.updateStatusByRequestId).toHaveBeenCalledWith(
      pendingRequest.id,
      BalanceReservationStatus.RELEASED,
      expect.anything(),
    );
    expect(result.status).toBe(TimeOffRequestStatus.REJECTED);
  });

  it('moves the request to REQUIRES_REVIEW and releases the reservation when revalidation fails', async () => {
    const manager = new EmployeeBuilder()
      .withId('mgr_sam')
      .withLocationId('loc_ny')
      .build();
    const employee = new EmployeeBuilder()
      .withId('emp_alice')
      .withLocationId('loc_ny')
      .withManagerId('mgr_sam')
      .build();
    const pendingRequest = new TimeOffRequestBuilder()
      .withId('req_review_1')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withRequestedUnits(2000)
      .withStatus(TimeOffRequestStatus.PENDING)
      .build();
    const activeReservation = new BalanceReservationBuilder()
      .fromRequest(pendingRequest)
      .withStatus(BalanceReservationStatus.ACTIVE)
      .build();
    const otherActiveReservation = new BalanceReservationBuilder()
      .withRequestId('req_other')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withReservedUnits(7000)
      .withStatus(BalanceReservationStatus.ACTIVE)
      .build();
    const reviewRequest = new TimeOffRequestBuilder()
      .withId('req_review_1')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withStatus(TimeOffRequestStatus.REQUIRES_REVIEW)
      .build();

    idempotencyKeyRepository.findByScopeAndKey.mockResolvedValue(null);
    idempotencyKeyRepository.create.mockResolvedValue(
      new IdempotencyKeyBuilder()
        .withId('idem_review_1')
        .withScope('timeoff.approve')
        .withIdempotencyKey('approve-review-1')
        .build(),
    );
    employeeRepository.findById.mockResolvedValueOnce(manager);
    timeOffRequestRepository.findById.mockResolvedValue(pendingRequest);
    employeeRepository.findById.mockResolvedValueOnce(employee);
    balanceReservationRepository.findByRequestId.mockResolvedValue(
      activeReservation,
    );
    hcmClient.getBalance.mockResolvedValue({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
      sourceVersion: '2026-04-09T10:20:00.000Z#1',
      sourceUpdatedAt: '2026-04-09T10:20:00.000Z',
    });
    balanceSnapshotRepository.upsert.mockResolvedValue(
      new BalanceSnapshotBuilder()
        .withEmployeeId('emp_alice')
        .withLocationId('loc_ny')
        .withAvailableUnits(8000)
        .build(),
    );
    balanceReservationRepository.findActiveByEmployeeAndLocation.mockResolvedValue([
      activeReservation,
      otherActiveReservation,
    ]);
    timeOffRequestRepository.updateDecision.mockResolvedValue(reviewRequest);
    balanceReservationRepository.updateStatusByRequestId.mockResolvedValue(
      activeReservation,
    );
    auditLogRepository.create.mockResolvedValue({
      id: 'audit_review_1',
      action: 'TIME_OFF_REQUEST_REQUIRES_REVIEW',
      actorType: AuditActorType.MANAGER,
      actorId: 'mgr_sam',
      requestId: pendingRequest.id,
      syncRunId: null,
      entityType: 'time_off_request',
      entityId: pendingRequest.id,
      metadata: '{}',
      occurredAt: new Date(),
      createdAt: new Date(),
    });
    idempotencyKeyRepository.markStatus.mockResolvedValue(
      new IdempotencyKeyBuilder()
        .withId('idem_review_1')
        .withScope('timeoff.approve')
        .withStatus(IdempotencyStatus.COMPLETED)
        .build(),
    );

    const result = await service.execute({
      actorId: 'mgr_sam',
      decision: 'APPROVE',
      idempotencyKey: 'approve-review-1',
      requestId: pendingRequest.id,
    });

    expect(hcmClient.applyBalanceAdjustment).not.toHaveBeenCalled();
    expect(timeOffRequestRepository.updateDecision).toHaveBeenCalledWith(
      pendingRequest.id,
      expect.objectContaining({
        status: TimeOffRequestStatus.REQUIRES_REVIEW,
      }),
      expect.anything(),
    );
    expect(balanceReservationRepository.updateStatusByRequestId).toHaveBeenCalledWith(
      pendingRequest.id,
      BalanceReservationStatus.RELEASED,
      expect.anything(),
    );
    expect(result.status).toBe(TimeOffRequestStatus.REQUIRES_REVIEW);
  });

  it('moves the request to SYNC_FAILED and keeps the reservation when HCM write-through fails', async () => {
    const manager = new EmployeeBuilder()
      .withId('mgr_sam')
      .withLocationId('loc_ny')
      .build();
    const employee = new EmployeeBuilder()
      .withId('emp_alice')
      .withLocationId('loc_ny')
      .withManagerId('mgr_sam')
      .build();
    const pendingRequest = new TimeOffRequestBuilder()
      .withId('req_sync_failed_1')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withRequestedUnits(2000)
      .withStatus(TimeOffRequestStatus.PENDING)
      .build();
    const activeReservation = new BalanceReservationBuilder()
      .fromRequest(pendingRequest)
      .withStatus(BalanceReservationStatus.ACTIVE)
      .build();
    const syncFailedRequest = new TimeOffRequestBuilder()
      .withId('req_sync_failed_1')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withStatus(TimeOffRequestStatus.SYNC_FAILED)
      .build();

    idempotencyKeyRepository.findByScopeAndKey.mockResolvedValue(null);
    idempotencyKeyRepository.create.mockResolvedValue(
      new IdempotencyKeyBuilder()
        .withId('idem_sync_failed_1')
        .withScope('timeoff.approve')
        .withIdempotencyKey('approve-sync-failed-1')
        .build(),
    );
    employeeRepository.findById.mockResolvedValueOnce(manager);
    timeOffRequestRepository.findById.mockResolvedValue(pendingRequest);
    employeeRepository.findById.mockResolvedValueOnce(employee);
    balanceReservationRepository.findByRequestId.mockResolvedValue(
      activeReservation,
    );
    hcmClient.getBalance.mockResolvedValue({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
      sourceVersion: '2026-04-09T10:30:00.000Z#1',
      sourceUpdatedAt: '2026-04-09T10:30:00.000Z',
    });
    balanceSnapshotRepository.upsert.mockResolvedValue(
      new BalanceSnapshotBuilder()
        .withEmployeeId('emp_alice')
        .withLocationId('loc_ny')
        .withAvailableUnits(8000)
        .build(),
    );
    balanceReservationRepository.findActiveByEmployeeAndLocation.mockResolvedValue([
      activeReservation,
    ]);
    hcmClient.applyBalanceAdjustment.mockRejectedValue(new Error('timeout'));
    timeOffRequestRepository.updateDecision.mockResolvedValue(syncFailedRequest);
    auditLogRepository.create.mockResolvedValue({
      id: 'audit_sync_failed_1',
      action: 'TIME_OFF_REQUEST_SYNC_FAILED',
      actorType: AuditActorType.MANAGER,
      actorId: 'mgr_sam',
      requestId: pendingRequest.id,
      syncRunId: null,
      entityType: 'time_off_request',
      entityId: pendingRequest.id,
      metadata: '{}',
      occurredAt: new Date(),
      createdAt: new Date(),
    });
    idempotencyKeyRepository.markStatus.mockResolvedValue(
      new IdempotencyKeyBuilder()
        .withId('idem_sync_failed_1')
        .withScope('timeoff.approve')
        .withStatus(IdempotencyStatus.COMPLETED)
        .build(),
    );

    const result = await service.execute({
      actorId: 'mgr_sam',
      decision: 'APPROVE',
      idempotencyKey: 'approve-sync-failed-1',
      requestId: pendingRequest.id,
    });

    expect(timeOffRequestRepository.updateDecision).toHaveBeenCalledWith(
      pendingRequest.id,
      expect.objectContaining({
        status: TimeOffRequestStatus.SYNC_FAILED,
      }),
      expect.anything(),
    );
    expect(balanceReservationRepository.updateStatusByRequestId).not.toHaveBeenCalled();
    expect(result.status).toBe(TimeOffRequestStatus.SYNC_FAILED);
  });
});
