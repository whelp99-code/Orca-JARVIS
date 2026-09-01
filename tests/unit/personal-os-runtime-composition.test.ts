import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";
import { PersonalOsRuntime } from "../../src/personal-os-runtime.js";
import { GjcRuntimeService } from "../../src/service.js";
import { personalOsScratch, removeScratch } from "../fixtures/personal-os-scratch.js";

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) removeScratch(root);
});

describe("PersonalOsRuntime service-run composition", () => {
  it("wraps GjcRuntimeService when composing the staged service run root", () => {
    // Given
    const root = personalOsScratch("jarvis-task36-runtime-");
    scratchRoots.push(root);
    const authority = new AuthorityDb(join(root, "authority.sqlite"));

    // When
    const composed = PersonalOsRuntime.forServiceRun({
      authority,
      coordinator: new GjcCoordinatorClient(async () => ({ stdout: "", exitCode: 0 })),
      worker: "gjc-runtime",
      clock: () => new Date("2026-08-27T00:00:00.000Z"),
    });

    // Then
    expect(composed.runtime.owner).toBe("PersonalOsRuntime/RetentionRuntime");
    expect(composed.service).toBeInstanceOf(GjcRuntimeService);
    authority.close();
  });
});
