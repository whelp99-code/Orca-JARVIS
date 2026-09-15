/** Worker identity and lease arithmetic shared by the GJC send and intent layers. */
export const DISPATCH_LEASE_MS = 60_000;

export function gjcWorkerId(): string {
	return `pid:${process.pid}`;
}

export function gjcWorkerAlive(owner: unknown): boolean {
	if (typeof owner !== "string" || !owner.startsWith("pid:")) return false;
	const pid = Number(owner.slice(4));
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function leaseExpiry(now: string): string {
	return new Date(Date.parse(now) + DISPATCH_LEASE_MS).toISOString();
}
