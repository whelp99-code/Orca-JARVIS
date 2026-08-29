import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parsePersonalOsCorpus, PersonalOsCorpusError, PERSONAL_OS_CORPUS_INVALID } from "./personal-os-corpus-parser.js";
import type { PersonalOsCorpus } from "./personal-os-eval-types.js";
import { parseSecondBrainStrictJson } from "./second-brain-strict-json.js";

export const PERSONAL_OS_FIXTURE_PATH_INVALID = "PERSONAL_OS_FIXTURE_PATH_INVALID" as const;
export const PERSONAL_OS_FIXTURE_READ_INVALID = "PERSONAL_OS_FIXTURE_READ_INVALID" as const;
export type PersonalOsFixtureErrorCode = typeof PERSONAL_OS_FIXTURE_PATH_INVALID | typeof PERSONAL_OS_FIXTURE_READ_INVALID;
export class PersonalOsFixtureError extends Error {
  readonly name = "PersonalOsFixtureError";
  constructor(readonly code: PersonalOsFixtureErrorCode) { super(code); }
}
export type PersonalOsFileOperations = {
  readonly realpath: (path: string) => string; readonly lstat: (path: string) => Stats;
  readonly readFile: (path: string, encoding: "utf8") => string;
};
const FILE_OPERATIONS: PersonalOsFileOperations = { realpath: realpathSync, lstat: lstatSync, readFile: readFileSync };
function systemCode(error: unknown): unknown { return error instanceof Error && "code" in error ? error.code : undefined; }
function pathFailure(error: unknown): never {
  if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(String(systemCode(error)))) {
    throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_PATH_INVALID);
  }
  throw error;
}
function readFailure(error: unknown): never {
  if (["ENOENT", "EACCES", "EISDIR"].includes(String(systemCode(error)))) {
    throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_READ_INVALID);
  }
  throw error;
}
export function loadPersonalOsCorpus(fixtureName: string, fixtureRoot: string, operations: PersonalOsFileOperations = FILE_OPERATIONS): PersonalOsCorpus {
  if (fixtureName !== basename(fixtureName) || !/^[a-z0-9][a-z0-9.-]{0,100}\.json$/.test(fixtureName)) {
    throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_PATH_INVALID);
  }
  let root: string;
  try { root = operations.realpath(resolve(fixtureRoot)); } catch (error) { return pathFailure(error); }
  const candidate = join(root, fixtureName); let stat: ReturnType<typeof lstatSync>;
  try { stat = operations.lstat(candidate); } catch (error) { return pathFailure(error); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) {
    throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_PATH_INVALID);
  }
  let actual: string;
  try { actual = operations.realpath(candidate); } catch (error) { return pathFailure(error); }
  const displacement = relative(root, actual);
  if (displacement.startsWith(`..${sep}`) || displacement === ".." || dirname(actual) !== root) {
    throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_PATH_INVALID);
  }
  let bytes: string;
  try { bytes = operations.readFile(actual, "utf8"); } catch (error) { return readFailure(error); }
  const parsed = parseSecondBrainStrictJson(bytes);
  if (parsed === undefined) throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_READ_INVALID);
  try { return parsePersonalOsCorpus(parsed); } catch (error) {
    if (error instanceof PersonalOsCorpusError && error.code === PERSONAL_OS_CORPUS_INVALID) {
      throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_READ_INVALID);
    }
    throw error;
  }
}
