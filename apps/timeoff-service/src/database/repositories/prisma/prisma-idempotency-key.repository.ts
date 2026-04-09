import { Injectable } from '@nestjs/common';
import { IdempotencyKey, IdempotencyStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma.service';
import {
  IdempotencyKeyRepository,
  PrismaTransactionClient,
} from '../interfaces';

@Injectable()
export class PrismaIdempotencyKeyRepository extends IdempotencyKeyRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(
    data: Prisma.IdempotencyKeyUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<IdempotencyKey> {
    return (tx ?? this.prisma).idempotencyKey.create({ data });
  }

  async findByScopeAndKey(
    scope: string,
    idempotencyKey: string,
    tx?: PrismaTransactionClient,
  ): Promise<IdempotencyKey | null> {
    return (tx ?? this.prisma).idempotencyKey.findUnique({
      where: {
        scope_idempotencyKey: {
          scope,
          idempotencyKey,
        },
      },
    });
  }

  async markStatus(
    id: string,
    status: IdempotencyStatus,
    data?: Pick<
      Prisma.IdempotencyKeyUncheckedUpdateInput,
      'responseCode' | 'responseBody' | 'errorCode' | 'lockedAt'
    >,
    tx?: PrismaTransactionClient,
  ): Promise<IdempotencyKey> {
    return (tx ?? this.prisma).idempotencyKey.update({
      where: { id },
      data: {
        status,
        ...data,
      },
    });
  }
}

