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
      managerDecisionReason
    }
  }
`;

const REJECT_TIME_OFF_REQUEST_MUTATION = `
  mutation RejectTimeOffRequest($input: ReviewTimeOffRequestInput!) {
    rejectTimeOffRequest(input: $input) {
      id
      status
      managerDecisionReason
    }
  }
`;

describe('manager review mutations (e2e)', () => {
  let databaseCleanup: (() => void) | undefined;
  let hcmMockApp: INestApplication;
  let timeoffApp: INestApplication;
  let prisma: PrismaService;
  let previousDatabaseUrl: string | undefined;
  let previousHcmBaseUrl: string | undefined;

  beforeAll(async () => {
    const databaseHandle = prepareSqliteTestDatabase(
      'timeoff-request-review.e2e.db',
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

    databaseCleanup?.();
  });

  it('approves a pending request, consumes the reservation, and updates HCM balance', async () => {
    const requestId = await createEmployeeRequest('approve-create-1');

    const response = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'mgr_sam')
      .set('x-actor-role', 'MANAGER')
      .set('idempotency-key', 'approve-review-1')
      .send({
        query: APPROVE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            requestId,
            reason: 'Approved',
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
    const hcmBalance = await request(hcmMockApp.getHttpServer())
      .get('/hcm/balances/emp_alice')
      .query({ locationId: 'loc_ny' })
      .expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.approveTimeOffRequest).toMatchObject({
      id: requestId,
      status: TimeOffRequestStatus.APPROVED,
      approvedBy: 'mgr_sam',
      managerDecisionReason: 'Approved',
    });
    expect(updatedRequest).toMatchObject({
      status: TimeOffRequestStatus.APPROVED,
      approvedBy: 'mgr_sam',
    });
    expect(reservation).toMatchObject({
      status: BalanceReservationStatus.CONSUMED,
    });
    expect(hcmBalance.body.availableUnits).toBe(6000);
  });

  it('rejects a request and releases the reservation', async () => {
    const requestId = await createEmployeeRequest('reject-create-1');

    const response = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'mgr_sam')
      .set('x-actor-role', 'MANAGER')
      .set('idempotency-key', 'reject-review-1')
      .send({
        query: REJECT_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            requestId,
            reason: 'Coverage unavailable',
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

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.rejectTimeOffRequest).toMatchObject({
      id: requestId,
      status: TimeOffRequestStatus.REJECTED,
      managerDecisionReason: 'Coverage unavailable',
    });
    expect(updatedRequest?.status).toBe(TimeOffRequestStatus.REJECTED);
    expect(reservation?.status).toBe(BalanceReservationStatus.RELEASED);
  });

  it('moves the request to REQUIRES_REVIEW when HCM balance drift invalidates approval', async () => {
    const requestId = await createEmployeeRequest('review-create-1');

    await request(hcmMockApp.getHttpServer())
      .post('/scenarios/drift')
      .send({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        availableUnits: 1000,
        sourceUpdatedAt: '2026-04-10T09:00:00.000Z',
      })
      .expect(201);

    const response = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'mgr_sam')
      .set('x-actor-role', 'MANAGER')
      .set('idempotency-key', 'approve-review-2')
      .send({
        query: APPROVE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            requestId,
            reason: 'Needs recheck',
          },
        },
      })
      .expect(200);

    const reservation = await prisma.balanceReservation.findUnique({
      where: { requestId },
    });

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.approveTimeOffRequest).toMatchObject({
      id: requestId,
      status: TimeOffRequestStatus.REQUIRES_REVIEW,
    });
    expect(reservation?.status).toBe(BalanceReservationStatus.RELEASED);
  });

  it('moves the request to SYNC_FAILED when HCM write-through fails', async () => {
    const requestId = await createEmployeeRequest('sync-failed-create-1');

    await request(hcmMockApp.getHttpServer())
      .post('/scenarios/force-next-adjustment-error')
      .send({
        code: 'UPSTREAM_TIMEOUT',
        message: 'The mock HCM is simulating a transient outage.',
      })
      .expect(201);

    const response = await request(timeoffApp.getHttpServer())
      .post('/graphql')
      .set('x-actor-id', 'mgr_sam')
      .set('x-actor-role', 'MANAGER')
      .set('idempotency-key', 'approve-review-3')
      .send({
        query: APPROVE_TIME_OFF_REQUEST_MUTATION,
        variables: {
          input: {
            requestId,
            reason: 'Approve and sync',
          },
        },
      })
      .expect(200);

    const reservation = await prisma.balanceReservation.findUnique({
      where: { requestId },
    });

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.approveTimeOffRequest).toMatchObject({
      id: requestId,
      status: TimeOffRequestStatus.SYNC_FAILED,
    });
    expect(reservation?.status).toBe(BalanceReservationStatus.ACTIVE);
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
});
