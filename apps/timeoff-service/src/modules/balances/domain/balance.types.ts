import { BalancePolicy } from './balance-policy';

export type BalanceReservationStatus = 'ACTIVE' | 'RELEASED' | 'CONSUMED';

export interface AuthoritativeBalanceSnapshot {
  employeeId: string;
  locationId: string;
  availableUnits: number;
  sourceUpdatedAt: Date;
  lastSyncedAt: Date;
}

export interface PendingBalanceReservation {
  requestId: string;
  employeeId: string;
  locationId: string;
  reservedUnits: number;
  status?: BalanceReservationStatus;
  expiresAt?: Date | null;
}

export interface CalculateEffectiveBalanceInput {
  snapshot: AuthoritativeBalanceSnapshot;
  reservations?: PendingBalanceReservation[];
  now?: Date;
  policy?: Partial<BalancePolicy>;
}

export interface EffectiveBalance {
  employeeId: string;
  locationId: string;
  availableUnits: number;
  reservedUnits: number;
  effectiveAvailableUnits: number;
  activeReservationCount: number;
  snapshotAgeInMilliseconds: number;
  sourceUpdatedAt: Date;
  lastSyncedAt: Date;
  stale: boolean;
  overReserved: boolean;
}

