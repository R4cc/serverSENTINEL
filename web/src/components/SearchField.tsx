import { useId, useRef } from "react";
import { Search, X } from "lucide-react";
import { Button } from "./UiPrimitives";

export function SearchField({ label, value, onChange }: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="uiSearchField">
      <Search aria-hidden="true" />
      <label className="srOnly" htmlFor={id}>{label}</label>
      <input ref={input} id={id} type="search" autoComplete="off" placeholder={label} value={value} onChange={(event) => onChange(event.target.value)} />
      {value && <Button variant="ghost" iconOnly compact aria-label={`Clear ${label.toLowerCase()}`} onClick={() => { onChange(""); input.current?.focus(); }}><X aria-hidden="true" /></Button>}
    </div>
  );
}
