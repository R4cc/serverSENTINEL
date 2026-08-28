import type { Header } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { Button } from "./UiPrimitives";

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

  return (
    <TableSortButton
      sorted={sorted}
      onClick={canSort ? () => header.column.toggleSorting() : undefined}
      disabled={!canSort}
      label={typeof children === "string" ? children : "this column"}
    >
      {children}
    </TableSortButton>
  );
}

export function TableSortButton({
  sorted,
  onClick,
  disabled = false,
  label,
  children
}: {
  sorted: false | "asc" | "desc";
  onClick?: () => void;
  disabled?: boolean;
  label: string;
  children: ReactNode;
}) {
  const indicator = sorted === "asc" ? "↑" : sorted === "desc" ? "↓" : "↕";

  return (
    <button
      type="button"
      className="uiSortHeaderButton"
      onClick={onClick}
      disabled={disabled}
      title={!disabled ? `Sort by ${label}` : undefined}
    >
      {children}
      {!disabled && <span className="uiSortIndicator" aria-hidden="true">{indicator}</span>}
    </button>
  );
}

export function TablePagination({
  pageIndex,
  pageSize,
  totalItems,
  itemLabel,
  onPageChange
}: {
  pageIndex: number;
  pageSize: number;
  totalItems: number;
  itemLabel: string;
  onPageChange: (pageIndex: number) => void;
}) {
  if (totalItems <= 0) return null;
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(0, pageIndex), pageCount - 1);
  const firstItem = currentPage * pageSize + 1;
  const lastItem = Math.min(totalItems, firstItem + pageSize - 1);

  return (
    <div className="uiTablePagination">
      <span className="uiTableRange" aria-live="polite">Showing {firstItem}–{lastItem} of {totalItems} {itemLabel}</span>
      <nav className="uiTablePager" aria-label={`${itemLabel} pagination`}>
        <Button variant="ghost" compact disabled={currentPage === 0} onClick={() => onPageChange(currentPage - 1)}>Previous</Button>
        <span>Page {currentPage + 1} of {pageCount}</span>
        <Button variant="ghost" compact disabled={currentPage >= pageCount - 1} onClick={() => onPageChange(currentPage + 1)}>Next</Button>
      </nav>
    </div>
  );
}
