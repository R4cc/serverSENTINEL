import type { FileEntry } from "../../types";
import { fileDisplayType } from "../../utils/files";
import { nextTableSort, type SimpleTableSort } from "../../utils/table";

export type FileSortColumn = "name" | "modifiedAt" | "type" | "size";
type FileSort = SimpleTableSort<FileSortColumn>;

export const defaultFileSort: FileSort = { id: "name", desc: false };

export function nextFileSort(current: FileSort, id: FileSortColumn): FileSort {
  return nextTableSort(current, id);
}

// `localeCompare` without options resolves the default locale on every call; a shared collator
// gives the same order without that per-comparison cost, which dominates sorting a large folder.
const nameCollator = new Intl.Collator();

/**
 * Sorts a folder listing. Each entry's sort key is derived once rather than inside the
 * comparator, where a date parse or the type lookup's regex chain would otherwise run
 * O(n log n) times.
 */
export function sortFileEntries(entries: FileEntry[], sort: FileSort): FileEntry[] {
  const keyed = entries.map((entry) => ({
    entry,
    directory: entry.type === "directory",
    key: sort.id === "modifiedAt" ? new Date(entry.modifiedAt).getTime()
      : sort.id === "type" ? fileDisplayType(entry)
        : sort.id === "size" ? entry.size
          : entry.name
  }));
  const compareKey = (left: string | number, right: string | number) =>
    typeof left === "number" && typeof right === "number" ? left - right : nameCollator.compare(String(left), String(right));

  keyed.sort((left, right) => {
    const folderOrder = Number(right.directory) - Number(left.directory);
    if (folderOrder !== 0) return folderOrder;
    const compared = compareKey(left.key, right.key) || nameCollator.compare(left.entry.name, right.entry.name);
    return sort.desc ? -compared : compared;
  });
  return keyed.map((item) => item.entry);
}
