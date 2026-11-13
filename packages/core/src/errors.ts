export const RPC_ERROR_CODES = [
  "E_NOT_CONFIGURED",
  "E_ALREADY_CONFIGURED",
  "E_REPO_AUTH",
  "E_REPO_NOT_FOUND",
  "E_BRANCH_NOT_FOUND",
  "E_MANIFEST_INVALID",
  "E_LOCAL_CHANGES",
  "E_REVISION_CONFLICT",
  "E_LOCKED",
  "E_PATH_UNSAFE",
  "E_PROVIDER_UNSUPPORTED",
  "E_ASSET_NOT_FOUND",
  "E_VALIDATION_FAILED",
  "E_GIT_IDENTITY_MISSING",
  "E_PUSH_REJECTED",
  "E_MIGRATION_CONFLICT",
  "E_CONFLICT_UNRESOLVED",
  "E_INTERNAL",
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export interface RpcError {
  code: RpcErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export type RpcEnvelope<T> =
  { ok: true; value: T } | { ok: false; error: RpcError };

export function ok<T>(value: T): RpcEnvelope<T> {
  return { ok: true, value };
}

export function fail(
  code: RpcErrorCode,
  message: string,
  details?: Record<string, unknown>,
  retryable = false,
): RpcEnvelope<never> {
  return { ok: false, error: { code, message, details, retryable } };
}

export class PluginError extends Error {
  readonly code: RpcErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(
    code: RpcErrorCode,
    message: string,
    details?: Record<string, unknown>,
    retryable = false,
  ) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}
