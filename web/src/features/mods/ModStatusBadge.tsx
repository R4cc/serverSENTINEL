import { StatusBadge } from "../../components/UiPrimitives";

// "update" means an update exists (informational), so it shares the accent. "restart" is the
// only warning-coloured chip, so a pending restart stands out from an available update.
type ModStatusTone = "ready" | "update" | "review" | "restart" | "not-recommended" | "unknown";

function sharedTone(tone: ModStatusTone) {
  if (tone === "ready") return "success";
  if (tone === "restart") return "warning";
  if (tone === "update" || tone === "review") return "accent";
  if (tone === "not-recommended") return "danger";
  return "neutral";
}

export function ModStatusBadge({ tone, children }: { tone: ModStatusTone; children: string }) {
  return <StatusBadge tone={sharedTone(tone)} className={`modsStatusChip ${tone}`}>{children}</StatusBadge>;
}
