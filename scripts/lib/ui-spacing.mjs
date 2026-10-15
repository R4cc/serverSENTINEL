import assert from "node:assert/strict";

export async function checkSpacing(page, label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.evaluate(() => {
    const issues = [];
    let icons = 0;
    let banners = 0;
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
    const contains = (outer, inner, inset = 0) => inner.left >= outer.left + inset - 1 && inner.right <= outer.right - inset + 1
      && inner.top >= outer.top + inset - 1 && inner.bottom <= outer.bottom - inset + 1;
    for (const svg of document.querySelectorAll("svg")) {
      if (!visible(svg)) continue;
      const parent = svg.parentElement;
      const button = svg.closest("button, a.uiButton");
      const iconOnly = button && (button.classList.contains("uiButton--icon")
        || button.classList.contains("iconButton") || button.classList.contains("iconOnlyButton")
        || button.matches(".sidebarCollapsed .sideNav button")
        || (!button.textContent.trim() && !button.querySelector("img")) || Number.parseFloat(getComputedStyle(button).fontSize) === 0);
      const well = [...parent.classList].some(name => /(?:Icon|icon|Marker)$/.test(name)) && !parent.matches("svg");
      if (button && visible(button)) {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const bordered = Number.parseFloat(style.borderWidth) > 0 && style.borderColor !== "rgba(0, 0, 0, 0)";
        if (bordered && !contains(box, svg.getBoundingClientRect(), 4)) issues.push(`Button icon lacks padding: ${button.getAttribute("aria-label") || button.className}`);
      }
      const container = iconOnly ? button : well ? parent : null;
      if (!container || !visible(container)) continue;
      const box = container.getBoundingClientRect();
      const glyph = svg.getBoundingClientRect();
      if (box.width < glyph.width || box.height < glyph.height) continue;
      // Composite event icons deliberately overlay a player head and a smaller status glyph.
      if (container.closest(".eventIcon--withPlayerHead, .timelineAnnotationIconStack")) continue;
      icons++;
      const name = container.getAttribute("aria-label") || container.getAttribute("title") || container.className;
      if (Math.abs(box.left + box.width / 2 - glyph.left - glyph.width / 2) > 1
        || Math.abs(box.top + box.height / 2 - glyph.top - glyph.height / 2) > 1) issues.push(`Off-center icon: ${name}`);
      if (box.width >= glyph.width + 8 && box.height >= glyph.height + 8 && !contains(box, glyph, 4)) issues.push(`Icon touches border: ${name}`);
    }
    for (const banner of document.querySelectorAll(".uiBanner")) {
      if (!visible(banner)) continue;
      banners++;
      const box = banner.getBoundingClientRect();
      const style = getComputedStyle(banner);
      const compact = banner.classList.contains("uiBanner--compact");
      const minimum = compact ? 8 : 12;
      if (banner.closest("#spacing-banner-fixtures") && compact
        && (Number.parseFloat(style.paddingTop) !== 8 || Number.parseFloat(style.paddingBottom) !== 8)) {
        issues.push("Compact banner lost its vertical padding");
      }
      if (banner.classList.contains("inlineState")) {
        banner.classList.remove("inlineState");
        const plainStyle = getComputedStyle(banner);
        const plainAppearance = [plainStyle.background, plainStyle.borderColor, plainStyle.padding, plainStyle.borderRadius];
        banner.classList.add("inlineState");
        const appearance = [style.background, style.borderColor, style.padding, style.borderRadius];
        if (JSON.stringify(appearance) !== JSON.stringify(plainAppearance)) issues.push("Inline state overrides banner appearance or spacing");
      }
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        if (Number.parseFloat(style[`padding${side}`]) < minimum) issues.push(`Banner lacks ${side.toLowerCase()} padding: ${banner.className}`);
      }
      for (const child of banner.children) {
        if (!contains(box, child.getBoundingClientRect(), minimum)) issues.push(`Banner content escapes padding: ${banner.className}`);
      }
      const icon = banner.querySelector(".uiBannerIcon").getBoundingClientRect();
      const copy = banner.querySelector(".uiBannerCopy").getBoundingClientRect();
      if (!banner.querySelector(".uiBannerMessage, .uiBannerDetails") && Math.abs(icon.top + icon.height / 2 - copy.top - copy.height / 2) > 1) {
        issues.push(`Title-only banner is not vertically centered: ${banner.className}`);
      }
      if (!banner.querySelector(".uiBannerAction") && Math.abs(box.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight) - copy.right) > 1) {
        issues.push(`Banner reserves an empty action column: ${banner.className}`);
      }
      if (banner.scrollWidth > banner.clientWidth + 1) issues.push(`Banner overflows: ${banner.className}`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push("Document overflows horizontally");
    return { icons, banners, issues: [...new Set(issues)] };
  });
  assert.deepEqual(result.issues, [], `${label}: ${result.issues.join("; ")}`);
  return result;
}

export async function checkBannerVariants(page, label) {
  // Force a real workspace error banner with a long backend message and retry action.
  await page.route("**/api/app", route => route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "The backend is temporarily unavailable. ".repeat(8) } } }));
  await page.reload();
  await page.locator(".inlineState-error.uiBanner").waitFor();
  await checkSpacing(page, `${label} workspace error`);
  // Reuse rendered Banner markup to exercise every tone, density, and content shape.
  await page.evaluate(() => {
    const source = document.querySelector(".inlineState-error.uiBanner");
    const gallery = document.createElement("div");
    gallery.id = "spacing-banner-fixtures";
    gallery.style.cssText = "display:grid;gap:16px;min-width:0";
    for (const tone of ["warning", "error", "info", "success"]) {
      for (const compact of [false, true]) {
        for (const titleOnly of [false, true]) {
          const banner = source.cloneNode(true);
          banner.className = `uiBanner uiBanner--${tone} ${compact ? "uiBanner--compact" : ""} ${tone === "error" ? "inlineState inlineState-error" : ""}`;
          banner.querySelector("strong").textContent = titleOnly ? "Node offline" : "UnreachableHost".repeat(12);
          if (titleOnly) {
            banner.querySelector(".uiBannerMessage")?.remove();
            banner.querySelector(".uiBannerAction")?.remove();
          } else {
            banner.querySelector(".uiBannerMessage").textContent = "The connection failed. Check the host and retry. ".repeat(6);
            const details = document.createElement("div");
            details.className = "uiBannerDetails";
            details.textContent = "ConnectionDetails".repeat(14);
            banner.querySelector(".uiBannerCopy").append(details);
          }
          gallery.append(banner);
        }
      }
    }
    document.querySelector(".workspace").append(gallery);
  });
  const fixtures = await checkSpacing(page, `${label} banner variants`);
  assert(fixtures.banners >= 16, `${label}: banner variants did not render`);
}
