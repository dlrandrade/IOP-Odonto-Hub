import { cn } from "@/lib/format";

/** Topo "redondo" do eixo (1, 2, 5 × 10ⁿ) para as linhas de grade caírem em números legíveis. */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 5 ? 5 : 10;
  return step * p;
}

/**
 * Barras de magnitude numa única cor (o acento da página), com grade horizontal e eixo.
 * Valor exato aparece no hover/foco; há tabela equivalente para leitores de tela.
 */
export function Bars({ data, label, height = 168 }: { data: { key: string; value: number; hint?: string }[]; label: string; height?: number }) {
  const top = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => Math.round(top * f));
  const empty = data.every((d) => d.value === 0);
  return (
    <figure className="flex flex-1 flex-col">
      <div className="flex flex-1 gap-3">
        <div aria-hidden className="flex flex-col justify-between py-0 text-right font-mono text-[10px] tabular-nums text-bone-mute" style={{ height }}>
          {ticks.map((t, i) => <span key={i} className="-translate-y-1/2 leading-none last:translate-y-0">{t}</span>)}
        </div>
        <div className="relative flex-1">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 flex flex-col justify-between" style={{ height }}>
            {ticks.map((_, i) => <span key={i} className={cn("block h-px", i === ticks.length - 1 ? "bg-line" : "border-t border-dashed border-line/70")} />)}
          </div>
          <div role="img" aria-label={label} className="relative flex items-end gap-1.5" style={{ height }}>
            {data.map((d) => (
              <div key={d.key} tabIndex={0} className="group relative flex h-full flex-1 items-end justify-center outline-none">
                <span className="pointer-events-none absolute z-10 -translate-y-2 whitespace-nowrap rounded-sm border border-line bg-ink px-2 py-1 font-mono text-[11px] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100"
                  style={{ bottom: `${(d.value / top) * 100}%` }}>{d.hint ?? d.key}: {d.value}</span>
                <div className="w-full max-w-6 rounded-t-[3px] bg-acento/55 transition-colors group-hover:bg-acento group-focus:bg-acento"
                  style={{ height: d.value === 0 ? 0 : `${Math.max(2, (d.value / top) * 100)}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-1.5 text-center font-mono text-[10px] text-bone-mute">
            {data.map((d) => <span key={d.key} className="flex-1 truncate">{d.key}</span>)}
          </div>
          {empty && <p className="t-small absolute inset-x-0 top-1/3 text-center">Sem mensagens no período.</p>}
        </div>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>{data.map((d) => <tr key={d.key}><th scope="row">{d.hint ?? d.key}</th><td>{d.value}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

/** Indicador: rótulo, número e nota. Altura fixa para a linha de indicadores ficar simétrica. */
export function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "sun" | "navy" }) {
  return (
    <div className="vidro fio-topo flex h-full min-h-[148px] flex-col justify-between rounded-lg p-6" data-ativo={tone === "sun"}>
      <p className="eyebrow text-bone-mute">{label}</p>
      <p className={cn("display num text-[40px] leading-none", tone === "navy" ? "text-gold" : "text-bone")}>{value}</p>
      <p className="t-small min-h-[19px] truncate">{note ?? ""}</p>
    </div>
  );
}
