import { Module } from '@nestjs/common';

import { getHcmRuntimeConfig } from '@app/config';

import { DatabaseModule } from '../../database/database.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { HCM_RUNTIME_CONFIG } from './hcm-sync.constants';
import { HcmSyncController } from './api/rest/hcm-sync.controller';
import { InternalSyncTokenGuard } from './api/rest/internal-sync-token.guard';
import { HcmSyncService } from './application/hcm-sync.service';
import { HcmClient } from './infrastructure/hcm.client';

@Module({
  imports: [DatabaseModule, ReconciliationModule],
  controllers: [HcmSyncController],
  providers: [
    {
      provide: HCM_RUNTIME_CONFIG,
      useFactory: () => getHcmRuntimeConfig(),
    },
    HcmClient,
    HcmSyncService,
    InternalSyncTokenGuard,
  ],
  exports: [HcmClient, HcmSyncService],
})
export class HcmSyncModule {}
