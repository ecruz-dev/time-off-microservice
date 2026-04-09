import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { HcmRuntimeConfig } from '@app/config';

import { HCM_RUNTIME_CONFIG } from '../../hcm-sync.constants';

@Injectable()
export class InternalSyncTokenGuard implements CanActivate {
  constructor(
    @Inject(HCM_RUNTIME_CONFIG)
    private readonly runtimeConfig: HcmRuntimeConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const suppliedHeader = request.headers['x-internal-sync-token'];
    const suppliedToken = Array.isArray(suppliedHeader)
      ? suppliedHeader[0]
      : suppliedHeader;

    if (suppliedToken === this.runtimeConfig.internalSyncToken) {
      return true;
    }

    throw new UnauthorizedException({
      code: 'INVALID_INTERNAL_SYNC_TOKEN',
      message: 'A valid internal sync token is required.',
    });
  }
}
