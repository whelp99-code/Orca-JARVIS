import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuthorityDb } from "./authority-db.js";
import { loadAgentToken } from "./omonyang-hands/auth.js";
import { HandsService } from "./omonyang-hands/hands.js";
import { createOmonyangHandsMcp } from "./omonyang-hands/mcp.js";
import { StdioSbMcp } from "./omonyang-hands/sb-client.js";

let direct = false;
try {
  direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch { /* imported */ }

if (direct) {
  try {
    const dbPath = process.argv[2];
    const tokenPath = process.argv[3];
    const sbCommand = process.argv[4];
    if (dbPath === undefined || tokenPath === undefined || sbCommand === undefined) throw new Error("arguments");
    const authority = new AuthorityDb(dbPath);
    await authority.migrate();
    const service = new HandsService(
      loadAgentToken(tokenPath),
      authority,
      new StdioSbMcp(sbCommand, process.argv.slice(5)),
      process.env["OMONYANG_HANDS_BIND"] ?? "stdio",
    );
    await createOmonyangHandsMcp(service).connect(new StdioServerTransport());
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "UNAVAILABLE";
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
  }
}
