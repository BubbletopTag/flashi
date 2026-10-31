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
