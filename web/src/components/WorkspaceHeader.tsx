import type { ReactNode } from "react";
import type { SignalGlyphKind } from "./SignalVisuals";
import { SignalGlyph } from "./SignalVisuals";

export function WorkspaceHeader({ title, subtitle, glyph, actions }: { title: string; subtitle: string; glyph: SignalGlyphKind; actions?: ReactNode }) {
  return (
    <header className="workspaceHeader">
      <div className="workspaceHeaderIdentity">
        <SignalGlyph kind={glyph} className="workspaceHeaderGlyph" />
        <div className="workspaceHeaderCopy">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="workspaceHeaderSignal" aria-hidden="true">
        <span /><span /><span /><i />
      </div>
      <div className="workspaceActions">{actions}</div>
    </header>
  );
}
