#!/usr/bin/env node
import { runPersonalOsEvalCli } from "../dist/src/personal-os-eval-cli.js";

process.exitCode = runPersonalOsEvalCli({
  args: process.argv.slice(2),
  fixtureRoot: new URL("../test/fixtures/personal-os", import.meta.url).pathname,
  stdout: bytes => process.stdout.write(bytes),
  stderr: bytes => process.stderr.write(bytes),
});
