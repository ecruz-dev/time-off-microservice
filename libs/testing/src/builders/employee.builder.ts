import { Employee, Prisma } from '@prisma/client';

import { TestDataBuilder } from './test-data.builder';
import { nextTestId, nextTestSequence } from './test-sequence';

export class EmployeeBuilder extends TestDataBuilder<Employee> {
  constructor() {
    const sequence = nextTestSequence('employee');
    const now = new Date('2026-04-08T15:00:00.000Z');

    super({
      id: nextTestId('emp'),
      email: `employee${sequence}@example.com`,
      displayName: `Employee ${sequence}`,
      locationId: 'loc_ny',
      managerId: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  withId(id: string): this {
    return this.set('id', id);
  }

  withEmail(email: string): this {
    return this.set('email', email);
  }

  withDisplayName(displayName: string): this {
    return this.set('displayName', displayName);
  }

  withLocationId(locationId: string): this {
    return this.set('locationId', locationId);
  }

  withManagerId(managerId: string | null): this {
    return this.set('managerId', managerId);
  }

  inactive(): this {
    return this.set('isActive', false);
  }

  withCreatedAt(createdAt: Date): this {
    return this.set('createdAt', createdAt);
  }

  withUpdatedAt(updatedAt: Date): this {
    return this.set('updatedAt', updatedAt);
  }

  toCreateInput(): Prisma.EmployeeUncheckedCreateInput {
    const employee = this.build();

    return {
      ...employee,
    };
  }
}

