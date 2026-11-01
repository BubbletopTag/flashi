// SPDX-License-Identifier: AGPL-3.0-or-later
export type Appearance = 'system' | 'light' | 'dark';
export function applyAppearance(appearance: Appearance): void {
  const dark = appearance === 'dark' || (appearance === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.colorMode = dark ? 'dark' : 'light';
  const style = getComputedStyle(document.documentElement);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', style.getPropertyValue('--app-bar').trim() || style.getPropertyValue('--primary').trim());
}
