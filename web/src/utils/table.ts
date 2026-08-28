export type SimpleTableSort<Column extends string> = {
  id: Column;
  desc: boolean;
};

export function nextTableSort<Column extends string>(current: SimpleTableSort<Column>, id: Column): SimpleTableSort<Column> {
  return current.id === id ? { id, desc: !current.desc } : { id, desc: false };
}

export function simpleTableAriaSort<Column extends string>(sort: SimpleTableSort<Column>, id: Column) {
  if (sort.id !== id) return "none" as const;
  return sort.desc ? "descending" as const : "ascending" as const;
}
