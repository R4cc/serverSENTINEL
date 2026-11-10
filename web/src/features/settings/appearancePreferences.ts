export const translucencyStorageKey = "serversentinel-glass-translucency";
export const contrastStorageKey = "serversentinel-contrast";

/** Both settings are whole percentages on a 0-100 slider. */
export const appearanceSliderStep = 5;
export const defaultTranslucency = 50;
export const defaultContrast = 0;

function readStoredValue(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function sliderValueFromStoredValue(value: string | null, fallback: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

export function translucencyFromStoredValue(value: string | null) {
  return sliderValueFromStoredValue(value, defaultTranslucency);
}

export function contrastFromStoredValue(value: string | null) {
  return sliderValueFromStoredValue(value, defaultContrast);
}

export function readTranslucency() {
  return translucencyFromStoredValue(readStoredValue(translucencyStorageKey));
}

export function readContrast() {
  return contrastFromStoredValue(readStoredValue(contrastStorageKey));
}

/**
 * The custom properties the stylesheets derive the glass material and the
 * contrast-adjusted colours from. `tokens.css` declares the same properties
 * with the values this returns for the defaults, so an unset preference and the
 * default preference render identically.
 *
 * Translucency runs from opaque (0: a solid overlay, no blur) through the
 * default (50: 80% tint) to the most see-through setting (100: 60% tint). Blur
 * grows with it, because the less tint a layer has, the more the backdrop has
 * to be diffused for the text on top to stay legible.
 *
 * Contrast moves secondary text and hairlines toward the primary text colour.
 * Lines move half as far as text: a border at full strength would outweigh the
 * content it separates.
 */
export function appearanceProperties(translucency: number, contrast: number): Record<string, string> {
  return {
    "--glass-opacity": `${100 - translucency * 0.4}%`,
    "--glass-blur-scale": translucency === 0 ? "0" : String(0.5 + translucency / 100),
    "--contrast-boost": `${contrast * 0.6}%`,
    "--contrast-border-boost": `${contrast * 0.3}%`
  };
}

export function applyAppearance(root: HTMLElement, translucency: number, contrast: number) {
  for (const [property, value] of Object.entries(appearanceProperties(translucency, contrast))) {
    root.style.setProperty(property, value);
  }
}
