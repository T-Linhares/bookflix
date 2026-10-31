import JSZip from 'jszip';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { Cover, Meta, emptyMeta } from './types.ts';
import { saneSeriesIndex } from './filename.ts';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const txt = (v: any): string => {
  if (v == null) return '';
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') return txt(v['#text']);
  return String(v);
};
const stripHtml = (s: string) =>
  s
    .replace(/<\/(p|div|br)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const MIME_EXT: Record<string, Cover['ext']> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

async function locateOpf(zip: JSZip): Promise<{ opfPath: string; xml: string }> {
  const container = await zip.file('META-INF/container.xml')?.async('string');
  if (!container) throw new Error('EPUB sem META-INF/container.xml');
  const rootfile = arr(parser.parse(container)?.container?.rootfiles?.rootfile)[0];
  const opfPath = rootfile?.['@_full-path'];
  if (!opfPath) throw new Error('EPUB sem arquivo OPF');
  const xml = await zip.file(opfPath)?.async('string');
  if (!xml) throw new Error('OPF não encontrado dentro do EPUB');
  return { opfPath, xml };
}

function findCoverItem(pkg: any): { href: string; mime: string; id: string } | undefined {
  const items = arr<any>(pkg?.manifest?.item);
  const metas = arr<any>(pkg?.metadata?.meta);
  const byProp = items.find((i) => String(i['@_properties'] ?? '').split(/\s+/).includes('cover-image'));
  if (byProp) return { href: byProp['@_href'], mime: byProp['@_media-type'], id: byProp['@_id'] };
  const coverId = metas.find((m) => m['@_name'] === 'cover')?.['@_content'];
  const byMeta = coverId && items.find((i) => i['@_id'] === coverId);
  if (byMeta) return { href: byMeta['@_href'], mime: byMeta['@_media-type'], id: byMeta['@_id'] };
  const guess = items.find((i) => /^image\//.test(i['@_media-type'] ?? '') && /cover/i.test(`${i['@_id']} ${i['@_href']}`));
  return guess && { href: guess['@_href'], mime: guess['@_media-type'], id: guess['@_id'] };
}

export async function readEpub(buf: Buffer): Promise<{ meta: Meta; cover?: Cover }> {
  const zip = await JSZip.loadAsync(buf);
  const { opfPath, xml } = await locateOpf(zip);
  const pkg = parser.parse(xml)?.package ?? {};
  const md = pkg.metadata ?? {};
  const metas = arr<any>(md.meta);
  const meta = emptyMeta();

  meta.title = txt(arr(md.title)[0]) || undefined;
  meta.authors = arr(md.creator).map(txt).filter(Boolean);
  meta.publisher = txt(arr(md.publisher)[0]) || undefined;
  const yr = txt(arr(md.date)[0]).match(/\d{4}/);
  if (yr) meta.year = Number(yr[0]);
  meta.language = txt(arr(md.language)[0]) || undefined;
  const desc = txt(arr(md.description)[0]);
  if (desc) meta.description = stripHtml(desc);
  meta.tags = arr(md.subject).map(txt).filter(Boolean);
  for (const id of arr(md.identifier)) {
    const m = txt(id).replace(/[^0-9Xx]/g, '').match(/^(97[89]\d{10}|\d{9}[\dXx])$/);
    if (m) {
      meta.isbn = m[1].toUpperCase();
      break;
    }
  }

  const calSeries = metas.find((m) => m['@_name'] === 'calibre:series')?.['@_content'];
  const calIdx = metas.find((m) => m['@_name'] === 'calibre:series_index')?.['@_content'];
  if (calSeries) {
    meta.series = calSeries;
    meta.seriesIndex = saneSeriesIndex(calIdx);
  } else {
    const coll = metas.find((m) => m['@_property'] === 'belongs-to-collection');
    if (coll) {
      meta.series = txt(coll);
      const id = coll['@_id'];
      const pos = metas.find((m) => m['@_refines'] === `#${id}` && m['@_property'] === 'group-position');
      if (pos) meta.seriesIndex = saneSeriesIndex(txt(pos));
    }
  }

  let cover: Cover | undefined;
  const item = findCoverItem(pkg);
  if (item?.href) {
    const full = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(item.href)));
    const data = await zip.file(full)?.async('nodebuffer');
    const ext = MIME_EXT[item.mime];
    if (data && ext) cover = { data, ext };
  }
  return { meta, cover };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function removeElements(opf: string, prefix: string, tag: string): { opf: string; ids: string[] } {
  const ids: string[] = [];
  const re = new RegExp(`<${prefix}:${tag}\\b([^>]*?)(?:/>|>[\\s\\S]*?</${prefix}:${tag}>)`, 'g');
  return {
    opf: opf.replace(re, (_m, attrs: string) => {
      const id = attrs.match(/\bid="([^"]+)"/)?.[1];
      if (id) ids.push(id);
      return '';
    }),
    ids,
  };
}

/** Rewrites the OPF metadata block (and cover) and returns the new EPUB bytes. */
export async function writeEpub(buf: Buffer, meta: Meta, cover?: Cover): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const { opfPath, xml } = await locateOpf(zip);
  const dc = xml.match(/xmlns:(\w+)="http:\/\/purl\.org\/dc\/elements\/1\.1\/"/)?.[1] ?? 'dc';
  const isV3 = /<package\b[^>]*\bversion="3/.test(xml);
  let opf = xml;
  const removedIds: string[] = [];
  for (const tag of ['title', 'creator', 'publisher', 'date', 'description', 'subject']) {
    const r = removeElements(opf, dc, tag);
    opf = r.opf;
    removedIds.push(...r.ids);
  }
  // series metadata (calibre + EPUB3 collection) and refinements pointing at removed ids
  const collIds = [...opf.matchAll(/<meta\b[^>]*\bproperty="belongs-to-collection"[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  opf = opf.replace(/<meta\b[^>]*?\bproperty="belongs-to-collection"[^>]*?(?:\/>|>[\s\S]*?<\/meta>)/g, '');
  for (const id of [...removedIds, ...collIds]) {
    opf = opf.replace(new RegExp(`<meta\\b[^>]*?\\brefines="#${id}"[^>]*?(?:/>|>[\\s\\S]*?</meta>)`, 'g'), '');
  }
  opf = opf.replace(/<meta\b[^>]*?\bname="calibre:series(?:_index)?"[^>]*?(?:\/>|>\s*<\/meta>)/g, '');

  const lines: string[] = [];
  const title = meta.title ? (meta.subtitle ? `${meta.title}: ${meta.subtitle}` : meta.title) : undefined;
  if (title) lines.push(`<${dc}:title>${esc(title)}</${dc}:title>`);
  for (const a of meta.authors) lines.push(`<${dc}:creator>${esc(a)}</${dc}:creator>`);
  if (meta.publisher) lines.push(`<${dc}:publisher>${esc(meta.publisher)}</${dc}:publisher>`);
  if (meta.year) lines.push(`<${dc}:date>${meta.year}</${dc}:date>`);
  if (meta.description) lines.push(`<${dc}:description>${esc(meta.description)}</${dc}:description>`);
  for (const t of meta.tags) lines.push(`<${dc}:subject>${esc(t)}</${dc}:subject>`);
  if (meta.series) {
    lines.push(`<meta name="calibre:series" content="${esc(meta.series)}"/>`);
    if (meta.seriesIndex != null) lines.push(`<meta name="calibre:series_index" content="${meta.seriesIndex}"/>`);
    if (isV3) {
      lines.push(`<meta property="belongs-to-collection" id="bookflix-series">${esc(meta.series)}</meta>`);
      lines.push(`<meta refines="#bookflix-series" property="collection-type">series</meta>`);
      if (meta.seriesIndex != null)
        lines.push(`<meta refines="#bookflix-series" property="group-position">${meta.seriesIndex}</meta>`);
    }
  }

  if (cover) {
    const pkg = parser.parse(opf)?.package ?? {};
    const existing = findCoverItem(pkg);
    const dir = path.posix.dirname(opfPath);
    if (existing?.href) {
      const full = path.posix.normalize(path.posix.join(dir, decodeURIComponent(existing.href)));
      zip.file(full, cover.data);
    } else {
      const href = `images/bookflix-cover.${cover.ext}`;
      const mime = Object.entries(MIME_EXT).find(([, e]) => e === cover.ext)![0];
      zip.file(path.posix.normalize(path.posix.join(dir, href)), cover.data);
      opf = opf.replace(
        /<\/manifest>/,
        `<item id="bookflix-cover" href="${href}" media-type="${mime}"${isV3 ? ' properties="cover-image"' : ''}/></manifest>`,
      );
      lines.push(`<meta name="cover" content="bookflix-cover"/>`);
    }
  }

  const block = lines.join('\n    ');
  opf = opf.replace(/<\/(\w+:)?metadata>/, (_m, p: string | undefined) => `${block}\n  </${p ?? ''}metadata>`);
  zip.file(opfPath, opf);
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
}
