import { JarvisError, type Row } from "./authority-db-base.js";
import { isRfc3339Millis } from "./progress.js";
import type { StoredProgressReport } from "./types.js";

import { ProgressAuthorityDb } from "./authority-progress-store.js";

export abstract class ProgressDeliveryAuthorityDb extends ProgressAuthorityDb {
	pendingProgressReport(): StoredProgressReport | undefined {
		try {
			const row = this.db
				.prepare(
					`SELECT o.sequence,o.report_id,o.worktree_selector,o.payload_json,o.payload_digest,o.created_at FROM
					progress_report_outbox o LEFT JOIN progress_delivery_receipts r ON r.report_id=o.report_id WHERE
					r.report_id IS NULL ORDER BY o.sequence LIMIT 1`,
				)
				.get() as Row | undefined;
			return row ? this.progressReport(row) : undefined;
		} catch (error) {
			if (error instanceof JarvisError) throw error;
			throw new JarvisError("PROGRESS_STORAGE_FAILED");
		}
	}
	markProgressDelivered(reportId: string, deliveredAt: string): void {
		if (!/^progress_[0-9a-f]{64}$/.test(reportId) || !isRfc3339Millis(deliveredAt))
			throw new JarvisError("PROGRESS_DELIVERY_MARK_FAILED");
		try {
			let inserted = false;
			this.atomic(() => {
				if (!this.db.prepare("SELECT 1 FROM progress_report_outbox WHERE report_id=?").get(reportId))
					throw new JarvisError("PROGRESS_DELIVERY_MARK_FAILED");
				const receipt = this.db
					.prepare("SELECT delivered_at FROM progress_delivery_receipts WHERE report_id=?")
					.get(reportId) as Row | undefined;
				if (receipt) {
					if (String(receipt.delivered_at) !== deliveredAt) throw new JarvisError("PROGRESS_DELIVERY_MARK_FAILED");
					return;
				}
				this.progressFault("before_receipt_insert");
				this.db
					.prepare("INSERT INTO progress_delivery_receipts(report_id,delivered_at) VALUES(?,?)")
					.run(reportId, deliveredAt);
				inserted = true;
				this.progressFault("after_receipt_insert_before_commit");
			});
			if (inserted) this.progressFault("after_receipt_commit");
		} catch (error) {
			if (error instanceof JarvisError) throw error;
			throw new JarvisError("PROGRESS_DELIVERY_MARK_FAILED");
		}
	}
}
