import { BadGatewayException, Injectable } from '@nestjs/common';
import {
  AuditActorType,
  BalanceReservationStatus,
  IdempotencyStatus,
  Prisma,
  TimeOffRequest,
  TimeOffRequestStatus,
} from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  AuditLogRepository,
  BalanceReservationRepository,
  BalanceSnapshotRepository,
  EmployeeRepository,
  IdempotencyKeyRepository,
  TimeOffRequestRepository,
} from '../../../database/repositories/interfaces';
import {
  AuthoritativeBalanceSnapshot,
  PendingBalanceReservation,
  calculateEffectiveBalance,
  hasSufficientEffectiveBalance,
} from '../../balances/domain';
import { HcmClient } from '../../hcm-sync/infrastructure/hcm.client';
import {
  RequestCreationError,
  requestCreationErrorCodes,
} from './request-creation.error';

type ReviewDecision = 'APPROVE' | 'REJECT';

export interface ReviewTimeOffRequestCommand {
  actorId: string;
  decision: ReviewDecision;
  idempotencyKey: string;
  reason?: string | null;
  requestId: string;
}

@Injectable()
export class ReviewTimeOffRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employeeRepository: EmployeeRepository,
    private readonly balanceSnapshotRepository: BalanceSnapshotRepository,
    private readonly balanceReservationRepository: BalanceReservationRepository,
    private readonly timeOffRequestRepository: TimeOffRequestRepository,
    private readonly auditLogRepository: AuditLogRepository,
    private readonly idempotencyKeyRepository: IdempotencyKeyRepository,
    private readonly hcmClient: HcmClient,
  ) {}

  async execute(command: ReviewTimeOffRequestCommand): Promise<TimeOffRequest> {
    const normalizedCommand = this.normalizeAndValidateCommand(command);
    const scope = this.getIdempotencyScope(normalizedCommand.decision);
    const now = new Date();
    const fingerprint = this.buildFingerprint(normalizedCommand);
    const replayedRequest = await this.replayExistingIdempotentDecision(
      scope,
      normalizedCommand.idempotencyKey,
      fingerprint,
    );

    if (replayedRequest) {
      return replayedRequest;
    }

    const idempotencyRecord = await this.createIdempotencyRecord(
      scope,
      normalizedCommand.idempotencyKey,
      fingerprint,
      now,
    );

    try {
      const manager = await this.employeeRepository.findById(
        normalizedCommand.actorId,
      );

      if (!manager) {
        throw new RequestCreationError(
          requestCreationErrorCodes.notFound,
          'Manager not found.',
        );
      }

      if (!manager.isActive) {
        throw new RequestCreationError(
          requestCreationErrorCodes.forbidden,
          'Inactive managers cannot review time-off requests.',
        );
      }

      const request = await this.timeOffRequestRepository.findById(
        normalizedCommand.requestId,
      );

      if (!request) {
        throw new RequestCreationError(
          requestCreationErrorCodes.notFound,
          'Time-off request not found.',
        );
      }

      this.assertReviewableStatus(request, normalizedCommand.decision);

      const employee = await this.employeeRepository.findById(request.employeeId);

      if (!employee) {
        throw new RequestCreationError(
          requestCreationErrorCodes.notFound,
          'Employee not found for the time-off request.',
        );
      }

      this.assertManagerAuthorization(manager, employee, request.locationId);

      const reservation = await this.balanceReservationRepository.findByRequestId(
        request.id,
      );

      const reviewedRequest =
        normalizedCommand.decision === 'REJECT'
          ? await this.rejectRequest({
              managerId: manager.id,
              now,
              reason: normalizedCommand.reason ?? null,
              request,
              reservation,
            })
          : await this.approveRequest({
              managerId: manager.id,
              now,
              reason: normalizedCommand.reason ?? null,
              request,
              reservation,
            });

      await this.idempotencyKeyRepository.markStatus(
        idempotencyRecord.id,
        IdempotencyStatus.COMPLETED,
        {
          responseCode: 200,
          responseBody: JSON.stringify({
            requestId: reviewedRequest.id,
            status: reviewedRequest.status,
          }),
          errorCode: null,
          lockedAt: now,
        },
      );

      return reviewedRequest;
    } catch (error) {
      const normalizedError = this.normalizeApplicationError(error);

      await this.idempotencyKeyRepository.markStatus(
        idempotencyRecord.id,
        IdempotencyStatus.FAILED,
        {
          responseCode: 200,
          responseBody: JSON.stringify({
            code: normalizedError.code,
            message: normalizedError.message,
          }),
          errorCode: normalizedError.code,
          lockedAt: now,
        },
      );

      throw normalizedError;
    }
  }

  private async approveRequest(input: {
    managerId: string;
    now: Date;
    reason: string | null;
    request: TimeOffRequest;
    reservation: {
      requestId: string;
      employeeId: string;
      locationId: string;
      reservedUnits: number;
      status: BalanceReservationStatus;
      expiresAt: Date | null;
    } | null;
  }): Promise<TimeOffRequest> {
    if (!input.reservation) {
      return this.markRequestForReview({
        action: 'TIME_OFF_REQUEST_REQUIRES_REVIEW',
        managerId: input.managerId,
        metadata: {
          reasonCode: 'MISSING_RESERVATION',
          message: 'The request is missing an active reservation.',
        },
        now: input.now,
        releaseReservation: false,
        request: input.request,
        reviewReason: input.reason,
      });
    }

    let refreshedSnapshotRecord;

    try {
      const refreshedBalance = await this.hcmClient.getBalance(
        input.request.employeeId,
        input.request.locationId,
      );

      refreshedSnapshotRecord = await this.balanceSnapshotRepository.upsert({
        employeeId: refreshedBalance.employeeId,
        locationId: refreshedBalance.locationId,
        availableUnits: refreshedBalance.availableUnits,
        sourceVersion: refreshedBalance.sourceVersion,
        sourceUpdatedAt: new Date(refreshedBalance.sourceUpdatedAt),
        lastSyncedAt: input.now,
      });
    } catch (error) {
      return this.handleApprovalRefreshFailure({
        error,
        managerId: input.managerId,
        now: input.now,
        request: input.request,
        reviewReason: input.reason,
      });
    }

    const activeReservations =
      await this.balanceReservationRepository.findActiveByEmployeeAndLocation(
        input.request.employeeId,
        input.request.locationId,
      );
    const competingReservations = activeReservations
      .filter((reservation) => reservation.requestId !== input.request.id)
      .map((reservation) => this.toPendingBalanceReservation(reservation));
    const refreshedSnapshot =
      this.toAuthoritativeBalanceSnapshot(refreshedSnapshotRecord);
    const effectiveBalance = calculateEffectiveBalance({
      snapshot: refreshedSnapshot,
      reservations: competingReservations,
      now: input.now,
    });

    if (
      !hasSufficientEffectiveBalance(
        effectiveBalance,
        input.request.requestedUnits,
      )
    ) {
      return this.markRequestForReview({
        action: 'TIME_OFF_REQUEST_REQUIRES_REVIEW',
        managerId: input.managerId,
        metadata: {
          reasonCode: 'INSUFFICIENT_BALANCE_AFTER_REVALIDATION',
          message:
            'The authoritative HCM balance no longer supports approval.',
          availableUnits: refreshedSnapshot.availableUnits,
          competingReservedUnits: effectiveBalance.reservedUnits,
        },
        now: input.now,
        releaseReservation: true,
        request: input.request,
        reviewReason: input.reason,
      });
    }

    let adjustmentResponse;

    try {
      adjustmentResponse = await this.hcmClient.applyBalanceAdjustment({
        idempotencyKey: `${input.request.id}:${input.managerId}:approval`,
        requestId: input.request.id,
        employeeId: input.request.employeeId,
        locationId: input.request.locationId,
        deltaUnits: input.request.requestedUnits * -1,
        reasonCode: 'TIME_OFF_APPROVAL',
        occurredAt: input.now.toISOString(),
      });
    } catch (error) {
      return this.markRequestSyncFailed({
        managerId: input.managerId,
        message: this.extractUpstreamFailureMessage(
          error,
          'Unable to write the approval to HCM.',
        ),
        now: input.now,
        request: input.request,
        reviewReason: input.reason,
      });
    }

    if (!adjustmentResponse.accepted) {
      if (
        adjustmentResponse.code === 'INSUFFICIENT_BALANCE' ||
        adjustmentResponse.code === 'INVALID_DIMENSIONS'
      ) {
        return this.markRequestForReview({
          action: 'TIME_OFF_REQUEST_REQUIRES_REVIEW',
          managerId: input.managerId,
          metadata: {
            reasonCode: adjustmentResponse.code,
            message: adjustmentResponse.message,
          },
          now: input.now,
          releaseReservation: true,
          request: input.request,
          reviewReason: input.reason,
        });
      }

      return this.markRequestSyncFailed({
        managerId: input.managerId,
        message: adjustmentResponse.message,
        now: input.now,
        request: input.request,
        reviewReason: input.reason,
      });
    }

    await this.balanceSnapshotRepository.upsert({
      employeeId: adjustmentResponse.employeeId,
      locationId: adjustmentResponse.locationId,
      availableUnits: adjustmentResponse.availableUnits,
      sourceVersion: adjustmentResponse.sourceVersion,
      sourceUpdatedAt: new Date(adjustmentResponse.sourceUpdatedAt),
      lastSyncedAt: input.now,
    });

    return this.prisma.$transaction(async (tx) => {
      const approvedRequest = await this.timeOffRequestRepository.updateDecision(
        input.request.id,
        {
          status: TimeOffRequestStatus.APPROVED,
          managerDecisionReason: input.reason,
          approvedBy: input.managerId,
        },
        tx,
      );

      await this.balanceReservationRepository.updateStatusByRequestId(
        input.request.id,
        BalanceReservationStatus.CONSUMED,
        tx,
      );

      await this.auditLogRepository.create(
        {
          action: 'TIME_OFF_REQUEST_APPROVED',
          actorType: AuditActorType.MANAGER,
          actorId: input.managerId,
          requestId: input.request.id,
          entityType: 'time_off_request',
          entityId: input.request.id,
          metadata: JSON.stringify({
            reviewReason: input.reason,
            status: TimeOffRequestStatus.APPROVED,
            hcmAvailableUnits: adjustmentResponse.availableUnits,
          }),
          occurredAt: input.now,
        },
        tx,
      );

      return approvedRequest;
    });
  }

  private async rejectRequest(input: {
    managerId: string;
    now: Date;
    reason: string | null;
    request: TimeOffRequest;
    reservation: {
      requestId: string;
      status: BalanceReservationStatus;
    } | null;
  }): Promise<TimeOffRequest> {
    return this.prisma.$transaction(async (tx) => {
      const rejectedRequest = await this.timeOffRequestRepository.updateDecision(
        input.request.id,
        {
          status: TimeOffRequestStatus.REJECTED,
          managerDecisionReason: input.reason,
          approvedBy: null,
        },
        tx,
      );

      if (input.reservation) {
        await this.balanceReservationRepository.updateStatusByRequestId(
          input.request.id,
          BalanceReservationStatus.RELEASED,
          tx,
        );
      }

      await this.auditLogRepository.create(
        {
          action: 'TIME_OFF_REQUEST_REJECTED',
          actorType: AuditActorType.MANAGER,
          actorId: input.managerId,
          requestId: input.request.id,
          entityType: 'time_off_request',
          entityId: input.request.id,
          metadata: JSON.stringify({
            reviewReason: input.reason,
            status: TimeOffRequestStatus.REJECTED,
          }),
          occurredAt: input.now,
        },
        tx,
      );

      return rejectedRequest;
    });
  }

  private async handleApprovalRefreshFailure(input: {
    error: unknown;
    managerId: string;
    now: Date;
    request: TimeOffRequest;
    reviewReason: string | null;
  }): Promise<TimeOffRequest> {
    const response = this.extractUpstreamFailureResponse(input.error);

    if (response?.code === 'INVALID_DIMENSIONS') {
      return this.markRequestForReview({
        action: 'TIME_OFF_REQUEST_REQUIRES_REVIEW',
        managerId: input.managerId,
        metadata: {
          reasonCode: response.code,
          message: response.message,
        },
        now: input.now,
        releaseReservation: true,
        request: input.request,
        reviewReason: input.reviewReason,
      });
    }

    return this.markRequestSyncFailed({
      managerId: input.managerId,
      message:
        response?.message ?? 'Unable to refresh the authoritative HCM balance.',
      now: input.now,
      request: input.request,
      reviewReason: input.reviewReason,
    });
  }

  private async markRequestForReview(input: {
    action: string;
    managerId: string;
    metadata: Record<string, unknown>;
    now: Date;
    releaseReservation: boolean;
    request: TimeOffRequest;
    reviewReason: string | null;
  }): Promise<TimeOffRequest> {
    return this.prisma.$transaction(async (tx) => {
      const reviewedRequest = await this.timeOffRequestRepository.updateDecision(
        input.request.id,
        {
          status: TimeOffRequestStatus.REQUIRES_REVIEW,
          managerDecisionReason: input.reviewReason,
          approvedBy: null,
        },
        tx,
      );

      if (input.releaseReservation) {
        await this.balanceReservationRepository.updateStatusByRequestId(
          input.request.id,
          BalanceReservationStatus.RELEASED,
          tx,
        );
      }

      await this.auditLogRepository.create(
        {
          action: input.action,
          actorType: AuditActorType.MANAGER,
          actorId: input.managerId,
          requestId: input.request.id,
          entityType: 'time_off_request',
          entityId: input.request.id,
          metadata: JSON.stringify({
            reviewReason: input.reviewReason,
            status: TimeOffRequestStatus.REQUIRES_REVIEW,
            ...input.metadata,
          }),
          occurredAt: input.now,
        },
        tx,
      );

      return reviewedRequest;
    });
  }

  private async markRequestSyncFailed(input: {
    managerId: string;
    message: string;
    now: Date;
    request: TimeOffRequest;
    reviewReason: string | null;
  }): Promise<TimeOffRequest> {
    return this.prisma.$transaction(async (tx) => {
      const failedRequest = await this.timeOffRequestRepository.updateDecision(
        input.request.id,
        {
          status: TimeOffRequestStatus.SYNC_FAILED,
          managerDecisionReason: input.reviewReason,
          approvedBy: null,
        },
        tx,
      );

      await this.auditLogRepository.create(
        {
          action: 'TIME_OFF_REQUEST_SYNC_FAILED',
          actorType: AuditActorType.MANAGER,
          actorId: input.managerId,
          requestId: input.request.id,
          entityType: 'time_off_request',
          entityId: input.request.id,
          metadata: JSON.stringify({
            reviewReason: input.reviewReason,
            status: TimeOffRequestStatus.SYNC_FAILED,
            message: input.message,
          }),
          occurredAt: input.now,
        },
        tx,
      );

      return failedRequest;
    });
  }

  private async replayExistingIdempotentDecision(
    scope: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<TimeOffRequest | null> {
    const existingRecord = await this.idempotencyKeyRepository.findByScopeAndKey(
      scope,
      idempotencyKey,
    );

    if (!existingRecord) {
      return null;
    }

    if (existingRecord.fingerprint !== fingerprint) {
      throw new RequestCreationError(
        requestCreationErrorCodes.idempotencyReplay,
        'The idempotency key has already been used with a different review payload.',
      );
    }

    if (existingRecord.status === IdempotencyStatus.IN_PROGRESS) {
      throw new RequestCreationError(
        requestCreationErrorCodes.conflict,
        'A matching review request is already in progress.',
      );
    }

    if (existingRecord.status === IdempotencyStatus.COMPLETED) {
      const requestId = this.parseStoredRequestId(existingRecord.responseBody);

      if (!requestId) {
        throw new RequestCreationError(
          requestCreationErrorCodes.conflict,
          'The stored idempotent review response is invalid.',
        );
      }

      const request = await this.timeOffRequestRepository.findById(requestId);

      if (!request) {
        throw new RequestCreationError(
          requestCreationErrorCodes.notFound,
          'The stored idempotent request could not be found.',
        );
      }

      return request;
    }

    const failedPayload = this.parseStoredError(existingRecord.responseBody);

    throw new RequestCreationError(
      this.isRequestCreationErrorCode(existingRecord.errorCode)
        ? existingRecord.errorCode
        : requestCreationErrorCodes.conflict,
      failedPayload?.message ?? 'The original review request failed.',
    );
  }

  private async createIdempotencyRecord(
    scope: string,
    idempotencyKey: string,
    fingerprint: string,
    now: Date,
  ) {
    try {
      return await this.idempotencyKeyRepository.create({
        idempotencyKey,
        scope,
        fingerprint,
        status: IdempotencyStatus.IN_PROGRESS,
        lockedAt: now,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new RequestCreationError(
          requestCreationErrorCodes.conflict,
          'A matching review request is already being processed.',
        );
      }

      throw error;
    }
  }

  private assertReviewableStatus(
    request: TimeOffRequest,
    decision: ReviewDecision,
  ): void {
    const allowedStatuses: TimeOffRequestStatus[] =
      decision === 'REJECT'
        ? [
            TimeOffRequestStatus.PENDING,
            TimeOffRequestStatus.SYNC_FAILED,
            TimeOffRequestStatus.REQUIRES_REVIEW,
          ]
        : [TimeOffRequestStatus.PENDING, TimeOffRequestStatus.SYNC_FAILED];

    if (!allowedStatuses.includes(request.status)) {
      throw new RequestCreationError(
        requestCreationErrorCodes.conflict,
        `The request cannot be ${decision.toLowerCase()}d from status ${request.status}.`,
      );
    }
  }

  private assertManagerAuthorization(
    manager: {
      id: string;
      locationId: string;
    },
    employee: {
      managerId: string | null;
      locationId: string;
    },
    requestLocationId: string,
  ): void {
    const managesEmployee =
      employee.managerId === manager.id || manager.locationId === requestLocationId;

    if (!managesEmployee || employee.locationId !== requestLocationId) {
      throw new RequestCreationError(
        requestCreationErrorCodes.forbidden,
        'The manager is not authorized to review this request.',
      );
    }
  }

  private normalizeAndValidateCommand(
    command: ReviewTimeOffRequestCommand,
  ): ReviewTimeOffRequestCommand {
    const actorId = command.actorId?.trim();
    const idempotencyKey = command.idempotencyKey?.trim();
    const requestId = command.requestId?.trim();
    const reason = command.reason?.trim() || null;

    if (!actorId) {
      throw new RequestCreationError(
        requestCreationErrorCodes.unauthenticated,
        'The request actor is required.',
      );
    }

    if (!idempotencyKey) {
      throw new RequestCreationError(
        requestCreationErrorCodes.badUserInput,
        'Idempotency-Key header is required.',
      );
    }

    if (!requestId) {
      throw new RequestCreationError(
        requestCreationErrorCodes.badUserInput,
        'requestId must be provided.',
      );
    }

    if (!['APPROVE', 'REJECT'].includes(command.decision)) {
      throw new RequestCreationError(
        requestCreationErrorCodes.badUserInput,
        'decision must be APPROVE or REJECT.',
      );
    }

    return {
      actorId,
      decision: command.decision,
      idempotencyKey,
      reason,
      requestId,
    };
  }

  private normalizeApplicationError(error: unknown): RequestCreationError {
    if (error instanceof RequestCreationError) {
      return error;
    }

    return new RequestCreationError(
      requestCreationErrorCodes.conflict,
      error instanceof Error ? error.message : 'The review request failed.',
    );
  }

  private getIdempotencyScope(decision: ReviewDecision): string {
    return decision === 'APPROVE' ? 'timeoff.approve' : 'timeoff.reject';
  }

  private buildFingerprint(command: ReviewTimeOffRequestCommand): string {
    return [
      command.actorId,
      command.requestId,
      command.decision,
      command.reason ?? '',
    ].join(':');
  }

  private toPendingBalanceReservation(record: {
    requestId: string;
    employeeId: string;
    locationId: string;
    reservedUnits: number;
    status: BalanceReservationStatus;
    expiresAt: Date | null;
  }): PendingBalanceReservation {
    return {
      requestId: record.requestId,
      employeeId: record.employeeId,
      locationId: record.locationId,
      reservedUnits: record.reservedUnits,
      status: record.status,
      expiresAt: record.expiresAt,
    };
  }

  private toAuthoritativeBalanceSnapshot(record: {
    employeeId: string;
    locationId: string;
    availableUnits: number;
    sourceUpdatedAt: Date;
    lastSyncedAt: Date;
  }): AuthoritativeBalanceSnapshot {
    return {
      employeeId: record.employeeId,
      locationId: record.locationId,
      availableUnits: record.availableUnits,
      sourceUpdatedAt: record.sourceUpdatedAt,
      lastSyncedAt: record.lastSyncedAt,
    };
  }

  private extractUpstreamFailureResponse(
    error: unknown,
  ): { code?: string; message?: string } | null {
    if (!(error instanceof BadGatewayException)) {
      return null;
    }

    const response = error.getResponse();

    if (this.isRecord(response)) {
      return {
        code: typeof response.code === 'string' ? response.code : undefined,
        message:
          typeof response.message === 'string' ? response.message : undefined,
      };
    }

    return null;
  }

  private extractUpstreamFailureMessage(
    error: unknown,
    fallbackMessage: string,
  ): string {
    return this.extractUpstreamFailureResponse(error)?.message ?? fallbackMessage;
  }

  private parseStoredRequestId(responseBody: string | null): string | null {
    if (!responseBody) {
      return null;
    }

    try {
      const payload = JSON.parse(responseBody) as unknown;

      if (this.isRecord(payload) && typeof payload.requestId === 'string') {
        return payload.requestId;
      }
    } catch {
      return null;
    }

    return null;
  }

  private parseStoredError(
    responseBody: string | null,
  ): { code?: string; message?: string } | null {
    if (!responseBody) {
      return null;
    }

    try {
      const payload = JSON.parse(responseBody) as unknown;

      if (this.isRecord(payload)) {
        return {
          code:
            typeof payload.code === 'string' ? payload.code : undefined,
          message:
            typeof payload.message === 'string' ? payload.message : undefined,
        };
      }
    } catch {
      return null;
    }

    return null;
  }

  private isRequestCreationErrorCode(
    code: string | null | undefined,
  ): code is RequestCreationError['code'] {
    return Object.values(requestCreationErrorCodes).includes(
      code as RequestCreationError['code'],
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
