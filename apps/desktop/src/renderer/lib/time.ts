import { useEffect, useState } from "react";

/** The ledger's own time format (ledger.md uses it too). */
export const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** "40 s" under a minute, "12 min" after. */
export const span = (ms: number) =>
  ms < 60_000
    ? `${Math.max(0, Math.floor(ms / 1000))} s`
    : `${Math.floor(ms / 60_000)} min`;

/** The clock, ticking each second while something is running, so the times stay live. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
