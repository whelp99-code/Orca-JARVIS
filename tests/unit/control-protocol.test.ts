import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeControlFrame, encodeControlFrame } from "../../src/control-protocol-codec.js";
import { decodeControlFrame as decodeShell, encodeControlFrame as encodeShell } from "../../shells/cli-jaw/src/jarvis/control-protocol-codec.js";
import { CONTROL_FRAME_MAX_BYTES, CONTROL_METHODS, type ControlFrame } from "../../src/control-protocol.js";

const fixturesDir = join(process.cwd(), "test/fixtures/control-protocol/v1");
const fixtureNames = ["capabilities-get.json", "capabilities-ok.json", "timeline-event.json"] as const;

function loadFixture(name: (typeof fixtureNames)[number]): ControlFrame {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as ControlFrame;
}

function rawFrame(overrides: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify({ ...loadFixture("capabilities-get.json"), ...overrides })}\n`;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("jarvis-control protocol", () => {
  it("round-trips shared fixtures through both codecs", () => {
    for (const name of fixtureNames) {
      const fixture = loadFixture(name);
      const jarvisBytes = encodeControlFrame(fixture);
      const shellBytes = encodeShell(fixture);
      expect(jarvisBytes).toBe(shellBytes);
      const jarvis = decodeControlFrame(jarvisBytes);
      const shell = decodeShell(shellBytes);
      expect(jarvis).toEqual({ ok: true, frame: fixture });
      expect(shell).toEqual(jarvis);
    }
  });

  it("rejects the named malformed classes without invoking a handler", () => {
    let handlers = 0;
    const handle = (frame: unknown) => {
      handlers += 1;
      return frame;
    };
    const base = loadFixture("capabilities-get.json");
    const oversized = "x".repeat(CONTROL_FRAME_MAX_BYTES + 1);
    const cases: Array<{ name: string; raw: string; ctx?: Parameters<typeof decodeControlFrame>[1]; code: string }> = [
      { name: "oversized", raw: oversized, code: "invalid_request" },
      { name: "duplicate-id", raw: encodeControlFrame(base), ctx: { seenIds: new Set([base.id]) }, code: "conflict" },
      { name: "unknown-method", raw: rawFrame({ method: "not.a.method" }), code: "invalid_request" },
      { name: "stale-generation", raw: encodeControlFrame(base), ctx: { generation: "other-gen" }, code: "stale_generation" },
      { name: "malformed-time", raw: rawFrame({ sentAt: "yesterday" }), code: "invalid_request" },
      { name: "response-without-request", raw: encodeControlFrame(loadFixture("capabilities-ok.json")), ctx: { pendingRequestIds: new Set() }, code: "invalid_request" },
      { name: "unsupported-version", raw: rawFrame({ version: "0.9" }), code: "unsupported_version" },
      { name: "authority-field", raw: rawFrame({ payload: { trustTier: 4 } }), code: "unauthorized" },
    ];
    for (const entry of cases) {
      const jarvis = decodeControlFrame(entry.raw, entry.ctx);
      const shell = decodeShell(entry.raw, entry.ctx);
      expect(jarvis.ok).toBe(false);
      expect(shell).toEqual(jarvis);
      if (!jarvis.ok) expect(jarvis.error.code).toBe(entry.code);
      else handle(jarvis.frame);
    }
    expect(handlers).toBe(0);
  });

  it("negotiates over stdout-only frames with logs on stderr", () => {
    const request = loadFixture("capabilities-get.json");
    const result = spawnSync(process.execPath, ["scripts/jarvis-control-handshake.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: encodeControlFrame(request),
    });
    expect(result.status).toBe(0);
    const lines = result.stdout.split("\n").filter(line => line.length > 0);
    expect(lines).toHaveLength(1);
    const decoded = decodeControlFrame(lines[0] ?? "", { pendingRequestIds: new Set([request.id]) });
    expect(decoded.ok).toBe(true);
    expect(result.stderr).toContain("jarvis-control handshake");
    expect(result.stderr.split("\n").every(line => line.length === 0 || !line.startsWith("{"))).toBe(true);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/04"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/04/handshake.jsonl"), `${lines[0]}\n`);
  });

  it("rejects a 1000-case malformed corpus with a fixed seed and zero handler calls", () => {
    const random = mulberry32(20260823);
    const base = loadFixture("capabilities-get.json");
    const counts: Record<string, number> = {};
    let handlers = 0;
    for (let index = 0; index < 1000; index += 1) {
      const kind = Math.floor(random() * 8);
      let raw = "";
      let ctx: Parameters<typeof decodeControlFrame>[1] = {};
      switch (kind) {
        case 0:
          raw = "x".repeat(CONTROL_FRAME_MAX_BYTES + 1 + Math.floor(random() * 16));
          break;
        case 1:
          raw = encodeControlFrame(base);
          ctx = { seenIds: new Set([base.id]) };
          break;
        case 2:
          raw = rawFrame({ method: `unknown.${index}` });
          break;
        case 3:
          raw = encodeControlFrame(base);
          ctx = { generation: `gen-${index}` };
          break;
        case 4:
          raw = rawFrame({ sentAt: `not-a-time-${index}` });
          break;
        case 5:
          raw = encodeControlFrame(loadFixture("capabilities-ok.json"));
          ctx = { pendingRequestIds: new Set() };
          break;
        case 6:
          raw = rawFrame({ version: index % 2 === 0 ? "2.0" : "0.8" });
          break;
        default:
          raw = rawFrame({ payload: { actionLevel: "high", principal: `p-${index}` } });
          break;
      }
      const jarvis = decodeControlFrame(raw, ctx);
      const shell = decodeShell(raw, ctx);
      expect(shell).toEqual(jarvis);
      if (jarvis.ok) handlers += 1;
      else counts[jarvis.error.code] = (counts[jarvis.error.code] ?? 0) + 1;
    }
    expect(handlers).toBe(0);
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(1000);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/04"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/04/malformed.json"), `${JSON.stringify({ handlers, counts, seed: 20260823, n: 1000 }, null, 2)}\n`);
  });

  it("keeps the published method list exhaustive", () => {
    expect(CONTROL_METHODS).toHaveLength(11);
  });
});
