import { Module } from '@nestjs/common';

import { HealthModule } from './health/health.module';
import { HcmBalancesModule } from './modules/balances/hcm-balances.module';
import { HcmScenariosModule } from './modules/scenarios/hcm-scenarios.module';

@Module({
  imports: [HealthModule, HcmBalancesModule, HcmScenariosModule],
})
export class AppModule {}
