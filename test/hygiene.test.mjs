import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanProductStrings } from '../scripts/check-product-hygiene.mjs';

test('public-source hygiene rejects consumer and framework assumptions', () => {
  assert.deepEqual(scanProductStrings(), []);

  const root = mkdtempSync(join(tmpdir(), 'ux-guard-hygiene-'));
  mkdirSync(join(root, 'lib'));
  writeFileSync(
    join(root, 'NOTICE'),
    `ux-guard\nCopyright 2026 ${['Net', 'App'].join('')}, Inc.\n`,
  );
  writeFileSync(
    join(root, 'README.md'),
    `Built for ${['Net', 'App'].join('')} systems.\n`,
  );
  writeFileSync(
    join(root, 'lib/example.mjs'),
    `export const framework = '${['man', 'tine'].join('')}';\n`,
  );
  assert.deepEqual(scanProductStrings(root), [
    {
      path: 'lib/example.mjs',
      line: 1,
      rule: 'ui-framework',
    },
    {
      path: 'README.md',
      line: 1,
      rule: 'brand-company',
    },
  ]);
});
