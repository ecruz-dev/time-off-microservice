import { Prisma, TimeOffRequest, TimeOffRequestStatus } from '@prisma/client';

import { PrismaTransactionClient } from './prisma-transaction-client.type';

export abstract class TimeOffRequestRepository {
  abstract create(
    data: Prisma.TimeOffRequestUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<TimeOffRequest>;

  abstract findById(
    id: string,
    tx?: PrismaTransactionClient,
  ): Promise<TimeOffRequest | null>;

  abstract updateDecision(
    id: string,
    data: {
      status: TimeOffRequestStatus;
      managerDecisionReason?: string | null;
      approvedBy?: string | null;
    },
    tx?: PrismaTransactionClient,
  ): Promise<TimeOffRequest>;
}
