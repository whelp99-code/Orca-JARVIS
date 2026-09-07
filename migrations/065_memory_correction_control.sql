-- No memory content or new authority: retain the digest-only schema3 command shape.
CREATE TABLE memory_correction_control_bindings (
  correction_id TEXT PRIMARY KEY REFERENCES memory_correction_requests(correction_id),
  target_json TEXT NOT NULL CHECK(json_valid(target_json)),
  args_json TEXT NOT NULL CHECK(json_valid(args_json))
);
CREATE TRIGGER memory_correction_control_binding_update BEFORE UPDATE ON memory_correction_control_bindings
BEGIN SELECT RAISE(ABORT,'immutable correction control binding'); END;
CREATE TRIGGER memory_correction_control_binding_delete BEFORE DELETE ON memory_correction_control_bindings
BEGIN SELECT RAISE(ABORT,'immutable correction control binding'); END;
CREATE TABLE memory_correction_control_cursor (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  last_updated_at TEXT NOT NULL,
  last_correction_id TEXT NOT NULL
);
