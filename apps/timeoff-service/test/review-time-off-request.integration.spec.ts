import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BalanceReservationStatus, TimeOffRequestStatus } from '@prisma/client';

import { EmployeeBuilder } from '@app/testing';

import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { ReviewTimeOffRequestService } from '../src/modules/time-off-requests/application/review-time-off-request.service';
import { HcmClient } from '../src/modules/hcm-sync/infrastructure/hcm.client';
import { prepareSqliteTestDatabase } from './support/sqlite-test-database';

describe('ReviewTimeOffRequestService (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: ReviewTimeOffRequestService;
  let hcmClientMock: jest.Mocked<
    Pick<HcmClient, 'applyBalanceAdjustment' | 'getBalance'>
  >;
  let databaseCleanup: (() => void) | undefined;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    const databaseHandle = prepareSqliteTestDatabase(
      'timeoff-request-review.integration.db',
    );

    databaseCleanup = databaseHandle.cleanup;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseHandle.databaseUrl;
    hcmClientMock = {
      applyBalanceAdjustment: jest.fn(),
      getBalance: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        ReviewTimeOffRequestService,
        {
          provide: HcmClient,
          useValue: hcmClientMock,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    service = app.get(ReviewTimeOffRequestService);
  });

  beforeEach(async () => {
    hcmClientMock.getBalance.mockReset();
    hcmClientMock.applyBalanceAdjustment.mockReset();
    await prisma.auditLog.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.idempotencyKey.deleteMany();
    await prisma.balanceReservation.deleteMany();
    await prisma.timeOffRequest.deleteMany();
    await prisma.balanceSnapshot.deleteMany();
    await prisma.employee.deleteMany();

    await prisma.employee.create({
      data: new EmployeeBuilder()
        .withId('mgr_sam')
        .withEmail('sam@example.com')
        .withDisplayName('Sam Patel')
        .withLocationId('loc_ny')
        .toCreateInput(),
    });
    await prisma.employee.create({
      data: new EmployeeBuilder()
        .withId('emp_alice')
        .withEmail('alice@example.com')
        .withDisplayName('Alice Johnson')
        .withLocationId('loc_ny')
        .withManagerId('mgr_sam')
        .toCreateInput(),
    });
  });

  afterAll(async () => {
    await app?.close();

    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }

    databaseCleanup?.();
  });

  it('approves the request, consumes the reservation, and updates the snapshot', async () => {
    const requestRecord = await prisma.timeOffRequest.create({
      data: {
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        startDate: new Date('2026-05-11T00:00:00.000Z'),
        endDate: new Date('2026-05-12T00:00:00.000Z'),
        requestedUnits: 2000,
        reason: 'Family trip',
        status: TimeOffRequestStatus.PENDING,
        createdBy: 'emp_alice',
      },
    });

    await prisma.balanceReservation.create({
      data: {
        requestId: requestRecord.id,
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        reservedUnits: 2000,
        status: BalanceReservationStatus.ACTIVE,
      },
    });

    hcmClientMock.getBalance.mockResolvedValue({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
      sourceVersion: '2026-04-09T12:00:00.000Z#1',
      sourceUpdatedAt: '2026-04-09T12:00:00.000Z',
    });
    hcmClientMock.applyBalanceAdjustment.mockResolvedValue({
      accepted: true,
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 6000,
      sourceVersion: '2026-04-09T12:01:00.000Z#2',
      sourceUpdatedAt: '2026-04-09T12:01:00.000Z',
    });

    const result = await service.execute({
      actorId: 'mgr_sam',
      decision: 'APPROVE',
      idempotencyKey: 'integration-approve-1',
      reason: 'Approved',
      requestId: requestRecord.id,
    });

    const updatedRequest = await prisma.timeOffRequest.findUnique({
      where: { id: requestRecord.id },
    });
    const reservation = await prisma.balanceReservation.findUnique({
      where: { requestId: requestRecord.id },
    });
    const snapshot = await prisma.balanceSnapshot.findUnique({
      where: {
        employeeId_locationId: {
          employeeId: 'emp_alice',
          locationId: 'loc_ny',
        },
      },
    });

    expect(result.status).toBe(TimeOffRequestStatus.APPROVED);
    expect(updatedRequest).toMatchObject({
      status: TimeOffRequestStatus.APPROVED,
      approvedBy: 'mgr_sam',
    });
    expect(reservation).toMatchObject({
      status: BalanceReservationStatus.CONSUMED,
    });
    expect(snapshot).toMatchObject({
      availableUnits: 6000,
      sourceVersion: '2026-04-09T12:01:00.000Z#2',
    });
  });

  it('rejects the request and releases the reservation', async () => {
    const requestRecord = await prisma.timeOffRequest.create({
      data: {
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        startDate: new Date('2026-05-15T00:00:00.000Z'),
        endDate: new Date('2026-05-16T00:00:00.000Z'),
        requestedUnits: 2000,
        reason: 'Conference',
        status: TimeOffRequestStatus.PENDING,
        createdBy: 'emp_alice',
      },
    });

    await prisma.balanceReservation.create({
      data: {
        requestId: requestRecord.id,
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        reservedUnits: 2000,
        status: BalanceReservationStatus.ACTIVE,
      },
    });

    const result = await service.execute({
      actorId: 'mgr_sam',
      decision: 'REJECT',
      idempotencyKey: 'integration-reject-1',
      reason: 'Coverage unavailable',
      requestId: requestRecord.id,
    });

    const updatedRequest = await prisma.timeOffRequest.findUnique({
      where: { id: requestRecord.id },
    });
    const reservation = await prisma.balanceReservation.findUnique({
      where: { requestId: requestRecord.id },
    });

    expect(result.status).toBe(TimeOffRequestStatus.REJECTED);
    expect(updatedRequest).toMatchObject({
      status: TimeOffRequestStatus.REJECTED,
      managerDecisionReason: 'Coverage unavailable',
    });
    expect(reservation).toMatchObject({
      status: BalanceReservationStatus.RELEASED,
    });
  });

  it('approves a reconciled request without re-consuming a released reservation', async () => {
    const requestRecord = await prisma.timeOffRequest.create({
      data: {
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        startDate: new Date('2026-05-20T00:00:00.000Z'),
        endDate: new Date('2026-05-21T00:00:00.000Z'),
        requestedUnits: 2000,
        reason: 'Anniversary leave',
        status: TimeOffRequestStatus.REQUIRES_REVIEW,
        createdBy: 'emp_alice',
      },
    });

    await prisma.balanceReservation.create({
      data: {
        requestId: requestRecord.id,
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        reservedUnits: 2000,
        status: BalanceReservationStatus.RELEASED,
      },
    });

    hcmClientMock.getBalance.mockResolvedValue({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
      sourceVersion: '2026-04-10T12:00:00.000Z#3',
      sourceUpdatedAt: '2026-04-10T12:00:00.000Z',
    });
    hcmClientMock.applyBalanceAdjustment.mockResolvedValue({
      accepted: true,
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 6000,
      sourceVersion: '2026-04-10T12:01:00.000Z#4',
      sourceUpdatedAt: '2026-04-10T12:01:00.000Z',
    });

    const result = await service.execute({
      actorId: 'mgr_sam',
      decision: 'APPROVE',
      idempotencyKey: 'integration-approve-released-1',
      reason: 'Approved after HCM anniversary refresh',
      requestId: requestRecord.id,
    });

    const updatedRequest = await prisma.timeOffRequest.findUnique({
      where: { id: requestRecord.id },
    });
    const reservation = await prisma.balanceReservation.findUnique({
      where: { requestId: requestRecord.id },
    });
    const snapshot = await prisma.balanceSnapshot.findUnique({
      where: {
        employeeId_locationId: {
          employeeId: 'emp_alice',
          locationId: 'loc_ny',
        },
      },
    });

    expect(result.status).toBe(TimeOffRequestStatus.APPROVED);
    expect(updatedRequest).toMatchObject({
      status: TimeOffRequestStatus.APPROVED,
      approvedBy: 'mgr_sam',
      managerDecisionReason: 'Approved after HCM anniversary refresh',
    });
    expect(reservation).toMatchObject({
      status: BalanceReservationStatus.RELEASED,
    });
    expect(snapshot).toMatchObject({
      availableUnits: 6000,
      sourceVersion: '2026-04-10T12:01:00.000Z#4',
    });
  });
});
