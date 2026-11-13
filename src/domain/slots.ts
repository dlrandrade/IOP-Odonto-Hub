import { addDays, addMinutes, weekdayOf, zonedToUtc } from "@/lib/datetime";

/**
 * Motor de horários (RF-05):
 * disponibilidade = regra do dentista ∩ habilitado para o serviço ∩ todos os recursos livres ∩ sem bloqueio.
 * Função pura: recebe os dados já carregados e devolve os horários possíveis.
 */
export type Interval = { start: Date; end: Date };

export type SlotQuery = {
  tz: string;
  now: Date;
  fromDate: string; // YYYY-MM-DD (local)
  toDate: string;
  turno?: "manha" | "tarde" | "noite" | null;
  service: { durationMin: number; bufferMin: number; requiredResourceKinds: string[] };
  /** Somente dentistas ativos e habilitados para o serviço. */
  professionals: { id: string; resourceId: string }[];
  rules: { professionalId: string; weekday: number; start: string; end: string }[];
  blocks: { professionalId: string | null; resourceId: string | null; start: Date; end: Date }[];
  /** Ocupação ativa por recurso (cadeiras, equipamentos e dentistas). */
  busy: { resourceId: string; start: Date; end: Date }[];
  resources: { id: string; kind: string }[];
  minLeadMinutes: number;
  maxAdvanceDays: number;
  limit?: number;
  stepMin?: number;
};

export type Slot = {
  professionalId: string;
  startsAt: Date;
  endsAt: Date;
  /** Fim da ocupação dos recursos (inclui o intervalo de higienização). */
  occupiedUntil: Date;
  resourceIds: string[];
};

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

const TURNOS: Record<string, [number, number]> = { manha: [0, 12 * 60], tarde: [12 * 60, 18 * 60], noite: [18 * 60, 24 * 60] };
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function computeSlots(q: SlotQuery): Slot[] {
  const out: Slot[] = [];
  const step = q.stepMin ?? Math.min(30, q.service.durationMin);
  const earliest = addMinutes(q.now, q.minLeadMinutes);
  const latest = addMinutes(q.now, q.maxAdvanceDays * 24 * 60);
  const busyBy = new Map<string, Interval[]>();
  for (const b of q.busy) {
    const list = busyBy.get(b.resourceId) ?? [];
    list.push(b);
    busyBy.set(b.resourceId, list);
  }
  const isFree = (resourceId: string, iv: Interval) =>
    !(busyBy.get(resourceId) ?? []).some((b) => overlaps(b, iv)) &&
    !q.blocks.some((b) => b.resourceId === resourceId && overlaps(b, iv));
  const clinicBlocked = (iv: Interval) => q.blocks.some((b) => !b.professionalId && !b.resourceId && overlaps(b, iv));
  const neededKinds = q.service.requiredResourceKinds.filter((k) => k !== "professional");

  for (let day = q.fromDate; day <= q.toDate; day = addDays(day, 1)) {
    const weekday = weekdayOf(day);
    const dayCandidates: Slot[] = [];
    for (const prof of q.professionals) {
      const rules = q.rules.filter((r) => r.professionalId === prof.id && r.weekday === weekday);
      for (const rule of rules) {
        const ruleEnd = toMinutes(rule.end);
        for (let m = toMinutes(rule.start); m + q.service.durationMin <= ruleEnd; m += step) {
          if (q.turno) {
            const [a, b] = TURNOS[q.turno] ?? [0, 1440];
            if (m < a || m >= b) continue;
          }
          const startsAt = zonedToUtc(day, toHHMM(m), q.tz);
          if (startsAt < earliest || startsAt > latest) continue;
          const endsAt = addMinutes(startsAt, q.service.durationMin);
          const occupied: Interval = { start: startsAt, end: addMinutes(endsAt, q.service.bufferMin) };
          if (clinicBlocked(occupied)) continue;
          if (q.blocks.some((b) => b.professionalId === prof.id && overlaps(b, occupied))) continue;
          if (!isFree(prof.resourceId, occupied)) continue;
          const picked: string[] = [prof.resourceId];
          let ok = true;
          for (const kind of neededKinds) {
            const free = q.resources.find((r) => r.kind === kind && !picked.includes(r.id) && isFree(r.id, occupied));
            if (!free) { ok = false; break; }
            picked.push(free.id);
          }
          if (!ok) continue;
          dayCandidates.push({ professionalId: prof.id, startsAt, endsAt, occupiedUntil: occupied.end, resourceIds: picked });
        }
      }
    }
    dayCandidates.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    out.push(...dayCandidates);
    if (q.limit && out.length >= q.limit * 4) break;
  }
  return out;
}

/** Escolhe poucas opções, das mais próximas, variando dia e período (no máx. 2 por dia). */
export function pickOffers(slots: Slot[], max = 5): Slot[] {
  const sorted = [...slots].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const picked: Slot[] = [];
  const perDay = new Map<string, Date[]>();
  for (const s of sorted) {
    if (picked.length >= max) break;
    const day = s.startsAt.toISOString().slice(0, 10);
    const times = perDay.get(day) ?? [];
    if (times.length >= 2) continue;
    if (times.some((t) => Math.abs(t.getTime() - s.startsAt.getTime()) < 2 * 3600_000)) continue;
    times.push(s.startsAt);
    perDay.set(day, times);
    picked.push(s);
  }
  return picked;
}
