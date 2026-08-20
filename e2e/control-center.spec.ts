import { expect, test } from "@playwright/test";
import { attachConsole, type ConsoleBag } from "./browser-qa.js";
import {
  agentLogsFlow,
  approveExecuteFlow,
  cancelFlow,
  emptyDbFlow,
  invalidReceiptFlow,
  koreanObjectiveFlow,
  overviewFlow,
  proposalStageFlow,
  qualityFlow,
  rejectFlow,
  retryFlow,
  taskGraphFlow,
} from "./control-center-flows.js";

test.describe.configure({ mode: "serial" });

let consoleBag: ConsoleBag;

test.beforeEach(async ({ page }) => {
  consoleBag = attachConsole(page);
});

test.afterEach(() => {
  expect(consoleBag.errors).toEqual([]);
});

test("overview shows live cards timeline approvals and risks", async ({ page }, testInfo) => {
  await overviewFlow(page, testInfo);
});

test("korean objective renders without clipping", async ({ page }, testInfo) => {
  await koreanObjectiveFlow(page, testInfo);
});

test("task detail exposes graph and list views", async ({ page }, testInfo) => {
  await taskGraphFlow(page, testInfo);
});

test("agent logs redact fixture secrets", async ({ page }, testInfo) => {
  await agentLogsFlow(page, testInfo);
});

test("empty authority database shows empty states", async ({ page }, testInfo) => {
  await emptyDbFlow(page, testInfo);
});

test("proposal preview does not write rows then stages a task", async ({ page, baseURL }, testInfo) => {
  await proposalStageFlow(page, testInfo, requiredBase(baseURL));
});

test("missing and invalid receipts show a safe error and keep the fingerprint", async ({ page, baseURL }, testInfo) => {
  await invalidReceiptFlow(page, testInfo, requiredBase(baseURL));
});

test("valid signed approve then execute settles the request", async ({ page, baseURL }) => {
  await approveExecuteFlow(page, requiredBase(baseURL));
});

test("valid signed reject settles pending-only", async ({ page, baseURL }) => {
  await rejectFlow(page, requiredBase(baseURL));
});

test("cancel stages a pending workflow.cancel", async ({ page }) => {
  await cancelFlow(page);
});

test("failed-only retry stages a fresh pending request", async ({ page }) => {
  await retryFlow(page);
});

test("axe serious or critical is zero and the viewport does not overflow", async ({ page }) => {
  await qualityFlow(page, consoleBag.errors);
});

function requiredBase(baseURL: string | undefined): string {
  if (baseURL === undefined || baseURL.length === 0) throw new Error("baseURL required");
  return baseURL;
}
