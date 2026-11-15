import { addDays, localDate, localParts, weekdayOf, zonedToUtc } from "@/lib/datetime";

/**
 * Agenda no formato iCalendar (o mesmo do Google Agenda, Outlook e Apple):
 * - leitura do "endereço secreto no formato iCal" para bloquear horários ocupados;
 * - geração do link que a clínica assina no Google Agenda para ver as consultas.
 * Recorrência suportada: FREQ DAILY/WEEKLY/MONTHLY/YEARLY com INTERVAL, COUNT, UNTIL, BYDAY (semanal) e EXDATE;
 * ocorrências alteradas (RECURRENCE-ID) substituem a original.
 */

export type IcsTime = { date: string; time: string | null; tz: string | null; utc: boolean };
export type IcsEvent = {
  uid: string; summary: string; start: IcsTime; end: IcsTime | null; durationMin: number | null;
  rrule: Record<string, string> | null; exdates: IcsTime[]; recurrenceId: IcsTime | null; cancelled: boolean; free: boolean;
};
export type BusyInterval = { uid: string; summary: string; start: Date; end: Date };

const unfold = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
const unescape = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

function parseTime(value: string, params: Record<string, string>): IcsTime | null {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (params.VALUE === "DATE" || !m[4]) return { date, time: null, tz: null, utc: false };
  return { date, time: `${m[4]}:${m[5]}`, tz: params.TZID ?? null, utc: m[7] === "Z" };
}

function parseDuration(v: string): number | null {
  const m = v.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0)) * 1440 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let cur: Partial<IcsEvent> | null = null;
  for (const line of unfold(text).split("\n")) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: [], rrule: null, recurrenceId: null, cancelled: false, free: false, summary: "", end: null, durationMin: null }; continue; }
    if (line === "END:VEVENT") {
      if (cur?.uid && cur.start) events.push(cur as IcsEvent);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const [name, ...rawParams] = line.slice(0, colon).split(";");
    const value = line.slice(colon + 1);
    const params = Object.fromEntries(rawParams.map((p) => { const [k, v = ""] = p.split("="); return [k!.toUpperCase(), v.replace(/^"|"$/g, "")]; }));
    switch (name!.toUpperCase()) {
      case "UID": cur.uid = value.trim(); break;
      case "SUMMARY": cur.summary = unescape(value).slice(0, 200); break;
      case "DTSTART": cur.start = parseTime(value, params) ?? undefined; break;
      case "DTEND": cur.end = parseTime(value, params); break;
      case "DURATION": cur.durationMin = parseDuration(value.trim()); break;
      case "RRULE": cur.rrule = Object.fromEntries(value.split(";").map((p) => { const [k, v = ""] = p.split("="); return [k!.toUpperCase(), v]; })); break;
      case "EXDATE": for (const v of value.split(",")) { const t = parseTime(v, params); if (t) cur.exdates!.push(t); } break;
      case "RECURRENCE-ID": cur.recurrenceId = parseTime(value, params); break;
      case "STATUS": cur.cancelled = value.trim().toUpperCase() === "CANCELLED"; break;
      case "TRANSP": cur.free = value.trim().toUpperCase() === "TRANSPARENT"; break;
    }
  }
  return events;
}

/** Converte um horário iCal para UTC. Dia inteiro = 00:00 no fuso da clínica. */
function toUtc(t: IcsTime, tz: string): Date {
  if (t.utc && t.time) return new Date(`${t.date}T${t.time}:00Z`);
  return zonedToUtc(t.date, t.time ?? "00:00", t.tz ?? tz);
}

const BYDAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Datas (locais) das ocorrências de uma regra, até `untilDate`, com limite de segurança. */
function occurrenceDates(start: string, rule: Record<string, string>, untilDate: string): string[] {
  const freq = rule.FREQ ?? "";
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1));
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const until = rule.UNTIL ? `${rule.UNTIL.slice(0, 4)}-${rule.UNTIL.slice(4, 6)}-${rule.UNTIL.slice(6, 8)}` : null;
  const last = until && until < untilDate ? until : untilDate;
  const out: string[] = [];
  const push = (d: string) => { if (d >= start && d <= last && out.length < count) out.push(d); };
  if (freq === "DAILY") {
    for (let d = start, i = 0; d <= last && out.length < count && i < 5000; d = addDays(d, interval), i++) push(d);
  } else if (freq === "WEEKLY") {
    const days = rule.BYDAY ? rule.BYDAY.split(",").map((x) => BYDAY[x.slice(-2)]).filter((x): x is number => x !== undefined) : [weekdayOf(start)];
    const weekStart = addDays(start, -weekdayOf(start));
    for (let w = weekStart, i = 0; w <= last && out.length < count && i < 2000; w = addDays(w, 7 * interval), i++) {
      for (const wd of [...days].sort((a, b) => a - b)) push(addDays(w, wd));
    }
  } else if (freq === "MONTHLY" || freq === "YEARLY") {
    const [y, m, d] = start.split("-").map(Number) as [number, number, number];
    for (let i = 0; out.length < count && i < 600; i++) {
      const months = freq === "MONTHLY" ? i * interval : i * 12 * interval;
      const yy = y + Math.floor((m - 1 + months) / 12);
      const mm = ((m - 1 + months) % 12) + 1;
      const date = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (date > last) break;
      // dia 31 em mês curto não existe: pula, como o Google
      if (new Date(Date.UTC(yy, mm - 1, d)).getUTCMonth() === mm - 1) push(date);
    }
  } else {
    push(start);
  }
  return out;
}

/** Intervalos ocupados entre `from` e `to` (UTC), no fuso da clínica para horários sem fuso. */
export function busyIntervals(events: IcsEvent[], from: Date, to: Date, tz: string): BusyInterval[] {
  const overrides = new Map<string, IcsEvent[]>();
  for (const e of events) if (e.recurrenceId) overrides.set(e.uid, [...(overrides.get(e.uid) ?? []), e]);
  const out: BusyInterval[] = [];
  const add = (e: IcsEvent, start: Date, end: Date) => {
    if (e.cancelled || e.free || end <= from || start >= to || end <= start) return;
    out.push({ uid: e.uid, summary: e.summary, start, end });
  };
  const lengthMs = (e: IcsEvent) => {
    if (e.end) return toUtc(e.end, tz).getTime() - toUtc(e.start, tz).getTime();
    if (e.durationMin != null) return e.durationMin * 60_000;
    return e.start.time ? 0 : 86_400_000; // dia inteiro sem fim = 1 dia
  };
  for (const e of events) {
    if (e.recurrenceId) { const s = toUtc(e.start, tz); add(e, s, new Date(s.getTime() + lengthMs(e))); continue; }
    const len = lengthMs(e);
    if (!e.rrule) { const s = toUtc(e.start, tz); add(e, s, new Date(s.getTime() + len)); continue; }
    const startLocal = e.start.utc && e.start.time ? localParts(toUtc(e.start, tz), tz) : null;
    const baseDate = startLocal ? localDate(toUtc(e.start, tz), tz) : e.start.date;
    const baseTime = startLocal ? `${String(startLocal.hour).padStart(2, "0")}:${String(startLocal.minute).padStart(2, "0")}` : e.start.time;
    const zone = e.start.utc ? tz : e.start.tz ?? tz;
    const excluded = new Set(e.exdates.map((x) => toUtc(x, tz).getTime()));
    const changed = new Set((overrides.get(e.uid) ?? []).map((o) => toUtc(o.recurrenceId!, tz).getTime()));
    for (const d of occurrenceDates(baseDate, e.rrule, localDate(to, tz))) {
      const s = zonedToUtc(d, baseTime ?? "00:00", zone);
      if (excluded.has(s.getTime()) || changed.has(s.getTime())) continue;
      add(e, s, new Date(s.getTime() + len));
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// ───────────── Geração (espelhar a agenda da clínica) ─────────────

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Dobra linhas em 75 octetos, como pede a RFC 5545. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let chunk = "";
  for (const ch of line) {
    if (Buffer.byteLength(chunk + ch, "utf8") > (parts.length ? 74 : 75)) { parts.push(chunk); chunk = ""; }
    chunk += ch;
  }
  parts.push(chunk);
  return parts.join("\r\n ");
}

export type FeedEvent = { id: string; start: Date; end: Date; summary: string; description?: string | null; tentative?: boolean };

export function buildIcs(name: string, events: FeedEvent[], now: Date = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//IOP Odonto Hub//Agenda//PT-BR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`, "X-PUBLISHED-TTL:PT1H", "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.id}@odontohub`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`,
      `SUMMARY:${esc(e.summary)}`, ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []), `STATUS:${e.tentative ? "TENTATIVE" : "CONFIRMED"}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
