import { Module } from '@nestjs/common';

import { HcmBalancesModule } from '../balances/hcm-balances.module';
import { HcmScenariosController } from './hcm-scenarios.controller';
import { HcmScenariosService } from './hcm-scenarios.service';

@Module({
  imports: [HcmBalancesModule],
  controllers: [HcmScenariosController],
  providers: [HcmScenariosService],
})
export class HcmScenariosModule {}

