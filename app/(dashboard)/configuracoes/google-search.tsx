"use client";

import { useState, useTransition } from "react";
import { Loader2, Search, Star } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { searchGooglePlaceAction } from "./actions";

/** Acha a clínica no Google pelo nome e cidade e preenche o Place ID do formulário. */
export function GooglePlaceSearch({ defaultQuery }: { defaultQuery: string }) {
  const [term, setTerm] = useState(defaultQuery);
  const [result, setResult] = useState<Awaited<ReturnType<typeof searchGooglePlaceAction>> | null>(null);
  const [pending, start] = useTransition();
  const pick = (id: string) => {
    const input = document.querySelector<HTMLInputElement>('input[name="placeId"]');
    if (input) { input.value = id; input.focus(); }
  };
  return (
    <div className="space-y-3 rounded-lg border border-line p-4">
      <p className="text-[13px] font-medium">Encontrar a clínica no Google</p>
      <div className="flex gap-2">
        <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Nome da clínica e cidade" aria-label="Buscar no Google" />
        <Button type="button" variant="outline" disabled={pending} onClick={() => start(async () => setResult(await searchGooglePlaceAction(term)))}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Search aria-hidden />} Buscar
        </Button>
      </div>
      {result?.error && <p className="t-small text-danger">{result.error}</p>}
      {result && !result.error && result.places.length === 0 && <p className="t-small">Nada encontrado. Tente com a cidade ou o bairro.</p>}
      <ul className="space-y-2">
        {result?.places.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => pick(p.id)} className="flex w-full items-center gap-3 rounded-md border border-line px-3 py-2.5 text-left transition-colors hover:border-acento">
              <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{p.name}</span><span className="t-small block truncate">{p.address}</span></span>
              <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-bone-dim"><Star size={13} className="text-gold" aria-hidden />{p.rating?.toFixed(1).replace(".", ",") ?? "—"} · {p.reviewCount}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
