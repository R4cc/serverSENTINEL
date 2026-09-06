import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { launchBrowser, signInThroughApi, startDemoHarness } from './lib/demo-harness.mjs';
const harness = await startDemoHarness({ dataDirectoryPrefix: 'serversentinel-mod-details-' });
let browser;
try {
  browser = await launchBrowser(chromium);
  for (const width of [1440, 2560, 768, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await signInThroughApi(context, harness.baseUrl);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${harness.baseUrl}/?mods-fixture=mixed`);
    await page.locator('.appShell').waitFor();
    const nav = page.locator('[data-nav-page="mods"]');
    if (!await nav.isVisible()) await page.getByRole('button', { name: 'Expand navigation' }).click();
    await nav.click();
    await page.locator('.modsWorkspaceIdentity').first().waitFor();
    const reviewRow = page.locator('.modsWorkspaceRow').filter({ has: page.getByRole('button', { name: 'Review update', exact: true }) }).first();
    await reviewRow.locator('.modsWorkspaceIdentity').click();
    const dialog = page.locator('.modsDetailsDrawer');
    await dialog.waitFor();
    const box = await dialog.boundingBox();
    assert.ok(box.width >= (width > 720 ? 640 : width - 1), `Drawer too narrow at ${width}`);
    if (width === 2560) assert.ok(box.width >= 900, 'Large screens need a wider panel');
    await dialog.getByRole('button', { name: 'Review update', exact: true }).click();
    const confirm = dialog.getByRole('button', { name: 'Confirm update', exact: true });
    assert.equal(await confirm.isDisabled(), true);
    await dialog.locator('.modsRiskAcknowledgement input').check();
    assert.equal(await confirm.isEnabled(), true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.getByRole('button', { name: 'Review update', exact: true }).click();
    assert.equal(await confirm.isDisabled(), true, 'Cancel must reset acknowledgement');
    await dialog.getByText('Technical compatibility details', { exact: true }).click();
    await dialog.getByText('File and source details', { exact: true }).click();
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
    assert.equal(await dialog.locator('.modsDrawerBody').evaluate(el => el.scrollWidth > el.clientWidth), false);
    await confirm.scrollIntoViewIfNeeded();
    if (process.env.MOD_DETAILS_SCREENSHOT_DIR) {
      await mkdir(process.env.MOD_DETAILS_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.MOD_DETAILS_SCREENSHOT_DIR}/mod-details-${width}.png` });
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`Mod details layout and review acknowledgement passed at ${width}px`);
  }
} finally {
  await browser?.close();
  await harness.stop();
}

