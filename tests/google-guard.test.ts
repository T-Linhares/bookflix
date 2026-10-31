import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../server/db.ts';
import { googleBlockedFor, googleRequest, guardConfig, resetGuard } from '../server/metadata/guard.ts';

type Res = { status: number; json: any; error?: any; retryAfter?: number };
const ok = (json: any = { items: [{ volumeInfo: { title: 'Dune' } }] }): Res => ({ status: 200, json });
const quota = (retryAfter?: number): Res => ({ status: 429, json: null, error: { errors: [{ reason: 'rateLimitExceeded' }] }, retryAfter });

const DAY = 24 * 3600 * 1000;
const saved = { ...guardConfig };
const clock = { t: 1_000_000 };
let calls: string[];
let sleeps: number[];
let script: Res[];

const URL1 = 'https://www.googleapis.com/books/v1/volumes?q=isbn%3A9780441013593&maxResults=5&printType=books';
const URL2 = 'https://www.googleapis.com/books/v1/volumes?q=intitle%3A%22Dune%22&maxResults=5&printType=books';

beforeEach(() => {
  resetGuard();
  calls = [];
  sleeps = [];
  script = [];
  clock.t = 1_000_000;
  Object.assign(guardConfig, {
    minGapMs: 0,
    retryDefaultWaitMs: 1500,
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    fetch: async (url: string) => {
      calls.push(url);
      return script.shift() ?? ok();
    },
  });
});
afterEach(() => Object.assign(guardConfig, saved));

describe('cache', () => {
  it('answers a repeated search without asking Google again', async () => {
    const a = await googleRequest(URL1);
    const b = await googleRequest(URL1);
    expect(calls).toHaveLength(1);
    expect(b.json).toEqual(a.json);
    expect(b.cached).toBe(true);
  });

  it('does not care which API key was in the URL, and never stores it', async () => {
    await googleRequest(`${URL1}&key=SEGREDO-ABC`);
    await googleRequest(`${URL1}&key=OUTRA-CHAVE`);
    await googleRequest(URL1);
    expect(calls).toHaveLength(1);
    const rows = db.prepare('select * from lookup_cache').all() as { key: string; json: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/SEGREDO|OUTRA-CHAVE/);
    expect(calls[0]).toContain('key=SEGREDO-ABC'); // the real request still carries the key
  });

  it('different searches are different entries', async () => {
    await googleRequest(URL1);
    await googleRequest(URL2);
    expect(calls).toHaveLength(2);
  });

  it('keeps a found book for 30 days, and an empty answer only 2 days (Google may learn the book later)', async () => {
    await googleRequest(URL1);
    script.push(ok({ totalItems: 0 }));
    await googleRequest(URL2);

    clock.t += 3 * DAY;
    await googleRequest(URL1);
    expect(calls).toHaveLength(2); // still cached
    await googleRequest(URL2);
    expect(calls).toHaveLength(3); // the empty one expired

    clock.t += 28 * DAY; // 31 days after the first
    await googleRequest(URL1);
    expect(calls).toHaveLength(4);
  });

  it('never caches errors', async () => {
    script.push({ status: 500, json: null, error: { code: 500 } });
    expect((await googleRequest(URL1)).status).toBe(500);
    expect((await googleRequest(URL1)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('keeps answering from the cache while Google is blocking us', async () => {
    await googleRequest(URL1);
    script.push(quota(), quota());
    await googleRequest(URL2); // opens the breaker
    expect(googleBlockedFor()).toBeGreaterThan(0);
    const again = await googleRequest(URL1);
    expect(again.status).toBe(200);
    expect(again.cached).toBe(true);
  });
});

describe('spacing between requests', () => {
  it('leaves at least minGapMs between two requests, even when they are asked at the same time', async () => {
    guardConfig.minGapMs = 400;
    const starts: number[] = [];
    guardConfig.fetch = async () => {
      starts.push(clock.t);
      return ok({ items: [{ volumeInfo: { title: String(starts.length) } }] });
    };
    await Promise.all([googleRequest(URL1), googleRequest(URL2), googleRequest(`${URL2}&startIndex=5`)]);
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(400);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(400);
  });

  it('does not wait when the last request was long ago', async () => {
    guardConfig.minGapMs = 400;
    await googleRequest(URL1);
    clock.t += 5000;
    sleeps.length = 0;
    await googleRequest(URL2);
    expect(sleeps).toEqual([]);
  });
});

describe('retry and breaker', () => {
  it('tries once more after a short wait asked by Google, and succeeds without blocking anything', async () => {
    script.push(quota(2), ok());
    const r = await googleRequest(URL1);
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(2000);
    expect(googleBlockedFor()).toBe(0);
  });

  it('waits a default moment when Google does not say how long, and also retries a 503', async () => {
    script.push({ status: 503, json: null, error: { code: 503 } }, ok());
    expect((await googleRequest(URL1)).status).toBe(200);
    expect(sleeps).toContain(guardConfig.retryDefaultWaitMs);
  });

  it('after a second refusal it stops asking Google for a while, and says so', async () => {
    script.push(quota(), quota());
    const r = await googleRequest(URL1);
    expect(r.status).toBe(429);
    expect(calls).toHaveLength(2);
    expect(googleBlockedFor()).toBe(guardConfig.breakerMs);

    const blocked = await googleRequest(URL2);
    expect(blocked).toMatchObject({ status: 429, blocked: true });
    expect(calls).toHaveLength(2); // no new request went out
  });

  it('tries again by itself when the pause is over', async () => {
    script.push(quota(), quota());
    await googleRequest(URL1);
    clock.t += guardConfig.breakerMs + 1;
    expect(googleBlockedFor()).toBe(0);
    expect((await googleRequest(URL2)).status).toBe(200);
  });

  it('does not wait a long time to retry: it pauses for as long as Google asked (within limits)', async () => {
    script.push(quota(1800));
    await googleRequest(URL1);
    expect(calls).toHaveLength(1); // 30 min is too long to wait here
    expect(googleBlockedFor()).toBe(1800 * 1000);

    resetGuard();
    script.push(quota(99999));
    await googleRequest(URL1);
    expect(googleBlockedFor()).toBe(guardConfig.breakerMaxMs);
  });

  it('a daily-limit refusal pauses for longer than a per-minute one', async () => {
    const daily = { status: 403, json: null, error: { errors: [{ reason: 'dailyLimitExceeded' }] } } as Res;
    script.push(daily, daily);
    await googleRequest(URL1);
    expect(googleBlockedFor()).toBe(guardConfig.breakerDailyMs);
    expect(guardConfig.breakerDailyMs).toBeGreaterThan(guardConfig.breakerMs);
  });

  it('a wrong or disabled key is not a rate limit: no retry, no pause', async () => {
    script.push({ status: 400, json: null, error: { message: 'API key not valid. API_KEY_INVALID' } });
    expect((await googleRequest(URL1)).status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(googleBlockedFor()).toBe(0);
    script.push({ status: 403, json: null, error: { errors: [{ reason: 'accessNotConfigured' }] } });
    await googleRequest(URL2);
    expect(googleBlockedFor()).toBe(0);
  });

  it('requests queued behind a refusal do not go out once the pause starts', async () => {
    script.push(quota(), quota());
    const rs = await Promise.all([googleRequest(URL1), googleRequest(URL2), googleRequest(`${URL2}&startIndex=5`)]);
    expect(rs.map((r) => r.status)).toEqual([429, 429, 429]);
    expect(calls).toHaveLength(2);
  });
});

describe('in a full lookup', () => {
  it('after Google refuses, the next books skip it, still come from the other sources, and the screen says when it will retry', async () => {
    const { vi } = await import('vitest');
    const { lookupMetadata } = await import('../server/metadata/index.ts');
    guardConfig.fetch = saved.fetch; // the real helper, over the stubbed network below
    const hosts: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      hosts.push(new URL(u).hostname);
      if (u.includes('googleapis.com')) return new Response(JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 429 });
      if (u.includes('openlibrary.org/search')) return Response.json({ docs: [{ key: '/works/OL1W', title: 'Dune', author_name: ['Frank Herbert'], first_publish_year: 1965, subject: ['Science fiction'] }] });
      return new Response('{}', { status: 404 });
    });
    try {
      const meta = (title: string) => ({ title, authors: ['Frank Herbert'], tags: [] as string[] });
      const first = await lookupMetadata({ title: 'Dune', authors: ['Frank Herbert'] }, { meta: meta('Dune'), sources: {} });
      const googleAfterFirst = hosts.filter((h) => h.includes('googleapis')).length;
      expect(googleAfterFirst).toBe(2); // the try and its one retry
      const second = await lookupMetadata({ title: 'Dune Messiah', authors: ['Frank Herbert'] }, { meta: meta('Dune Messiah'), sources: {} });
      expect(hosts.filter((h) => h.includes('googleapis')).length).toBe(googleAfterFirst); // paused: nothing more went to Google
      expect(first.warnings.join(' ')).toMatch(/Volto a tentar sozinho em cerca de \d+ min/);
      expect(second.warnings.join(' ')).toMatch(/Google Books recusou/);
      expect(second.candidates.some((c) => c.source === 'openlibrary')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
