// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { ssim } from 'ssim.js';
import fixture from '../fixtures/golden-fixture.json' with { type: 'json' };

type Rect = [number, number, number, number];
const exists = (path: string) => access(path).then(() => true, () => false);
const report = resolve('golden/report');
await mkdir(report, { recursive: true });
const html = await readFile('dist-golden/flashi.html');
const server = createServer((_req, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not start screenshot server');
const browser = await chromium.launch();
const results: Array<{ screen: string; status: string; mismatch?: number; ssim?: number; budget: number }> = [];
try {
  for (const screen of fixture.screens) {
    const referencePath = `golden/android/${screen}.png`;
    const hasReference = await exists(referencePath);
    const reference = hasReference ? PNG.sync.read(await readFile(referencePath)) : null;
    const meta = await exists(`golden/android/${screen}.json`) ? JSON.parse(await readFile(`golden/android/${screen}.json`, 'utf8')) : null;
    if (hasReference && !(meta?.density > 0)) throw new Error(`Missing recorded density for ${screen}; re-record its Android metadata`);
    const density = meta?.density ?? 2;
    const width = reference ? Math.round(reference.width / density) : 393;
    const height = reference ? Math.round(reference.height / density) : 852;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: density, timezoneId: 'UTC', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.setFixedTime(new Date(fixture.now));
    await page.goto(`http://127.0.0.1:${address.port}/flashi.html?theme=golden&fixture=golden&screen=${screen}`);
    await page.locator('.toolbar').waitFor().catch(async (error: unknown) => {
      throw new Error(`${screen}: ${await page.locator('#app').textContent()} (${String(error)})`);
    });
    await page.addStyleTag({ content: '*,*::before,*::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
    if (['answer', 'cloze-answer'].includes(screen)) await page.locator('#show-answer').click();
    if (screen === 'overflow') await page.getByRole('button', { name: 'More options' }).click();
    if (['question', 'answer', 'cloze-question', 'cloze-answer', 'overflow'].includes(screen)) {
      await page.locator('iframe[srcdoc]').waitFor();
      await page.waitForFunction(() => !!document.querySelector('iframe')?.getAttribute('srcdoc')?.includes('<body'));
    }
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${report}/${screen}-flashi.png`, animations: 'disabled' });
    await context.close();
    if (errors.length) throw new Error(`${screen}: ${errors.join('; ')}`);
    const budget = 0.05;
    if (!reference) { results.push({ screen, status: 'Awaiting Android reference', budget }); continue; }
    const actual = PNG.sync.read(await readFile(`${report}/${screen}-flashi.png`));
    if (actual.width !== reference.width || actual.height !== reference.height) throw new Error(`${screen}: density rounding produced unequal image dimensions`);
    await writeFile(`${report}/${screen}-android.png`, PNG.sync.write(reference));
    const config = JSON.parse(await readFile(`golden/masks/${screen}.json`, 'utf8')) as { rects: Rect[] };
    const rects = [...config.rects, ...(meta.cardMask ? [meta.cardMask as Rect] : [])];
    const masked = new Set<number>();
    for (const [x, y, w, h] of rects) {
      for (let yy = Math.max(0, Math.floor(y * density)); yy < Math.min(actual.height, Math.ceil((y + h) * density)); yy++) {
        for (let xx = Math.max(0, Math.floor(x * density)); xx < Math.min(actual.width, Math.ceil((x + w) * density)); xx++) {
          const index = yy * actual.width + xx;
          masked.add(index);
          actual.data.fill(255, index * 4, index * 4 + 4);
          reference.data.fill(255, index * 4, index * 4 + 4);
        }
      }
    }
    const diff = new PNG({ width: actual.width, height: actual.height });
    const count = pixelmatch(reference.data, actual.data, diff.data, actual.width, actual.height, { threshold: 0.1, includeAA: false });
    const mismatch = count / Math.max(1, actual.width * actual.height - masked.size);
    const similarity = ssim({ width: reference.width, height: reference.height, data: new Uint8ClampedArray(reference.data) }, { width: actual.width, height: actual.height, data: new Uint8ClampedArray(actual.data) }).mssim;
    await writeFile(`${report}/${screen}-diff.png`, PNG.sync.write(diff));
    results.push({ screen, status: mismatch <= budget ? 'Pass' : 'Over budget', mismatch, ssim: similarity, budget });
  }
} finally {
  await browser.close();
  server.close();
}
await writeFile(`${report}/results.json`, JSON.stringify(results, null, 2));
const rows = results.map((r) => `<section><h2>${r.screen}</h2><p>${r.status}${r.mismatch === undefined ? '' : ` · ${(r.mismatch * 100).toFixed(2)}% mismatch (budget ${r.budget * 100}%) · SSIM ${r.ssim?.toFixed(4)}`}</p><div class="frames">${r.mismatch === undefined ? '' : `<figure><figcaption>Android</figcaption><img src="${r.screen}-android.png"></figure>`}<figure><figcaption>Flashi</figcaption><img src="${r.screen}-flashi.png"></figure>${r.mismatch === undefined ? '' : `<figure><figcaption>Diff overlay</figcaption><img src="${r.screen}-diff.png"></figure>`}</div></section>`).join('');
await writeFile(`${report}/index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Flashi visual report</title><style>body{font:16px system-ui;margin:24px;background:#f6f7f2;color:#1a1c16}.frames{display:flex;gap:16px;overflow:auto}figure{margin:0;flex:0 0 300px}img{width:100%;border:1px solid #bbb}figcaption{padding:8px}section{margin-bottom:32px}h1{font-size:28px}</style><h1>Flashi visual report</h1><p>Fixed fixture and time. Android dimensions come from recorded qualifier density. Missing references are pending, never counted as passing. Reviewer WebView contents are masked because Robolectric does not render them.</p>${rows}</html>`);
console.table(results);
if (results.some((r) => r.status === 'Over budget') || (process.argv.includes('--require-baselines') && results.some((r) => r.mismatch === undefined))) process.exitCode = 1;
