import { db, parseBook } from './db.ts';
import { norm } from './util.ts';

type Q = Record<string, string | string[] | undefined>;

export interface Filters {
  q?: string;
  status?: string[];
  series?: string;
  author?: string;
  publisher?: string;
  year?: number;
  tags?: string[];
  format?: string;
  rating?: number;
  progressMin?: number;
  progressMax?: number;
  hasNotes?: boolean;
  complete?: boolean;
  sent?: boolean;
  organized?: boolean;
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const list = (v: string | string[] | undefined) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).filter(Boolean));
const bool = (v: string | string[] | undefined) => (v === undefined || v === '' ? undefined : one(v) === '1' || one(v) === 'true');
const num = (v: string | string[] | undefined) => (one(v) === undefined || one(v) === '' || Number.isNaN(Number(one(v))) ? undefined : Number(one(v)));

export function parseFilters(q: Q): Filters {
  return {
    q: one(q.q)?.trim() || undefined,
    status: list(q.status),
    series: one(q.series) || undefined,
    author: one(q.author) || undefined,
    publisher: one(q.publisher) || undefined,
    year: num(q.year),
    tags: list(q.tags),
    format: one(q.format) || undefined,
    rating: num(q.rating),
    progressMin: num(q.progressMin),
    progressMax: num(q.progressMax),
    hasNotes: bool(q.hasNotes),
    complete: bool(q.complete),
    sent: bool(q.sent),
    organized: bool(q.organized),
    sort: one(q.sort) || undefined,
    dir: one(q.dir) === 'desc' ? 'desc' : one(q.dir) === 'asc' ? 'asc' : undefined,
    limit: num(q.limit),
    offset: num(q.offset),
  };
}

/** Prefix-matching, accent-insensitive FTS5 expression; every word must match. */
export function ftsQuery(q: string): string | null {
  const toks = norm(q).split(' ').filter(Boolean);
  return toks.length ? toks.map((t) => `"${t}"*`).join(' ') : null;
}

const SORTS: Record<string, [string, 'asc' | 'desc']> = {
  title: ['b.title collate nocase', 'asc'],
  author: ['b.authors collate nocase, b.title collate nocase', 'asc'],
  series: ["coalesce(b.series,'zzz') collate nocase, b.series_index, b.title collate nocase", 'asc'],
  year: ['b.year', 'desc'],
  added: ['b.added_at', 'desc'],
  last_read: ['b.last_read', 'desc'],
  rating: ['b.rating', 'desc'],
  progress: ['b.progress', 'desc'],
  relevance: ['f.rank', 'asc'],
};

export function listBooks(f: Filters) {
  const where: string[] = ['b.missing = 0'];
  const p: Record<string, any> = {};
  let join = '';

  const match = f.q ? ftsQuery(f.q) : null;
  if (match) {
    join = 'join (select rowid as rid, rank from books_fts where books_fts match :match) f on f.rid = b.id';
    p.match = match;
  }
  if (f.status?.length) where.push(`b.status in (${f.status.map((_, i) => `:st${i}`).join(',')})`), f.status.forEach((s, i) => (p[`st${i}`] = s));
  if (f.series) (where.push('b.series = :series'), (p.series = f.series));
  if (f.author) (where.push("('; ' || b.authors || ';') like :author"), (p.author = `%; ${f.author};%`));
  if (f.publisher) (where.push('b.publisher = :publisher'), (p.publisher = f.publisher));
  if (f.year) (where.push('b.year = :year'), (p.year = f.year));
  if (f.format) (where.push('b.format = :format'), (p.format = f.format));
  if (f.rating) (where.push('b.rating >= :rating'), (p.rating = f.rating));
  if (f.progressMin != null) (where.push('b.progress >= :pmin'), (p.pmin = f.progressMin));
  if (f.progressMax != null) (where.push('b.progress <= :pmax'), (p.pmax = f.progressMax));
  f.tags?.forEach((t, i) => (where.push(`exists (select 1 from json_each(b.tags) where value = :tag${i})`), (p[`tag${i}`] = t)));
  if (f.hasNotes !== undefined) where.push(`${f.hasNotes ? '' : 'not '}exists (select 1 from highlights h where h.book_id = b.id and h.deleted = 0)`);
  if (f.complete !== undefined) {
    const c = "(b.title is not null and b.authors <> '' and b.publisher is not null and b.year is not null and b.description is not null)";
    where.push(f.complete ? c : `not ${c}`);
  }
  if (f.sent !== undefined) where.push(`b.sent_to_kindle = ${f.sent ? 1 : 0}`);
  if (f.organized !== undefined) where.push(`b.organized = ${f.organized ? 1 : 0}`);

  const sortKey = f.sort && SORTS[f.sort] && (f.sort !== 'relevance' || match) ? f.sort : match ? 'relevance' : 'title';
  const [expr, defDir] = SORTS[sortKey];
  const dir = f.dir ?? defDir;
  // nulls last so unrated / unread books never crowd the top
  const order = `${expr} ${dir}${sortKey === 'year' || sortKey === 'rating' || sortKey === 'last_read' ? ' nulls last' : ''}`;

  const base = `from books b ${join} where ${where.join(' and ')}`;
  const total = (db.prepare(`select count(*) as n ${base}`).get(p) as { n: number }).n;
  const rows = db
    .prepare(
      `select b.*, (select count(*) from highlights h where h.book_id = b.id and h.deleted = 0) as notes_count ${base} order by ${order} limit :limit offset :offset`,
    )
    .all({ ...p, limit: Math.min(f.limit ?? 60, 500), offset: f.offset ?? 0 }) as any[];
  const items = rows.map((r) => {
    const { description, review, ...rest } = parseBook(r) as any;
    return rest;
  });
  return { items, total };
}

export function facets() {
  const rows = db.prepare('select * from books where missing = 0').all().map(parseBook);
  const count = (vals: (string | number | null | undefined)[]) => {
    const m = new Map<string | number, number>();
    for (const v of vals) if (v !== null && v !== undefined && v !== '') m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([value, n]) => ({ value, count: n }));
  };
  return {
    status: count(rows.map((b) => b.status)),
    series: count(rows.map((b) => b.series)),
    authors: count(rows.flatMap((b) => (b.authors ? b.authors.split(';').map((a) => a.trim()).filter(Boolean) : []))),
    publishers: count(rows.map((b) => b.publisher)),
    years: count(rows.map((b) => b.year)),
    tags: count(rows.flatMap((b) => b.tags)),
    formats: count(rows.map((b) => b.format)),
    total: rows.length,
  };
}

export function homeRows() {
  const pick = (sql: string, params: any[] = []) =>
    (db.prepare(sql).all(...params) as any[]).map((r) => {
      const { description, review, ...rest } = parseBook(r) as any;
      return rest;
    });
  const rows: any[] = [];
  const add = (id: string, title: string, items: any[], extra: object = {}) => items.length && rows.push({ id, title, kind: 'books', items, ...extra });

  add('continue', 'Continuar lendo', pick("select * from books where missing = 0 and status = 'reading' order by last_read desc nulls last limit 20"));

  const series = db
    .prepare(
      `select series, count(*) as n, min(id) as first_id from books where missing = 0 and series is not null group by series order by n desc, series limit 20`,
    )
    .all() as { series: string; n: number }[];
  if (series.length) {
    const items = series.map((s) => {
      const b = db.prepare('select * from books where missing = 0 and series = ? order by series_index nulls last, id limit 1').get(s.series) as any;
      const read = (db.prepare("select count(*) as n from books where missing = 0 and series = ? and status = 'read'").get(s.series) as { n: number }).n;
      return { ...parseBook(b), series_count: s.n, series_read: read, description: undefined, review: undefined };
    });
    rows.push({ id: 'series', title: 'Minhas séries', kind: 'series', items });
  }

  add('read', 'Lidos recentemente', pick("select * from books where missing = 0 and status = 'read' order by finished_at desc nulls last limit 20"));
  add('ready', 'Prontos para enviar ao Kindle', pick('select * from books where missing = 0 and organized = 1 and sent_to_kindle = 0 order by added_at desc limit 20'));
  add('recent', 'Adicionados recentemente', pick('select * from books where missing = 0 order by added_at desc limit 20'));

  const wish = db.prepare('select * from wishlist order by added_at desc limit 30').all() as any[];
  if (wish.length) rows.push({ id: 'wishlist', title: 'Quero ler', kind: 'wishlist', items: wish });

  const f = facets();
  for (const a of f.authors.filter((x) => x.count >= 2).slice(0, 3)) {
    add(`author-${a.value}`, `Mais de ${a.value}`, listBooks({ author: String(a.value), sort: 'series', limit: 20 }).items, { query: `author=${encodeURIComponent(String(a.value))}` });
  }
  for (const t of f.tags.filter((x) => x.count >= 2).slice(0, 3)) {
    add(`tag-${t.value}`, String(t.value), listBooks({ tags: [String(t.value)], limit: 20 }).items, { query: `tags=${encodeURIComponent(String(t.value))}` });
  }
  for (const sf of db.prepare('select * from saved_filters').all() as any[]) {
    const params = Object.fromEntries(new URLSearchParams(sf.query));
    add(`saved-${sf.id}`, sf.name, listBooks({ ...parseFilters(params), limit: 20 }).items, { query: sf.query, savedId: sf.id });
  }

  const hero =
    pick("select * from books where missing = 0 and status = 'reading' and cover is not null order by last_read desc nulls last limit 1")[0] ??
    pick('select * from books where missing = 0 and cover is not null order by random() limit 1')[0] ??
    null;
  if (hero) hero.description = (db.prepare('select description from books where id = ?').get(hero.id) as any)?.description;
  return { hero, rows };
}
