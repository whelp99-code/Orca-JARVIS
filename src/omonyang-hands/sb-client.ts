import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type SbTool = "sb_remember" | "sb_search" | "sb_read_page";

export type SbMcp = {
  call(tool: SbTool, args: Record<string, unknown>): Promise<unknown>;
};

/** Speaks Second Brain's MCP. Does not write vault files itself. */
export class StdioSbMcp implements SbMcp {
  private client: Client | undefined;

  constructor(private readonly command: string, private readonly args: readonly string[]) {}

  async call(tool: SbTool, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.connect();
    const result = await client.callTool({ name: tool, arguments: args });
    const text = textOf(result.content);
    if (text === undefined) return result;
    try { return JSON.parse(text) as unknown; } catch { return text; }
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: "omonyang-hands", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: this.command, args: [...this.args] }));
    this.client = client;
    return client;
  }
}

function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : undefined;
}
