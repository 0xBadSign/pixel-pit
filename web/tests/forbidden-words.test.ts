// @vitest-environment node
// SPEC §7: forbidden words in the product (official, Aura, badge, whitelist, approved game, earn, reward,
// airdrop, MVP). Case-sensitive whole-word match over the BUILT dist. "Unofficial"/"unofficial" are allowed
// (and do not match \bofficial\b). Also scans the static index.html and src/copy.ts as a fast pre-check.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(web, 'dist');

export const FORBIDDEN = ['official', 'Aura', 'badge', 'whitelist', 'approved game', 'earn', 'reward', 'airdrop', 'MVP'] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|html|css|json|svg|txt)$/.test(name)) out.push(p);
  }
  return out;
}

export function findForbidden(text: string): { word: string; context: string }[] {
  const hits: { word: string; context: string }[] = [];
  for (const w of FORBIDDEN) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${w.replace(/ /g, '\\s+')}(?![A-Za-z0-9_])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      hits.push({ word: w, context: text.slice(Math.max(0, m.index - 40), m.index + w.length + 40).replace(/\s+/g, ' ') });
    }
  }
  return hits;
}

describe('forbidden words (SPEC §7)', () => {
  beforeAll(() => {
    const vite = join(web, 'node_modules', 'vite', 'bin', 'vite.js');
    execFileSync(process.execPath, [vite, 'build', '--logLevel', 'error'], { cwd: web, stdio: 'pipe', env: { ...process.env, VITE_ENV: '' } });
  }, 180_000);

  it('the matcher itself: Unofficial is allowed, official is not', () => {
    expect(findForbidden('Unofficial fan project. unofficial · Sepolia')).toEqual([]);
    expect(findForbidden('an official thing').map((h) => h.word)).toEqual(['official']);
    expect(findForbidden('approved  game')).toHaveLength(1);
    expect(findForbidden('blockReward rewards earned')).toEqual([]); // not whole-word / different case
  });

  it('static index.html and copy.ts contain none', () => {
    for (const f of ['index.html', join('src', 'copy.ts')]) {
      const hits = findForbidden(readFileSync(join(web, f), 'utf8'));
      expect(hits, `${f}: ${JSON.stringify(hits)}`).toEqual([]);
    }
  });

  it('built dist contains none', () => {
    expect(existsSync(dist)).toBe(true);
    const files = walk(dist);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const hits = findForbidden(readFileSync(f, 'utf8'));
      expect(hits, `${f}: ${JSON.stringify(hits.slice(0, 5))}`).toEqual([]);
    }
  });

  it('built dist keeps the static squeekchain-project meta and the §7.1 footer', () => {
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(html).toMatch(/<meta name="squeekchain-project" content="[^"]+"/);
    expect(html).toContain('Unofficial fan project. Not affiliated with or endorsed by Squeekchain. Runs on the Sepolia testnet; nothing here has value.');
  });

  it('bundle stays under the 200 KB budget (raw, all assets)', () => {
    const total = walk(dist).reduce((n, f) => n + statSync(f).size, 0);
    expect(total, `dist total ${total} bytes`).toBeLessThan(200 * 1024);
  });
});
