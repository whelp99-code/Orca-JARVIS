import { execFile as nodeExecFile } from "node:child_process";
import { realpathSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { SecondBrainTransportError } from "./second-brain-transport.js";
import {
  SECOND_BRAIN_PROVIDER_TOOLS,
  type ProviderExecFile,
  type ProviderJson as Json,
  type ProviderTransportOptions,
  type SecondBrainProviderMethod,
} from "./second-brain-provider-contract.js";
import {
  PROVIDER_MUTATING_METHODS,
  assertProviderBounded,
  isProviderRecord,
  providerDeadline,
  providerLauncherArgs,
} from "./second-brain-provider-codec.js";
import { ProviderStdioChannel } from "./second-brain-provider-channel.js";

export class SecondBrainProviderProcess {
  private child: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private closed = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly channel: ProviderStdioChannel;
  private readonly launcher: string;
  private readonly args: readonly string[];
  private readonly config: string;
  private readonly run: ProviderExecFile;
  private readonly resolvePath: (path: string) => string;
  private readonly startupMs: number;
  private readonly readMs: number;
  private readonly writeMs: number;
  private readonly retries: 0 | 1;

  constructor(options: ProviderTransportOptions = {}) {
    this.launcher = options.launcherPath
      ?? process.env.SECOND_BRAIN_PROVIDER_BIN
      ?? "/home/jm/.local/bin/sb";
    this.args = providerLauncherArgs(this.launcher, options.launcherArgs);
    this.config = options.configPath
      ?? process.env.SECOND_BRAIN_PROVIDER_CONFIG
      ?? "/home/jm/.config/second-brain/config.toml";
    this.run = options.execFile ?? (nodeExecFile as unknown as ProviderExecFile);
    this.resolvePath = options.realpath ?? realpathSync;
    this.startupMs = providerDeadline(options.startupMs, 5_000);
    this.readMs = providerDeadline(options.readMs, 10_000);
    this.writeMs = providerDeadline(options.writeMs, 30_000);
    this.retries = options.retries ?? 1;
    this.channel = new ProviderStdioChannel((code, disposition, requestId) =>
      this.error(code, disposition, requestId));
  }

  async call(method: SecondBrainProviderMethod, arguments_: Json): Promise<Json> {
    assertProviderBounded(arguments_);
    if (PROVIDER_MUTATING_METHODS.has(method)) return this.mutate(method, arguments_);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.ensureStarted();
        return await this.request(method, arguments_, false);
      } catch (error) {
        const retryable = attempt < this.retries
          && error instanceof SecondBrainTransportError
          && error.code === "SECOND_BRAIN_PROVIDER_CHILD_EXIT";
        if (!retryable) throw error;
        await this.restart();
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.channel.closePending();
    const child = this.child;
    if (child) await this.terminate(child);
    this.child = undefined;
  }

  private async mutate(method: SecondBrainProviderMethod, arguments_: Json): Promise<Json> {
    const previous = this.mutationTail;
    let release = (): void => undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.ensureStarted();
      return await this.request(method, arguments_, true);
    } finally {
      release();
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw this.error("SECOND_BRAIN_PROVIDER_CLOSED", "unavailable");
    if (this.child) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    let target: string;
    try {
      target = this.resolvePath(this.launcher);
    } catch {
      throw this.error("SECOND_BRAIN_PROVIDER_UNAVAILABLE", "unavailable");
    }
    const child = this.run(target, this.args, {
      env: {
        ...process.env,
        SB_MCP_PROFILE: "provider",
        SB_CONFIG: this.config,
      },
      shell: false,
      windowsHide: true,
      encoding: "buffer",
    });
    this.child = child;
    this.channel.attach(child, () => {
      if (this.child === child) this.child = undefined;
    });
    try {
      await this.handshake();
    } catch (error) {
      await this.terminate(child);
      this.child = undefined;
      throw error instanceof SecondBrainTransportError
        ? error
        : this.error("SECOND_BRAIN_PROVIDER_START_FAILED", "unavailable");
    }
  }

  private async handshake(): Promise<void> {
    const initialized = await this.channel.request(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "orca-jarvis-provider", version: "1" },
      },
      false,
      this.startupMs,
    );
    if (initialized.protocolVersion !== "2025-11-25") {
      throw this.error("SECOND_BRAIN_PROVIDER_VERSION_MISMATCH", "fatal");
    }
    this.channel.notification({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    const listed = await this.channel.request("tools/list", {}, false, this.startupMs);
    const tools = Array.isArray(listed.tools)
      ? listed.tools
        .map((item) => isProviderRecord(item) ? item.name : undefined)
        .filter((item): item is string => typeof item === "string")
        .sort()
      : [];
    if (tools.join("\0") !== [...SECOND_BRAIN_PROVIDER_TOOLS].sort().join("\0")) {
      throw this.error("SECOND_BRAIN_PROVIDER_TOOLSET_MISMATCH", "fatal");
    }
  }

  private async restart(): Promise<void> {
    const child = this.child;
    if (child) await this.terminate(child);
    this.child = undefined;
    await this.ensureStarted();
  }

  private request(
    method: SecondBrainProviderMethod,
    arguments_: Json,
    write: boolean,
  ): Promise<Json> {
    return this.channel.request(
      "tools/call",
      { name: method, arguments: arguments_ },
      write,
      write ? this.writeMs : this.readMs,
    );
  }

  private async terminate(child: ChildProcess): Promise<void> {
    this.channel.detach();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private error(
    code: string,
    disposition: "unavailable" | "uncertain" | "fatal",
    requestId?: string,
  ): SecondBrainTransportError {
    return new SecondBrainTransportError(code, disposition, {
      generation: 0,
      request_id: requestId,
    });
  }
}
