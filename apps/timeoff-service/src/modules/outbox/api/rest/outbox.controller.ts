import { Body, Controller, Post, UseGuards } from '@nestjs/common';

import { InternalSyncTokenGuard } from '../../../hcm-sync/api/rest/internal-sync-token.guard';
import { OutboxProcessorService } from '../../application/outbox-processor.service';

@Controller('internal/outbox')
@UseGuards(InternalSyncTokenGuard)
export class OutboxController {
  constructor(private readonly outboxProcessorService: OutboxProcessorService) {}

  @Post('process')
  processPending(@Body() body?: { limit?: number }) {
    return this.outboxProcessorService.processPending(body?.limit);
  }
}
