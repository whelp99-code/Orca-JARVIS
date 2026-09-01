import type { Database } from "better-sqlite3";
import type { AuthorityDb } from "./db.js";
import type { GjcCoordinatorClient } from "./gjc.js";
import { RetentionRuntime, type RetentionAdapterMap } from "./personal-os-retention.js";
import { GjcRuntimeService } from "./service.js";

export class PersonalOsRuntime {
  readonly owner = "PersonalOsRuntime/RetentionRuntime" as const;
  readonly retention: RetentionRuntime;
  readonly now: () => Date;
  readonly gjcService: GjcRuntimeService | undefined;

  constructor(input: {
    readonly db: Database;
    readonly now: () => Date;
    readonly adapters?: RetentionAdapterMap;
    readonly gjcService?: GjcRuntimeService;
  }) {
    this.now = input.now;
    this.retention = new RetentionRuntime(input.db, this.owner, input.adapters ?? {});
    this.gjcService = input.gjcService;
  }

  static forServiceRun(input: {
    readonly authority: AuthorityDb;
    readonly coordinator: GjcCoordinatorClient;
    readonly worker: string;
    readonly supervisorCycle?: () => Promise<unknown>;
    readonly clock: () => Date;
  }): { readonly runtime: PersonalOsRuntime; readonly service: GjcRuntimeService } {
    const service = new GjcRuntimeService(
      input.authority,
      input.coordinator,
      input.worker,
      input.supervisorCycle,
      input.clock,
    );
    return {
      runtime: new PersonalOsRuntime({
        db: input.authority.db,
        now: input.clock,
        gjcService: service,
      }),
      service,
    };
  }
}
