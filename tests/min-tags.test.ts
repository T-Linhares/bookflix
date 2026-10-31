import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_TAGS, mergeCandidates } from '../server/metadata/index.ts';

const g = (tags: string[]) => ({ source: 'google' as const, meta: { title: 'x', authors: [], tags } });
const ol = (tags: string[]) => ({ source: 'openlibrary' as const, meta: { title: 'x', authors: [], tags } });
const tagsOf = (c: Parameters<typeof mergeCandidates>[0]) => (mergeCandidates(c).tags?.value as string[]) ?? [];

describe('at least 4 tags', () => {
  it('the minimum is 4', () => {
    expect(MIN_TAGS).toBe(4);
  });

  it('tops up a short list from Open Library, up to 4 and no further', () => {
    const r = mergeCandidates([g(['Fiction']), ol(['Coming of age', 'Teenage boys', 'New York (N.Y.)', 'Prep schools', 'Psychology'])]);
    expect(r.tags?.value).toEqual(['Fiction', 'Coming of age', 'Teenage boys', 'New York (N.Y.)']);
    expect(r.tags?.source).toBe('google'); // the trusted source keeps the credit
  });

  it('does not touch Open Library when the trusted sources already give 4', () => {
    expect(tagsOf([g(['A', 'B', 'C', 'D', 'E']), ol(['Z1', 'Z2'])])).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('keeps fewer than 4 when nobody has more (the AI step handles that case)', () => {
    expect(tagsOf([g(['A']), ol(['B'])])).toEqual(['A', 'B']);
  });

  it('does not repeat a tag Open Library shares with Google', () => {
    expect(tagsOf([g(['Fiction', 'Drama']), ol(['fiction', 'Drama', 'Novel', 'Classics'])])).toEqual(['Fiction', 'Drama', 'Novel', 'Classics']);
  });
});

describe('lookupMetadata completes the tags', () => {
  let settings: typeof import('../server/settings.ts');
  let prompts: string[];
  const file = { title: 'Franny e Zooey', authors: ['J. D. Salinger'], tags: [] as string[] };

  const stub = () =>
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
      const u = String(url);
      if (u.includes('googleapis.com/books'))
        return Response.json({ items: [{ id: 'a', volumeInfo: { title: 'Franny e Zooey', authors: ['J. D. Salinger'], publisher: 'Todavia', publishedDate: '2020', description: 'Sinopse', categories: ['Fiction'] } }] });
      if (u.includes('generativelanguage')) {
        prompts.push(String(init.body));
        return Response.json({ candidates: [{ content: { parts: [{ text: '{"tags":["Fiction","Romance de formação","Literatura americana","Clássicos","Família"]}' }] } }] });
      }
      return new Response('{}', { status: 404 });
    });

  beforeEach(async () => {
    prompts = [];
    settings = await import('../server/settings.ts');
    settings.updateSettings({ geminiKey: '', anthropicKey: '', openaiKey: '', aiOrder: 'auto' });
    for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
    stub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    settings.updateSettings({ geminiKey: '', anthropicKey: '', openaiKey: '', aiOrder: 'auto' });
  });

  it('asks the AI for the missing ones, keeps the existing one and ends with at least 4 (marked as generated)', async () => {
    settings.updateSettings({ geminiKey: 'k' });
    const { lookupMetadata } = await import('../server/metadata/index.ts');
    const r = await lookupMetadata({ title: file.title, authors: file.authors }, { meta: file, sources: {} });
    const tags = r.merged.tags?.value as string[];
    expect(tags.length).toBeGreaterThanOrEqual(4);
    expect(tags[0]).toBe('Fiction');
    expect(new Set(tags.map((t) => t.toLowerCase())).size).toBe(tags.length);
    expect(r.merged.tags?.source).toBe('gerado');
    expect(r.generated).toContain('tags');
    expect(prompts.join()).toContain('Fiction'); // it was told what already exists
  });

  it('without an AI key it keeps what it found and says that tags are short, pointing at Ajustes', async () => {
    const { lookupMetadata } = await import('../server/metadata/index.ts');
    const r = await lookupMetadata({ title: file.title, authors: file.authors }, { meta: file, sources: {} });
    expect(r.merged.tags?.value).toEqual(['Fiction']);
    expect(r.warnings.some((w) => /\btags?\b/i.test(w) && /4/.test(w) && /chave/i.test(w))).toBe(true);
    expect(prompts).toHaveLength(0);
  });
});
