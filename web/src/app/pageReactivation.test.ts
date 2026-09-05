import { describe, expect, it, vi } from "vitest";
import { subscribeToPageReactivation, type PageReactivationTargets } from "./pageReactivation";

function lifecycleTargets() {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  let hidden = false;
  Object.defineProperty(documentTarget, "hidden", { get: () => hidden });

  return {
    targets: {
      windowTarget: windowTarget as unknown as PageReactivationTargets["windowTarget"],
      documentTarget: documentTarget as unknown as PageReactivationTargets["documentTarget"]
    },
    windowTarget,
    documentTarget,
    setHidden: (value: boolean) => { hidden = value; }
  };
}

describe("subscribeToPageReactivation", () => {
  it("refreshes immediately once for a burst of resume and reconnect events", () => {
    const lifecycle = lifecycleTargets();
    const refresh = vi.fn();
    subscribeToPageReactivation(refresh, lifecycle.targets);

    lifecycle.windowTarget.dispatchEvent(new Event("focus"));
    lifecycle.windowTarget.dispatchEvent(new Event("online"));
    lifecycle.windowTarget.dispatchEvent(new Event("pageshow"));
    lifecycle.documentTarget.dispatchEvent(new Event("visibilitychange"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("allows a later reconnect to refresh again", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const lifecycle = lifecycleTargets();
    const refresh = vi.fn();
    const unsubscribe = subscribeToPageReactivation(refresh, lifecycle.targets);
    try {
      lifecycle.windowTarget.dispatchEvent(new Event("online"));
      now.mockReturnValue(1_100);
      lifecycle.windowTarget.dispatchEvent(new Event("focus"));
      expect(refresh).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_300);
      lifecycle.windowTarget.dispatchEvent(new Event("online"));
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      now.mockRestore();
    }
  });

  it("waits for visibility and removes every listener during cleanup", () => {
    const lifecycle = lifecycleTargets();
    const refresh = vi.fn();
    const unsubscribe = subscribeToPageReactivation(refresh, lifecycle.targets);

    lifecycle.setHidden(true);
    lifecycle.windowTarget.dispatchEvent(new Event("focus"));
    lifecycle.documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).not.toHaveBeenCalled();

    lifecycle.setHidden(false);
    lifecycle.documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);

    unsubscribe();
    lifecycle.windowTarget.dispatchEvent(new Event("focus"));
    lifecycle.windowTarget.dispatchEvent(new Event("online"));
    lifecycle.windowTarget.dispatchEvent(new Event("pageshow"));
    lifecycle.documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
