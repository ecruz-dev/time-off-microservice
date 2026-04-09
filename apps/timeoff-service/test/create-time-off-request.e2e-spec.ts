import { AddressInfo } from 'node:net';

import { INestApplication } from '@nestjs/common';
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
      employeeId
      locationId
      requestedUnits
      reason
      status
      startDate
      endDate
      createdAt
      updatedAt
    }
  }
`;

describe('createTimeOffRequest mutation (e2e)', () => {
  let databaseCleanup: (() => void) | undefined;
  let hcmMockApp: INestApplication;
  let timeoffApp: INestApplication;
  let prisma: PrismaService;
  let previousDatabaseUrl: string | undefined;
  let previousHcmBaseUrl: string | undefined;

  beforeAll(async () => {
    const databaseHandle = prepareSqliteTestDatabase(
      'timeoff-request-create.e2e.db',
    );

    databaseCleanup = databaseHandle.cleanup;
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousHcmBaseUrl = process.env.HCM_BASE_URL;
    process.env.DATABASE_URL = databaseHandle.databaseUrl;

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
    await prisma.idempotencyKey.deleteMany();
    await prisma.balanceReservation.deleteMany();
    await prisma.timeOffRequest.deleteMany();
    await prisma.balanceSnapshot.deleteMany();
    await prisma.employee.deleteMany();

    await prisma.employee.create({
      data: {
        id: 'emp_alice',
        email: 'alice@example.com',
        displayName: 'Alice Johnson',
        locationId: 'loc_ny',
        managerId: 'mgr_sam',
        isActive: true,
      },
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

    databaseCleanup?.();
  });

  it('creates a pending request and reservation through GraphQL', async () => {
    const response = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'emp_alice')
      .set('x-actor-role', 'EMPLOYEE')
      .set('idempotency-key', 'graphql-create-1')
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

    const createdRequest = response.body.data.createTimeOffRequest;
    const reservation = await prisma.balanceReservation.findUnique({
      where: { requestId: createdRequest.id },
    });
    const snapshot = await prisma.balanceSnapshot.findUnique({
      where: {
        employeeId_locationId: {
          employeeId: 'emp_alice',
          locationId: 'loc_ny',
        },
      },
    });

    expect(response.body.errors).toBeUndefined();
    expect(createdRequest).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      requestedUnits: 2000,
      reason: 'Family trip',
      status: 'PENDING',
    });
    expect(reservation).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      reservedUnits: 2000,
      status: 'ACTIVE',
    });
    expect(snapshot).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
    });
  });

  it('replays the same mutation result for the same idempotency key', async () => {
    const firstResponse = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'emp_alice')
      .set('x-actor-role', 'EMPLOYEE')
      .set('idempotency-key', 'graphql-create-2')
      .send({
        query: CREATE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            locationId: 'loc_ny',
            startDate: '2026-05-20T00:00:00.000Z',
            endDate: '2026-05-21T00:00:00.000Z',
            requestedUnits: 2000,
            reason: 'Conference',
          },
        },
      })
      .expect(200);
    const secondResponse = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'emp_alice')
      .set('x-actor-role', 'EMPLOYEE')
      .set('idempotency-key', 'graphql-create-2')
      .send({
        query: CREATE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            locationId: 'loc_ny',
            startDate: '2026-05-20T00:00:00.000Z',
            endDate: '2026-05-21T00:00:00.000Z',
            requestedUnits: 2000,
            reason: 'Conference',
          },
        },
      })
      .expect(200);

    expect(secondResponse.body.errors).toBeUndefined();
    expect(firstResponse.body.data.createTimeOffRequest.id).toBe(
      secondResponse.body.data.createTimeOffRequest.id,
    );
    expect(await prisma.timeOffRequest.count()).toBe(1);
    expect(await prisma.balanceReservation.count()).toBe(1);
    expect(await prisma.idempotencyKey.count()).toBe(1);
  });

  it('guards against stale-balance oversubscription once another request has already reserved time', async () => {
    const firstResponse = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'emp_alice')
      .set('x-actor-role', 'EMPLOYEE')
      .set('idempotency-key', 'graphql-create-oversubscribe-1')
      .send({
        query: CREATE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            locationId: 'loc_ny',
            startDate: '2026-06-10T00:00:00.000Z',
            endDate: '2026-06-11T00:00:00.000Z',
            requestedUnits: 6000,
            reason: 'Summer trip',
          },
        },
      })
      .expect(200);

    const secondResponse = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'emp_alice')
      .set('x-actor-role', 'EMPLOYEE')
      .set('idempotency-key', 'graphql-create-oversubscribe-2')
      .send({
        query: CREATE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            locationId: 'loc_ny',
            startDate: '2026-06-12T00:00:00.000Z',
            endDate: '2026-06-13T00:00:00.000Z',
            requestedUnits: 3000,
            reason: 'Extension',
          },
        },
      })
      .expect(200);

    expect(firstResponse.body.errors).toBeUndefined();
    expect(secondResponse.body.data).toBeNull();
    expect(secondResponse.body.errors[0].extensions.code).toBe(
      'INSUFFICIENT_BALANCE',
    );
    expect(await prisma.timeOffRequest.count()).toBe(1);
    expect(await prisma.balanceReservation.count()).toBe(1);
  });

  it('returns a GraphQL error when the employee does not have sufficient balance', async () => {
    const response = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'emp_alice')
      .set('x-actor-role', 'EMPLOYEE')
      .set('idempotency-key', 'graphql-create-3')
      .send({
        query: CREATE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            locationId: 'loc_ny',
            startDate: '2026-06-01T00:00:00.000Z',
            endDate: '2026-06-02T00:00:00.000Z',
            requestedUnits: 9000,
            reason: 'Long trip',
          },
        },
      })
      .expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors[0].extensions.code).toBe('INSUFFICIENT_BALANCE');
    expect(await prisma.timeOffRequest.count()).toBe(0);
    expect(await prisma.balanceReservation.count()).toBe(0);
  });
});
