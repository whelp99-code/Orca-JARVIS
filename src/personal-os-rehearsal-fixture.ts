import { readFileSync } from "node:fs";
import { PersonalOsError } from "./personal-os-errors.js";
import { FixtureSchema, type RehearsalFixture } from "./personal-os-rehearsal-contract.js";

export function loadRehearsalFixture(path: string): RehearsalFixture {
  try {
    return FixtureSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof PersonalOsError) throw error;
    throw new PersonalOsError("E_FIXTURE_INVALID");
  }
}
