import { Injectable } from '@nestjs/common';
import {
  AuditActorType,
  BalanceReservationStatus,
  BalanceSnapshot,
  TimeOffRequestStatus,
} from '@prisma/client';

import {
  AuditLogRepository,
  BalanceReservationRepository,
  OutboxEventRepository,
  PrismaTransactionClient,
  TimeOffRequestRepository,
} from '../../../database/repositories/interfaces';

export interface IncomingSnapshotVersion {
  availableUnits: number;
  employeeId: string;
  locationId: string;
  sourceUpdatedAt: Date;
  sourceVersion: string;
}

export type SnapshotChangeDisposition = 'APPLY' | 'STALE' | 'UNCHANGED';

export interface SnapshotReconciliationInput {
  nextSnapshot: BalanceSnapshot;
  previousSnapshot: BalanceSnapshot | null;
  source: string;
  syncRunId: string;
}

export interface SnapshotReconciliationResult {
  requestsFlagged: number;
  reservationsReleased: number;
  snapshotUpdated: boolean;
}

interface ReconciliationCandidate {
  createdAt: Date;
  requestId: string;
  reservedUnits: number;
  status: TimeOffRequestStatus;
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly auditLogRepository: AuditLogRepository,
    private readonly balanceReservationRepository: BalanceReservationRepository,
    private readonly outboxEventRepository: OutboxEventRepository,
    private readonly timeOffRequestRepository: TimeOffRequestRepository,
  ) {}

  getSnapshotChangeDisposition(
    previousSnapshot: Pick<
      BalanceSnapshot,
      'availableUnits' | 'sourceUpdatedAt' | 'sourceVersion'
    > | null,
    incomingSnapshot: IncomingSnapshotVersion,
  ): SnapshotChangeDisposition {
    if (!previousSnapshot) {
      return 'APPLY';
    }

    const previousUpdatedAt = previousSnapshot.sourceUpdatedAt.getTime();
    const incomingUpdatedAt = incomingSnapshot.sourceUpdatedAt.getTime();

    if (incomingUpdatedAt < previousUpdatedAt) {
      return 'STALE';
    }

    if (
      incomingUpdatedAt === previousUpdatedAt &&
      previousSnapshot.availableUnits === incomingSnapshot.availableUnits &&
      previousSnapshot.sourceVersion === incomingSnapshot.sourceVersion
    ) {
      return 'UNCHANGED';
    }

    return 'APPLY';
  }

  async reconcileSnapshotChange(
    input: SnapshotReconciliationInput,
    tx: PrismaTransactionClient,
  ): Promise<SnapshotReconciliationResult> {
    const snapshotUpdated = this.hasSnapshotChanged(
      input.previousSnapshot,
      input.nextSnapshot,
    );

    if (!snapshotUpdated) {
      return {
        requestsFlagged: 0,
        reservationsReleased: 0,
        snapshotUpdated: false,
      };
    }

    await this.auditLogRepository.create(
      {
        action: 'HCM_BALANCE_SNAPSHOT_UPDATED',
        actorType: this.getActorType(input.source),
        actorId: input.source,
        syncRunId: input.syncRunId,
        entityType: 'balance_snapshot',
        entityId: this.toSnapshotAggregateId(input.nextSnapshot),
        metadata: JSON.stringify({
          employeeId: input.nextSnapshot.employeeId,
          locationId: input.nextSnapshot.locationId,
          previousAvailableUnits: input.previousSnapshot?.availableUnits ?? null,
          nextAvailableUnits: input.nextSnapshot.availableUnits,
          previousSourceVersion: input.previousSnapshot?.sourceVersion ?? null,
          nextSourceVersion: input.nextSnapshot.sourceVersion,
          previousSourceUpdatedAt:
            input.previousSnapshot?.sourceUpdatedAt.toISOString() ?? null,
          nextSourceUpdatedAt: input.nextSnapshot.sourceUpdatedAt.toISOString(),
        }),
        occurredAt: input.nextSnapshot.lastSyncedAt,
      },
      tx,
    );

    await this.outboxEventRepository.create(
      {
        eventType: 'balance.snapshot.updated.v1',
        aggregateType: 'balance_snapshot',
        aggregateId: this.toSnapshotAggregateId(input.nextSnapshot),
        payload: JSON.stringify({
          eventType: 'balance.snapshot.updated.v1',
          employeeId: input.nextSnapshot.employeeId,
          locationId: input.nextSnapshot.locationId,
          availableUnits: input.nextSnapshot.availableUnits,
          sourceVersion: input.nextSnapshot.sourceVersion,
          occurredAt: input.nextSnapshot.lastSyncedAt.toISOString(),
        }),
      },
      tx,
    );

    const activeReservations =
      await this.balanceReservationRepository.findActiveByEmployeeAndLocation(
        input.nextSnapshot.employeeId,
        input.nextSnapshot.locationId,
        tx,
      );

    if (!activeReservations.length) {
      return {
        requestsFlagged: 0,
        reservationsReleased: 0,
        snapshotUpdated: true,
      };
    }

    const requestIds = activeReservations.map((reservation) => reservation.requestId);
    const relatedRequests = await tx.timeOffRequest.findMany({
      where: {
        id: {
          in: requestIds,
        },
        status: {
          in: [
            TimeOffRequestStatus.PENDING,
            TimeOffRequestStatus.SYNC_FAILED,
            TimeOffRequestStatus.REQUIRES_REVIEW,
          ],
        },
      },
      select: {
        createdAt: true,
        id: true,
        requestedUnits: true,
        status: true,
      },
    });
    const requestsById = new Map(
      relatedRequests.map((request) => [request.id, request]),
    );
    const candidates: ReconciliationCandidate[] = activeReservations
      .map((reservation) => {
        const request = requestsById.get(reservation.requestId);

        if (!request) {
          return null;
        }

        return {
          createdAt: request.createdAt,
          requestId: request.id,
          reservedUnits: reservation.reservedUnits,
          status: request.status,
        } satisfies ReconciliationCandidate;
      })
      .filter((candidate): candidate is ReconciliationCandidate => candidate !== null);

    if (!candidates.length) {
      return {
        requestsFlagged: 0,
        reservationsReleased: 0,
        snapshotUpdated: true,
      };
    }

    const totalReservedUnits = candidates.reduce(
      (total, candidate) => total + candidate.reservedUnits,
      0,
    );

    if (input.nextSnapshot.availableUnits >= totalReservedUnits) {
      return {
        requestsFlagged: 0,
        reservationsReleased: 0,
        snapshotUpdated: true,
      };
    }

    let shortageUnits = totalReservedUnits - input.nextSnapshot.availableUnits;
    let requestsFlagged = 0;
    let reservationsReleased = 0;
    const candidatesToFlag = [...candidates].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );

    for (const candidate of candidatesToFlag) {
      if (shortageUnits <= 0) {
        break;
      }

      const updatedRequest = await this.timeOffRequestRepository.updateDecision(
        candidate.requestId,
        {
          status: TimeOffRequestStatus.REQUIRES_REVIEW,
          approvedBy: null,
        },
        tx,
      );

      await this.balanceReservationRepository.updateStatusByRequestId(
        candidate.requestId,
        BalanceReservationStatus.RELEASED,
        tx,
      );

      await this.auditLogRepository.create(
        {
          action: 'BALANCE_RECONCILIATION_FLAGGED',
          actorType: this.getActorType(input.source),
          actorId: input.source,
          requestId: updatedRequest.id,
          syncRunId: input.syncRunId,
          entityType: 'time_off_request',
          entityId: updatedRequest.id,
          metadata: JSON.stringify({
            employeeId: updatedRequest.employeeId,
            locationId: updatedRequest.locationId,
            previousAvailableUnits: input.previousSnapshot?.availableUnits ?? null,
            nextAvailableUnits: input.nextSnapshot.availableUnits,
            previousSourceVersion: input.previousSnapshot?.sourceVersion ?? null,
            nextSourceVersion: input.nextSnapshot.sourceVersion,
            reason: 'Snapshot drift invalidated one or more pending reservations.',
            releasedReservedUnits: candidate.reservedUnits,
          }),
          occurredAt: input.nextSnapshot.lastSyncedAt,
        },
        tx,
      );

      await this.outboxEventRepository.create(
        {
          eventType: 'balance.reconciliation.flagged.v1',
          aggregateType: 'time_off_request',
          aggregateId: updatedRequest.id,
          payload: JSON.stringify({
            eventType: 'balance.reconciliation.flagged.v1',
            employeeId: updatedRequest.employeeId,
            locationId: updatedRequest.locationId,
            requestId: updatedRequest.id,
            reason: 'Snapshot changed materially while request was pending',
            occurredAt: input.nextSnapshot.lastSyncedAt.toISOString(),
          }),
        },
        tx,
      );

      shortageUnits -= candidate.reservedUnits;
      requestsFlagged += 1;
      reservationsReleased += 1;
    }

    return {
      requestsFlagged,
      reservationsReleased,
      snapshotUpdated: true,
    };
  }

  private hasSnapshotChanged(
    previousSnapshot: BalanceSnapshot | null,
    nextSnapshot: BalanceSnapshot,
  ): boolean {
    if (!previousSnapshot) {
      return true;
    }

    return (
      previousSnapshot.availableUnits !== nextSnapshot.availableUnits ||
      previousSnapshot.sourceVersion !== nextSnapshot.sourceVersion ||
      previousSnapshot.sourceUpdatedAt.getTime() !==
        nextSnapshot.sourceUpdatedAt.getTime()
    );
  }

  private getActorType(source: string): AuditActorType {
    return source === 'hcm-batch-push' ? AuditActorType.HCM : AuditActorType.SYSTEM;
  }

  private toSnapshotAggregateId(snapshot: {
    employeeId: string;
    locationId: string;
  }): string {
    return `${snapshot.employeeId}:${snapshot.locationId}`;
  }
}
