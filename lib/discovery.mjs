import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveExistingRepositoryPath } from './config.mjs';
import { baselineFromScan, DEBT_RULES, scanFiles, scanSource } from './patterns.mjs';
import { ConfigError } from './yaml.mjs';

const require = createRequire(import.meta.url);
const SOURCE_EXTENSIONS = new Set(['.jsx', '.tsx']);
const TEST_SUFFIXES = ['.test.jsx', '.test.tsx', '.spec.jsx', '.spec.tsx'];
const SKIP_DIRECTORIES = new Set(['build', 'coverage', 'dist', 'node_modules']);
const NATIVE_CONTROLS = new Set(['button', 'input', 'select', 'textarea']);
const PRESENTATION_PROPS = new Set(['size', 'variant']);
const CONTROL_NAME =
  /(?:^|\.)(?:.*Button|.*Input|.*Icon|Autocomplete|Checkbox|Combobox|Radio|SegmentedControl|Select|Slider|Switch|Textarea)$/;
const ICON_PACKAGE =
  /(?:^|[-/])icons?(?:$|[-/])|fontawesome|heroicons|lucide|phosphor|@mui\/icons-material/;

export function discoverProject(root, explicitTypeScript) {
  const manifests = findNamedFiles(root, (name) => name === 'package.json').map((path) => readManifest(root, path));
  const dependencies = dependencyIndex(manifests);
  const runtime = loadDiscoveryTypeScript(root, explicitTypeScript, manifests);
  const project = readTypeScriptProjects(runtime.ts, root);
  const moduleMap = new Map();
  const nativeControls = {};
  const styles = { classNameAttributes: 0, inlineStyleAttributes: 0, stylesheetImports: {} };
  const texts = new Map();

  for (const file of project.files) {
    const text = readFileSync(resolveExistingRepositoryPath(root, file, `discovery source ${file}`), 'utf8');
    texts.set(file, text);
    inspectSource(runtime.ts, file, text, dependencies, moduleMap, nativeControls, styles);
  }

  const iconModules = [...moduleMap.keys()].filter(isIconPackage).sort();
  const discoveryConfig = {
    patterns: {
      components: { module: '', names: [], props: [] },
      icons: { modules: iconModules, allowed: [] },
    },
  };
  const debt = Object.fromEntries(DEBT_RULES.map((rule) => [rule, {}]));
  for (const [file, text] of texts) {
    const result = scanSource(runtime.ts, file, text, discoveryConfig);
    for (const rule of DEBT_RULES) {
      if (result.debt[rule] > 0) debt[rule][file] = result.debt[rule];
    }
  }

  const libraries = renderLibraries(moduleMap, dependencies);
  const candidate = buildCandidate(runtime, project, libraries, root);
  const baselineConfig = { patterns: candidate.configFragment.patterns };
  const baseline = baselineFromScan(scanFiles(runtime.ts, root, baselineConfig, project.files));

  return {
    version: 1,
    kind: 'ux-guard-discovery',
    approval: {
      status: 'review-required',
      observedUsageIsApprovedPolicy: false,
      filesWritten: false,
    },
    inputs: {
      typescript: runtime.configPath,
      typescriptVersion: runtime.ts.version,
      typescriptSource: runtime.source,
      manifests: manifests.map(({ path, name }) => ({ path, name })),
      tsconfigs: project.tsconfigs,
      diagnostics: project.diagnostics,
    },
    observed: {
      files: project.files.length,
      sourceRoots: project.sourceRoots,
      componentLibraries: libraries.filter((library) => !library.iconLibrary),
      iconLibraries: libraries.filter((library) => library.iconLibrary),
      nativeControls: sortRecord(nativeControls),
      styling: {
        classNameAttributes: styles.classNameAttributes,
        inlineStyleAttributes: styles.inlineStyleAttributes,
        stylesheetImports: sortRecord(styles.stylesheetImports),
      },
      debt,
    },
    candidate: {
      status: 'review-required',
      configIsComplete: false,
      missingDecisions: [
        'catalog path and navigation sources',
        'approved component modules, controls, and props',
        'approved icon libraries',
        'pattern baseline destination',
        'source-root and exclusion review',
      ],
      configFragment: candidate.configFragment,
      baseline: {
        status: 'candidate-observation-only',
        approved: false,
        value: baseline,
      },
      notes: candidate.notes,
    },
  };
}

export function candidateFromDiscovery(report) {
  return {
    version: 1,
    kind: 'ux-guard-policy-candidate',
    approval: {
      status: 'unapproved',
      reviewer: '',
      reviewedAt: '',
      patternPolicyReviewed: false,
    },
    config: report.candidate.configFragment,
    observedBaseline: {
      status: 'unapproved-observation-only',
      approved: false,
      value: report.candidate.baseline.value,
    },
    review: {
      missingDecisions: report.candidate.missingDecisions,
      notes: report.candidate.notes,
    },
  };
}

export function renderDiscovery(report) {
  const debtTotal = (rule) => Object.values(report.observed.debt[rule]).reduce((sum, count) => sum + count, 0);
  const lines = [
    'UX project discovery (review required)',
    report.approval.filesWritten
      ? 'Observed usage is inventory, not approved policy. Only an unapproved candidate artifact was written.'
      : 'Observed usage is inventory, not approved policy. No files were written.',
    `TypeScript: ${report.inputs.typescript} (${report.inputs.typescriptSource})`,
    `Source: ${report.observed.files} files in ${report.observed.sourceRoots.length} candidate roots`,
  ];
  for (const sourceRoot of report.observed.sourceRoots) {
    lines.push(`  ${sourceRoot.path}: ${sourceRoot.files} files (${sourceRoot.productionFiles} non-test JSX)`);
  }
  lines.push('Observed component libraries:');
  for (const library of report.observed.componentLibraries) {
    lines.push(`  ${library.module}: ${library.jsxUses} JSX uses, ${library.components.length} components`);
  }
  if (report.observed.componentLibraries.length === 0) lines.push('  (none)');
  lines.push('Observed icon libraries (not automatically allowed):');
  for (const library of report.observed.iconLibraries) {
    lines.push(`  ${library.module}: ${library.jsxUses} JSX uses in ${library.files.length} files`);
  }
  if (report.observed.iconLibraries.length === 0) lines.push('  (none)');
  const native = Object.entries(report.observed.nativeControls).map(([name, count]) => `${name} ${count}`).join(', ');
  lines.push(`Native controls: ${native || 'none'}`);
  lines.push(
    `Styling: ${report.observed.styling.inlineStyleAttributes} inline style attributes, ` +
      `${report.observed.styling.classNameAttributes} className attributes, ` +
      `${Object.values(report.observed.styling.stylesheetImports).reduce((sum, count) => sum + count, 0)} stylesheet imports`,
  );
  lines.push(`Debt observations: ${DEBT_RULES.map((rule) => `${rule} ${debtTotal(rule)}`).join(', ')}`);
  const components = report.candidate.configFragment.patterns.components;
  lines.push('Candidate pattern profile (requires review):');
  lines.push(`  roots: ${report.candidate.configFragment.patterns.roots.join(', ') || '(none)'}`);
  lines.push(`  component module: ${components.module || '(none)'}`);
  lines.push(`  controls: ${components.names.join(', ') || '(none)'}`);
  lines.push(`  props: ${components.props.join(', ') || '(none)'}`);
  lines.push('  allowed icon libraries: none selected');
  lines.push(
    `Candidate baseline: ${Object.keys(report.candidate.baseline.value.controlValues).length} control keys; ` +
      (report.approval.filesWritten ? 'observation only, included in the unapproved candidate' : 'observation only, not written'),
  );
  lines.push('Use --format json for aliases, prop values, file-level debt, and the complete candidate artifacts.');
  return `${lines.join('\n')}\n`;
}

function findNamedFiles(root, accepts) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(join(directory, entry.name));
      } else if (entry.isFile() && accepts(entry.name)) {
        files.push(join(directory, entry.name));
      }
    }
  };
  walk(root);
  return files;
}

function readManifest(root, path) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError(`${toRelative(root, path)} is not valid JSON`);
  }
  return {
    path: toRelative(root, path),
    directory: dirname(path),
    name: typeof manifest.name === 'string' ? manifest.name : null,
    dependencies: {
      dependencies: manifest.dependencies ?? {},
      devDependencies: manifest.devDependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
    },
  };
}

function dependencyIndex(manifests) {
  const index = new Map();
  for (const manifest of manifests) {
    for (const [scope, entries] of Object.entries(manifest.dependencies)) {
      for (const [name, version] of Object.entries(entries)) {
        const declarations = index.get(name) ?? [];
        declarations.push({ manifest: manifest.path, scope, version });
        index.set(name, declarations);
      }
    }
  }
  return index;
}

function loadDiscoveryTypeScript(root, explicit, manifests) {
  const candidates = [];
  if (explicit) candidates.push({ path: isAbsolute(explicit) ? explicit : resolve(root, explicit), source: '--typescript' });
  if (!explicit) {
    candidates.push({
      path: require.resolve('typescript'),
      source: 'ux-guard exact dependency',
    });
  }
  for (const manifest of manifests) {
    if (!Object.values(manifest.dependencies).some((entries) => typeof entries.typescript === 'string')) continue;
    candidates.push({ path: join(manifest.directory, 'node_modules/typescript'), source: manifest.path });
    try {
      const resolved = createRequire(join(manifest.directory, 'package.json')).resolve('typescript');
      candidates.push({ path: resolved, source: manifest.path });
    } catch {
      // The declared peer or dependency may not be installed in this package.
    }
  }
  const tried = new Set();
  for (const candidate of candidates) {
    if (tried.has(candidate.path)) continue;
    tried.add(candidate.path);
    try {
      const ts = require(candidate.path);
      if (typeof ts.createSourceFile === 'function' && typeof ts.parseJsonConfigFileContent === 'function') {
        return { ts, configPath: toConfigPath(root, candidate.path), source: candidate.source };
      }
    } catch {
      // Try the next deterministic candidate.
    }
  }
  throw new ConfigError('discover could not load TypeScript; install it in a package or pass --typescript <path>');
}

function readTypeScriptProjects(ts, root) {
  const configPaths = findNamedFiles(root, (name) => /^tsconfig(?:\.[^.]+)?\.json$/.test(name));
  if (configPaths.length === 0) throw new ConfigError('discover found no tsconfig files');
  const diagnostics = [];
  const files = new Set();
  const roots = new Map();
  const tsconfigs = [];
  for (const configPath of configPaths) {
    const configName = toRelative(root, configPath);
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error) {
      diagnostics.push({ tsconfig: configName, message: diagnosticText(ts, loaded.error) });
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configPath), undefined, configPath);
    for (const error of parsed.errors) diagnostics.push({ tsconfig: configName, message: diagnosticText(ts, error) });
    const jsxFiles = parsed.fileNames.filter((file) => SOURCE_EXTENSIONS.has(extname(file).toLowerCase()) && isInside(root, file));
    for (const file of jsxFiles) {
      const relativeFile = toRelative(root, file);
      if (!isTestFile(relativeFile)) files.add(relativeFile);
    }
    tsconfigs.push(configName);
    for (const includeRoot of configIncludeRoots(configPath, loaded.config, jsxFiles)) {
      if (!isInside(root, includeRoot.path)) continue;
      const path = toRelative(root, includeRoot.path);
      const current = roots.get(path) ?? { path, files: new Set(), productionFiles: new Set(), tsconfigs: new Set() };
      for (const file of includeRoot.files) {
        current.files.add(toRelative(root, file));
        if (!isTestFile(file)) current.productionFiles.add(toRelative(root, file));
      }
      current.tsconfigs.add(configName);
      roots.set(path, current);
    }
  }
  if (files.size === 0) throw new ConfigError('discover found no non-test JSX or TSX source files');
  return {
    files: [...files].sort(),
    sourceRoots: [...roots.values()]
      .filter((entry) => entry.productionFiles.size > 0)
      .map((entry) => ({
        path: entry.path,
        files: entry.files.size,
        productionFiles: entry.productionFiles.size,
        tsconfigs: [...entry.tsconfigs].sort(),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    tsconfigs: tsconfigs.sort(),
    diagnostics,
  };
}

function configIncludeRoots(configPath, rawConfig, files) {
  const configDirectory = dirname(configPath);
  const includes = Array.isArray(rawConfig.include) && rawConfig.include.length ? rawConfig.include : ['.'];
  const roots = [];
  for (const include of includes) {
    if (typeof include !== 'string') continue;
    const wildcard = include.search(/[*?]/);
    let prefix = wildcard === -1 ? include : include.slice(0, wildcard);
    prefix = prefix.replace(/[\\/]+$/, '') || '.';
    let path = resolve(configDirectory, prefix);
    if (existsSync(path) && !statSync(path).isDirectory()) path = dirname(path);
    const matching = files.filter((file) => isInside(path, file));
    if (matching.length) roots.push({ path, files: matching });
  }
  return roots;
}

function inspectSource(ts, file, text, dependencies, moduleMap, nativeControls, styles) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, sourceKind(ts, file));
  const bindings = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const importSource = statement.moduleSpecifier.text;
    if (/\.(?:css|less|sass|scss|styl)$/.test(importSource)) {
      styles.stylesheetImports[importSource] = (styles.stylesheetImports[importSource] ?? 0) + 1;
    }
    const module = packageName(importSource);
    if (!module || !dependencies.has(module)) continue;
    const record = moduleRecord(moduleMap, module);
    record.importSources.add(importSource);
    record.files.add(file);
    record.importDeclarations += 1;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.set(clause.name.text, { module, importSource, imported: 'default', kind: 'default' });
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.set(element.name.text, {
          module,
          importSource,
          imported: (element.propertyName ?? element.name).text,
          kind: 'named',
        });
      }
    } else if (named && ts.isNamespaceImport(named)) {
      bindings.set(named.name.text, { module, importSource, imported: '*', kind: 'namespace' });
    }
  }

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (NATIVE_CONTROLS.has(tag)) nativeControls[tag] = (nativeControls[tag] ?? 0) + 1;
      const [local, ...member] = tag.split('.');
      const binding = bindings.get(local);
      if (binding) {
        const name =
          binding.kind === 'namespace'
            ? member.join('.')
            : [binding.imported === 'default' ? local : binding.imported, ...member].filter(Boolean).join('.');
        if (name) {
          const record = moduleRecord(moduleMap, binding.module);
          const component = record.components.get(name) ?? {
            name,
            importKind: binding.kind,
            jsxUses: 0,
            aliases: new Map(),
            importSources: new Set(),
            props: new Map(),
          };
          component.jsxUses += 1;
          component.aliases.set(tag, (component.aliases.get(tag) ?? 0) + 1);
          component.importSources.add(binding.importSource);
          for (const attribute of node.attributes.properties) {
            if (!ts.isJsxAttribute(attribute)) continue;
            const prop = attribute.name.getText(source);
            const propRecord = component.props.get(prop) ?? { occurrences: 0, values: new Map() };
            propRecord.occurrences += 1;
            for (const value of attributeValues(ts, attribute)) {
              propRecord.values.set(value, (propRecord.values.get(value) ?? 0) + 1);
            }
            component.props.set(prop, propRecord);
            if (prop === 'className') styles.classNameAttributes += 1;
            if (prop === 'style') styles.inlineStyleAttributes += 1;
          }
          record.components.set(name, component);
        }
      } else {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const prop = attribute.name.getText(source);
          if (prop === 'className') styles.classNameAttributes += 1;
          if (prop === 'style') styles.inlineStyleAttributes += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function moduleRecord(moduleMap, module) {
  const record = moduleMap.get(module) ?? {
    module,
    importSources: new Set(),
    files: new Set(),
    importDeclarations: 0,
    components: new Map(),
  };
  moduleMap.set(module, record);
  return record;
}

function renderLibraries(moduleMap, dependencies) {
  return [...moduleMap.values()]
    .map((record) => {
      const components = [...record.components.values()]
        .map((component) => ({
          name: component.name,
          importKind: component.importKind,
          jsxUses: component.jsxUses,
          aliases: [...component.aliases].map(([local, count]) => ({ local, count })).sort((a, b) => a.local.localeCompare(b.local)),
          importSources: [...component.importSources].sort(),
          props: [...component.props]
            .map(([name, prop]) => ({
              name,
              occurrences: prop.occurrences,
              values: [...prop.values].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        module: record.module,
        iconLibrary: isIconPackage(record.module),
        declarations: dependencies.get(record.module).slice().sort((a, b) => a.manifest.localeCompare(b.manifest)),
        importSources: [...record.importSources].sort(),
        importDeclarations: record.importDeclarations,
        files: [...record.files].sort(),
        jsxUses: components.reduce((sum, component) => sum + component.jsxUses, 0),
        components,
      };
    })
    .filter((library) => library.jsxUses > 0 || library.iconLibrary)
    .sort((a, b) => a.module.localeCompare(b.module));
}

function buildCandidate(runtime, project, libraries, root) {
  const ranked = libraries
    .filter((library) => !library.iconLibrary)
    .map((library) => ({
      library,
      controls: library.components.filter(
        (component) =>
          component.importKind === 'named' &&
          component.importSources.includes(library.module) &&
          !component.name.includes('.') &&
          CONTROL_NAME.test(component.name),
      ),
    }))
    .map((entry) => ({ ...entry, score: entry.controls.reduce((sum, component) => sum + component.jsxUses, 0) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.library.module.localeCompare(b.library.module));
  const selected = ranked[0];
  const names = selected?.controls.map((component) => component.name).sort() ?? [];
  const props = [...PRESENTATION_PROPS]
    .filter((prop) => selected?.controls.some((component) => component.props.some((entry) => entry.name === prop)))
    .sort();
  const roots = minimalRoots(project.sourceRoots.map((entry) => entry.path));
  const extensions = [...new Set(project.files.map((file) => extname(file).toLowerCase()))].sort();
  const icons = libraries.filter((library) => library.iconLibrary).map((library) => library.module).sort();
  const notes = [
    'This fragment is evidence for review, not an enforceable .uxguard.json.',
    'No icon library is allowed automatically; choose approved libraries and regenerate the baseline.',
    'The candidate baseline snapshots observations under this unapproved fragment and must not be installed as policy without review.',
  ];
  if (!selected) notes.push('No imported control component module could be selected deterministically.');
  if (props.length === 0) notes.push('No size or variant values were observed on candidate controls.');
  if (icons.length === 0) notes.push('No icon package was identified from declared dependency names.');
  return {
    configFragment: {
      version: 2,
      patterns: {
        roots,
        extensions,
        exclude: TEST_SUFFIXES,
        baseline: '',
        components: {
          module: selected?.library.module ?? '',
          names,
          props,
        },
        icons: {
          modules: icons,
          allowed: [],
        },
      },
    },
    notes,
  };
}

function attributeValues(ts, attribute) {
  const init = attribute.initializer;
  if (!init) return ['true'];
  if (ts.isStringLiteral(init)) return [init.text];
  if (!ts.isJsxExpression(init) || !init.expression) return ['dynamic'];
  return expressionValues(ts, init.expression);
}

function expressionValues(ts, expression) {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return [expression.text];
  if (ts.isConditionalExpression(expression)) {
    return [...expressionValues(ts, expression.whenTrue), ...expressionValues(ts, expression.whenFalse)];
  }
  return ['dynamic'];
}

function packageName(importSource) {
  if (importSource.startsWith('.') || importSource.startsWith('/')) return null;
  const parts = importSource.split('/');
  return importSource.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isIconPackage(name) {
  return ICON_PACKAGE.test(name);
}

function isTestFile(path) {
  return TEST_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function sourceKind(ts, file) {
  return file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
}

function diagnosticText(ts, diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function minimalRoots(paths) {
  const selected = [];
  for (const path of paths.sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    if (!selected.some((parent) => path === parent || path.startsWith(`${parent}/`))) selected.push(path);
  }
  return selected.sort();
}

function toConfigPath(root, path) {
  return isInside(root, path) ? toRelative(root, path) : path;
}

function toRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}
