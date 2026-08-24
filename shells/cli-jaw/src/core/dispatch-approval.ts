import { ShellApprovalStore, type ApprovalCallback, type ShellApprovalRecord } from "../jarvis/approval-intent.js";

export class DispatchApprovalIngress {
  constructor(private readonly store: ShellApprovalStore) {}

  display(record: ShellApprovalRecord): ShellApprovalRecord {
    return this.store.present(record);
  }

  dispatch(callback: ApprovalCallback) {
    return this.store.resolveCallback(callback);
  }
}
