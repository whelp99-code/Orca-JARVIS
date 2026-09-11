-- Durable retention cycle fence, matching the collection fence beside it.
-- A rebuild is expensive and replaces the authority database, so a restart, a duplicate start or
-- a clock that jumped must not start a second one inside the window. One row; the claim and its
-- advance share one write, and a claim that loses the compare leaves the window untouched.
-- A clock that moved backwards therefore defers instead of claiming, and a long outage collapses
-- its missed windows into the single next run rather than a catch-up burst.
CREATE TABLE local_retention_cycle_fence (
  fence_id INTEGER PRIMARY KEY CHECK(fence_id=1),
  next_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',next_at)=next_at),
  claimed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at)=claimed_at),
  CHECK(julianday(claimed_at)<julianday(next_at))
);
