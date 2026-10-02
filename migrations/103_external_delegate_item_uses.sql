CREATE TABLE external_delegate_item_uses (
  receipt_id TEXT NOT NULL,
  item_digest TEXT NOT NULL,
  request_id TEXT NOT NULL,
  used_at TEXT NOT NULL,
  PRIMARY KEY (receipt_id, item_digest)
);
