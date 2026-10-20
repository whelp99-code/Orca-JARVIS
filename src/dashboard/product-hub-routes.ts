import type { DashboardApiInput } from "./api-routes.js";
import type { MailCandidatesSummary } from "../integration/mail-candidates-contract.js";
import { JarvisError } from "../jarvis-error.js";
import { classifyPersonalSnapshot } from "../personal-connector-results.js";
import type { PersonalConnectorState, PersonalSourceSnapshot } from "../personal-connector-types.js";
import { pendingControlSummary } from "./control-request-read.js";
import { hasSameOriginReadOrigin } from "./request-boundary.js";
import { sessionMatchesCsrf } from "./session.js";
import { writeDashboardError, writeDashboardJson } from "./http.js";
import { productHubSchema, type ProductHubResponse } from "./product-hub-contract.js";

type HubItem = ProductHubResponse["items"][number];
type HubState = HubItem["state"];
type SourceFailure = { readonly failed: "denied" | "unavailable"; readonly code: string };

export type ProductHubRead = {
  readonly clock: () => Date;
  readonly db: DashboardApiInput["db"];
  readonly mailCandidates?: { read(): Promise<MailCandidatesSummary> };
  readonly mailSource?: { read(now: Date): Promise<PersonalSourceSnapshot> };
  readonly messengerSource?: { read(now: Date): Promise<PersonalSourceSnapshot> };
  readonly priceConfigured: boolean;
  readonly memoryConfigured: boolean;
};

export async function tryHandleProductHub(input: DashboardApiInput): Promise<boolean> {
  if (input.path !== "/api/v1/product-hub") return false;
  if (input.request.method !== "GET" || !hasSameOriginReadOrigin(input.request, input.origin)
    || !sessionMatchesCsrf(input.session, typeof input.request.headers["x-jarvis-csrf"] === "string"
      ? input.request.headers["x-jarvis-csrf"] : undefined)) {
    input.request.resume();
    writeDashboardError(input.response, { status: 403, code: "LOCAL_SESSION_REQUIRED", requestId: input.requestId });
    return true;
  }
  if (new URL(input.url ?? "", input.origin).search !== "") {
    writeDashboardError(input.response, { status: 400, code: "VALIDATION_ERROR", requestId: input.requestId });
    return true;
  }
  const body = await readProductHub({
    clock: input.clock,
    db: input.db,
    ...(input.mailCandidates === undefined ? {} : { mailCandidates: input.mailCandidates }),
    ...(input.mailSource === undefined ? {} : { mailSource: input.mailSource }),
    ...(input.messengerSource === undefined ? {} : { messengerSource: input.messengerSource }),
    priceConfigured: input.priceFinance !== undefined,
    memoryConfigured: memoryReadConfigured(input),
  });
  writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body });
  return true;
}

export async function readProductHub(input: ProductHubRead): Promise<ProductHubResponse> {
  const now = input.clock();
  const [candidates, mail, messenger] = await Promise.all([
    settle(input.mailCandidates?.read()),
    settle(input.mailSource?.read(now)),
    settle(input.messengerSource?.read(now)),
  ]);
  const body = {
    schema_version: 1 as const,
    generated_at: now.toISOString(),
    items: [
      crmCard(candidates),
      mailCard(mail, now),
      card("price", input.priceConfigured ? "configured" : "unconfigured"),
      secondBrainCard(candidates, input.memoryConfigured),
      messengerCard(messenger, now),
      approvalsCard(input.db, now),
    ] as const,
  };
  return productHubSchema.parse(body);
}

function memoryReadConfigured(input: DashboardApiInput): boolean {
  try {
    return input.memoryRuntime.read.status().state === "ready";
  } catch (error) {
    if (!(error instanceof JarvisError)) throw error;
    return false;
  }
}

async function settle<T>(read: Promise<T> | undefined): Promise<{ readonly value: T } | SourceFailure | undefined> {
  if (read === undefined) return undefined;
  try {
    return { value: await read };
  } catch (error) {
    if (!(error instanceof JarvisError)) throw error;
    return { failed: identityScopeDenied(error.code) ? "denied" : "unavailable", code: error.code };
  }
}

function crmCard(
  settled: { readonly value: MailCandidatesSummary } | SourceFailure | undefined,
): HubItem {
  if (settled === undefined) return card("crm", "unconfigured");
  if ("failed" in settled) return card("crm", candidateFailure(settled, "crm"));
  if (settled.value.proof_level !== "native-read") return card("crm", "unavailable");
  const crm = settled.value.crm;
  if (crm.state === "unconnected") return card("crm", crm.reason === "refused" ? "denied" : "unconfigured");
  if (crm.candidate_count === 0) return card("crm", "no_data", settled.value.observed_at, 0);
  return card("crm", "ready", settled.value.observed_at, crm.candidate_count);
}

function secondBrainCard(
  settled: { readonly value: MailCandidatesSummary } | SourceFailure | undefined,
  memoryConfigured: boolean,
): HubItem {
  if (settled === undefined) return card("second_brain", memoryConfigured ? "configured" : "unconfigured");
  if ("failed" in settled) return card("second_brain", candidateFailure(settled, "second_brain"));
  if (settled.value.proof_level !== "native-read") {
    return card("second_brain", memoryConfigured ? "configured" : "unavailable");
  }
  const sb = settled.value.sb;
  if (sb.state === "unconnected") {
    if (sb.reason === "refused") return card("second_brain", "denied");
    return card("second_brain", memoryConfigured ? "configured" : "unconfigured");
  }
  if (sb.candidate_count === 0) return card("second_brain", "no_data", settled.value.observed_at, 0);
  return card("second_brain", "ready", settled.value.observed_at, sb.candidate_count);
}

function mailCard(
  settled: { readonly value: PersonalSourceSnapshot } | SourceFailure | undefined,
  now: Date,
): HubItem {
  if (settled === undefined) return card("mail", "unconfigured");
  if ("failed" in settled) return card("mail", settled.failed);
  const snapshot = settled.value;
  const classified = classifyPersonalSnapshot(snapshot, "mail", now);
  const state = connectorState(classified.state, classified.reason);
  if (state === "denied" || state === "unconfigured" || state === "unavailable") return card("mail", state);
  const primary = verifiedCount(snapshot.values.message_count);
  const secondary = verifiedCount(snapshot.values.thread_count);
  if (state === "no_data" && primary === undefined && secondary === undefined) {
    return card("mail", "no_data", snapshot.observed_at, 0, 0, null);
  }
  return card("mail", state, snapshot.observed_at, primary ?? null, secondary ?? null, null);
}

function messengerCard(
  settled: { readonly value: PersonalSourceSnapshot } | SourceFailure | undefined,
  now: Date,
): HubItem {
  if (settled === undefined) return card("messenger", "unconfigured");
  if ("failed" in settled) return card("messenger", settled.failed);
  const snapshot = settled.value;
  const classified = classifyPersonalSnapshot(snapshot, "messenger", now);
  const state = connectorState(classified.state, classified.reason);
  if (state === "denied" || state === "unconfigured" || state === "unavailable") return card("messenger", state);
  const count = verifiedCount(snapshot.values.incomplete_count);
  const rawAge = snapshot.values.oldest_incomplete_age_ms;
  const oldest = rawAge === null ? null : verifiedCount(rawAge) ?? null;
  if (state === "no_data" && count === undefined) return card("messenger", "no_data", snapshot.observed_at, 0, null, null);
  return card("messenger", state, snapshot.observed_at, count ?? null, null, oldest);
}

function approvalsCard(db: DashboardApiInput["db"], now: Date): HubItem {
  try {
    const total = pendingControlSummary(db, now).total;
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error("PENDING_CONTROL_COUNT_INVALID");
    }
    if (total === 0) return card("approvals", "no_data", null, 0);
    return card("approvals", "ready", null, total);
  } catch (error) {
    if (!(error instanceof JarvisError)) throw error;
    return card("approvals", "unavailable");
  }
}

function identityScopeDenied(code: string): boolean {
  return code.endsWith("_SCOPE_DENIED") || code.endsWith("_IDENTITY_REFUSED");
}

function candidateFailure(settled: SourceFailure, id: "crm" | "second_brain"): HubState {
  if (settled.failed !== "denied") return "unavailable";
  if (id === "crm" && settled.code.startsWith("SB_")) return "unavailable";
  if (id === "second_brain" && settled.code.startsWith("CRM_")) return "unavailable";
  return "denied";
}

function connectorState(
  state: PersonalConnectorState,
  reason: string,
): HubState {
  if (reason === "no_scope") return "denied";
  if (reason === "not_configured") return "unconfigured";
  if (state === "offline") return "unavailable";
  return state;
}

function verifiedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function card(
  id: HubItem["id"],
  state: HubState,
  observed_at: string | null = null,
  count: number | null = null,
  secondary_count: number | null = null,
  oldest_age_ms: number | null = null,
): HubItem {
  return { id, state, observed_at, count, secondary_count, oldest_age_ms };
}
