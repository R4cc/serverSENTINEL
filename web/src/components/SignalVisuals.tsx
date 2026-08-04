import type { CSSProperties } from "react";

export type SignalGlyphKind = "overview" | "console" | "files" | "mods" | "schedules" | "properties" | "nodes" | "settings" | "create";
export type SignalIllustrationKind = "servers" | "players" | "files" | "mods" | "schedules" | "events" | "search";

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function signalFingerprintGeometry(serverId: string) {
  const hash = stableHash(serverId || "server");
  const rotation = hash % 360;
  const nodes = [0, 1, 2].map((index) => {
    const angle = ((hash >>> (index * 7)) % 360) * Math.PI / 180;
    const radius = index === 0 ? 7 : index === 1 ? 11 : 15;
    return {
      cx: Number((20 + Math.cos(angle) * radius).toFixed(2)),
      cy: Number((20 + Math.sin(angle) * radius).toFixed(2)),
      radius: index === 0 ? 1.8 : 1.45
    };
  });
  return { rotation, nodes };
}

export function SignalFingerprint({ serverId, className = "" }: { serverId: string; className?: string }) {
  const geometry = signalFingerprintGeometry(serverId);
  return (
    <svg className={`signalFingerprint ${className}`.trim()} viewBox="0 0 40 40" aria-hidden="true">
      <circle className="signalFingerprintField" cx="20" cy="20" r="18" />
      <circle className="signalFingerprintRing signalFingerprintRing--outer" cx="20" cy="20" r="14.5" />
      <circle className="signalFingerprintRing" cx="20" cy="20" r="9" />
      <g transform={`rotate(${geometry.rotation} 20 20)`}>
        <path className="signalFingerprintSweep" d="M20 20 33.2 12.4A15.2 15.2 0 0 1 35.2 20" />
      </g>
      <circle className="signalFingerprintCore" cx="20" cy="20" r="2.3" />
      {geometry.nodes.map((node, index) => <circle key={index} className="signalFingerprintNode" cx={node.cx} cy={node.cy} r={node.radius} />)}
    </svg>
  );
}

function GlyphPaths({ kind }: { kind: SignalGlyphKind }) {
  if (kind === "overview") return <><path d="M5 7h14M5 12h9M5 17h6" /><circle cx="18" cy="17" r="2" /></>;
  if (kind === "console") return <><path d="m6 8 4 4-4 4M12.5 16H18" /><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /></>;
  if (kind === "files") return <><path d="M3.5 7.5h6l2 2h9v10h-17Z" /><path d="M3.5 7.5V5h6l2 2" /></>;
  if (kind === "mods") return <><path d="M8 4h8v4h4v8h-4v4H8v-4H4V8h4Z" /><path d="M10 10h4v4h-4z" /></>;
  if (kind === "schedules") return <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16M9 15h3l3-3" /></>;
  if (kind === "properties") return <><path d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h3" /></>;
  if (kind === "nodes") return <><circle cx="12" cy="5.5" r="2.2" /><circle cx="6" cy="17.5" r="2.2" /><circle cx="18" cy="17.5" r="2.2" /><path d="m11 7.5-4 8m6-8 4 8M8.5 17.5h7" /></>;
  if (kind === "create") return <><circle cx="12" cy="12" r="7" /><path d="M12 8v8M8 12h8" /></>;
  return <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.12-1.3l2-1.55-2-3.46-2.47 1a7 7 0 0 0-2.26-1.3L13.8 2.7h-4l-.36 2.69a7 7 0 0 0-2.26 1.3l-2.47-1-2 3.46 2 1.55A7 7 0 0 0 4.6 12c0 .44.04.88.12 1.3l-2 1.55 2 3.46 2.47-1a7 7 0 0 0 2.26 1.3l.36 2.69h4l.36-2.69a7 7 0 0 0 2.26-1.3l2.47 1 2-3.46-2-1.55c.08-.42.12-.86.12-1.3Z" /></>;
}

export function SignalGlyph({ kind, className = "" }: { kind: SignalGlyphKind; className?: string }) {
  return (
    <span className={`signalGlyph ${className}`.trim()} aria-hidden="true">
      <svg viewBox="0 0 24 24"><GlyphPaths kind={kind} /></svg>
      <span className="signalGlyphPing" />
    </span>
  );
}

function IllustrationGlyph({ kind }: { kind: SignalIllustrationKind }) {
  if (kind === "players") return <><circle cx="32" cy="26" r="6" /><path d="M20 48c1.4-8 6-12 12-12s10.6 4 12 12" /></>;
  if (kind === "files") return <><path d="M18 24h15l5 5h12v20H18Z" /><path d="M18 24v-6h15l5 5" /></>;
  if (kind === "mods") return <><path d="M25 17h14v8h8v14h-8v8H25v-8h-8V25h8Z" /><path d="M29 29h6v6h-6z" /></>;
  if (kind === "schedules") return <><rect x="18" y="18" width="30" height="31" rx="4" /><path d="M25 14v8M41 14v8M18 27h30M27 38h6l6-7" /></>;
  if (kind === "events") return <><path d="M17 41h8l5-16 7 24 5-12h8" /><circle cx="52" cy="37" r="2" /></>;
  if (kind === "search") return <><circle cx="29" cy="29" r="12" /><path d="m38 38 11 11" /></>;
  return <><rect x="20" y="22" width="28" height="10" rx="3" /><rect x="20" y="37" width="28" height="10" rx="3" /><path d="M26 27h.01M26 42h.01" /></>;
}

export function SignalIllustration({ kind, compact = false }: { kind: SignalIllustrationKind; compact?: boolean }) {
  return (
    <span className={`signalIllustration${compact ? " signalIllustration--compact" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 72 64">
        <circle className="signalIllustrationRing signalIllustrationRing--outer" cx="36" cy="32" r="27" />
        <circle className="signalIllustrationRing" cx="36" cy="32" r="20" />
        <g className="signalIllustrationGlyph"><IllustrationGlyph kind={kind} /></g>
        <circle className="signalIllustrationNode" cx="57" cy="16" r="2.5" />
      </svg>
    </span>
  );
}

export function SignalMeter({ value }: { value: number }) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <span className="signalMeter" style={{ "--signal-meter-value": clamped } as CSSProperties} aria-hidden="true">
      <svg viewBox="0 0 36 36">
        <circle className="signalMeterTrack" cx="18" cy="18" r="14" />
        <circle className="signalMeterValue" cx="18" cy="18" r="14" pathLength="100" />
        <circle className="signalMeterCore" cx="18" cy="18" r="3" />
      </svg>
    </span>
  );
}
