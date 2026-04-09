import { Prisma, TimeOffRequest, TimeOffRequestStatus } from '@prisma/client';

import { TestDataBuilder } from './test-data.builder';
import { nextTestId, nextTestSequence } from './test-sequence';

export class TimeOffRequestBuilder extends TestDataBuilder<TimeOffRequest> {
  constructor() {
    const sequence = nextTestSequence('time_off_request');
    const createdAt = new Date('2026-04-08T15:00:00.000Z');
    const startDate = new Date('2026-05-01T00:00:00.000Z');
    const endDate = new Date('2026-05-02T00:00:00.000Z');

    super({
      id: nextTestId('req'),
      employeeId: `emp_${sequence}`,
      locationId: 'loc_ny',
      startDate,
      endDate,
      requestedUnits: 2_000,
      reason: 'Family trip',
      status: TimeOffRequestStatus.PENDING,
      managerDecisionReason: null,
      createdBy: `emp_${sequence}`,
      approvedBy: null,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
  }

  withId(id: string): this {
    return this.set('id', id);
  }

  withEmployeeId(employeeId: string): this {
    this.set('employeeId', employeeId);
    this.set('createdBy', employeeId);

    return this;
  }

  withLocationId(locationId: string): this {
    return this.set('locationId', locationId);
  }

  withRequestedUnits(requestedUnits: number): this {
    return this.set('requestedUnits', requestedUnits);
  }

  withStatus(status: TimeOffRequestStatus): this {
    return this.set('status', status);
  }

  withReason(reason: string | null): this {
    return this.set('reason', reason);
  }

  withManagerDecisionReason(managerDecisionReason: string | null): this {
    return this.set('managerDecisionReason', managerDecisionReason);
  }

  withApprovedBy(approvedBy: string | null): this {
    return this.set('approvedBy', approvedBy);
  }

  withDateRange(startDate: Date, endDate: Date): this {
    this.set('startDate', startDate);
    this.set('endDate', endDate);

    return this;
  }

  withVersion(version: number): this {
    return this.set('version', version);
  }

  toCreateInput(): Prisma.TimeOffRequestUncheckedCreateInput {
    const request = this.build();

    return {
      ...request,
    };
  }
}

