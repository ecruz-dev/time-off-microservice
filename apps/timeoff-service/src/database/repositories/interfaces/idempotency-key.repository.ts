import { IdempotencyKey, IdempotencyStatus, Prisma } from '@prisma/client';

import { PrismaTransactionClient } from './prisma-transaction-client.type';

export abstract class IdempotencyKeyRepository {
  abstract create(
    data: Prisma.IdempotencyKeyUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<IdempotencyKey>;

  abstract findByScopeAndKey(
    scope: string,
    idempotencyKey: string,
    tx?: PrismaTransactionClient,
  ): Promise<IdempotencyKey | null>;

  abstract markStatus(
    id: string,
    status: IdempotencyStatus,
    data?: Pick<
      Prisma.IdempotencyKeyUncheckedUpdateInput,
      'responseCode' | 'responseBody' | 'errorCode' | 'lockedAt'
    >,
    tx?: PrismaTransactionClient,
  ): Promise<IdempotencyKey>;
}

