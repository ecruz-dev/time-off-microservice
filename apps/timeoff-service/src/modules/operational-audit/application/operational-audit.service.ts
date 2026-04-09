import { Injectable } from '@nestjs/common';
import { AuditLog } from '@prisma/client';

import { AuditLogRepository } from '../../../database/repositories/interfaces';

@Injectable()
export class OperationalAuditService {
  constructor(private readonly auditLogRepository: AuditLogRepository) {}

  async listRequestTrail(requestId: string): Promise<AuditLog[]> {
    return this.auditLogRepository.listByRequestId(requestId.trim());
  }

  async listSyncRunTrail(syncRunId: string): Promise<AuditLog[]> {
    return this.auditLogRepository.listBySyncRunId(syncRunId.trim());
  }
}
