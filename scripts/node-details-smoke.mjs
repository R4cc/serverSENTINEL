import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { launchBrowser, signInThroughApi, startDemoHarness } from './lib/demo-harness.mjs';
const harness = await startDemoHarness({ dataDirectoryPrefix: 'serversentinel-node-details-' });
try {
  for (const [engine, widths] of [[chromium, [1440, 2560, 768, 390, 320]], [webkit, [1024, 390]]]) {
    const browser = await launchBrowser(engine);
    try {
      for (const width of widths) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
        await signInThroughApi(context, harness.baseUrl);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(harness.baseUrl);
        await page.locator('.appShell').waitFor();
        const nav = page.locator('[data-nav-page="nodes"]');
        if (!await nav.isVisible()) await page.getByRole('button', { name: 'Expand navigation' }).click();
        await nav.click();
        const trigger = page.getByRole('button', { name: 'Details', exact: true }).first();
        await trigger.click();
        const dialog = page.locator('.nodeDetailsDrawer');
        await dialog.waitFor();
        const box = await dialog.boundingBox();
        if (width > 720) assert.ok(box.width >= 640, `Drawer too narrow at ${width}`);
        if (width === 2560) assert.ok(box.width >= 900, 'Drawer must scale on large screens');
        const close = dialog.getByRole('button', { name: 'Close node details' });
        const closeBox = await close.boundingBox();
        assert.ok(closeBox.y >= 0 && closeBox.y + closeBox.height <= 1000, 'Close must be in view when opened');
        assert.equal(await dialog.locator('.nodeVersionComparison > div').count(), 2);
        await dialog.locator('.nodeTechnicalDetails summary').click();
        assert.equal(await dialog.locator('.nodeTechnicalDetails').getAttribute('open'), '');
        const toggle = dialog.getByRole('checkbox', { name: /Node update notifications for/ });
        assert.equal(await toggle.isChecked(), true);
        assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false, `Drawer overflow at ${width}`);
        assert.equal(await dialog.locator('.nodeDrawerBody').evaluate(el => el.scrollWidth > el.clientWidth), false, `Body overflow at ${width}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Page overflow at ${width}`);
        await dialog.getByRole('button', { name: 'More node actions' }).click();
        await page.getByRole('menu').waitFor();
        await page.keyboard.press('Escape');
        await dialog.locator('.nodeTechnicalDetails summary').click();
        if (process.env.NODE_DETAILS_SCREENSHOT_DIR) {
          await mkdir(process.env.NODE_DETAILS_SCREENSHOT_DIR, { recursive: true });
          await dialog.locator('.nodeDrawerBody').evaluate(el => { el.scrollTop = 0; });
          await page.evaluate(() => scrollTo(0, 0));
          await page.screenshot({ path: `${process.env.NODE_DETAILS_SCREENSHOT_DIR}/node-details-${engine.name()}-${width}.png`, fullPage: width <= 720 });
        }
        await close.click();
        await dialog.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Details', null, { timeout: 2000 });
        assert.deepEqual(errors, []);
        await context.close();
        console.log(`Node details layout, disclosure, actions and focus passed: ${engine.name()} ${width}px`);
      }
    } finally { await browser.close(); }
  }
} finally { await harness.stop(); }

