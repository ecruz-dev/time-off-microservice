import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  EmployeeBuilder,
} from '@app/testing';

import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { CreateTimeOffRequestService } from '../src/modules/time-off-requests/application/create-time-off-request.service';
import { HcmClient } from '../src/modules/hcm-sync/infrastructure/hcm.client';
import { prepareSqliteTestDatabase } from './support/sqlite-test-database';

describe('CreateTimeOffRequestService (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: CreateTimeOffRequestService;
  let hcmClientMock: jest.Mocked<Pick<HcmClient, 'getBalance'>>;
  let databaseCleanup: (() => void) | undefined;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    const databaseHandle = prepareSqliteTestDatabase(
      'timeoff-request-create.integration.db',
    );

    databaseCleanup = databaseHandle.cleanup;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseHandle.databaseUrl;
    hcmClientMock = {
      getBalance: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        CreateTimeOffRequestService,
        {
          provide: HcmClient,
          useValue: hcmClientMock,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    service = app.get(CreateTimeOffRequestService);
  });

  beforeEach(async () => {
    hcmClientMock.getBalance.mockReset();
    await prisma.auditLog.deleteMany();
    await prisma.idempotencyKey.deleteMany();
    await prisma.balanceReservation.deleteMany();
    await prisma.timeOffRequest.deleteMany();
    await prisma.balanceSnapshot.deleteMany();
    await prisma.employee.deleteMany();

    await prisma.employee.create({
      data: new EmployeeBuilder()
        .withId('emp_alice')
        .withEmail('alice@example.com')
        .withDisplayName('Alice Johnson')
        .withLocationId('loc_ny')
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

  it('persists the request, reservation, audit log, snapshot, and idempotency record', async () => {
    hcmClientMock.getBalance.mockResolvedValue({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
      sourceVersion: '2026-04-09T10:00:00.000Z#1',
      sourceUpdatedAt: '2026-04-09T10:00:00.000Z',
    });

    const result = await service.execute({
      actorId: 'emp_alice',
      idempotencyKey: 'integration-create-1',
      locationId: 'loc_ny',
      startDate: new Date('2026-05-11T00:00:00.000Z'),
      endDate: new Date('2026-05-12T00:00:00.000Z'),
      requestedUnits: 2000,
      reason: 'Family trip',
    });

    const requestRecord = await prisma.timeOffRequest.findUnique({
      where: { id: result.id },
    });
    const reservationRecord = await prisma.balanceReservation.findUnique({
      where: { requestId: result.id },
    });
    const auditLogs = await prisma.auditLog.findMany({
      where: { requestId: result.id },
    });
    const snapshot = await prisma.balanceSnapshot.findUnique({
      where: {
        employeeId_locationId: {
          employeeId: 'emp_alice',
          locationId: 'loc_ny',
        },
      },
    });
    const idempotencyRecord = await prisma.idempotencyKey.findUnique({
      where: {
        scope_idempotencyKey: {
          scope: 'timeoff.create',
          idempotencyKey: 'integration-create-1',
        },
      },
    });

    expect(result.status).toBe('PENDING');
    expect(requestRecord).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      requestedUnits: 2000,
      status: 'PENDING',
    });
    expect(reservationRecord).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      reservedUnits: 2000,
      status: 'ACTIVE',
    });
    expect(auditLogs).toHaveLength(1);
    expect(snapshot).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
    });
    expect(idempotencyRecord).toMatchObject({
      scope: 'timeoff.create',
      idempotencyKey: 'integration-create-1',
      status: 'COMPLETED',
    });
  });

  it('replays a completed idempotent create without creating duplicate rows', async () => {
    hcmClientMock.getBalance.mockResolvedValue({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
      sourceVersion: '2026-04-09T10:00:00.000Z#2',
      sourceUpdatedAt: '2026-04-09T10:00:00.000Z',
    });

    const firstResult = await service.execute({
      actorId: 'emp_alice',
      idempotencyKey: 'integration-create-2',
      locationId: 'loc_ny',
      startDate: new Date('2026-05-20T00:00:00.000Z'),
      endDate: new Date('2026-05-21T00:00:00.000Z'),
      requestedUnits: 2000,
      reason: 'Conference',
    });
    const secondResult = await service.execute({
      actorId: 'emp_alice',
      idempotencyKey: 'integration-create-2',
      locationId: 'loc_ny',
      startDate: new Date('2026-05-20T00:00:00.000Z'),
      endDate: new Date('2026-05-21T00:00:00.000Z'),
      requestedUnits: 2000,
      reason: 'Conference',
    });

    expect(firstResult.id).toBe(secondResult.id);
    expect(await prisma.timeOffRequest.count()).toBe(1);
    expect(await prisma.balanceReservation.count()).toBe(1);
    expect(await prisma.idempotencyKey.count()).toBe(1);
    expect(hcmClientMock.getBalance).toHaveBeenCalledTimes(1);
  });
});
