import { useEffect, useState } from "react";
import type { ProductHubResponse } from "../../src/dashboard/product-hub-contract.js";
import { classifyDashboardError } from "./api.js";
import { formatKst } from "./copy.js";
import "./product-hub.css";

type Product = ProductHubResponse["items"][number];
type ProductId = Product["id"];
type Loader = (signal?: AbortSignal) => Promise<ProductHubResponse>;
type LoadState =
  | Readonly<{ load: Loader; kind: "loading" }>
  | Readonly<{ load: Loader; kind: "read"; value: ProductHubResponse }>
  | Readonly<{ load: Loader; kind: "error"; denied: boolean }>;

const PRODUCTS = [
  { id: "crm", name: "CRM", link: "CRM 화면 열기" },
  { id: "mail", name: "Mail", link: "메일함 열기" },
  { id: "price", name: "AI 세무사", link: "AI 세무사 화면 열기" },
  { id: "second_brain", name: "Second Brain", link: "기억 화면 열기" },
  { id: "messenger", name: "메신저 요약", link: "메신저 요약 보기" },
  { id: "approvals", name: "승인함", link: "승인함 열기" },
] as const satisfies readonly Readonly<{ id: ProductId; name: string; link: string }>[];

const STATES = {
  loading: "확인 중",
  ready: "조회됨",
  no_data: "조회됨 · 자료 없음",
  unconfigured: "연결 설정 필요",
  unavailable: "현재 확인 불가",
  denied: "읽기 권한 확인 필요",
  stale: "관측이 오래됨",
  configured: "연결 구성됨 · 실제 조회 미확인",
} as const satisfies Record<Product["state"] | "loading", string>;

/** Product destinations use the entry point's hostname, never provider-supplied URLs. */
export function productScreen(id: ProductId, origin: string): string {
  const url = new URL("/", origin);
  switch (id) {
    case "crm":
      url.protocol = "https:"; url.port = "8446"; return url.href;
    case "mail":
      url.protocol = "http:"; url.port = "3010"; return url.href;
    case "price":
      url.protocol = "https:"; url.port = "8450"; return url.href;
    case "second_brain":
      return "/memory";
    case "messenger":
      return "/products#product-messenger";
    case "approvals":
      return "/approvals";
    default:
      return assertNever(id);
  }
}

export function ProductHub({ load }: Readonly<{ load?: Loader }>) {
  const [state, setState] = useState<LoadState | undefined>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (load === undefined) return undefined;
    const abort = new AbortController();
    setState({ load, kind: "loading" });
    void load(abort.signal).then(value => {
      if (!abort.signal.aborted) setState({ load, kind: "read", value });
    }, (error: unknown) => {
      if (!abort.signal.aborted) {
        setState({ load, kind: "error", denied: classifyDashboardError(error).kind === "forbidden" });
      }
    });
    return () => { abort.abort(); };
  }, [load, revision]);
  const current = state?.load === load ? state : undefined;
  const value = current?.kind === "read" ? current.value : undefined;
  const fallback = load === undefined ? "unconfigured" : current?.kind === "error"
    ? current.denied ? "denied" : "unavailable" : "loading";
  const loading = fallback === "loading" && value === undefined;
  return (
    <section className="page-frame dashboard-main product-hub" aria-labelledby="product-hub-title" aria-busy={loading}>
      <header className="product-hub-heading">
        <div>
          <p className="product-hub-kicker">읽기 전용 · 제품 한눈에</p>
          <h1 id="product-hub-title">JARVIS</h1>
        </div>
        <button type="button" disabled={load === undefined || loading}
          onClick={() => { setRevision(value => value + 1); }}>제품 요약 새로고침</button>
      </header>
      <p className="product-hub-note">오늘 브리핑이 비어 있어도 각 제품을 확인할 수 있습니다. 조회와 화면 이동은 승인·기장·전송이 아닙니다.</p>
      <p className="product-hub-note" role="status" aria-live="polite" aria-atomic="true">
        {value === undefined ? STATES[fallback] : `요약 조회 시각 ${formatKst(value.generated_at)}`}
      </p>
      <div className="product-hub-grid">
        {PRODUCTS.map(product => {
          const item = value?.items.find(item => item.id === product.id);
          const status = item?.state ?? fallback;
          return (
            <article className="panel product-hub-card" id={`product-${product.id}`} key={product.id}
              data-product={product.id} data-state={status} aria-labelledby={`product-title-${product.id}`}>
              <header className="product-hub-card-heading">
                <h2 id={`product-title-${product.id}`}>{product.name}</h2>
                <p className="product-hub-state">{STATES[status]}</p>
              </header>
              <p className="product-hub-summary" data-product-summary={product.id}>{summary(product.id, item)}</p>
              <p className="product-hub-note">{limitation(product.id)}</p>
              <p className="product-hub-observation">
                {item?.observed_at == null ? "원본 관측 시각 미확인"
                  : <>관측 <time dateTime={item.observed_at}>{formatKst(item.observed_at)}</time></>}
              </p>
              <a href={productScreen(product.id, window.location.origin)}>{product.link}</a>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function count(value: number | null | undefined): string {
  return value == null ? "미확인" : `${value.toLocaleString("ko-KR")}건`;
}

function summary(id: ProductId, item: Product | undefined): string {
  switch (id) {
    case "crm": return `메일에서 온 업무 후보 ${count(item?.count)}`;
    case "mail": return `메일 ${count(item?.count)} · 대화 ${count(item?.secondary_count)}`;
    case "price": return "원장 금액과 처리 상태는 AI 세무사 원래 화면에서 확인";
    case "second_brain": return `회사기억 후보 ${count(item?.count)}`;
    case "messenger": {
      const age = item?.oldest_age_ms;
      return `미완료 요청 ${count(item?.count)}${age == null ? "" : ` · 가장 오래된 것 약 ${Math.floor(age / 60_000).toLocaleString("ko-KR")}분`}`;
    }
    case "approvals": return `제어 요청 승인 대기 ${count(item?.count)}`;
    default: return assertNever(id);
  }
}

function limitation(id: ProductId): string {
  switch (id) {
    case "crm": return "후보 수신은 업무 확정이 아닙니다. 전체 CRM 업무 수와 다릅니다.";
    case "mail": return "허용된 건수만 표시합니다. 메일 본문과 발송 권한은 가져오지 않습니다.";
    case "price": return "연결 설정은 실제 원장 조회 완료가 아닙니다. 금액을 새로 계산하지 않습니다.";
    case "second_brain": return "회사기억 후보 수는 전체 기억 수가 아닙니다. 개인 기억 내용은 표시하지 않습니다.";
    case "messenger": return "원문·방·작성자 없이 기존 수집기의 건수와 관측만 표시합니다.";
    case "approvals": return "개인 결정 큐·대표 승인함과 별도인 제어 요청 수입니다. 이 카드에서 결정하지 않습니다.";
    default: return assertNever(id);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected product: ${String(value)}`);
}
