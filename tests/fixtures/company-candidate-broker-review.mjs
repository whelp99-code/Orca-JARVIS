import { createConnection } from "node:net";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import process from "node:process";

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;

if (!isMain && process.env.JARVIS_BROKER_REVIEW_FAULT === "post-listen") {
  const { registerHooks } = await import("node:module");
  const builtin = process.getBuiltinModule("node:fs");
  const forwarded = Object.keys(builtin)
    .filter((name) => name !== "default" && name !== "chmodSync" && name !== "chownSync" && /^[$A-Z_a-z][$0-9A-Z_a-z]*$/u.test(name))
    .map((name) => `export const ${name} = fs[${JSON.stringify(name)}];`)
    .join("\n");
  registerHooks({
    load(url, context, nextLoad) {
      if (url !== "node:fs") return nextLoad(url, context);
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const fs = process.getBuiltinModule("node:fs");
          function fault(path) {
            if (typeof path === "string" && path.endsWith(".sock")) {
              const error = new Error("EPERM");
              error.code = "EPERM";
              throw error;
            }
          }
          export function chmodSync(path, mode) {
            fault(path);
            return fs.chmodSync(path, mode);
          }
          export function chownSync(path, uid, gid) {
            fault(path);
            return fs.chownSync(path, uid, gid);
          }
          ${forwarded}
          export default fs;
        `,
      };
    },
  });
}

if (isMain) {
  const gatePath = process.argv[2];
  if (gatePath === undefined || !gatePath.startsWith("/")) process.exit(2);
  const socket = createConnection(gatePath);
  socket.on("error", () => process.exit(1));
  await once(socket, "connect");
  await once(socket, "end");
  process.stdout.write("{\"state\":\"ok\"}");
}
