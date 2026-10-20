import { writeFileSync } from "node:fs";
import { startCompanyCandidateBroker } from "../../src/company-candidate-broker-main.mjs";

const [config, ready] = process.argv.slice(2);
if (!config || !ready) throw new Error("Missing broker fixture arguments");
const broker = await startCompanyCandidateBroker(config);
writeFileSync(ready, "READY", { flag: "wx", mode: 0o600 });
process.on("SIGTERM", () => { void broker.close().then(() => process.exit(0)); });
