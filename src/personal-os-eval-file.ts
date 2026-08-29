import { lstatSync, readFileSync, realpathSync } from "node:fs";
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
export function loadPersonalOsCorpus(fixtureName: string, fixtureRoot: string): PersonalOsCorpus {
  if (fixtureName !== basename(fixtureName) || !/^[a-z0-9][a-z0-9.-]{0,100}\.json$/.test(fixtureName)) {
    throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_PATH_INVALID);
  }
  try {
    const root = realpathSync(resolve(fixtureRoot));
    const candidate = join(root, fixtureName);
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) {
      throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_PATH_INVALID);
    }
    const actual = realpathSync(candidate);
    const displacement = relative(root, actual);
    if (displacement.startsWith(`..${sep}`) || displacement === ".." || dirname(actual) !== root) {
      throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_PATH_INVALID);
    }
    const parsed = parseSecondBrainStrictJson(readFileSync(actual, "utf8"));
    if (parsed === undefined) throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_READ_INVALID);
    return parsePersonalOsCorpus(parsed);
  } catch (error) {
    if (error instanceof PersonalOsFixtureError) throw error;
    if (error instanceof PersonalOsCorpusError && error.code === PERSONAL_OS_CORPUS_INVALID) {
      throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_READ_INVALID);
    }
    if (error instanceof Error) throw new PersonalOsFixtureError(PERSONAL_OS_FIXTURE_PATH_INVALID);
    throw error;
  }
}
