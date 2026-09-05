import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { launchBrowser, repositoryRoot } from './lib/demo-harness.mjs';

// Render the real hook and modal with deferred API responses, so races are
// deterministic and require neither a live server nor real edit leases.
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useFileEditorSession } from './web/src/features/files/useFileEditorSession';
    import { FileEditorModal } from './web/src/components/FileEditorModal';
    window.requests = []; window.notifications = [];
    window.heartbeat = null;
    const originalInterval = window.setInterval.bind(window);
    const originalClear = window.clearInterval.bind(window);
    window.setInterval = (fn, ms) => { if (ms !== 20000) return originalInterval(fn, ms); window.heartbeat = fn; return -1; };
    window.clearInterval = id => { if (id === -1) window.heartbeat = null; else originalClear(id); };
    const noop = () => {};
    const options = {
      activeServer: { id: 'one' }, activeServerIsDemo: false,
      permissionUser: { permissions: ['files.view', 'files.edit'], role: 'admin' },
      listing: { path: '/', entries: [] }, setListing: noop,
      demoFiles: {}, setDemoFiles: noop, demoInstalledMods: [],
      isProvisioning: false, dockerOperationalLock: false,
      runtimeControlsDisabledReason: '', serverRequiresStoppedForMutableConfig: false,
      stoppedServerMutationMessage: '', formatDisplayDate: String,
      notify: (...args) => window.notifications.push(args), setNotice: noop,
      handleStaleSession: () => false, setSelectedFilePaths: noop,
      setFocusedFilePath: noop, setSelectionAnchorPath: noop, refreshFiles: async () => {}
    };
    function Harness() {
      const session = useFileEditorSession(options);
      window.session = session;
      const s = session.state, a = session.actions;
      return <FileEditorModal selectedPath={s.selectedPath} editorText={s.editorText}
        dirty={s.dirty} fileOpening={s.fileOpening} fileOpenFailed={s.fileOpenFailed}
        fileReadError={s.fileReadError} fileSaving={s.fileSaving} editing={s.fileEditMode}
        editBusy={s.fileLeaseBusy} editMessage={s.fileLeaseMessage} editDisabled={false}
        editorDisabled={!s.fileEditMode} saveDisabled={!s.fileEditMode || s.fileSaving || !s.dirty}
        discardRequestOpen={!!s.discardEditorRequest} onTextChange={a.setEditorText}
        onRequestClose={a.requestCloseEditor} onCancel={a.cancelFileEdit} onSave={a.saveFile}
        onCopy={noop} onEnterEdit={a.enterFileEditMode} onRetryOpen={noop}
        onKeepEditing={() => a.setDiscardEditorRequest(null)} onDiscardChanges={a.discardEditorChanges} />;
    }
    const root = createRoot(document.getElementById('root'));
    window.changeScope = id => { options.activeServer = { id }; root.render(<Harness />); };
    window.unmount = () => root.unmount();
    root.render(<Harness />);
  `, resolveDir: repositoryRoot, loader: 'tsx' },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'deferred-api', setup(builder) {
    builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
      export class ApiError extends Error {}
      export function api(url, options = {}) {
        return new Promise((resolve, reject) => {
          window.requests.push({ url, method: options.method || 'GET', body: options.body, resolve, reject });
          if (options.method === 'DELETE') resolve({ ok: true });
        });
      }
    ` }));
  } }]
});
const browser = await launchBrowser(chromium);
try {
  const styles = await build({ entryPoints: ['web/src/styles.css'], absWorkingDir: repositoryRoot,
    bundle: true, write: false, external: ['*.woff2', '*.woff', '*.ttf', '*.svg', '*.png'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.session);
  const state = () => page.evaluate(() => window.session.state);
  const action = async (name, ...args) => {
    await page.evaluate(({ name, args }) => { void window.session.actions[name](...args); }, { name, args });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  const request = async (method, suffix) => {
    const index = await page.evaluate(({ method, suffix }) => window.requests.findIndex(r => !r.used && r.method === method && r.url.endsWith(suffix)), { method, suffix });
    assert(index >= 0, `Missing ${method} ${suffix}`);
    await page.evaluate(i => { window.requests[i].used = true; }, index);
    return index;
  };
  const finish = async (index, value, fail = false) => {
    await page.evaluate(({ index, value, fail }) => {
      const r = window.requests[index];
      if (fail) r.reject(new Error(value)); else r.resolve(value);
    }, { index, value, fail });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  };
  const open = async (path = '/a.txt') => {
    await action('openFile', path, true);
    await finish(await request('GET', '/file?path=' + encodeURIComponent(path)), { path, content: 'original', revision: 'r1' });
  };
  const edit = async (id = 'lease1') => {
    await action('enterFileEditMode');
    const index = await request('POST', '/file/lease');
    await finish(index, { lease: { serverId: 'one', leaseId: id } });
    return page.evaluate(i => JSON.parse(window.requests[i].body), index);
  };

  await open(); await edit();
  await action('setEditorText', 'sent');
  await page.evaluate(() => window.heartbeat());
  const heartbeat = await request('POST', '/heartbeat');
  await action('saveFile');
  const save = await request('PUT', '/file');
  await page.locator('.cm-content[contenteditable="true"]').waitFor();
  await action('setEditorText', 'newer text');
  await finish(save, { revision: 'r2' });
  assert.equal((await state()).editorText, 'newer text');
  assert.equal((await state()).savedEditorText, 'sent');
  assert.equal((await state()).dirty, true);
  assert.equal((await state()).fileEditMode, false);
  await finish(heartbeat, 'Lease consumed', true);
  assert.equal((await state()).fileLeaseMessage, '');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  assert.equal((await state()).discardEditorRequest.action, 'close');
  await action('setDiscardEditorRequest', null);
  assert.equal((await edit('lease2')).revision, 'r2');
  await action('saveFile');
  await finish(await request('PUT', '/file'), { revision: 'r3' });
  assert.equal((await state()).dirty, false);

  // Closed and superseded reads cannot reopen or clear a newer loading state.
  await action('openFile', '/late.txt');
  const lateRead = await request('GET', '/file?path=%2Flate.txt');
  await action('requestCloseEditor');
  await finish(lateRead, { path: '/late.txt', content: 'late', revision: 'old' });
  assert.equal((await state()).selectedPath, '');
  await action('openFile', '/old.txt');
  const oldRead = await request('GET', '/file?path=%2Fold.txt');
  await action('openFile', '/new.txt');
  const newRead = await request('GET', '/file?path=%2Fnew.txt');
  await finish(oldRead, 'Late read failure', true);
  assert.equal((await state()).fileOpening, true);
  assert.equal((await state()).fileReadError, '');
  await finish(newRead, { path: '/new.txt', content: 'new', revision: 'r1' });

  // A lease acquired after close must be released, never adopted.
  await action('enterFileEditMode');
  const lateLease = await request('POST', '/file/lease');
  await action('requestCloseEditor');
  await finish(lateLease, { lease: { serverId: 'one', leaseId: 'orphan' } });
  await request('DELETE', '/file/lease/orphan');
  assert.equal((await state()).fileEditMode, false);

  await open(); await edit('old-heartbeat');
  await page.evaluate(() => window.heartbeat());
  const oldHeartbeat = await request('POST', '/heartbeat');
  await open('/heartbeat.txt'); await edit('current-heartbeat');
  await finish(oldHeartbeat, { lease: { serverId: 'one', leaseId: 'old-heartbeat' } });
  await action('setEditorText', 'current'); await action('saveFile');
  const heartbeatSave = await request('PUT', '/file');
  assert.equal(await page.evaluate(i => JSON.parse(window.requests[i].body).leaseId, heartbeatSave), 'current-heartbeat');
  await finish(heartbeatSave, { revision: 'current' });

  await open(); await action('enterFileEditMode');
  const failedLease = await request('POST', '/file/lease');
  await open('/lease.txt'); await action('enterFileEditMode');
  const currentLease = await request('POST', '/file/lease');
  await finish(failedLease, 'Old lease failure', true);
  assert.equal((await state()).fileLeaseBusy, true);
  assert.equal((await state()).fileLeaseMessage, '');
  await finish(currentLease, { lease: { serverId: 'one', leaseId: 'current' } });

  for (const fail of [false, true]) {
    await open(); await edit(); await action('setEditorText', 'old save');
    await action('saveFile');
    const oldSave = await request('PUT', '/file');
    await open('/next.txt'); await edit('next');
    await action('setEditorText', 'next save'); await action('saveFile');
    const nextSave = await request('PUT', '/file');
    await finish(oldSave, fail ? 'Late save failure' : { revision: 'old' }, fail);
    assert.equal((await state()).fileSaving, true);
    assert.equal((await state()).savedEditorText, 'original');
    assert.equal((await state()).fileReadError, '');
    await finish(nextSave, { revision: 'next' });
  }

  await action('openFile', '/scope.txt');
  const scopeRead = await request('GET', '/file?path=%2Fscope.txt');
  await page.evaluate(() => window.changeScope('two'));
  await finish(scopeRead, { path: '/scope.txt', content: 'stale scope', revision: 'old' });
  assert.equal((await state()).selectedPath, '');
  await open();
  await action('enterFileEditMode');
  const unmountedLease = await request('POST', '/file/lease');
  await page.evaluate(() => window.unmount());
  await finish(unmountedLease, { lease: { serverId: 'two', leaseId: 'unmounted' } });
  await request('DELETE', '/file/lease/unmounted');
  console.log('File editor session smoke passed: saved text, lease renewal, stale reads/saves/heartbeats, scope changes, and unmount cleanup.');
} finally {
  await browser.close();
}
