import { PhoneSession } from "../phone-gateway.js";

export type PhoneSessionSnapshot = Readonly<{ session_id: string; csrf_token: string }>;

export function createPhoneSession(): Readonly<{ snapshot(): PhoneSessionSnapshot; matchesCsrf(candidate: string): boolean }> {
  const session = new PhoneSession();
  return {
    snapshot: () => ({ session_id: session.session_id, csrf_token: session.csrf_token }),
    matchesCsrf: (candidate: string) => session.matches(candidate),
  };
}
