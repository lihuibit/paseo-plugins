export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

export class ConnectionError extends CliError {
  constructor(message: string) {
    super(message, 3);
    this.name = "ConnectionError";
  }
}

export class BoardApiError extends CliError {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, 1);
    this.name = "BoardApiError";
    this.code = code;
    this.details = details;
  }
}
