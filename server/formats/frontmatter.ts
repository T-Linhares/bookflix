import JSZip from 'jszip';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export interface FrontMatter {
  isbn?: string;
  year?: number;
  publisher?: string;
  language?: string;
  synopsis?: string;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#169;': '©', '&copy;': '©', '&#160;': ' ', '&apos;': "'" };

/** XHTML -> plain text, keeping one line per block element so headings stay on their own line. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|copy|#169|#160);/g, (m) => ENTITIES[m] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const STOP: Record<string, RegExp> = {
  pt: /\b(de|que|não|uma|para|com|os|as|em|do|da|ele|ela|mas)\b/gi,
  en: /\b(the|and|of|to|was|that|his|her|with|for|you|had)\b/gi,
  es: /\b(el|los|las|que|una|para|con|por|del|pero|sus)\b/gi,
};

export function detectLanguage(text: string): string | undefined {
  const sample = text.slice(0, 8000);
  if (sample.length < 300) return undefined;
  const scores = Object.entries(STOP).map(([lang, re]) => [lang, (sample.match(re) ?? []).length] as const).sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  return best[1] >= 25 && best[1] > second[1] * 1.3 ? best[0] : undefined;
}

const SYNOPSIS_HEADING = /^(sinopse|resumo|sobre o livro|sobre a obra|descri[cç][aã]o|about the book|synopsis|description|blurb)\s*:?$/i;

/** Pure text analysis, split out so it can be tested without building an EPUB. */
export function analyseFrontMatter(docs: string[]): FrontMatter {
  const out: FrontMatter = {};
  const text = docs.join('\n\n');

  const isbn = text.match(/ISBN(?:-1[03])?\s*(?:digital|e-?book|epub)?\s*[:.]?\s*((?:97[89][\s-]?)?(?:\d[\s-]?){9}[\dXx])/i);
  if (isbn) {
    const digits = isbn[1].replace(/[^0-9Xx]/g, '');
    if (digits.length === 13 || digits.length === 10) out.isbn = digits.toUpperCase();
  }

  const year = text.match(/(?:©|\(c\)|copyright)\s*(?:by\s+)?(?:[^\d\n]{0,50}?)((?:19|20)\d{2})/i) ?? text.match(/\b(?:edi[cç][aã]o|publicado em|published|first published)[^\d\n]{0,25}((?:19|20)\d{2})/i);
  if (year) out.year = Number(year[1]);

  // names never span lines: use [ \t] instead of \s
  const WORD = String.raw`[\p{Lu}][\p{L}&.\-]*`;
  const pub =
    text.match(new RegExp(String.raw`\b(Editora[ \t]+${WORD}(?:[ \t]+${WORD}){0,3})`, 'u')) ??
    text.match(new RegExp(String.raw`\b(${WORD}(?:[ \t]+${WORD}){0,2}[ \t]+(?:Editora|Editores|Books|Press|Publishing|Publishers|Livros))\b`, 'u')) ??
    text.match(new RegExp(String.raw`(?:published by|publicado por|edi[cç][aã]o:?)[ \t]+(${WORD}(?:[ \t]+${WORD}){0,3})`, 'iu'));
  if (pub) out.publisher = pub[1].trim().replace(/[ \t]+(Ltda|S\.?A|Eireli|ME)\.?$/i, '').replace(/[.,;]+$/, '');

  // synopsis: lines after a "Sinopse" / "About the book" heading
  for (const doc of docs) {
    const lines = doc.split('\n').map((l) => l.trim());
    const at = lines.findIndex((l) => l.length < 40 && SYNOPSIS_HEADING.test(l));
    if (at < 0) continue;
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (!l) {
        if (body.join(' ').length > 120) break;
        continue;
      }
      if (l.length < 40 && /^[\p{Lu}\d\s.\-]+$/u.test(l) && body.length) break; // next heading
      body.push(l);
      if (body.join(' ').length > 900) break;
    }
    const syn = body.join('\n').trim();
    if (syn.length >= 80) {
      out.synopsis = syn.slice(0, 1200);
      break;
    }
  }

  // language from the running text of the first chapters
  const prose = docs.filter((d) => d.length > 1500).slice(0, 3).join(' ');
  out.language = detectLanguage(prose);
  return out;
}

/** Looks at the copyright/credits pages and early chapters of an EPUB for what the OPF does not say. */
export async function scanFrontMatter(buf: Buffer): Promise<FrontMatter> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const container = await zip.file('META-INF/container.xml')?.async('string');
    const opfPath = arr(parser.parse(container ?? '')?.container?.rootfiles?.rootfile)[0]?.['@_full-path'];
    const opfXml = opfPath && (await zip.file(opfPath)?.async('string'));
    if (!opfXml) return {};
    const pkg = parser.parse(opfXml).package ?? {};
    const manifest = new Map<string, string>(arr<any>(pkg.manifest?.item).filter((i) => /html/.test(i['@_media-type'] ?? '')).map((i) => [i['@_id'], i['@_href']]));
    const order = arr<any>(pkg.spine?.itemref).map((r) => manifest.get(r['@_idref'])).filter((h): h is string => !!h);
    // first pages (cover, title, copyright, synopsis) plus the last two (colophon)
    const picks = [...new Set([...order.slice(0, 14), ...order.slice(-2)])];
    const docs: string[] = [];
    for (const href of picks) {
      const full = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(href.split('#')[0])));
      const html = await zip.file(full)?.async('string');
      if (html) docs.push(htmlToText(html.slice(0, 120_000)));
    }
    return analyseFrontMatter(docs);
  } catch {
    return {};
  }
}
