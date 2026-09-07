-- Content-free scheduling metadata. It carries no dispatch or completion authority.
CREATE TABLE memory_outbox_control_cursor (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  last_updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',last_updated_at)=last_updated_at),
  last_outbox_id TEXT NOT NULL
);
