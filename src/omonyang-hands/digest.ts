import { createHash } from "node:crypto";
import { canonicalize } from "../canonical.js";

export function sha256Digest(value: unknown, kind: "input" | "output"): string {
  return `sha256:${createHash("sha256").update(`orca-jarvis/omonyang-hands/${kind}/v1\0`).update(canonicalize(value)).digest("hex")}`;
}
