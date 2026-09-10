-- Durable collection cycle fence for the opt-in local timeline refresh service.
-- The previous throttle lived in process memory, so a restart or a duplicate start
-- collected again at the same instant and replaced every cached collection. Storage
-- growth followed from that, because each replacement collection admits as a new
-- immutable observation. One row; the cycle claim and its advance share one write.
CREATE TABLE local_timeline_cycle_fence (
  fence_id INTEGER PRIMARY KEY CHECK(fence_id=1),
  next_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',next_at)=next_at),
  claimed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at)=claimed_at),
  CHECK(julianday(claimed_at)<julianday(next_at))
);
