import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditActorType, SyncRun, SyncRunStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  AuditLogRepository,
  BalanceSnapshotRepository,
  SyncRunRepository,
} from '../../../database/repositories/interfaces';
import {
  HCM_BATCH_PULL_SOURCE,
  HCM_BATCH_PUSH_SOURCE,
} from '../hcm-sync.constants';
import {
  BatchSyncSummary,
  HcmBalancePayload,
  HcmBatchBalanceSnapshotPayload,
  HcmBatchQuery,
} from '../hcm-sync.types';
import { HcmClient } from '../infrastructure/hcm.client';

@Injectable()
export class HcmSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceSnapshotRepository: BalanceSnapshotRepository,
    private readonly syncRunRepository: SyncRunRepository,
    private readonly auditLogRepository: AuditLogRepository,
    private readonly hcmClient: HcmClient,
  ) {}

  async pullBatchSnapshots(query: HcmBatchQuery = {}): Promise<BatchSyncSummary> {
    this.assertOptionalQueryField(query.employeeId, 'employeeId');
    this.assertOptionalQueryField(query.locationId, 'locationId');

    const payload = await this.hcmClient.listBatchSnapshots(query);

    return this.importBatchSnapshots(payload, HCM_BATCH_PULL_SOURCE);
  }

  async importBatchSnapshots(
    payload: HcmBatchBalanceSnapshotPayload,
    source = HCM_BATCH_PUSH_SOURCE,
  ): Promise<BatchSyncSummary> {
    this.assertBatchPayload(payload);

    const existingRun = await this.syncRunRepository.findByExternalRunId(
      payload.runId,
    );

    if (existingRun) {
      return this.toBatchSyncSummary(existingRun, true);
    }

    const startedAt = new Date();
    const syncRun = await this.syncRunRepository.create({
      source,
      externalRunId: payload.runId,
      status: SyncRunStatus.PROCESSING,
      sentAt: new Date(payload.sentAt),
      startedAt,
      recordsReceived: payload.records.length,
      recordsApplied: 0,
    });

    try {
      await this.prisma.$transaction(async (tx) => {
        for (const record of payload.records) {
          await this.balanceSnapshotRepository.upsert(
            {
              employeeId: record.employeeId,
              locationId: record.locationId,
              availableUnits: record.availableUnits,
              sourceVersion: record.sourceVersion,
              sourceUpdatedAt: new Date(record.sourceUpdatedAt),
              lastSyncedAt: startedAt,
            },
            tx,
          );
        }

        await this.auditLogRepository.create(
          {
            action: 'HCM_BALANCE_BATCH_SYNC_COMPLETED',
            actorType:
              source === HCM_BATCH_PUSH_SOURCE
                ? AuditActorType.HCM
                : AuditActorType.SYSTEM,
            actorId: source,
            syncRunId: syncRun.id,
            entityType: 'sync_run',
            entityId: syncRun.id,
            metadata: JSON.stringify({
              externalRunId: payload.runId,
              recordsReceived: payload.records.length,
              recordsApplied: payload.records.length,
            }),
            occurredAt: startedAt,
          },
          tx,
        );
      });

      const completedRun = await this.syncRunRepository.markStatus(
        syncRun.id,
        SyncRunStatus.COMPLETED,
        {
          completedAt: new Date(),
          recordsReceived: payload.records.length,
          recordsApplied: payload.records.length,
        },
      );

      return this.toBatchSyncSummary(completedRun, false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown HCM sync failure.';

      const failedRun = await this.syncRunRepository.markStatus(
        syncRun.id,
        SyncRunStatus.FAILED,
        {
          completedAt: new Date(),
          errorSummary: message,
          recordsReceived: payload.records.length,
          recordsApplied: 0,
        },
      );

      return this.toBatchSyncSummary(failedRun, false);
    }
  }

  private toBatchSyncSummary(
    syncRun: SyncRun,
    reusedExistingRun: boolean,
  ): BatchSyncSummary {
    return {
      syncRunId: syncRun.id,
      externalRunId: syncRun.externalRunId ?? '',
      source: syncRun.source,
      status: syncRun.status,
      sentAt: syncRun.sentAt?.toISOString() ?? null,
      startedAt: syncRun.startedAt.toISOString(),
      completedAt: syncRun.completedAt?.toISOString() ?? null,
      recordsReceived: syncRun.recordsReceived,
      recordsApplied: syncRun.recordsApplied,
      reusedExistingRun,
    };
  }

  private assertBatchPayload(payload: HcmBatchBalanceSnapshotPayload): void {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException({
        code: 'BAD_USER_INPUT',
        message: 'Batch payload must be provided.',
      });
    }

    this.assertNonEmptyString(payload.runId, 'runId');
    this.assertIsoDate(payload.sentAt, 'sentAt');

    if (!Array.isArray(payload.records)) {
      throw new BadRequestException({
        code: 'BAD_USER_INPUT',
        message: 'records must be an array.',
      });
    }

    for (const record of payload.records) {
      this.assertBalancePayload(record);
    }
  }

  private assertBalancePayload(record: HcmBalancePayload): void {
    this.assertNonEmptyString(record.employeeId, 'employeeId');
    this.assertNonEmptyString(record.locationId, 'locationId');
    this.assertInteger(record.availableUnits, 'availableUnits');
    this.assertNonEmptyString(record.sourceVersion, 'sourceVersion');
    this.assertIsoDate(record.sourceUpdatedAt, 'sourceUpdatedAt');
  }

  private assertOptionalQueryField(
    value: string | undefined,
    fieldName: string,
  ): void {
    if (value === undefined) {
      return;
    }

    this.assertNonEmptyString(value, fieldName);
  }

  private assertNonEmptyString(value: string, fieldName: string): void {
    if (!value || !value.trim()) {
      throw new BadRequestException({
        code: 'BAD_USER_INPUT',
        message: `${fieldName} must be a non-empty string.`,
      });
    }
  }

  private assertInteger(value: number, fieldName: string): void {
    if (!Number.isInteger(value)) {
      throw new BadRequestException({
        code: 'BAD_USER_INPUT',
        message: `${fieldName} must be an integer.`,
      });
    }
  }

  private assertIsoDate(value: string, fieldName: string): void {
    if (!value || Number.isNaN(new Date(value).getTime())) {
      throw new BadRequestException({
        code: 'BAD_USER_INPUT',
        message: `${fieldName} must be a valid ISO 8601 timestamp.`,
      });
    }
  }
}
