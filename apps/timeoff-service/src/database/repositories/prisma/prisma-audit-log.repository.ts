import { Injectable } from '@nestjs/common';
import { AuditLog, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma.service';
import { AuditLogRepository, PrismaTransactionClient } from '../interfaces';

@Injectable()
export class PrismaAuditLogRepository extends AuditLogRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(
    data: Prisma.AuditLogUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<AuditLog> {
    return (tx ?? this.prisma).auditLog.create({ data });
  }

  async listByRequestId(
    requestId: string,
    tx?: PrismaTransactionClient,
  ): Promise<AuditLog[]> {
    return (tx ?? this.prisma).auditLog.findMany({
      where: { requestId },
      orderBy: { occurredAt: 'asc' },
    });
  }
}

