import { BalanceSnapshot, Prisma } from '@prisma/client';

import { PrismaTransactionClient } from './prisma-transaction-client.type';

export abstract class BalanceSnapshotRepository {
  abstract findByEmployeeAndLocation(
    employeeId: string,
    locationId: string,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceSnapshot | null>;

  abstract upsert(
    data: Prisma.BalanceSnapshotUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceSnapshot>;

  abstract listByEmployee(
    employeeId: string,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceSnapshot[]>;
}

