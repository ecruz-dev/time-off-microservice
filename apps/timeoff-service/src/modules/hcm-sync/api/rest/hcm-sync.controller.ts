import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { HcmSyncService } from '../../application/hcm-sync.service';
import {
  HcmBatchBalanceSnapshotPayload,
  HcmBatchQuery,
} from '../../hcm-sync.types';
import { InternalSyncTokenGuard } from './internal-sync-token.guard';

@Controller('internal/hcm-sync')
@UseGuards(InternalSyncTokenGuard)
export class HcmSyncController {
  constructor(private readonly hcmSyncService: HcmSyncService) {}

  @Post('balance-snapshots')
  importBatchSnapshots(@Body() body: HcmBatchBalanceSnapshotPayload) {
    return this.hcmSyncService.importBatchSnapshots(body);
  }

  @Post('pull/balance-snapshots')
  pullBatchSnapshots(@Body() body?: HcmBatchQuery) {
    return this.hcmSyncService.pullBatchSnapshots(body ?? {});
  }
}
