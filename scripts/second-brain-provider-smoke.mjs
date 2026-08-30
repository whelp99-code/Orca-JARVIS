#!/usr/bin/env node
import { SecondBrainProviderClient } from "../dist/src/second-brain-provider.js";

const launcherPath = process.env.SECOND_BRAIN_PROVIDER_BIN;
if (!launcherPath) { process.stdout.write(`${JSON.stringify({ ok: false, state: "unavailable", code: "SECOND_BRAIN_PROVIDER_BIN_REQUIRED" })}\n`); process.exitCode = 2; }
else {
  const provider = new SecondBrainProviderClient({ launcherPath, configPath: process.env.SECOND_BRAIN_PROVIDER_CONFIG });
  try { const health = await provider.health(); process.stdout.write(`${JSON.stringify({ ok: true, health })}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ ok: false, state: "unavailable", code: error instanceof Error ? error.message : "SECOND_BRAIN_PROVIDER_SMOKE_FAILED" })}\n`); process.exitCode = 2; }
  finally { await provider.close().catch(() => undefined); }
}
