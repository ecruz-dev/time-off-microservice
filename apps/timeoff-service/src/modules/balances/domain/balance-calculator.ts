import { ACTIVE_BALANCE_RESERVATION_STATUS } from './balance.constants';
import {
  BalanceDomainError,
  balanceDomainErrorCodes,
} from './balance-domain.error';
import { BalancePolicy, createBalancePolicy } from './balance-policy';
import {
  AuthoritativeBalanceSnapshot,
  CalculateEffectiveBalanceInput,
  EffectiveBalance,
  PendingBalanceReservation,
} from './balance.types';

export function calculateEffectiveBalance(
  input: CalculateEffectiveBalanceInput,
): EffectiveBalance {
  const now = input.now ?? new Date();
  const policy = createBalancePolicy(input.policy);

  assertBalanceSnapshotInvariants(input.snapshot);
  assertValidDate(now, 'now');

  const activeReservations = (input.reservations ?? []).filter((reservation) => {
    assertReservationInvariants(reservation);
    assertReservationMatchesSnapshot(input.snapshot, reservation);

    return isReservationActive(reservation, now);
  });

  const reservedUnits = activeReservations.reduce(
    (total, reservation) => total + reservation.reservedUnits,
    0,
  );
  const snapshotAgeInMilliseconds = calculateSnapshotAgeInMilliseconds(
    input.snapshot,
    now,
  );
  const effectiveAvailableUnits = input.snapshot.availableUnits - reservedUnits;

  return {
    employeeId: input.snapshot.employeeId,
    locationId: input.snapshot.locationId,
    availableUnits: input.snapshot.availableUnits,
    reservedUnits,
    effectiveAvailableUnits,
    activeReservationCount: activeReservations.length,
    snapshotAgeInMilliseconds,
    sourceUpdatedAt: input.snapshot.sourceUpdatedAt,
    lastSyncedAt: input.snapshot.lastSyncedAt,
    stale: snapshotAgeInMilliseconds > policy.staleAfterMilliseconds,
    overReserved: effectiveAvailableUnits < 0,
  };
}

export function isSnapshotStale(
  snapshot: AuthoritativeBalanceSnapshot,
  now: Date = new Date(),
  policy: Partial<BalancePolicy> = {},
): boolean {
  const resolvedPolicy = createBalancePolicy(policy);

  return (
    calculateSnapshotAgeInMilliseconds(snapshot, now) >
    resolvedPolicy.staleAfterMilliseconds
  );
}

export function shouldRefreshSnapshot(
  snapshot: AuthoritativeBalanceSnapshot | null | undefined,
  now: Date = new Date(),
  policy: Partial<BalancePolicy> = {},
): boolean {
  return !snapshot || isSnapshotStale(snapshot, now, policy);
}

export function hasSufficientEffectiveBalance(
  balance: Pick<EffectiveBalance, 'effectiveAvailableUnits'>,
  requestedUnits: number,
): boolean {
  assertPositiveInteger(requestedUnits, 'requestedUnits', {
    code: balanceDomainErrorCodes.invalidRequestedUnits,
  });

  return balance.effectiveAvailableUnits >= requestedUnits;
}

export function isReservationActive(
  reservation: PendingBalanceReservation,
  now: Date = new Date(),
): boolean {
  assertReservationInvariants(reservation);
  assertValidDate(now, 'now');

  if (
    reservation.status &&
    reservation.status !== ACTIVE_BALANCE_RESERVATION_STATUS
  ) {
    return false;
  }

  if (!reservation.expiresAt) {
    return true;
  }

  assertValidDate(reservation.expiresAt, 'reservation.expiresAt');

  return reservation.expiresAt.getTime() > now.getTime();
}

export function calculateSnapshotAgeInMilliseconds(
  snapshot: AuthoritativeBalanceSnapshot,
  now: Date = new Date(),
): number {
  assertBalanceSnapshotInvariants(snapshot);
  assertValidDate(now, 'now');

  return Math.max(now.getTime() - snapshot.lastSyncedAt.getTime(), 0);
}

export function assertBalanceSnapshotInvariants(
  snapshot: AuthoritativeBalanceSnapshot,
): void {
  assertDimensionValue(snapshot.employeeId, 'snapshot.employeeId');
  assertDimensionValue(snapshot.locationId, 'snapshot.locationId');
  assertPositiveInteger(snapshot.availableUnits, 'snapshot.availableUnits', {
    allowZero: true,
    code: balanceDomainErrorCodes.invalidAvailableUnits,
  });
  assertValidDate(snapshot.sourceUpdatedAt, 'snapshot.sourceUpdatedAt');
  assertValidDate(snapshot.lastSyncedAt, 'snapshot.lastSyncedAt');
}

export function assertReservationInvariants(
  reservation: PendingBalanceReservation,
): void {
  assertDimensionValue(reservation.requestId, 'reservation.requestId');
  assertDimensionValue(reservation.employeeId, 'reservation.employeeId');
  assertDimensionValue(reservation.locationId, 'reservation.locationId');
  assertPositiveInteger(reservation.reservedUnits, 'reservation.reservedUnits', {
    code: balanceDomainErrorCodes.invalidReservedUnits,
  });

  if (reservation.expiresAt) {
    assertValidDate(reservation.expiresAt, 'reservation.expiresAt');
  }
}

export function assertReservationMatchesSnapshot(
  snapshot: AuthoritativeBalanceSnapshot,
  reservation: PendingBalanceReservation,
): void {
  if (
    snapshot.employeeId !== reservation.employeeId ||
    snapshot.locationId !== reservation.locationId
  ) {
    throw new BalanceDomainError(
      balanceDomainErrorCodes.invalidBalanceDimension,
      'Reservation dimensions must match the authoritative balance snapshot.',
    );
  }
}

function assertDimensionValue(value: string, fieldName: string): void {
  if (!value || !value.trim()) {
    throw new BalanceDomainError(
      balanceDomainErrorCodes.invalidBalanceDimension,
      `${fieldName} must be a non-empty string.`,
    );
  }
}

function assertPositiveInteger(
  value: number,
  fieldName: string,
  options: {
    allowZero?: boolean;
    code:
      | typeof balanceDomainErrorCodes.invalidAvailableUnits
      | typeof balanceDomainErrorCodes.invalidRequestedUnits
      | typeof balanceDomainErrorCodes.invalidReservedUnits;
  },
): void {
  const minimum = options.allowZero ? 0 : 1;

  if (!Number.isInteger(value) || value < minimum) {
    throw new BalanceDomainError(
      options.code,
      `${fieldName} must be an integer greater than or equal to ${minimum}.`,
    );
  }
}

function assertValidDate(value: Date, fieldName: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BalanceDomainError(
      balanceDomainErrorCodes.invalidDate,
      `${fieldName} must be a valid Date.`,
    );
  }
}

