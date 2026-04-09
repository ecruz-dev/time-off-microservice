import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { HcmSyncModule } from './modules/hcm-sync/hcm-sync.module';

@Module({
  imports: [DatabaseModule, HealthModule, HcmSyncModule],
})
export class AppModule {}
