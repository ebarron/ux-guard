import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TYPESCRIPT = createRequire(import.meta.url).resolve('typescript');
export const ts = createRequire(import.meta.url)('typescript');

export function config(overrides = {}) {
  return {
    version: 2,
    catalog: { path: 'ux/use-cases.yml', navigation: ['src/nav.tsx'] },
    patterns: {
      roots: ['src'],
      extensions: ['.tsx'],
      exclude: ['.test.tsx'],
      baseline: 'ux/patterns-baseline.json',
      components: { module: '@example/ui', names: ['Button', 'IconButton'], props: ['size', 'variant'] },
      icons: { modules: ['@example/icons', 'community-icons'], allowed: ['@example/icons'] },
    },
    ...overrides,
  };
}

export const NAV = `export const nav = [
  { id: 'dashboard', label: 'Dashboard', route: '/dashboard' },
  { id: 'records', label: 'Records', route: '/records' },
];
`;

export const CATALOG = `version: 1
inventory: partial
use_cases:
  - id: create-record
    title: Create a record
    persona: Operator
    tier: primary
    effect: create
    owner: product-owner
    goal: "Create a record."
    success: "The record appears."
    starts:
      - nav_id: records
        route: /records
`;

export const PAGE = `import { Button } from '@example/ui';
export function Page() {
  return <Button size="xs" variant="default">Create</Button>;
}
`;

export function tempRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'ux-guard-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

export function capture() {
  let out = '';
  let err = '';
  return {
    io: { out: { write: (text) => (out += text) }, err: { write: (text) => (err += text) } },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}
