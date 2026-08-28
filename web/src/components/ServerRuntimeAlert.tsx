import type { ReactNode } from "react";
import { Banner } from "./UiPrimitives";

type ServerRuntimeAlertProps = {
  title: string;
  message?: string;
  compact?: boolean;
  action?: ReactNode;
};

export function ServerRuntimeAlert({ title, message, compact = false, action }: ServerRuntimeAlertProps) {
  return (
    <Banner
      tone="error"
      title={title}
      message={message}
      action={action}
      compact={compact}
      className={`serverRuntimeAlert${compact ? " compact" : ""}`}
    />
  );
}
