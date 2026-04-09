import { AddressInfo } from 'node:net';

import { INestApplication } from '@nestjs/common';
import { BalanceReservationStatus, TimeOffRequestStatus } from '@prisma/client';
import * as request from 'supertest';

import { createHttpApp } from '@app/testing';

import { AppModule as HcmMockAppModule } from '../../hcm-mock/src/app.module';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { prepareSqliteTestDatabase } from './support/sqlite-test-database';

const CREATE_TIME_OFF_REQUEST_MUTATION = `
  mutation CreateTimeOffRequest($input: CreateTimeOffRequestInput!) {
    createTimeOffRequest(input: $input) {
      id
      status
    }
  }
`;

const APPROVE_TIME_OFF_REQUEST_MUTATION = `
  mutation ApproveTimeOffRequest($input: ReviewTimeOffRequestInput!) {
    approveTimeOffRequest(input: $input) {
      id
      status
      approvedBy
    }
  }
`;

describe('reconciliation drift handling (e2e)', () => {
  let databaseCleanup: (() => void) | undefined;
  let hcmMockApp: INestApplication;
  let timeoffApp: INestApplication;
  let prisma: PrismaService;
  let previousDatabaseUrl: string | undefined;
  let previousHcmBaseUrl: string | undefined;
  let previousInternalSyncToken: string | undefined;

  beforeAll(async () => {
    const databaseHandle = prepareSqliteTestDatabase(
      'timeoff-reconciliation-drift.e2e.db',
    );

    databaseCleanup = databaseHandle.cleanup;
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousHcmBaseUrl = process.env.HCM_BASE_URL;
    previousInternalSyncToken = process.env.HCM_INTERNAL_SYNC_TOKEN;
    process.env.DATABASE_URL = databaseHandle.databaseUrl;
    process.env.HCM_INTERNAL_SYNC_TOKEN = 'test-internal-sync-token';

    hcmMockApp = await createHttpApp(HcmMockAppModule);
    await hcmMockApp.listen(0, '127.0.0.1');

    const hcmAddress = hcmMockApp.getHttpServer().address() as AddressInfo;

    process.env.HCM_BASE_URL = `http://127.0.0.1:${hcmAddress.port}`;

    timeoffApp = await createHttpApp(AppModule);
    prisma = timeoffApp.get(PrismaService);
  });

  beforeEach(async () => {
    await request(hcmMockApp.getHttpServer()).post('/scenarios/reset').expect(201);

    await prisma.auditLog.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.idempotencyKey.deleteMany();
    await prisma.balanceReservation.deleteMany();
    await prisma.timeOffRequest.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.balanceSnapshot.deleteMany();
    await prisma.employee.deleteMany();

    await prisma.employee.createMany({
      data: [
        {
          id: 'mgr_sam',
          email: 'sam@example.com',
          displayName: 'Sam Patel',
          locationId: 'loc_ny',
          managerId: null,
          isActive: true,
        },
        {
          id: 'emp_alice',
          email: 'alice@example.com',
          displayName: 'Alice Johnson',
          locationId: 'loc_ny',
          managerId: 'mgr_sam',
          isActive: true,
        },
      ],
    });
  });

  afterAll(async () => {
    await timeoffApp?.close();
    await hcmMockApp?.close();

    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }

    if (previousHcmBaseUrl === undefined) {
      delete process.env.HCM_BASE_URL;
    } else {
      process.env.HCM_BASE_URL = previousHcmBaseUrl;
    }

    if (previousInternalSyncToken === undefined) {
      delete process.env.HCM_INTERNAL_SYNC_TOKEN;
    } else {
      process.env.HCM_INTERNAL_SYNC_TOKEN = previousInternalSyncToken;
    }

    databaseCleanup?.();
  });

  it('flags a pending request for review when batch reconciliation detects balance drift', async () => {
    const requestId = await createEmployeeRequest('drift-create-1');

    await request(hcmMockApp.getHttpServer())
      .post('/scenarios/drift')
      .send({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        availableUnits: 1000,
        sourceUpdatedAt: '2026-04-10T09:00:00.000Z',
      })
      .expect(201);

    const syncResponse = await request(timeoffApp.getHttpServer())
      .post('/internal/hcm-sync/pull/balance-snapshots')
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .send({})
      .expect(201);

    const updatedRequest = await prisma.timeOffRequest.findUnique({
      where: { id: requestId },
    });
    const reservation = await prisma.balanceReservation.findUnique({
      where: { requestId },
    });
    const reconciliationEvents = await prisma.outboxEvent.findMany({
      where: {
        eventType: 'balance.reconciliation.flagged.v1',
      },
    });

    expect(syncResponse.body).toMatchObject({
      source: 'hcm-batch-pull',
      recordsApplied: 3,
      requestsFlagged: 1,
    });
    expect(updatedRequest?.status).toBe(TimeOffRequestStatus.REQUIRES_REVIEW);
    expect(reservation?.status).toBe(BalanceReservationStatus.RELEASED);
    expect(reconciliationEvents).toHaveLength(1);
    expect(JSON.parse(reconciliationEvents[0].payload)).toMatchObject({
      requestId,
      reason: 'Snapshot changed materially while request was pending',
    });
  });

  it('allows a manager to approve a reconciled request after a later HCM balance increase', async () => {
    const requestId = await createEmployeeRequest('drift-create-2');

    await request(hcmMockApp.getHttpServer())
      .post('/scenarios/drift')
      .send({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        availableUnits: 1000,
        sourceUpdatedAt: '2026-04-10T09:00:00.000Z',
      })
      .expect(201);
    const firstSyncResponse = await pullBatchSync();

    const reviewedRequest = await prisma.timeOffRequest.findUnique({
      where: { id: requestId },
    });
    const releasedReservation = await prisma.balanceReservation.findUnique({
      where: { requestId },
    });

    expect(firstSyncResponse.body).toMatchObject({
      source: 'hcm-batch-pull',
      requestsFlagged: 1,
    });
    expect(reviewedRequest?.status).toBe(TimeOffRequestStatus.REQUIRES_REVIEW);
    expect(releasedReservation?.status).toBe(BalanceReservationStatus.RELEASED);

    await request(hcmMockApp.getHttpServer())
      .post('/scenarios/drift')
      .send({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        availableUnits: 5000,
        sourceUpdatedAt: '2026-04-10T10:00:00.000Z',
      })
      .expect(201);
    await pullBatchSync();

    const approvalResponse = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'mgr_sam')
      .set('x-actor-role', 'MANAGER')
      .set('idempotency-key', 'drift-approve-2')
      .send({
        query: APPROVE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            requestId,
            reason: 'Approved after anniversary refresh',
          },
        },
      })
      .expect(200);

    const updatedRequest = await prisma.timeOffRequest.findUnique({
      where: { id: requestId },
    });
    const reservation = await prisma.balanceReservation.findUnique({
      where: { requestId },
    });

    expect(approvalResponse.body.errors).toBeUndefined();
    expect(approvalResponse.body.data.approveTimeOffRequest).toMatchObject({
      id: requestId,
      status: TimeOffRequestStatus.APPROVED,
      approvedBy: 'mgr_sam',
    });
    expect(updatedRequest?.status).toBe(TimeOffRequestStatus.APPROVED);
    expect(reservation?.status).toBe(BalanceReservationStatus.RELEASED);
  });

  async function createEmployeeRequest(idempotencyKey: string): Promise<string> {
    const response = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'emp_alice')
      .set('x-actor-role', 'EMPLOYEE')
      .set('idempotency-key', idempotencyKey)
      .send({
        query: CREATE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            locationId: 'loc_ny',
            startDate: '2026-05-11T00:00:00.000Z',
            endDate: '2026-05-12T00:00:00.000Z',
            requestedUnits: 2000,
            reason: 'Family trip',
          },
        },
      })
      .expect(200);

    return response.body.data.createTimeOffRequest.id as string;
  }

  async function pullBatchSync() {
    return request(timeoffApp.getHttpServer())
      .post('/internal/hcm-sync/pull/balance-snapshots')
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .send({})
      .expect(201);
  }
});
