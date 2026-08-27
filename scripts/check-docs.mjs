import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

const publicDocs = [
  'README.md',
  'RestaurantIQ/README.md',
  'RestaurantIQ/docs/README.md',
  'RestaurantIQ/docs/known-limitations.md',
];

const docs = new Map(publicDocs.map((file) => [file, read(file)]));
const rootReadme = docs.get('README.md');

const fail = (message) => errors.push(message);

// Frequently changing totals do not belong in current-facing docs. CI is the
// source of truth for test execution, while this check reports the current file
// inventory without requiring the README to be edited after every new test.
const volatileClaims = [
  { label: 'test total', pattern: /\b\d+\s+(?:test suites?|tests?)\b/gi },
  { label: 'migration total', pattern: /\b\d+\s+migrations?\b/gi },
  { label: 'bug total', pattern: /\b\d+\s+(?:documented\s+)?bugs?\b/gi },
  {
    label: 'coverage percentage',
    pattern: /\b\d+(?:\.\d+)?%\s+(?:line|branch|function|statement)\s+coverage\b/gi,
  },
];

for (const [file, contents] of docs) {
  for (const { label, pattern } of volatileClaims) {
    pattern.lastIndex = 0;
    const match = pattern.exec(contents);
    if (match) fail(`${file}: remove volatile ${label} "${match[0]}"`);
  }
}

const backendPackage = JSON.parse(
  read('RestaurantIQ/restaurantiq-backend/package.json'),
);
const frontendPackage = JSON.parse(
  read('RestaurantIQ/restaurantiq-frontend/package.json'),
);

const engineMajor = (value, label) => {
  const match = /^>=\s*(\d+)$/.exec(value ?? '');
  if (!match) {
    fail(`${label}: expected an engines.node value like ">=22"`);
    return null;
  }
  return Number(match[1]);
};

const backendNode = engineMajor(
  backendPackage.engines?.node,
  'Backend package',
);
const frontendNode = engineMajor(
  frontendPackage.engines?.node,
  'Frontend package',
);
const readmeNodeMatch = /Prerequisites:\s*Node\.js\s+(\d+)\+/.exec(rootReadme);
const readmeNode = readmeNodeMatch ? Number(readmeNodeMatch[1]) : null;

if (readmeNode === null) fail('README.md: missing Node.js N+ prerequisite');
if (backendNode !== frontendNode) {
  fail(`Package Node versions disagree: backend=${backendNode}, frontend=${frontendNode}`);
}
if (readmeNode !== backendNode) {
  fail(`README Node version ${readmeNode} does not match package engines ${backendNode}`);
}

const ci = read('.github/workflows/ci.yml');
const ciNodeVersions = [...ci.matchAll(/node-version:\s*(\d+)/g)].map((m) =>
  Number(m[1]),
);
if (ciNodeVersions.length === 0) fail('CI: no node-version values found');
for (const version of ciNodeVersions) {
  if (version !== backendNode) {
    fail(`CI Node version ${version} does not match package engines ${backendNode}`);
  }
}

const migrationDir = path.join(
  root,
  'RestaurantIQ/restaurantiq-backend/migrations',
);
const migrationFiles = fs
  .readdirSync(migrationDir)
  .filter((file) => /^\d{3}_.+\.sql$/.test(file))
  .sort();
const migrationNumbers = migrationFiles.map((file) => Number(file.slice(0, 3)));
const distinctMigrationNumbers = [...new Set(migrationNumbers)];

// This repository's tracked history begins at 002 and contains two legacy 003
// files. Preserve that history while still detecting a newly introduced gap.
for (let index = 1; index < distinctMigrationNumbers.length; index += 1) {
  const expected = distinctMigrationNumbers[index - 1] + 1;
  if (distinctMigrationNumbers[index] !== expected) {
    fail(
      `Migration sequence has a gap before ${String(distinctMigrationNumbers[index]).padStart(3, '0')}: expected ${String(expected).padStart(3, '0')}`,
    );
    break;
  }
}

const walk = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });

const backendTestFiles = walk(
  path.join(root, 'RestaurantIQ/restaurantiq-backend/src'),
).filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));

let checkedLinks = 0;
for (const [file, contents] of docs) {
  for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    checkedLinks += 1;
    const resolved = path.resolve(root, path.dirname(file), target);
    if (!fs.existsSync(resolved)) fail(`${file}: missing local link target ${target}`);
  }
}

const cloneTarget = /git clone\s+\S+\s+(\S+)/.exec(rootReadme)?.[1];
if (!cloneTarget) fail('README.md: clone command must use an explicit local directory');

let checkedSetupPaths = 0;
for (const match of rootReadme.matchAll(/^cd\s+([^\s#]+)$/gm)) {
  let documentedPath = match[1];
  if (cloneTarget && documentedPath.startsWith(`${cloneTarget}/`)) {
    documentedPath = documentedPath.slice(cloneTarget.length + 1);
  }
  const resolved = path.resolve(root, documentedPath);
  checkedSetupPaths += 1;
  if (!fs.existsSync(resolved)) {
    fail(`README.md: setup path does not exist: ${match[1]}`);
  }
}

if (errors.length > 0) {
  console.error('Documentation accuracy check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Documentation accuracy check passed.');
console.log(`Node major: ${backendNode}`);
console.log(
  `Migrations: ${migrationFiles.length} numbered files (${migrationFiles[0]} through ${migrationFiles.at(-1)})`,
);
console.log(
  `Backend test inventory: ${backendTestFiles.length} test files; exact Jest totals remain in CI output`,
);
console.log(`Local Markdown links checked: ${checkedLinks}`);
console.log(`README setup paths checked: ${checkedSetupPaths}`);
