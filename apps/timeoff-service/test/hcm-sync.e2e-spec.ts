import { AddressInfo } from 'node:net';

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

import {
  buildHcmBalancePayload,
  buildHcmBatchBalanceSnapshotRequest,
  createHttpApp,
} from '@app/testing';

import { AppModule as HcmMockAppModule } from '../../hcm-mock/src/app.module';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { HcmClient } from '../src/modules/hcm-sync/infrastructure/hcm.client';
import { prepareSqliteTestDatabase } from './support/sqlite-test-database';

describe('timeoff-service hcm sync (e2e)', () => {
  let databaseCleanup: (() => void) | undefined;
  let hcmMockApp: INestApplication;
  let timeoffApp: INestApplication;
  let prisma: PrismaService;
  let hcmClient: HcmClient;
  let previousDatabaseUrl: string | undefined;
  let previousHcmBaseUrl: string | undefined;
  let previousInternalSyncToken: string | undefined;

  beforeAll(async () => {
    const databaseHandle = prepareSqliteTestDatabase('timeoff-hcm-sync.e2e.db');

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
    hcmClient = timeoffApp.get(HcmClient);
  });

  beforeEach(async () => {
    await request(hcmMockApp.getHttpServer()).post('/scenarios/reset').expect(201);

    await prisma.auditLog.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.balanceSnapshot.deleteMany();
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

  it('matches the HCM realtime and batch contracts through the outbound client', async () => {
    const realtimeBalance = await hcmClient.getBalance('emp_alice', 'loc_ny');
    const batchPayload = await hcmClient.listBatchSnapshots();

    expect(realtimeBalance).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
    });
    expect(batchPayload.runId).toContain('mock-hcm-batch-');
    expect(batchPayload.records).toHaveLength(3);
    expect(batchPayload.records[0]).toEqual(
      expect.objectContaining({
        employeeId: expect.any(String),
        locationId: expect.any(String),
        availableUnits: expect.any(Number),
        sourceVersion: expect.any(String),
        sourceUpdatedAt: expect.any(String),
      }),
    );
  });

  it('imports pushed batch sync payloads and deduplicates repeated external run ids', async () => {
    const payload = buildHcmBatchBalanceSnapshotRequest({
      runId: 'push-run-1',
      sentAt: '2026-04-09T10:00:00.000Z',
      records: [
        buildHcmBalancePayload({
          employeeId: 'emp_push_alice',
          locationId: 'loc_ny',
          availableUnits: 7000,
          sourceVersion: 'push-v1-a',
          sourceUpdatedAt: '2026-04-09T09:59:00.000Z',
        }),
        buildHcmBalancePayload({
          employeeId: 'emp_push_bob',
          locationId: 'loc_sf',
          availableUnits: 11000,
          sourceVersion: 'push-v1-b',
          sourceUpdatedAt: '2026-04-09T09:59:30.000Z',
        }),
      ],
    });

    const firstResponse = await request(timeoffApp.getHttpServer())
      .post('/internal/hcm-sync/balance-snapshots')
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .send(payload)
      .expect(201);
    const secondResponse = await request(timeoffApp.getHttpServer())
      .post('/internal/hcm-sync/balance-snapshots')
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .send(payload)
      .expect(201);

    const snapshots = await prisma.balanceSnapshot.findMany({
      orderBy: [{ employeeId: 'asc' }, { locationId: 'asc' }],
    });
    const syncRuns = await prisma.syncRun.findMany();
    const auditLogs = await prisma.auditLog.findMany();

    expect(firstResponse.body).toMatchObject({
      externalRunId: 'push-run-1',
      source: 'hcm-batch-push',
      status: 'COMPLETED',
      recordsReceived: 2,
      recordsApplied: 2,
      reusedExistingRun: false,
    });
    expect(secondResponse.body).toMatchObject({
      externalRunId: 'push-run-1',
      reusedExistingRun: true,
    });
    expect(snapshots).toHaveLength(2);
    expect(syncRuns).toHaveLength(1);
    expect(auditLogs).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      employeeId: 'emp_push_alice',
      locationId: 'loc_ny',
      availableUnits: 7000,
      sourceVersion: 'push-v1-a',
    });
  });

  it('pulls HCM batch snapshots from the mock service and persists drifted balances', async () => {
    await request(hcmMockApp.getHttpServer())
      .post('/scenarios/drift')
      .send({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        deltaUnits: 1500,
        sourceUpdatedAt: '2026-04-09T10:05:00.000Z',
      })
      .expect(201);

    const response = await request(timeoffApp.getHttpServer())
      .post('/internal/hcm-sync/pull/balance-snapshots')
      .set('x-internal-sync-token', 'test-internal-sync-token')
      .send({})
      .expect(201);

    const aliceSnapshot = await prisma.balanceSnapshot.findUnique({
      where: {
        employeeId_locationId: {
          employeeId: 'emp_alice',
          locationId: 'loc_ny',
        },
      },
    });
    const syncRun = await prisma.syncRun.findUnique({
      where: {
        externalRunId: response.body.externalRunId,
      },
    });

    expect(response.body).toMatchObject({
      source: 'hcm-batch-pull',
      status: 'COMPLETED',
      recordsReceived: 3,
      recordsApplied: 3,
      reusedExistingRun: false,
    });
    expect(aliceSnapshot).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 9500,
      sourceVersion: expect.any(String),
    });
    expect(aliceSnapshot?.sourceUpdatedAt.toISOString()).toBe(
      '2026-04-09T10:05:00.000Z',
    );
    expect(syncRun?.source).toBe('hcm-batch-pull');
  });

  it('rejects batch sync endpoints when the internal token is missing', async () => {
    await request(timeoffApp.getHttpServer())
      .post('/internal/hcm-sync/pull/balance-snapshots')
      .send({})
      .expect(401);
  });
});
