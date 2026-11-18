import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveExistingRepositoryPath } from './config.mjs';
import { ConfigError } from './yaml.mjs';

export const DEBT_RULES = [
  'inline-style',
  'px-literal',
  'raw-button',
  'icon-library',
  'hard-coded-color',
];

const PX = /(?<![\w.-])\d+(?:\.\d+)?px\b/g;
const HEX = /(?:^|[\s,(:])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?)\(/g;

export function listSourceFiles(root, config) {
  const { roots, extensions, exclude } = config.patterns;
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      throw new ConfigError(`pattern root ${relative(root, dir) || '.'} could not be read from the working tree`);
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      if (exclude.some((suffix) => entry.name.endsWith(suffix))) continue;
      files.push(relative(root, full).split(sep).join('/'));
    }
  };
  for (const scanRoot of roots) {
    walk(resolveExistingRepositoryPath(root, scanRoot, `pattern root ${scanRoot}`, true));
  }
  if (files.length === 0) throw new ConfigError('pattern scan found no source files');
  return files.sort();
}

// scanSource returns control-prop values and debt counts for one file.
export function scanSource(ts, fileName, text, config) {
  const { components, icons } = config.patterns;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const controls = [];
  const debt = Object.fromEntries(DEBT_RULES.map((rule) => [rule, 0]));
  const localComponents = new Map();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    if (isIconModule(moduleName, icons) && !icons.allowed.includes(moduleName)) debt['icon-library'] += 1;
    if (moduleName !== components.module) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (components.names.includes(imported)) localComponents.set(element.name.text, imported);
    }
  }

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (tag === 'button') debt['raw-button'] += 1;
      const component = localComponents.get(tag);
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const name = attribute.name.getText(source);
        if (name === 'style' && attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
          debt['inline-style'] += 1;
        }
        if (component && components.props.includes(name)) {
          for (const value of attributeValues(ts, attribute)) {
            controls.push({ key: `${component}.${name}`, value });
          }
        }
      }
    }
    if (ts.isStringLiteralLike(node) && !ts.isImportDeclaration(node.parent) && !isFragmentLink(ts, node)) {
      countText(node.text, debt);
    } else if (ts.isTemplateExpression(node)) {
      countText(node.head.text, debt);
      for (const span of node.templateSpans) countText(span.literal.text, debt);
    } else if (ts.isJsxText(node)) {
      countText(node.text, debt);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { controls, debt };
}

// `href="#add"` is a fragment link, not the color #add.
function isFragmentLink(ts, node) {
  return ts.isJsxAttribute(node.parent) && node.parent.name.getText() === 'href';
}

function isIconModule(moduleName, icons) {
  return icons.modules.some((prefix) => moduleName === prefix || moduleName.startsWith(`${prefix}/`));
}

function countText(text, debt) {
  debt['px-literal'] += text.match(PX)?.length ?? 0;
  debt['hard-coded-color'] += (text.match(HEX)?.length ?? 0) + (text.match(COLOR_FUNCTION)?.length ?? 0);
}

// A conditional whose branches are literals contributes each literal, so
// `{active ? 'filled' : 'light'}` reads as filled and light.
function attributeValues(ts, attribute) {
  const init = attribute.initializer;
  if (!init) return ['true'];
  if (ts.isStringLiteral(init)) return [init.text];
  if (ts.isJsxExpression(init) && init.expression) return expressionValues(ts, init.expression);
  return ['dynamic'];
}

function expressionValues(ts, expression) {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return [expression.text];
  if (ts.isConditionalExpression(expression)) {
    return [...expressionValues(ts, expression.whenTrue), ...expressionValues(ts, expression.whenFalse)];
  }
  return ['dynamic'];
}

export function scanFiles(ts, root, config, files) {
  const inventory = Object.create(null);
  const debt = Object.fromEntries(DEBT_RULES.map((rule) => [rule, Object.create(null)]));
  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolveExistingRepositoryPath(root, file, `pattern source ${file}`), 'utf8');
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(`pattern source ${file} could not be read from the working tree`);
    }
    const result = scanSource(ts, file, text, config);
    for (const { key, value } of result.controls) {
      inventory[key] ??= Object.create(null);
      inventory[key][value] = (inventory[key][value] ?? 0) + 1;
    }
    for (const rule of DEBT_RULES) {
      if (result.debt[rule] > 0) debt[rule][file] = result.debt[rule];
    }
  }
  return { files, inventory, debt };
}

export function baselineFromScan(scan) {
  const controlValues = {};
  for (const key of Object.keys(scan.inventory).sort()) {
    controlValues[key] = Object.keys(scan.inventory[key]).sort();
  }
  const debt = {};
  for (const rule of DEBT_RULES) {
    debt[rule] = Object.fromEntries(Object.entries(scan.debt[rule]).sort(([a], [b]) => a.localeCompare(b)));
  }
  return { version: 1, controlValues, debt };
}

export function validateBaseline(baseline) {
  if (!isRecord(baseline) || baseline.version !== 1 || !isRecord(baseline.controlValues) || !isRecord(baseline.debt)) {
    throw new ConfigError('pattern baseline is malformed');
  }
  for (const rule of DEBT_RULES) {
    const counts = baseline.debt[rule];
    if (!isRecord(counts)) throw new ConfigError(`pattern baseline lacks ${rule}`);
    for (const [file, count] of Object.entries(counts)) {
      if (!Number.isInteger(count) || count < 1) {
        throw new ConfigError(`pattern baseline has an invalid ${rule} count for ${file}`);
      }
    }
  }
  for (const [key, values] of Object.entries(baseline.controlValues)) {
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== 'string') ||
      new Set(values).size !== values.length
    ) {
      throw new ConfigError(`pattern baseline has invalid values for ${key}`);
    }
  }
  return baseline;
}

export function compare(scan, baseline) {
  const findings = [];
  const stale = [];
  for (const [key, counts] of Object.entries(scan.inventory).sort(([a], [b]) => a.localeCompare(b))) {
    const known = new Set(Object.hasOwn(baseline.controlValues, key) ? baseline.controlValues[key] : []);
    for (const [value, count] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
      if (!known.has(value)) {
        findings.push({ rule: 'new-control-value', key, value, count, message: `${key}=${value} is a new control value` });
      }
    }
  }
  for (const [key, values] of Object.entries(baseline.controlValues).sort(([a], [b]) => a.localeCompare(b))) {
    for (const value of values) {
      if (!scan.inventory[key]?.[value]) stale.push({ rule: 'unused-control-value', key, value });
    }
  }
  for (const rule of DEBT_RULES) {
    const current = scan.debt[rule];
    const allowed = baseline.debt[rule];
    for (const [file, count] of Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) {
      const limit = Object.hasOwn(allowed, file) ? allowed[file] : 0;
      if (count > limit) {
        findings.push({ rule, file, count, limit, message: `${file}: ${rule} grew from ${limit} to ${count}` });
      }
    }
    for (const [file, limit] of Object.entries(allowed).sort(([a], [b]) => a.localeCompare(b))) {
      const count = current[file] ?? 0;
      if (count < limit) stale.push({ rule, file, count, limit });
    }
  }
  return { findings, stale };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function renderComparison(scan, result) {
  const lines = [`Pattern scan: ${scan.files.length} files`];
  for (const [key, counts] of Object.entries(scan.inventory).sort(([a], [b]) => a.localeCompare(b))) {
    const summary = Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => `${value} ${count}`)
      .join(', ');
    lines.push(`  ${key}: ${summary}`);
  }
  for (const rule of DEBT_RULES) {
    const total = Object.values(scan.debt[rule]).reduce((sum, count) => sum + count, 0);
    lines.push(`  ${rule}: ${total} in ${Object.keys(scan.debt[rule]).length} files`);
  }
  lines.push(`Findings: ${result.findings.length}`);
  for (const finding of result.findings) lines.push(`  - ${finding.rule}: ${finding.message}`);
  lines.push(`Stale baseline entries: ${result.stale.length}`);
  return `${lines.join('\n')}\n`;
}
