import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { ManagedServer, Notify, PlayerInsightsResponse } from "../../types";
import { errorMessage } from "../../utils/appHelpers";
import { subscribeToPageReactivation } from "../../app/pageReactivation";
import { demoPlayerInsights } from "./playersDemoFixtures";
import { rangeWindowMs, type PlayerInsightsRange } from "./playerInsightsView";

const refreshIntervalMs = 30_000;

/**
 * The Players workspace's own state, held inside the module's chunk rather than in the shell.
 *
 * It polls only while its page is open, because nothing outside the module reads it — unlike
 * managed content, which backs a card on the overview and therefore has to outlive its page.
 */
export function usePlayersWorkspace(inputs: {
  active: boolean;
  activeServer: ManagedServer | null;
  activeServerIsDemo: boolean;
  demoRunning: boolean;
  canManage: boolean;
  notify: Notify;
  handleStaleSession(error: unknown): boolean;
}) {
  const [range, setRange] = useState<PlayerInsightsRange>("24h");
  const [insights, setInsights] = useState<PlayerInsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const serverId = inputs.activeServer?.id ?? "";
  const inFlightRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const loadedServerRef = useRef("");
  /**
   * The shell rebuilds these on every render, and the poll below depends on `load`. Holding them
   * through refs is what keeps `load` stable: with them in its dependency list the whole polling
   * effect tore down and re-fired on every render of the shell, which is one request per console
   * line on a busy server.
   */
  const notifyRef = useRef(inputs.notify);
  notifyRef.current = inputs.notify;
  const staleSessionRef = useRef(inputs.handleStaleSession);
  staleSessionRef.current = inputs.handleStaleSession;

  const load = useCallback(async (options: { showLoading?: boolean; replace?: boolean } = {}) => {
    if (!serverId) return;
    const requestKey = `${inputs.activeServerIsDemo ? "demo" : "remote"}:${serverId}:${range}`;
    if (inFlightRef.current?.key === requestKey && !options.replace) return;
    // A request for another server or range no longer owns this workspace. Abort it before the new
    // request starts so it cannot suppress the load or paint its response under the new heading.
    inFlightRef.current?.controller.abort();
    inFlightRef.current = null;
    if (inputs.activeServerIsDemo) {
      setInsights(demoPlayerInsights(serverId, inputs.demoRunning, range));
      setError("");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    inFlightRef.current = { key: requestKey, controller };
    if (options.showLoading) setLoading(true);
    try {
      const data = await api<PlayerInsightsResponse>(
        `/api/players/insights?serverId=${encodeURIComponent(serverId)}&windowMs=${rangeWindowMs(range)}`,
        { signal: controller.signal, timeoutMs: 15_000 }
      );
      if (controller.signal.aborted) return;
      setInsights(data);
      setError("");
    } catch (requestError) {
      if (controller.signal.aborted) return;
      if (staleSessionRef.current(requestError)) return;
      // Whatever was loaded before is left on screen: a failed refresh should not blank a page the
      // operator is reading, so the message sits beside the data it could not replace.
      setError(errorMessage(requestError, "Could not load player insights."));
    } finally {
      if (inFlightRef.current?.controller === controller) {
        inFlightRef.current = null;
        setLoading(false);
      }
    }
  }, [serverId, range, inputs.activeServerIsDemo, inputs.demoRunning]);

  // Declared before the load below, and it has to stay there: effects run in declaration order, and
  // the demo path resolves synchronously, so a reset that ran afterwards would clear the data the
  // load had just produced and leave the workspace permanently empty.
  useEffect(() => {
    // Another server's players are another page's data; showing the previous one while the next
    // loads would attribute one server's geography to another.
    inFlightRef.current?.controller.abort();
    inFlightRef.current = null;
    setLoading(false);
    setInsights(null);
    setError("");
  }, [serverId]);

  useEffect(() => () => {
    inFlightRef.current?.controller.abort();
    inFlightRef.current = null;
  }, []);

  useEffect(() => {
    if (!inputs.active || !serverId) return;
    const firstLoadForServer = loadedServerRef.current !== `${serverId}:${range}`;
    loadedServerRef.current = `${serverId}:${range}`;
    void load({ showLoading: firstLoadForServer });
    const interval = window.setInterval(() => {
      if (!document.hidden) void load();
    }, refreshIntervalMs);
    const unsubscribe = subscribeToPageReactivation(() => void load());
    return () => {
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [inputs.active, serverId, range, load]);

  const saveServerAddress = useCallback(async (address: string) => {
    if (!serverId || !inputs.canManage || busy) return false;
    setBusy(true);
    try {
      await api(`/api/players/servers/${encodeURIComponent(serverId)}/location`, {
        method: "PUT",
        body: JSON.stringify({ address })
      });
      await load({ replace: true });
      notifyRef.current("success", address ? "Server location updated" : "Server location cleared");
      return true;
    } catch (requestError) {
      if (staleSessionRef.current(requestError)) return false;
      notifyRef.current("error", errorMessage(requestError, "Could not save the server location."));
      return false;
    } finally {
      setBusy(false);
    }
  }, [serverId, inputs.canManage, busy, load]);

  const refreshGeoDatabase = useCallback(async () => {
    if (!inputs.canManage || busy) return false;
    setBusy(true);
    try {
      await api("/api/players/geo-database/refresh", { method: "POST" });
      await load({ replace: true });
      notifyRef.current("success", "GeoLite2 database checked");
      return true;
    } catch (requestError) {
      if (staleSessionRef.current(requestError)) return false;
      notifyRef.current("error", errorMessage(requestError, "Could not update the GeoLite2 database."));
      return false;
    } finally {
      setBusy(false);
    }
  }, [inputs.canManage, busy, load]);

  return {
    insights,
    loading: loading && !insights,
    error,
    busy,
    range,
    setRange,
    reload: () => void load({ showLoading: true }),
    saveServerAddress,
    refreshGeoDatabase
  };
}
