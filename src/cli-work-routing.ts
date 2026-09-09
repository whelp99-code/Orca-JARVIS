import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { JarvisError } from "./db.js";
import { classifyWorkRouting } from "./work-routing.js";
import { inspectTaskExecutorPlan } from "./task-executor-plan.js";
import { parseBoundedStrictJson } from "./strict-json.js";
import { compileTaskTemplate } from "./task-templates.js";

async function readJson(path: string, maximum: number): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > maximum) throw new Error("invalid");
      const bytes = Buffer.alloc(maximum + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await file.read(bytes, count, bytes.length - count, count);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
      }
      if (count > maximum) throw new Error("invalid");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
      const value = parseBoundedStrictJson(text, { depth: 32, nodes: 8192, workItems: 32768, characters: maximum });
      if (value === undefined) throw new Error("invalid");
      return value;
    } finally { await file.close(); }
  } catch { throw new JarvisError("WORK_ROUTING_INPUT_INVALID"); }
}

export async function executeWorkRouting(requestPath: string, policyPath: string): Promise<Record<string, unknown>> {
  const request = await readJson(requestPath, 8192);
  const policy = await readJson(policyPath, 65536);
  return { ok: true, command: "routing.classify", routing: classifyWorkRouting(request, policy) };
}

export async function readWorkRoutingPolicy(path: string): Promise<unknown> {
  const policy = await readJson(path, 65536);
  classifyWorkRouting({ schema_version: 1, objective: "policy validation" }, policy);
  return policy;
}

export async function executeExecutorPlanValidation(id: string, path: string): Promise<Record<string, unknown>> {
  const plan = await readJson(path, 4 * 1024 * 1024);
  return { ok: true, command: "routing.validate-plan", validation: inspectTaskExecutorPlan(id, plan) };
}

export async function executeTaskTemplateCompilation(path: string): Promise<Record<string, unknown>> {
  return { ok: true, command: "routing.compile-template", ...compileTaskTemplate(await readJson(path, 65536)) };
}
