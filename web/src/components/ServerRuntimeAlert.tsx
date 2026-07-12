type ServerRuntimeAlertProps = {
  title: string;
  message?: string;
  compact?: boolean;
};

export function ServerRuntimeAlert({ title, message, compact = false }: ServerRuntimeAlertProps) {
  return (
    <section className={`serverRuntimeAlert${compact ? " compact" : ""}`} role="alert">
      <span className="serverRuntimeAlertIcon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.3 3.7 2.5 17.2A2 2 0 0 0 4.2 20h15.6a2 2 0 0 0 1.7-2.8L13.7 3.7a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      </span>
      <span className="serverRuntimeAlertCopy">
        <strong>{title}</strong>
        {message && <span>{message}</span>}
      </span>
    </section>
  );
}
