import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('recommendations', () => {
  let bookId: number;
  let recommendationsFor: typeof import('../server/recommend.ts').recommendationsFor;
  let dismissRecommendation: typeof import('../server/recommend.ts').dismissRecommendation;

  beforeAll(async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('openlibrary.org/search.json'))
        return Response.json({
          docs: [
            { key: '/works/1', title: 'Livro Próprio', author_name: ['Ann Author'] },
            { key: '/works/2', title: 'Second Book', author_name: ['Ann Author'], cover_i: 7 },
            { key: '/works/3', title: 'Third Book', author_name: ['Ann Author'] },
            { key: '/works/4', title: 'Someone Else', author_name: ['Other Person'] },
          ],
        });
      return new Response('{}', { status: 429 });
    });
    const { insertBook } = await import('../server/library.ts');
    ({ recommendationsFor, dismissRecommendation } = await import('../server/recommend.ts'));
    bookId = insertBook('/tmp/own.epub', 1, 'h-own', { title: 'Livro Próprio', authors: ['Ann Author'], tags: [] }, {});
  });
  afterAll(() => vi.unstubAllGlobals());

  it('suggests other books by the author and never the ones already in the library', async () => {
    const titles = (await recommendationsFor(bookId, true)).map((r) => r.title);
    expect(titles).toEqual(expect.arrayContaining(['Second Book', 'Third Book']));
    expect(titles).not.toContain('Livro Próprio');
    expect(titles).not.toContain('Someone Else');
  });

  it('hides a dismissed title, including from the cached list', async () => {
    dismissRecommendation('Third Book', 'Ann Author');
    const titles = (await recommendationsFor(bookId)).map((r) => r.title);
    expect(titles).toContain('Second Book');
    expect(titles).not.toContain('Third Book');
  });
});
