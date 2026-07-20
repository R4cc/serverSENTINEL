import { ApiError } from "../../api";
import type { FileEditLease, FileEntry } from "../../types";
import { errorMessage } from "../../utils/appHelpers";
import { isServerPropertiesPath } from "../../utils/permissions";

export function fileEditBlockedReason(path: string, serverRequiresStoppedForMutableConfig: boolean, stoppedServerMutationMessage: string) {
  return serverRequiresStoppedForMutableConfig && isServerPropertiesPath(path) ? stoppedServerMutationMessage : "";
}

export function unsupportedEditorMessage(entry: FileEntry) {
  if (entry.type !== "file") return "Folders cannot be edited in the browser editor.";
  if (entry.size > 2 * 1024 * 1024) return "Only files up to 2 MiB can be edited in the browser editor.";
  return "Only small text files can be edited in the browser editor.";
}

export function fileLeaseConflictMessage(error: unknown, formatDisplayDate: (value: string | number | Date) => string) {
  if (!(error instanceof ApiError) || (error.code !== "FILE_EDIT_LEASE_CONFLICT" && error.status !== 409)) {
    return errorMessage(error, "Could not acquire an edit lease for this file.");
  }
  const details = error.details as { lease?: FileEditLease } | undefined;
  if (details?.lease) {
    return `${details.lease.displayName || "Another user"} is editing this file. They were last active ${formatDisplayDate(details.lease.refreshedAt)}. You can try again after they close the editor.`;
  }
  return "Another editing session currently has exclusive access to this file. Try again after the other editor closes it.";
}

export function fileSaveError(error: unknown) {
  if (error instanceof ApiError && error.code === "FILE_REVISION_CONFLICT") {
    return {
      conflict: true,
      message: "The file changed outside this editor. Your changes were not saved. Reload the file before editing again."
    };
  }
  if (error instanceof ApiError && error.code === "FILE_EDIT_LEASE_LOST") {
    return {
      conflict: true,
      message: "Your edit lease expired or was lost. Your changes were not saved. Reload the file before editing again."
    };
  }
  return {
    conflict: false,
    message: errorMessage(error, "Could not save the file. Review the path and try again.")
  };
}
