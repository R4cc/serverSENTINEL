import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { launchBrowser, signInThroughApi, startDemoHarness } from './lib/demo-harness.mjs';

const harness = await startDemoHarness({ dataDirectoryPrefix: 'serversentinel-editor-layout-' });
let browser;
try {
  browser = await launchBrowser(chromium);
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'no-preference' });
    await signInThroughApi(context, harness.baseUrl);
    const page = await context.newPage();
    await page.goto(harness.baseUrl);
    const nav = page.locator('[data-nav-page="files"]');
    await page.locator('.appShell').waitFor();
    if (!await nav.isVisible()) await page.getByRole('button', { name: 'Expand navigation' }).click();
    await nav.click();
    const file = page.getByRole('rowheader', { name: 'server.properties', exact: true });
    await file.waitFor();
    for (let opening = 0; opening < 2; opening++) {
      // Observe before opening: waiting for the editor to settle hides this regression.
      await page.evaluate(() => {
        window.editorLayoutSamples = [];
        const start = performance.now();
        const sample = () => {
          const lines = [...document.querySelectorAll('.cm-content .cm-line')];
          const numbers = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
            .filter(element => element.style.visibility !== 'hidden');
          if (lines.length && getComputedStyle(lines[0]).visibility === 'visible' && numbers.length >= lines.length) {
            window.editorLayoutSamples.push(Math.max(...lines.map((line, index) =>
              Math.abs(line.getBoundingClientRect().top - numbers[index].getBoundingClientRect().top))));
          }
          if (performance.now() - start < 1600) requestAnimationFrame(sample);
          else window.editorLayoutDone = true;
        };
        window.editorLayoutDone = false;
        requestAnimationFrame(sample);
      });
      await file.dblclick();
      await page.waitForFunction(() => window.editorLayoutDone);
      const samples = await page.evaluate(() => window.editorLayoutSamples);
      assert(samples.length > 10, 'Expected frame-by-frame editor measurements');
      const drift = Math.max(...samples);
      console.log(`${width}px opening ${opening + 1}: maximum row drift ${drift.toFixed(2)}px`);
      assert(drift <= 1, `Line numbers drifted by ${drift}px at ${width}px`);
      await page.getByRole('button', { name: 'Close editor', exact: true }).click();
    }
    await context.close();
  }
} finally {
  await browser?.close();
  await harness.stop();
}
