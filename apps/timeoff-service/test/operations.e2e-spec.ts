import { AddressInfo } from 'node:net';

import { INestApplication } from '@nestjs/common';
import {
  BalanceReservationStatus,
  OutboxEventStatus,
  TimeOffRequestStatus,
} from '@prisma/client';
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
    }
  }
`;

describe('operational outbox and audit flows (e2e)', () => {
  let databaseCleanup: (() => void) | undefined;
  let hcmMockApp: INestApplication;
  let timeoffApp: INestApplication;
  let prisma: PrismaService;
  let previousDatabaseUrl: string | undefined;
  let previousHcmBaseUrl: string | undefined;
  let previousInternalSyncToken: string | undefined;

  beforeAll(async () => {
    const databaseHandle = prepareSqliteTestDatabase('timeoff-operations.e2e.db');

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

  it('retries a failed approval from the outbox and exposes the request audit trail', async () => {
    const requestId = await createEmployeeRequest('ops-create-1');

    await request(hcmMockApp.getHttpServer())
      .post('/scenarios/force-next-adjustment-error')
      .send({
        code: 'UPSTREAM_TIMEOUT',
        message: 'The mock HCM is simulating a transient outage.',
      })
      .expect(201);

    await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'mgr_sam')
      .set('x-actor-role', 'MANAGER')
      .set('idempotency-key', 'ops-approve-1')
      .send({
        query: APPROVE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            requestId,
            reason: 'Approve and retry if needed',
          },
        },
      })
      .expect(200);

    const processResponse = await request(timeoffApp.getHttpServer())
      .post('/internal/outbox/process')
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .send({})
      .expect(201);

    const updatedRequest = await prisma.timeOffRequest.findUnique({
      where: { id: requestId },
    });
    const outboxEvent = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: requestId,
      },
    });
    const auditTrailResponse = await request(timeoffApp.getHttpServer())
      .get(`/internal/audit/requests/${requestId}`)
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .expect(200);

    expect(processResponse.body).toEqual({
      failedPermanently: 0,
      processed: 1,
      releasedForReview: 0,
      retried: 0,
      succeeded: 1,
    });
    expect(updatedRequest?.status).toBe(TimeOffRequestStatus.APPROVED);
    expect(outboxEvent?.status).toBe(OutboxEventStatus.SENT);
    expect(auditTrailResponse.body.map((entry: { action: string }) => entry.action))
      .toEqual([
        'TIME_OFF_REQUEST_CREATED',
        'TIME_OFF_REQUEST_SYNC_FAILED',
        'TIME_OFF_REQUEST_SYNC_RETRY_ENQUEUED',
        'TIME_OFF_REQUEST_SYNC_RETRY_SUCCEEDED',
      ]);
  });

  it('exposes the sync-run audit trail for a batch import', async () => {
    const syncResponse = await request(timeoffApp.getHttpServer())
      .post('/internal/hcm-sync/pull/balance-snapshots')
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .send({})
      .expect(201);

    const auditTrailResponse = await request(timeoffApp.getHttpServer())
      .get(`/internal/audit/sync-runs/${syncResponse.body.syncRunId}`)
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .expect(200);

    expect(auditTrailResponse.body).toHaveLength(4);
    expect(auditTrailResponse.body.map((entry: { action: string }) => entry.action))
      .toEqual([
        'HCM_BALANCE_SNAPSHOT_UPDATED',
        'HCM_BALANCE_SNAPSHOT_UPDATED',
        'HCM_BALANCE_SNAPSHOT_UPDATED',
        'HCM_BALANCE_BATCH_SYNC_COMPLETED',
      ]);
  });

  it('skips a queued retry after batch reconciliation moves the request to REQUIRES_REVIEW', async () => {
    const requestId = await createEmployeeRequest('ops-create-2');

    await request(hcmMockApp.getHttpServer())
      .post('/scenarios/force-next-adjustment-error')
      .send({
        code: 'UPSTREAM_TIMEOUT',
        message: 'The mock HCM is simulating a transient outage.',
      })
      .expect(201);

    await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'mgr_sam')
      .set('x-actor-role', 'MANAGER')
      .set('idempotency-key', 'ops-approve-2')
      .send({
        query: APPROVE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            requestId,
            reason: 'Approve and retry if needed',
          },
        },
      })
      .expect(200);

    await request(hcmMockApp.getHttpServer())
      .post('/scenarios/drift')
      .send({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        availableUnits: 1000,
        sourceUpdatedAt: '2026-04-10T09:00:00.000Z',
      })
      .expect(201);

    const syncResponse = await pullBatchSync();

    const processResponse = await request(timeoffApp.getHttpServer())
      .post('/internal/outbox/process')
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .send({})
      .expect(201);

    const updatedRequest = await prisma.timeOffRequest.findUnique({
      where: { id: requestId },
    });
    const reservation = await prisma.balanceReservation.findUnique({
      where: { requestId },
    });
    const outboxEvent = await prisma.outboxEvent.findFirst({
      where: { aggregateId: requestId },
    });
    const auditTrailResponse = await request(timeoffApp.getHttpServer())
      .get(`/internal/audit/requests/${requestId}`)
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .expect(200);

    expect(syncResponse.body.requestsFlagged).toBe(1);
    expect(processResponse.body.processed).toBeGreaterThanOrEqual(1);
    expect(processResponse.body.releasedForReview).toBe(0);
    expect(processResponse.body.retried).toBe(0);
    expect(processResponse.body.succeeded).toBe(0);
    expect(updatedRequest?.status).toBe(TimeOffRequestStatus.REQUIRES_REVIEW);
    expect(reservation?.status).toBe(BalanceReservationStatus.RELEASED);
    expect(outboxEvent?.status).toBe(OutboxEventStatus.SENT);
    expect(auditTrailResponse.body.map((entry: { action: string }) => entry.action))
      .toEqual([
        'TIME_OFF_REQUEST_CREATED',
        'TIME_OFF_REQUEST_SYNC_FAILED',
        'TIME_OFF_REQUEST_SYNC_RETRY_ENQUEUED',
        'BALANCE_RECONCILIATION_FLAGGED',
        'OUTBOX_EVENT_SKIPPED',
      ]);
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
