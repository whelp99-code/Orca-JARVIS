import { AuthorityDbBase, JarvisError, json, same, sha, timestamp, type Row } from "./authority-db-base.js";

export abstract class GjcConfigurationAuthorityDb extends AuthorityDbBase {
	/** The GJC configuration is usable only when its immutable audit revision still binds it exactly. */
	configureGjc(
		canonicalCwd: string,
		sessionId: string,
		enabled: boolean,
		registrationReceipt: unknown = {},
		now = timestamp(),
		serverInfo: { name: string; version: string } = { name: "gjc-coordinator-mcp", version: "0.11.8" },
	): { revision: number; config_digest: string } {
		if (!canonicalCwd || !sessionId) throw new JarvisError("GJC_CONFIG_INVALID");
		const config_digest = sha({
			canonical_cwd: canonicalCwd,
			session_id: sessionId,
			profile: "jarvis",
			repo: "Orca-JARVIS",
			enabled,
		});
		return this.atomic(() => {
			const inserted = this.db
				.prepare(
					"INSERT INTO gjc_runtime_config_audit(canonical_cwd,session_id,profile,repo,enabled,config_digest,created_at) VALUES(?,?,?,?,?,?,?)",
				)
				.run(canonicalCwd, sessionId, "jarvis", "Orca-JARVIS", enabled ? 1 : 0, config_digest, now);
			const revision = Number(inserted.lastInsertRowid);
			this.db
				.prepare(
					`INSERT INTO
					gjc_runtime_config(id,canonical_cwd,session_id,profile,repo,enabled,revision,config_digest,registration_receipt_json,updated_at,server_name,server_version)
					VALUES(1,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
					canonical_cwd=excluded.canonical_cwd,session_id=excluded.session_id,profile=excluded.profile,
					repo=excluded.repo,enabled=excluded.enabled,revision=excluded.revision,
					config_digest=excluded.config_digest,registration_receipt_json=excluded.registration_receipt_json,
					updated_at=excluded.updated_at,server_name=excluded.server_name,
					server_version=excluded.server_version`,
				)
				.run(
					canonicalCwd,
					sessionId,
					"jarvis",
					"Orca-JARVIS",
					enabled ? 1 : 0,
					revision,
					config_digest,
					json(registrationReceipt),
					now,
					serverInfo.name,
					serverInfo.version,
				);
			return { revision, config_digest };
		});
	}
	gjcConfig(): Record<string, unknown> | null {
		const row = this.db
			.prepare(
				`SELECT
				c.canonical_cwd,c.session_id,c.profile,c.repo,c.enabled,c.revision,c.config_digest,c.registration_receipt_json,c.updated_at,c.server_name,c.server_version
				FROM gjc_runtime_config c JOIN gjc_runtime_config_audit a ON a.revision=c.revision AND
				a.canonical_cwd=c.canonical_cwd AND a.session_id=c.session_id AND a.profile=c.profile AND
				a.repo=c.repo AND a.enabled=c.enabled AND a.config_digest=c.config_digest WHERE c.id=1`,
			)
			.get() as Row | undefined;
		return row
			? {
					...row,
					enabled: Boolean(row.enabled),
					operational:
						Boolean(row.enabled) &&
						row.server_name === "gjc-coordinator-mcp" &&
						typeof row.server_version === "string" &&
						/^0\.11\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(row.server_version),
				}
			: null;
	}
	gjcOperational(): boolean {
		const config = this.gjcConfig();
		return Boolean(config?.operational);
	}
	claimGjcRuntimeLease(owner: string, now = timestamp(), leaseMs = 60_000): number | null {
		if (!owner || leaseMs < 1) throw new JarvisError("GJC_LEASE_INVALID");
		return this.atomic(() => {
			const row = this.db.prepare("SELECT * FROM gjc_runtime_leases WHERE id=1").get() as Row | undefined;
			if (row && String(row.expires_at) > now) return null;
			const fence = Number(row?.fence ?? 0) + 1;
			const expires = new Date(Date.parse(now) + leaseMs).toISOString();
			this.db
				.prepare(
					`INSERT INTO gjc_runtime_leases(id,owner,fence,expires_at,heartbeat_at) VALUES(1,?,?,?,?) ON
					CONFLICT(id) DO UPDATE SET
					owner=excluded.owner,fence=excluded.fence,expires_at=excluded.expires_at,heartbeat_at=excluded.heartbeat_at`,
				)
				.run(owner, fence, expires, now);
			return fence;
		});
	}
	heartbeatGjcRuntimeLease(owner: string, fence: number, now = timestamp(), leaseMs = 60_000): void {
		const expires = new Date(Date.parse(now) + leaseMs).toISOString();
		const changed = this.db
			.prepare(
				"UPDATE gjc_runtime_leases SET expires_at=?,heartbeat_at=? WHERE id=1 AND owner=? AND fence=? AND expires_at>?",
			)
			.run(expires, now, owner, fence, now);
		if (changed.changes !== 1) throw new JarvisError("GJC_STALE_LEASE");
	}
	releaseGjcRuntimeLease(owner: string, fence: number, now = timestamp()): void {
		if (!Number.isFinite(Date.parse(now))) throw new JarvisError("GJC_LEASE_INVALID");
		this.db.prepare(
			"UPDATE gjc_runtime_leases SET expires_at=MIN(expires_at,?) WHERE id=1 AND owner=? AND fence=?",
		).run(now, owner, fence);
	}
	recordGjcRuntimeStatus(errorCode: string | null, now = timestamp()): void {
		this.db
			.prepare(
				`INSERT INTO gjc_runtime_status(id,pid,last_heartbeat_at,last_error_code,updated_at)
				VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
				pid=excluded.pid,last_heartbeat_at=excluded.last_heartbeat_at,last_error_code=excluded.last_error_code,updated_at=excluded.updated_at`,
			)
			.run(process.pid, now, errorCode, now);
	}
	createGjcDispatchFromContinuation(
		continuationId: string,
		payload: Record<string, unknown>,
		idempotencyKey: string,
		now = timestamp(),
	): string {
		const config = this.gjcConfig();
		if (!config?.operational || payload.cwd !== config.canonical_cwd || payload.session_id !== config.session_id)
			throw new JarvisError("GJC_DISPATCH_NOT_AUTHORIZED");
		const row = this.db
			.prepare(
				"SELECT c.id,c.authority_expires_at,w.state FROM continuation_acceptances c JOIN work_items w ON w.id=c.work_id WHERE c.id=?",
			)
			.get(continuationId) as Row | undefined;
		if (!row || row.state !== "continued" || String(row.authority_expires_at) <= now)
			throw new JarvisError("GJC_DISPATCH_NOT_AUTHORIZED");
		return this.createGjcIntent(
			"dispatch",
			{ ...payload, continuation_id: continuationId },
			idempotencyKey,
			continuationId,
			now,
		);
	}
	assertGjcDispatchTask(task: Record<string, unknown>, now = timestamp()): void {
		const required = [
			"action",
			"baseline",
			"budget",
			"budget_digest",
			"census_snapshot_hash",
			"continuation_id",
			"cwd",
			"expiry",
			"fencing_token",
			"forbidden_actions",
			"forbidden_digest",
			"idempotency_key",
			"lease_epoch",
			"policy_hash",
			"scope",
			"scope_digest",
			"session_id",
		].sort();
		if (
			Object.keys(task).sort().join(",") !== required.join(",") ||
			typeof task.continuation_id !== "string" ||
			typeof task.idempotency_key !== "string"
		)
			throw new JarvisError("GJC_DISPATCH_SCHEMA_INVALID");
		const config = this.gjcConfig();
		if (!config?.operational || task.cwd !== config.canonical_cwd || task.session_id !== config.session_id)
			throw new JarvisError("GJC_DISPATCH_NOT_AUTHORIZED");
		const row = this.db
			.prepare(
				"SELECT c.id,c.authority_expires_at,w.state FROM continuation_acceptances c JOIN work_items w ON w.id=c.work_id WHERE c.id=?",
			)
			.get(task.continuation_id) as Row | undefined;
		if (!row || row.state !== "continued" || String(row.authority_expires_at) <= now)
			throw new JarvisError("GJC_DISPATCH_NOT_AUTHORIZED");
		const full = this.db
			.prepare(
				`SELECT c.*,w.*,s.digest AS snapshot_digest FROM continuation_acceptances c JOIN work_items w ON
				w.id=c.work_id JOIN census_snapshots s ON s.id=w.snapshot_id WHERE c.id=?`,
			)
			.get(task.continuation_id) as Row | undefined;
		if (
			!full ||
			task.action !== full.action ||
			task.baseline !== full.baseline ||
			task.policy_hash !== full.policy_hash ||
			task.census_snapshot_hash !== full.snapshot_digest ||
			task.expiry !== full.authority_expires_at ||
			task.lease_epoch !== full.lease_epoch ||
			task.fencing_token !== full.fencing_token ||
			task.scope_digest !== full.scope_digest ||
			task.forbidden_digest !== full.forbidden_digest ||
			task.budget_digest !== full.budget_digest ||
			!same(task.scope, JSON.parse(String(full.scope_json))) ||
			!same(task.forbidden_actions, JSON.parse(String(full.forbidden_json))) ||
			!same(task.budget, JSON.parse(String(full.budget_json)))
		)
			throw new JarvisError("GJC_DISPATCH_NOT_AUTHORIZED");
	}

	createGjcDispatchFromTask(task: Record<string, unknown>, now = timestamp()): string {
		this.assertGjcDispatchTask(task, now);
		return this.createGjcDispatchFromContinuation(
			String(task.continuation_id),
			task,
			String(task.idempotency_key),
			now,
		);
	}
}
