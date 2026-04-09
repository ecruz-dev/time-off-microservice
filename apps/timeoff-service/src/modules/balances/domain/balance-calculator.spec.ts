import { BalanceReservationStatus } from '@prisma/client';

import {
  BalanceReservationBuilder,
  BalanceSnapshotBuilder,
  TestClock,
  resetTestSequences,
} from '@app/testing';

import {
  BalanceDomainError,
  balanceDomainErrorCodes,
  calculateEffectiveBalance,
  createBalancePolicy,
  hasSufficientEffectiveBalance,
  isSnapshotStale,
  shouldRefreshSnapshot,
} from './index';

describe('balance domain', () => {
  beforeEach(() => {
    resetTestSequences();
  });

  it('calculates effective available balance using only active reservations', () => {
    const clock = new TestClock(new Date('2026-04-08T15:05:00.000Z'));
    const snapshot = new BalanceSnapshotBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withAvailableUnits(8_000)
      .withLastSyncedAt(new Date('2026-04-08T15:02:00.000Z'))
      .build();
    const activeReservation = new BalanceReservationBuilder()
      .withRequestId('req_active')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withReservedUnits(2_000)
      .withStatus(BalanceReservationStatus.ACTIVE)
      .build();
    const releasedReservation = new BalanceReservationBuilder()
      .withRequestId('req_released')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withReservedUnits(1_000)
      .withStatus(BalanceReservationStatus.RELEASED)
      .build();
    const expiredReservation = new BalanceReservationBuilder()
      .withRequestId('req_expired')
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withReservedUnits(500)
      .withExpiresAt(new Date('2026-04-08T15:04:59.000Z'))
      .build();

    const balance = calculateEffectiveBalance({
      snapshot,
      reservations: [activeReservation, releasedReservation, expiredReservation],
      now: clock.now(),
    });

    expect(balance).toMatchObject({
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8_000,
      reservedUnits: 2_000,
      effectiveAvailableUnits: 6_000,
      activeReservationCount: 1,
      stale: false,
      overReserved: false,
    });
  });

  it('marks a snapshot stale when it exceeds the policy window', () => {
    const clock = new TestClock(new Date('2026-04-08T15:10:00.000Z'));
    const snapshot = new BalanceSnapshotBuilder()
      .withLastSyncedAt(new Date('2026-04-08T15:00:00.000Z'))
      .build();

    expect(
      isSnapshotStale(snapshot, clock.now(), { staleAfterMilliseconds: 5 * 60 * 1000 }),
    ).toBe(true);
    expect(shouldRefreshSnapshot(snapshot, clock.now())).toBe(true);
  });

  it('requests a refresh when the snapshot is missing', () => {
    expect(shouldRefreshSnapshot(null)).toBe(true);
    expect(shouldRefreshSnapshot(undefined)).toBe(true);
  });

  it('allows negative effective balances when reservations exceed the snapshot', () => {
    const snapshot = new BalanceSnapshotBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withAvailableUnits(1_000)
      .build();
    const reservation = new BalanceReservationBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .withReservedUnits(1_500)
      .build();

    const balance = calculateEffectiveBalance({
      snapshot,
      reservations: [reservation],
    });

    expect(balance.effectiveAvailableUnits).toBe(-500);
    expect(balance.overReserved).toBe(true);
    expect(hasSufficientEffectiveBalance(balance, 500)).toBe(false);
  });

  it('rejects reservations whose dimensions do not match the snapshot', () => {
    const snapshot = new BalanceSnapshotBuilder()
      .withEmployeeId('emp_alice')
      .withLocationId('loc_ny')
      .build();
    const invalidReservation = new BalanceReservationBuilder()
      .withEmployeeId('emp_bob')
      .withLocationId('loc_ny')
      .build();

    expect(() =>
      calculateEffectiveBalance({
        snapshot,
        reservations: [invalidReservation],
      }),
    ).toThrow(
      new BalanceDomainError(
        balanceDomainErrorCodes.invalidBalanceDimension,
        'Reservation dimensions must match the authoritative balance snapshot.',
      ),
    );
  });

  it('rejects invalid balance units and invalid staleness policies', () => {
    const invalidSnapshot = new BalanceSnapshotBuilder()
      .withAvailableUnits(-1)
      .build();

    expect(() =>
      calculateEffectiveBalance({
        snapshot: invalidSnapshot,
      }),
    ).toThrow(BalanceDomainError);

    expect(() => createBalancePolicy({ staleAfterMilliseconds: 0 })).toThrow(
      new BalanceDomainError(
        balanceDomainErrorCodes.invalidStalenessWindow,
        'staleAfterMilliseconds must be a positive integer.',
      ),
    );
  });
});
