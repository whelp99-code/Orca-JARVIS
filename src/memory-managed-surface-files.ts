import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { canonicalize } from "./canonical.js";

export type FilesystemSurfaceScan = {
  readonly readable: boolean;
  readonly manifest_digest: string;
  readonly file_count: number;
  readonly object_count: number;
  readonly error_count: number;
  readonly omission_count: number;
  readonly scan_digest: string;
};

type FileObservation = {
  readonly locator: string;
  readonly digest: string;
  readonly bytes: number;
};

const digest = (value: Buffer | string): string => `sha256:${createHash("sha256")
  .update(value).digest("hex")}`;

export function scanFilesystemSurface(root: string): FilesystemSurfaceScan {
  if (!existsSync(root)) return failedScan("missing");
  const files: FileObservation[] = [];
  let errors = 0;
  const visit = (path: string): void => {
    try {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory()
        && (!metadata.isFile() || metadata.nlink !== 1))) {
        errors += 1;
        return;
      }
      if (metadata.isDirectory()) {
        for (const name of readdirSync(path).sort()) visit(join(path, name));
        return;
      }
      const bytes = readFileSync(path);
      files.push({ locator: digest(relative(root, path)), digest: digest(bytes),
        bytes: bytes.byteLength });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      errors += 1;
    }
  };
  visit(root);
  const body = { root: digest(root), files, errors };
  return { readable: errors === 0, manifest_digest: digest(canonicalize(files)),
    file_count: files.length, object_count: files.length, error_count: errors,
    omission_count: 0, scan_digest: digest(canonicalize(body)) };
}

function failedScan(reason: string): FilesystemSurfaceScan {
  const observed = digest(canonicalize({ reason }));
  return { readable: false, manifest_digest: observed, file_count: 0,
    object_count: 0, error_count: 1, omission_count: 1, scan_digest: observed };
}
