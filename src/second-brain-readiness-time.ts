const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

export type ParsedSecondBrainInstant = {
  readonly epoch_ms: number;
  readonly canonical: string;
};

export function parseSecondBrainInstant(value: string): ParsedSecondBrainInstant | undefined {
  const match = RFC3339.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!validCalendar(year, month, day)
    || hour > 23
    || minute > 59
    || second > 59
    || !validOffset(match[8])) return undefined;
  const epoch_ms = Date.parse(value);
  if (!Number.isFinite(epoch_ms)) return undefined;
  return { epoch_ms, canonical: new Date(epoch_ms).toISOString() };
}

function validCalendar(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validOffset(value: string | undefined): boolean {
  if (value === undefined || value === "Z") return value === "Z";
  const hour = Number(value.slice(1, 3));
  const minute = Number(value.slice(4, 6));
  return hour <= 23 && minute <= 59;
}
