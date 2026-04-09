import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

import {
  buildHcmBalanceAdjustmentRequest,
  createHttpApp,
} from '@app/testing';

import { AppModule } from '../src/app.module';

describe('hcm-mock balances (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createHttpApp(AppModule);
  });

  beforeEach(async () => {
    await request(app.getHttpServer()).post('/scenarios/reset').expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns seeded realtime balances', async () => {
    const response = await request(app.getHttpServer())
      .get('/hcm/balances/emp_alice')
      .query({ locationId: 'loc_ny' })
      .expect(200);

    expect(response.body).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
    });
    expect(typeof response.body.sourceVersion).toBe('string');
    expect(typeof response.body.sourceUpdatedAt).toBe('string');
  });

  it('applies adjustments idempotently', async () => {
    const adjustmentRequest = buildHcmBalanceAdjustmentRequest({
      idempotencyKey: 'idem-adjustment-1',
      requestId: 'req_approval_1',
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      deltaUnits: -2000,
      occurredAt: '2026-04-08T16:00:00.000Z',
    });

    const firstResponse = await request(app.getHttpServer())
      .post('/hcm/balance-adjustments')
      .send(adjustmentRequest)
      .expect(201);
    const secondResponse = await request(app.getHttpServer())
      .post('/hcm/balance-adjustments')
      .send(adjustmentRequest)
      .expect(201);

    expect(firstResponse.body).toEqual(secondResponse.body);
    expect(firstResponse.body).toMatchObject({
      accepted: true,
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 6000,
    });
  });

  it('returns a validation failure when balance would go negative', async () => {
    const adjustmentRequest = buildHcmBalanceAdjustmentRequest({
      idempotencyKey: 'idem-adjustment-2',
      requestId: 'req_approval_2',
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      deltaUnits: -9000,
    });

    const adjustmentResponse = await request(app.getHttpServer())
      .post('/hcm/balance-adjustments')
      .send(adjustmentRequest)
      .expect(201);
    const balanceResponse = await request(app.getHttpServer())
      .get('/hcm/balances/emp_alice')
      .query({ locationId: 'loc_ny' })
      .expect(200);

    expect(adjustmentResponse.body).toEqual({
      accepted: false,
      code: 'INSUFFICIENT_BALANCE',
      message: 'Available balance is lower than requested deduction.',
    });
    expect(balanceResponse.body.availableUnits).toBe(8000);
  });

  it('can disable insufficient balance validation to simulate defensive cases', async () => {
    await request(app.getHttpServer())
      .patch('/scenarios/settings')
      .send({
        enforceInsufficientBalanceErrors: false,
      })
      .expect(200);

    const adjustmentRequest = buildHcmBalanceAdjustmentRequest({
      idempotencyKey: 'idem-adjustment-3',
      requestId: 'req_approval_3',
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      deltaUnits: -9000,
    });

    const adjustmentResponse = await request(app.getHttpServer())
      .post('/hcm/balance-adjustments')
      .send(adjustmentRequest)
      .expect(201);

    expect(adjustmentResponse.body).toMatchObject({
      accepted: true,
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: -1000,
    });
  });

  it('exports the balance corpus through the batch endpoint', async () => {
    const response = await request(app.getHttpServer())
      .get('/hcm/balance-snapshots')
      .expect(200);

    expect(response.body.runId).toContain('mock-hcm-batch-');
    expect(Array.isArray(response.body.records)).toBe(true);
    expect(response.body.records).toHaveLength(3);
    expect(response.body.records[0]).toEqual(
      expect.objectContaining({
        employeeId: expect.any(String),
        locationId: expect.any(String),
        availableUnits: expect.any(Number),
        sourceVersion: expect.any(String),
        sourceUpdatedAt: expect.any(String),
      }),
    );
  });

  it('supports drift and forced adjustment failures for scenario control', async () => {
    const driftResponse = await request(app.getHttpServer())
      .post('/scenarios/drift')
      .send({
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        deltaUnits: 1500,
        sourceUpdatedAt: '2026-04-08T16:30:00.000Z',
      })
      .expect(201);

    expect(driftResponse.body).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 9500,
      sourceUpdatedAt: '2026-04-08T16:30:00.000Z',
    });

    await request(app.getHttpServer())
      .post('/scenarios/force-next-adjustment-error')
      .send({
        code: 'UPSTREAM_TIMEOUT',
        message: 'The mock HCM is simulating a transient outage.',
      })
      .expect(201);

    const adjustmentResponse = await request(app.getHttpServer())
      .post('/hcm/balance-adjustments')
      .send(
        buildHcmBalanceAdjustmentRequest({
          idempotencyKey: 'idem-adjustment-4',
          requestId: 'req_approval_4',
          employeeId: 'emp_alice',
          locationId: 'loc_ny',
        }),
      )
      .expect(201);

    expect(adjustmentResponse.body).toEqual({
      accepted: false,
      code: 'UPSTREAM_TIMEOUT',
      message: 'The mock HCM is simulating a transient outage.',
    });
  });
});
