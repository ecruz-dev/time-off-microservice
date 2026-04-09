import {
  AuditActorType,
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
import { CreateTimeOffRequestService } from './create-time-off-request.service';

describe('CreateTimeOffRequestService', () => {
  let prisma: Pick<PrismaService, '$transaction'>;
  let employeeRepository: jest.Mocked<EmployeeRepository>;
  let balanceSnapshotRepository: jest.Mocked<BalanceSnapshotRepository>;
  let balanceReservationRepository: jest.Mocked<BalanceReservationRepository>;
  let timeOffRequestRepository: jest.Mocked<TimeOffRequestRepository>;
  let auditLogRepository: jest.Mocked<AuditLogRepository>;
  let idempotencyKeyRepository: jest.Mocked<IdempotencyKeyRepository>;
  let hcmClient: jest.Mocked<Pick<HcmClient, 'getBalance'>>;
  let service: CreateTimeOffRequestService;

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
      listBySyncRunId: jest.fn(),
    };
    idempotencyKeyRepository = {
      create: jest.fn(),
      findByScopeAndKey: jest.fn(),
      markStatus: jest.fn(),
    };
    hcmClient = {
      getBalance: jest.fn(),
    };
    service = new CreateTimeOffRequestService(
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

  it('refreshes stale balances, creates a pending request, and reserves units', async () => {
    const employee = new EmployeeBuilder()
      .withId('emp_alice')
      .withLocationId('loc_ny')
      .build();
    const staleSnapshot = new BalanceSnapshotBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withAvailableUnits(5000)
      .withLastSyncedAt(new Date('2026-01-01T00:00:00.000Z'))
      .build();
    const refreshedSnapshot = new BalanceSnapshotBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withAvailableUnits(8000)
      .withSourceVersion('2026-04-09T10:00:00.000Z#1')
      .withSourceUpdatedAt(new Date('2026-04-09T10:00:00.000Z'))
      .withLastSyncedAt(new Date())
      .build();
    const idempotencyRecord = new IdempotencyKeyBuilder()
      .withId('idem_1')
      .withIdempotencyKey('request-create-1')
      .build();
    const createdRequest = new TimeOffRequestBuilder()
      .withId('req_1')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withRequestedUnits(2000)
      .withStatus(TimeOffRequestStatus.PENDING)
      .build();

    employeeRepository.findById.mockResolvedValue(employee);
    idempotencyKeyRepository.findByScopeAndKey.mockResolvedValue(null);
    idempotencyKeyRepository.create.mockResolvedValue(idempotencyRecord);
    balanceReservationRepository.findActiveByEmployeeAndLocation.mockResolvedValue(
      [],
    );
    balanceSnapshotRepository.findByEmployeeAndLocation.mockResolvedValue(
      staleSnapshot,
    );
    hcmClient.getBalance.mockResolvedValue({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
      sourceVersion: '2026-04-09T10:00:00.000Z#1',
      sourceUpdatedAt: '2026-04-09T10:00:00.000Z',
    });
    balanceSnapshotRepository.upsert.mockResolvedValue(refreshedSnapshot);
    timeOffRequestRepository.create.mockResolvedValue(createdRequest);
    balanceReservationRepository.create.mockResolvedValue(
      new BalanceReservationBuilder().fromRequest(createdRequest).build(),
    );
    auditLogRepository.create.mockResolvedValue({
      id: 'audit_1',
      action: 'TIME_OFF_REQUEST_CREATED',
      actorType: AuditActorType.EMPLOYEE,
      actorId: 'emp_alice',
      requestId: createdRequest.id,
      syncRunId: null,
      entityType: 'time_off_request',
      entityId: createdRequest.id,
      metadata: '{}',
      occurredAt: new Date(),
      createdAt: new Date(),
    });
    idempotencyKeyRepository.markStatus.mockResolvedValue(
      new IdempotencyKeyBuilder()
        .withId('idem_1')
        .withIdempotencyKey('request-create-1')
        .withStatus(IdempotencyStatus.COMPLETED)
        .build(),
    );

    const result = await service.execute({
      actorId: 'emp_alice',
      idempotencyKey: 'request-create-1',
      locationId: 'loc_ny',
      startDate: new Date('2026-05-11T00:00:00.000Z'),
      endDate: new Date('2026-05-12T00:00:00.000Z'),
      requestedUnits: 2000,
      reason: 'Family trip',
    });

    expect(hcmClient.getBalance).toHaveBeenCalledWith('emp_alice', 'loc_ny');
    expect(balanceSnapshotRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        availableUnits: 8000,
      }),
    );
    expect(timeOffRequestRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        requestedUnits: 2000,
        status: TimeOffRequestStatus.PENDING,
      }),
      expect.anything(),
    );
    expect(balanceReservationRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req_1',
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        reservedUnits: 2000,
        status: 'ACTIVE',
      }),
      expect.anything(),
    );
    expect(idempotencyKeyRepository.markStatus).toHaveBeenCalledWith(
      'idem_1',
      IdempotencyStatus.COMPLETED,
      expect.objectContaining({
        responseCode: 200,
      }),
    );
    expect(result).toBe(createdRequest);
  });

  it('replays completed idempotent requests without creating duplicates', async () => {
    const existingRequest = new TimeOffRequestBuilder()
      .withId('req_existing')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .build();

    idempotencyKeyRepository.findByScopeAndKey.mockResolvedValue(
      new IdempotencyKeyBuilder()
        .withIdempotencyKey('request-create-2')
        .withFingerprint(
          'emp_alice:loc_ny:2026-05-11T00:00:00.000Z:2026-05-12T00:00:00.000Z:2000:Family trip',
        )
        .withStatus(IdempotencyStatus.COMPLETED)
        .withResponse(200, {
          requestId: existingRequest.id,
        })
        .build(),
    );
    timeOffRequestRepository.findById.mockResolvedValue(existingRequest);

    const result = await service.execute({
      actorId: 'emp_alice',
      idempotencyKey: 'request-create-2',
      locationId: 'loc_ny',
      startDate: new Date('2026-05-11T00:00:00.000Z'),
      endDate: new Date('2026-05-12T00:00:00.000Z'),
      requestedUnits: 2000,
      reason: 'Family trip',
    });

    expect(result).toBe(existingRequest);
    expect(employeeRepository.findById).not.toHaveBeenCalled();
    expect(timeOffRequestRepository.create).not.toHaveBeenCalled();
    expect(balanceReservationRepository.create).not.toHaveBeenCalled();
  });

  it('marks the idempotency key as failed when effective balance is insufficient', async () => {
    const employee = new EmployeeBuilder()
      .withId('emp_alice')
      .withLocationId('loc_ny')
      .build();
    const freshSnapshot = new BalanceSnapshotBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withAvailableUnits(3000)
      .withLastSyncedAt(new Date())
      .build();
    const existingReservation = new BalanceReservationBuilder()
      .withRequestId('req_pending')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withReservedUnits(2000)
      .build();
    const idempotencyRecord = new IdempotencyKeyBuilder()
      .withId('idem_3')
      .withIdempotencyKey('request-create-3')
      .build();

    employeeRepository.findById.mockResolvedValue(employee);
    idempotencyKeyRepository.findByScopeAndKey.mockResolvedValue(null);
    idempotencyKeyRepository.create.mockResolvedValue(idempotencyRecord);
    balanceSnapshotRepository.findByEmployeeAndLocation.mockResolvedValue(
      freshSnapshot,
    );
    balanceReservationRepository.findActiveByEmployeeAndLocation.mockResolvedValue([
      existingReservation,
    ]);
    idempotencyKeyRepository.markStatus.mockResolvedValue(
      new IdempotencyKeyBuilder()
        .withId('idem_3')
        .withStatus(IdempotencyStatus.FAILED)
        .withErrorCode('INSUFFICIENT_BALANCE')
        .build(),
    );

    await expect(
      service.execute({
        actorId: 'emp_alice',
        idempotencyKey: 'request-create-3',
        locationId: 'loc_ny',
        startDate: new Date('2026-05-11T00:00:00.000Z'),
        endDate: new Date('2026-05-12T00:00:00.000Z'),
        requestedUnits: 2000,
        reason: 'Family trip',
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });

    expect(timeOffRequestRepository.create).not.toHaveBeenCalled();
    expect(balanceReservationRepository.create).not.toHaveBeenCalled();
    expect(idempotencyKeyRepository.markStatus).toHaveBeenCalledWith(
      'idem_3',
      IdempotencyStatus.FAILED,
      expect.objectContaining({
        errorCode: 'INSUFFICIENT_BALANCE',
      }),
    );
  });
});
