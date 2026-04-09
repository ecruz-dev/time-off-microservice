export const balanceDomainErrorCodes = {
  invalidAvailableUnits: 'INVALID_AVAILABLE_UNITS',
  invalidBalanceDimension: 'INVALID_BALANCE_DIMENSION',
  invalidDate: 'INVALID_DATE',
  invalidRequestedUnits: 'INVALID_REQUESTED_UNITS',
  invalidReservedUnits: 'INVALID_RESERVED_UNITS',
  invalidStalenessWindow: 'INVALID_STALENESS_WINDOW',
} as const;

export type BalanceDomainErrorCode =
  (typeof balanceDomainErrorCodes)[keyof typeof balanceDomainErrorCodes];

export class BalanceDomainError extends Error {
  constructor(
    public readonly code: BalanceDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BalanceDomainError';
  }
}

