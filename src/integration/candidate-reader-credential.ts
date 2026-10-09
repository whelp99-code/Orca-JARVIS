import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { JarvisError } from "../jarvis-error.js";

/** Existing operator-issued credentials only; never copy, issue, log or rotate them. */
export function readCandidateCredential(path: string): string {
  try {
    if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) {
      throw new JarvisError("CANDIDATE_READER_CREDENTIAL_INVALID");
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600
        || info.size === 0 || info.size > 65_536) {
        throw new JarvisError("CANDIDATE_READER_CREDENTIAL_INVALID");
      }
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new JarvisError("CANDIDATE_READER_CREDENTIAL_INVALID");
  }
}
