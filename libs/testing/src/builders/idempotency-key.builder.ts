import { IdempotencyKey, IdempotencyStatus, Prisma } from '@prisma/client';

import { TestDataBuilder } from './test-data.builder';
import { nextTestId, nextTestSequence } from './test-sequence';

export class IdempotencyKeyBuilder extends TestDataBuilder<IdempotencyKey> {
  constructor() {
    const sequence = nextTestSequence('idempotency_key');
    const now = new Date('2026-04-08T15:00:00.000Z');

    super({
      id: nextTestId('idem'),
      idempotencyKey: `idem-key-${sequence}`,
      scope: 'timeoff.create',
      fingerprint: `employee:${sequence}:loc_ny`,
      status: IdempotencyStatus.IN_PROGRESS,
      responseCode: null,
      responseBody: null,
      errorCode: null,
      lockedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  withId(id: string): this {
    return this.set('id', id);
  }

  withIdempotencyKey(idempotencyKey: string): this {
    return this.set('idempotencyKey', idempotencyKey);
  }

  withScope(scope: string): this {
    return this.set('scope', scope);
  }

  withFingerprint(fingerprint: string): this {
    return this.set('fingerprint', fingerprint);
  }

  withStatus(status: IdempotencyStatus): this {
    return this.set('status', status);
  }

  withResponse(responseCode: number, responseBody: unknown): this {
    this.set('responseCode', responseCode);
    this.set('responseBody', JSON.stringify(responseBody));

    return this;
  }

  withErrorCode(errorCode: string | null): this {
    return this.set('errorCode', errorCode);
  }

  toCreateInput(): Prisma.IdempotencyKeyUncheckedCreateInput {
    const idempotencyKey = this.build();

    return {
      ...idempotencyKey,
    };
  }
}

