import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { launchBrowser, signInThroughApi, startDemoHarness } from './lib/demo-harness.mjs';

const harness = await startDemoHarness({ dataDirectoryPrefix: 'serversentinel-search-smoke-' });
let browser;
try {
  browser = await launchBrowser(chromium);
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    await signInThroughApi(context, harness.baseUrl);
    const page = await context.newPage();
    await page.goto(harness.baseUrl);
    await page.locator('.appShell').waitFor();
    const open = async (name) => {
      const nav = page.locator(`[data-nav-page="${name}"]`);
      if (!await nav.isVisible()) await page.getByRole('button', { name: 'Expand navigation' }).click();
      await nav.click();
      await page.locator(`.workspacePage-${name}`).waitFor();
    };
    await open('nodes');
    const nodeSearch = page.getByRole('searchbox', { name: 'Search nodes and servers' });
    await nodeSearch.fill('  BERLIN  ');
    assert.equal(await page.locator('.nodeListItem').count(), 1);
    assert.match(await page.locator('.nodeListItem').innerText(), /Berlin Edge/);
    await nodeSearch.fill('Modpack Lab');
    assert.equal(await page.locator('.nodeListItem').count(), 1);
    assert.match(await page.locator('.nodeListItem').innerText(), /Modpack Lab/);
    await nodeSearch.fill('no-such-node');
    await page.getByText('No matching nodes or servers', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Clear search nodes and servers', exact: true }).click();
    assert.equal(await nodeSearch.inputValue(), '');
    assert(await nodeSearch.evaluate((element) => element === document.activeElement));
    assert((await page.locator('.nodeListItem').count()) > 1);
    await open('players');
    const rosterSearch = page.getByRole('searchbox', { name: 'Search players and locations' });
    await rosterSearch.waitFor();
    const playerName = await page.locator('.playerRosterTable .playerIdentityCopy strong').first().innerText();
    await rosterSearch.fill(playerName);
    assert((await page.locator('.playerRosterTable tbody tr').count()) >= 1);
    assert.match(await page.locator('.playerRosterTable tbody').innerText(), new RegExp(playerName));
    await rosterSearch.fill('no-such-player');
    await page.getByText('No matching players', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Clear search players and locations' }).click();
    assert.equal(await rosterSearch.inputValue(), '');
    assert((await page.locator('.playerRosterTable .playerIdentityCopy strong').count()) > 1);
    const headingSize = await page.locator('.workspaceHeader h2').evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    assert(headingSize >= 24 && headingSize <= 30, `Heading size ${headingSize} at ${width}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, `Document overflow at ${width}`);
    await context.close();
    console.log(`Search workflows passed at ${width}px`);
  }
} finally {
  await browser?.close();
  await harness.stop();
}

