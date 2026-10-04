/** Long-lived sockets must not retain the user snapshot cached during the HTTP handshake. */
export function watchSocketAuthorization(check: () => boolean, revoke: () => void, intervalMs = 5_000) {
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const allow = () => {
    if (stopped) return false;
    let authorized = false;
    try { authorized = check(); } catch { /* Fail closed if current session state cannot be read. */ }
    if (!authorized) {
      stop();
      revoke();
    }
    return authorized;
  };
  const timer = setInterval(allow, intervalMs);
  timer.unref();
  return { allow, stop };
}
