import { BadGatewayException, Inject, Injectable } from '@nestjs/common';

import { HcmRuntimeConfig } from '../../../../../../libs/config/src';

import { HCM_RUNTIME_CONFIG } from '../hcm-sync.constants';
import {
  HcmBalanceAdjustmentRequest,
  HcmBalanceAdjustmentResponse,
  HcmBalancePayload,
  HcmBatchBalanceSnapshotPayload,
  HcmBatchQuery,
} from '../hcm-sync.types';

@Injectable()
export class HcmClient {
  constructor(
    @Inject(HCM_RUNTIME_CONFIG)
    private readonly runtimeConfig: HcmRuntimeConfig,
  ) {}

  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<HcmBalancePayload> {
    this.assertNonEmptyString(employeeId, 'employeeId');
    this.assertNonEmptyString(locationId, 'locationId');

    const url = this.buildUrl(`hcm/balances/${encodeURIComponent(employeeId)}`, {
      locationId,
    });
    const payload = await this.requestJson<unknown>(url, {
      method: 'GET',
    });

    return this.assertBalancePayload(payload);
  }

  async listBatchSnapshots(
    query: HcmBatchQuery = {},
  ): Promise<HcmBatchBalanceSnapshotPayload> {
    const url = this.buildUrl('hcm/balance-snapshots', query);
    const payload = await this.requestJson<unknown>(url, {
      method: 'GET',
    });

    return this.assertBatchSnapshotPayload(payload);
  }

  async applyBalanceAdjustment(
    request: HcmBalanceAdjustmentRequest,
  ): Promise<HcmBalanceAdjustmentResponse> {
    this.assertNonEmptyString(request.idempotencyKey, 'idempotencyKey');
    this.assertNonEmptyString(request.requestId, 'requestId');
    this.assertNonEmptyString(request.employeeId, 'employeeId');
    this.assertNonEmptyString(request.locationId, 'locationId');
    this.assertNonEmptyString(request.reasonCode, 'reasonCode');
    this.assertInteger(request.deltaUnits, 'deltaUnits');
    this.assertIsoDate(request.occurredAt, 'occurredAt');

    const payload = await this.requestJson<unknown>(this.buildUrl('hcm/balance-adjustments'), {
      method: 'POST',
      body: JSON.stringify(request),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (
      this.isRecord(payload) &&
      payload.accepted === false &&
      typeof payload.code === 'string' &&
      typeof payload.message === 'string'
    ) {
      return {
        accepted: false,
        code: payload.code,
        message: payload.message,
      };
    }

    return {
      accepted: true,
      ...this.assertBalancePayload(payload),
    };
  }

  private buildUrl(
    path: string,
    query:
      | HcmBatchQuery
      | Record<string, string | undefined>
      | undefined = {},
  ): string {
    const url = new URL(path, this.runtimeConfig.baseUrl);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit,
  ): Promise<T> {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.runtimeConfig.requestTimeoutMs),
      });

      if (!response.ok) {
        throw new BadGatewayException(
          this.buildUpstreamErrorPayload(response.status, await response.text()),
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw error;
      }

      throw new BadGatewayException({
        code: 'HCM_UPSTREAM_UNAVAILABLE',
        message: 'The HCM upstream request failed.',
      });
    }
  }

  private buildUpstreamErrorPayload(status: number, body: string): {
    code: string;
    message: string;
    status: number;
  } {
    let code = 'HCM_UPSTREAM_ERROR';
    let message = `The HCM upstream request failed with status ${status}.`;

    try {
      const payload = JSON.parse(body) as unknown;

      if (this.isRecord(payload)) {
        if (typeof payload.code === 'string') {
          code = payload.code;
        }

        if (typeof payload.message === 'string') {
          message = payload.message;
        }
      }
    } catch {
      // Preserve the default message when the upstream body is not JSON.
    }

    return {
      code,
      message,
      status,
    };
  }

  private assertBatchSnapshotPayload(
    payload: unknown,
  ): HcmBatchBalanceSnapshotPayload {
    if (!this.isRecord(payload)) {
      throw new BadGatewayException({
        code: 'INVALID_HCM_RESPONSE',
        message: 'The HCM batch snapshot response was malformed.',
      });
    }

    if (
      typeof payload.runId !== 'string' ||
      typeof payload.sentAt !== 'string' ||
      !Array.isArray(payload.records)
    ) {
      throw new BadGatewayException({
        code: 'INVALID_HCM_RESPONSE',
        message: 'The HCM batch snapshot response was missing required fields.',
      });
    }

    return {
      runId: payload.runId,
      sentAt: payload.sentAt,
      records: payload.records.map((record) => this.assertBalancePayload(record)),
    };
  }

  private assertBalancePayload(payload: unknown): HcmBalancePayload {
    if (!this.isRecord(payload)) {
      throw new BadGatewayException({
        code: 'INVALID_HCM_RESPONSE',
        message: 'The HCM balance response was malformed.',
      });
    }

    if (
      typeof payload.employeeId !== 'string' ||
      typeof payload.locationId !== 'string' ||
      typeof payload.availableUnits !== 'number' ||
      !Number.isInteger(payload.availableUnits) ||
      typeof payload.sourceVersion !== 'string' ||
      typeof payload.sourceUpdatedAt !== 'string' ||
      Number.isNaN(new Date(payload.sourceUpdatedAt).getTime())
    ) {
      throw new BadGatewayException({
        code: 'INVALID_HCM_RESPONSE',
        message: 'The HCM balance response was missing required fields.',
      });
    }

    return {
      employeeId: payload.employeeId,
      locationId: payload.locationId,
      availableUnits: payload.availableUnits,
      sourceVersion: payload.sourceVersion,
      sourceUpdatedAt: payload.sourceUpdatedAt,
    };
  }

  private assertNonEmptyString(value: string, fieldName: string): void {
    if (!value || !value.trim()) {
      throw new Error(`${fieldName} must be a non-empty string.`);
    }
  }

  private assertInteger(value: number, fieldName: string): void {
    if (!Number.isInteger(value)) {
      throw new Error(`${fieldName} must be an integer.`);
    }
  }

  private assertIsoDate(value: string, fieldName: string): void {
    if (!value || Number.isNaN(new Date(value).getTime())) {
      throw new Error(`${fieldName} must be a valid ISO timestamp.`);
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
