import { receiptSchema, requestSchema, type ActionReceipt, type ActionRequest, type ActionSend, type WorkboardActionAdapter } from "../action-contracts.js";

/** Explicitly configured v1 conditional protocol, not autodetected from prose or an arbitrary URL.
 * The endpoint contract is implemented by the disposable fixture agent. No live app is claimed compatible.
 */
export class StructuredActions implements WorkboardActionAdapter {
  readonly requiresReceipt = false;
  constructor(readonly sourceId: string, private readonly endpoint: string,
    readonly effects: ActionRequest["effects"], readonly location: string) {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || ["4173", "4174", "4176"].includes(url.port)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("WORKBOARD_ENDPOINT_INVALID");
  }
  async readRequest(workId: string): Promise<ActionRequest | null> {
    const value = await this.request(`/requests/${encodeURIComponent(workId)}`);
    return value === null ? null : requestSchema.parse(value);
  }
  async send(input: ActionSend): Promise<void> {
    await this.request("/decisions", input);
  }
  async readReceipt(intentId: string): Promise<ActionReceipt | null> {
    const value = await this.request(`/receipts/${encodeURIComponent(intentId)}`);
    return value === null ? null : receiptSchema.parse(value);
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.endpoint), {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("WORKBOARD_SOURCE_UNAVAILABLE");
    return response.json();
  }
}
