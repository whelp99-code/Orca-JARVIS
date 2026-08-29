import { evaluatePersonalOsCorpus } from "./personal-os-evaluator.js";
import { loadPersonalOsCorpus, PersonalOsFixtureError } from "./personal-os-eval-file.js";
import type { PersonalOsCorpus } from "./personal-os-eval-types.js";

export const PERSONAL_OS_EVAL_HELP = `Usage: npm run personal-os:eval -- [--fixture <name>]

Evaluates one bounded synthetic corpus from test/fixtures/personal-os.
Results are canonical JSON on stdout only; no output file is written.

Options:
  --fixture <name>  Corpus basename (default: happy.json)
  --help            Show this help without evaluating
`;
type PersonalOsEvalCliOptions = {
  readonly args: readonly string[]; readonly fixtureRoot: string;
  readonly stdout: (bytes: string) => void; readonly stderr: (bytes: string) => void;
  readonly load?: (fixtureName: string, fixtureRoot: string) => PersonalOsCorpus;
};
export function runPersonalOsEvalCli(options: PersonalOsEvalCliOptions): number {
  if (options.args.length === 1 && options.args[0] === "--help") { options.stdout(PERSONAL_OS_EVAL_HELP); return 0; }
  let fixture = "happy.json";
  if (options.args.length === 2 && options.args[0] === "--fixture" && options.args[1] !== undefined) fixture = options.args[1];
  else if (options.args.length !== 0) { options.stderr(`${JSON.stringify({ code: "PERSONAL_OS_CLI_ARGUMENT_INVALID" })}\n`); return 2; }
  try {
    const corpus = (options.load ?? loadPersonalOsCorpus)(fixture, options.fixtureRoot);
    const result = evaluatePersonalOsCorpus(corpus); options.stdout(`${JSON.stringify(result)}\n`);
    return result.verdict === "pass" ? 0 : 1;
  } catch (error) {
    // no-excuse-ok: catch -- top-level CLI emits stable non-stack boundary and internal failures.
    const code = error instanceof PersonalOsFixtureError ? error.code : "PERSONAL_OS_INTERNAL_ERROR";
    options.stderr(`${JSON.stringify({ code })}\n`); return 2;
  }
}
