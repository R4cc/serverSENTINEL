export type ModHistoryVersion = {
  filename: string;
  version: string | null;
  enabled: boolean;
};

export type ModHistoryEntry = {
  id: string;
  modName: string;
  iconUrl?: string;
  action: "installed" | "updated" | "removed" | "enabled" | "disabled";
  before: ModHistoryVersion | null;
  after: ModHistoryVersion | null;
  occurredAt: string;
  user: { id: string; username: string };
  revertsEntryId: string | null;
  revertedAt: string | null;
  canRevert: boolean;
  revertBlockedReason: string | null;
};

export type ModHistoryResponse = { entries: ModHistoryEntry[]; total: number; limit: number; offset: number };
