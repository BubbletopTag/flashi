// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

const fixture = resolve('fixtures/decks/schema18-noscheduling.apkg');
async function importDeck(page: Page, path = fixture) {
  await page.locator('#import-file').setInputFiles(path);
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.deck-row').filter({ has: page.getByText('Many', { exact: true }) })).toBeVisible();
}
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.locator('.drawer').getByRole('button', { name: 'Settings', exact: true }).click();
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const request = indexedDB.open('flashi'); request.onsuccess = () => res(request.result); request.onerror = () => rej(request.error);
    });
    const value = await new Promise<Uint8Array>((res, rej) => {
      const request = db.transaction('kv').objectStore('kv').get('collection'); request.onsuccess = () => res(request.result); request.onerror = () => rej(request.error);
    });
    db.close(); return Array.from(value ?? []);
  });
}

for (const target of ['artifact', 'pwa'] as const) {
  test(`${target}: import, study 20, reload, export and reimport scheduling`, async ({ page, context }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(target === 'artifact' ? '/dist/flashi.html' : '/dist-pwa/');
    await expect(page.getByText('Collection is empty')).toBeVisible();
    await importDeck(page);
    await page.locator('.deck-row').filter({ has: page.getByText('Many', { exact: true }) }).click();
    for (let i = 0; i < 20; i++) {
      await page.locator('#show-answer').click();
      await page.locator('#ease-4').click();
    }
    if (await page.getByRole('button', { name: 'Back to decks' }).first().isVisible()) await page.getByRole('button', { name: 'Back to decks' }).first().click();
    await expect(page.locator('.studied-today')).toContainText('Studied 20 cards');
    // Reload immediately: the answer journal must cover the debounced snapshot.
    await page.reload();
    await expect(page.locator('.studied-today')).toContainText('Studied 20 cards');
    await settings(page);
    if (target === 'pwa') {
      await expect(page.getByText('Automatic backups', { exact: true })).toBeVisible();
      // Confirms the Worker-backed OPFS store was selected, not a silent IDB fallback.
      await expect.poll(() => page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        return !!(await root.getDirectoryHandle('flashi-sqlite'));
      })).toBeTruthy();
    }
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: /^Export backup/ }).click();
    const download = await downloadEvent;
    const path = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(path);
    const zip = unzipSync(new Uint8Array(await readFile(path)));
    expect(zip['collection.anki21']).toBeDefined();
    const collectionBefore = target === 'artifact' ? await snapshot(page) : null;
    await context.close();
    const fresh = await page.context().browser()!.newContext({ viewport: { width: 393, height: 852 } });
    const restored = await fresh.newPage();
    await restored.goto('/dist/flashi.html');
    await importDeck(restored, path);
    await expect(restored.locator('.studied-today')).toContainText('Studied 20 cards');
    if (collectionBefore) expect(collectionBefore.length).toBeGreaterThan(1000);
    await fresh.close();
    expect(errors).toEqual([]);
  });
}

test('storage refusal still allows importing and exporting', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
  await page.goto('/dist/flashi.html');
  await expect(page.getByRole('alert')).toContainText('Storage is unavailable');
  await importDeck(page);
  const download = page.waitForEvent('download');
  await page.getByRole('alert').getByRole('button', { name: 'Export' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.apkg$/);
});

test('delete requires confirmation and clears the collection', async ({ page }) => {
  await page.goto('/dist-pwa/');
  await importDeck(page);
  await settings(page);
  await page.getByRole('button', { name: /^Delete all data/ }).click();
  await expect(page.getByRole('dialog')).toContainText('permanently removes');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: /^Delete all data/ }).click();
  await page.getByRole('button', { name: 'Delete everything', exact: true }).click();
  await expect(page.getByText('Collection is empty')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Collection is empty')).toBeVisible();
});

test('PWA starts and reviews offline with its self-hosted assets', async ({ page, context }) => {
  await page.goto('/dist-pwa/');
  await importDeck(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBeTruthy();
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.deck-row').filter({ has: page.getByText('Many', { exact: true }) })).toBeVisible();
  await page.locator('.deck-row').filter({ has: page.getByText('Many', { exact: true }) }).click();
  await page.locator('#show-answer').click();
  await page.locator('#ease-3').click();
  await expect(page.locator('#show-answer')).toBeVisible();
});

test('blocked WebAssembly reports an error instead of hanging', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(WebAssembly, 'instantiate', { value: () => Promise.reject(new Error('WASM blocked by CSP')) }); });
  await page.goto('/dist/flashi.html');
  await expect(page.locator('#app')).toContainText("Flashi couldn't start: WASM blocked by CSP");
});

test('an answer undo survives immediate reload', async ({ page }) => {
  await page.goto('/dist/flashi.html');
  await importDeck(page);
  await page.locator('.deck-row').filter({ has: page.getByText('Many', { exact: true }) }).click();
  await expect(page.locator('iframe')).toHaveAttribute('srcdoc', /<!doctype/i);
  const front = await page.locator('iframe').getAttribute('srcdoc');
  await page.locator('#show-answer').click();
  await page.locator('#ease-4').click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Answer card undone');
  await expect(page.locator('iframe')).toHaveAttribute('srcdoc', front!);
  await page.reload();
  await expect(page.locator('.studied-today')).toHaveText('');
});

test('a second tab cannot overwrite the active collection', async ({ page, context }) => {
  await page.goto('/dist-pwa/');
  await expect(page.getByText('Collection is empty')).toBeVisible();
  const second = await context.newPage();
  await second.goto('/dist-pwa/');
  await expect(second.locator('#app')).toContainText('already open in another tab');
  await page.close();
  await second.reload();
  await expect(second.getByText('Collection is empty')).toBeVisible();
});

test('PWA migrates collection and media from IndexedDB, then exports automatic backups', async ({ page }) => {
  await page.goto('/dist/flashi.html');
  await importDeck(page);
  await page.goto('/dist-pwa/');
  await expect(page.locator('.deck-row').filter({ has: page.getByText('Many', { exact: true }) })).toBeVisible();
  await settings(page);
  await expect(page.getByText('Automatic backups', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download this backup/ }).first().click();
  expect((await download).suggestedFilename()).toContain('automatic.apkg');
});

test('import retains the browser file grant through asynchronous archive reads', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Blob.prototype.slice;
    Blob.prototype.slice = function (...args: Parameters<Blob['slice']>) {
      // Model a file provider that revokes access when its picker selection is
      // cleared. ZIP import needs multiple reads after the change handler ends.
      if (this instanceof File && this.name.endsWith('.apkg') && !document.querySelector<HTMLInputElement>('#import-file')?.files?.length) {
        throw new DOMException('File access was revoked', 'NotReadableError');
      }
      return original.apply(this, args);
    };
  });
  await page.goto('/dist-pwa/');
  await importDeck(page);
});

test('notes, browser actions, statistics and dark appearance work and persist', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const navigate = async (name: string) => {
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.locator('.drawer').getByRole('button', { name, exact: true }).click();
  };
  await page.goto('/dist-pwa/');
  await expect(page.getByText('Collection is empty')).toBeVisible();
  await navigate('Add note');
  await page.getByLabel('Note type', { exact: true }).selectOption({ label: 'Basic' });
  await page.getByLabel('Front', { exact: true }).fill('A new local note');
  await page.getByRole('textbox', {name:'Back', exact:true}).fill('A saved answer');
  await page.getByLabel('Tags', { exact: true }).fill('local::test marked');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('dialog').locator('iframe')).toHaveAttribute('srcdoc', /A new local note/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.inline-status')).toContainText('Added 1 card');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await navigate('Card browser');
  await page.getByRole('searchbox', { name: 'Search cards' }).fill('tag:local');
  await expect(page.locator('.browser-row')).toHaveCount(1);
  await page.getByRole('checkbox', { name: 'Select A new local note' }).check();
  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  await expect(page.locator('.browser-row')).toHaveClass(/suspended/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.browser-row')).not.toHaveClass(/suspended/);
  await page.getByRole('button', { name: 'Card info: A new local note', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Review history');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await navigate('Decks');
  await page.locator('.deck-row').filter({has:page.getByText('Default', {exact:true})}).click();
  await expect(page.locator('iframe')).toHaveAttribute('srcdoc', /A new local note/);
  await page.locator('#show-answer').click(); await page.locator('#ease-4').click();
  await page.getByRole('button', {name:'Back to decks',exact:true}).first().click();
  await navigate('Statistics');
  await expect(page.getByRole('heading',{name:'Today',exact:true})).toBeVisible();
  await expect(page.locator('.today-lines')).toContainText('Studied 1 card');
  await expect(page.getByRole('heading',{name:'Future Due',exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('statistics-light.png'),fullPage:true});
  await navigate('Settings');
  await page.getByLabel('Appearance', {exact:true}).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-color-mode','dark');
  await navigate('Statistics');
  await page.screenshot({path:testInfo.outputPath('statistics-dark.png'),fullPage:true});
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-color-mode','dark');
  await navigate('Card browser');
  await expect(page.locator('.browser-row')).toContainText('A saved answer');
  expect(await page.locator('link[rel="icon"]').getAttribute('href')).toContain('image/svg+xml');
  expect(errors).toEqual([]);
});

test('deck presets, learning labels, rename and deletion undo work on mobile', async ({page})=>{
  const navigate=async(name:string)=>{await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.locator('.drawer').getByRole('button',{name,exact:true}).click();};
  await page.goto('/dist-pwa/');await importDeck(page);
  await navigate('Deck options');
  await page.getByLabel('Options deck',{exact:true}).selectOption({label:'Flashi Test::Many'});
  await page.getByRole('button',{name:'Clone preset',exact:true}).click();await page.getByLabel('New preset name').fill('Mobile study');await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('spinbutton',{name:'New cards/day',exact:true}).fill('3');await page.getByRole('textbox',{name:'Learning steps',exact:true}).fill('2m 20m');
  await page.getByRole('button',{name:'Save deck options',exact:true}).click();await expect(page.locator('.inline-status')).toContainText('Options saved');
  await page.getByRole('button',{name:'Back to decks',exact:true}).click();await page.locator('.deck-row').filter({has:page.getByText('Many',{exact:true})}).click();await page.locator('#show-answer').click();await expect(page.locator('#ease-1')).toContainText('2m');
  await page.getByRole('button',{name:'Back to decks',exact:true}).first().click();await navigate('Deck options');await page.getByLabel('Options deck',{exact:true}).selectOption({label:'Flashi Test::Many'});
  await page.getByRole('button',{name:'Rename / move',exact:true}).click();await page.getByLabel('Deck name',{exact:true}).fill('Flashi Test::Renamed');await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByLabel('Options deck',{exact:true}).locator('option:checked')).toHaveText('Flashi Test::Renamed');
  await page.getByRole('button',{name:'Delete deck',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.getByLabel('Options deck',{exact:true}).locator('option')).toContainText(['Default','Flashi Test','Flashi Test::Renamed']);
  await page.reload();await navigate('Deck options');await page.getByLabel('Options deck',{exact:true}).selectOption({label:'Flashi Test::Renamed'});await expect(page.getByLabel('Options preset',{exact:true}).locator('option:checked')).toHaveText('Mobile study');
});
