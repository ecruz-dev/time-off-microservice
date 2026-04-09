import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { InternalSyncTokenGuard } from '../../../hcm-sync/api/rest/internal-sync-token.guard';
import { OperationalAuditService } from '../../application/operational-audit.service';

@Controller('internal/audit')
@UseGuards(InternalSyncTokenGuard)
export class OperationalAuditController {
  constructor(
    private readonly operationalAuditService: OperationalAuditService,
  ) {}

  @Get('requests/:requestId')
  listRequestTrail(@Param('requestId') requestId: string) {
    return this.operationalAuditService.listRequestTrail(requestId);
  }

  @Get('sync-runs/:syncRunId')
  listSyncRunTrail(@Param('syncRunId') syncRunId: string) {
    return this.operationalAuditService.listSyncRunTrail(syncRunId);
  }
}
