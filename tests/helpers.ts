import zlib from 'node:zlib';
import JSZip from 'jszip';

export async function makeEpub(
  opts: { title?: string; authors?: string[]; series?: string; index?: number; publisher?: string; year?: number; cover?: boolean; extra?: string; pages?: string[]; language?: string } = {},
) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  const meta = [
    opts.title && `<dc:title>${opts.title}</dc:title>`,
    ...(opts.authors ?? []).map((a) => `<dc:creator opf:role="aut">${a}</dc:creator>`),
    opts.publisher && `<dc:publisher>${opts.publisher}</dc:publisher>`,
    opts.year && `<dc:date>${opts.year}-05-01</dc:date>`,
    `<dc:identifier id="bookid">urn:uuid:1234</dc:identifier>`,
    opts.language !== '' && `<dc:language>${opts.language ?? 'en'}</dc:language>`,
    opts.series && `<meta name="calibre:series" content="${opts.series}"/>`,
    opts.index != null && `<meta name="calibre:series_index" content="${opts.index}"/>`,
    opts.cover && `<meta name="cover" content="cover-img"/>`,
    opts.extra,
  ]
    .filter(Boolean)
    .join('\n');
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata>
${meta}
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    ${(opts.pages ?? []).map((_, i) => `<item id="p${i}" href="p${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}
    ${opts.cover ? '<item id="cover-img" href="cover.png" media-type="image/png"/>' : ''}
  </manifest>
  <spine>${(opts.pages ?? []).map((_, i) => `<itemref idref="p${i}"/>`).join('')}<itemref idref="ch1"/></spine>
</package>`,
  );
  zip.file('OEBPS/ch1.xhtml', '<html><body><p>Hello</p></body></html>');
  (opts.pages ?? []).forEach((html, i) => zip.file(`OEBPS/p${i}.xhtml`, `<html><body>${html}</body></html>`));
  if (opts.cover) zip.file('OEBPS/cover.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
}

/** A valid grayscale PNG (8-bit) of `w` x `h`, each pixel derived from `seed` so different seeds give different bytes. */
export function makePng(w = 6, h = 8, seed = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = (x * 31 + y * 17 + seed * 53) & 255;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
