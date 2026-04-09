import { Employee, Prisma } from '@prisma/client';

import { PrismaTransactionClient } from './prisma-transaction-client.type';

export abstract class EmployeeRepository {
  abstract create(
    data: Prisma.EmployeeCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<Employee>;

  abstract upsert(
    data: Prisma.EmployeeUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<Employee>;

  abstract findById(
    id: string,
    tx?: PrismaTransactionClient,
  ): Promise<Employee | null>;

  abstract list(tx?: PrismaTransactionClient): Promise<Employee[]>;
}

