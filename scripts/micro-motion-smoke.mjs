import assert from "node:assert/strict";
import { chromium } from "playwright";
import { launchBrowser, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-micro-motion-" });
let browser;
try {
  browser = await launchBrowser(chromium);
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(theme => localStorage.setItem("serversentinel-theme", theme), theme);
    await signInThroughApi(context, harness.baseUrl);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(harness.baseUrl);
    await page.locator(".appShell").waitFor();
    const nav = page.locator('[data-nav-page="nodes"]');
    if (!await nav.isVisible()) await page.getByRole("button", { name: "Expand navigation" }).click();

    // Render the shared loading/status primitives with production CSS. Keeping
    // them mounted makes it possible to observe multiple full animation cycles.
    await page.evaluate(() => {
      const fixture = document.createElement("div");
      fixture.id = "micro-motion-fixture";
      // Real loading labels are flex containers, which makes the spinner a
      // transformable box rather than an inline span with ignored dimensions.
      fixture.style.cssText = "position:fixed;bottom:8px;right:8px;pointer-events:none;display:flex;align-items:center;gap:8px";
      fixture.innerHTML = '<span class="uiSpinner"></span><span class="uiSkeleton uiSkeleton--text"></span><span class="serverCommandStatusDot running"></span>';
      document.body.append(fixture);
    });
    for (const reducedMotion of ["reduce", "no-preference", "reduce"]) {
      await page.emulateMedia({ reducedMotion });
      const label = `${width}/${theme}/${reducedMotion}`;
      const spinner = page.locator("#micro-motion-fixture .uiSpinner");
      for (const [selector, pseudo, name] of [[".uiSpinner", null, "spinner"], [".uiSkeleton", "::after", "skeleton"]]) {
        const target = page.locator(`#micro-motion-fixture ${selector}`);
        const style = await target.evaluate((element, pseudo) => {
          const style = getComputedStyle(element, pseudo);
          return { name: style.animationName, iterations: style.animationIterationCount, duration: parseFloat(style.animationDuration) };
        }, pseudo);
        assert.notEqual(style.name, "none", `${label}: ${name} is animated`);
        assert.equal(style.iterations, "infinite", `${label}: ${name} keeps looping`);
        assert(style.duration > 0.1, `${label}: ${name} duration is not collapsed`);
        const transform = () => target.evaluate((element, pseudo) => getComputedStyle(element, pseudo).transform, pseudo);
        const before = await transform();
        // Observe a changed painted frame rather than assuming CI rendered one
        // during a fixed sleep. A stopped animation still fails within 3 seconds.
        try {
          await page.waitForFunction(({ selector, pseudo, before }) =>
            getComputedStyle(document.querySelector(`#micro-motion-fixture ${selector}`), pseudo).transform !== before,
          { selector, pseudo, before }, { timeout: 3000, polling: "raf" });
        } catch (cause) {
          throw new Error(`${label}: ${name} actually moves`, { cause });
        }
      }
      await page.waitForTimeout(1500);
      assert.notEqual(await spinner.evaluate(element => getComputedStyle(element).transform), "none", `${label}: spinner survives a full cycle`);
      assert.equal(await page.locator("#micro-motion-fixture .serverCommandStatusDot").evaluate(element => getComputedStyle(element, "::after").animationIterationCount), "infinite");

      await page.mouse.move(width - 1, 1);
      await nav.evaluate(element => element.blur());
      const beforeHover = await nav.boundingBox();
      await nav.hover();
      assert.equal(await nav.evaluate(element => getComputedStyle(element, "::after").animationName), "sentinelNavGlint", `${label}: hover shines`);
      assert(await nav.evaluate(element => parseFloat(getComputedStyle(element, "::after").animationDuration) > 0.1), `${label}: shine has a visible duration`);
      // A busy CI runner can resume after the entire short shine has finished.
      // Inspect its painted phase through the browser's real CSS animation clock.
      assert(await nav.evaluate(async element => {
        const animation = element.getAnimations({ subtree: true }).find(animation => animation.animationName === "sentinelNavGlint");
        if (!animation) return false;
        await animation.ready;
        animation.pause();
        animation.currentTime = Number(animation.effect.getTiming().duration) * 0.32;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const painted = Number(getComputedStyle(element, "::after").opacity) > 0;
        animation.play();
        return painted;
      }), `${label}: shine paints`);
      const afterHover = await nav.boundingBox();
      for (const dimension of ["x", "y", "width", "height"]) assert(Math.abs(afterHover[dimension] - beforeHover[dimension]) < 1, `${label}: hover preserves ${dimension}`);
      assert.notEqual(await nav.locator(".sideIcon").evaluate(element => getComputedStyle(element).transform), "none", `${label}: icon responds to hover`);
      await page.mouse.move(width - 1, 1);
      await nav.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await nav.evaluate(element => getComputedStyle(element, "::after").animationName), "sentinelNavGlint", `${label}: focus shines`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: no horizontal overflow`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Micro-motion smoke passed: reduced motion and live preference changes, light/dark, desktop/phone, looping loaders, hover/focus shine, and stable layout.");
} finally {
  await browser?.close();
  await harness.stop();
}
