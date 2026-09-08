import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
const output = process.argv[2] ?? "dist";
await rm(join(output, "migrations"), { recursive: true, force: true });
await mkdir(join(output, "migrations"), { recursive: true });
await cp("migrations", join(output, "migrations"), { recursive: true });
await rm(join(output, "contracts"), { recursive: true, force: true });
await mkdir(join(output, "contracts"), { recursive: true });
for (const name of ["second-brain-mcp-v1.json", "second-brain-mcp-v1.json.sha256",
  "second-brain-mcp-v3.json", "second-brain-mcp-v3.json.sha256"]) {
  await cp(join("contracts", name), join(output, "contracts", name));
}
