import { cn } from "@/lib/format";

/**
 * Barras de magnitude em uma única matiz (marinho): pontas arredondadas ancoradas na base,
 * rótulo só no pico, valor exato no hover/foco e tabela equivalente para leitores de tela.
 */
export function Bars({ data, label, height = 120 }: { data: { key: string; value: number; hint?: string }[]; label: string; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const peak = data.reduce((a, d) => (d.value > a.value ? d : a), data[0] ?? { key: "", value: 0 });
  return (
    <figure>
      <div role="img" aria-label={label} className="flex items-end gap-[2px] border-b border-line" style={{ height }}>
        {data.map((d) => (
          <div key={d.key} tabIndex={0} title={`${d.hint ?? d.key}: ${d.value}`} className="group relative flex h-full flex-1 items-end justify-center outline-offset-0">
            {d.value > 0 && d.key === peak.key && <span className="absolute text-[10px] font-semibold text-bone" style={{ bottom: `calc(${(d.value / max) * 100}% + 2px)` }}>{d.value}</span>}
            <div className={cn("w-full max-w-7 rounded-t-[4px] bg-bone-mute transition group-hover:bg-bone group-focus:bg-bone", d.value === 0 && "bg-line")}
              style={{ height: d.value === 0 ? 2 : `${Math.max(3, (d.value / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-center text-[10px] text-bone-mute">
        {data.map((d) => <span key={d.key} className="flex-1 truncate">{d.key}</span>)}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>{data.map((d) => <tr key={d.key}><th scope="row">{d.hint ?? d.key}</th><td>{d.value}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

export function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "sun" | "navy" }) {
  return (
    <div className={cn("rounded-[var(--radius-card)] p-5 ", tone === "navy" ? "bg-surface-2 border border-line" : tone === "sun" ? "bg-gold text-ink" : "bg-surface border border-line")}>
      <p className={cn("eyebrow", tone === "navy" ? "text-gold" : "text-bone-mute", tone === "sun" && "text-ink")}>{label}</p>
      <p className="mt-2 text-4xl font-bold tracking-tight">{value}</p>
      {note && <p className={cn("mt-1 text-xs", tone === "navy" ? "text-bone-dim" : "text-bone-mute", tone === "sun" && "text-ink/80")}>{note}</p>}
    </div>
  );
}
