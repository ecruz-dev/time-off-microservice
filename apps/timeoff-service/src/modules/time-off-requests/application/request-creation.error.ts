export const requestCreationErrorCodes = {
  badUserInput: 'BAD_USER_INPUT',
  conflict: 'CONFLICT',
  forbidden: 'FORBIDDEN',
  idempotencyReplay: 'IDEMPOTENCY_REPLAY',
  insufficientBalance: 'INSUFFICIENT_BALANCE',
  invalidDimensions: 'INVALID_DIMENSIONS',
  notFound: 'NOT_FOUND',
  unauthenticated: 'UNAUTHENTICATED',
  upstreamHcmFailure: 'UPSTREAM_HCM_FAILURE',
} as const;

export type RequestCreationErrorCode =
  (typeof requestCreationErrorCodes)[keyof typeof requestCreationErrorCodes];

export class RequestCreationError extends Error {
  constructor(
    public readonly code: RequestCreationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RequestCreationError';
  }
}
