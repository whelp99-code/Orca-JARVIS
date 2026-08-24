import type { CrewMember } from "./types.js";

export class CrewStore {
  private readonly members = new Map<string, CrewMember>();

  add(member: CrewMember): void {
    this.members.set(member.id, member);
  }

  list(): readonly CrewMember[] {
    return [...this.members.values()];
  }
}
