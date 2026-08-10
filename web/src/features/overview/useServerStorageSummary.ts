import { useEffect, useState } from "react";
import type { ServerStorageSummary } from "../../types";

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

  useEffect(() => {
    if (!active || !serverId) return;
    let cancelled = false;
    setState((current) => current.serverId === serverId
      ? { ...current, loading: true }
      : { serverId, summary: unavailableStorageSummary, loading: true });

    void loadStorageSummary(serverId)
      .then((summary) => {
        if (!cancelled) setState({ serverId, summary, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ serverId, summary: unavailableStorageSummary, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [active, loadStorageSummary, serverId]);

  return state.serverId === serverId
    ? { ...state.summary, loading: state.loading }
    : { ...unavailableStorageSummary, loading: active };
}
