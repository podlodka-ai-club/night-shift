export class ImplementPhaseContractError extends Error {
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ImplementPhaseContractError';
    this.cause = cause;
  }
}