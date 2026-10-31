import { Meta } from '../formats/types.ts';
import { Candidate, Seed, Source, searchBrasilApi, searchGoogle, searchOpenLibrary, cleanTags, providerStatus, GOOGLE_MESSAGES } from './providers.ts';
import { generateMissing } from './generate.ts';
import { aiAvailable } from '../settings.ts';
import { googleBlockedFor } from './guard.ts';
import { splitSeriesFromTitle } from '../formats/filename.ts';

export type Field = keyof Meta | 'cover';
export type Suggestion = { value: unknown; source: Source };
export type Merged = Partial<Record<Field, Suggestion>>;

/** Per-field source priority: the first source with a value wins. */
const PRIORITY: Record<string, Source[]> = {
  title: ['google', 'brasilapi', 'openlibrary', 'embedded', 'filename'],
  subtitle: ['google', 'brasilapi', 'openlibrary', 'embedded'],
  authors: ['google', 'brasilapi', 'openlibrary', 'embedded', 'filename'],
  series: ['embedded', 'openlibrary', 'filename'],
  seriesIndex: ['embedded', 'openlibrary', 'filename'],
  publisher: ['google', 'brasilapi', 'openlibrary', 'embedded', 'filename'],
  year: ['google', 'brasilapi', 'openlibrary', 'embedded', 'filename'],
  isbn: ['google', 'brasilapi', 'openlibrary', 'embedded', 'filename'],
  language: ['embedded', 'google', 'openlibrary'],
  description: ['google', 'brasilapi', 'openlibrary', 'embedded', 'filename'],
  pages: ['google', 'brasilapi', 'openlibrary', 'embedded', 'filename'],
};

/** A book should end up with at least this many tags (sites, then Open Library, then the AI). */
export const MIN_TAGS = 4;

const has = (v: unknown) => v != null && v !== '' && !(Array.isArray(v) && !v.length);

/** Pure merge step (kept separate so it is testable without network). */
export function mergeCandidates(cands: Candidate[]): Merged {
  const merged: Merged = {};
  for (const [field, order] of Object.entries(PRIORITY)) {
    // series and index must come from the same candidate
    if (field === 'seriesIndex') continue;
    for (const src of order) {
      const c = cands.find((c) => c.source === src && has((c.meta as any)[field]) && !(c.crossLanguage && field !== 'authors'));
      if (!c) continue;
      merged[field as Field] = { value: (c.meta as any)[field], source: src };
      if (field === 'series' && c.meta.seriesIndex != null) merged.seriesIndex = { value: c.meta.seriesIndex, source: src };
      break;
    }
  }
  // Open Library subjects are noisy: use them only when nobody else has tags, or to reach the minimum
  const trusted = cands.filter((c) => c.source !== 'openlibrary' && !c.crossLanguage);
  const pool = trusted.some((c) => c.meta.tags?.length) ? trusted : cands.filter((c) => !c.crossLanguage);
  let tags = cleanTags(pool.flatMap((c) => c.meta.tags ?? []));
  if (tags.length && tags.length < MIN_TAGS && pool === trusted) {
    const extra = cands.filter((c) => c.source === 'openlibrary' && !c.crossLanguage).flatMap((c) => c.meta.tags ?? []);
    tags = cleanTags([...tags, ...extra], MIN_TAGS);
  }
  if (tags.length) merged.tags = { value: tags, source: pool.find((c) => c.meta.tags?.length)!.source };
  const cover = cands.find((c) => c.coverUrl);
  if (cover) merged.cover = { value: cover.coverUrl, source: cover.source };
  return merged;
}

export interface LookupResult {
  merged: Merged;
  candidates: Candidate[];
  warnings: string[];
  /** fields no site had that were created (heuristics or AI) */
  generated: string[];
  /** fields still empty after everything */
  empty: string[];
  foundOnline: boolean;
  /** a Gemini or Anthropic key is configured, so description/tags can be written for real */
  ai: boolean;
}

/**
 * Cascade: Google Books -> Open Library -> generated.
 * `current` is what the file already has (embedded/filename); it ranks below the sites but fills gaps.
 */
export async function lookupMetadata(seed: Seed, current: { meta: Meta; sources: Record<string, string> }): Promise<LookupResult> {
  const candidates: Candidate[] = [];
  for (const k of Object.keys(providerStatus)) delete providerStatus[k];
  const embeddedSource = (Object.values(current.sources).includes('embedded') ? 'embedded' : 'filename') as Source;
  candidates.push({ source: embeddedSource, meta: current.meta });

  const isbn = seed.isbn ?? current.meta.isbn;
  // "Title (Series, #3)" would defeat the search: look the book up by its clean title
  const rawTitle = seed.title ?? current.meta.title;
  const fromTitle = rawTitle ? splitSeriesFromTitle(rawTitle) : undefined;
  const s: Seed = { ...seed, title: fromTitle?.title ?? rawTitle, isbn, language: current.meta.language };
  let found = await searchGoogle(s);
  if (!found.length && isbn) found = await searchGoogle({ ...s, isbn: undefined });
  candidates.push(...found);
  candidates.push(...(await searchBrasilApi(isbn)));

  // Open Library is consulted when Google found nothing OR left series/publisher/edition year empty
  const g = mergeCandidates(candidates);
  const needsMore = !found.length || !g.series || !g.publisher || !g.year || !g.description || ((g.tags?.value as string[] | undefined)?.length ?? 0) < MIN_TAGS;
  if (needsMore) {
    const best = found[0]?.meta;
    candidates.push(...(await searchOpenLibrary({ title: best?.title ?? s.title, authors: best?.authors ?? s.authors, isbn: best?.isbn ?? isbn, language: s.language })));
  }

  const merged = mergeCandidates(candidates);

  // a title that only the file itself provided keeps its "(Series, #n)" tail otherwise
  if (fromTitle?.series && merged.title && (merged.title.source === 'embedded' || merged.title.source === 'filename') && merged.title.value === rawTitle) {
    merged.title = { value: fromTitle.title, source: merged.title.source };
    if (!merged.series) merged.series = { value: fromTitle.series, source: 'gerado' };
    if (!merged.seriesIndex && fromTitle.seriesIndex != null) merged.seriesIndex = { value: fromTitle.seriesIndex, source: 'gerado' };
  }

  // anything still missing is created
  const base: Meta = {
    title: (merged.title?.value as string) ?? current.meta.title,
    authors: (merged.authors?.value as string[]) ?? current.meta.authors,
    year: merged.year?.value as number | undefined,
    publisher: merged.publisher?.value as string | undefined,
    tags: (merged.tags?.value as string[] | undefined) ?? [],
  };
  const missing = new Set<string>();
  if (!merged.series) missing.add('series');
  if (!merged.description) missing.add('description');
  if (base.tags.length < MIN_TAGS) missing.add('tags');
  if (missing.size) {
    const gen = await generateMissing(base, missing);
    if (gen.series) merged.series = { value: gen.series, source: 'gerado' };
    if (gen.series && gen.seriesIndex != null) merged.seriesIndex = { value: gen.seriesIndex, source: 'gerado' };
    if (gen.description) merged.description = { value: gen.description, source: 'gerado' };
    if (gen.tags?.length) {
      const all = cleanTags([...base.tags, ...gen.tags]);
      if (all.length > base.tags.length) merged.tags = { value: all, source: 'gerado' };
    }
  }
  // say where a value really came from: the OPF, the book's own text, or the file name
  for (const [k, s] of Object.entries(merged)) {
    if (s && (s.source === 'embedded' || s.source === 'filename') && current.sources[k]) s.source = current.sources[k] as Source;
  }
  const generated = Object.entries(merged).filter(([, s]) => s?.source === 'gerado').map(([k]) => k);
  const empty = ['publisher', 'year', 'tags', 'description', 'isbn'].filter((k) => !(merged as any)[k]);
  const foundOnline = candidates.some((c) => ['google', 'brasilapi', 'openlibrary'].includes(c.source) && !c.crossLanguage);
  const warnings: string[] = [];
  const gStatus = providerStatus.google;
  if (gStatus && gStatus !== 'ok') {
    const wait = gStatus === 'quota' ? googleBlockedFor() : 0;
    warnings.push((GOOGLE_MESSAGES[gStatus] ?? `Google Books indisponível (${gStatus}).`) + (wait ? ` Volto a tentar sozinho em cerca de ${Math.max(1, Math.ceil(wait / 60000))} min.` : ''));
  }
  const nTags = (merged.tags?.value as string[] | undefined)?.length ?? 0;
  if (nTags > 0 && nTags < MIN_TAGS)
    warnings.push(
      aiAvailable()
        ? `Só ${nTags} tag${nTags > 1 ? 's' : ''} (o mínimo é ${MIN_TAGS}): a IA não conseguiu completar. Adicione à mão ou tente buscar de novo.`
        : `Só ${nTags} tag${nTags > 1 ? 's' : ''} encontrada${nTags > 1 ? 's' : ''} (o mínimo é ${MIN_TAGS}). Configure uma chave de IA em Ajustes para completar.`,
    );
  return { merged, candidates, warnings, generated, empty, foundOnline, ai: aiAvailable() };
}
