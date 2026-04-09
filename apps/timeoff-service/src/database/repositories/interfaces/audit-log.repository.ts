import { AuditLog, Prisma } from '@prisma/client';

import { PrismaTransactionClient } from './prisma-transaction-client.type';

export abstract class AuditLogRepository {
  abstract create(
    data: Prisma.AuditLogUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<AuditLog>;

  abstract listByRequestId(
    requestId: string,
    tx?: PrismaTransactionClient,
  ): Promise<AuditLog[]>;

  abstract listBySyncRunId(
    syncRunId: string,
    tx?: PrismaTransactionClient,
  ): Promise<AuditLog[]>;
}
