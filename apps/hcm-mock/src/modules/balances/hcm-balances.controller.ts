import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { HcmBalancesService } from './hcm-balances.service';
import {
  HcmBalanceAdjustmentRequest,
  HcmBatchQuery,
} from './hcm-balance.types';

@Controller('hcm')
export class HcmBalancesController {
  constructor(private readonly balancesService: HcmBalancesService) {}

  @Get('balances/:employeeId')
  getBalance(
    @Param('employeeId') employeeId: string,
    @Query('locationId') locationId: string,
  ) {
    return this.balancesService.getBalance(employeeId, locationId);
  }

  @Get('balance-snapshots')
  getBalanceSnapshots(@Query() query: HcmBatchQuery) {
    return this.balancesService.listBatchSnapshots(query);
  }

  @Post('balance-adjustments')
  applyBalanceAdjustment(@Body() body: HcmBalanceAdjustmentRequest) {
    return this.balancesService.applyAdjustment(body);
  }
}

