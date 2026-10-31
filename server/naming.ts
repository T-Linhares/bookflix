import path from 'node:path';

export interface NameInput {
  authors: string[];
  title?: string;
  series?: string;
  seriesIndex?: number;
}

export interface NameOptions {
  template?: string;
  useFolders?: boolean;
  maxLength?: number;
}

export const DEFAULT_TEMPLATE = '{author} - {title}';
const UNKNOWN_AUTHOR = 'Autor Desconhecido';
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function sanitize(s: string): string {
  let out = s
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (RESERVED.test(out)) out = `_${out}`;
  return out;
}

/** "Sanderson, Brandon" -> "Brandon Sanderson". */
export function displayAuthor(a: string): string {
  const m = a.match(/^([^,]+),\s*([^,]+)$/);
  return (m ? `${m[2]} ${m[1]}` : a).trim();
}

/** Drops subtitle, trailing "(...)" / "[...]" groups. */
export function shortTitle(title: string): string {
  const cut = title
    .split(/\s*[:–—]\s+|\s+-\s+/)[0]
    .replace(/\s*[\(\[][^)\]]*[\)\]]\s*$/, '')
    .trim();
  return cut || title.trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

export function buildFileName(input: NameInput, ext: string, opts: NameOptions = {}): string {
  const max = opts.maxLength ?? 100;
  let author = sanitize(displayAuthor(input.authors[0] ?? '')) || UNKNOWN_AUTHOR;
  let title = sanitize(shortTitle(input.title ?? '')) || 'Sem título';
  author = truncate(author, 40);
  const template = opts.template || DEFAULT_TEMPLATE;
  const fill = (t: string) =>
    template
      .replace(/\{author\}/g, author)
      .replace(/\{title\}/g, t)
      .replace(/\{series\}/g, sanitize(input.series ?? ''))
      .replace(/\{index\}/g, input.seriesIndex != null ? String(input.seriesIndex).padStart(2, '0') : '')
      .replace(/(\s*[-–]\s*){2,}/g, ' - ')
      .replace(/^[\s-–]+|[\s-–]+$/g, '')
      .replace(/\s+/g, ' ');
  let name = fill(title);
  if (name.length > max) {
    const over = name.length - max;
    title = truncate(title, Math.max(20, title.length - over));
    name = fill(title);
  }
  return `${sanitize(name)}.${ext.replace(/^\./, '').toLowerCase()}`;
}

/** Relative path inside the library: Autor/[Série/]Arquivo.ext */
export function buildRelPath(input: NameInput, ext: string, opts: NameOptions = {}): string {
  const file = buildFileName(input, ext, opts);
  if (opts.useFolders === false) return file;
  const parts = [truncate(sanitize(displayAuthor(input.authors[0] ?? '')) || UNKNOWN_AUTHOR, 60)];
  const series = input.series ? sanitize(input.series) : '';
  if (series) parts.push(truncate(series, 60));
  return path.join(...parts, file);
}
