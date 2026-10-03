import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { launchBrowser, repositoryRoot } from "./lib/demo-harness.mjs";

// Real workspace and page with deferred responses: reproduce stale previews even
// when the transport ignores cancellation, without touching any server files.
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useFilesWorkspace } from './web/src/features/files/useFilesWorkspace';
    import { FilesPage } from './web/src/features/files/FilesPage';
    window.requests = []; window.notifications = [];
    const noop = () => {};
    const options = {
      activeServer: { id: 'one' }, activeServerIsDemo: false,
      activeServerIdRef: { current: 'one' }, demoMode: false,
      permissionUser: { permissions: ['files.view', 'files.edit', 'files.upload', 'files.delete', 'files.download', 'files.rename'], role: 'admin' },
      demoFiles: {}, setDemoFiles: noop, demoInstalledMods: [], setDemoInstalledMods: noop,
      isProvisioning: false, dockerOperationalLock: false,
      runtimeControlsDisabledReason: '', serverRequiresStoppedForMutableConfig: false,
      stoppedServerMutationMessage: '', formatDisplayDate: String,
      notify: (...args) => window.notifications.push(args), setNotice: noop,
      handleStaleSession: () => false, refreshModsAfterFilesChange: noop, setActiveJobs: noop
    };
    function Harness() {
      const workspace = useFilesWorkspace(options);
      window.workspace = workspace;
      return <main className="workspaceServerPage workspacePage-files"><FilesPage workspace={workspace}
        activeServerIsDemo={false} permissionUser={options.permissionUser} isProvisioning={false}
        dockerOperationalLock={false} dateTimeFormatter={new Intl.DateTimeFormat('en')} onCopyText={noop} /></main>;
    }
    const root = createRoot(document.getElementById('root'));
    window.changeScope = id => { options.activeServer = { id }; options.activeServerIdRef.current = id; root.render(<Harness />); };
    window.unmount = () => root.unmount();
    root.render(<Harness />);
  `, resolveDir: repositoryRoot, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "deferred-api", setup(builder) {
    builder.onResolve({ filter: /\/api$/ }, () => ({ path: "api", namespace: "mock" }));
    builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: `
      export class ApiError extends Error {}
      export function api(url, options = {}) {
        return new Promise((resolve, reject) => window.requests.push({ url, options, resolve, reject }));
      }
    ` }));
  } }]
});
const styles = await build({ entryPoints: ["web/src/styles.css"], absWorkingDir: repositoryRoot,
  bundle: true, write: false, external: ["*.woff2", "*.woff", "*.ttf", "*.svg", "*.png"] });
const file = (name) => ({ name, path: `/${name}`, type: "file", size: 42, modifiedAt: "2026-10-01T12:00:00Z", status: "ok" });
const listing = { path: "/", entries: [{ ...file("config"), type: "directory" }, file("alpha.txt"), file("beta.txt"), file("gamma.json")] };
const browser = await launchBrowser(chromium);
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.on("pageerror", error => { throw error; });
  page.setDefaultTimeout(5000);
  await page.route("http://files.test/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://files.test/");
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.workspace);
  const frame = () => page.evaluate(() => new Promise(requestAnimationFrame));
  const action = async (name, ...args) => {
    await page.evaluate(({ name, args }) => { void window.workspace.actions[name](...args); }, { name, args });
    await frame();
  };
  const request = async (suffix) => {
    const index = await page.evaluate(suffix => window.requests.findIndex(r => !r.used && r.url.endsWith(suffix)), suffix);
    assert(index >= 0, `Missing request ${suffix}`);
    await page.evaluate(i => { window.requests[i].used = true; }, index);
    return index;
  };
  const finish = async (index, value, fail = false) => {
    await page.evaluate(({ index, value, fail }) => {
      const r = window.requests[index];
      if (fail) r.reject(new Error(value)); else r.resolve(value);
    }, { index, value, fail });
    await frame();
  };
  await action("loadFiles", "one", "/");
  await finish(await request("/files?path=%2F"), listing);
  const search = page.getByRole("searchbox", { name: "File filter" });
  await page.getByRole("rowheader", { name: "alpha.txt", exact: true }).click();
  const oldPreview = await request("/file/preview?path=%2Falpha.txt");
  await search.fill(" BETA ");
  assert.equal(await page.locator(".fileTableRow").count(), 1);
  assert.equal(await page.locator('[aria-selected="true"]').count(), 0, "Filtering must discard hidden selection");
  await page.locator(".fileSelectAllCell input").check();
  assert.deepEqual(await page.evaluate(() => window.workspace.state.selectedFilePaths), ["/beta.txt"]);
  await request("/file/preview?path=%2Fbeta.txt");
  await page.getByRole("button", { name: "Clear file selection" }).click();
  assert.equal(await page.locator('[aria-selected="true"]').count(), 0);
  await search.fill("missing");
  await frame();
  await page.getByText("No matching files", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  assert.equal(await page.locator(".fileTableRow").count(), 4);
  await page.getByRole("rowheader", { name: "alpha.txt", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  assert.deepEqual(await page.evaluate(() => window.workspace.state.selectedFilePaths), ["/beta.txt"]);
  await request("/file/preview?path=%2Fbeta.txt");
  await action("selectFileEntry", "/alpha.txt");
  const newPreview = await request("/file/preview?path=%2Falpha.txt");
  await finish(newPreview, { path: "/alpha.txt", preview: "text", content: "current preview" });
  await finish(oldPreview, { path: "/alpha.txt", preview: "text", content: "stale preview" });
  assert.equal(await page.evaluate(() => window.workspace.data.filePreview.data.content), "current preview");

  // Refresh selected metadata and preview, even when size and modifiedAt are unchanged.
  await action("refreshCurrentFiles");
  await finish(await request("/files?path=%2F"), listing);
  await finish(await request("/file/preview?path=%2Falpha.txt"), { path: "/alpha.txt", preview: "text", content: "refreshed preview" });
  assert.equal(await page.evaluate(() => window.workspace.data.filePreview.data.content), "refreshed preview");
  await action("refreshCurrentFiles");
  await finish(await request("/files?path=%2F"), listing);
  const priorScope = await request("/file/preview?path=%2Falpha.txt");
  await page.evaluate(() => window.changeScope("two")); await frame();
  const secondScope = await request("/file/preview?path=%2Falpha.txt");
  await page.evaluate(() => window.changeScope("one")); await frame();
  const currentScope = await request("/file/preview?path=%2Falpha.txt");
  await finish(currentScope, { path: "/alpha.txt", preview: "text", content: "current server" });
  await finish(secondScope, { path: "/alpha.txt", preview: "text", content: "other server" });
  await finish(priorScope, "late error", true);
  assert.equal(await page.evaluate(() => window.workspace.data.filePreview.data.content), "current server");
  assert.equal(await page.evaluate(() => window.workspace.data.filePreview.error), "");

  await page.locator('input[type="file"]').setInputFiles({ name: "alpha.txt", mimeType: "text/plain", buffer: Buffer.from("replacement") });
  assert.match(await page.evaluate(() => window.notifications.at(-1)[1]), /already exists/);
  assert.equal(await page.evaluate(() => window.requests.filter(r => r.options.method === "POST").length), 0, "Known duplicates must be rejected before upload");
  await action("clearFileSelection");
  for (const width of [1440, 768, 390, 320]) {
    for (const theme of ["themeLight", "themeDark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => { document.getElementById("root").className = theme; }, theme);
      await search.fill("alpha");
      await frame();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width} ${theme}: horizontal overflow`);
      assert(await search.evaluate(el => { const b = el.getBoundingClientRect(); return b.width > 100 && b.left >= 0 && b.right <= innerWidth; }), `${width} ${theme}: filter is clipped`);
      if (width <= 720) assert(await page.locator(".fileCompactMetadata").isVisible(), "Mobile rows should show type and size");
      await search.press("Escape");
      assert.equal(await search.inputValue(), "");
    }
  }
  await search.fill("alpha");
  await action("navigateFiles", "/config");
  await finish(await request("/files?path=%2Fconfig"), { path: "/config", entries: [] });
  assert.equal(await search.inputValue(), "", "Navigation should reset the folder filter");
  await page.getByText("This folder is empty", { exact: true }).waitFor();
  await page.evaluate(() => window.unmount());
  console.log("Files workspace passed: filtering, selection, keyboard, preview races, duplicate uploads, and responsive layouts.");
} finally {
  await browser.close();
}
