import { inspectFrozenSchemas } from "./second-brain-frozen.js";
import { parseSecondBrainStrictJson } from "./second-brain-strict-json.js";
import {
  loadSecondBrainContract,
  type SecondBrainDiagnostic,
} from "./second-brain-transport-contract.js";
import { SECOND_BRAIN_REQUIRED_TOOLS } from "./second-brain-readiness.js";

export type SecondBrainHandshakeFacts = {
  readonly protocol_version: string;
  readonly server_name: string;
  readonly server_version: string;
  readonly tools: readonly string[];
  readonly input_schemas_compatible: boolean;
  readonly output_schemas_compatible: boolean | null;
};

export function parseSecondBrainHandshakeFacts(text: string): SecondBrainHandshakeFacts | undefined {
  const value = parseSecondBrainStrictJson(text.trim());
  if (!record(value) || !exactKeys(value, ["initialize", "tools_list"])) return undefined;
  const initialize = recordValue(value.initialize);
  const toolsList = recordValue(value.tools_list);
  const server = initialize === undefined ? undefined : recordValue(initialize.serverInfo);
  const observed = toolsList?.tools;
  if (initialize === undefined || toolsList === undefined || server === undefined
    || typeof initialize.protocolVersion !== "string"
    || typeof server.name !== "string"
    || typeof server.version !== "string") return undefined;
  const inspection = inspectFrozenSchemas(observed, loadSecondBrainContract());
  const tools = toolNames(observed);
  if (!inspection.matches || tools === undefined) return undefined;
  return {
    protocol_version: initialize.protocolVersion,
    server_name: server.name,
    server_version: server.version,
    tools,
    input_schemas_compatible: true,
    output_schemas_compatible: outputSchemasPresent(observed) ? true : null,
  };
}

export function attestedSecondBrainHandshake(
  diagnostics: readonly SecondBrainDiagnostic[],
): SecondBrainHandshakeFacts | undefined {
  const started = [...diagnostics].reverse().find(item => item.code === "SECOND_BRAIN_STARTED");
  if (started?.protocol_version === undefined
    || started.server_name === undefined
    || started.server_version === undefined) return undefined;
  return {
    protocol_version: started.protocol_version,
    server_name: started.server_name,
    server_version: started.server_version,
    tools: SECOND_BRAIN_REQUIRED_TOOLS,
    input_schemas_compatible: true,
    output_schemas_compatible: null,
  };
}

function toolNames(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const item of value) {
    if (!record(item) || typeof item.name !== "string") return undefined;
    names.push(item.name);
  }
  return [...names].sort();
}

function outputSchemasPresent(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => record(item) && Object.hasOwn(item, "outputSchema"));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return record(value) ? value : undefined;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
