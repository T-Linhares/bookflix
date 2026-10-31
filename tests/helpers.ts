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
