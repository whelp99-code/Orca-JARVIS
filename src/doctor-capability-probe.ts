import { execFile } from "node:child_process";
import type { CapabilityFact, CapabilityProbe } from "./capabilities.js";
import { GJC_PROTOCOL_VERSION } from "./gjc.js";

type ProbeObservation = Awaited<ReturnType<CapabilityProbe["inspect"]>>;
export type CapabilityVersionRunner = (command: "codex" | "claude") => Promise<{ stdout: string; exitCode: number }>;
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const VERSION_TIMEOUT_MS = 1_500;
const VERSION_MAX_BYTES = 512;
const SHIPPED_VERSION = "0.1.0";
const closed = (evidence: string) => ({ ok: false, evidence });
const open = (evidence: string) => ({ ok: true, evidence });
const boundStdout = (value: string): string => {
	if (Buffer.byteLength(value, "utf8") <= VERSION_MAX_BYTES) return value;
	let next = value;
	while (next.length > 0 && Buffer.byteLength(next, "utf8") > VERSION_MAX_BYTES) next = next.slice(0, -1);
	return next;
};
async function defaultCapabilityVersionRunner(command: "codex" | "claude"): Promise<{ stdout: string; exitCode: number }> {
	return await new Promise((resolve) => {
		execFile(
			command,
			["--version"],
			{
				encoding: "utf8",
				timeout: VERSION_TIMEOUT_MS,
				maxBuffer: VERSION_MAX_BYTES,
				killSignal: "SIGKILL",
				windowsHide: true,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" },
			},
			(error, stdout) => {
				const output = boundStdout(typeof stdout === "string" ? stdout : "");
				if (!error) {
					resolve({ stdout: output, exitCode: 0 });
					return;
				}
				const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | number };
				if (err.code === "ENOENT") {
					resolve({ stdout: "", exitCode: 127 });
					return;
				}
				if (err.killed === true || err.signal === "SIGKILL") {
					resolve({ stdout: output, exitCode: 124 });
					return;
				}
				resolve({ stdout: output, exitCode: typeof err.code === "number" ? err.code : 1 });
			},
		);
	});
}
async function inspectExecutable(command: "codex" | "claude", runner: CapabilityVersionRunner): Promise<ProbeObservation["installed"]> {
	try {
		const result = await runner(command);
		if (result.exitCode === 124) return { ok: false, version: null, evidence: "probe_timeout" };
		if (result.exitCode === 127) return { ok: false, version: null, evidence: "missing_executable" };
		const version = result.stdout.match(VERSION)?.[0] ?? null;
		if (version === null) return { ok: false, version: null, evidence: result.exitCode === 0 ? "version_unparsed" : "missing_executable" };
		return { ok: true, version, evidence: "executable_present" };
	} catch {
		return { ok: false, version: null, evidence: "missing_executable" };
	}
}
function shipped(id: Exclude<CapabilityFact["id"], "codex" | "claude">): ProbeObservation {
	if (id === "orca_read")
		return {
			installed: { ok: true, version: null, evidence: "adapter_present" },
			configured: open("library_present"),
			protocol_compatible: { ok: true, protocol_version: GJC_PROTOCOL_VERSION, evidence: "protocol_compatible" },
			operational: open("library_present"),
			authorized: open("read_only"),
		};
	if (id === "gjc")
		return {
			installed: { ok: true, version: SHIPPED_VERSION, evidence: "client_present" },
			configured: open("client_present"),
			protocol_compatible: { ok: true, protocol_version: GJC_PROTOCOL_VERSION, evidence: "protocol_compatible" },
			operational: open("client_present"),
			authorized: closed("authority_unverified"),
		};
	return {
		installed: { ok: true, version: SHIPPED_VERSION, evidence: "adapter_present" },
		configured: open("library_present"),
		protocol_compatible: { ok: true, protocol_version: GJC_PROTOCOL_VERSION, evidence: "protocol_compatible" },
		operational: open("library_present"),
		authorized: closed("authority_unverified"),
	};
}
export function runtimeCapabilityProbe(runner: CapabilityVersionRunner = defaultCapabilityVersionRunner): CapabilityProbe {
	return {
		inspect: async (id) => {
			if (id === "codex" || id === "claude") {
				const installed = await inspectExecutable(id, runner);
				return {
					installed,
					configured: closed("configuration_unverified"),
					protocol_compatible: { ok: false, protocol_version: null, evidence: "protocol_unverified" },
					operational: closed("runtime_unverified"),
					authorized: closed("authority_unverified"),
				};
			}
			return shipped(id);
		},
	};
}
export function passiveCapabilityProbe(): CapabilityProbe {
	return runtimeCapabilityProbe(async () => ({ stdout: "", exitCode: 127 }));
}
