import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { JarvisError, timestamp, type Row } from "./authority-db-base.js";
import { ProgressDeliveryAuthorityDb } from "./authority-progress-delivery-store.js";
import type { OrcaObservationDelta, OrcaObservationSource } from "./types.js";

export abstract class InitializationAuthorityDb extends ProgressDeliveryAuthorityDb {
	recordOrcaObservations(
		source: OrcaObservationSource,
		deltas: OrcaObservationDelta[],
	): { inserted: number; replayed: number } {
		return this.orcaObservations.record(source, deltas);
	}
	async initialize(
		anchors: {
			decision?: { keyId: string; principal: string; publicKeyPath: string };
			verifier?: { keyId: string; principal: string; publicKeyPath: string };
		} = {},
	): Promise<void> {
		await this.migrate();
		const decision = anchors.decision;
		const verifier = anchors.verifier;
		if (!decision || !verifier) throw new JarvisError("ANCHORS_REQUIRED");
		const sealed = this.db.prepare("SELECT 1 FROM authority_configuration WHERE id=1").get();
		if (sealed) {
			await this.assertExactAnchor(decision, "decision");
			await this.assertExactAnchor(verifier, "verifier");
			await this.ensurePolicyKey();
			return;
		}
		await this.registerPublicAnchor(decision, "decision");
		await this.registerPublicAnchor(verifier, "verifier");
		await this.ensurePolicyKey();
		this.atomic(() => {
			this.db.prepare("INSERT INTO authority_configuration(id,sealed_at) VALUES(1,?)").run(timestamp());
			this.audit("authority_sealed", "authority", { decision_key_id: decision.keyId, verifier_key_id: verifier.keyId });
		});
	}
	protected async assertExactAnchor(
		anchor: { keyId: string; principal: string; publicKeyPath: string },
		purpose: "decision" | "verifier",
	): Promise<void> {
		const pem = createPublicKey(await readFile(anchor.publicKeyPath, "utf8"))
			.export({ type: "spki", format: "pem" })
			.toString();
		const existing = this.db
			.prepare(
				"SELECT k.public_key_pem,k.principal_id,p.purpose FROM trusted_authority_keys k JOIN authority_key_purposes p ON p.key_id=k.key_id WHERE k.key_id=?",
			)
			.get(anchor.keyId) as Row | undefined;
		if (
			!existing ||
			existing.public_key_pem !== pem ||
			existing.principal_id !== anchor.principal ||
			existing.purpose !== purpose
		)
			throw new JarvisError("ANCHOR_SEALED_MISMATCH");
	}
	protected async registerPublicAnchor(
		anchor: { keyId: string; principal: string; publicKeyPath: string },
		purpose: "decision" | "verifier",
	): Promise<void> {
		const pem = await readFile(anchor.publicKeyPath, "utf8");
		const publicPem = createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
		const existing = this.db
			.prepare("SELECT public_key_pem,principal_id FROM trusted_authority_keys WHERE key_id=?")
			.get(anchor.keyId) as Row | undefined;
		if (existing && (existing.public_key_pem !== publicPem || existing.principal_id !== anchor.principal))
			throw new JarvisError("KEY_REGISTRY_MISMATCH");
		if (!existing)
			this.db
				.prepare(
					"INSERT INTO trusted_authority_keys(key_id,principal_id,algorithm,public_key_pem,created_at) VALUES(?,?,?,?,?)",
				)
				.run(anchor.keyId, anchor.principal, "Ed25519", publicPem, timestamp());
		const mapped = this.db.prepare("SELECT purpose FROM authority_key_purposes WHERE key_id=?").get(anchor.keyId) as
			| Row
			| undefined;
		if (!mapped)
			this.db
				.prepare("INSERT INTO authority_key_purposes(key_id,purpose,created_at) VALUES(?,?,?)")
				.run(anchor.keyId, purpose, timestamp());
		if (mapped && mapped.purpose !== purpose) throw new JarvisError("KEY_PURPOSE_MISMATCH");
	}
	protected async ensurePolicyKey(): Promise<void> {
		const path = `${this.filename}.policy-key.pem`;
		let privatePem: string;
		let publicPem: string;
		try {
			privatePem = await readFile(path, "utf8");
			publicPem = createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString();
			await chmod(path, 0o600);
		} catch {
			const pair = generateKeyPairSync("ed25519");
			privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
			publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
			await writeFile(path, privatePem, { mode: 0o600, flag: "wx" });
		}
		const existing = this.db
			.prepare("SELECT public_key_pem FROM trusted_authority_keys WHERE key_id='local-policy-key'")
			.get() as Row | undefined;
		if (existing && existing.public_key_pem !== publicPem) throw new JarvisError("KEY_REGISTRY_MISMATCH");
		if (!existing)
			this.db
				.prepare(
					"INSERT INTO trusted_authority_keys(key_id,principal_id,algorithm,public_key_pem,created_at) VALUES(?,?,?,?,?)",
				)
				.run("local-policy-key", "shadow-policy", "Ed25519", publicPem, timestamp());
		const mapped = this.db
			.prepare("SELECT purpose FROM authority_key_purposes WHERE key_id='local-policy-key'")
			.get() as Row | undefined;
		if (!mapped)
			this.db
				.prepare("INSERT INTO authority_key_purposes(key_id,purpose,created_at) VALUES(?,?,?)")
				.run("local-policy-key", "policy", timestamp());
		if (mapped && mapped.purpose !== "policy") throw new JarvisError("KEY_PURPOSE_MISMATCH");
	}
}
