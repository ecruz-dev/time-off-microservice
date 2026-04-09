import { Injectable } from '@nestjs/common';
import { Employee, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma.service';
import { EmployeeRepository, PrismaTransactionClient } from '../interfaces';

@Injectable()
export class PrismaEmployeeRepository extends EmployeeRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(
    data: Prisma.EmployeeCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<Employee> {
    return (tx ?? this.prisma).employee.create({ data });
  }

  async upsert(
    data: Prisma.EmployeeUncheckedCreateInput,
    tx?: PrismaTransactionClient,
  ): Promise<Employee> {
    return (tx ?? this.prisma).employee.upsert({
      where: { id: data.id },
      create: data,
      update: {
        email: data.email,
        displayName: data.displayName,
        isActive: data.isActive ?? true,
        locationId: data.locationId,
        managerId: data.managerId,
      },
    });
  }

  async findById(
    id: string,
    tx?: PrismaTransactionClient,
  ): Promise<Employee | null> {
    return (tx ?? this.prisma).employee.findUnique({
      where: { id },
    });
  }

  async list(tx?: PrismaTransactionClient): Promise<Employee[]> {
    return (tx ?? this.prisma).employee.findMany({
      orderBy: { id: 'asc' },
    });
  }
}

