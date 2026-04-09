import { Injectable } from '@nestjs/common';
import {
  BalanceReservation,
  BalanceReservationStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma.service';
import {
  BalanceReservationRepository,
  PrismaTransactionClient,
} from '../interfaces';

@Injectable()
export class PrismaBalanceReservationRepository extends BalanceReservationRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(
    data: Prisma.BalanceReservationUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceReservation> {
    return (tx ?? this.prisma).balanceReservation.create({ data });
  }

  async findActiveByEmployeeAndLocation(
    employeeId: string,
    locationId: string,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceReservation[]> {
    return (tx ?? this.prisma).balanceReservation.findMany({
      where: {
        employeeId,
        locationId,
        status: BalanceReservationStatus.ACTIVE,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateStatusByRequestId(
    requestId: string,
    status: BalanceReservationStatus,
    tx?: PrismaTransactionClient,
  ): Promise<BalanceReservation> {
    return (tx ?? this.prisma).balanceReservation.update({
      where: { requestId },
      data: { status },
    });
  }
}

