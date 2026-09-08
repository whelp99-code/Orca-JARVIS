import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { JarvisError } from "./db.js";
import { commandNow, type CliCommandContext } from "./cli-command-context.js";
import { MemoryCandidateStore } from "./memory-candidate-store.js";
import { MemoryCandidateError } from "./memory-candidate-types.js";
import { memoryCandidateSpoolRoots, bindMemoryCandidateSpools } from "./memory-outbox-production.js";
import { parseSecondBrainStrictJsonBytes } from "./second-brain-strict-json.js";
import { publishAutomaticMemoryCandidate } from "./memory-auto-publication.js";

const MAX_BYTES = 32_768;

/** Bounded, pinned input. CLI diagnostics never contain input bytes or paths. */
async function intakeFile(path: string): Promise<unknown> {
  try {
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const pinned = await file.stat();
      if (!pinned.isFile() || pinned.dev !== initial.dev || pinned.ino !== initial.ino
        || pinned.size < 1 || pinned.size > MAX_BYTES) throw new Error();
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      const after = await file.stat();
      if (length !== pinned.size || length > MAX_BYTES || after.size !== pinned.size
        || after.mtimeMs !== pinned.mtimeMs || after.ctimeMs !== pinned.ctimeMs) throw new Error();
      const value = parseSecondBrainStrictJsonBytes(buffer.subarray(0, length));
      if (value === undefined) throw new Error();
      return value;
    } finally { await file.close(); }
  } catch { throw new JarvisError("MEMORY_CANDIDATE_FILE_INVALID"); }
}

export async function executeMemoryIntake(context: CliCommandContext): Promise<Record<string, unknown>> {
  if (!context.argument || !context.fourth || context.fifth !== undefined) {
    throw new JarvisError("MEMORY_CANDIDATE_FILE_REQUIRED");
  }
  const [input, policy] = await Promise.all([intakeFile(context.argument), intakeFile(context.fourth)]);
  try {
    const store = new MemoryCandidateStore(context.db, policy, () => commandNow(context));
    const roots = memoryCandidateSpoolRoots(context.db.filename, context.dependencies.memoryOutboxOptions);
    store.attachReviewSpool(roots.candidate_review_spool_root);
    const candidate = store.classify(input);
    publishAutomaticMemoryCandidate(context.db, input, policy, roots, () => commandNow(context));
    // Register the same roots used by owner confirmation and the existing outbox.
    bindMemoryCandidateSpools(context.db, roots);
    return { ok: true, command: "memory.classify", candidate: {
      candidate_id: candidate.candidate_id, classification_digest: candidate.classification_digest,
      state: candidate.state, reason: candidate.classification_reason, input_class: candidate.input_class,
      required_confirmation: candidate.required_confirmation, delivery: candidate.delivery,
      confirmation_expires_at: candidate.confirmation_expires_at,
      candidate_expires_at: candidate.candidate_expires_at,
    }, stored: false };
  } catch (error) {
    if (error instanceof MemoryCandidateError) throw new JarvisError(error.code);
    throw new JarvisError("MEMORY_CANDIDATE_INTAKE_FAILED");
  }
}
