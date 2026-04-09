import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';
import { CreateTimeOffRequestService } from './application/create-time-off-request.service';
import { ReviewTimeOffRequestService } from './application/review-time-off-request.service';
import { TimeOffRequestsResolver } from './api/graphql/time-off-requests.resolver';

@Module({
  imports: [DatabaseModule, HcmSyncModule],
  providers: [
    CreateTimeOffRequestService,
    ReviewTimeOffRequestService,
    TimeOffRequestsResolver,
  ],
  exports: [CreateTimeOffRequestService, ReviewTimeOffRequestService],
})
export class TimeOffRequestsModule {}
