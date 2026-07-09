import type { FilePreview, ModrinthHit, ModrinthInstallVersionsResponse, ReleaseChannel } from "../types";

export type FilePreviewState = {
  path: string;
  loading: boolean;
  data: FilePreview | null;
  error: string;
};

export type ModInstallModalState = {
  mode: "install" | "switch";
  mod: ModrinthHit;
  sourceFilename?: string;
  step: 1 | 2;
  channel: ReleaseChannel;
  loading: boolean;
  installing: boolean;
  error: string;
  data: ModrinthInstallVersionsResponse | null;
  selectedVersionId: string;
  showOtherVersions: boolean;
  acknowledgeMinecraftMismatch: boolean;
};
