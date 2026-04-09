import { Module } from '@nestjs/common';

import { HcmBalanceStoreService } from './hcm-balance-store.service';
import { HcmBalancesController } from './hcm-balances.controller';
import { HcmBalancesService } from './hcm-balances.service';

@Module({
  controllers: [HcmBalancesController],
  providers: [HcmBalanceStoreService, HcmBalancesService],
  exports: [HcmBalanceStoreService, HcmBalancesService],
})
export class HcmBalancesModule {}
