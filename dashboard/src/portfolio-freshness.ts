import {
  PORTFOLIO_LIVE_MS,
  PORTFOLIO_STALE_MS,
  type PortfolioOverview,
} from "../../src/dashboard/portfolio-contracts.js";

export class PortfolioFreshnessTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;

  schedule(portfolio: PortfolioOverview, refresh: () => void): void {
    this.clear();
    const transition = nextTransition(portfolio);
    if (transition === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      refresh();
    }, Math.max(0, transition - Date.now()));
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
      ? updatedAt + PORTFOLIO_LIVE_MS
      : host.freshness === "stale"
        ? updatedAt + PORTFOLIO_STALE_MS
        : undefined;
    if (transition !== undefined && (earliest === undefined || transition < earliest)) {
      earliest = transition;
    }
  }
  return earliest;
}
