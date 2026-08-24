import { JarvisError } from "../db.js";
import type { CrewMail } from "./types.js";

const FORBIDDEN = ["receipt", "signature", "command_digest", "signingKey", "trustTier", "actionLevel"];

export function assertAdvisoryMail(mail: CrewMail): void {
  for (const key of FORBIDDEN) {
    if (key in mail.body) throw new JarvisError("CREW_MAIL_AUTHORITY_INJECTED");
  }
}

export class CrewMailbox {
  private readonly messages: CrewMail[] = [];

  send(mail: CrewMail): void {
    assertAdvisoryMail(mail);
    this.messages.push(mail);
  }

  thread(taskId: string): readonly CrewMail[] {
    return this.messages.filter(item => item.taskId === taskId);
  }
}
