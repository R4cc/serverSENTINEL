import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api";
import type { ServerStorageSummary } from "../../types";
import { subscribeToPageReactivation } from "../../app/pageReactivation";
import { clearCachedStorageSummary, readCachedStorageSummary, writeCachedStorageSummary } from "./storageSummaryCache";

type StorageSummaryState = {
  serverId: string;
  summary: ServerStorageSummary;
  loading: boolean;
  error: string;
};

const unavailableStorageSummary: ServerStorageSummary = {
  worldSizeBytes: null,
  totalBytes: null,
  availableBytes: null
};

export function useServerStorageSummary(
  serverId: string,
  active: boolean,
  loadStorageSummary: (serverId: string, signal?: AbortSignal) => Promise<ServerStorageSummary>,
  cacheScope: string
) {
  const [state, setState] = useState<StorageSummaryState>({
    serverId: "",
    summary: unavailableStorageSummary,
    error: "",
    loading: false
  });
  // Reading storage is deferred to a memo so a re-render does not re-parse the entry, and so the
  // first render of a server already carries its last known figures instead of waiting an effect.
  const cacheKey = JSON.stringify([cacheScope, serverId]);
  const cachedSummary = useMemo(
    () => (serverId ? readCachedStorageSummary(cacheKey) : null) ?? unavailableStorageSummary,
    [cacheKey, serverId]
  );

  useEffect(() => {
    if (!active || !serverId) return;
    let cancelled = false;
    const controller = new AbortController();
    let requestId = 0;
    let requestInFlight = false;

    const load = () => {
      // Focus and visibilitychange commonly arrive together when a tab is restored. Measuring a
      // large world twice only makes both requests slower, so let the active read satisfy every
      // reactivation signal until it settles.
      if (requestInFlight) return;
      requestInFlight = true;
      const currentRequestId = ++requestId;
      // A reload drops the figures held in memory. Seeding from the cache lets the tiles show the
      // last known sizes while the measurement runs, rather than sitting on a skeleton.
      setState((current) => current.serverId === cacheKey
        ? { ...current, loading: true }
        : { serverId: cacheKey, summary: cachedSummary, loading: true, error: "" });
      void loadStorageSummary(serverId, controller.signal)
        .then((summary) => {
          if (cancelled || currentRequestId !== requestId) return;
          writeCachedStorageSummary(cacheKey, summary);
          setState({ serverId: cacheKey, summary, loading: false, error: "" });
        })
        .catch((error: unknown) => {
          if (cancelled || currentRequestId !== requestId) return;
          const accessDenied = error instanceof ApiError && [401, 403, 404].includes(error.status);
          if (accessDenied) clearCachedStorageSummary(cacheKey);
          setState((current) => ({
            ...current,
            summary: accessDenied ? unavailableStorageSummary : current.summary,
            loading: false,
            error: "Storage could not be refreshed. Last measured sizes are shown when available."
          }));
        })
        .finally(() => {
          if (currentRequestId === requestId) requestInFlight = false;
        });
    };

    load();
    const unsubscribe = subscribeToPageReactivation(load);

    return () => {
      cancelled = true;
      controller.abort();
      unsubscribe();
    };
  }, [active, cacheKey, cachedSummary, loadStorageSummary, serverId]);

  return state.serverId === cacheKey
    ? { ...state.summary, loading: state.loading, error: state.error }
    : { ...cachedSummary, loading: active, error: "" };
}
