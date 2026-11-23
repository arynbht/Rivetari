import { ShieldBan } from "lucide-react";
import { useEffect, useState } from "react";

import { Card } from "@/components/ui/card";
import { errorMessage } from "@/lib/errors";

import { MAP_PARTITION, type MapView } from "../../shared/ipc";

// The floorplan skill's map of the repo, as the static page it draws in
// floorplan/. It runs in a webview on its own session, which the main process
// fences to that directory: anything else the page asks for (the waitlist's
// "Notify me", the Ask bar, a font from the web) is cancelled and listed here.
// Its server is never started, so the parts that need one stay inert.

/**
 * The map's session, which the main process guards and only lets the map's
 * webview attach to. Spread on, since React's lint rule doesn't know webview's
 * attributes.
 */
const MAP_GUEST = { partition: MAP_PARTITION };

export function RepoMap({ repoPath }: { repoPath: string }) {
  const [view, setView] = useState<MapView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.rivetari.map.onBlocked((next) => {
      if (active && next.repoPath === repoPath) setBlocked(next.urls);
    });
    window.rivetari.map.get(repoPath).then(
      (next) => active && setView(next),
      (err: unknown) => active && setError(errorMessage(err)),
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [repoPath]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Map</h2>
        <p className="text-xs text-muted-foreground">
          The floorplan skill&apos;s map of this repository, from{" "}
          <code>floorplan/index.html</code>. It runs offline: the shell blocks
          every request it makes outside <code>floorplan/</code>.
        </p>
      </div>

      {error && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-rose-300"
          role="alert"
        >
          {error}
        </p>
      )}

      {view === null && !error ? (
        <p className="text-sm text-muted-foreground">Looking for the map…</p>
      ) : view && view.url === null ? (
        <Card className="space-y-2 p-4 text-sm">
          <p className="font-medium">No map for this repository yet.</p>
          <p className="text-muted-foreground">
            Rivetari draws one when the repo&apos;s profile has{" "}
            <code>floorplan: true</code>: at <code>rivetari init</code>, and
            again each time a task&apos;s PR is merged and the task is closed.
          </p>
          <p className="text-xs text-muted-foreground">
            {view.floorplanOn
              ? "The profile has floorplan on; the map appears after the next init or merged close."
              : "The profile doesn't have floorplan on. Turning it on is a change to .rivetari/profile.yml."}
          </p>
        </Card>
      ) : view?.url ? (
        <>
          <webview
            src={view.url}
            {...MAP_GUEST}
            title="Floorplan map"
            className="w-full rounded-md border border-border"
            style={{ display: "flex", height: "70vh" }}
          />
          <section aria-labelledby="map-blocked" className="space-y-1">
            <h3
              id="map-blocked"
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
            >
              <ShieldBan className="h-3.5 w-3.5" aria-hidden />
              Blocked requests ({blocked.length})
            </h3>
            {blocked.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                The map hasn&apos;t asked for anything outside floorplan/.
              </p>
            ) : (
              <ul
                aria-label="Blocked requests"
                className="space-y-0.5 font-mono text-xs text-muted-foreground"
              >
                {blocked.map((url, i) => (
                  <li key={`${i}-${url}`} className="break-all">
                    {url}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
