import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

import { APP_VERSION } from '../server/version.ts';
import { checkForUpdate, isNewer, resetUpdateCache } from '../server/versionCheck.ts';

let calls: { url: string; init: RequestInit }[];
const release = (over: object = {}) => ({ tag_name: 'v0.3.0', html_url: 'https://github.com/o/r/releases/tag/v0.3.0', draft: false, prerelease: false, ...over });

function stub(res: () => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return res();
    }),
  );
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const check = (over: object = {}) => checkForUpdate({ current: '0.2.0', repo: 'o/r', enabled: true, ...over });

beforeEach(() => {
  calls = [];
  resetUpdateCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('version check (T19)', () => {
  it('reports a newer release with its link', async () => {
    stub(ok(release()));
    expect(await check()).toEqual({ version: '0.3.0', url: 'https://github.com/o/r/releases/tag/v0.3.0' });
  });

  it('says nothing when the release is the same, older, a draft or a pre-release', async () => {
    stub(ok(release({ tag_name: 'v0.2.0' })));
    expect(await check()).toBeNull();
    resetUpdateCache();
    stub(ok(release({ tag_name: 'v0.1.0' })));
    expect(await check()).toBeNull();
    resetUpdateCache();
    stub(ok(release({ prerelease: true })));
    expect(await check()).toBeNull();
    resetUpdateCache();
    stub(ok(release({ draft: true })));
    expect(await check()).toBeNull();
  });

  it('compares numbers, not strings (0.10.0 is newer than 0.9.0)', () => {
    expect(isNewer('v0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('lixo', '0.2.0')).toBe(false);
  });

  it('is silent on network failure, bad status or bad JSON', async () => {
    stub(() => {
      throw new TypeError('fetch failed');
    });
    await expect(check()).resolves.toBeNull();
    resetUpdateCache();
    stub(() => new Response('nope', { status: 500 }));
    await expect(check()).resolves.toBeNull();
    resetUpdateCache();
    stub(() => new Response('<html>', { status: 200 }));
    await expect(check()).resolves.toBeNull();
  });

  it('does not call the network at all when turned off or when the repo is not configured', async () => {
    stub(ok(release()));
    expect(await check({ enabled: false })).toBeNull();
    expect(await check({ repo: 'SEU-USUARIO/bookflix' })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('sends one anonymous GET: no body, no cookies, no credentials, only accept + user-agent', async () => {
    stub(ok(release()));
    await check();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/releases/latest');
    const init = calls[0].init;
    expect((init.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.credentials === undefined || init.credentials === 'omit').toBe(true);
    const names = [...new Headers(init.headers).keys()];
    expect(names.filter((n) => !['accept', 'user-agent'].includes(n))).toEqual([]);
    expect(new Headers(init.headers).get('user-agent')).toMatch(/^Bookflix\/\d/);
  });

  it('asks GitHub once per run, not on every page load', async () => {
    stub(ok(release()));
    await check();
    await check();
    expect(calls).toHaveLength(1);
  });

  it('APP_VERSION matches package.json', () => {
    expect(APP_VERSION).toBe(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  });
});

describe('GET /api/update-check', () => {
  it('respects the checkUpdates setting', async () => {
    process.env.BOOKFLIX_REPO = 'o/r';
    const { buildApp } = await import('../server/app.ts');
    const { updateSettings } = await import('../server/settings.ts');
    const app = await buildApp();
    stub(ok(release({ tag_name: 'v99.0.0' })));

    updateSettings({ checkUpdates: false });
    const off = JSON.parse((await app.inject({ method: 'GET', url: '/api/update-check' })).body);
    expect(off.update).toBeNull();
    expect(calls).toHaveLength(0);

    updateSettings({ checkUpdates: true });
    const on = JSON.parse((await app.inject({ method: 'GET', url: '/api/update-check' })).body);
    expect(on.update.version).toBe('99.0.0');
    expect(calls).toHaveLength(1);
    await app.close();
    delete process.env.BOOKFLIX_REPO;
  });
});
