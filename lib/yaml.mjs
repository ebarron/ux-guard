// A strict parser for the YAML subset ux-guard catalogs use: two-space
// indentation, mappings, lists, quoted or plain scalars, and comments. Anything
// outside that subset is an error rather than a guess.

export class ConfigError extends Error {}

export function parseYamlSubset(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, offset) => {
    const lineNo = offset + 1;
    const code = stripComment(raw);
    if (!code.trim()) return;
    if (code.includes('\t')) throw new ConfigError(`line ${lineNo}: tabs are not allowed`);
    const indent = code.length - code.trimStart().length;
    if (indent % 2) throw new ConfigError(`line ${lineNo}: indent must be a multiple of 2`);
    lines.push({ level: indent / 2, text: code.trim(), lineNo });
  });
  if (lines.length === 0) throw new ConfigError('document is empty');
  const [value, index] = parseNode(lines, 0, 0);
  if (index !== lines.length) {
    throw new ConfigError(`line ${lines[index].lineNo}: unexpected content`);
  }
  return value;
}

function stripComment(raw) {
  let quote = '';
  let out = '';
  for (const char of raw) {
    if (quote) {
      out += char;
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
      out += char;
    } else if (char === '#') {
      break;
    } else {
      out += char;
    }
  }
  return out;
}

function parseNode(lines, index, level) {
  if (index >= lines.length || lines[index].level !== level) {
    throw new ConfigError(where(lines, index, `expected content at indent ${level * 2}`));
  }
  return isListItem(lines[index].text)
    ? parseList(lines, index, level)
    : parseMap(lines, index, level);
}

function isListItem(text) {
  return text === '-' || text.startsWith('- ');
}

function parseList(lines, index, level) {
  const items = [];
  while (index < lines.length && lines[index].level === level && isListItem(lines[index].text)) {
    const { text, lineNo } = lines[index];
    const rest = text.slice(1).trim();
    index += 1;
    if (!rest) {
      const [value, next] = parseNode(lines, index, level + 1);
      items.push(value);
      index = next;
      continue;
    }
    if (rest[0] === '"' || rest[0] === "'" || !hasField(rest)) {
      items.push(scalar(rest, lineNo));
      continue;
    }
    const item = {};
    let [key, value] = splitField(rest, lineNo);
    if (value === undefined) {
      [value, index] = parseNode(lines, index, level + 2);
    }
    item[key] = value;
    while (index < lines.length && lines[index].level === level + 1 && !isListItem(lines[index].text)) {
      const field = lines[index];
      let [nestedKey, nestedValue] = splitField(field.text, field.lineNo);
      index += 1;
      if (Object.hasOwn(item, nestedKey)) {
        throw new ConfigError(`line ${field.lineNo}: duplicate key ${nestedKey}`);
      }
      if (nestedValue === undefined) {
        [nestedValue, index] = parseNode(lines, index, level + 2);
      }
      item[nestedKey] = nestedValue;
    }
    items.push(item);
  }
  return [items, index];
}

function parseMap(lines, index, level) {
  const mapping = {};
  while (index < lines.length && lines[index].level === level && !isListItem(lines[index].text)) {
    const { text, lineNo } = lines[index];
    let [key, value] = splitField(text, lineNo);
    index += 1;
    if (Object.hasOwn(mapping, key)) throw new ConfigError(`line ${lineNo}: duplicate key ${key}`);
    if (value === undefined) {
      [value, index] = parseNode(lines, index, level + 1);
    }
    mapping[key] = value;
  }
  return [mapping, index];
}

function hasField(text) {
  return /^[^\s:"']+:(\s|$)/.test(text);
}

function splitField(text, lineNo) {
  const match = /^([^\s:"']+):(?:\s+(.*))?$/.exec(text);
  if (!match) throw new ConfigError(`line ${lineNo}: expected key: value`);
  const [, key, raw] = match;
  return [key, raw === undefined || raw === '' ? undefined : scalar(raw.trim(), lineNo)];
}

function scalar(text, lineNo) {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'")) {
    if (text.at(-1) !== text[0]) throw new ConfigError(`line ${lineNo}: unterminated quote`);
    return text.slice(1, -1);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^\d+$/.test(text)) return Number(text);
  if (text.includes(': ') || text.endsWith(':')) {
    throw new ConfigError(`line ${lineNo}: quote text that contains a colon`);
  }
  return text;
}

function where(lines, index, message) {
  const lineNo = index < lines.length ? lines[index].lineNo : 'end';
  return `line ${lineNo}: ${message}`;
}
