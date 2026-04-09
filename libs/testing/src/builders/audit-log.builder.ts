import { AuditActorType, AuditLog, Prisma } from '@prisma/client';

import { TestDataBuilder } from './test-data.builder';
import { nextTestId } from './test-sequence';

export class AuditLogBuilder extends TestDataBuilder<AuditLog> {
  constructor() {
    const now = new Date('2026-04-08T15:00:00.000Z');

    super({
      id: nextTestId('audit'),
      action: 'TIME_OFF_REQUEST_CREATED',
      actorType: AuditActorType.SYSTEM,
      actorId: nextTestId('actor'),
      requestId: null,
      syncRunId: null,
      entityType: 'time_off_request',
      entityId: nextTestId('entity'),
      metadata: JSON.stringify({ reason: 'test' }),
      occurredAt: now,
      createdAt: now,
    });
  }

  withId(id: string): this {
    return this.set('id', id);
  }

  withAction(action: string): this {
    return this.set('action', action);
  }

  withActor(actorType: AuditActorType, actorId: string): this {
    this.set('actorType', actorType);
    this.set('actorId', actorId);

    return this;
  }

  withRequestId(requestId: string | null): this {
    return this.set('requestId', requestId);
  }

  withSyncRunId(syncRunId: string | null): this {
    return this.set('syncRunId', syncRunId);
  }

  withEntity(entityType: string, entityId: string): this {
    this.set('entityType', entityType);
    this.set('entityId', entityId);

    return this;
  }

  withMetadata(metadata: Record<string, unknown> | null): this {
    return this.set('metadata', metadata ? JSON.stringify(metadata) : null);
  }

  toCreateInput(): Prisma.AuditLogUncheckedCreateInput {
    const auditLog = this.build();

    return {
      ...auditLog,
    };
  }
}

