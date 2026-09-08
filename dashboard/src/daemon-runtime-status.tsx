import type { DaemonRuntimeIdentityReport } from "../../src/daemon-runtime-identity.js";
import "./runtime-status.css";

const statusLabels = { active: "관측 시점에 lease·프로세스 일치", inactive: "lease 종료",
  stale: "이전 실행 관측", unknown: "상태 확인 불가" } as const;
const reasonLabels = { missing: "저장된 관측 없음", invalid: "저장된 관측 형식 오류", unavailable: "관측 저장소 확인 불가",
  clock_invalid: "관측 시각 불일치", lease_missing: "lease 기록 없음", lease_changed: "lease 소유 실행 변경",
  lease_expired: "lease 해제 또는 만료", lease_invalid: "lease 기록 형식 오류", process_unobservable: "프로세스 확인 불가",
  namespace_unobservable: "같은 PID namespace에서 확인 불가", process_missing: "프로세스 사라짐",
  process_exited: "프로세스 종료 중", incarnation_changed: "프로세스 기동 변경" } as const;
const buildLabels = { matched: "파일 일치", mismatch: "파일 불일치", missing: "빌드 기록 없음",
  invalid: "빌드 기록 오류", unreadable: "파일 확인 불가" } as const;

export function DaemonRuntimeStatus({ daemon }: { readonly daemon?: DaemonRuntimeIdentityReport }) {
  if (daemon === undefined) return <p className="runtime-unavailable">작업 데몬 식별 정보가 제공되지 않았습니다.</p>;
  const { snapshot, lease } = daemon;
  return <details className="runtime-status">
    <summary>작업 데몬 · {statusLabels[daemon.status]}</summary>
    <div className="runtime-status-body">
      <p>표시한 관측 시점의 lease와 프로세스 상태입니다. 업무 처리 준비 여부는 별도로 확인합니다.</p>
      <dl className="runtime-identity-list">
        <div><dt>상태 확인 시각</dt><dd>{daemon.observed_at ?? "확인 불가"}</dd></div>
        <div><dt>판정 근거</dt><dd>{daemon.reason === null ? "같은 lease와 프로세스 기동 확인" : reasonLabels[daemon.reason]}</dd></div>
        <div><dt>관측 게시 시각</dt><dd>{daemon.recorded_at ?? "기록 없음"}</dd></div>
        {lease && <><div><dt>Lease 번호</dt><dd>{lease.fence}</dd></div>
          <div><dt>마지막 heartbeat</dt><dd>{lease.heartbeat_at}</dd></div>
          <div><dt>Lease 만료 시각</dt><dd>{lease.expires_at}</dd></div></>}
      </dl>
      {snapshot ? <>
        <p>데몬이 처음 게시한 빌드 관측입니다. 이후 파일 변경이나 배포 승인 상태를 나타내지 않습니다.</p>
        <dl className="runtime-identity-list">
          <div><dt>데몬 프로세스</dt><dd>PID {snapshot.process.pid} · 시작 {snapshot.process.started_at}</dd></div>
          <div><dt>데몬 실행 환경</dt><dd>Node {snapshot.process.node} · ABI {snapshot.process.modules} · {snapshot.process.platform}/{snapshot.process.arch}</dd></div>
          <div><dt>데몬 소스 커밋</dt><dd>{snapshot.build.source_head ?? "확인 불가"}</dd></div>
          <div><dt>빌드 당시 소스 변경</dt><dd>{snapshot.build.source_dirty === null ? "확인 불가" : snapshot.build.source_dirty ? "변경 포함" : "변경 없음"}</dd></div>
          <div><dt>첫 게시 파일 대조</dt><dd>{buildLabels[snapshot.build.status]} · {snapshot.build.artifact_files ?? "—"}개</dd></div>
          <div><dt>데몬 파일 확인 시각</dt><dd>{snapshot.build.checked_at}</dd></div>
          <div><dt>데몬 빌드 산출물 해시</dt><dd>{snapshot.build.artifact_digest ?? "확인 불가"}</dd></div>
          <div><dt>데몬 관측 산출물 해시</dt><dd>{snapshot.build.observed_artifact_digest ?? "확인 불가"}</dd></div>
        </dl>
      </> : <p>저장된 데몬 빌드 관측이 없습니다.</p>}
    </div>
  </details>;
}
