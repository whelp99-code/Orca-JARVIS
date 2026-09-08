import type { RuntimeIdentityReport } from "../../src/runtime-identity-contracts.js";
import "./runtime-status.css";

const buildLabels = { matched: "파일 일치", mismatch: "파일 불일치", missing: "빌드 기록 없음",
  invalid: "빌드 기록 오류", unreadable: "파일 확인 불가" } as const;
const databaseLabels = { matched: "기록 일치", mismatch: "적용 차이 있음", unverified: "대조 기준 없음",
  unavailable: "기록 확인 불가" } as const;
const toolchainLabels = { matched: "빌드 환경과 일치", mismatch: "빌드 환경과 다름", unknown: "확인 불가" } as const;

export function RuntimeStatus({ runtime }: { readonly runtime?: RuntimeIdentityReport }) {
  if (runtime === undefined) return <p className="runtime-unavailable">서버 실행 식별 정보가 제공되지 않았습니다.</p>;
  const { build, database, process } = runtime;
  return <details className="runtime-status">
    <summary>현황판 서버 실행 정보 · {buildLabels[build.status]} · DB {databaseLabels[database.status]}</summary>
    <div className="runtime-status-body">
      <p>서버 초기화 시 확인한 백엔드 파일입니다. 이후 파일 교체 여부와 배포 승인 상태는 포함하지 않습니다.</p>
      <dl className="runtime-identity-list">
        <div><dt>소스 커밋</dt><dd>{build.source_head ?? "확인 불가"}</dd></div>
        <div><dt>빌드 당시 소스 변경</dt><dd>{build.source_dirty === null ? "확인 불가" : build.source_dirty ? "변경 포함" : "변경 없음"}</dd></div>
        <div><dt>파일 대조</dt><dd>{buildLabels[build.status]} · {build.artifact_files ?? "—"}개</dd></div>
        <div><dt>파일 확인 시각</dt><dd><time dateTime={build.checked_at}>{build.checked_at}</time></dd></div>
        <div><dt>빌드 산출물 해시</dt><dd>{build.artifact_digest ?? "확인 불가"}</dd></div>
        <div><dt>관측 산출물 해시</dt><dd>{build.observed_artifact_digest ?? "확인 불가"}</dd></div>
        <div><dt>소스 입력 해시</dt><dd>{build.input_digest ?? "확인 불가"}</dd></div>
        <div><dt>서버 프로세스</dt><dd>PID {process.pid} · 시작 {process.started_at}</dd></div>
        <div><dt>실행 환경</dt><dd>Node {process.node} · ABI {process.modules} · {process.platform}/{process.arch} · {toolchainLabels[build.toolchain_status]}</dd></div>
        <div><dt>마이그레이션 기록</dt><dd>{databaseLabels[database.status]} · 적용 {database.applied_migrations ?? "—"} / 빌드 {build.migration_count ?? "—"}</dd></div>
        <div><dt>적용 차이</dt><dd>누락 {database.missing ?? "—"} · 추가 {database.unexpected ?? "—"} · 변경 {database.changed ?? "—"}</dd></div>
        <div><dt>DB 마이그레이션 해시</dt><dd>{database.migration_digest ?? "확인 불가"}</dd></div>
        <div><dt>DB 구조 해시</dt><dd>{database.schema_digest ?? "확인 불가"} · 객체 {database.schema_objects ?? "—"}개</dd></div>
        <div><dt>DB 확인 시각</dt><dd>{database.observed_at ?? "확인 불가"}</dd></div>
      </dl>
      <p>마이그레이션 기록 일치는 실제 DB 구조의 정상 판정을 대신하지 않습니다.</p>
    </div>
  </details>;
}
