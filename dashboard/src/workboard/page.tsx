import { useEffect, useId, useState } from "react";
import type {
  WorkboardCard,
  WorkboardGroup,
  WorkboardPurposeStatus,
  WorkboardResponse,
} from "../../../src/dashboard/workboard-routes.js";
import { classifyDashboardError } from "../api.js";

/** Exact copy required by the workboard contract. */
export const UNKNOWN_PURPOSE = "목적 확인 필요";
export const HANDLE_AT_SOURCE = "원천에서 처리";

const text = {
  kicker: "목적 우선",
  title: "워크보드",
  generated: "기준 시각",
  refresh: "새로 고침",
  reload: "다시 불러오기",
  loading: "워크보드를 불러오는 중",
  loadFailed: "워크보드를 불러오지 못했습니다",
  notCollected: "워크보드 관측이 아직 시작되지 않았습니다",
  lead: "지금 당신이 필요한 일",
  leadEmpty: "지금 당신이 처리할 일이 없습니다",
  byPurpose: "목적별 진행 상황",
  groupsEmpty: "관측된 작업이 없습니다",
  countUnit: "건",
  project: "프로젝트",
  why: "왜",
  what: "무엇을",
  where: "어디서",
  who: "누가",
  how: "어떻게",
  action: "당신이 할 일",
  nothingToDo: "지금 할 일이 없습니다",
  evidenceShow: "근거 보기",
  evidenceHide: "근거 닫기",
  reconfirm: "목적이 바뀌었습니다. 다시 확인이 필요합니다",
  unknownSource: "출처 미상",
  deadlinePassed: "마감 지남",
  timeUnknown: "시각 미상",
} as const;

const RANK_LABELS = { 0: "결정 필요", 1: "막힘", 2: "확인 필요", 3: "검증 대기" } as const;
const PURPOSE_STATUS = { confirmed: "목적 확인됨", proposed: "목적 제안됨", unknown: UNKNOWN_PURPOSE } as const satisfies Record<WorkboardPurposeStatus, string>;
const DISPOSITION = {
  running: "실행 중", waiting: "대기 중", blocked: "막힘", failed: "실패", paused: "일시 정지",
  claimed_done: "완료 주장", verified: "검증 완료", unknown: "상태 미상",
} as const satisfies Record<WorkboardCard["disposition"], string>;
const ATTEMPT = {
  running: "에이전트 실행 중", waiting: "에이전트 대기 중", stopped: "에이전트 멈춤", unknown: "에이전트 상태 미상",
} as const satisfies Record<WorkboardCard["attempt_execution"], string>;
const DELIVERY = {
  none: null, cancel_requested: "취소 요청됨", delivering: "지시 전달 중", delivered: "지시 전달됨", uncertain: "지시 전달 불확실",
} as const satisfies Record<WorkboardCard["action_delivery"], string | null>;

type Urgency = "now" | "soon" | "watch" | "none";
type View =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: WorkboardResponse };

export type WorkboardRouteProps = Readonly<{
  load: (signal?: AbortSignal) => Promise<WorkboardResponse>;
  now?: () => Date;
}>;

export function WorkboardRoute({ load, now }: WorkboardRouteProps) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setView({ kind: "loading" });
    load(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setView({ kind: "ready", data }); },
      (error: unknown) => {
        if (!controller.signal.aborted) setView({ kind: "error", message: classifyDashboardError(error).message });
      },
    );
    return () => controller.abort();
  }, [load, attempt]);
  const reload = () => setAttempt((count) => count + 1);
  switch (view.kind) {
    case "loading":
      return <RouteState message={text.loading} busy />;
    case "error":
      return <RouteState message={`${text.loadFailed}: ${view.message}`} onRetry={reload} />;
    case "ready":
      return <WorkboardPage data={view.data} now={now} onRefresh={reload} />;
    default:
      return assertNever(view);
  }
}

export type WorkboardPageProps = Readonly<{
  data: WorkboardResponse;
  now?: () => Date;
  onRefresh?: () => void;
}>;

export function WorkboardPage({ data, now, onRefresh }: WorkboardPageProps) {
  const at = (now ?? (() => new Date()))();
  const leadId = useId();
  const purposeId = useId();
  return (
    <section className="page-frame dashboard-main workboard-page" aria-label={text.title}>
      <header className="workboard-heading">
        <div>
          <p className="workboard-kicker">{text.kicker}</p>
          <h1>{text.title}</h1>
        </div>
        <div className="workboard-meta">
          <span>{text.generated} <time dateTime={data.generated_at}>{clock(data.generated_at)}</time></span>
          {onRefresh === undefined ? null : <button type="button" onClick={onRefresh}>{text.refresh}</button>}
        </div>
      </header>
      {data.collected ? null : <p className="workboard-notice" role="status">{text.notCollected}</p>}
      <section className="workboard-section" aria-labelledby={leadId}>
        <div className="workboard-section-head">
          <h2 id={leadId}>{text.lead}</h2>
          <span className="workboard-count">{data.attention.length}{text.countUnit}</span>
        </div>
        {data.attention.length === 0 ? (
          <p className="empty-state" role="status">{text.leadEmpty}</p>
        ) : (
          <ol className="workboard-lead-list">
            {data.attention.map((card) => (
              <li key={card.work_id}><Card card={card} at={at} /></li>
            ))}
          </ol>
        )}
      </section>
      <section className="workboard-section" aria-labelledby={purposeId}>
        <div className="workboard-section-head">
          <h2 id={purposeId}>{text.byPurpose}</h2>
          <span className="workboard-count">{data.groups.length}{text.countUnit}</span>
        </div>
        {data.groups.length === 0 ? (
          <p className="empty-state" role="status">{text.groupsEmpty}</p>
        ) : (
          <div className="workboard-groups">
            {data.groups.map((group) => <PurposeGroup key={group.project_id ?? ""} group={group} at={at} />)}
          </div>
        )}
      </section>
    </section>
  );
}

function PurposeGroup({ group, at }: Readonly<{ group: WorkboardGroup; at: Date }>) {
  const headingId = useId();
  return (
    <section className="workboard-group" aria-labelledby={headingId} data-status={group.status}>
      <div className="workboard-group-head">
        {group.project_id === null ? null : <span className="workboard-kicker">{text.project} {group.project_id}</span>}
        <h2 id={headingId}>{group.purpose ?? UNKNOWN_PURPOSE}</h2>
        <Badge tone={purposeTone(group.status)}>{PURPOSE_STATUS[group.status]}</Badge>
        <span className="workboard-count">{group.works.length}{text.countUnit}</span>
      </div>
      <ul className="workboard-group-list">
        {group.works.map((card) => <li key={card.work_id}><Card card={card} at={at} /></li>)}
      </ul>
    </section>
  );
}

function Card({ card, at }: Readonly<{ card: WorkboardCard; at: Date }>) {
  const why = card.purpose.why ?? card.purpose.text;
  const action = userAction(card);
  return (
    <article className="wb-card" data-urgency={urgency(card.rank)}>
      <div className="wb-card-top">
        {card.rank === null ? null : <Badge tone={urgency(card.rank)}>{RANK_LABELS[card.rank]}</Badge>}
        {card.purpose.status === "confirmed" ? null : <Badge tone={purposeTone(card.purpose.status)}>{PURPOSE_STATUS[card.purpose.status]}</Badge>}
        {card.deadline_at === null ? null : <span className="wb-time"><time dateTime={card.deadline_at}>{deadline(card.deadline_at, at)}</time></span>}
      </div>
      <p className="wb-why" data-unknown={why === null || undefined}>
        <span className="wb-label">{text.why}</span>
        {why ?? UNKNOWN_PURPOSE}
      </p>
      <h3 className="wb-what">
        <span className="wb-label">{text.what}</span>
        {card.summary}
      </h3>
      <dl className="wb-facts">
        <div className="wb-fact">
          <dt>{text.where}</dt>
          <dd>{card.source.scope || text.unknownSource}{card.source.host ? ` @ ${card.source.host}` : ""}</dd>
        </div>
        <div className="wb-fact">
          <dt>{text.who}</dt>
          <dd>{card.source.app || text.unknownSource}</dd>
        </div>
        <div className="wb-fact">
          <dt>{text.how}</dt>
          <dd>{how(card, at)}</dd>
        </div>
      </dl>
      <div className="wb-action">
        <p className="wb-action-title"><span className="wb-label">{text.action}</span>{action.title}</p>
        {action.effect === null ? null : (
          <span className="wb-source-chip">{action.effect} · {HANDLE_AT_SOURCE}</span>
        )}
      </div>
      <Evidence items={card.evidence} />
    </article>
  );
}

function Evidence({ items }: Readonly<{ items: WorkboardCard["evidence"] }>) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="wb-evidence">
      <button type="button" className="wb-evidence-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        {open ? text.evidenceHide : text.evidenceShow}
      </button>
      {open ? (
        <dl id={panelId} className="wb-evidence-list">
          {items.map((item) => (
            <div className="wb-evidence-item" key={`${item.label}:${item.value}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function Badge({ tone, children }: Readonly<{ tone: Urgency; children: string }>) {
  return <span className="wb-badge" data-tone={tone}>{children}</span>;
}

function urgency(rank: WorkboardCard["rank"]): Urgency {
  switch (rank) {
    case 0:
    case 1:
      return "now";
    case 2:
      return "soon";
    case 3:
      return "watch";
    case null:
      return "none";
    default:
      return assertNever(rank);
  }
}

function purposeTone(status: WorkboardPurposeStatus): Urgency {
  switch (status) {
    case "confirmed":
      return "none";
    case "proposed":
      return "watch";
    case "unknown":
      return "soon";
    default:
      return assertNever(status);
  }
}

/** Names what the user must do; nothing here can be sent from the board yet, so every effect routes to the source. */
function userAction(card: WorkboardCard): { title: string; effect: string | null } {
  if (card.purpose.needs_reconfirmation) return { title: text.reconfirm, effect: "목적 다시 확인" };
  if (card.reasons.includes("user_decision")) {
    return { title: card.wait_reason === null ? "결정이 필요합니다" : `결정이 필요합니다: ${card.wait_reason}`, effect: "결정 보내기" };
  }
  if (card.disposition === "blocked") return { title: card.wait_reason === null ? "막힌 원인을 풀어야 합니다" : `막힘: ${card.wait_reason}`, effect: "막힘 풀기" };
  if (card.disposition === "failed") return { title: "실패 원인을 확인하고 다시 시작할지 정해야 합니다", effect: "다시 시작" };
  if (card.reasons.includes("verification_wait")) return { title: "결과가 맞는지 검증해야 합니다", effect: "검증 완료 표시" };
  if (card.reasons.includes("stall_suspected")) return { title: "진행이 멈춘 것 같습니다. 원천 상태를 확인하세요", effect: "상태 확인" };
  if (card.reasons.includes("observation_gap")) return { title: "관측이 끊겼습니다. 원천이 살아 있는지 확인하세요", effect: "관측 재개" };
  return { title: text.nothingToDo, effect: null };
}

function how(card: WorkboardCard, at: Date): string {
  const parts: string[] = [DISPOSITION[card.disposition], ATTEMPT[card.attempt_execution]];
  const delivery = DELIVERY[card.action_delivery];
  if (delivery !== null) parts.push(delivery);
  if (card.wait_started_at !== null) parts.push(`${elapsed(card.wait_started_at, at)}째 대기`);
  parts.push(card.freshness === "fresh"
    ? `${relative(card.observed_at ?? card.source_at, at)} 확인`
    : `관측 끊김 · 마지막 확인 ${relative(card.observed_at, at)}`);
  if (card.warning !== null) parts.push(`경고: ${card.warning}`);
  return parts.join(" · ");
}

function relative(iso: string | null, at: Date): string {
  if (iso === null) return text.timeUnknown;
  const ms = at.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return text.timeUnknown;
  if (ms < 60_000) return "방금";
  return `${elapsed(iso, at)} 전`;
}

function elapsed(iso: string, at: Date): string {
  const ms = Math.max(0, at.getTime() - Date.parse(iso));
  if (!Number.isFinite(ms)) return text.timeUnknown;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  return `${Math.floor(hours / 24)}일`;
}

function deadline(iso: string, at: Date): string {
  const ms = Date.parse(iso) - at.getTime();
  if (!Number.isFinite(ms)) return text.timeUnknown;
  if (ms <= 0) return text.deadlinePassed;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `마감 ${minutes}분 남음`;
  const hours = Math.ceil(minutes / 60);
  return hours < 24 ? `마감 ${hours}시간 남음` : `마감 ${Math.ceil(hours / 24)}일 남음`;
}

function clock(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return text.timeUnknown;
  return new Date(time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function RouteState({ message, busy = false, onRetry }: Readonly<{ message: string; busy?: boolean; onRetry?: () => void }>) {
  return (
    <div className="page-frame route-state" aria-busy={busy || undefined}>
      <section role={busy ? "status" : "alert"}>
        <h1>{text.title}</h1>
        <p>{message}</p>
        {onRetry === undefined ? null : <button type="button" onClick={onRetry}>{text.reload}</button>}
      </section>
    </div>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unexpected workboard state: ${JSON.stringify(value)}`);
}
