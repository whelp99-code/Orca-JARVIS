export function formatReadableDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "확인 필요";
  const parts = new Intl.DateTimeFormat("ko-KR", {
    month: "numeric", day: "numeric", weekday: "short", timeZone: "Asia/Seoul",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  const month = part("month");
  const day = part("day");
  const weekday = part("weekday");
  return month === undefined || day === undefined || weekday === undefined
    ? "확인 필요" : `${month}/${day}(${weekday})`;
}

export function formatReadablePeriodDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "확인 필요";
  const parts = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "numeric", day: "numeric", weekday: "short", timeZone: "Asia/Seoul",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const weekday = part("weekday");
  return year === undefined || month === undefined || day === undefined || weekday === undefined
    ? "확인 필요" : `${year}/${month}/${day}(${weekday})`;
}

export function formatReadableTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "확인 필요";
  const parts = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "numeric", day: "numeric", weekday: "short",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "Asia/Seoul",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const weekday = part("weekday");
  const hour = part("hour");
  const minute = part("minute");
  const second = part("second");
  return year === undefined || month === undefined || day === undefined || weekday === undefined
    || hour === undefined || minute === undefined || second === undefined
    ? "확인 필요" : `${year}/${month}/${day}(${weekday}) ${hour}:${minute}:${second}`;
}

export function elapsedDays(from: string, until: string): number | undefined {
  const fromMs = Date.parse(from);
  const untilMs = Date.parse(until);
  if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs) || untilMs < fromMs) return undefined;
  return Math.floor((untilMs - fromMs) / 86_400_000);
}

export function formatWon(value: unknown): string {
  let amount: bigint;
  if (typeof value === "number" && Number.isSafeInteger(value)) amount = BigInt(value);
  else if (typeof value === "string" && /^-?\d+$/.test(value)) amount = BigInt(value);
  else return "확인 필요";
  return `₩${amount.toLocaleString("ko-KR")}`;
}

function formatCardWonSuffix(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  let amount: bigint;
  if (typeof value === "number" && Number.isSafeInteger(value)) amount = BigInt(value);
  else if (typeof value === "string" && /^-?\d+$/.test(value)) amount = BigInt(value);
  else return undefined;
  return `${amount.toLocaleString("ko-KR")}원`;
}

export function formatLabeledCardWon(label: string, value: unknown): string {
  const formatted = formatCardWonSuffix(value);
  return formatted === undefined ? `${label}: 확인 안 됨` : `${label} ${formatted}`;
}

export function formatOrderBillingLine(ordered: unknown, invoiced: unknown, unbilled: unknown): string {
  return [
    formatLabeledCardWon("발주", ordered),
    formatLabeledCardWon("청구", invoiced),
    formatLabeledCardWon("미청구", unbilled),
  ].join(" · ");
}

export function formatOptionalCardAmount(value: unknown): string {
  return formatCardWonSuffix(value) ?? "확인 안 됨";
}

export function formatCashBalancePair(opening: unknown, closing: unknown): string {
  const open = formatCardWonSuffix(opening);
  const close = formatCardWonSuffix(closing);
  if (open === undefined && close === undefined) return "확인 안 됨";
  return `기초 ${open ?? "확인 안 됨"} · 마감 ${close ?? "확인 안 됨"}`;
}

export function formatReadablePeriodRange(start: string, end: string): string {
  return `${formatReadablePeriodDate(start)} — ${formatReadablePeriodDate(end)}`;
}

export function describeConnectionStatus(
  connection: "unconnected" | "registered_confirmed",
  confirmation: "unconfirmed" | "confirmed",
): string {
  const link = connection === "unconnected" ? "연결: 아직 안 됨" : "연결: 등록·사람 확인";
  const confirm = confirmation === "unconfirmed" ? "회사 확인: 미확인" : "회사 확인: 완료";
  return `${link} · ${confirm}`;
}

export function describeFixtureFreshness(): string {
  return "신선도: 실제 제공자 조회로 검증 안 됨";
}

export function describeNativeObservationFreshness(): string {
  return "신선도: 원본 응답만 관측 · 업무·기억 확정 근거 아님";
}

export function describeProducerUnverifiedFreshness(): string {
  return "실제 제공자 신선도 미검증";
}

export function describePayableConfirmation(payableToday: null | unknown, confirmed: boolean): string {
  if (payableToday === null && !confirmed) return "아직 안 됨";
  if (confirmed) return "확정됨";
  return "확인 안 됨";
}

export function describeCashCoverage(complete: boolean | null | undefined): string {
  if (complete === true) return "확인됨";
  if (complete === false) return "확인 안 됨";
  return "확인 안 됨";
}

export function describeTaxReady(ready: boolean): string {
  return ready ? "준비 완료" : "아직";
}

export function describeCompanyDataComplete(complete: boolean): string {
  return complete ? "자료 완전" : "미완료";
}

export function describeNullableText(value: string | null | undefined, missing = "확인 안 됨"): string {
  return value === null || value === undefined || value === "" ? missing : value;
}
