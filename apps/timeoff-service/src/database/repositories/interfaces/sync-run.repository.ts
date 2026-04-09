import { Prisma, SyncRun, SyncRunStatus } from '@prisma/client';

import { PrismaTransactionClient } from './prisma-transaction-client.type';

export abstract class SyncRunRepository {
  abstract create(
    data: Prisma.SyncRunUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<SyncRun>;

  abstract markStatus(
    id: string,
    status: SyncRunStatus,
    data?: Pick<
      Prisma.SyncRunUncheckedUpdateInput,
      'completedAt' | 'errorSummary' | 'recordsApplied' | 'recordsReceived'
    >,
    tx?: PrismaTransactionClient,
  ): Promise<SyncRun>;

  abstract findByExternalRunId(
    externalRunId: string,
    tx?: PrismaTransactionClient,
  ): Promise<SyncRun | null>;
}

