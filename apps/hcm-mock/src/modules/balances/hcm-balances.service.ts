import { Injectable } from '@nestjs/common';

import { HcmBalanceStoreService } from './hcm-balance-store.service';
import {
  HcmBalanceAdjustmentRequest,
  HcmBalanceAdjustmentResponse,
  HcmBalancePayload,
  HcmBatchBalanceSnapshotResponse,
  HcmBatchQuery,
} from './hcm-balance.types';

@Injectable()
export class HcmBalancesService {
  constructor(private readonly balanceStore: HcmBalanceStoreService) {}

  getBalance(employeeId: string, locationId: string): HcmBalancePayload {
    return this.balanceStore.getBalance(employeeId, locationId);
  }

  listBatchSnapshots(query: HcmBatchQuery): HcmBatchBalanceSnapshotResponse {
    return this.balanceStore.listBatchSnapshots(query);
  }

  applyAdjustment(
    request: HcmBalanceAdjustmentRequest,
  ): HcmBalanceAdjustmentResponse {
    return this.balanceStore.applyAdjustment(request);
  }
}

