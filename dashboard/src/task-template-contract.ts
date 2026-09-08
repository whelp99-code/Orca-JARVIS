import type { TaskTemplateBinding, compileTaskTemplate } from "../../src/task-templates.js";
export type CompiledTaskTemplate = ReturnType<typeof compileTaskTemplate>;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const list = (v: unknown, max: number): v is any[] => Array.isArray(v) && v.length > 0 && v.length <= max;
export const TEMPLATE_LABELS: Readonly<Record<string, string>> = {
  "code-fix": "코드 수정", "incident-report": "장애 진단 보고서", "technical-review": "기술 검토",
};

/** Display/transport shape only; the server owns definition and authority validation. */
export function isTaskTemplateBinding(v: unknown): v is TaskTemplateBinding {
  return object(v) && v.schema_version === 1 && Object.hasOwn(TEMPLATE_LABELS, v.template_id) && v.revision === 1
    && typeof v.definition_digest === "string" && /^sha256:[a-f0-9]{64}$/.test(v.definition_digest)
    && list(v.files, 128) && v.files.every(file => object(file) && text(file.path) && ["read", "write"].includes(file.access))
    && list(v.verification, 8) && v.verification.every(check => object(check) && text(check.id) && text(check.cwd)
      && check.expected_exit === 0 && list(check.argv, 64) && check.argv.every(text));
}

export function parseCompiledTemplate(v: unknown): CompiledTaskTemplate | undefined {
  if (!object(v) || v.schema_version !== 1 || !object(v.compiled) || !isTaskTemplateBinding(v.compiled.task_template)) return undefined;
  const p = v.compiled.proposal_request;
  if (!object(p) || p.schema_version !== 1 || !text(p.objective) || !["development", "analysis"].includes(p.work_type)
    || !list(p.constraints, 3) || !p.constraints.every(text) || !list(p.completion_evidence, 3) || !p.completion_evidence.every(text)) return undefined;
  return v.compiled as CompiledTaskTemplate;
}
