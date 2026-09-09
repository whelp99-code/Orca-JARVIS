import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
const output = process.argv[2] ?? "dist";
await mkdir(join(output, "src"), { recursive: true });
await cp("config/personal-os-policy.json", join(output, "src", "personal-os-policy.json"));
await rm(join(output, "migrations"), { recursive: true, force: true });
await mkdir(join(output, "migrations"), { recursive: true });
await cp("migrations", join(output, "migrations"), { recursive: true });
await rm(join(output, "contracts"), { recursive: true, force: true });
await mkdir(join(output, "contracts"), { recursive: true });
for (const name of ["second-brain-mcp-v1.json", "second-brain-mcp-v1.json.sha256",
  "second-brain-mcp-v3.json", "second-brain-mcp-v3.json.sha256",
  "second-brain-mcp-v4.json", "second-brain-mcp-v4.json.sha256",
  "second-brain-mcp-v5.json", "second-brain-mcp-v5.json.sha256",
  "second-brain-scoped-read-v1.json", "second-brain-scoped-read-v1.json.sha256",
  "second-brain-scoped-read-v2.json", "second-brain-scoped-read-v2.json.sha256",
  "second-brain-scoped-read-v5.json", "second-brain-scoped-read-v5.json.sha256", "second-brain-scoped-read-v4.json", "second-brain-scoped-read-v4.json.sha256", "second-brain-scoped-read-v3.json", "second-brain-scoped-read-v3.json.sha256"]) {
  await cp(join("contracts", name), join(output, "contracts", name));
}
