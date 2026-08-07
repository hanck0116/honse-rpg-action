export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: ErrorDetails | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryable?: boolean; details?: ErrorDetails } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

