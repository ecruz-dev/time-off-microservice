import { BadRequestException, Injectable } from '@nestjs/common';

import {
  HcmAcceptedAdjustmentResponse,
  HcmBalanceAdjustmentRequest,
  HcmBalanceAdjustmentResponse,
  HcmBalancePayload,
  HcmBatchBalanceSnapshotResponse,
  HcmBatchQuery,
} from './hcm-balance.types';

export interface MockScenarioSettings {
  enforceDimensionValidationErrors: boolean;
  enforceInsufficientBalanceErrors: boolean;
}

export interface ForcedAdjustmentError {
  code: string;
  message: string;
}

export interface DriftBalanceCommand {
  employeeId: string;
  locationId: string;
  deltaUnits?: number;
  availableUnits?: number;
  sourceUpdatedAt?: string;
}

export interface MockScenarioState {
  settings: MockScenarioSettings;
  balances: HcmBalancePayload[];
  forcedAdjustmentError: ForcedAdjustmentError | null;
}

const DEFAULT_SETTINGS: Readonly<MockScenarioSettings> = Object.freeze({
  enforceDimensionValidationErrors: true,
  enforceInsufficientBalanceErrors: true,
});

const SEEDED_BALANCES: ReadonlyArray<{
  employeeId: string;
  locationId: string;
  availableUnits: number;
}> = Object.freeze([
  { employeeId: 'emp_alice', locationId: 'loc_ny', availableUnits: 8_000 },
  { employeeId: 'emp_bob', locationId: 'loc_ny', availableUnits: 12_000 },
  { employeeId: 'emp_carla', locationId: 'loc_sf', availableUnits: 16_000 },
]);

@Injectable()
export class HcmBalanceStoreService {
  private readonly balances = new Map<string, HcmBalancePayload>();
  private readonly adjustmentResponses = new Map<
    string,
    HcmBalanceAdjustmentResponse
  >();
  private settings: MockScenarioSettings = { ...DEFAULT_SETTINGS };
  private forcedAdjustmentError: ForcedAdjustmentError | null = null;
  private versionSequence = 0;
  private batchSequence = 0;

  constructor() {
    this.reset();
  }

  reset(): MockScenarioState {
    this.balances.clear();
    this.adjustmentResponses.clear();
    this.settings = { ...DEFAULT_SETTINGS };
    this.forcedAdjustmentError = null;
    this.versionSequence = 0;
    this.batchSequence = 0;

    for (const seedBalance of SEEDED_BALANCES) {
      const sourceUpdatedAt = '2026-04-08T15:00:00.000Z';

      this.balances.set(this.toBalanceKey(seedBalance), {
        employeeId: seedBalance.employeeId,
        locationId: seedBalance.locationId,
        availableUnits: seedBalance.availableUnits,
        sourceVersion: this.createSourceVersion(sourceUpdatedAt),
        sourceUpdatedAt,
      });
    }

    return this.getScenarioState();
  }

  getBalance(employeeId: string, locationId: string): HcmBalancePayload {
    this.assertNonEmptyString(employeeId, 'employeeId');
    this.assertNonEmptyString(locationId, 'locationId');

    const balance = this.findBalance(employeeId, locationId);

    if (balance) {
      return balance;
    }

    if (this.settings.enforceDimensionValidationErrors) {
      throw new BadRequestException({
        code: 'INVALID_DIMENSIONS',
        message: 'Balance not found for employee/location combination.',
      });
    }

    return this.createOrReplaceBalance({
      employeeId,
      locationId,
      availableUnits: 0,
    });
  }

  listBatchSnapshots(query: HcmBatchQuery = {}): HcmBatchBalanceSnapshotResponse {
    const records = [...this.balances.values()].filter((balance) => {
      if (query.employeeId && balance.employeeId !== query.employeeId) {
        return false;
      }

      if (query.locationId && balance.locationId !== query.locationId) {
        return false;
      }

      return true;
    });
    const sentAt = new Date().toISOString();

    this.batchSequence += 1;

    return {
      runId: `mock-hcm-batch-${this.batchSequence}`,
      sentAt,
      records,
    };
  }

  applyAdjustment(
    request: HcmBalanceAdjustmentRequest,
  ): HcmBalanceAdjustmentResponse {
    this.assertAdjustmentRequest(request);

    const priorResponse = this.adjustmentResponses.get(request.idempotencyKey);

    if (priorResponse) {
      return priorResponse;
    }

    const balance = this.findBalance(request.employeeId, request.locationId);

    if (!balance && this.settings.enforceDimensionValidationErrors) {
      return this.storeAdjustmentResponse(request.idempotencyKey, {
        accepted: false,
        code: 'INVALID_DIMENSIONS',
        message: 'Balance not found for employee/location combination.',
      });
    }

    if (this.forcedAdjustmentError) {
      const forcedError = this.forcedAdjustmentError;

      this.forcedAdjustmentError = null;

      return this.storeAdjustmentResponse(request.idempotencyKey, {
        accepted: false,
        code: forcedError.code,
        message: forcedError.message,
      });
    }

    const mutableBalance =
      balance ??
      this.createOrReplaceBalance({
        employeeId: request.employeeId,
        locationId: request.locationId,
        availableUnits: 0,
      });
    const projectedAvailableUnits =
      mutableBalance.availableUnits + request.deltaUnits;

    if (
      this.settings.enforceInsufficientBalanceErrors &&
      projectedAvailableUnits < 0
    ) {
      return this.storeAdjustmentResponse(request.idempotencyKey, {
        accepted: false,
        code: 'INSUFFICIENT_BALANCE',
        message: 'Available balance is lower than requested deduction.',
      });
    }

    const updatedBalance = this.createOrReplaceBalance({
      employeeId: request.employeeId,
      locationId: request.locationId,
      availableUnits: projectedAvailableUnits,
      sourceUpdatedAt: request.occurredAt,
    });
    const response: HcmAcceptedAdjustmentResponse = {
      accepted: true,
      ...updatedBalance,
    };

    return this.storeAdjustmentResponse(request.idempotencyKey, response);
  }

  applyDrift(command: DriftBalanceCommand): HcmBalancePayload {
    this.assertNonEmptyString(command.employeeId, 'employeeId');
    this.assertNonEmptyString(command.locationId, 'locationId');

    if (
      typeof command.deltaUnits !== 'number' &&
      typeof command.availableUnits !== 'number'
    ) {
      throw new BadRequestException({
        code: 'INVALID_DRIFT_COMMAND',
        message: 'Either deltaUnits or availableUnits must be provided.',
      });
    }

    const currentBalance =
      this.findBalance(command.employeeId, command.locationId) ??
      this.createOrReplaceBalance({
        employeeId: command.employeeId,
        locationId: command.locationId,
        availableUnits: 0,
      });
    const availableUnits =
      typeof command.availableUnits === 'number'
        ? command.availableUnits
        : currentBalance.availableUnits + (command.deltaUnits ?? 0);

    return this.createOrReplaceBalance({
      employeeId: command.employeeId,
      locationId: command.locationId,
      availableUnits,
      sourceUpdatedAt: command.sourceUpdatedAt,
    });
  }

  updateSettings(settings: Partial<MockScenarioSettings>): MockScenarioState {
    this.settings = {
      ...this.settings,
      ...settings,
    };

    return this.getScenarioState();
  }

  setForcedAdjustmentError(
    forcedAdjustmentError: ForcedAdjustmentError | null,
  ): MockScenarioState {
    this.forcedAdjustmentError = forcedAdjustmentError;

    return this.getScenarioState();
  }

  getScenarioState(): MockScenarioState {
    return {
      settings: { ...this.settings },
      balances: [...this.balances.values()].sort((left, right) =>
        this.toBalanceKey(left).localeCompare(this.toBalanceKey(right)),
      ),
      forcedAdjustmentError: this.forcedAdjustmentError
        ? { ...this.forcedAdjustmentError }
        : null,
    };
  }

  private createOrReplaceBalance(input: {
    employeeId: string;
    locationId: string;
    availableUnits: number;
    sourceUpdatedAt?: string;
  }): HcmBalancePayload {
    this.assertInteger(input.availableUnits, 'availableUnits');

    const sourceUpdatedAt = input.sourceUpdatedAt ?? new Date().toISOString();
    const balance: HcmBalancePayload = {
      employeeId: input.employeeId,
      locationId: input.locationId,
      availableUnits: input.availableUnits,
      sourceVersion: this.createSourceVersion(sourceUpdatedAt),
      sourceUpdatedAt,
    };

    this.balances.set(this.toBalanceKey(balance), balance);

    return balance;
  }

  private createSourceVersion(sourceUpdatedAt: string): string {
    this.versionSequence += 1;

    return `${sourceUpdatedAt}#${this.versionSequence}`;
  }

  private storeAdjustmentResponse(
    idempotencyKey: string,
    response: HcmBalanceAdjustmentResponse,
  ): HcmBalanceAdjustmentResponse {
    this.adjustmentResponses.set(idempotencyKey, response);

    return response;
  }

  private findBalance(
    employeeId: string,
    locationId: string,
  ): HcmBalancePayload | undefined {
    return this.balances.get(this.toBalanceKey({ employeeId, locationId }));
  }

  private toBalanceKey(input: {
    employeeId: string;
    locationId: string;
  }): string {
    return `${input.employeeId}::${input.locationId}`;
  }

  private assertAdjustmentRequest(
    request: HcmBalanceAdjustmentRequest,
  ): void {
    this.assertNonEmptyString(request.idempotencyKey, 'idempotencyKey');
    this.assertNonEmptyString(request.requestId, 'requestId');
    this.assertNonEmptyString(request.employeeId, 'employeeId');
    this.assertNonEmptyString(request.locationId, 'locationId');
    this.assertNonEmptyString(request.reasonCode, 'reasonCode');
    this.assertInteger(request.deltaUnits, 'deltaUnits');
    this.assertIsoDate(request.occurredAt, 'occurredAt');
  }

  private assertNonEmptyString(value: string, fieldName: string): void {
    if (!value || !value.trim()) {
      throw new BadRequestException({
        code: 'BAD_USER_INPUT',
        message: `${fieldName} must be a non-empty string.`,
      });
    }
  }

  private assertInteger(value: number, fieldName: string): void {
    if (!Number.isInteger(value)) {
      throw new BadRequestException({
        code: 'BAD_USER_INPUT',
        message: `${fieldName} must be an integer.`,
      });
    }
  }

  private assertIsoDate(value: string, fieldName: string): void {
    if (!value || Number.isNaN(new Date(value).getTime())) {
      throw new BadRequestException({
        code: 'BAD_USER_INPUT',
        message: `${fieldName} must be a valid ISO 8601 timestamp.`,
      });
    }
  }
}
