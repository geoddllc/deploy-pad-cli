export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function asCliError(error: unknown): CliError {
  return error instanceof CliError
    ? error
    : new CliError('UNEXPECTED_ERROR', 'The operation failed unexpectedly. No diagnostic credentials were recorded.');
}

export function interrupted(): CliError {
  return new CliError('INTERRUPTED', 'Operation interrupted.', 130);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, '');
}
