import { OutboxEvent, OutboxEventStatus, Prisma } from '@prisma/client';

import { TestDataBuilder } from './test-data.builder';
import { nextTestId } from './test-sequence';

export class OutboxEventBuilder extends TestDataBuilder<OutboxEvent> {
  constructor() {
    const now = new Date('2026-04-08T15:00:00.000Z');

    super({
      id: nextTestId('outbox'),
      eventType: 'timeoff.request.created.v1',
      aggregateType: 'time_off_request',
      aggregateId: nextTestId('aggregate'),
      payload: JSON.stringify({
        requestId: nextTestId('req'),
        employeeId: nextTestId('emp'),
        locationId: 'loc_ny',
      }),
      status: OutboxEventStatus.PENDING,
      attempts: 0,
      availableAt: now,
      processedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  withId(id: string): this {
    return this.set('id', id);
  }

  withEventType(eventType: string): this {
    return this.set('eventType', eventType);
  }

  withAggregate(aggregateType: string, aggregateId: string): this {
    this.set('aggregateType', aggregateType);
    this.set('aggregateId', aggregateId);

    return this;
  }

  withPayload(payload: unknown): this {
    return this.set('payload', JSON.stringify(payload));
  }

  withStatus(status: OutboxEventStatus): this {
    return this.set('status', status);
  }

  withAttempts(attempts: number): this {
    return this.set('attempts', attempts);
  }

  toCreateInput(): Prisma.OutboxEventUncheckedCreateInput {
    const outboxEvent = this.build();

    return {
      ...outboxEvent,
    };
  }
}

