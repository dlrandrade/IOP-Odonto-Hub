/** Datas no fuso da clínica sem dependências. Banco sempre em UTC. */

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const WEEKDAY_LABELS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"] as const;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(date: Date, tz: string): LocalParts {
  const map: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year), month: Number(map.month), day: Number(map.day),
    hour: Number(map.hour), minute: Number(map.minute), weekday: WEEKDAYS[map.weekday ?? "Sun"] ?? 0,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" no fuso informado. */
export function localDate(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localTime(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Converte data/hora local ("YYYY-MM-DD", "HH:MM") no instante UTC correspondente. */
export function zonedToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const [hh, mm] = timeStr.split(":").map(Number) as [number, number];
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = target - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/** "terça-feira, 17/11/2026 às 14:00" — data completa exigida antes de qualquer reserva. */
export function formatFull(date: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  return `${day} às ${localTime(date, tz)}`;
}

export function formatShort(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export type BusinessHours = Partial<Record<(typeof WEEKDAY_KEYS)[number], [string, string][]>>;

export function isWithinBusinessHours(date: Date, tz: string, hours: BusinessHours): boolean {
  const p = localParts(date, tz);
  const ranges = hours[WEEKDAY_KEYS[p.weekday] ?? "sun"] ?? [];
  const now = `${pad(p.hour)}:${pad(p.minute)}`;
  return ranges.some(([start, end]) => now >= start && now < end);
}

/** Empurra um horário para dentro da janela permitida de envio (ex.: 08h–20h locais). */
export function clampToQuietHours(date: Date, tz: string, startHour: number, endHour: number): Date {
  const p = localParts(date, tz);
  const day = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  if (p.hour < startHour) return zonedToUtc(day, `${pad(startHour)}:00`, tz);
  if (p.hour >= endHour) return zonedToUtc(addDays(day, 1), `${pad(startHour)}:00`, tz);
  return date;
}
