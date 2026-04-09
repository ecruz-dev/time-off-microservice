import { Injectable } from '@nestjs/common';

import {
  DriftBalanceCommand,
  ForcedAdjustmentError,
  HcmBalanceStoreService,
  MockScenarioSettings,
  MockScenarioState,
} from '../balances/hcm-balance-store.service';
import { HcmBalancePayload } from '../balances/hcm-balance.types';

@Injectable()
export class HcmScenariosService {
  constructor(private readonly balanceStore: HcmBalanceStoreService) {}

  reset(): MockScenarioState {
    return this.balanceStore.reset();
  }

  getState(): MockScenarioState {
    return this.balanceStore.getScenarioState();
  }

  applyDrift(command: DriftBalanceCommand): HcmBalancePayload {
    return this.balanceStore.applyDrift(command);
  }

  updateSettings(settings: Partial<MockScenarioSettings>): MockScenarioState {
    return this.balanceStore.updateSettings(settings);
  }

  setForcedAdjustmentError(
    forcedAdjustmentError: ForcedAdjustmentError,
  ): MockScenarioState {
    return this.balanceStore.setForcedAdjustmentError(forcedAdjustmentError);
  }

  clearForcedAdjustmentError(): MockScenarioState {
    return this.balanceStore.setForcedAdjustmentError(null);
  }
}

