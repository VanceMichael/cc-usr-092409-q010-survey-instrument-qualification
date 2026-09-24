export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "OVERLAPPING_LEASE"
  | "SEAL_ALREADY_CONFIRMED"
  | "ILLEGAL_STATE";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  OVERLAPPING_LEASE: 409,
  SEAL_ALREADY_CONFIRMED: 409,
  ILLEGAL_STATE: 409,
};

export class DomainError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
    this.statusCode = STATUS[code];
  }
}

export const fail = {
  validation: (message: string, details?: unknown) => new DomainError("VALIDATION", message, details),
  notFound: (resource: string, id: string) => new DomainError("NOT_FOUND", `${resource} 不存在: ${id}`),
  conflict: (message: string, details?: unknown) => new DomainError("CONFLICT", message, details),
  overlap: (message: string, details?: unknown) => new DomainError("OVERLAPPING_LEASE", message, details),
  seal: (message: string) => new DomainError("SEAL_ALREADY_CONFIRMED", message),
  illegal: (message: string, details?: unknown) => new DomainError("ILLEGAL_STATE", message, details),
};
