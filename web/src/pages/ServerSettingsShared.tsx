import type { CSSProperties } from "react";
import type { MemoryBounds } from "./serverSettingsHelpers";

export function MemoryRangeControl({
  bounds,
  minimumHeapGb,
  maximumHeapGb,
  onMinimumHeapChange,
  onMaximumHeapChange
}: {
  bounds: MemoryBounds;
  minimumHeapGb: number;
  maximumHeapGb: number;
  onMinimumHeapChange: (value: number) => void;
  onMaximumHeapChange: (value: number) => void;
}) {
  const span = Math.max(1, bounds.max - bounds.min);
  const minPercent = ((minimumHeapGb - bounds.min) / span) * 100;
  const maxPercent = ((maximumHeapGb - bounds.min) / span) * 100;
  const quarter = Math.round(bounds.min + span * 0.25);
  const midpoint = Math.round(bounds.min + span * 0.5);
  const threeQuarter = Math.round(bounds.min + span * 0.75);
  const sliderStyle = {
    "--xms-percent": `${minPercent}%`,
    "--xmx-percent": `${maxPercent}%`
  } as CSSProperties;

  return (
    <div className="memoryRangeControl" style={sliderStyle}>
      <div className="memoryRangeTrackWrap">
        <span className="memoryValueBubble xms">{minimumHeapGb} GB</span>
        <span className="memoryValueBubble xmx">{maximumHeapGb} GB</span>
        <div className="memoryRangeTrack" aria-hidden="true" />
        <input
          aria-label="Minimum heap Xms"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step="1"
          value={minimumHeapGb}
          onChange={(event) => onMinimumHeapChange(Number(event.target.value))}
          className="memoryRangeInput xms"
        />
        <input
          aria-label="Maximum heap Xmx"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step="1"
          value={maximumHeapGb}
          onChange={(event) => onMaximumHeapChange(Number(event.target.value))}
          className="memoryRangeInput xmx"
        />
      </div>
      <div className="memoryTicks" aria-hidden="true">
        <span>{bounds.min} GB</span>
        <span>{quarter} GB</span>
        <span>{midpoint} GB</span>
        <span>{threeQuarter} GB</span>
        <span>{bounds.max} GB</span>
      </div>
    </div>
  );
}

export function MemoryNumberInput({
  id,
  label,
  value,
  min,
  max,
  onChange
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="memoryNumberField" htmlFor={id}>
      <span className="memoryNumberInputWrap">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <strong>GB</strong>
      </span>
      <small>{label}</small>
    </label>
  );
}
