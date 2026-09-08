/** Shared error identity without loading the authority database or persistence graph. */
export class JarvisError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}
