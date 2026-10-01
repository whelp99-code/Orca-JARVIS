import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAgentToken } from "./omonyang-hands/auth.js";
import { HandsService } from "./omonyang-hands/hands.js";
import { createOmonyangHandsMcp } from "./omonyang-hands/mcp.js";
import { HandsStore } from "./omonyang-hands/store.js";
import { FileVault } from "./omonyang-hands/vault.js";

let direct = false;
try {
  direct = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch { /* imported */ }

if (direct) {
  try {
    if (process.argv.length !== 5) throw new Error("arguments");
    const token = loadAgentToken(process.argv[2]!);
    const store = new HandsStore(process.argv[3]!);
    const vault = new FileVault(process.argv[4]!);
    const bind = process.env["OMONYANG_HANDS_BIND"] ?? "stdio";
    const service = new HandsService(token, store, vault, bind);
    await createOmonyangHandsMcp(service).connect(new StdioServerTransport());
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "UNAVAILABLE";
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
  }
}
