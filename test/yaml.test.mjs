import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, parseYamlSubset } from '../lib/yaml.mjs';
import { CATALOG } from './helpers.mjs';

test('parses mappings, nested list mappings, and quoted text', () => {
  const parsed = parseYamlSubset(`${CATALOG}    requirements:
      - "Username, address, and password: required."
`);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.use_cases[0].starts[0].route, '/records');
  assert.deepEqual(parsed.use_cases[0].requirements, ['Username, address, and password: required.']);
});

test('ignores comments outside quotes and keeps hashes inside quotes', () => {
  const parsed = parseYamlSubset('# heading\nname: "a # b" # trailing\n');
  assert.deepEqual(parsed, { name: 'a # b' });
});

test('rejects input outside the supported subset', () => {
  for (const text of ['key:\tvalue\n', 'note: say: this\n', ' odd: 1\n', 'a: 1\na: 2\n', 'a: "open\n', '']) {
    assert.throws(() => parseYamlSubset(text), ConfigError, JSON.stringify(text));
  }
});
