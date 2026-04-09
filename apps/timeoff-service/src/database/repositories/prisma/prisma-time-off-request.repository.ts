import { Injectable } from '@nestjs/common';
import { Prisma, TimeOffRequest, TimeOffRequestStatus } from '@prisma/client';

import { PrismaService } from '../../prisma.service';
import { PrismaTransactionClient, TimeOffRequestRepository } from '../interfaces';

@Injectable()
export class PrismaTimeOffRequestRepository extends TimeOffRequestRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(
    data: Prisma.TimeOffRequestUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<TimeOffRequest> {
    return (tx ?? this.prisma).timeOffRequest.create({ data });
  }

  async findById(
    id: string,
    tx?: PrismaTransactionClient,
  ): Promise<TimeOffRequest | null> {
    return (tx ?? this.prisma).timeOffRequest.findUnique({
      where: { id },
    });
  }

  async updateDecision(
    id: string,
    data: {
      status: TimeOffRequestStatus;
      managerDecisionReason?: string | null;
      approvedBy?: string | null;
    },
    tx?: PrismaTransactionClient,
  ): Promise<TimeOffRequest> {
    return (tx ?? this.prisma).timeOffRequest.update({
      where: { id },
      data: {
        status: data.status,
        managerDecisionReason: data.managerDecisionReason,
        approvedBy: data.approvedBy,
        version: {
          increment: 1,
        },
      },
    });
  }
}
