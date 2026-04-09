import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
} from '@nestjs/common';

import {
  DriftBalanceCommand,
  ForcedAdjustmentError,
  MockScenarioSettings,
} from '../balances/hcm-balance-store.service';
import { HcmScenariosService } from './hcm-scenarios.service';

@Controller('scenarios')
export class HcmScenariosController {
  constructor(private readonly scenariosService: HcmScenariosService) {}

  @Get('state')
  getState() {
    return this.scenariosService.getState();
  }

  @Post('reset')
  reset() {
    return this.scenariosService.reset();
  }

  @Post('drift')
  applyDrift(@Body() body: DriftBalanceCommand) {
    return this.scenariosService.applyDrift(body);
  }

  @Patch('settings')
  updateSettings(@Body() body: Partial<MockScenarioSettings>) {
    return this.scenariosService.updateSettings(body);
  }

  @Post('force-next-adjustment-error')
  setForcedAdjustmentError(@Body() body: ForcedAdjustmentError) {
    return this.scenariosService.setForcedAdjustmentError(body);
  }

  @Delete('force-next-adjustment-error')
  clearForcedAdjustmentError() {
    return this.scenariosService.clearForcedAdjustmentError();
  }
}

