import { BalanceSnapshot, Prisma } from '@prisma/client';

import { TestDataBuilder } from './test-data.builder';
import { nextTestId, nextTestSequence } from './test-sequence';

export class BalanceSnapshotBuilder extends TestDataBuilder<BalanceSnapshot> {
  constructor() {
    const sequence = nextTestSequence('balance_snapshot');
    const now = new Date('2026-04-08T15:00:00.000Z');

    super({
      id: nextTestId('snapshot'),
      employeeId: `emp_${sequence}`,
      locationId: 'loc_ny',
      availableUnits: 10_000,
      sourceVersion: `2026-04-08T15:00:00.000Z#${sequence}`,
      sourceUpdatedAt: now,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  withId(id: string): this {
    return this.set('id', id);
  }

  withEmployeeId(employeeId: string): this {
    return this.set('employeeId', employeeId);
  }

  withLocationId(locationId: string): this {
    return this.set('locationId', locationId);
  }

  withAvailableUnits(availableUnits: number): this {
    return this.set('availableUnits', availableUnits);
  }

  withSourceVersion(sourceVersion: string): this {
    return this.set('sourceVersion', sourceVersion);
  }

  withSourceUpdatedAt(sourceUpdatedAt: Date): this {
    return this.set('sourceUpdatedAt', sourceUpdatedAt);
  }

  withLastSyncedAt(lastSyncedAt: Date): this {
    return this.set('lastSyncedAt', lastSyncedAt);
  }

  toCreateInput(): Prisma.BalanceSnapshotUncheckedCreateInput {
    const snapshot = this.build();

    return {
      ...snapshot,
    };
  }
}

