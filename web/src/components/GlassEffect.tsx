import { Component, lazy, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from "react";

export type GlassVariant = "chrome" | "floating" | "modal";

const LiquidGlass = lazy(() => import("liquid-glass-react"));
const fixedMousePosition = { x: 1, y: 1 };
const fixedMouseOffset = { x: 0, y: 0 };

class GlassErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The CSS material remains complete without the decorative refractive layer.
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function supportsLiquidGlass({
  userAgent,
  backdropFilter,
  reducedMotion,
  reducedTransparency
}: {
  userAgent: string;
  backdropFilter: boolean;
  reducedMotion: boolean;
  reducedTransparency: boolean;
}) {
  if (!backdropFilter || reducedMotion || reducedTransparency) return false;
  return /(?:Chrome|Chromium)\//.test(userAgent) || /Edg\//.test(userAgent);
}

function browserSupportsLiquidGlass() {
  return supportsLiquidGlass({
    userAgent: window.navigator.userAgent,
    backdropFilter: window.CSS?.supports?.("backdrop-filter", "blur(1px)")
      || window.CSS?.supports?.("-webkit-backdrop-filter", "blur(1px)")
      || false,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    reducedTransparency: window.matchMedia("(prefers-reduced-transparency: reduce)").matches
  });
}

function useLiquidGlassSupport() {
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const transparency = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const update = () => setSupported(browserSupportsLiquidGlass());
    update();
    motion.addEventListener("change", update);
    transparency.addEventListener("change", update);
    return () => {
      motion.removeEventListener("change", update);
      transparency.removeEventListener("change", update);
    };
  }, []);

  return supported;
}

const glassSettings: Record<GlassVariant, { blurAmount: number; cornerRadius: number; displacementScale: number; saturation: number }> = {
  chrome: { blurAmount: 0.08, cornerRadius: 26, displacementScale: 24, saturation: 142 },
  floating: { blurAmount: 0.09, cornerRadius: 18, displacementScale: 28, saturation: 148 },
  modal: { blurAmount: 0.1, cornerRadius: 28, displacementScale: 22, saturation: 140 }
};

/**
 * Decorative-only refraction. The parent remains the semantic and interactive
 * surface; this layer never receives focus, pointer events, or accessible text.
 */
export function GlassEffect({ variant }: { variant: GlassVariant }) {
  const supported = useLiquidGlassSupport();
  if (!supported) return null;
  const settings = glassSettings[variant];

  return (
    <span className={`uiLiquidGlassEffect uiLiquidGlassEffect--${variant}`} aria-hidden="true">
      <GlassErrorBoundary>
        <Suspense fallback={null}>
          <LiquidGlass
            {...settings}
            aberrationIntensity={0.65}
            elasticity={0}
            globalMousePos={fixedMousePosition}
            mouseOffset={fixedMouseOffset}
            padding="0"
            style={{ position: "absolute", width: "100%", height: "100%" }}
          >
            <span className="uiLiquidGlassFill" />
          </LiquidGlass>
        </Suspense>
      </GlassErrorBoundary>
    </span>
  );
}
