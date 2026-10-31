// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { sha1Fallback } from '../src/anki/sha1';
it('the HTTP media checksum fallback matches SHA-1 across padding and block boundaries', () => {
  for (const length of [0, 1, 3, 55, 56, 63, 64, 65, 127, 128, 4096]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256);
    expect(sha1Fallback(bytes)).toBe(createHash('sha1').update(bytes).digest('hex'));
  }
});
