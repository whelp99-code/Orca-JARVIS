export const PERSONAL_OS_ERROR_CODES = [
  "E_PROTECTED_ROOT",
  "E_DEPLOYMENT_ROOT",
  "E_UNSAFE_SYMLINK",
  "E_STAGE_INVALID",
  "E_SHA_INVALID",
  "E_RELEASE_MISMATCH",
  "E_BACKUP_PATH",
  "E_BACKUP_FAILED",
  "E_RESTORE_FAILED",
  "E_RETENTION_CLAIM",
  "E_RETENTION_ADAPTER",
  "E_RETENTION_POLICY",
  "E_USAGE",
  "E_FIXTURE_INVALID",
  "E_CLOCK_INVALID",
  "E_REHEARSAL_GATE",
  "E_PRODUCTION_DB",
  "E_SYSTEMD_VERIFY",
  "E_PROCESS_STRESS",
  "E_CYCLE_PROTOCOL",
  "UNREACHABLE",
] as const;

export type PersonalOsErrorCode = (typeof PERSONAL_OS_ERROR_CODES)[number];

export class PersonalOsError extends Error {
  readonly name = "PersonalOsError";
  constructor(readonly code: PersonalOsErrorCode) {
    super(code);
  }
}

export function assertNever(value: never): never {
  throw new PersonalOsError(value);
}
