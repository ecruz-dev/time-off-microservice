import { BadGatewayException, Inject, Injectable } from '@nestjs/common';
import {
  AuditActorType,
  BalanceReservationStatus,
  OutboxEvent,
  OutboxEventStatus,
  TimeOffRequestStatus,
} from '@prisma/client';

import { OutboxRuntimeConfig } from '@app/config';

import { PrismaService } from '../../../database/prisma.service';
import {
  AuditLogRepository,
  BalanceReservationRepository,
  BalanceSnapshotRepository,
  OutboxEventRepository,
  TimeOffRequestRepository,
} from '../../../database/repositories/interfaces';
import { HcmClient } from '../../hcm-sync/infrastructure/hcm.client';
import { OUTBOX_RUNTIME_CONFIG } from '../outbox.constants';
import {
  APPROVAL_SYNC_RETRY_EVENT,
  ApprovalSyncRetryPayload,
  OutboxProcessingSummary,
} from '../outbox.types';

const OUTBOX_PROCESSOR_ACTOR_ID = 'outbox-processor';

@Injectable()
export class OutboxProcessorService {
  constructor(
    @Inject(OUTBOX_RUNTIME_CONFIG)
    private readonly runtimeConfig: OutboxRuntimeConfig,
    private readonly prisma: PrismaService,
    private readonly auditLogRepository: AuditLogRepository,
    private readonly balanceReservationRepository: BalanceReservationRepository,
    private readonly balanceSnapshotRepository: BalanceSnapshotRepository,
    private readonly outboxEventRepository: OutboxEventRepository,
    private readonly timeOffRequestRepository: TimeOffRequestRepository,
    private readonly hcmClient: HcmClient,
  ) {}

  async processPending(limit?: number): Promise<OutboxProcessingSummary> {
    const batchLimit = limit ?? this.runtimeConfig.batchSize;
    const events = await this.outboxEventRepository.listPending(batchLimit);
    const summary: OutboxProcessingSummary = {
      failedPermanently: 0,
      processed: events.length,
      releasedForReview: 0,
      retried: 0,
      succeeded: 0,
    };

    for (const event of events) {
      const outcome = await this.processEvent(event);

      if (outcome === 'SUCCEEDED') {
        summary.succeeded += 1;
      } else if (outcome === 'RETRIED') {
        summary.retried += 1;
      } else if (outcome === 'FAILED_PERMANENTLY') {
        summary.failedPermanently += 1;
      } else if (outcome === 'RELEASED_FOR_REVIEW') {
        summary.releasedForReview += 1;
      }
    }

    return summary;
  }

  private async processEvent(
    event: OutboxEvent,
  ): Promise<'FAILED_PERMANENTLY' | 'RELEASED_FOR_REVIEW' | 'RETRIED' | 'SKIPPED' | 'SUCCEEDED'> {
    const attemptNumber = event.attempts + 1;
    const startedAt = new Date();

    await this.outboxEventRepository.markStatus(event.id, OutboxEventStatus.PROCESSING, {
      attempts: attemptNumber,
      lastError: null,
    });

    if (event.eventType !== APPROVAL_SYNC_RETRY_EVENT) {
      await this.failOutboxEvent({
        attemptNumber,
        event,
        message: `Unsupported outbox event type: ${event.eventType}.`,
        permanent: true,
        startedAt,
      });

      return 'FAILED_PERMANENTLY';
    }

    const payload = this.parseApprovalSyncRetryPayload(event.payload);

    if (!payload) {
      await this.failOutboxEvent({
        attemptNumber,
        event,
        message: 'The approval sync retry payload was invalid.',
        permanent: true,
        startedAt,
      });

      return 'FAILED_PERMANENTLY';
    }

    const request = await this.timeOffRequestRepository.findById(payload.requestId);

    if (!request) {
      await this.failOutboxEvent({
        attemptNumber,
        event,
        message: `Time-off request ${payload.requestId} no longer exists.`,
        permanent: true,
        requestId: payload.requestId,
        startedAt,
      });

      return 'FAILED_PERMANENTLY';
    }

    if (request.status !== TimeOffRequestStatus.SYNC_FAILED) {
      await this.prisma.$transaction(async (tx) => {
        await this.outboxEventRepository.markStatus(
          event.id,
          OutboxEventStatus.SENT,
          {
            attempts: attemptNumber,
            processedAt: startedAt,
            lastError: null,
          },
          tx,
        );
        await this.auditLogRepository.create(
          {
            action: 'OUTBOX_EVENT_SKIPPED',
            actorType: AuditActorType.SYSTEM,
            actorId: OUTBOX_PROCESSOR_ACTOR_ID,
            requestId: request.id,
            entityType: 'outbox_event',
            entityId: event.id,
            metadata: JSON.stringify({
              currentRequestStatus: request.status,
              eventType: event.eventType,
              message: 'The request no longer requires a retry.',
            }),
            occurredAt: startedAt,
          },
          tx,
        );
      });

      return 'SKIPPED';
    }

    try {
      const adjustmentResponse = await this.hcmClient.applyBalanceAdjustment({
        idempotencyKey: `${payload.requestId}:${payload.managerId}:approval`,
        requestId: payload.requestId,
        employeeId: payload.employeeId,
        locationId: payload.locationId,
        deltaUnits: payload.requestedUnits * -1,
        reasonCode: 'TIME_OFF_APPROVAL',
        occurredAt: startedAt.toISOString(),
      });

      if (!adjustmentResponse.accepted) {
        if (
          adjustmentResponse.code === 'INSUFFICIENT_BALANCE' ||
          adjustmentResponse.code === 'INVALID_DIMENSIONS'
        ) {
          await this.markRequestRequiresReview({
            attemptNumber,
            event,
            message: adjustmentResponse.message,
            payload,
            requestId: request.id,
            startedAt,
          });

          return 'RELEASED_FOR_REVIEW';
        }

        await this.failOutboxEvent({
          attemptNumber,
          event,
          message: adjustmentResponse.message,
          permanent: attemptNumber >= this.runtimeConfig.maxAttempts,
          requestId: request.id,
          startedAt,
        });

        return attemptNumber >= this.runtimeConfig.maxAttempts
          ? 'FAILED_PERMANENTLY'
          : 'RETRIED';
      }

      const reservation = await this.balanceReservationRepository.findByRequestId(
        payload.requestId,
      );

      await this.prisma.$transaction(async (tx) => {
        await this.balanceSnapshotRepository.upsert(
          {
            employeeId: adjustmentResponse.employeeId,
            locationId: adjustmentResponse.locationId,
            availableUnits: adjustmentResponse.availableUnits,
            sourceVersion: adjustmentResponse.sourceVersion,
            sourceUpdatedAt: new Date(adjustmentResponse.sourceUpdatedAt),
            lastSyncedAt: startedAt,
          },
          tx,
        );

        await this.timeOffRequestRepository.updateDecision(
          request.id,
          {
            status: TimeOffRequestStatus.APPROVED,
            managerDecisionReason: payload.reason,
            approvedBy: payload.managerId,
          },
          tx,
        );

        if (reservation?.status === BalanceReservationStatus.ACTIVE) {
          await this.balanceReservationRepository.updateStatusByRequestId(
            request.id,
            BalanceReservationStatus.CONSUMED,
            tx,
          );
        }

        await this.outboxEventRepository.markStatus(
          event.id,
          OutboxEventStatus.SENT,
          {
            attempts: attemptNumber,
            processedAt: startedAt,
            lastError: null,
          },
          tx,
        );

        await this.auditLogRepository.create(
          {
            action: 'TIME_OFF_REQUEST_SYNC_RETRY_SUCCEEDED',
            actorType: AuditActorType.SYSTEM,
            actorId: OUTBOX_PROCESSOR_ACTOR_ID,
            requestId: request.id,
            entityType: 'time_off_request',
            entityId: request.id,
            metadata: JSON.stringify({
              attemptNumber,
              hcmAvailableUnits: adjustmentResponse.availableUnits,
              reviewReason: payload.reason,
              status: TimeOffRequestStatus.APPROVED,
            }),
            occurredAt: startedAt,
          },
          tx,
        );
      });

      return 'SUCCEEDED';
    } catch (error) {
      const message = this.extractUpstreamFailureMessage(
        error,
        'The retry worker could not reach HCM.',
      );
      const permanent = attemptNumber >= this.runtimeConfig.maxAttempts;

      await this.failOutboxEvent({
        attemptNumber,
        event,
        message,
        permanent,
        requestId: request.id,
        startedAt,
      });

      return permanent ? 'FAILED_PERMANENTLY' : 'RETRIED';
    }
  }

  private async markRequestRequiresReview(input: {
    attemptNumber: number;
    event: OutboxEvent;
    message: string;
    payload: ApprovalSyncRetryPayload;
    requestId: string;
    startedAt: Date;
  }): Promise<void> {
    const reservation = await this.balanceReservationRepository.findByRequestId(
      input.requestId,
    );

    await this.prisma.$transaction(async (tx) => {
      await this.timeOffRequestRepository.updateDecision(
        input.requestId,
        {
          status: TimeOffRequestStatus.REQUIRES_REVIEW,
          managerDecisionReason: input.payload.reason,
          approvedBy: null,
        },
        tx,
      );

      if (reservation?.status === BalanceReservationStatus.ACTIVE) {
        await this.balanceReservationRepository.updateStatusByRequestId(
          input.requestId,
          BalanceReservationStatus.RELEASED,
          tx,
        );
      }

      await this.outboxEventRepository.markStatus(
        input.event.id,
        OutboxEventStatus.SENT,
        {
          attempts: input.attemptNumber,
          processedAt: input.startedAt,
          lastError: input.message,
        },
        tx,
      );

      await this.auditLogRepository.create(
        {
          action: 'TIME_OFF_REQUEST_SYNC_RETRY_REQUIRES_REVIEW',
          actorType: AuditActorType.SYSTEM,
          actorId: OUTBOX_PROCESSOR_ACTOR_ID,
          requestId: input.requestId,
          entityType: 'time_off_request',
          entityId: input.requestId,
          metadata: JSON.stringify({
            attemptNumber: input.attemptNumber,
            message: input.message,
            reviewReason: input.payload.reason,
            status: TimeOffRequestStatus.REQUIRES_REVIEW,
          }),
          occurredAt: input.startedAt,
        },
        tx,
      );
    });
  }

  private async failOutboxEvent(input: {
    attemptNumber: number;
    event: OutboxEvent;
    message: string;
    permanent: boolean;
    requestId?: string;
    startedAt: Date;
  }): Promise<void> {
    const nextAvailableAt = input.permanent
      ? input.startedAt
      : new Date(
          input.startedAt.getTime() +
            this.runtimeConfig.baseDelayMs * 2 ** (input.attemptNumber - 1),
        );

    await this.prisma.$transaction(async (tx) => {
      await this.outboxEventRepository.markStatus(
        input.event.id,
        input.permanent ? OutboxEventStatus.FAILED : OutboxEventStatus.PENDING,
        {
          attempts: input.attemptNumber,
          availableAt: nextAvailableAt,
          lastError: input.message,
          processedAt: input.permanent ? input.startedAt : null,
        },
        tx,
      );

      await this.auditLogRepository.create(
        {
          action: input.permanent
            ? 'TIME_OFF_REQUEST_SYNC_RETRY_EXHAUSTED'
            : 'TIME_OFF_REQUEST_SYNC_RETRY_SCHEDULED',
          actorType: AuditActorType.SYSTEM,
          actorId: OUTBOX_PROCESSOR_ACTOR_ID,
          requestId: input.requestId ?? null,
          entityType: 'outbox_event',
          entityId: input.event.id,
          metadata: JSON.stringify({
            attemptNumber: input.attemptNumber,
            eventType: input.event.eventType,
            message: input.message,
            nextAttemptAt: input.permanent ? null : nextAvailableAt.toISOString(),
          }),
          occurredAt: input.startedAt,
        },
        tx,
      );
    });
  }

  private parseApprovalSyncRetryPayload(
    payload: string,
  ): ApprovalSyncRetryPayload | null {
    try {
      const parsed = JSON.parse(payload) as unknown;

      if (!this.isRecord(parsed)) {
        return null;
      }

      if (
        typeof parsed.employeeId !== 'string' ||
        typeof parsed.locationId !== 'string' ||
        typeof parsed.managerId !== 'string' ||
        typeof parsed.requestId !== 'string' ||
        typeof parsed.requestedUnits !== 'number' ||
        !Number.isInteger(parsed.requestedUnits)
      ) {
        return null;
      }

      return {
        employeeId: parsed.employeeId,
        locationId: parsed.locationId,
        managerId: parsed.managerId,
        reason: typeof parsed.reason === 'string' ? parsed.reason : null,
        requestId: parsed.requestId,
        requestedUnits: parsed.requestedUnits,
      };
    } catch {
      return null;
    }
  }

  private extractUpstreamFailureMessage(
    error: unknown,
    fallbackMessage: string,
  ): string {
    if (error instanceof BadGatewayException) {
      const response = error.getResponse();

      if (this.isRecord(response) && typeof response.message === 'string') {
        return response.message;
      }
    }

    return fallbackMessage;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
