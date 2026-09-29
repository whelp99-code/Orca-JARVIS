import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const pinnedWheel = "dcffa57bd011d59f0993583fee435413ebb0fb293fb3de941b567cca8e70e762";
const oracle = `import hashlib, json, pathlib, sys, tomllib, zipfile
assert sys.prefix != sys.base_prefix, "ISOLATED_PROVIDER_VENV_REQUIRED"
from pydantic import TypeAdapter
import sb.config
from sb.config import load_config
module = pathlib.Path(sb.config.__file__).resolve()
assert module.is_relative_to(pathlib.Path(sys.prefix).resolve()), "ORACLE_OUTSIDE_ISOLATED_RUNTIME"
with zipfile.ZipFile(sys.argv[1]) as wheel:
    assert hashlib.sha256(module.read_bytes()).digest() == hashlib.sha256(wheel.read("sb/config.py")).digest(), "ORACLE_PIN_MISMATCH"
cases = TypeAdapter(list[str]).validate_json(sys.stdin.buffer.read())
rows = []
for index, text in enumerate(cases):
    path = pathlib.Path(sys.argv[2]) / f"{index}.toml"
    path.write_text(text, encoding="utf-8")
    try:
        tomllib.loads(text)
        toml_ok = True
    except tomllib.TOMLDecodeError:
        toml_ok = False
    try:
        vault = load_config(path).vault_root
        producer_ok = True
    except (ValueError, TypeError):
        vault = None
        producer_ok = False
    rows.append({"tomllib": toml_ok, "producer": producer_ok, "vault": vault})
print(json.dumps(rows, ensure_ascii=False))
`;

/** Independent stdlib and pinned-provider interpretations, not a second implementation of config rules. */
export function producerConfigOutcomes(cases: readonly string[]) {
  const python = process.env["TASK30_PROVIDER_PYTHON"];
  const wheel = process.env["TASK30_PROVIDER_WHEEL"];
  if (python === undefined || wheel === undefined) throw new Error("TASK30_ISOLATED_PROVIDER_ORACLE_REQUIRED");
  if (createHash("sha256").update(readFileSync(wheel)).digest("hex") !== pinnedWheel) {
    throw new Error("TASK30_PROVIDER_ORACLE_WHEEL_MISMATCH");
  }
  const root = mkdtempSync(join(tmpdir(), "task30-config-oracle-"));
  try {
    const output = execFileSync(python, ["-I", "-c", oracle, wheel, root], {
      cwd: root, encoding: "utf8", input: JSON.stringify(cases), timeout: 10_000,
      env: { HOME: root, TMPDIR: root, XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), PATH: "/usr/bin:/bin" },
    });
    return z.array(z.object({ tomllib: z.boolean(), producer: z.boolean(), vault: z.string().nullable() }).strict())
      .length(cases.length).parse(JSON.parse(output));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
