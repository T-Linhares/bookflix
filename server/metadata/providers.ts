import { fetchJson, fetchRaw, similarity } from '../util.ts';
import { Meta } from '../formats/types.ts';
import { saneSeriesIndex } from '../formats/filename.ts';
import { googleKey } from '../settings.ts';
import { googleRequest, isQuotaError } from './guard.ts';

export type Source = 'google' | 'brasilapi' | 'openlibrary' | 'embedded' | 'livro' | 'filename' | 'gerado' | 'manual';

export interface Candidate {
  source: Source;
  /** Found only in another language than the file's: usable as an alternative, not auto-merged. */
  crossLanguage?: boolean;
  meta: Partial<Meta>;
  coverUrl?: string;
  link?: string;
}

export interface Seed {
  title?: string;
  authors?: string[];
  isbn?: string;
  language?: string;
}

const MIN_SIMILARITY = 0.6;

function rank(list: Candidate[], title?: string): Candidate[] {
  if (!title) return list;
  return list.map((c, i) => ({ c, i, s: similarity(title, c.meta.title) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.c);
}

/** What happened to each site during the last lookup, so the UI can say why a source was empty. */
export const providerStatus: Record<string, string> = {};

const OL_LANG: Record<string, string> = { pt: 'por', en: 'eng', es: 'spa', fr: 'fre', de: 'ger', it: 'ita' };

function year(s?: string): number | undefined {
  const m = s?.match(/\d{4}/);
  return m ? Number(m[0]) : undefined;
}

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export function cleanTags(subjects: string[], limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of subjects) {
    for (const part of raw.split(/\s*\/\s*|\s*--\s*/)) {
      const t = part.trim();
      const key = t.toLowerCase();
      if (!t || t.length > 32 || /^(fiction|general)$/i.test(t) && out.length > 2) continue;
      if (/^(nyt|new york times|reading level|accessible book|protected daisy|in library|large type)/i.test(t)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Maps a Google Books response to a short status the UI can explain. */
export function classifyGoogle(res: { status: number; error?: any }): 'ok' | 'quota' | 'chave-invalida' | 'api-desativada' | 'offline' | string {
  if (res.status === 200) return 'ok';
  if (res.status === 0) return 'offline';
  const reasons = JSON.stringify(res.error ?? '');
  if (isQuotaError(res)) return 'quota';
  if (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(reasons)) return 'chave-invalida';
  if (res.status === 403 || /SERVICE_DISABLED|accessNotConfigured|API_KEY_SERVICE_BLOCKED/.test(reasons)) return 'api-desativada';
  return `erro ${res.status}`;
}

export const GOOGLE_MESSAGES: Record<string, string> = {
  quota: 'Google Books recusou a busca: o limite de consultas foi atingido (a cota gratuita compartilhada é pequena). O Bookflix pausa o Google por um tempo e continua no Open Library e na BrasilAPI. Para ter uma cota só sua, crie uma chave gratuita (Google Cloud, Books API) e cole em Ajustes.',
  'chave-invalida': 'A chave do Google Books em Ajustes não é válida. Confira se copiou inteira.',
  'api-desativada': 'A chave do Google Books não tem permissão: ative a "Books API" no projeto dela (Google Cloud → APIs e serviços) e, se restringiu a chave, permita essa API.',
  offline: 'Sem conexão com o Google Books.',
};

export async function searchGoogle(seed: Seed, max = 5): Promise<Candidate[]> {
  const key = googleKey();
  const q = seed.isbn
    ? `isbn:${seed.isbn}`
    : [seed.title && `intitle:"${seed.title}"`, seed.authors?.[0] && `inauthor:"${seed.authors[0]}"`].filter(Boolean).join(' ');
  if (!q) return [];
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${max}&printType=books${key ? `&key=${key}` : ''}`;
  const res = await googleRequest(url);
  providerStatus.google = classifyGoogle(res);
  const data = res.json;
  const out: Candidate[] = [];
  for (const item of data?.items ?? []) {
    const v = item.volumeInfo ?? {};
    if (!v.title) continue;
    if (!seed.isbn && seed.title && similarity(seed.title, v.title) < MIN_SIMILARITY) continue;
    // only real ISBNs: Google also lists library record ids (type OTHER, e.g. "UOM:490150...")
    const ids = (v.industryIdentifiers ?? []).filter((i: any) => i.type === 'ISBN_13' || i.type === 'ISBN_10');
    const isbn = (ids.find((i: any) => i.type === 'ISBN_13') ?? ids[0])?.identifier;
    // the file says it is Portuguese and Google answered with the American edition: show it, do not apply it
    const want = seed.language?.slice(0, 2).toLowerCase();
    const got = typeof v.language === 'string' ? v.language.slice(0, 2).toLowerCase() : undefined;
    out.push({
      source: 'google',
      crossLanguage: !!want && !!got && want !== got,
      link: v.infoLink,
      coverUrl: v.imageLinks?.thumbnail?.replace('http:', 'https:').replace('&edge=curl', '').replace('zoom=1', 'zoom=2'),
      meta: {
        title: v.title,
        subtitle: v.subtitle,
        authors: v.authors ?? [],
        publisher: v.publisher,
        year: year(v.publishedDate),
        isbn,
        language: v.language,
        description: v.description ? stripHtml(v.description) : undefined,
        tags: cleanTags(v.categories ?? []),
        pages: v.pageCount || undefined,
      },
    });
  }
  return rank(out, seed.title);
}

/** "The Stormlight Archive ; 1", "Mistborn, #1", "Discworld (Book 4)". */
export function parseOlSeries(s: string): { series: string; seriesIndex?: number } {
  const m = s.match(/^(.*?)[\s,;:(]*(?:#|no\.?|book|vol\.?|volume|livro)?\s*(\d+(?:\.\d+)?)?\)?\s*$/i);
  const series = (m?.[1] ?? s).replace(/[\s,;:(]+$/, '').trim();
  return { series: series || s.trim(), seriesIndex: saneSeriesIndex(m?.[2]) };
}

export async function searchOpenLibrary(seed: Seed): Promise<Candidate[]> {
  if (!seed.isbn && !seed.title) return [];
  const want = seed.language ? OL_LANG[seed.language.slice(0, 2).toLowerCase()] : undefined;
  const run = async (lang?: string) => {
    const params = new URLSearchParams({
      limit: '5',
      fields: 'key,title,author_name,first_publish_year,publisher,isbn,subject,cover_i,edition_key,number_of_pages_median,language',
    });
    if (seed.isbn) params.set('q', `isbn:${seed.isbn}`);
    else {
      params.set('title', seed.title!);
      if (seed.authors?.[0]) params.set('author', seed.authors[0]);
    }
    if (lang) params.set('language', lang);
    return (await fetchJson<any>(`https://openlibrary.org/search.json?${params}`))?.docs ?? [];
  };
  let docs = want ? await run(want) : [];
  if (!docs.length) docs = await run();

  const out: Candidate[] = [];
  for (const d of docs.slice(0, 3)) {
    if (!seed.isbn && seed.title && similarity(seed.title, d.title) < MIN_SIMILARITY) continue;
    const meta: Partial<Meta> = {
      title: d.title,
      authors: d.author_name ?? [],
      year: d.first_publish_year,
      publisher: d.publisher?.[0],
      isbn: seed.isbn ?? d.isbn?.find((i: string) => i.length === 13),
      tags: cleanTags((d.subject ?? []).slice(0, 5), 4),
      pages: d.number_of_pages_median,
    };
    // editions carry publisher/date/series; only trust them when one exists in the book's language
    const picked = await pickEdition(d.edition_key ?? [], want);
    const ed = picked?.edition;
    if (ed) {
      if (picked.series) Object.assign(meta, parseOlSeries(picked.series));
      if (ed.publishers?.[0]) meta.publisher = ed.publishers[0];
      const y = year(ed.publish_date);
      if (y) meta.year = y;
      const desc = typeof ed.description === 'string' ? ed.description : ed.description?.value;
      if (desc) meta.description = stripHtml(desc);
    }
    if (!meta.description && d.key) {
      const w = await fetchJson<any>(`https://openlibrary.org${d.key}.json`);
      const desc = typeof w?.description === 'string' ? w.description : w?.description?.value;
      if (desc) meta.description = stripHtml(desc).split('----------')[0].trim();
    }
    out.push({
      source: 'openlibrary',
      meta,
      link: `https://openlibrary.org${d.key}`,
      coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined,
      // asked for a language and got none: keep it as an alternative, never as an automatic suggestion
      crossLanguage: !!want && !picked?.langOk,
    });
  }
  return rank(out, seed.title);
}

/**
 * Looks at a few editions. Returns the best one (language, publisher, date), whether it is in the
 * wanted language, and a series name only when most editions that list a series agree on it
 * (a single edition's "series" is often the publisher's collection, e.g. "Oscar Moderni").
 */
async function pickEdition(keys: string[], want?: string): Promise<{ edition: any; langOk: boolean; series?: string } | null> {
  const eds = (await Promise.all(keys.slice(0, 5).map((k) => fetchJson<any>(`https://openlibrary.org/books/${k}.json`)))).filter(Boolean);
  if (!eds.length) return null;
  const inLang = (e: any) => !!want && (e.languages ?? []).some((l: any) => l.key?.endsWith(`/${want}`));
  const score = (e: any) => (inLang(e) ? 4 : 0) + (e.publishers?.length ? 2 : 0) + (e.publish_date ? 1 : 0);
  const best = [...eds].sort((a, b) => score(b) - score(a))[0];

  const votes = new Map<string, number>();
  for (const e of eds) {
    const s = e.series?.[0];
    if (s) votes.set(s.trim(), (votes.get(s.trim()) ?? 0) + 1);
  }
  const withSeries = [...votes.values()].reduce((a, b) => a + b, 0);
  const [top, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  const series = top && (n >= 2 || (withSeries === 1 && eds.length === 1)) ? top : undefined;
  return { edition: best, langOk: !want || inLang(best), series };
}

/** Brazilian ISBN registry (CBL) through BrasilAPI: free, no key. Only useful when the ISBN is known. */
export async function searchBrasilApi(isbn?: string): Promise<Candidate[]> {
  if (!isbn) return [];
  const res = await fetchRaw(`https://brasilapi.com.br/api/isbn/v1/${isbn}`);
  providerStatus.brasilapi = res.status === 200 ? 'ok' : res.status === 404 ? 'nao-encontrado' : res.status === 0 ? 'offline' : `erro ${res.status}`;
  const d = res.json;
  if (!d?.title) return [];
  return [
    {
      source: 'brasilapi',
      coverUrl: d.cover_url || undefined,
      meta: {
        title: d.title,
        subtitle: d.subtitle || undefined,
        // the registry lists translators and illustrators after the author
        authors: d.authors?.length ? [d.authors[0]] : [],
        publisher: d.publisher || undefined,
        year: d.year || undefined,
        isbn: d.isbn ?? isbn,
        description: d.synopsis ? stripHtml(d.synopsis) : undefined,
        pages: d.page_count || undefined,
        tags: cleanTags(d.subjects ?? [], 4),
      },
    },
  ];
}

/** Settings "Testar chave": one real request, reported in plain words. */
export async function testGoogleKey(key?: string): Promise<{ ok: boolean; status: string; message: string }> {
  const k = key ?? googleKey();
  const res = await fetchRaw(`https://www.googleapis.com/books/v1/volumes?q=isbn:9780553293357&maxResults=1${k ? `&key=${encodeURIComponent(k)}` : ''}`);
  const status = classifyGoogle(res);
  if (status === 'ok') {
    const title = res.json?.items?.[0]?.volumeInfo?.title;
    return { ok: true, status, message: title ? `Funcionando ✓ (achou "${title}")${k ? '' : ', mas sem chave: a cota compartilhada pode acabar a qualquer momento'}.` : 'A chave é aceita, mas a busca de teste não retornou nada.' };
  }
  const base = GOOGLE_MESSAGES[status] ?? `O Google respondeu com ${status}.`;
  return { ok: false, status, message: !k && status === 'quota' ? base : base };
}
