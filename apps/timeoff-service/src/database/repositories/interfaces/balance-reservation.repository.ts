import { BalanceReservation, BalanceReservationStatus, Prisma } from '@prisma/client';

import { PrismaTransactionClient } from './prisma-transaction-client.type';

export abstract class BalanceReservationRepository {
  abstract create(
    data: Prisma.BalanceReservationUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceReservation>;

  abstract findActiveByEmployeeAndLocation(
    employeeId: string,
    locationId: string,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceReservation[]>;

  abstract updateStatusByRequestId(
    requestId: string,
    status: BalanceReservationStatus,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceReservation>;
}

