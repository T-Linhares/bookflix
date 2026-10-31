import { BookRow, db, getBook, parseBook } from './db.ts';
import { fetchJson, norm, now } from './util.ts';
import { googleKey } from './settings.ts';

export interface Rec {
  key: string;
  title: string;
  authors: string[];
  description?: string;
  coverUrl?: string;
  link?: string;
  year?: number;
  reason: string;
  score: number;
  wishlisted?: boolean;
}

const TTL = 14 * 24 * 3600;
const dedupKey = (title: string, author?: string) => `${norm(title)}|${norm(author)}`;

function libraryIndex() {
  const rows = db.prepare('select title, subtitle, authors, isbn from books').all() as any[];
  const titles = new Set<string>();
  const isbns = new Set<string>();
  const titleOnly = new Set<string>();
  for (const r of rows) {
    const a = (r.authors ?? '').split(';')[0];
    titles.add(dedupKey(r.title ?? '', a));
    if (r.subtitle) titles.add(dedupKey(`${r.title}: ${r.subtitle}`, a));
    titleOnly.add(norm(r.title));
    if (r.isbn) isbns.add(r.isbn);
  }
  return { has: (title: string, author?: string, isbn?: string) => titles.has(dedupKey(title, author)) || (!!isbn && isbns.has(isbn)) || titleOnly.has(norm(title)) };
}

async function googleQuery(q: string, max = 15): Promise<any[]> {
  const key = googleKey();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${max}&printType=books&orderBy=relevance${key ? `&key=${key}` : ''}`;
  return (await fetchJson<any>(url))?.items ?? [];
}

function fromGoogle(item: any, reason: string, score: number): Rec | null {
  const v = item.volumeInfo;
  if (!v?.title) return null;
  return {
    key: `g:${item.id}`,
    title: v.title,
    authors: v.authors ?? [],
    description: v.description?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 320),
    coverUrl: v.imageLinks?.thumbnail?.replace('http:', 'https:').replace('&edge=curl', ''),
    link: v.infoLink,
    year: Number(v.publishedDate?.match(/\d{4}/)?.[0]) || undefined,
    reason,
    score,
  };
}

async function build(book: BookRow): Promise<Rec[]> {
  const author = book.authors.split(';')[0]?.trim();
  const lib = libraryIndex();
  const found = new Map<string, Rec>();
  const add = (r: Rec | null, isbn?: string) => {
    if (!r || lib.has(r.title, r.authors[0], isbn)) return;
    const k = dedupKey(r.title, r.authors[0]);
    const prev = found.get(k);
    if (!prev || prev.score < r.score) found.set(k, r);
  };

  const jobs: Promise<void>[] = [];
  if (book.series) {
    jobs.push(
      googleQuery(`"${book.series}"${author ? ` inauthor:"${author}"` : ''}`).then((items) =>
        items.forEach((i) => {
          const t = norm(i.volumeInfo?.title);
          const inSeries = t.includes(norm(book.series));
          add(fromGoogle(i, inSeries ? `Continua a série ${book.series}` : `Mesma série/autor: ${book.series}`, inSeries ? 10 : 6), i.volumeInfo?.industryIdentifiers?.[0]?.identifier);
        }),
      ),
    );
  }
  if (author) {
    jobs.push(
      googleQuery(`inauthor:"${author}"`, 20).then((items) =>
        items.forEach((i) => add(fromGoogle(i, `Outro livro de ${author}`, 7), i.volumeInfo?.industryIdentifiers?.[0]?.identifier)),
      ),
    );
  }
  if (author) {
    // keyless baseline: works by the same author on Open Library (Google Books may be out of quota)
    jobs.push(
      fetchJson<any>(
        `https://openlibrary.org/search.json?author=${encodeURIComponent(author)}&limit=25&sort=editions&fields=key,title,author_name,cover_i,first_publish_year,isbn`,
      ).then((d) => {
        for (const w of d?.docs ?? []) {
          if (!w.author_name?.some((a: string) => norm(a) === norm(author))) continue;
          add(
            {
              key: `ol:${w.key}`,
              title: w.title,
              authors: w.author_name,
              coverUrl: w.cover_i ? `https://covers.openlibrary.org/b/id/${w.cover_i}-M.jpg` : undefined,
              link: `https://openlibrary.org${w.key}`,
              year: w.first_publish_year,
              reason: `Outro livro de ${author}`,
              score: 6,
            },
            w.isbn?.[0],
          );
        }
      }),
    );
  }
  for (const tag of book.tags.slice(0, 2)) {
    jobs.push(
      googleQuery(`subject:"${tag}"`, 15).then((items) =>
        items.forEach((i) => add(fromGoogle(i, `Assunto em comum: ${tag}`, 4), i.volumeInfo?.industryIdentifiers?.[0]?.identifier)),
      ),
    );
    const slug = tag.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    jobs.push(
      fetchJson<any>(`https://openlibrary.org/subjects/${slug}.json?limit=12`).then((d) => {
        for (const w of d?.works ?? []) {
          add({
            key: `ol:${w.key}`,
            title: w.title,
            authors: (w.authors ?? []).map((a: any) => a.name),
            coverUrl: w.cover_id ? `https://covers.openlibrary.org/b/id/${w.cover_id}-M.jpg` : undefined,
            link: `https://openlibrary.org${w.key}`,
            year: w.first_publish_year,
            reason: `Assunto em comum: ${tag}`,
            score: 3,
          });
        }
      }),
    );
  }
  await Promise.all(jobs);

  const sameAuthor = (r: Rec) => (author && r.authors.some((a) => norm(a) === norm(author)) ? 0.5 : 0);
  return [...found.values()]
    .map((r) => ({ ...r, score: r.score + sameAuthor(r) + (r.coverUrl ? 0.3 : 0) + (r.description ? 0.2 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

export async function recommendationsFor(bookId: number, refresh = false): Promise<Rec[]> {
  const book = getBook(bookId);
  if (!book) throw new Error('Livro não encontrado');
  let recs: Rec[] | null = null;
  if (!refresh) {
    const row = db.prepare('select json, fetched_at from recs where book_id = ?').get(bookId) as any;
    if (row && now() - row.fetched_at < TTL) recs = JSON.parse(row.json);
  }
  if (!recs) {
    recs = await build(book);
    if (recs.length) db.prepare('insert or replace into recs(book_id, json, fetched_at) values(?,?,?)').run(bookId, JSON.stringify(recs), now());
  }
  // library may have changed since the cache was written
  const lib = libraryIndex();
  const hidden = new Set((db.prepare('select norm from rec_dismissed').all() as { norm: string }[]).map((r) => r.norm));
  const wished = new Set((db.prepare('select key from wishlist').all() as { key: string }[]).map((r) => r.key));
  return recs.filter((r) => !lib.has(r.title, r.authors[0]) && !hidden.has(dedupKey(r.title, r.authors[0]))).map((r) => ({ ...r, wishlisted: wished.has(r.key) }));
}

/** "Já tenho": translated editions look like new books to the sites, so the user can hide a title for good. */
export function dismissRecommendation(title: string, author?: string) {
  db.prepare('insert or ignore into rec_dismissed(norm, title, at) values(?,?,?)').run(dedupKey(title, author), title, now());
}
