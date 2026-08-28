import type { FileEntry } from "../../types";
import { fileDisplayType } from "../../utils/files";
import { nextTableSort, type SimpleTableSort } from "../../utils/table";

export type FileSortColumn = "name" | "modifiedAt" | "type" | "size";
type FileSort = SimpleTableSort<FileSortColumn>;

export const defaultFileSort: FileSort = { id: "name", desc: false };

export function nextFileSort(current: FileSort, id: FileSortColumn): FileSort {
  return nextTableSort(current, id);
}

export function sortFileEntries(entries: FileEntry[], sort: FileSort): FileEntry[] {
  const compareValue = (left: FileEntry, right: FileEntry) => {
    if (sort.id === "modifiedAt") return new Date(left.modifiedAt).getTime() - new Date(right.modifiedAt).getTime();
    if (sort.id === "type") return fileDisplayType(left).localeCompare(fileDisplayType(right));
    if (sort.id === "size") return left.size - right.size;
    return left.name.localeCompare(right.name);
  };

  return [...entries].sort((left, right) => {
    const folderOrder = Number(right.type === "directory") - Number(left.type === "directory");
    if (folderOrder !== 0) return folderOrder;
    const compared = compareValue(left, right) || left.name.localeCompare(right.name);
    return sort.desc ? -compared : compared;
  });
}
