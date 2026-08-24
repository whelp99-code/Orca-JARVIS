import type { CrewMail, CrewMember } from "../../../../src/crews/types.js";

export function presentCrew(members: readonly CrewMember[], mail: readonly CrewMail[]): { readonly members: number; readonly mail: number } {
  return { members: members.length, mail: mail.length };
}
