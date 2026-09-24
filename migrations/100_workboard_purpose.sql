-- Project purpose history is separate from untrusted observation and existing action authority.
CREATE TABLE IF NOT EXISTS workboard_purposes (
 project_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), text TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind = 'owner'), source_ref TEXT NOT NULL,
 PRIMARY KEY(project_id,version)
);
CREATE TABLE IF NOT EXISTS workboard_purpose_candidates (
 project_id TEXT NOT NULL, text TEXT NOT NULL, source_kind TEXT NOT NULL
 CHECK(source_kind IN ('explicit_request','agent_summary')), source_ref TEXT NOT NULL,
 PRIMARY KEY(project_id,source_kind,source_ref)
);
CREATE TABLE IF NOT EXISTS workboard_purpose_bindings (
 work_id TEXT PRIMARY KEY REFERENCES workboard_works(work_id), project_id TEXT NOT NULL,
 why TEXT NOT NULL, evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('owner','explicit_request','agent_summary')),
 evidence_ref TEXT NOT NULL, purpose_version INTEGER, work_spec_revision TEXT NOT NULL,
 FOREIGN KEY(project_id,purpose_version) REFERENCES workboard_purposes(project_id,version)
);
