import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TerminalMemoryError } from "./terminal-memory-validation.js";

export type PhoneGatewayConfig = Readonly<{
	host: "127.0.0.1";
	port: 4174;
	authority_url: "http://127.0.0.1:4173";
	tailnet_host: string;
	owner_login: string;
	funnel: false;
}>;
export type PhoneGatewayRequest = Readonly<{
	peer_address: string;
	host: string;
	origin: string;
	path: string;
	tailscale_user_login?: string;
	csrf?: string;
}>;
export type PhoneGatewayDecision = Readonly<{
	allowed: boolean;
	code:
		| "OK"
		| "GATEWAY_PEER_DENIED"
		| "GATEWAY_IDENTITY_DENIED"
		| "GATEWAY_HOST_DENIED"
		| "GATEWAY_ORIGIN_DENIED"
		| "GATEWAY_ROUTE_DENIED"
		| "GATEWAY_RATE_LIMITED"
		| "GATEWAY_CSRF_REQUIRED";
}>;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const SAFE_ROUTES = [/^\/api\/v1\/(health|overview|today|recommendations|decisions|sources|memory)(?:\/[^/]+)?$/];

export class PhoneGatewayPolicy {
	private readonly buckets = new Map<string, { started: number; count: number }>();
	readonly config: PhoneGatewayConfig;
	constructor(
		tailnetHost: string,
		ownerLogin: string,
		private readonly maxRequests = 60,
		private readonly windowMs = 60_000,
	) {
		if (!/^[A-Za-z0-9.-]{1,253}$/.test(tailnetHost) || ownerLogin.length === 0) throw new TerminalMemoryError("GATEWAY_CONFIG_INVALID");
		this.config = {
			host: "127.0.0.1",
			port: 4174,
			authority_url: "http://127.0.0.1:4173",
			tailnet_host: tailnetHost,
			owner_login: ownerLogin,
			funnel: false,
		};
	}

	authorize(input: PhoneGatewayRequest, now = Date.now()): PhoneGatewayDecision {
		if (!LOOPBACK.has(input.peer_address)) return { allowed: false, code: "GATEWAY_PEER_DENIED" };
		if (input.host !== this.config.tailnet_host) return { allowed: false, code: "GATEWAY_HOST_DENIED" };
		if (input.origin !== `https://${this.config.tailnet_host}`) return { allowed: false, code: "GATEWAY_ORIGIN_DENIED" };
		if (input.tailscale_user_login !== this.config.owner_login) return { allowed: false, code: "GATEWAY_IDENTITY_DENIED" };
		if (!SAFE_ROUTES.some((route) => route.test(input.path)) || /terminal|raw|stdout|stderr/i.test(input.path))
			return { allowed: false, code: "GATEWAY_ROUTE_DENIED" };
		const bucket = this.buckets.get(input.peer_address);
		const current = bucket === undefined || now - bucket.started >= this.windowMs ? { started: now, count: 0 } : bucket;
		current.count += 1;
		this.buckets.set(input.peer_address, current);
		if (current.count > this.maxRequests) return { allowed: false, code: "GATEWAY_RATE_LIMITED" };
		return { allowed: true, code: "OK" };
	}
}

export class PhoneSession {
	readonly session_id = `phone:${randomBytes(16).toString("hex")}`;
	private readonly csrfDigest: Buffer;
	constructor(csrfToken = randomBytes(32).toString("base64url")) {
		this.csrfDigest = createHash("sha256").update(csrfToken).digest();
		this.csrf_token = csrfToken;
	}
	readonly csrf_token: string;
	matches(candidate: string): boolean {
		const digest = createHash("sha256").update(candidate).digest();
		return timingSafeEqual(this.csrfDigest, digest);
	}
}

export function createPhoneGatewayPolicy(tailnetHost: string, ownerLogin: string): PhoneGatewayPolicy {
	return new PhoneGatewayPolicy(tailnetHost, ownerLogin);
}
