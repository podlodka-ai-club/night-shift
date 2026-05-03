export class EscalationPhaseContractError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'EscalationPhaseContractError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}