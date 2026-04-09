import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';
import { OperationalAuditController } from './api/rest/operational-audit.controller';
import { OperationalAuditService } from './application/operational-audit.service';

@Module({
  imports: [DatabaseModule, HcmSyncModule],
  controllers: [OperationalAuditController],
  providers: [OperationalAuditService],
  exports: [OperationalAuditService],
})
export class OperationalAuditModule {}
