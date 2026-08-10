import type { Header } from "@tanstack/react-table";
import type { ReactNode } from "react";

/**
 * `aria-sort` belongs on the header cell, not on the control inside it, so the
 * cell wrapper takes it and the button stays a plain button.
 */
export function headerAriaSort<TData, TValue>(header: Header<TData, TValue>) {
  if (!header.column.getCanSort()) return undefined;
  const sorted = header.column.getIsSorted();
  return sorted === "asc" ? "ascending" as const : sorted === "desc" ? "descending" as const : "none" as const;
}

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
      title={canSort ? `Sort by ${typeof children === "string" ? children : "this column"}` : undefined}
    >
      {children}
      {canSort && <span className="uiSortIndicator" aria-hidden="true">{indicator}</span>}
    </button>
  );
}
