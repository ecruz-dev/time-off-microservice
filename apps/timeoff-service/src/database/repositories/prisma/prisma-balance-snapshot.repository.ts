import { Injectable } from '@nestjs/common';
import { BalanceSnapshot, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma.service';
import { BalanceSnapshotRepository, PrismaTransactionClient } from '../interfaces';

@Injectable()
export class PrismaBalanceSnapshotRepository extends BalanceSnapshotRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findByEmployeeAndLocation(
    employeeId: string,
    locationId: string,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceSnapshot | null> {
    return (tx ?? this.prisma).balanceSnapshot.findUnique({
      where: {
        employeeId_locationId: {
          employeeId,
          locationId,
        },
      },
    });
  }

  async upsert(
    data: Prisma.BalanceSnapshotUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceSnapshot> {
    return (tx ?? this.prisma).balanceSnapshot.upsert({
      where: {
        employeeId_locationId: {
          employeeId: data.employeeId,
          locationId: data.locationId,
        },
      },
      create: data,
      update: {
        availableUnits: data.availableUnits,
        sourceVersion: data.sourceVersion,
        sourceUpdatedAt: data.sourceUpdatedAt,
        lastSyncedAt: data.lastSyncedAt,
      },
    });
  }

  async listByEmployee(
    employeeId: string,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceSnapshot[]> {
    return (tx ?? this.prisma).balanceSnapshot.findMany({
      where: { employeeId },
      orderBy: { locationId: 'asc' },
    });
  }
}

