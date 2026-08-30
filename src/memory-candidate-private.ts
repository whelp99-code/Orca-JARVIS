import { containsPrivateMetadata } from "./private-text.js";

const SECRET_ASSIGNMENT = /\b(?:password|passwd|secret|token|access_token|refresh_token|client_secret|api[_-]?key|authorization|cookie)\b\s*[:=]/iu;
const SECRET_AUTHORIZATION = /\bBearer\s+\S+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/iu;
const SECRET_TOKEN = /\b(?:sk-(?:proj-|live-|test-)?|gh[pousr]_|github_pat_|xox[baprs]-|AIza|glpat-|npm_|pypi-|hf_)[A-Za-z0-9_-]{12,}/iu;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/iu;
const PROMPT_ROLE = /(?:^|\n)\s*(?:system|assistant|developer|user)\s*:|<\/?(?:system|assistant|prompt)>/iu;
const PROMPT_OVERRIDE = /ignore\s+(?:all\s+|any\s+)?previous\s+instructions/iu;

export function containsMemorySecret(value: string): boolean {
  return SECRET_ASSIGNMENT.test(value) || SECRET_AUTHORIZATION.test(value) || SECRET_TOKEN.test(value)
    || PRIVATE_KEY.test(value) || containsPrivateMetadata(value);
}

export function containsMemoryPromptText(value: string): boolean {
  return PROMPT_ROLE.test(value) || PROMPT_OVERRIDE.test(value);
}
