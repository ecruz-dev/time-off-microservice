import { BadGatewayException } from '@nestjs/common';
import {
  AuditActorType,
  BalanceReservationStatus,
  OutboxEventStatus,
  TimeOffRequestStatus,
} from '@prisma/client';

import {
  BalanceReservationBuilder,
  BalanceSnapshotBuilder,
  OutboxEventBuilder,
  TimeOffRequestBuilder,
} from '@app/testing';

import { OutboxRuntimeConfig } from '@app/config';

import { PrismaService } from '../../../database/prisma.service';
import {
  AuditLogRepository,
  BalanceReservationRepository,
  BalanceSnapshotRepository,
  OutboxEventRepository,
  TimeOffRequestRepository,
} from '../../../database/repositories/interfaces';
import { HcmClient } from '../../hcm-sync/infrastructure/hcm.client';
import { APPROVAL_SYNC_RETRY_EVENT } from '../outbox.types';
import { OutboxProcessorService } from './outbox-processor.service';

describe('OutboxProcessorService', () => {
  let prisma: Pick<PrismaService, '$transaction'>;
  let auditLogRepository: jest.Mocked<AuditLogRepository>;
  let balanceReservationRepository: jest.Mocked<BalanceReservationRepository>;
  let balanceSnapshotRepository: jest.Mocked<BalanceSnapshotRepository>;
  let outboxEventRepository: jest.Mocked<OutboxEventRepository>;
  let timeOffRequestRepository: jest.Mocked<TimeOffRequestRepository>;
  let hcmClient: jest.Mocked<Pick<HcmClient, 'applyBalanceAdjustment'>>;
  let runtimeConfig: OutboxRuntimeConfig;
  let service: OutboxProcessorService;

  beforeEach(() => {
    prisma = {
      $transaction:
        jest.fn(
          async (callback: (client: never) => Promise<unknown>) =>
            callback({} as never),
        ) as unknown as PrismaService['$transaction'],
    };
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
    balanceSnapshotRepository = {
      findByEmployeeAndLocation: jest.fn(),
      listByEmployee: jest.fn(),
      upsert: jest.fn(),
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
    hcmClient = {
      applyBalanceAdjustment: jest.fn(),
    };
    runtimeConfig = {
      baseDelayMs: 1_000,
      batchSize: 25,
      maxAttempts: 3,
    };

    service = new OutboxProcessorService(
      runtimeConfig,
      prisma as PrismaService,
      auditLogRepository,
      balanceReservationRepository,
      balanceSnapshotRepository,
      outboxEventRepository,
      timeOffRequestRepository,
      hcmClient as unknown as HcmClient,
    );
  });

  it('retries a failed approval sync and marks the request approved on success', async () => {
    const event = new OutboxEventBuilder()
      .withId('outbox_retry_1')
      .withEventType(APPROVAL_SYNC_RETRY_EVENT)
      .withAggregate('time_off_request', 'req_retry_1')
      .withPayload({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        managerId: 'mgr_sam',
        reason: 'Approved',
        requestId: 'req_retry_1',
        requestedUnits: 2000,
      })
      .build();
    const request = new TimeOffRequestBuilder()
      .withId('req_retry_1')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withRequestedUnits(2000)
      .withStatus(TimeOffRequestStatus.SYNC_FAILED)
      .build();
    const reservation = new BalanceReservationBuilder()
      .fromRequest(request)
      .withStatus(BalanceReservationStatus.ACTIVE)
      .build();

    outboxEventRepository.listPending.mockResolvedValue([event]);
    outboxEventRepository.markStatus.mockResolvedValue(event);
    timeOffRequestRepository.findById.mockResolvedValue(request);
    balanceReservationRepository.findByRequestId.mockResolvedValue(reservation);
    hcmClient.applyBalanceAdjustment.mockResolvedValue({
      accepted: true,
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 6000,
      sourceVersion: '2026-04-10T12:01:00.000Z#4',
      sourceUpdatedAt: '2026-04-10T12:01:00.000Z',
    });
    balanceSnapshotRepository.upsert.mockResolvedValue(
      new BalanceSnapshotBuilder()
        .withEmployeeId('emp_alice')
        .withLocationId('loc_ny')
        .withAvailableUnits(6000)
        .withSourceVersion('2026-04-10T12:01:00.000Z#4')
        .build(),
    );
    timeOffRequestRepository.updateDecision.mockResolvedValue(
      new TimeOffRequestBuilder()
        .withId('req_retry_1')
        .withEmployeeId('emp_alice')
        .withLocationId('loc_ny')
        .withRequestedUnits(2000)
        .withStatus(TimeOffRequestStatus.APPROVED)
        .withApprovedBy('mgr_sam')
        .build(),
    );
    balanceReservationRepository.updateStatusByRequestId.mockResolvedValue(
      reservation,
    );
    auditLogRepository.create.mockResolvedValue({
      id: 'audit_retry_success',
      action: 'TIME_OFF_REQUEST_SYNC_RETRY_SUCCEEDED',
      actorType: AuditActorType.SYSTEM,
      actorId: 'outbox-processor',
      requestId: request.id,
      syncRunId: null,
      entityType: 'time_off_request',
      entityId: request.id,
      metadata: '{}',
      occurredAt: new Date(),
      createdAt: new Date(),
    });

    const result = await service.processPending(1);

    expect(result).toEqual({
      failedPermanently: 0,
      processed: 1,
      releasedForReview: 0,
      retried: 0,
      succeeded: 1,
    });
    expect(timeOffRequestRepository.updateDecision).toHaveBeenCalledWith(
      request.id,
      expect.objectContaining({
        status: TimeOffRequestStatus.APPROVED,
        approvedBy: 'mgr_sam',
      }),
      expect.anything(),
    );
    expect(balanceReservationRepository.updateStatusByRequestId).toHaveBeenCalledWith(
      request.id,
      BalanceReservationStatus.CONSUMED,
      expect.anything(),
    );
    expect(outboxEventRepository.markStatus).toHaveBeenNthCalledWith(
      1,
      event.id,
      OutboxEventStatus.PROCESSING,
      expect.objectContaining({
        attempts: 1,
      }),
    );
    expect(outboxEventRepository.markStatus).toHaveBeenNthCalledWith(
      2,
      event.id,
      OutboxEventStatus.SENT,
      expect.objectContaining({
        attempts: 1,
      }),
      expect.anything(),
    );
  });

  it('reschedules transient upstream failures with exponential backoff', async () => {
    const event = new OutboxEventBuilder()
      .withId('outbox_retry_2')
      .withEventType(APPROVAL_SYNC_RETRY_EVENT)
      .withPayload({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        managerId: 'mgr_sam',
        reason: 'Approved',
        requestId: 'req_retry_2',
        requestedUnits: 2000,
      })
      .build();
    const request = new TimeOffRequestBuilder()
      .withId('req_retry_2')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withRequestedUnits(2000)
      .withStatus(TimeOffRequestStatus.SYNC_FAILED)
      .build();

    outboxEventRepository.listPending.mockResolvedValue([event]);
    outboxEventRepository.markStatus.mockResolvedValue(event);
    timeOffRequestRepository.findById.mockResolvedValue(request);
    hcmClient.applyBalanceAdjustment.mockRejectedValue(
      new BadGatewayException({
        code: 'HCM_UPSTREAM_UNAVAILABLE',
        message: 'The HCM upstream request failed.',
      }),
    );
    auditLogRepository.create.mockResolvedValue({
      id: 'audit_retry_scheduled',
      action: 'TIME_OFF_REQUEST_SYNC_RETRY_SCHEDULED',
      actorType: AuditActorType.SYSTEM,
      actorId: 'outbox-processor',
      requestId: request.id,
      syncRunId: null,
      entityType: 'outbox_event',
      entityId: event.id,
      metadata: '{}',
      occurredAt: new Date(),
      createdAt: new Date(),
    });

    const result = await service.processPending(1);

    expect(result).toEqual({
      failedPermanently: 0,
      processed: 1,
      releasedForReview: 0,
      retried: 1,
      succeeded: 0,
    });
    expect(outboxEventRepository.markStatus).toHaveBeenNthCalledWith(
      2,
      event.id,
      OutboxEventStatus.PENDING,
      expect.objectContaining({
        attempts: 1,
        lastError: 'The HCM upstream request failed.',
      }),
      expect.anything(),
    );
  });

  it('moves the request to REQUIRES_REVIEW on deterministic HCM rejection', async () => {
    const event = new OutboxEventBuilder()
      .withId('outbox_retry_3')
      .withEventType(APPROVAL_SYNC_RETRY_EVENT)
      .withPayload({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        managerId: 'mgr_sam',
        reason: 'Approved',
        requestId: 'req_retry_3',
        requestedUnits: 2000,
      })
      .build();
    const request = new TimeOffRequestBuilder()
      .withId('req_retry_3')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withRequestedUnits(2000)
      .withStatus(TimeOffRequestStatus.SYNC_FAILED)
      .build();
    const reservation = new BalanceReservationBuilder()
      .fromRequest(request)
      .withStatus(BalanceReservationStatus.ACTIVE)
      .build();

    outboxEventRepository.listPending.mockResolvedValue([event]);
    outboxEventRepository.markStatus.mockResolvedValue(event);
    timeOffRequestRepository.findById.mockResolvedValue(request);
    balanceReservationRepository.findByRequestId.mockResolvedValue(reservation);
    hcmClient.applyBalanceAdjustment.mockResolvedValue({
      accepted: false,
      code: 'INSUFFICIENT_BALANCE',
      message: 'Available balance is lower than requested deduction.',
    });
    timeOffRequestRepository.updateDecision.mockResolvedValue(
      new TimeOffRequestBuilder()
        .withId('req_retry_3')
        .withStatus(TimeOffRequestStatus.REQUIRES_REVIEW)
        .build(),
    );
    balanceReservationRepository.updateStatusByRequestId.mockResolvedValue(
      reservation,
    );
    auditLogRepository.create.mockResolvedValue({
      id: 'audit_retry_review',
      action: 'TIME_OFF_REQUEST_SYNC_RETRY_REQUIRES_REVIEW',
      actorType: AuditActorType.SYSTEM,
      actorId: 'outbox-processor',
      requestId: request.id,
      syncRunId: null,
      entityType: 'time_off_request',
      entityId: request.id,
      metadata: '{}',
      occurredAt: new Date(),
      createdAt: new Date(),
    });

    const result = await service.processPending(1);

    expect(result).toEqual({
      failedPermanently: 0,
      processed: 1,
      releasedForReview: 1,
      retried: 0,
      succeeded: 0,
    });
    expect(timeOffRequestRepository.updateDecision).toHaveBeenCalledWith(
      request.id,
      expect.objectContaining({
        status: TimeOffRequestStatus.REQUIRES_REVIEW,
      }),
      expect.anything(),
    );
    expect(balanceReservationRepository.updateStatusByRequestId).toHaveBeenCalledWith(
      request.id,
      BalanceReservationStatus.RELEASED,
      expect.anything(),
    );
    expect(outboxEventRepository.markStatus).toHaveBeenNthCalledWith(
      2,
      event.id,
      OutboxEventStatus.SENT,
      expect.objectContaining({
        attempts: 1,
      }),
      expect.anything(),
    );
  });
});
