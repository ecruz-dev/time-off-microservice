import { Injectable } from '@nestjs/common';
import { OutboxEvent, OutboxEventStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma.service';
import { OutboxEventRepository, PrismaTransactionClient } from '../interfaces';

@Injectable()
export class PrismaOutboxEventRepository extends OutboxEventRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(
    data: Prisma.OutboxEventUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<OutboxEvent> {
    return (tx ?? this.prisma).outboxEvent.create({ data });
  }

  async listPending(
    limit: number,
    tx?: PrismaTransactionClient,
  ): Promise<OutboxEvent[]> {
    return (tx ?? this.prisma).outboxEvent.findMany({
      where: { status: OutboxEventStatus.PENDING },
      orderBy: { availableAt: 'asc' },
      take: limit,
    });
  }

  async markStatus(
    id: string,
    status: OutboxEventStatus,
    data?: Pick<
      Prisma.OutboxEventUncheckedUpdateInput,
      'attempts' | 'lastError' | 'processedAt' | 'availableAt'
    >,
    tx?: PrismaTransactionClient,
  ): Promise<OutboxEvent> {
    return (tx ?? this.prisma).outboxEvent.update({
      where: { id },
      data: {
        status,
        ...data,
      },
    });
  }
}

