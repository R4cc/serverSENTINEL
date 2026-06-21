import { StatusBadge } from "../../components/UiPrimitives";

type ModStatusTone = "ready" | "update" | "review" | "not-recommended" | "unknown";

function sharedTone(tone: ModStatusTone) {
  if (tone === "ready") return "success";
  if (tone === "update") return "warning";
  if (tone === "review") return "accent";
  if (tone === "not-recommended") return "danger";
  return "neutral";
}

export function ModStatusBadge({ tone, children }: { tone: ModStatusTone; children: string }) {
  return <StatusBadge tone={sharedTone(tone)} className={`modsStatusChip ${tone}`}>{children}</StatusBadge>;
}
