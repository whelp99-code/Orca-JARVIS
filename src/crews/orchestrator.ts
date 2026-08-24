import type { CommandIntent } from "../control-protocol.js";
import { JarvisError } from "../db.js";
import { CrewBudgetTracker } from "./budget.js";
import { CrewMailbox } from "./mail.js";
import type { CrewStore } from "./store.js";
import type { CrewBudget, CrewMail } from "./types.js";

export class CrewOrchestrator {
  readonly mailbox = new CrewMailbox();
  readonly budget: CrewBudgetTracker;
  private intents = 0;
  constructor(private readonly store: CrewStore, limits: CrewBudget) {
    this.budget = new CrewBudgetTracker(limits);
  }

  post(mail: CrewMail): void {
    if (!this.store.list().some(member => member.id === mail.from || member.id === mail.to)) {
      throw new JarvisError("CREW_MEMBER_UNKNOWN");
    }
    this.budget.charge({ tokens: 1, toolCalls: 1 });
    this.mailbox.send(mail);
  }

  proposeIntent(from: string, intent: CommandIntent): CommandIntent {
    this.budget.charge({ tokens: 1 });
    if (from === "jarvis") throw new JarvisError("CREW_CANNOT_MINT_RECEIPT");
    this.intents += 1;
    return intent;
  }

  get intentCount(): number {
    return this.intents;
  }
}
