#!/usr/bin/env node
import { evaluatePersonalOsCorpus } from "../dist/src/personal-os-evaluator.js";
import {
  loadPersonalOsCorpus,
  PersonalOsFixtureError,
  PERSONAL_OS_FIXTURE_PATH_INVALID,
} from "../dist/src/personal-os-eval-file.js";

const HELP = `Usage: npm run personal-os:eval -- [--fixture <name>]

Evaluates one bounded synthetic corpus from test/fixtures/personal-os.
Results are canonical JSON on stdout only; no output file is written.

Options:
  --fixture <name>  Corpus basename (default: happy.json)
  --help            Show this help without evaluating
`;
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write(HELP);
  process.exitCode = 0;
} else {
  let fixture = "happy.json";
  if (args.length === 2 && args[0] === "--fixture" && args[1] !== undefined) fixture = args[1];
  else if (args.length !== 0) {
    process.stderr.write(`${JSON.stringify({ code: "PERSONAL_OS_CLI_ARGUMENT_INVALID" })}\n`);
    process.exitCode = 2;
  }
  if (process.exitCode === undefined) {
    try {
      const corpus = loadPersonalOsCorpus(fixture, new URL("../test/fixtures/personal-os", import.meta.url).pathname);
      const result = evaluatePersonalOsCorpus(corpus);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.verdict === "pass" ? 0 : 1;
    } catch (error) {
      // no-excuse-ok: catch -- top-level CLI converts every boundary failure to one typed, non-stack response.
      const code = error instanceof PersonalOsFixtureError ? error.code : PERSONAL_OS_FIXTURE_PATH_INVALID;
      process.stderr.write(`${JSON.stringify({ code })}\n`);
      process.exitCode = 2;
    }
  }
}
