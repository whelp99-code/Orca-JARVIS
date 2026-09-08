import {
  PORTFOLIO_LIVE_MS,
  PORTFOLIO_STALE_MS,
  type PortfolioOverview,
} from "../../src/dashboard/portfolio-contracts.js";

export class PortfolioFreshnessTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;

  schedule(portfolio: PortfolioOverview, refresh: () => void, additionalDelayMs?: number): void {
    this.clear();
    const transition = nextTransition(portfolio);
    const portfolioDelay = transition === undefined ? Infinity : transition - Date.now();
    const additionalDelay = additionalDelayMs !== undefined && Number.isFinite(additionalDelayMs) ? additionalDelayMs : Infinity;
    const remaining = Math.min(portfolioDelay, additionalDelay);
    if (!Number.isFinite(remaining)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      refresh();
    }, remaining > 0 ? Math.min(remaining, 2_147_483_647) : 1_000);
  }

  clear(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function nextTransition(portfolio: PortfolioOverview): number | undefined {
  let earliest: number | undefined;
  for (const host of portfolio.hosts) {
    if (host.updated_at === null) continue;
    const updatedAt = Date.parse(host.updated_at);
    if (!Number.isFinite(updatedAt)) continue;
    const transition = host.freshness === "live"
      ? updatedAt + PORTFOLIO_LIVE_MS + 1
      : host.freshness === "stale"
        ? updatedAt + PORTFOLIO_STALE_MS + 1
        : undefined;
    if (transition !== undefined && (earliest === undefined || transition < earliest)) {
      earliest = transition;
    }
  }
  return earliest;
}
