import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCompanyJson, parseCompanyJsonBytes } from "../../src/company-candidate-json.js";

describe("company v2 raw JSON profile", () => {
  it.each(["-0", "-1", "1.0", "1e0", "1E+0", "9007199254740992"])("rejects the raw number token %s", number => {
    expect(parseCompanyJson(`{"schema_version":2,"sequence":${number}}`)).toBeUndefined();
  });

  it("does not lose the invalid spelling of the version marker itself", () => {
    expect(parseCompanyJson('{"schema_version":2e0}')).toBeUndefined();
    expect(parseCompanyJson('{"schema_version":2.0}')).toBeUndefined();
  });
  it("applies the profile to the v1 approval envelope referencing a v2 request", () => {
    expect(parseCompanyJson('{"schema_version":1,"request_id":"company-handoff:v2:fixture:1","max_uses":1e0}')).toBeUndefined();
  });

  it("validates all numbers within an actual v2 handoff page", () => {
    const fixture: { command: unknown; command_digest: string; handoff_key: string } = JSON.parse(
      readFileSync("fixtures/company-approver/company-approver-v2.test-only.json", "utf8"),
    );
    const page = { handoffs: [{ idempotency_key: fixture.handoff_key, command: fixture.command, command_digest: fixture.command_digest }],
      count: 1, limit: 100, offset: 0 };
    const raw = JSON.stringify(page);
    expect(parseCompanyJson(raw)).toEqual(page);
    expect(parseCompanyJson(raw.replace('"deletion_sequence":0', '"deletion_sequence":0e0'))).toBeUndefined();
    expect(parseCompanyJson(raw.replace('"schema_version":1', '"schema_version":1e0')
      .replace('"count":1', '"count":1.0'))).toBeUndefined();
  });

  it("refuses non-NFC strings, non-ASCII keys, duplicate keys and invalid UTF-8", () => {
    expect(parseCompanyJson('{"schema_version":2,"text":"e\\u0301"}')).toBeUndefined();
    expect(parseCompanyJson('{"schema_version":2,"\\u00e9":1}')).toBeUndefined();
    expect(parseCompanyJson('{"schema_version":2,"sequence":0,"sequence":1}')).toBeUndefined();
    expect(parseCompanyJsonBytes(new Uint8Array([0xc0, 0xaf]))).toBeUndefined();
    expect(parseCompanyJsonBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toBeUndefined();
  });

  it("preserves the existing v1 JSON number and string behavior", () => {
    expect(parseCompanyJson('{"schema_version":1,"n":-0,"float":1.5,"exp":1e0,"text":"e\\u0301"}'))
      .toEqual({ schema_version: 1, n: -0, float: 1.5, exp: 1, text: "e\u0301" });
  });
});
