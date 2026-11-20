import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConfigError } from './yaml.mjs';

export const CONFIG_FILE = '.uxguard.json';

const require = createRequire(import.meta.url);

// Resolve an untrusted ref to a commit before constructing object names. Besides
// producing consistent reads, this prevents ref text from being interpreted as
// an option or as part of a different rev/path expression.
export function resolveTrustedRevision(root, ref) {
  if (!ref) return null;
  try {
    const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('unexpected object id');
    return { ref, commit };
  } catch {
    throw new ConfigError(`trusted revision ${ref} is not a commit`);
  }
}

// readTrusted returns a file from the working tree, or from a previously
// resolved trusted commit. A missing trusted file is an error, never an empty
// policy.
export function readTrusted(root, path, trust) {
  if (!trust) {
    const full = resolveExistingRepositoryPath(root, path, path);
    if (!existsSync(full)) throw new ConfigError(`${path} does not exist`);
    return readFileSync(full, 'utf8');
  }
  try {
    return execFileSync('git', ['show', `${trust.commit}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new ConfigError(`${path} is not present at trusted revision ${trust.ref}`);
  }
}

export function trustedFileExists(root, path, trust) {
  resolveRepositoryPath(root, path, path);
  if (!trust) return existsSync(join(root, path));
  try {
    execFileSync('git', ['cat-file', '-e', `${trust.commit}:${path}`], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(root, trust) {
  let config;
  try {
    config = JSON.parse(readTrusted(root, CONFIG_FILE, trust));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${CONFIG_FILE} is not valid JSON`);
  }
  return validateConfig(config);
}

export function validateConfig(config) {
  const fail = (message) => {
    throw new ConfigError(`${CONFIG_FILE}: ${message}`);
  };
  const strings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item);
  if (config?.version !== 2) fail('version must be 2');
  if (Object.hasOwn(config, 'typescript')) {
    fail('typescript paths are not accepted; ux-guard uses its exact package dependency');
  }
  const { catalog, journeys, visuals, patterns } = config;
  if (typeof catalog?.path !== 'string' || !strings(catalog.navigation)) {
    fail('catalog needs path and navigation files');
  }
  assertPolicyPath(catalog.path, 'catalog.path', fail);
  for (const path of catalog.navigation) assertPolicyPath(path, 'catalog.navigation entries', fail);
  if (journeys !== undefined) {
    if (
      journeys === null ||
      typeof journeys !== 'object' ||
      Array.isArray(journeys) ||
      typeof journeys.policy !== 'string' ||
      typeof journeys.report !== 'string'
    ) {
      fail('journeys needs policy and report paths');
    }
    assertPolicyPath(journeys.policy, 'journeys.policy', fail);
    assertPolicyPath(journeys.report, 'journeys.report', fail);
    for (const field of ['targets', 'baseline']) {
      if (journeys[field] !== undefined) {
        if (typeof journeys[field] !== 'string' || !journeys[field]) {
          fail(`journeys.${field} must be a repository-relative path`);
        }
        assertPolicyPath(journeys[field], `journeys.${field}`, fail);
      }
    }
    const journeyPaths = [
      journeys.policy,
      journeys.report,
      journeys.targets,
      journeys.baseline,
    ].filter(Boolean);
    if (journeyPaths.includes(CONFIG_FILE)) {
      fail(`journey paths cannot be ${CONFIG_FILE}`);
    }
    if (new Set(journeyPaths).size !== journeyPaths.length) {
      fail('journey policy, report, targets, and baseline paths must be different');
    }
  }
  if (visuals !== undefined) {
    if (
      visuals === null ||
      typeof visuals !== 'object' ||
      Array.isArray(visuals) ||
      !['profiles', 'checkpoints', 'candidate', 'baseline'].every(
        (field) => typeof visuals?.[field] === 'string' && visuals[field],
      )
    ) {
      fail('visuals needs profiles, checkpoints, candidate, and baseline paths');
    }
    for (const field of ['profiles', 'checkpoints', 'candidate', 'baseline']) {
      assertPolicyPath(visuals[field], `visuals.${field}`, fail);
    }
    if (new Set(Object.values(visuals)).size !== 4) {
      fail('visual profile, checkpoint, candidate, and baseline paths must be different');
    }
    if (Object.values(visuals).includes(CONFIG_FILE)) {
      fail(`visual paths cannot be ${CONFIG_FILE}`);
    }
  }
  if (!strings(patterns?.roots) || !strings(patterns.extensions) || !Array.isArray(patterns.exclude)) {
    fail('patterns needs roots, extensions, and exclude');
  }
  for (const path of patterns.roots) assertPolicyPath(path, 'patterns.roots entries', fail, true);
  if (!patterns.extensions.every((value) => /^\.[a-z0-9]+$/i.test(value))) {
    fail('patterns.extensions entries must be file extensions');
  }
  if (!patterns.exclude.every((value) => typeof value === 'string' && value)) {
    fail('patterns.exclude entries must be non-empty strings');
  }
  if (typeof patterns.baseline !== 'string' || !patterns.baseline) fail('patterns needs a baseline path');
  assertPolicyPath(patterns.baseline, 'patterns.baseline', fail);
  if (patterns.baseline === CONFIG_FILE) fail(`patterns.baseline cannot be ${CONFIG_FILE}`);
  const { components, icons } = patterns;
  if (typeof components?.module !== 'string' || !strings(components.names) || !strings(components.props)) {
    fail('patterns.components needs module, names, and props');
  }
  if (!strings(icons?.modules) || !Array.isArray(icons.allowed)) fail('patterns.icons needs modules and allowed');
  return config;
}

export function resolveRepositoryPath(root, path, label, allowDot = false) {
  const fail = (message) => {
    throw new ConfigError(message);
  };
  assertPolicyPath(path, label, fail, allowDot);
  return resolve(root, path);
}

export function assertRepositoryRelativePath(path, label) {
  assertPolicyPath(path, label, (message) => {
    throw new ConfigError(message);
  });
  return path;
}

export function resolveExistingRepositoryPath(root, path, label, allowDot = false) {
  const full = resolveRepositoryPath(root, path, label, allowDot);
  let realRoot;
  let realPath;
  try {
    realRoot = realpathSync(root);
    realPath = realpathSync(full);
  } catch {
    throw new ConfigError(`${label} does not exist in the working tree`);
  }
  const fromRoot = relative(realRoot, realPath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ConfigError(`${label} resolves outside the repository`);
  }
  return full;
}

// ensureLocalDirectory walks every parent below root so a write cannot follow
// a symbolic link out of the repository.
export function ensureLocalDirectory(root, directory, label, create) {
  const path = relative(root, directory);
  if (!path) return;
  let current = root;
  for (const part of path.split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (!create) throw new ConfigError(`${label} parent does not exist`);
      try {
        mkdirSync(current);
      } catch {
        throw new ConfigError(`${label} parent could not be created safely`);
      }
    }
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      throw new ConfigError(`${label} parent could not be inspected`);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ConfigError(`${label} parent must be a repository directory, not a symbolic link`);
    }
  }
}

function assertPolicyPath(value, label, fail, allowDot = false) {
  if (typeof value !== 'string' || !value || value.includes('\0')) fail(`${label} must be a repository-relative path`);
  if (isAbsolute(value) || /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')) {
    fail(`${label} must be a repository-relative path`);
  }
  if (value.includes('\\')) fail(`${label} must use forward slashes`);
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '..') || (!allowDot && parts.every((part) => part === '.'))) {
    fail(`${label} must stay within the repository`);
  }
}

export function loadTypeScript() {
  try {
    const ts = require('typescript');
    if (typeof ts.createSourceFile !== 'function') throw new Error('invalid compiler API');
    return ts;
  } catch {
    throw new ConfigError('ux-guard exact TypeScript dependency is not installed');
  }
}
