"use client";

import { useEffect, useRef } from "react";

/** Rola a tela (inclusive o funil horizontal) até o elemento pai e o deixa no centro. */
export function FocusHere() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (el) setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" }), 150);
  }, []);
  return <span ref={ref} hidden />;
}
