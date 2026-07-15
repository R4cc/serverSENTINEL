import { useEffect, useRef, type RefObject } from "react";

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(", ");

const dialogStack: symbol[] = [];
let bodyLockCount = 0;
let previousBodyOverflow = "";
let previousDocumentOverflow = "";
type DialogTrackingWindow = Window & {
  __serverSentinelDialogTriggerTracking?: boolean;
  __serverSentinelDialogTrigger?: HTMLElement | null;
  __serverSentinelDialogTriggerAt?: number;
};

if (typeof document !== "undefined") {
  const trackingWindow = window as DialogTrackingWindow;
  if (!trackingWindow.__serverSentinelDialogTriggerTracking) {
    document.addEventListener("pointerdown", (event) => {
      if (event.target instanceof HTMLElement) {
        trackingWindow.__serverSentinelDialogTrigger = event.target.closest<HTMLElement>(focusableSelector) || event.target;
        trackingWindow.__serverSentinelDialogTriggerAt = performance.now();
      }
    }, true);
    trackingWindow.__serverSentinelDialogTriggerTracking = true;
  }
}

export function useDialogFocus<T extends HTMLElement>({
  onClose,
  initialFocusRef
}: {
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialogId = Symbol("dialog");
    const activeElement = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    const trackingWindow = window as DialogTrackingWindow;
    const pointerTrigger = trackingWindow.__serverSentinelDialogTrigger;
    const recentPointerTrigger = pointerTrigger?.isConnected && performance.now() - (trackingWindow.__serverSentinelDialogTriggerAt || 0) < 1_000
      ? pointerTrigger
      : null;
    const trigger = recentPointerTrigger || activeElement;
    dialogStack.push(dialogId);

    if (bodyLockCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      previousDocumentOverflow = document.documentElement.style.overflow;
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
    }
    bodyLockCount += 1;

    const focusTarget = initialFocusRef?.current ?? dialogRef.current;
    focusTarget?.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== dialogId) return;
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
      if (!focusable.length) {
        event.preventDefault();
        dialog?.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    const blockOutsideScroll = (event: WheelEvent | TouchEvent) => {
      if (dialogStack.at(-1) !== dialogId) return;
      const dialog = dialogRef.current;
      if (dialog && event.target instanceof Node && dialog.contains(event.target)) return;
      if (event.cancelable) event.preventDefault();
    };

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("wheel", blockOutsideScroll, { capture: true, passive: false });
    document.addEventListener("touchmove", blockOutsideScroll, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("wheel", blockOutsideScroll, true);
      document.removeEventListener("touchmove", blockOutsideScroll, true);
      const stackIndex = dialogStack.lastIndexOf(dialogId);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      bodyLockCount = Math.max(0, bodyLockCount - 1);
      if (bodyLockCount === 0) {
        document.body.style.overflow = previousBodyOverflow;
        document.documentElement.style.overflow = previousDocumentOverflow;
      }
      if (trigger?.isConnected) window.setTimeout(() => trigger.focus({ preventScroll: true }), 0);
    };
  }, [initialFocusRef]);

  return dialogRef;
}
