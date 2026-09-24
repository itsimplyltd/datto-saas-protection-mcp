import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from '../src/datto-api.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const SDK = /^@wyre-(ai|technology)\//;
const SDK_IMPORT = /from\s+['"]@wyre-(ai|technology)\//;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|mts|js|mjs)$/.test(entry) ? [full] : [];
  });
}

describe('the WYRE SDK stays gone', () => {
  // It was only ever kept for six error classes, and it cost a private-
  // registry token in every install, CI run and image build.
  it('is not a dependency of any kind', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const all = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    };
    expect(Object.keys(all).filter((name) => SDK.test(name))).toEqual([]);
  });

  it('is imported by nothing', () => {
    const offenders = ['src', 'test', 'ui', 'scripts']
      .flatMap((d) => sourceFiles(path.join(root, d)))
      .filter((f) => SDK_IMPORT.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('needs no private registry to install', () => {
    expect(existsSync(path.join(root, '.npmrc'))).toBe(false);
    expect(readFileSync(path.join(root, 'package-lock.json'), 'utf8')).not.toContain('npm.pkg.github.com');
  });
});

describe('the error taxonomy is unchanged', () => {
  it.each([
    [new api.DattoSaasProtectionAuthenticationError('x'), 'DattoSaasProtectionAuthenticationError', 401],
    [new api.DattoSaasProtectionForbiddenError('x'), 'DattoSaasProtectionForbiddenError', 403],
    [new api.DattoSaasProtectionNotFoundError('x'), 'DattoSaasProtectionNotFoundError', 404],
    [new api.DattoSaasProtectionRateLimitError('x'), 'DattoSaasProtectionRateLimitError', 429],
    [new api.DattoSaasProtectionServerError('x', 504), 'DattoSaasProtectionServerError', 504],
  ])('%s', (error, name, statusCode) => {
    expect(error).toBeInstanceOf(api.DattoSaasProtectionError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.statusCode).toBe(statusCode);
  });

  it('rate-limit errors carry the retry delay', () => {
    expect(new api.DattoSaasProtectionRateLimitError('x', 7000).retryAfter).toBe(7000);
  });
});
