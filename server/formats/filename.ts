import path from 'node:path';
import { Meta, emptyMeta } from './types.ts';

const NUM = String.raw`(\d+(?:\.\d+)?)`;
/** A series number is small; anything bigger is a year, a page count or part of the title. */
const sane = (n: number) => Number.isFinite(n) && n >= 0 && n <= 200;

/** Same limit for every source (file name, EPUB, Open Library, AI): returns the number, or undefined when it is not a plausible book order. */
export function saneSeriesIndex(n: unknown): number | undefined {
  if (n == null || n === '') return undefined;
  const v = Number(n);
  return sane(v) ? v : undefined;
}

/**
 * Extracts "Title (Series #3)" / "Series #3 - Title" style hints from a title string.
 * Only explicit markers (#, Book, Vol., Livro, or parentheses) count: a bare number such as
 * "Fahrenheit 451 - Ray Bradbury" or "Autor - 2014 - Título" is never read as a series.
 */
export function splitSeriesFromTitle(raw: string): { title: string; series?: string; seriesIndex?: number } {
  const t = raw.trim();
  let m = t.match(new RegExp(String.raw`^(.*?)\s*[\(\[]\s*([^()\[\]]+?)\s*[,:]?\s*(?:#|n[ºo°.]?\s*|book\s+|vol\.?\s*|volume\s+|livro\s+|v\.?\s*)${NUM}\s*[\)\]]\s*$`, 'i'));
  if (m && sane(Number(m[3]))) return { title: m[1].trim(), series: m[2].trim(), seriesIndex: Number(m[3]) };
  m = t.match(new RegExp(String.raw`^(.+?)[\s,]*(?:#\s*|(?:book|livro|vol\.?|volume)\s+)${NUM}\s*[-–—:]\s*(.+)$`, 'i'));
  if (m && sane(Number(m[2])) && /[a-z]/i.test(m[1]) && !/^\d+$/.test(m[1])) return { title: m[3].trim(), series: m[1].trim(), seriesIndex: Number(m[2]) };
  return { title: t };
}

const MD5 = /^[0-9a-f]{32}$/i;
const ISBN = /^(?:97[89][\d-]{10,14}|\d[\d-]{8,12}[\dXx])$/;

/**
 * "Título -- Autor -- 2014 -- Editora -- 9788576572008 -- <md5> -- Anna's Archive":
 * the layout of files downloaded from shadow libraries. Parts are positional, so each one is checked by shape.
 */
function fromDoubleDash(base: string): Meta | null {
  const parts = base.split(/\s+--\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const meta = emptyMeta();
  meta.title = parts[0];
  const authors = parts[1];
  if (authors && !/^\d{4}$/.test(authors) && !ISBN.test(authors.replace(/\s/g, ''))) meta.authors = authors.split(/\s*;\s*/).filter(Boolean);
  for (const p of parts.slice(2)) {
    const bare = p.replace(/[\s]/g, '');
    if (MD5.test(bare) || /archive/i.test(p)) continue;
    const isbn = bare.split(/[,;]/).map((x) => x.replace(/-/g, '')).find((x) => /^(97[89]\d{10}|\d{9}[\dXx])$/.test(x));
    if (isbn) {
      meta.isbn ??= isbn.toUpperCase();
      continue;
    }
    if (/^(19|20)\d{2}$/.test(p)) {
      meta.year ??= Number(p);
      continue;
    }
    if (p.length >= 2 && p.length <= 60 && !meta.publisher && !/^\d+$/.test(p)) meta.publisher = p;
  }
  return meta;
}

/** Best-effort metadata from a file name; understands "Autor - Título" and the "A -- B -- C" layout. */
export function metaFromFilename(file: string): Meta {
  const base = path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const dd = fromDoubleDash(base);
  if (dd) {
    const s = splitSeriesFromTitle(dd.title ?? '');
    dd.title = s.title;
    if (s.series) {
      dd.series = s.series;
      dd.seriesIndex = s.seriesIndex;
    }
    return dd;
  }
  const meta = emptyMeta();
  const parts = base.split(/\s+[-–—]\s+/);
  let titlePart = base;
  if (parts.length >= 2) {
    meta.authors = [parts[0].trim()];
    titlePart = parts.slice(1).join(' - ');
  }
  const s = splitSeriesFromTitle(titlePart);
  meta.title = s.title;
  if (s.series) {
    meta.series = s.series;
    meta.seriesIndex = s.seriesIndex;
  }
  return meta;
}
