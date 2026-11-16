import type {
  VersionSwitchContentAction,
  VersionSwitchContentEntry,
  VersionSwitchOutcome,
  VersionSwitchOutcomeStatus,
  VersionSwitchPlan
} from "@serversentinel/contracts";

export type VersionSwitchRow = {
  key: string;
  name: string;
  iconUrl?: string;
  fromVersion?: string;
  toVersion?: string;
  detail: string;
};

export type VersionSwitchGroupTone = "danger" | "warning" | "accent" | "success" | "neutral";

export type VersionSwitchGroup = {
  id: string;
  title: string;
  tone: VersionSwitchGroupTone;
  /** Unremarkable groups start collapsed so the overview opens on what changes. */
  collapsed: boolean;
  rows: VersionSwitchRow[];
};

const planGroups: Array<{ action: VersionSwitchContentAction; title: string; tone: VersionSwitchGroupTone; collapsed: boolean }> = [
  { action: "disable", title: "Will be disabled", tone: "danger", collapsed: false },
  { action: "install", title: "New dependencies", tone: "accent", collapsed: false },
  { action: "update", title: "Will switch version", tone: "success", collapsed: false },
  { action: "keep", title: "Already compatible", tone: "neutral", collapsed: true },
  { action: "unchanged", title: "Already disabled", tone: "neutral", collapsed: true }
];

const outcomeGroups: Array<{ status: VersionSwitchOutcomeStatus; title: string; tone: VersionSwitchGroupTone; collapsed: boolean }> = [
  { status: "failed", title: "Needs attention", tone: "danger", collapsed: false },
  { status: "disabled", title: "Disabled", tone: "warning", collapsed: false },
  { status: "installed", title: "Installed", tone: "accent", collapsed: false },
  { status: "updated", title: "Switched version", tone: "success", collapsed: false },
  { status: "kept", title: "Already compatible", tone: "neutral", collapsed: true },
  { status: "unchanged", title: "Left disabled", tone: "neutral", collapsed: true }
];

function planRow(entry: VersionSwitchContentEntry): VersionSwitchRow {
  const detail = entry.action === "install" && entry.requiredBy?.length
    ? `Required by ${entry.requiredBy.join(", ")}.`
    : entry.reason;
  return {
    key: `${entry.action}:${entry.filename}`,
    name: entry.displayName,
    iconUrl: entry.iconUrl,
    fromVersion: entry.action === "install" ? undefined : entry.currentVersion,
    toVersion: entry.action === "update" || entry.action === "install" ? entry.targetVersion : undefined,
    detail
  };
}

export function versionSwitchPlanGroups(plan: VersionSwitchPlan): VersionSwitchGroup[] {
  return planGroups.flatMap((group) => {
    const rows = plan.content.filter((entry) => entry.action === group.action).map(planRow);
    return rows.length ? [{ id: group.action, title: group.title, tone: group.tone, collapsed: group.collapsed, rows }] : [];
  });
}

export function versionSwitchOutcomeGroups(plan: VersionSwitchPlan, outcomes: VersionSwitchOutcome[]): VersionSwitchGroup[] {
  const planned = new Map(plan.content.map((entry) => [entry.filename, entry]));
  return outcomeGroups.flatMap((group) => {
    const rows = outcomes.filter((outcome) => outcome.status === group.status).map((outcome): VersionSwitchRow => {
      const entry = planned.get(outcome.filename);
      return {
        key: `${outcome.status}:${outcome.filename}`,
        name: outcome.displayName,
        iconUrl: entry?.iconUrl,
        fromVersion: outcome.status === "updated" ? entry?.currentVersion : undefined,
        toVersion: outcome.status === "updated" || outcome.status === "installed" ? outcome.version : undefined,
        detail: outcome.reason ?? ""
      };
    });
    return rows.length ? [{ id: group.status, title: group.title, tone: group.tone, collapsed: group.collapsed, rows }] : [];
  });
}

/** One line describing what the switch will do to installed content, for the review summary. */
export function versionSwitchPlanSummary(plan: VersionSwitchPlan) {
  const singular = plan.contentKind === "plugins" ? "plugin" : "mod";
  const count = (value: number, noun = singular, plural = `${noun}s`) => `${value} ${value === 1 ? noun : plural}`;
  const parts = [
    plan.counts.update ? `${count(plan.counts.update)} ${plan.counts.update === 1 ? "switches" : "switch"} version` : "",
    plan.counts.install ? `${count(plan.counts.install, "dependency", "dependencies")} added` : "",
    plan.counts.disable ? `${count(plan.counts.disable)} disabled` : "",
    plan.counts.keep ? `${plan.counts.keep} already compatible` : ""
  ].filter(Boolean);
  if (!parts.length) return plan.content.length ? `No ${plan.contentKind} change.` : `No ${plan.contentKind} installed.`;
  return `${parts.join(" · ")}.`;
}
