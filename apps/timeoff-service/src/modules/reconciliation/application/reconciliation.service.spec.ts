import {
  AuditActorType,
  BalanceReservationStatus,
  TimeOffRequestStatus,
} from '@prisma/client';

import {
  BalanceReservationBuilder,
  BalanceSnapshotBuilder,
  TimeOffRequestBuilder,
} from '@app/testing';

import {
  AuditLogRepository,
  BalanceReservationRepository,
  OutboxEventRepository,
  PrismaTransactionClient,
  TimeOffRequestRepository,
} from '../../../database/repositories/interfaces';
import { ReconciliationService } from './reconciliation.service';

describe('ReconciliationService', () => {
  let auditLogRepository: jest.Mocked<AuditLogRepository>;
  let balanceReservationRepository: jest.Mocked<BalanceReservationRepository>;
  let outboxEventRepository: jest.Mocked<OutboxEventRepository>;
  let timeOffRequestRepository: jest.Mocked<TimeOffRequestRepository>;
  let tx: PrismaTransactionClient;
  let service: ReconciliationService;

  beforeEach(() => {
    auditLogRepository = {
      create: jest.fn(),
      listByRequestId: jest.fn(),
      listBySyncRunId: jest.fn(),
    };
    balanceReservationRepository = {
      create: jest.fn(),
      findActiveByEmployeeAndLocation: jest.fn(),
      findByRequestId: jest.fn(),
      updateStatusByRequestId: jest.fn(),
    };
    outboxEventRepository = {
      create: jest.fn(),
      listPending: jest.fn(),
      markStatus: jest.fn(),
    };
    timeOffRequestRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      updateDecision: jest.fn(),
    };
    tx = {
      timeOffRequest: {
        findMany: jest.fn(),
      },
    } as unknown as PrismaTransactionClient;
    service = new ReconciliationService(
      auditLogRepository,
      balanceReservationRepository,
      outboxEventRepository,
      timeOffRequestRepository,
    );
  });

  it('classifies incoming snapshots as stale, unchanged, or applicable', () => {
    const previousSnapshot = new BalanceSnapshotBuilder()
      .withAvailableUnits(8000)
      .withSourceVersion('2026-04-10T12:00:00.000Z#2')
      .withSourceUpdatedAt(new Date('2026-04-10T12:00:00.000Z'))
      .build();

    expect(
      service.getSnapshotChangeDisposition(previousSnapshot, {
        availableUnits: 7000,
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        sourceUpdatedAt: new Date('2026-04-09T12:00:00.000Z'),
        sourceVersion: '2026-04-09T12:00:00.000Z#1',
      }),
    ).toBe('STALE');
    expect(
      service.getSnapshotChangeDisposition(previousSnapshot, {
        availableUnits: 8000,
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        sourceUpdatedAt: new Date('2026-04-10T12:00:00.000Z'),
        sourceVersion: '2026-04-10T12:00:00.000Z#2',
      }),
    ).toBe('UNCHANGED');
    expect(
      service.getSnapshotChangeDisposition(previousSnapshot, {
        availableUnits: 9000,
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        sourceUpdatedAt: new Date('2026-04-11T12:00:00.000Z'),
        sourceVersion: '2026-04-11T12:00:00.000Z#3',
      }),
    ).toBe('APPLY');
  });

  it('creates snapshot update audit and outbox records when no pending reservations exist', async () => {
    const nextSnapshot = new BalanceSnapshotBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withAvailableUnits(9000)
      .withSourceVersion('2026-04-11T12:00:00.000Z#3')
      .withSourceUpdatedAt(new Date('2026-04-11T12:00:00.000Z'))
      .build();

    balanceReservationRepository.findActiveByEmployeeAndLocation.mockResolvedValue(
      [],
    );
    auditLogRepository.create.mockResolvedValue({
      id: 'audit_snapshot_updated',
      action: 'HCM_BALANCE_SNAPSHOT_UPDATED',
      actorType: AuditActorType.SYSTEM,
      actorId: 'hcm-batch-pull',
      requestId: null,
      syncRunId: 'sync_1',
      entityType: 'balance_snapshot',
      entityId: 'emp_alice:loc_ny',
      metadata: '{}',
      occurredAt: new Date(),
      createdAt: new Date(),
    });
    outboxEventRepository.create.mockResolvedValue({
      id: 'outbox_snapshot_updated',
      eventType: 'balance.snapshot.updated.v1',
      aggregateType: 'balance_snapshot',
      aggregateId: 'emp_alice:loc_ny',
      payload: '{}',
      status: 'PENDING',
      attempts: 0,
      availableAt: new Date(),
      processedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.reconcileSnapshotChange(
      {
        nextSnapshot,
        previousSnapshot: null,
        source: 'hcm-batch-pull',
        syncRunId: 'sync_1',
      },
      tx,
    );

    expect(result).toEqual({
      requestsFlagged: 0,
      reservationsReleased: 0,
      snapshotUpdated: true,
    });
    expect(auditLogRepository.create).toHaveBeenCalledTimes(1);
    expect(outboxEventRepository.create).toHaveBeenCalledTimes(1);
  });

  it('flags the newest requests first when the authoritative balance drops below reserved units', async () => {
    const previousSnapshot = new BalanceSnapshotBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withAvailableUnits(8000)
      .withSourceVersion('2026-04-10T12:00:00.000Z#1')
      .withSourceUpdatedAt(new Date('2026-04-10T12:00:00.000Z'))
      .build();
    const nextSnapshot = new BalanceSnapshotBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withAvailableUnits(2000)
      .withSourceVersion('2026-04-11T12:00:00.000Z#2')
      .withSourceUpdatedAt(new Date('2026-04-11T12:00:00.000Z'))
      .withLastSyncedAt(new Date('2026-04-11T12:05:00.000Z'))
      .build();
    const oldestRequest = new TimeOffRequestBuilder()
      .withId('req_oldest')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withRequestedUnits(2000)
      .withStatus(TimeOffRequestStatus.PENDING)
      .build();
    const newestRequest = new TimeOffRequestBuilder()
      .withId('req_newest')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withRequestedUnits(2000)
      .withStatus(TimeOffRequestStatus.PENDING)
      .build();
    const oldestReservation = new BalanceReservationBuilder()
      .fromRequest(oldestRequest)
      .withStatus(BalanceReservationStatus.ACTIVE)
      .build();
    const newestReservation = new BalanceReservationBuilder()
      .fromRequest(newestRequest)
      .withStatus(BalanceReservationStatus.ACTIVE)
      .build();

    oldestRequest.createdAt = new Date('2026-04-11T08:00:00.000Z');
    newestRequest.createdAt = new Date('2026-04-11T09:00:00.000Z');
    balanceReservationRepository.findActiveByEmployeeAndLocation.mockResolvedValue([
      oldestReservation,
      newestReservation,
    ]);
    (tx.timeOffRequest.findMany as jest.Mock).mockResolvedValue([
      {
        createdAt: oldestRequest.createdAt,
        id: oldestRequest.id,
        requestedUnits: oldestRequest.requestedUnits,
        status: oldestRequest.status,
      },
      {
        createdAt: newestRequest.createdAt,
        id: newestRequest.id,
        requestedUnits: newestRequest.requestedUnits,
        status: newestRequest.status,
      },
    ]);
    timeOffRequestRepository.updateDecision.mockResolvedValue(
      new TimeOffRequestBuilder()
        .withId('req_newest')
        .withEmployeeId('emp_alice')
        .withLocationId('loc_ny')
        .withStatus(TimeOffRequestStatus.REQUIRES_REVIEW)
        .build(),
    );
    balanceReservationRepository.updateStatusByRequestId.mockResolvedValue(
      newestReservation,
    );
    auditLogRepository.create.mockResolvedValue({
      id: 'audit_reconciliation',
      action: 'BALANCE_RECONCILIATION_FLAGGED',
      actorType: AuditActorType.HCM,
      actorId: 'hcm-batch-push',
      requestId: 'req_newest',
      syncRunId: 'sync_2',
      entityType: 'time_off_request',
      entityId: 'req_newest',
      metadata: '{}',
      occurredAt: new Date(),
      createdAt: new Date(),
    });
    outboxEventRepository.create.mockResolvedValue({
      id: 'outbox_reconciliation',
      eventType: 'balance.reconciliation.flagged.v1',
      aggregateType: 'time_off_request',
      aggregateId: 'req_newest',
      payload: '{}',
      status: 'PENDING',
      attempts: 0,
      availableAt: new Date(),
      processedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.reconcileSnapshotChange(
      {
        nextSnapshot,
        previousSnapshot,
        source: 'hcm-batch-push',
        syncRunId: 'sync_2',
      },
      tx,
    );

    expect(result).toEqual({
      requestsFlagged: 1,
      reservationsReleased: 1,
      snapshotUpdated: true,
    });
    expect(timeOffRequestRepository.updateDecision).toHaveBeenCalledWith(
      'req_newest',
      expect.objectContaining({
        status: TimeOffRequestStatus.REQUIRES_REVIEW,
      }),
      tx,
    );
    expect(balanceReservationRepository.updateStatusByRequestId).toHaveBeenCalledWith(
      'req_newest',
      BalanceReservationStatus.RELEASED,
      tx,
    );
  });
});
