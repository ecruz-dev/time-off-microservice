import { Module } from '@nestjs/common';

import { PrismaModule } from './prisma.module';
import {
  AuditLogRepository,
  BalanceReservationRepository,
  BalanceSnapshotRepository,
  EmployeeRepository,
  IdempotencyKeyRepository,
  OutboxEventRepository,
  SyncRunRepository,
  TimeOffRequestRepository,
} from './repositories/interfaces';
import {
  PrismaAuditLogRepository,
  PrismaBalanceReservationRepository,
  PrismaBalanceSnapshotRepository,
  PrismaEmployeeRepository,
  PrismaIdempotencyKeyRepository,
  PrismaOutboxEventRepository,
  PrismaSyncRunRepository,
  PrismaTimeOffRequestRepository,
} from './repositories/prisma';

@Module({
  imports: [PrismaModule],
  providers: [
    PrismaEmployeeRepository,
    PrismaBalanceSnapshotRepository,
    PrismaBalanceReservationRepository,
    PrismaTimeOffRequestRepository,
    PrismaSyncRunRepository,
    PrismaOutboxEventRepository,
    PrismaAuditLogRepository,
    PrismaIdempotencyKeyRepository,
    {
      provide: EmployeeRepository,
      useExisting: PrismaEmployeeRepository,
    },
    {
      provide: BalanceSnapshotRepository,
      useExisting: PrismaBalanceSnapshotRepository,
    },
    {
      provide: BalanceReservationRepository,
      useExisting: PrismaBalanceReservationRepository,
    },
    {
      provide: TimeOffRequestRepository,
      useExisting: PrismaTimeOffRequestRepository,
    },
    {
      provide: SyncRunRepository,
      useExisting: PrismaSyncRunRepository,
    },
    {
      provide: OutboxEventRepository,
      useExisting: PrismaOutboxEventRepository,
    },
    {
      provide: AuditLogRepository,
      useExisting: PrismaAuditLogRepository,
    },
    {
      provide: IdempotencyKeyRepository,
      useExisting: PrismaIdempotencyKeyRepository,
    },
  ],
  exports: [
    PrismaModule,
    EmployeeRepository,
    BalanceSnapshotRepository,
    BalanceReservationRepository,
    TimeOffRequestRepository,
    SyncRunRepository,
    OutboxEventRepository,
    AuditLogRepository,
    IdempotencyKeyRepository,
  ],
})
export class DatabaseModule {}

