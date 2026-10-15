import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export type ConfirmationOptions = {
  title: string;
  description: string;
  details?: ReactNode;
  warning?: string;
  warningTone?: "warning" | "danger";
  textInput?: {
    label: string;
    description?: string;
    placeholder?: string;
    required?: boolean;
    maxLength?: number;
    rows?: number;
  };
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "primary" | "critical";
};

export type RequestConfirmation = (options: ConfirmationOptions) => Promise<boolean>;
export type RequestTextConfirmation = (options: ConfirmationOptions & { textInput: NonNullable<ConfirmationOptions["textInput"]> }) => Promise<string | null>;

type ConfirmationOutcome = {
  confirmed: boolean;
  textValue: string;
};

export function useConfirmationController() {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null);
  const resolverRef = useRef<((outcome: ConfirmationOutcome) => void) | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const settle = useCallback((confirmed: boolean, textValue = "") => {
    const resolve = resolverRef.current;
    const trigger = triggerRef.current;
    resolverRef.current = null;
    triggerRef.current = null;
    setOptions(null);
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    resolve?.({ confirmed, textValue: textValue.trim() });
  }, []);

  const requestOutcome = useCallback((nextOptions: ConfirmationOptions) => {
    if (resolverRef.current) {
      resolverRef.current({ confirmed: false, textValue: "" });
    } else {
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    setOptions(nextOptions);
    return new Promise<ConfirmationOutcome>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const requestConfirmation = useCallback<RequestConfirmation>(async (nextOptions) => (
    await requestOutcome(nextOptions)
  ).confirmed, [requestOutcome]);

  const requestTextConfirmation = useCallback<RequestTextConfirmation>(async (nextOptions) => {
    const outcome = await requestOutcome(nextOptions);
    return outcome.confirmed ? outcome.textValue : null;
  }, [requestOutcome]);

  useEffect(() => () => {
    resolverRef.current?.({ confirmed: false, textValue: "" });
    resolverRef.current = null;
  }, []);

  return { options, requestConfirmation, requestTextConfirmation, settle };
}

