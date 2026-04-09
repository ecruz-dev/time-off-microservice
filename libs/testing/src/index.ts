import { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';

export async function createHttpApp(
  rootModule: Type<unknown>,
): Promise<INestApplication> {
  const testingModule = await Test.createTestingModule({
    imports: [rootModule],
  }).compile();

  const app = testingModule.createNestApplication();
  await app.init();

  return app;
}

export * from './builders';
export * from './clock/test-clock';
export * from './fixtures';
export * from './hcm';
