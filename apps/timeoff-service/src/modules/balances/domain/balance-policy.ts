import { DEFAULT_BALANCE_STALE_AFTER_MILLISECONDS } from './balance.constants';
import {
  BalanceDomainError,
  balanceDomainErrorCodes,
} from './balance-domain.error';

export interface BalancePolicy {
  staleAfterMilliseconds: number;
}

export const DEFAULT_BALANCE_POLICY: Readonly<BalancePolicy> = Object.freeze({
  staleAfterMilliseconds: DEFAULT_BALANCE_STALE_AFTER_MILLISECONDS,
});

export function createBalancePolicy(
  overrides: Partial<BalancePolicy> = {},
): BalancePolicy {
  const policy = {
    ...DEFAULT_BALANCE_POLICY,
    ...overrides,
  };

  if (
    !Number.isInteger(policy.staleAfterMilliseconds) ||
    policy.staleAfterMilliseconds <= 0
  ) {
    throw new BalanceDomainError(
      balanceDomainErrorCodes.invalidStalenessWindow,
      'staleAfterMilliseconds must be a positive integer.',
    );
  }

  return policy;
}

