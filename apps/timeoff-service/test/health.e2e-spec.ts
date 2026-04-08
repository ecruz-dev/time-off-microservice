import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

import { createHttpApp } from '@app/testing';

import { AppModule } from '../src/app.module';

describe('timeoff-service health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createHttpApp(AppModule);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a healthy status payload', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'timeoff-service',
    });
    expect(typeof response.body.timestamp).toBe('string');
  });
});
