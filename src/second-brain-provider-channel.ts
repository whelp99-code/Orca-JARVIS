import type { ChildProcess } from "node:child_process";
import type { SecondBrainTransportError } from "./second-brain-transport.js";
import type { ProviderJson as Json } from "./second-brain-provider-contract.js";
import {
  PROVIDER_FRAME_BYTES,
  asProviderRecord,
  isProviderRecord,
  providerToolError,
  providerToolPayload,
  type ProviderPending,
} from "./second-brain-provider-codec.js";

type Disposition = "unavailable" | "uncertain" | "fatal";
type ErrorFactory = (
  code: string,
  disposition: Disposition,
  requestId?: string,
) => SecondBrainTransportError;
type ListenerSet = Readonly<{
  child: ChildProcess;
  data: (chunk: Buffer | string) => void;
  close: () => void;
  error: () => void;
}>;

export class ProviderStdioChannel {
  private buffer = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  private sequence = 0;
  private listeners: ListenerSet | undefined;
  private readonly pending = new Map<string, ProviderPending>();

  constructor(private readonly makeError: ErrorFactory) {}

  attach(child: ChildProcess, onUnexpectedClose: () => void): void {
    this.detach();
    this.buffer = Buffer.alloc(0);
    const data = (chunk: Buffer | string): void => this.onData(chunk);
    const close = (): void => {
      this.failAll(this.makeError("SECOND_BRAIN_PROVIDER_CHILD_EXIT", "unavailable"));
      onUnexpectedClose();
    };
    const error = (): void => {
      this.failAll(this.makeError("SECOND_BRAIN_PROVIDER_CHILD_EXIT", "unavailable"));
    };
    this.listeners = { child, data, close, error };
    child.stdout?.on("data", data);
    child.once("close", close);
    child.once("error", error);
  }

  detach(): void {
    const listeners = this.listeners;
    if (!listeners) return;
    listeners.child.stdout?.off("data", listeners.data);
    listeners.child.off("close", listeners.close);
    listeners.child.off("error", listeners.error);
    this.listeners = undefined;
  }

  notification(message: Json): void {
    this.write(Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
  }

  request(
    method: string,
    params: Json,
    write: boolean,
    timeout: number,
  ): Promise<Json> {
    const id = `provider:${++this.sequence}`;
    const frame = Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      "utf8",
    );
    if (frame.length > PROVIDER_FRAME_BYTES) {
      return Promise.reject(
        this.makeError("SECOND_BRAIN_PROVIDER_OVERSIZE_FRAME", "fatal", id),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.makeError(
          write ? "SECOND_BRAIN_PROVIDER_WRITE_TIMEOUT" : "SECOND_BRAIN_PROVIDER_READ_TIMEOUT",
          write ? "uncertain" : "unavailable",
          id,
        ));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, write });
      try {
        this.write(frame);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(this.makeError(
          "SECOND_BRAIN_PROVIDER_CHILD_EXIT",
          write ? "uncertain" : "unavailable",
          id,
        ));
      }
    });
  }

  closePending(): void {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(this.makeError("SECOND_BRAIN_PROVIDER_CLOSED", "unavailable", id));
    }
    this.pending.clear();
  }

  private write(frame: Buffer): void {
    const child = this.listeners?.child;
    if (!child?.stdin?.writable) throw new Error("child closed");
    child.stdin.write(frame);
  }

  private onData(chunk: Buffer | string): void {
    this.buffer = Buffer.concat([
      this.buffer,
      typeof chunk === "string" ? Buffer.from(chunk) : chunk,
    ]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > PROVIDER_FRAME_BYTES) this.rejectOversize();
        return;
      }
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (frame.length > PROVIDER_FRAME_BYTES) {
        this.rejectOversize();
        return;
      }
      this.acceptFrame(frame);
    }
  }

  private acceptFrame(frame: Buffer): void {
    try {
      const response = asProviderRecord(JSON.parse(frame.toString("utf8")));
      if (typeof response.id !== "string") throw new Error();
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (isProviderRecord(response.error)) {
        pending.reject(this.makeError(
          "SECOND_BRAIN_PROVIDER_PROTOCOL_ERROR",
          pending.write ? "uncertain" : "unavailable",
          response.id,
        ));
        return;
      }
      const result = asProviderRecord(response.result);
      if (result.isError === true || "content" in result || "structuredContent" in result) {
        this.acceptToolResult(response.id, pending, result);
      } else {
        pending.resolve(result);
      }
    } catch {
      this.failAll(this.makeError("SECOND_BRAIN_PROVIDER_MALFORMED_FRAME", "fatal"));
    }
  }

  private acceptToolResult(id: string, pending: ProviderPending, result: Json): void {
    if (result.isError === true) {
      pending.reject(this.makeError(
        providerToolError(result),
        pending.write ? "uncertain" : "unavailable",
        id,
      ));
      return;
    }
    try {
      pending.resolve(providerToolPayload(result));
    } catch {
      pending.reject(this.makeError(
        "SECOND_BRAIN_PROVIDER_MALFORMED_FRAME",
        "fatal",
        id,
      ));
    }
  }

  private rejectOversize(): void {
    this.buffer = Buffer.alloc(0);
    this.failAll(this.makeError("SECOND_BRAIN_PROVIDER_OVERSIZE_FRAME", "fatal"));
  }

  private failAll(error: SecondBrainTransportError): void {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(item.write
        ? this.makeError("SECOND_BRAIN_PROVIDER_WRITE_INTERRUPTED", "uncertain", id)
        : error);
    }
    this.pending.clear();
  }
}
