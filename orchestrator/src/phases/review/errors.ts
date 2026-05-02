export class ReviewPhaseContractError extends Error {
  public readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ReviewPhaseContractError';
    this.cause = cause;
  }
}
