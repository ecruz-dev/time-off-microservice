import { Module } from '@nestjs/common';

import { getOutboxRuntimeConfig } from '../../../../../libs/config/src';

import { DatabaseModule } from '../../database/database.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';
import { OutboxController } from './api/rest/outbox.controller';
import { OutboxProcessorService } from './application/outbox-processor.service';
import { OUTBOX_RUNTIME_CONFIG } from './outbox.constants';

@Module({
  imports: [DatabaseModule, HcmSyncModule],
  controllers: [OutboxController],
  providers: [
    {
      provide: OUTBOX_RUNTIME_CONFIG,
      useFactory: () => getOutboxRuntimeConfig(),
    },
    OutboxProcessorService,
  ],
  exports: [OutboxProcessorService],
})
export class OutboxModule {}
