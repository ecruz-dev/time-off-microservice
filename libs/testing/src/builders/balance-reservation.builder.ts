import {
  BalanceReservation,
  BalanceReservationStatus,
  Prisma,
  TimeOffRequest,
} from '@prisma/client';

import { TestDataBuilder } from './test-data.builder';
import { nextTestId, nextTestSequence } from './test-sequence';

export class BalanceReservationBuilder extends TestDataBuilder<BalanceReservation> {
  constructor() {
    const sequence = nextTestSequence('balance_reservation');
    const now = new Date('2026-04-08T15:00:00.000Z');

    super({
      id: nextTestId('reservation'),
      requestId: `req_${sequence}`,
      employeeId: `emp_${sequence}`,
      locationId: 'loc_ny',
      reservedUnits: 2_000,
      status: BalanceReservationStatus.ACTIVE,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  withId(id: string): this {
    return this.set('id', id);
  }

  withRequestId(requestId: string): this {
    return this.set('requestId', requestId);
  }

  withEmployeeId(employeeId: string): this {
    return this.set('employeeId', employeeId);
  }

  withLocationId(locationId: string): this {
    return this.set('locationId', locationId);
  }

  withReservedUnits(reservedUnits: number): this {
    return this.set('reservedUnits', reservedUnits);
  }

  withStatus(status: BalanceReservationStatus): this {
    return this.set('status', status);
  }

  withExpiresAt(expiresAt: Date | null): this {
    return this.set('expiresAt', expiresAt);
  }

  fromRequest(request: Pick<TimeOffRequest, 'id' | 'employeeId' | 'locationId' | 'requestedUnits'>): this {
    this.set('requestId', request.id);
    this.set('employeeId', request.employeeId);
    this.set('locationId', request.locationId);
    this.set('reservedUnits', request.requestedUnits);

    return this;
  }

  toCreateInput(): Prisma.BalanceReservationUncheckedCreateInput {
    const reservation = this.build();

    return {
      ...reservation,
    };
  }
}
