import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PhoneGatewayPolicy } from "./phone-gateway.js";

export type PhoneGatewayServerOptions = Readonly<{
	tailnet_host: string;
	owner_login: string;
	authority_url?: string;
	port?: number;
}>;

function send(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
	});
	response.end(payload);
}

export function createPhoneGatewayServer(options: PhoneGatewayServerOptions) {
	const policy = new PhoneGatewayPolicy(options.tailnet_host, options.owner_login);
	const authority = options.authority_url ?? policy.config.authority_url;
	return createServer(async (request: IncomingMessage, response: ServerResponse) => {
		const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		const decision = policy.authorize({
			peer_address: request.socket.remoteAddress ?? "",
			host: String(request.headers.host ?? ""),
			origin: String(request.headers.origin ?? ""),
			path,
			tailscale_user_login: typeof request.headers["tailscale-user-login"] === "string" ? request.headers["tailscale-user-login"] : undefined,
		});
		if (!decision.allowed) {
			send(response, decision.code === "GATEWAY_RATE_LIMITED" ? 429 : 403, {
				error: { code: decision.code },
			});
			return;
		}
		if (request.method !== "GET") {
			send(response, 405, { error: { code: "GATEWAY_READ_ONLY" } });
			return;
		}
		try {
			const upstream = await fetch(`${authority}${path}`, {
				method: "GET",
				headers: { accept: "application/json" },
			});
			const body = await upstream.text();
			if (Buffer.byteLength(body, "utf8") > 256 * 1024) {
				send(response, 502, { error: { code: "GATEWAY_RESPONSE_LIMIT" } });
				return;
			}
			response.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") ?? "application/json",
				"content-length": Buffer.byteLength(body),
			});
			response.end(body);
		} catch {
			send(response, 502, {
				error: { code: "GATEWAY_AUTHORITY_UNAVAILABLE" },
			});
		}
	});
}

export function startPhoneGateway(options: PhoneGatewayServerOptions): Server {
	const server = createPhoneGatewayServer(options);
	server.listen(options.port ?? 4174, "127.0.0.1");
	return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const host = process.env.JARVIS_PHONE_GATEWAY_HOST;
	const owner = process.env.JARVIS_PHONE_OWNER_LOGIN;
	if (!host || !owner) throw new Error("JARVIS_PHONE_GATEWAY_CONFIG_REQUIRED");
	startPhoneGateway({ tailnet_host: host, owner_login: owner });
}
