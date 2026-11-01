import { readdirSync } from "node:fs";
import { afterAll, beforeAll } from "vitest";
import { privateRunRoot, removeNewProviderChildren } from "../scripts/lib/provider-storage-cleanup.mjs";

const root = privateRunRoot();
if (root !== undefined) {
  let seen = new Set<string>();
  beforeAll(() => { seen = new Set(readdirSync(root)); });
  afterAll(() => { removeNewProviderChildren(root, seen); });
}
