import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { build } from "esbuild";
import { launchBrowser, repositoryRoot, signInThroughApi, startDemoHarness } from "./lib/demo-harness.mjs";

// Demo intentionally disables node management. Exercise setup with the real modal
// and synthetic callback results, never a node mutation or a real join token.
const setup = await build({
  stdin: { resolveDir: repositoryRoot, loader: "tsx", contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AddNodeModal } from './web/src/pages/NodesPage';
    import { NODE_PROTOCOL_VERSION } from '@serversentinel/contracts';
    function Setup() {
      const [open, setOpen] = useState(true);
      const [busy, setBusy] = useState(false);
      const [created, setCreated] = useState(null);
      const [node, setNode] = useState(undefined);
      const [method, setMethod] = useState('run');
      window.finishCreate = () => {
        const input = window.nodeInput;
        const result = { node: { id: 'fixture-node', name: input.name, type: 'remote', status: 'unknown', isInternal: false },
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          install: { tokenRequired: true, joinToken: 'fixture-token',
            dockerRun: 'docker run --name serversentinel-node -e SS_JOIN_TOKEN=fixture-token -v /var/lib/serversentinel:/data serversentinel:dev',
            dockerCompose: { image: 'serversentinel:dev', environment: { SS_JOIN_TOKEN: 'fixture-token' }, volumes: ['/var/lib/serversentinel:/data'] } } };
        setCreated(result); setBusy(false);
      };
      window.connection = state => {
        if (state === 'expired') setCreated(value => ({ ...value, expiresAt: '2000-01-01T00:00:00Z' }));
        else setNode({ ...created.node, status: state === 'success' ? 'online' : 'offline',
          connectedAt: new Date().toISOString(), dockerStatus: 'available', dataPathStatus: 'ready', protocolVersion: NODE_PROTOCOL_VERSION });
      };
      return open ? <AddNodeModal busy={busy} browserPanelUrl="https://panel.example.com" created={created}
        currentNode={node} installMethod={method} onInstallMethodChange={setMethod}
        onClose={() => setOpen(false)} onDone={() => setOpen(false)}
        onCreate={input => { window.nodeInput = input; setBusy(true); }}
        onCopy={value => { window.copied = value; }} formatDate={value => new Date(value).toLocaleString('en-GB')} /> : null;
    }
    createRoot(document.getElementById('root')).render(<Setup />);
  ` },
  bundle: true, write: false, platform: "browser", format: "iife",
  define: { "process.env.NODE_ENV": '"production"' }
});
const styles = await build({ entryPoints: ["web/src/styles.css"], absWorkingDir: repositoryRoot,
  bundle: true, write: false, loader: { ".woff2": "dataurl" }, external: ["*.woff", "*.ttf", "*.svg", "*.png"] });

const harness = await startDemoHarness({ dataDirectoryPrefix: "serversentinel-nodes-ui-" });
const screenshots = process.env.NODES_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });

async function capture(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Page overflows");
  for (const selector of [".nodeListItem", ".nodeServerRow", ".nodeDetailsDrawer", ".nodeDrawerBody", ".nodeModalPanel", ".nodeModalBody"]) {
    for (const element of await page.locator(selector).all()) {
      assert(await element.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${selector} overflows`);
    }
  }
  for (const selector of [".nodeDetailsDrawer", ".nodeModalPanel"]) {
    for (const dialog of await page.locator(selector).all()) {
      assert(await dialog.evaluate(element => {
        const box = element.getBoundingClientRect();
        const footer = element.querySelector('footer').getBoundingClientRect();
        return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1
          && footer.top >= box.top && footer.bottom <= innerHeight + 1;
      }), `${selector} or its actions leave the viewport`);
    }
  }
  if (screenshots) await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true, animations: "disabled" });
}

try {
  for (const [engine, width, theme] of [
    [chromium, 1440, "dark"], [chromium, 1440, "light"],
    [chromium, 1024, "dark"], [chromium, 768, "light"],
    [chromium, 390, "dark"], [webkit, 320, "light"]
  ]) {
    const browser = await launchBrowser(engine);
    try {
      const height = width === 320 ? 568 : width === 390 ? 844 : 900;
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
      await context.addInitScript(theme => {
        localStorage.setItem("serversentinel-theme", theme);
        localStorage.setItem("serversentinel-active-page", JSON.stringify({ value: "nodes", savedAt: Date.now() }));
      }, theme);
      await signInThroughApi(context, harness.baseUrl);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(harness.baseUrl);
      await page.locator(".nodeListItem").first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await capture(page, `${width}-${theme}-fleet`);
      assert.equal(await page.locator(".nodeListItem").count(), 8);
      assert(await page.getByRole("button", { name: "Add node", exact: true }).isDisabled(), "Demo allows node management");
      const search = page.getByRole("searchbox", { name: "Search nodes and servers" });
      await search.fill("BERLIN");
      await page.waitForFunction(() => document.querySelectorAll('.nodeListItem').length === 1);
      assert.equal(await page.locator(".nodeServerRow").count(), 4, "Matching hosts must retain their servers");
      await search.fill("no matching host");
      await page.getByText("No matching nodes or servers", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Clear search", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.nodeListItem').length === 8);
      await search.fill("Demo Survival");
      await page.waitForFunction(() => document.querySelectorAll('.nodeListItem').length === 1);
      await page.getByRole("button", { name: "Clear search nodes and servers", exact: true }).click();
      assert(await search.evaluate(element => element === document.activeElement));
      const details = page.getByRole("button", { name: "Details", exact: true }).first();
      await details.click();
      await page.locator(".nodeDetailsDrawer").waitFor();
      await capture(page, `${width}-${theme}-details`);
      await page.locator(".nodeTechnicalDetails summary").click();
      await page.locator(".nodeDrawerFacts.technical").waitFor();
      await capture(page, `${width}-${theme}-technical`);
      await page.getByRole("button", { name: "More node actions", exact: true }).click();
      assert(await page.getByRole("menuitem", { name: /Refresh/ }).isEnabled());
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.locator(".nodeDetailsDrawer").waitFor({ state: "detached" });
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Details");
      assert(await details.evaluate(element => element === document.activeElement), "Details did not restore focus");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByText("Node status refreshed", { exact: true }).waitFor();

      await page.route("http://nodes.test/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      await page.goto("http://nodes.test/");
      await page.evaluate(theme => document.documentElement.className = theme === "dark" ? "themeDark" : "themeLight", theme);
      await page.addStyleTag({ content: styles.outputFiles[0].text });
      await page.addScriptTag({ content: setup.outputFiles[0].text });
      await page.locator(".nodeModalPanel").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await capture(page, `${width}-${theme}-add`);
      await page.getByRole("textbox", { name: /^Node name/ }).fill("Compute host with a deliberately long but valid node name");
      await page.getByRole("button", { name: "Use this address", exact: true }).click();
      assert.equal(await page.getByRole("textbox", { name: /^Panel address for this node/ }).inputValue(), "https://panel.example.com");
      await page.getByRole("textbox", { name: /^Panel address for this node/ }).fill("http://localhost:8080");
      await page.getByRole("button", { name: "Create install command", exact: true }).click();
      await page.getByText("Check node details", { exact: true }).waitFor();
      await capture(page, `${width}-${theme}-invalid`);
      await page.getByRole("textbox", { name: /^Panel address for this node/ }).fill("https://panel.example.com");
      await page.getByRole("button", { name: "Create install command", exact: true }).click();
      assert(await page.getByRole("button", { name: "Creating...", exact: true }).isDisabled());
      await page.keyboard.press("Escape");
      assert(await page.locator(".nodeModalPanel").isVisible(), "Busy setup dismissed by Escape");
      await page.evaluate(() => window.finishCreate());
      await page.getByText("Waiting for node connection", { exact: true }).waitFor();
      await capture(page, `${width}-${theme}-install`);
      await page.getByRole("button", { name: "Copy install command", exact: true }).click();
      assert.equal(await page.evaluate(() => window.copied), await page.locator(".installSnippet code").textContent());
      await page.getByRole("button", { name: "Docker Compose", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "Docker Compose", exact: true }).getAttribute("aria-pressed"), "true");
      assert((await page.locator(".installSnippet code").textContent()).startsWith("services:"));
      await capture(page, `${width}-${theme}-compose`);
      await page.evaluate(() => window.connection("expired"));
      await page.getByText("Join token expired", { exact: true }).waitFor();
      await page.evaluate(() => window.connection("disconnected"));
      await page.getByText("Node disconnected", { exact: true }).waitFor();
      await page.evaluate(() => window.connection("success"));
      await page.getByText("Node added successfully", { exact: true }).waitFor();
      assert.equal(await page.locator(".installSnippet").count(), 0, "Install secret remains after success");
      await capture(page, `${width}-${theme}-connected`);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.locator(".nodeModalPanel").waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
      console.log(`Nodes UI passed: ${width}px ${theme}`);
    } finally { await browser.close(); }
  }
} finally { await harness.stop(); }
