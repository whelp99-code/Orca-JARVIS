import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sessionKey, sourceKey, workKey, type Source } from "../../src/workboard/contracts.js";

/**
 * Test-only workboard rows. Never applied to a production authority database: the vitest page test
 * seeds an in-memory database and the screenshot preview seeds the isolated e2e fixture database.
 */
export const WORKBOARD_FIXTURE_NOW = new Date("2026-09-24T09:00:00.000Z");
const minutesAgo = (minutes: number): string => new Date(WORKBOARD_FIXTURE_NOW.getTime() - minutes * 60_000).toISOString();
const minutesAhead = (minutes: number): string => new Date(WORKBOARD_FIXTURE_NOW.getTime() + minutes * 60_000).toISOString();

// Identifiers that must never appear in the default render, only behind the evidence disclosure.
export const WORKBOARD_SOURCE: Source = { host: "jm-workstation", app: "orca", scope: "orca-jarvis/purpose-workboard", generation: "boot-7f3a-PID-4242" };
export const WORKBOARD_SOURCE_KEY = sourceKey(WORKBOARD_SOURCE);
export const WORKBOARD_IDS = {
  sessionA: "term_a1b2c3",
  sessionB: "term_d4e5f6",
  sessionC: "term_777777",
  sessionD: "term_9z9z9z",
  digestA: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  digestB: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  digestC: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  digestD: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
} as const;
export const WORKBOARD_TEXT = {
  whyA: "결제 장애를 막기 위한 배포 준비",
  whatA: "배포 전 마이그레이션 실행 여부 결정 대기",
  decisionA: "운영 DB에 마이그레이션 101을 지금 적용할까요?",
  purposeJarvis: "JARVIS를 하루 안에 믿고 쓸 수 있는 개인 비서로 만든다",
  whyB: "목적 우선 워크보드를 오늘 보여주기 위해",
  whatB: "워크보드 UI 스크린샷 검증 진행 중",
  whatC: "테스트 러너가 포트 충돌로 멈춤",
  blockC: "4174 포트를 다른 프로세스가 사용 중",
  purposeBrain: "기억 검색을 한국어로 정확하게",
  whyD: "한국어 기억 검색 정확도",
  whatD: "기억 검색 한국어 형태소 처리 완료 주장",
} as const;

// Same cwd-relative convention as WorkboardStore/PurposeStore; test runners and the preview start at the repo root.
const migration = (name: string): string => readFileSync(resolve("migrations", name), "utf8");

type WorkSeed = {
  session: string; task: string | null; state: string; summary: string; digest: string; at: string;
  attention?: Partial<Record<"attempt_execution" | "wait_kind" | "wait_reason" | "wait_started_at" | "deadline_at" | "last_progress_received_at", string>>
    & { impact?: number; decision_valid?: 0 | 1 };
};

function seedWork(db: Database.Database, seed: WorkSeed): string {
  const session = sessionKey(WORKBOARD_SOURCE, seed.session);
  const attempt = JSON.stringify([session, "incarnation-1"]);
  const work = workKey(session, seed.task);
  db.prepare("INSERT OR IGNORE INTO workboard_sessions(session_key,source_key,session_id,alias_of) VALUES(?,?,?,NULL)").run(session, WORKBOARD_SOURCE_KEY, seed.session);
  db.prepare("INSERT OR IGNORE INTO workboard_attempts(attempt_key,session_key,incarnation) VALUES(?,?,?)").run(attempt, session, "incarnation-1");
  db.prepare(`INSERT INTO workboard_works(work_id,session_key,session_id,task_id,parent_work_id,source_key,sequence,state,summary,evidence_ref,source_at,received_at,attempt_key)
    VALUES(?,?,?,?,NULL,?,1,?,?,?,?,?,?)`).run(work, session, seed.session, seed.task, WORKBOARD_SOURCE_KEY, seed.state, seed.summary, seed.digest, seed.at, seed.at, attempt);
  const a = seed.attention ?? {};
  db.prepare(`INSERT INTO workboard_attention(work_id,sequence,last_progress_received_at,attempt_execution,action_delivery,wait_kind,wait_reason,wait_started_at,deadline_at,impact,decision_valid)
    VALUES(?,1,?,?,'none',?,?,?,?,?,?)`).run(work, a.last_progress_received_at ?? null, a.attempt_execution ?? "unknown", a.wait_kind ?? null,
    a.wait_reason ?? null, a.wait_started_at ?? null, a.deadline_at ?? null, a.impact ?? null, a.decision_valid ?? 0);
  return work;
}

/** Applies the three workboard migrations on this connection and inserts four works across three purposes. */
export function seedWorkboardFixture(db: Database.Database): void {
  db.exec(migration("099_workboard_projection.sql"));
  db.exec(migration("100_workboard_purpose.sql"));
  db.exec(migration("101_workboard_attention.sql"));
  const ids = WORKBOARD_IDS;
  const t = WORKBOARD_TEXT;
  db.prepare("INSERT INTO workboard_sources(source_key,coverage,warning,last_successful_observation) VALUES(?,?,NULL,?)").run(WORKBOARD_SOURCE_KEY, "full", minutesAgo(1));
  const workA = seedWork(db, { session: ids.sessionA, task: "task-1", state: "waiting", summary: t.whatA, digest: ids.digestA, at: minutesAgo(4),
    attention: { attempt_execution: "waiting", wait_kind: "user_decision", wait_reason: t.decisionA, wait_started_at: minutesAgo(3),
      deadline_at: minutesAhead(45), impact: 3, decision_valid: 1 } });
  const workB = seedWork(db, { session: ids.sessionB, task: null, state: "running", summary: t.whatB, digest: ids.digestB, at: minutesAgo(6),
    attention: { attempt_execution: "running", last_progress_received_at: minutesAgo(2) } });
  seedWork(db, { session: ids.sessionC, task: "task-3", state: "blocked", summary: t.whatC, digest: ids.digestC, at: minutesAgo(9),
    attention: { attempt_execution: "stopped", wait_kind: "dependency", wait_reason: t.blockC } });
  const workD = seedWork(db, { session: ids.sessionD, task: "task-4", state: "claimed_done", summary: t.whatD, digest: ids.digestD, at: minutesAgo(12),
    attention: { attempt_execution: "stopped" } });
  db.prepare("INSERT INTO workboard_purposes(project_id,version,text,source_kind,source_ref) VALUES(?,?,?,?,?)").run("orca-jarvis", 1, t.purposeJarvis, "owner", "owner-note-2026-09-20");
  const bind = db.prepare("INSERT INTO workboard_purpose_bindings(work_id,project_id,why,evidence_kind,evidence_ref,purpose_version,work_spec_revision) VALUES(?,?,?,?,?,?,?)");
  bind.run(workA, "orca-jarvis", t.whyA, "owner", `${ids.sessionA}/decision-log#12`, 1, "spec-rev-3");
  bind.run(workB, "orca-jarvis", t.whyB, "agent_summary", ids.digestB, 1, "spec-rev-3");
  db.prepare("INSERT INTO workboard_purpose_candidates(project_id,text,source_kind,source_ref) VALUES(?,?,?,?)").run("second-brain", t.purposeBrain, "explicit_request", "request-77");
  bind.run(workD, "second-brain", t.whyD, "explicit_request", "request-77", null, "spec-rev-1");
}

/** In-memory database with the fixture applied; callers own close(). */
export function openWorkboardFixture(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  seedWorkboardFixture(db);
  return db;
}
