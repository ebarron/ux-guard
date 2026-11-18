import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEBT_RULES, baselineFromScan, compare, scanSource, validateBaseline } from '../lib/patterns.mjs';
import { ConfigError } from '../lib/yaml.mjs';
import { config, ts } from './helpers.mjs';

const cfg = config();

function scanOf(files) {
  const inventory = {};
  const debt = Object.fromEntries(DEBT_RULES.map((rule) => [rule, {}]));
  for (const [file, text] of Object.entries(files)) {
    const result = scanSource(ts, file, text, cfg);
    for (const { key, value } of result.controls) {
      inventory[key] ??= {};
      inventory[key][value] = (inventory[key][value] ?? 0) + 1;
    }
    for (const rule of DEBT_RULES) if (result.debt[rule]) debt[rule][file] = result.debt[rule];
  }
  return { files: Object.keys(files), inventory, debt };
}

test('records control values only for configured components from the configured module', () => {
  const { controls } = scanSource(
    ts,
    'a.tsx',
    `import { Button as PrimaryButton, IconButton } from '@example/ui';
     import { Button } from './local';
     export const A = () => (<>
       <PrimaryButton size="xs" variant={active ? 'filled' : 'light'} />
       <IconButton size={16} variant={pick()} />
       <Button size="huge" />
     </>);`,
    cfg,
  );
  assert.deepEqual(controls, [
    { key: 'Button.size', value: 'xs' },
    { key: 'Button.variant', value: 'filled' },
    { key: 'Button.variant', value: 'light' },
    { key: 'IconButton.size', value: '16' },
    { key: 'IconButton.variant', value: 'dynamic' },
  ]);
});

test('counts each debt rule', () => {
  const { debt } = scanSource(
    ts,
    'b.tsx',
    `import { CommunityIcon } from 'community-icons';
     import { AddIcon } from '@example/icons';
     import './x.css';
     export const B = () => (
       <div style={{ width: '12px', margin: \`4px \${gap}px\`, color: 'rgba(0,0,0,.5)', border: '1px solid #abc' }}>
         <button type="button" /><a href="#add">add</a>
       </div>
     );`,
    cfg,
  );
  assert.deepEqual(debt, {
    'inline-style': 1,
    'px-literal': 3,
    'raw-button': 1,
    'icon-library': 1,
    'hard-coded-color': 2,
  });
});

test('compare blocks new control values and per-file debt growth, and reports stale entries', () => {
  const before = scanOf({
    'a.tsx': `import { Button } from '@example/ui'; export const A = () => <div style={{}}><Button size="xs" /></div>;`,
    'b.tsx': `export const B = () => <div style={{}} />;`,
  });
  const baseline = baselineFromScan(before);
  assert.deepEqual(compare(before, baseline), { findings: [], stale: [] });

  const after = scanOf({
    'a.tsx': `import { Button } from '@example/ui'; export const A = () => <div style={{}}><span style={{}} /><Button size="xl" /></div>;`,
    'c.tsx': `export const C = () => <div style={{}} />;`,
  });
  const { findings, stale } = compare(after, baseline);
  assert.deepEqual(
    findings.map(({ rule, key, value, file, count, limit }) => ({ rule, key, value, file, count, limit })),
    [
      { rule: 'new-control-value', key: 'Button.size', value: 'xl', file: undefined, count: 1, limit: undefined },
      { rule: 'inline-style', key: undefined, value: undefined, file: 'a.tsx', count: 2, limit: 1 },
      { rule: 'inline-style', key: undefined, value: undefined, file: 'c.tsx', count: 1, limit: 0 },
    ],
  );
  assert.deepEqual(stale, [
    { rule: 'unused-control-value', key: 'Button.size', value: 'xs' },
    { rule: 'inline-style', file: 'b.tsx', count: 0, limit: 1 },
  ]);
});

test('baselines are deterministic and malformed baselines fail closed', () => {
  const scan = scanOf({ 'z.tsx': '<div style={{}} />', 'a.tsx': '<div style={{}} />' });
  assert.deepEqual(Object.keys(baselineFromScan(scan).debt['inline-style']), ['a.tsx', 'z.tsx']);
  const good = baselineFromScan(scan);
  assert.doesNotThrow(() => validateBaseline(structuredClone(good)));
  for (const mutate of [
    (b) => (b.version = 2),
    (b) => delete b.debt['raw-button'],
    (b) => (b.debt['raw-button'] = []),
    (b) => (b.debt['inline-style']['a.tsx'] = 0),
    (b) => (b.controlValues['Button.size'] = [1]),
    (b) => (b.controlValues['Button.size'] = ['xs', 'xs']),
    (b) => (b.controlValues = []),
  ]) {
    const bad = structuredClone(good);
    mutate(bad);
    assert.throws(() => validateBaseline(bad), ConfigError);
  }
});
