import { OutboxEvent, OutboxEventStatus, Prisma } from '@prisma/client';

import { PrismaTransactionClient } from './prisma-transaction-client.type';

export abstract class OutboxEventRepository {
  abstract create(
    data: Prisma.OutboxEventUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<OutboxEvent>;

  abstract listPending(
    limit: number,
    tx?: PrismaTransactionClient,
  ): Promise<OutboxEvent[]>;

  abstract markStatus(
    id: string,
    status: OutboxEventStatus,
    data?: Pick<
      Prisma.OutboxEventUncheckedUpdateInput,
      'attempts' | 'lastError' | 'processedAt' | 'availableAt'
    >,
    tx?: PrismaTransactionClient,
  ): Promise<OutboxEvent>;
}

