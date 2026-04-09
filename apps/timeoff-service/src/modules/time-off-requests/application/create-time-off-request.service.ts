import { BadGatewayException, Injectable } from '@nestjs/common';
import {
  AuditActorType,
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
  BalanceDomainError,
  PendingBalanceReservation,
  AuthoritativeBalanceSnapshot,
  calculateEffectiveBalance,
  hasSufficientEffectiveBalance,
  shouldRefreshSnapshot,
} from '../../balances/domain';
import { HcmClient } from '../../hcm-sync/infrastructure/hcm.client';
import {
  RequestCreationError,
  requestCreationErrorCodes,
} from './request-creation.error';

const CREATE_REQUEST_IDEMPOTENCY_SCOPE = 'timeoff.create';

export interface CreateTimeOffRequestCommand {
  actorId: string;
  idempotencyKey: string;
  locationId: string;
  startDate: Date;
  endDate: Date;
  requestedUnits: number;
  reason?: string | null;
}

@Injectable()
export class CreateTimeOffRequestService {
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

  async execute(command: CreateTimeOffRequestCommand): Promise<TimeOffRequest> {
    const normalizedCommand = this.normalizeAndValidateCommand(command);
    const now = new Date();
    const fingerprint = this.buildFingerprint(normalizedCommand);
    const replayedRequest = await this.replayExistingIdempotentRequest(
      normalizedCommand.idempotencyKey,
      fingerprint,
    );

    if (replayedRequest) {
      return replayedRequest;
    }

    const idempotencyRecord = await this.createIdempotencyRecord(
      normalizedCommand.idempotencyKey,
      fingerprint,
      now,
    );

    try {
      const employee = await this.employeeRepository.findById(
        normalizedCommand.actorId,
      );

      if (!employee) {
        throw new RequestCreationError(
          requestCreationErrorCodes.notFound,
          'Employee not found.',
        );
      }

      if (!employee.isActive) {
        throw new RequestCreationError(
          requestCreationErrorCodes.forbidden,
          'Inactive employees cannot create time-off requests.',
        );
      }

      if (employee.locationId !== normalizedCommand.locationId) {
        throw new RequestCreationError(
          requestCreationErrorCodes.invalidDimensions,
          'The employee/location combination is invalid.',
        );
      }

      const reservations =
        await this.balanceReservationRepository.findActiveByEmployeeAndLocation(
          normalizedCommand.actorId,
          normalizedCommand.locationId,
        );
      let snapshotRecord =
        await this.balanceSnapshotRepository.findByEmployeeAndLocation(
          normalizedCommand.actorId,
          normalizedCommand.locationId,
        );
      let snapshot = snapshotRecord
        ? this.toAuthoritativeBalanceSnapshot(snapshotRecord)
        : null;

      if (shouldRefreshSnapshot(snapshot, now)) {
        const refreshedBalance = await this.refreshSnapshotFromHcm(
          normalizedCommand.actorId,
          normalizedCommand.locationId,
          now,
        );

        snapshotRecord = await this.balanceSnapshotRepository.upsert({
          employeeId: refreshedBalance.employeeId,
          locationId: refreshedBalance.locationId,
          availableUnits: refreshedBalance.availableUnits,
          sourceVersion: refreshedBalance.sourceVersion,
          sourceUpdatedAt: new Date(refreshedBalance.sourceUpdatedAt),
          lastSyncedAt: now,
        });
        snapshot = this.toAuthoritativeBalanceSnapshot(snapshotRecord);
      }

      if (!snapshot) {
        throw new RequestCreationError(
          requestCreationErrorCodes.invalidDimensions,
          'No authoritative balance snapshot exists for the employee/location combination.',
        );
      }

      const effectiveBalance = calculateEffectiveBalance({
        snapshot,
        reservations: reservations.map((reservation) =>
          this.toPendingBalanceReservation(reservation),
        ),
        now,
      });

      if (
        !hasSufficientEffectiveBalance(
          effectiveBalance,
          normalizedCommand.requestedUnits,
        )
      ) {
        throw new RequestCreationError(
          requestCreationErrorCodes.insufficientBalance,
          'The employee does not have enough available balance for this request.',
        );
      }

      const createdRequest = await this.prisma.$transaction(async (tx) => {
        const request = await this.timeOffRequestRepository.create(
          {
            employeeId: normalizedCommand.actorId,
            locationId: normalizedCommand.locationId,
            startDate: normalizedCommand.startDate,
            endDate: normalizedCommand.endDate,
            requestedUnits: normalizedCommand.requestedUnits,
            reason: normalizedCommand.reason,
            status: TimeOffRequestStatus.PENDING,
            createdBy: normalizedCommand.actorId,
          },
          tx,
        );

        await this.balanceReservationRepository.create(
          {
            requestId: request.id,
            employeeId: request.employeeId,
            locationId: request.locationId,
            reservedUnits: request.requestedUnits,
            status: 'ACTIVE',
          },
          tx,
        );

        await this.auditLogRepository.create(
          {
            action: 'TIME_OFF_REQUEST_CREATED',
            actorType: AuditActorType.EMPLOYEE,
            actorId: normalizedCommand.actorId,
            requestId: request.id,
            entityType: 'time_off_request',
            entityId: request.id,
            metadata: JSON.stringify({
              locationId: request.locationId,
              requestedUnits: request.requestedUnits,
              startDate: request.startDate.toISOString(),
              endDate: request.endDate.toISOString(),
              reason: request.reason,
            }),
            occurredAt: now,
          },
          tx,
        );

        return request;
      });

      await this.idempotencyKeyRepository.markStatus(
        idempotencyRecord.id,
        IdempotencyStatus.COMPLETED,
        {
          responseCode: 200,
          responseBody: JSON.stringify({
            requestId: createdRequest.id,
          }),
          errorCode: null,
          lockedAt: now,
        },
      );

      return createdRequest;
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

  private async replayExistingIdempotentRequest(
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<TimeOffRequest | null> {
    const existingRecord = await this.idempotencyKeyRepository.findByScopeAndKey(
      CREATE_REQUEST_IDEMPOTENCY_SCOPE,
      idempotencyKey,
    );

    if (!existingRecord) {
      return null;
    }

    if (existingRecord.fingerprint !== fingerprint) {
      throw new RequestCreationError(
        requestCreationErrorCodes.idempotencyReplay,
        'The idempotency key has already been used with a different request payload.',
      );
    }

    if (existingRecord.status === IdempotencyStatus.IN_PROGRESS) {
      throw new RequestCreationError(
        requestCreationErrorCodes.conflict,
        'A matching time-off request is already in progress.',
      );
    }

    if (existingRecord.status === IdempotencyStatus.COMPLETED) {
      const requestId = this.parseStoredRequestId(existingRecord.responseBody);

      if (!requestId) {
        throw new RequestCreationError(
          requestCreationErrorCodes.conflict,
          'The stored idempotent response is invalid.',
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
      failedPayload?.message ?? 'The original idempotent request failed.',
    );
  }

  private async createIdempotencyRecord(
    idempotencyKey: string,
    fingerprint: string,
    now: Date,
  ) {
    try {
      return await this.idempotencyKeyRepository.create({
        idempotencyKey,
        scope: CREATE_REQUEST_IDEMPOTENCY_SCOPE,
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
          'A matching time-off request is already being processed.',
        );
      }

      throw error;
    }
  }

  private normalizeAndValidateCommand(
    command: CreateTimeOffRequestCommand,
  ): CreateTimeOffRequestCommand {
    const actorId = command.actorId?.trim();
    const idempotencyKey = command.idempotencyKey?.trim();
    const locationId = command.locationId?.trim();
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

    if (!locationId) {
      throw new RequestCreationError(
        requestCreationErrorCodes.badUserInput,
        'locationId must be provided.',
      );
    }

    if (
      !(command.startDate instanceof Date) ||
      Number.isNaN(command.startDate.getTime())
    ) {
      throw new RequestCreationError(
        requestCreationErrorCodes.badUserInput,
        'startDate must be a valid ISO timestamp.',
      );
    }

    if (
      !(command.endDate instanceof Date) ||
      Number.isNaN(command.endDate.getTime())
    ) {
      throw new RequestCreationError(
        requestCreationErrorCodes.badUserInput,
        'endDate must be a valid ISO timestamp.',
      );
    }

    if (command.endDate.getTime() < command.startDate.getTime()) {
      throw new RequestCreationError(
        requestCreationErrorCodes.badUserInput,
        'endDate must be greater than or equal to startDate.',
      );
    }

    if (
      !Number.isInteger(command.requestedUnits) ||
      command.requestedUnits <= 0
    ) {
      throw new RequestCreationError(
        requestCreationErrorCodes.badUserInput,
        'requestedUnits must be a positive integer.',
      );
    }

    return {
      actorId,
      idempotencyKey,
      locationId,
      startDate: command.startDate,
      endDate: command.endDate,
      requestedUnits: command.requestedUnits,
      reason,
    };
  }

  private async refreshSnapshotFromHcm(
    employeeId: string,
    locationId: string,
    now: Date,
  ) {
    try {
      return await this.hcmClient.getBalance(employeeId, locationId);
    } catch (error) {
      if (error instanceof BadGatewayException) {
        const response = error.getResponse();

        if (this.isRecord(response) && response.code === 'INVALID_DIMENSIONS') {
          throw new RequestCreationError(
            requestCreationErrorCodes.invalidDimensions,
            typeof response.message === 'string'
              ? response.message
              : 'The employee/location combination is invalid in HCM.',
          );
        }

        if (this.isRecord(response) && typeof response.message === 'string') {
          throw new RequestCreationError(
            requestCreationErrorCodes.upstreamHcmFailure,
            response.message,
          );
        }
      }

      throw new RequestCreationError(
        requestCreationErrorCodes.upstreamHcmFailure,
        `Unable to refresh the balance snapshot from HCM as of ${now.toISOString()}.`,
      );
    }
  }

  private normalizeApplicationError(error: unknown): RequestCreationError {
    if (error instanceof RequestCreationError) {
      return error;
    }

    if (error instanceof BalanceDomainError) {
      return new RequestCreationError(
        requestCreationErrorCodes.badUserInput,
        error.message,
      );
    }

    return new RequestCreationError(
      requestCreationErrorCodes.conflict,
      error instanceof Error
        ? error.message
        : 'The time-off request could not be created.',
    );
  }

  private buildFingerprint(command: CreateTimeOffRequestCommand): string {
    return [
      command.actorId,
      command.locationId,
      command.startDate.toISOString(),
      command.endDate.toISOString(),
      String(command.requestedUnits),
      command.reason ?? '',
    ].join(':');
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

  private toPendingBalanceReservation(record: {
    requestId: string;
    employeeId: string;
    locationId: string;
    reservedUnits: number;
    status: 'ACTIVE' | 'RELEASED' | 'CONSUMED';
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
