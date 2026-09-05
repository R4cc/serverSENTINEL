import { useEffect, useRef } from "react";

/** Visual progress is estimated between reports; accessible values remain measured. */
export function ToastProgress({ progress, status = "running", children }: {
  progress?: number;
  status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  children?: React.ReactNode;
}) {
  const fill = useRef<HTMLSpanElement>(null);
  const displayed = useRef(0);
  const previousStatus = useRef(status);
  const measured = progress === undefined || !Number.isFinite(progress) ? undefined : Math.max(0, Math.min(100, progress));
  const active = status === "running";

  useEffect(() => {
    // Sonner can reuse the same toast ID for a later update check.
    if ((active || status === "queued") && previousStatus.current !== "running" && previousStatus.current !== "queued") {
      displayed.current = 0;
    }
    previousStatus.current = status;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previous = performance.now();
    const paint = () => {
      if (fill.current) fill.current.style.transform = `scaleX(${displayed.current / 100})`;
    };
    const tick = (now: number) => {
      const elapsed = Math.min(now - previous, 100);
      previous = now;
      if (status === "succeeded") displayed.current = 100;
      else if (motion.matches) displayed.current = Math.min(99, measured ?? 0);
      else if (active) {
        // Catch up gently to real reports, then creep toward 95% over a long wait.
        // Preserve forward movement across stages whose reported percentage resets.
        const reported = Math.min(99, measured ?? 0);
        const ceiling = Math.max(95, reported);
        const target = Math.max(displayed.current, reported);
        displayed.current += (target - displayed.current) * (1 - Math.exp(-elapsed / 450));
        displayed.current += Math.max(0, ceiling - displayed.current) * (1 - Math.exp(-elapsed / 25000));
      }
      paint();
      if (active && !motion.matches) frame = requestAnimationFrame(tick);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      previous = performance.now();
      tick(previous);
    };
    restart();
    motion.addEventListener("change", restart);
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener("change", restart);
    };
  }, [active, measured, status]);

  return <div className="toastProgressDescription">
    {children && <div>{children}</div>}
    <div className="toastProgress" data-status={status} role="progressbar" aria-label="Operation progress"
      aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={status === "succeeded" ? 100 : measured}
      aria-valuetext={status === "succeeded" ? "Complete" : status === "queued" ? "Queued" : status === "failed" ? "Failed" : status === "cancelled" ? "Cancelled" : measured === undefined ? "In progress" : `${Math.round(measured)}% reported`}>
      <span ref={fill} className="toastProgressFill" />
    </div>
  </div>;
}
