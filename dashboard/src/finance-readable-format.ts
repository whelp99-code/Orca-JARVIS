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
