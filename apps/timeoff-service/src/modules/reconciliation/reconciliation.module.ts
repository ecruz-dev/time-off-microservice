import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { ReconciliationService } from './application/reconciliation.service';

@Module({
  imports: [DatabaseModule],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
