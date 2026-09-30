import { useId, useRef, type RefObject } from "react";
import { Search, X } from "lucide-react";
import { Button } from "./UiPrimitives";

export function SearchField({ label, value, onChange, disabled = false, placeholder = label, inputRef, className = "" }: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
}) {
  const id = useId();
  const localInput = useRef<HTMLInputElement>(null);
  const input = inputRef ?? localInput;
  return (
    <div className={`uiSearchField ${className}`.trim()}>
      <Search aria-hidden="true" />
      <label className="srOnly" htmlFor={id}>{label}</label>
      <input ref={input} id={id} type="search" autoComplete="off" placeholder={placeholder} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      {value && <Button variant="ghost" iconOnly compact disabled={disabled} aria-label={`Clear ${label.toLowerCase()}`} onClick={() => { onChange(""); input.current?.focus(); }}><X aria-hidden="true" /></Button>}
    </div>
  );
}
