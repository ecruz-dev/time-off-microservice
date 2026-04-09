import { Prisma, SyncRun, SyncRunStatus } from '@prisma/client';

import { TestDataBuilder } from './test-data.builder';
import { nextTestId, nextTestSequence } from './test-sequence';

export class SyncRunBuilder extends TestDataBuilder<SyncRun> {
  constructor() {
    const sequence = nextTestSequence('sync_run');
    const now = new Date('2026-04-08T15:00:00.000Z');

    super({
      id: nextTestId('sync'),
      source: 'hcm-batch',
      externalRunId: `run_${sequence}`,
      status: SyncRunStatus.PROCESSING,
      sentAt: now,
      startedAt: now,
      completedAt: null,
      recordsReceived: 0,
      recordsApplied: 0,
      errorSummary: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  withId(id: string): this {
    return this.set('id', id);
  }

  withSource(source: string): this {
    return this.set('source', source);
  }

  withExternalRunId(externalRunId: string | null): this {
    return this.set('externalRunId', externalRunId);
  }

  withStatus(status: SyncRunStatus): this {
    return this.set('status', status);
  }

  withCounts(recordsReceived: number, recordsApplied: number): this {
    this.set('recordsReceived', recordsReceived);
    this.set('recordsApplied', recordsApplied);

    return this;
  }

  withCompletedAt(completedAt: Date | null): this {
    return this.set('completedAt', completedAt);
  }

  toCreateInput(): Prisma.SyncRunUncheckedCreateInput {
    const syncRun = this.build();

    return {
      ...syncRun,
    };
  }
}

