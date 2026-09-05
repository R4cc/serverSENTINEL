import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { launchBrowser, signInThroughApi, startDemoHarness } from './lib/demo-harness.mjs';

const dataDirectory = await mkdtemp(join(tmpdir(), 'serversentinel-download-smoke-'));
let harness;
let browser;
try {
  // Let demo startup provision its fixed account, then restart the isolated fixture without
  // demo mode's intentional ban on real-server routes. No testing account is created here.
  harness = await startDemoHarness({ dataDirectory });
  await harness.stop();
  harness = await startDemoHarness({ dataDirectory, env: { SERVERSENTINEL_ENABLE_DEMO: 'false' } });
  const id = '11111111-1111-4111-8111-111111111111';
  const serverDir = join(harness.dataDirectory, 'servers', id);
  await mkdir(join(serverDir, 'world'), { recursive: true });
  await writeFile(join(serverDir, 'world', 'hello.txt'), 'Browser-managed download\n');
  const large = await open(join(serverDir, 'large.bin'), 'w');
  await large.truncate(256 * 1024 * 1024);
  await large.close();
  const db = new Database(join(harness.dataDirectory, 'serversentinel.sqlite'));
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO servers
      (id, node_id, display_name, server_dir, storage_name, runtime_profile_json, created_at, updated_at)
      VALUES (?, 'local', 'Download smoke', ?, ?, ?, ?, ?)`).run(id, serverDir, id, JSON.stringify({
      minecraftVersion: '1.21.4', runtimeType: 'fabric', runtimeVersion: '0.16.10',
      javaMajorVersion: 21, jarProvider: 'mcjars', jarArtifact: { filename: 'server.jar' },
      compatibilityStatus: 'compatible', resolvedAt: now
    }), now, now);
  } finally {
    db.close();
  }
  browser = await launchBrowser(chromium);
  const context = await browser.newContext({ acceptDownloads: true });
  await signInThroughApi(context, harness.baseUrl);
  const page = await context.newPage();
  await page.goto(harness.baseUrl);
  await page.locator('.appShell').waitFor();
  const startDownload = async (url) => {
    const pending = page.waitForEvent('download');
    await page.evaluate((href) => {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = '';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    }, url);
    return pending;
  };
  const base = `/api/servers/${id}`;
  const probe = await context.request.get(`${harness.baseUrl}${base}/file/download?path=/world/hello.txt`);
  assert.equal(probe.status(), 200);
  const file = await startDownload(`${base}/file/download?path=/world/hello.txt`);
  assert.equal(await file.failure(), null);
  assert.equal(await readFile(await file.path(), 'utf8'), 'Browser-managed download\n');
  const intent = await context.request.post(`${harness.baseUrl}${base}/files/download/intent`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' }, data: { paths: ['/world'] }
  });
  assert.equal(intent.status(), 200);
  const archive = await startDownload((await intent.json()).url);
  assert.equal(await archive.failure(), null);
  assert.equal((await readFile(await archive.path())).subarray(0, 2).toString(), 'PK');
  const transfer = await startDownload(`${base}/file/download?path=/large.bin`);
  await transfer.cancel();
  assert.match(await transfer.failure(), /cancel/i);
  assert.equal(new URL(page.url()).pathname, '/');
  console.log('Native file/archive downloads and cancellation passed.');
} finally {
  await browser?.close();
  await harness?.stop();
  await rm(dataDirectory, { recursive: true, force: true });
}
