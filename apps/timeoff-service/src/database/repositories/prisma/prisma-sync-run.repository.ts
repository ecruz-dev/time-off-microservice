import { Injectable } from '@nestjs/common';
import { Prisma, SyncRun, SyncRunStatus } from '@prisma/client';

import { PrismaService } from '../../prisma.service';
import { PrismaTransactionClient, SyncRunRepository } from '../interfaces';

@Injectable()
export class PrismaSyncRunRepository extends SyncRunRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(
    data: Prisma.SyncRunUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<SyncRun> {
    return (tx ?? this.prisma).syncRun.create({ data });
  }

  async markStatus(
    id: string,
    status: SyncRunStatus,
    data?: Pick<
      Prisma.SyncRunUncheckedUpdateInput,
      'completedAt' | 'errorSummary' | 'recordsApplied' | 'recordsReceived'
    >,
    tx?: PrismaTransactionClient,
  ): Promise<SyncRun> {
    return (tx ?? this.prisma).syncRun.update({
      where: { id },
      data: {
        status,
        ...data,
      },
    });
  }

  async findByExternalRunId(
    externalRunId: string,
    tx?: PrismaTransactionClient,
  ): Promise<SyncRun | null> {
    return (tx ?? this.prisma).syncRun.findUnique({
      where: { externalRunId },
    });
  }
}

