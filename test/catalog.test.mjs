import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navSurfaces, validateCatalog } from '../lib/catalog.mjs';
import { ConfigError, parseYamlSubset } from '../lib/yaml.mjs';
import { CATALOG, NAV, ts } from './helpers.mjs';

const surfaces = navSurfaces(ts, 'nav.tsx', NAV);

test('reads navigation surfaces from nested object literals', () => {
  const nested = navSurfaces(
    ts,
    'nav.tsx',
    `export const n = [{ id: 'settings', route: '/settings', destination: false,
      children: [{ id: 'smtp', label: 'Email', route: '/settings/smtp', hiddenInMenu: true }] }];`,
  );
  assert.deepEqual(
    nested.map(({ id, route, destination, hidden }) => [id, route, destination, hidden]),
    [
      ['settings', '/settings', false, false],
      ['smtp', '/settings/smtp', true, true],
    ],
  );
});

test('reports navigation surfaces that no use case covers', () => {
  const report = validateCatalog(parseYamlSubset(CATALOG), surfaces);
  assert.deepEqual(report.unmapped.map((surface) => surface.id), ['dashboard']);
});

test('accepts assistant starts and deep routes under a surface', () => {
  const catalog = parseYamlSubset(CATALOG);
  catalog.use_cases[0].starts.push(
    { entry: 'assistant', prompt: 'Create a record' },
    { nav_id: 'records', route: '/records/new' },
  );
  assert.equal(validateCatalog(catalog, surfaces).useCases.length, 1);
});

test('rejects malformed use cases', () => {
  const cases = {
    'unknown navigation id': (c) => (c.use_cases[0].starts[0].nav_id = 'absent'),
    'route outside its surface': (c) => (c.use_cases[0].starts[0].route = '/recording'),
    'extra start key': (c) => (c.use_cases[0].starts[0].label = 'x'),
    'invalid tier': (c) => (c.use_cases[0].tier = 'urgent'),
    'invalid effect': (c) => (c.use_cases[0].effect = 'delete'),
    'missing success': (c) => delete c.use_cases[0].success,
    'duplicate id': (c) => c.use_cases.push(structuredClone(c.use_cases[0])),
    'uppercase id': (c) => (c.use_cases[0].id = 'Create-Record'),
    'assistant start without prompt': (c) => (c.use_cases[0].starts = [{ entry: 'assistant' }]),
    'non-text gap': (c) => (c.use_cases[0].gaps = [3]),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const catalog = parseYamlSubset(CATALOG);
    mutate(catalog);
    assert.throws(() => validateCatalog(catalog, surfaces), ConfigError, name);
  }
});
