import { readFileSync } from 'node:fs';
import { resolveExistingRepositoryPath } from './config.mjs';
import { ConfigError, parseYamlSubset } from './yaml.mjs';

const TIERS = new Set(['primary', 'secondary', 'tertiary']);
const EFFECTS = new Set(['read', 'create', 'change']);
const REQUIRED = ['id', 'title', 'persona', 'tier', 'effect', 'goal', 'success'];
const TEXT_FIELDS = ['title', 'persona', 'goal', 'success'];

// Object literals that declare a string `id` and an absolute string `route`
// are navigation surfaces.
export function navSurfaces(ts, fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const surfaces = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const fields = {};
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(ts, property.name);
        if (!name) continue;
        const init = property.initializer;
        if (ts.isStringLiteralLike(init)) fields[name] = init.text;
        else if (init.kind === ts.SyntaxKind.TrueKeyword) fields[name] = true;
        else if (init.kind === ts.SyntaxKind.FalseKeyword) fields[name] = false;
      }
      if (typeof fields.id === 'string' && typeof fields.route === 'string' && fields.route.startsWith('/')) {
        surfaces.push({
          id: fields.id,
          label: typeof fields.label === 'string' ? fields.label : '',
          route: fields.route,
          hidden: fields.hiddenInMenu === true,
          destination: fields.destination !== false,
          file: fileName,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return surfaces;
}

function propertyName(ts, name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

export function loadCatalog(root, config) {
  return parseYamlSubset(readInput(root, config.catalog.path, 'catalog'));
}

export function loadSurfaces(ts, root, config) {
  const surfaces = [];
  for (const file of config.catalog.navigation) {
    surfaces.push(...navSurfaces(ts, file, readInput(root, file, 'navigation source')));
  }
  if (surfaces.length === 0) throw new ConfigError('no navigation surfaces found');
  const seen = new Map();
  for (const surface of surfaces) {
    const prior = seen.get(surface.id);
    if (prior) {
      throw new ConfigError(`navigation id ${surface.id} is declared in ${prior.file} and ${surface.file}`);
    }
    seen.set(surface.id, surface);
  }
  return surfaces;
}

export function catalogPolicy(catalog) {
  if (!isMap(catalog) || catalog.version !== 1) throw new ConfigError('trusted catalog version must be 1');
  if (catalog.inventory !== 'partial' && catalog.inventory !== 'complete') {
    throw new ConfigError('trusted catalog inventory must be partial or complete');
  }
  return { inventory: catalog.inventory };
}

export function validateCatalog(catalog, surfaces) {
  if (!isMap(catalog)) throw new ConfigError('catalog must be a mapping');
  if (catalog.version !== 1) throw new ConfigError('catalog version must be 1');
  if (catalog.inventory !== 'partial' && catalog.inventory !== 'complete') {
    throw new ConfigError('catalog inventory must be partial or complete');
  }
  const cases = catalog.use_cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new ConfigError('use_cases must be a non-empty list');
  }

  const byId = new Map(surfaces.map((surface) => [surface.id, surface]));
  const ids = new Set();
  const covered = new Set();
  for (const useCase of cases) {
    if (!isMap(useCase)) throw new ConfigError('each use case must be a mapping');
    const label = typeof useCase.id === 'string' ? useCase.id : '<unknown>';
    const missing = REQUIRED.filter((field) => !Object.hasOwn(useCase, field));
    if (missing.length) throw new ConfigError(`${label}: missing ${missing.join(', ')}`);
    if (typeof useCase.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(useCase.id)) {
      throw new ConfigError(`invalid use-case id ${JSON.stringify(useCase.id)}`);
    }
    if (ids.has(useCase.id)) throw new ConfigError(`duplicate use-case id ${useCase.id}`);
    ids.add(useCase.id);
    if (!TIERS.has(useCase.tier)) {
      throw new ConfigError(`${useCase.id}: tier must be primary, secondary, or tertiary`);
    }
    if (!EFFECTS.has(useCase.effect)) {
      throw new ConfigError(`${useCase.id}: effect must be read, create, or change`);
    }
    for (const field of TEXT_FIELDS) {
      if (typeof useCase[field] !== 'string' || !useCase[field].trim()) {
        throw new ConfigError(`${useCase.id}: ${field} must be text`);
      }
    }
    // `owner` is accepted as deprecated catalog metadata so existing catalogs
    // remain readable, but governance provenance is not definition validity.
    if (useCase.owner !== undefined && (typeof useCase.owner !== 'string' || !useCase.owner.trim())) {
      throw new ConfigError(`${useCase.id}: owner must be text when present`);
    }
    const starts = useCase.starts ?? [];
    if (!Array.isArray(starts)) {
      throw new ConfigError(`${useCase.id}: starts must be a list when present`);
    }
    for (const start of starts) {
      for (const id of checkStart(useCase.id, start, byId)) covered.add(id);
    }
    for (const field of ['requirements', 'gaps']) {
      const values = useCase[field] ?? [];
      if (!Array.isArray(values) || values.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new ConfigError(`${useCase.id}: ${field} must be a list of text`);
      }
    }
  }

  return {
    inventory: catalog.inventory,
    useCases: cases,
    surfaces,
    unmapped: surfaces.filter((surface) => !covered.has(surface.id)),
    unbound: cases.filter((useCase) => !Array.isArray(useCase.starts) || useCase.starts.length === 0),
  };
}

function checkStart(caseId, start, byId) {
  if (!isMap(start)) throw new ConfigError(`${caseId}: each start must be a mapping`);
  if (start.entry === 'assistant') {
    if (typeof start.prompt !== 'string' || !start.prompt.trim()) {
      throw new ConfigError(`${caseId}: an assistant start needs a prompt`);
    }
    if (!sameKeys(start, ['entry', 'prompt'])) {
      throw new ConfigError(`${caseId}: an assistant start has entry and prompt only`);
    }
    return [];
  }
  if (!sameKeys(start, ['nav_id', 'route'])) {
    throw new ConfigError(`${caseId}: a navigation start has nav_id and route only`);
  }
  const surface = byId.get(start.nav_id);
  if (!surface) throw new ConfigError(`${caseId}: start names unknown navigation id ${JSON.stringify(start.nav_id)}`);
  if (typeof start.route !== 'string' || !start.route.startsWith('/')) {
    throw new ConfigError(`${caseId}: start ${start.nav_id} needs an absolute route`);
  }
  const base = surface.route.replace(/\/+$/, '');
  if (start.route !== surface.route && !start.route.startsWith(`${base}/`)) {
    throw new ConfigError(`${caseId}: route ${start.route} is outside navigation surface ${surface.route}`);
  }
  return [start.nav_id];
}

function sameKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}

function isMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readInput(root, path, kind) {
  try {
    return readFileSync(resolveExistingRepositoryPath(root, path, `${kind} ${path}`), 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${kind} ${path} could not be read from the working tree`);
  }
}

export function renderCatalog(report) {
  const lines = [
    `Use-case catalog: ${report.inventory}, ${report.useCases.length} recorded`,
    `Navigation surfaces: ${report.surfaces.length}`,
    `Unmapped surfaces: ${report.unmapped.length}`,
    `Use cases without entry points: ${report.unbound.length}`,
  ];
  if (report.inventory === 'partial') {
    lines.push('Unmapped surfaces are expected until the inventory is finished.');
  }
  lines.push('', 'Recorded:');
  for (const useCase of report.useCases) {
    const binding = Array.isArray(useCase.starts) && useCase.starts.length ? '' : ', entry points unknown';
    lines.push(`  - ${useCase.id}: ${useCase.title} (${useCase.tier}, ${useCase.effect}${binding})`);
  }
  lines.push('', 'Unmapped:');
  for (const surface of report.unmapped) {
    lines.push(`  - ${surface.id}: ${surface.label} ${surface.route}${surface.hidden ? ' hidden' : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
