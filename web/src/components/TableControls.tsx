import type { Header } from "@tanstack/react-table";
import type { ReactNode } from "react";

export function SortHeaderButton<TData, TValue>({
  header,
  children
}: {
  header: Header<TData, TValue>;
  children: ReactNode;
}) {
  const sorted = header.column.getIsSorted();
  const canSort = header.column.getCanSort();
  const indicator = sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : "↕";

  return (
    <button
      type="button"
      className="uiSortHeaderButton"
      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
      disabled={!canSort}
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
    >
      {children}
      {canSort && <span className="uiSortIndicator" aria-hidden="true">{indicator}</span>}
    </button>
  );
}
