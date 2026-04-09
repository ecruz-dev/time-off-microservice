import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { getHttpRuntimeConfig } from '../../../libs/config/src';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const runtimeConfig = getHttpRuntimeConfig({
    portEnv: 'TIMEOFF_SERVICE_PORT',
    defaultPort: 3000,
  });

  await app.listen(runtimeConfig.port, runtimeConfig.host);

  Logger.log(
    `timeoff-service listening on http://${runtimeConfig.host}:${runtimeConfig.port}`,
    'Bootstrap',
  );
}

void bootstrap();
