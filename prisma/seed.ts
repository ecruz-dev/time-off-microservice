import {
  AuditActorType,
  BalanceReservationStatus,
  IdempotencyStatus,
  OutboxEventStatus,
  PrismaClient,
  SyncRunStatus,
  TimeOffRequestStatus,
} from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL ?? 'file:./dev.db',
    },
  },
});

async function main(): Promise<void> {
  const aliceRequestId = 'req_alice_may';
  const aliceAuditLogId = 'audit_req_alice_created';
  const aliceOutboxEventId = 'outbox_req_alice_created';
  const now = new Date('2026-04-08T17:00:00.000Z');

  for (const employee of [
    {
      id: 'emp_alice',
      email: 'alice@example.com',
      displayName: 'Alice Johnson',
      locationId: 'loc_ny',
      managerId: 'mgr_sam',
    },
    {
      id: 'emp_bob',
      email: 'bob@example.com',
      displayName: 'Bob Martinez',
      locationId: 'loc_ny',
      managerId: 'mgr_sam',
    },
    {
      id: 'mgr_sam',
      email: 'sam@example.com',
      displayName: 'Sam Patel',
      locationId: 'loc_ny',
      managerId: null,
    },
  ]) {
    await prisma.employee.upsert({
      where: { id: employee.id },
      create: employee,
      update: employee,
    });
  }

  for (const snapshot of [
    {
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      availableUnits: 8000,
      sourceVersion: 'seed-v1-alice',
      sourceUpdatedAt: now,
      lastSyncedAt: now,
    },
    {
      employeeId: 'emp_bob',
      locationId: 'loc_ny',
      availableUnits: 12000,
      sourceVersion: 'seed-v1-bob',
      sourceUpdatedAt: now,
      lastSyncedAt: now,
    },
  ]) {
    await prisma.balanceSnapshot.upsert({
      where: {
        employeeId_locationId: {
          employeeId: snapshot.employeeId,
          locationId: snapshot.locationId,
        },
      },
      create: snapshot,
      update: snapshot,
    });
  }

  await prisma.timeOffRequest.upsert({
    where: { id: aliceRequestId },
    create: {
      id: aliceRequestId,
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      startDate: new Date('2026-05-11T00:00:00.000Z'),
      endDate: new Date('2026-05-12T00:00:00.000Z'),
      requestedUnits: 2000,
      reason: 'Family trip',
      status: TimeOffRequestStatus.PENDING,
      createdBy: 'emp_alice',
    },
    update: {
      requestedUnits: 2000,
      reason: 'Family trip',
      status: TimeOffRequestStatus.PENDING,
      updatedAt: now,
    },
  });

  await prisma.balanceReservation.upsert({
    where: { requestId: aliceRequestId },
    create: {
      requestId: aliceRequestId,
      employeeId: 'emp_alice',
      locationId: 'loc_ny',
      reservedUnits: 2000,
      status: BalanceReservationStatus.ACTIVE,
    },
    update: {
      reservedUnits: 2000,
      status: BalanceReservationStatus.ACTIVE,
      updatedAt: now,
    },
  });

  await prisma.syncRun.upsert({
    where: { externalRunId: 'seed-sync-run-1' },
    create: {
      source: 'seed',
      externalRunId: 'seed-sync-run-1',
      status: SyncRunStatus.COMPLETED,
      sentAt: now,
      startedAt: now,
      completedAt: now,
      recordsReceived: 2,
      recordsApplied: 2,
    },
    update: {
      status: SyncRunStatus.COMPLETED,
      completedAt: now,
      recordsReceived: 2,
      recordsApplied: 2,
      updatedAt: now,
    },
  });

  await prisma.outboxEvent.upsert({
    where: { id: aliceOutboxEventId },
    create: {
      id: aliceOutboxEventId,
      eventType: 'timeoff.request.created.v1',
      aggregateType: 'time_off_request',
      aggregateId: aliceRequestId,
      payload: JSON.stringify({
        requestId: aliceRequestId,
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        requestedUnits: 2000,
      }),
      status: OutboxEventStatus.PENDING,
    },
    update: {
      payload: JSON.stringify({
        requestId: aliceRequestId,
        employeeId: 'emp_alice',
        locationId: 'loc_ny',
        requestedUnits: 2000,
      }),
      status: OutboxEventStatus.PENDING,
      attempts: 0,
      lastError: null,
      processedAt: null,
      availableAt: now,
    },
  });

  await prisma.auditLog.upsert({
    where: { id: aliceAuditLogId },
    create: {
      id: aliceAuditLogId,
      action: 'TIME_OFF_REQUEST_CREATED',
      actorType: AuditActorType.EMPLOYEE,
      actorId: 'emp_alice',
      requestId: aliceRequestId,
      entityType: 'time_off_request',
      entityId: aliceRequestId,
      metadata: JSON.stringify({
        requestedUnits: 2000,
        locationId: 'loc_ny',
      }),
      occurredAt: now,
    },
    update: {
      metadata: JSON.stringify({
        requestedUnits: 2000,
        locationId: 'loc_ny',
      }),
      occurredAt: now,
    },
  });

  await prisma.idempotencyKey.upsert({
    where: {
      scope_idempotencyKey: {
        scope: 'timeoff.create',
        idempotencyKey: 'seed-create-req-1',
      },
    },
    create: {
      idempotencyKey: 'seed-create-req-1',
      scope: 'timeoff.create',
      fingerprint: 'emp_alice:loc_ny:2026-05-11:2026-05-12:2000',
      status: IdempotencyStatus.COMPLETED,
      responseCode: 201,
      responseBody: JSON.stringify({
        requestId: aliceRequestId,
        status: TimeOffRequestStatus.PENDING,
      }),
      lockedAt: now,
    },
    update: {
      status: IdempotencyStatus.COMPLETED,
      responseCode: 201,
      responseBody: JSON.stringify({
        requestId: aliceRequestId,
        status: TimeOffRequestStatus.PENDING,
      }),
      errorCode: null,
      lockedAt: now,
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
