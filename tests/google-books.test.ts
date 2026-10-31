import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let settings: typeof import('../server/settings.ts');
let meta: typeof import('../server/metadata/index.ts');
let urls: string[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ALLOWED = ['www.googleapis.com', 'openlibrary.org', 'covers.openlibrary.org', 'brasilapi.com.br'];

function stub(google: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('googleapis.com/books')) return google();
      if (u.includes('openlibrary.org')) return json({ docs: [] });
      return json({}, 404);
    }),
  );
}
const lookup = () => meta.lookupMetadata({ title: 'Duna', authors: ['Frank Herbert'] }, { meta: { title: 'Duna', authors: ['Frank Herbert'], tags: [] }, sources: {} });
const googleUrls = () => urls.filter((u) => u.includes('googleapis.com/books'));

beforeEach(async () => {
  urls = [];
  settings = await import('../server/settings.ts');
  meta = await import('../server/metadata/index.ts');
  settings.updateSettings({ googleBooksKey: '', geminiKey: '', anthropicKey: '', openaiKey: '' });
  delete process.env.GOOGLE_BOOKS_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  settings.updateSettings({ googleBooksKey: '' });
});

describe('Google Books without any proxy (T8)', () => {
  it('asks Google directly and without a key when the user has none', async () => {
    stub(() => json({ items: [] }));
    await lookup();
    expect(googleUrls().length).toBeGreaterThan(0);
    for (const u of googleUrls()) expect(u).not.toMatch(/[?&]key=/);
  });

  it("sends the user's own key when one is configured", async () => {
    settings.updateSettings({ googleBooksKey: 'k-user-123' });
    stub(() => json({ items: [] }));
    await lookup();
    for (const u of googleUrls()) expect(u).toContain('key=k-user-123');
  });

  it('on 429 falls back to Open Library and tells the user how to fix it', async () => {
    stub(() => json({ error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } }, 429));
    const r = await lookup();
    expect(urls.some((u) => u.includes('openlibrary.org'))).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/chave gratuita/);
    expect(r.warnings.join(' ')).toMatch(/Open Library/);
  });

  it('only ever talks to the documented hosts (nothing of the author in the middle)', async () => {
    stub(() => json({ error: { code: 429 } }, 429));
    await lookup();
    for (const u of urls) expect(ALLOWED).toContain(new URL(u).hostname);
  });
});
