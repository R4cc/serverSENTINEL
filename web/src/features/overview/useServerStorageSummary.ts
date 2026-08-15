import { useEffect, useMemo, useState } from "react";
import type { ServerStorageSummary } from "../../types";
import { clearCachedStorageSummary, readCachedStorageSummary, writeCachedStorageSummary } from "./storageSummaryCache";

type StorageSummaryState = {
  serverId: string;
  summary: ServerStorageSummary;
  loading: boolean;
};

const unavailableStorageSummary: ServerStorageSummary = {
  worldSizeBytes: null,
  totalBytes: null,
  availableBytes: null
};

export function useServerStorageSummary(
  serverId: string,
  active: boolean,
  loadStorageSummary: (serverId: string) => Promise<ServerStorageSummary>
) {
  const [state, setState] = useState<StorageSummaryState>({
    serverId: "",
    summary: unavailableStorageSummary,
    loading: false
  });
  // Reading storage is deferred to a memo so a re-render does not re-parse the entry, and so the
  // first render of a server already carries its last known figures instead of waiting an effect.
  const cachedSummary = useMemo(
    () => (serverId ? readCachedStorageSummary(serverId) : null) ?? unavailableStorageSummary,
    [serverId]
  );

  useEffect(() => {
    if (!active || !serverId) return;
    let cancelled = false;
    // A reload drops the figures held in memory. Seeding from the cache lets the tiles show the
    // last known sizes while the measurement runs, rather than sitting on a skeleton.
    setState((current) => current.serverId === serverId
      ? { ...current, loading: true }
      : { serverId, summary: cachedSummary, loading: true });

    void loadStorageSummary(serverId)
      .then((summary) => {
        writeCachedStorageSummary(serverId, summary);
        if (!cancelled) setState({ serverId, summary, loading: false });
      })
      .catch(() => {
        // A failed read must not leave a stale number standing in for a measurement that no
        // longer succeeds, so the cache goes with it and the tiles fall back to "Unavailable".
        clearCachedStorageSummary(serverId);
        if (!cancelled) setState({ serverId, summary: unavailableStorageSummary, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [active, cachedSummary, loadStorageSummary, serverId]);

  return state.serverId === serverId
    ? { ...state.summary, loading: state.loading }
    : { ...cachedSummary, loading: active };
}
