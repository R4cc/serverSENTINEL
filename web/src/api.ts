export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const demoMode = window.localStorage.getItem("serversentinel-demo-mode") === "true";
  const headers = {
    "X-Requested-With": "XMLHttpRequest",
    ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(demoMode ? { "X-ServerSentinel-Demo-Mode": "true" } : {}),
    ...(init?.headers as Record<string, string> | undefined)
  };
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? `Request failed with ${response.status}`);
  }
  return payload as T;
}
