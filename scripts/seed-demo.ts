/**
 * Builds a throw-away demo: sample EPUBs, a fake Kindle/KOReader folder and a ready database.
 *   npx tsx scripts/seed-demo.ts <demo-dir>
 *   BOOKFLIX_DATA=<demo-dir>/data npm start
 * Never touches the real data/ folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';

const demo = path.resolve(process.argv[2] ?? 'demo');
fs.rmSync(demo, { recursive: true, force: true });
const livros = path.join(demo, 'Livros');
const kindle = path.join(demo, 'kindle');
fs.mkdirSync(livros, { recursive: true });
process.env.BOOKFLIX_DATA = path.join(demo, 'data');

function png(w: number, h: number, hue: number): Buffer {
  const rows: Buffer[] = [];
  const hsl = (hh: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min((n + hh / 30) % 12 - 3, 9 - ((n + hh / 30) % 12), 1));
    return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
  };
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    const [r, g, b] = hsl((hue + (y / h) * 40) % 360, 0.55, 0.32 - (y / h) * 0.18);
    for (let x = 0; x < w; x++) {
      const edge = x < 6 || x > w - 7 ? 14 : 0;
      row[1 + x * 3] = Math.min(255, r + edge);
      row[2 + x * 3] = Math.min(255, g + edge);
      row[3 + x * 3] = Math.min(255, b + edge);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function epub(file: string, b: { title: string; author: string; series?: string; idx?: number; publisher: string; year: number; desc: string; tags: string[]; hue: number }) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0" unique-identifier="id">
<metadata>
<dc:title>${esc(b.title)}</dc:title><dc:creator>${esc(b.author)}</dc:creator><dc:publisher>${esc(b.publisher)}</dc:publisher>
<dc:date>${b.year}</dc:date><dc:language>pt</dc:language><dc:identifier id="id">urn:uuid:${b.title.length}${b.year}</dc:identifier>
<dc:description>${esc(b.desc)}</dc:description>${b.tags.map((t) => `<dc:subject>${t}</dc:subject>`).join('')}
${b.series ? `<meta name="calibre:series" content="${esc(b.series)}"/><meta name="calibre:series_index" content="${b.idx}"/>` : ''}
<meta name="cover" content="cover"/>
</metadata>
<manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.png" media-type="image/png"/></manifest>
<spine><itemref idref="ch1"/></spine></package>`,
  );
  zip.file('OEBPS/ch1.xhtml', `<html><body><p>${esc(b.title)}</p></body></html>`);
  zip.file('OEBPS/cover.png', png(200, 300, b.hue));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' }));
}

const BOOKS = [
  { title: 'O Nome do Vento', author: 'Patrick Rothfuss', series: 'A Crônica do Matador do Rei', idx: 1, publisher: 'Arqueiro', year: 2009, tags: ['Fantasia', 'Magia'], hue: 18, desc: 'Kvothe conta a própria história: de artista itinerante a arcanista lendário e o homem mais temido do reino.' },
  { title: 'O Temor do Sábio', author: 'Patrick Rothfuss', series: 'A Crônica do Matador do Rei', idx: 2, publisher: 'Arqueiro', year: 2011, tags: ['Fantasia', 'Magia'], hue: 28, desc: 'Kvothe segue para a Universidade e depois para a corte, entre intrigas, amores e perigos.' },
  { title: 'O Império Final', author: 'Brandon Sanderson', series: 'Mistborn', idx: 1, publisher: 'Leya', year: 2010, tags: ['Fantasia', 'Épico'], hue: 255, desc: 'Um ladrão e uma jovem alomante tentam derrubar um imperador imortal.' },
  { title: 'O Poço da Ascensão', author: 'Brandon Sanderson', series: 'Mistborn', idx: 2, publisher: 'Leya', year: 2011, tags: ['Fantasia', 'Épico'], hue: 265, desc: 'O império caiu, mas a guerra por Luthadel apenas começou.' },
  { title: 'O Herói das Eras', author: 'Brandon Sanderson', series: 'Mistborn', idx: 3, publisher: 'Leya', year: 2012, tags: ['Fantasia', 'Épico'], hue: 275, desc: 'A profecia final se aproxima e a névoa não deixa ninguém em paz.' },
  { title: 'O Caminho dos Reis', author: 'Brandon Sanderson', series: 'O Arquivo das Tempestades', idx: 1, publisher: 'Leya', year: 2015, tags: ['Fantasia', 'Épico'], hue: 200, desc: 'Em um mundo castigado por tempestades, três destinos se cruzam.' },
  { title: 'Duna', author: 'Frank Herbert', series: 'Duna', idx: 1, publisher: 'Aleph', year: 2017, tags: ['Ficção Científica', 'Clássico'], hue: 42, desc: 'Paul Atreides assume o destino do planeta deserto Arrakis, fonte da especiaria.' },
  { title: 'Messias de Duna', author: 'Frank Herbert', series: 'Duna', idx: 2, publisher: 'Aleph', year: 2017, tags: ['Ficção Científica', 'Clássico'], hue: 36, desc: 'Doze anos depois, o imperador Muad’Dib enfrenta conspirações e o peso da profecia.' },
  { title: 'Fundação', author: 'Isaac Asimov', series: 'Fundação', idx: 1, publisher: 'Aleph', year: 2012, tags: ['Ficção Científica', 'Clássico'], hue: 175, desc: 'A psico-história prevê a queda do Império Galáctico e uma Fundação tenta encurtar a era sombria.' },
  { title: 'Eu, Robô', author: 'Isaac Asimov', publisher: 'Aleph', year: 2014, tags: ['Ficção Científica', 'Contos'], hue: 190, desc: 'Nove contos sobre robôs, as Três Leis e as questões que elas criam.' },
  { title: 'Ensaio sobre a Cegueira', author: 'José Saramago', publisher: 'Companhia das Letras', year: 1995, tags: ['Romance', 'Distopia'], hue: 55, desc: 'Uma epidemia de cegueira branca derruba a ordem social de uma cidade.' },
  { title: 'Sapiens', author: 'Yuval Noah Harari', publisher: 'L&PM', year: 2015, tags: ['História', 'Não ficção'], hue: 8, desc: 'Uma breve história da humanidade, da revolução cognitiva à era digital.' },
  { title: 'Hábitos Atômicos', author: 'James Clear', publisher: 'Alta Books', year: 2019, tags: ['Autoajuda', 'Produtividade'], hue: 140, desc: 'Pequenas mudanças diárias que geram resultados extraordinários.' },
  { title: 'O Hobbit', author: 'J. R. R. Tolkien', publisher: 'HarperCollins', year: 2019, tags: ['Fantasia', 'Clássico'], hue: 100, desc: 'Bilbo Bolseiro parte numa aventura inesperada com treze anões e um mago.' },
];

for (const b of BOOKS) {
  await epub(path.join(livros, b.author, ...(b.series ? [b.series] : []), `${b.author} - ${b.title}.epub`), b);
}

const { updateSettings } = await import('../server/settings.ts');
const { scanLibrary } = await import('../server/library.ts');
const { importFromKindle } = await import('../server/kindle/import.ts');
const { partialMd5 } = await import('../server/util.ts');
const { db } = await import('../server/db.ts');

updateSettings({ booksDir: livros, yearlyGoal: 12 });
console.log('scan:', await scanLibrary());

// fake KOReader data: some finished, one in progress, with highlights and reading sessions
const docs = path.join(kindle, 'documents');
fs.mkdirSync(docs, { recursive: true });
const stats = new DatabaseSync((fs.mkdirSync(path.join(kindle, 'koreader', 'settings'), { recursive: true }), path.join(kindle, 'koreader', 'settings', 'statistics.sqlite3')));
stats.exec(`create table book(id integer primary key, title text, authors text, notes integer, last_open integer, highlights integer, pages integer, series text, language text, md5 text, total_read_time integer, total_read_pages integer);
create table page_stat_data(id_book integer, page integer, start_time integer, duration integer, total_pages integer);`);

const plan: { title: string; status: string; pct: number; rating?: number; review?: string; finished?: string; quotes: [string, string?][] }[] = [
  { title: 'O Nome do Vento', status: 'complete', pct: 1, rating: 5, review: 'Prosa linda e um protagonista inesquecível.', finished: '2026-02-14', quotes: [['Há três coisas que todo homem sábio teme: o mar em tempestade, a noite sem lua e a ira de um homem gentil.', 'Minha frase favorita do livro.'], ['É a música que tece as histórias.']] },
  { title: 'O Temor do Sábio', status: 'complete', pct: 1, rating: 4, finished: '2026-04-02', quotes: [['Um bom nome é um bom começo.']] },
  { title: 'O Império Final', status: 'complete', pct: 1, rating: 5, review: 'O sistema de magia mais criativo que li.', finished: '2026-06-20', quotes: [['Sempre existe mais um segredo.', 'Ótimo gancho para o resto da série.'], ['A esperança é o que nos mantém de pé.']] },
  { title: 'Duna', status: 'complete', pct: 1, rating: 5, finished: '2026-09-05', quotes: [['O medo é o assassino da mente.', 'Litania contra o medo.']] },
  { title: 'Fundação', status: 'complete', pct: 1, rating: 4, finished: '2026-10-01', quotes: [['A violência é o último refúgio do incompetente.']] },
  { title: 'O Poço da Ascensão', status: 'reading', pct: 0.46, quotes: [['Nem toda mudança é para pior.', 'Reler depois do final.']] },
  { title: 'Sapiens', status: 'reading', pct: 0.18, quotes: [] },
];

let id = 0;
const days = [] as { d: Date; mins: number }[];
for (let i = 0; i < 200; i++) {
  const d = new Date();
  d.setDate(d.getDate() - i);
  if (i < 12 || Math.sin(i * 1.7) > -0.2) days.push({ d, mins: 15 + Math.round(Math.abs(Math.sin(i * 2.3)) * 70) });
}
const rows = db.prepare('select id, path, title, authors from books').all() as any[];
for (const p of plan) {
  const row = rows.find((r) => r.title === p.title)!;
  const target = path.join(docs, path.basename(row.path));
  fs.copyFileSync(row.path, target);
  const md5 = await partialMd5(target);
  const q = p.quotes
    .map(([text, note], n) => `[${n + 1}] = { ["chapter"] = "Capítulo ${n + 1}", ["datetime"] = "2026-0${(n % 8) + 2}-1${n} 21:0${n}:00", ["drawer"] = "lighten", ["pageno"] = ${20 + n * 31}, ["text"] = ${JSON.stringify(text)}${note ? `, ["note"] = ${JSON.stringify(note)}` : ''} },`)
    .join('\n');
  const dir = `${target}.sdr`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'metadata.epub.lua'),
    `return {\n["annotations"] = {\n${q}\n},\n["doc_pages"] = 320,\n["doc_props"] = { ["authors"] = ${JSON.stringify(row.authors)}, ["title"] = ${JSON.stringify(p.title)} },\n["partial_md5_checksum"] = "${md5}",\n["percent_finished"] = ${p.pct},\n["summary"] = { ["modified"] = "${p.finished ?? '2026-10-20'}", ${p.review ? `["note"] = ${JSON.stringify(p.review)}, ` : ''}${p.rating ? `["rating"] = ${p.rating}, ` : ''}["status"] = "${p.status}" },\n}`,
  );
  id++;
  stats.prepare('insert into book(id, title, authors, md5, last_open, pages, total_read_time, total_read_pages) values(?,?,?,?,?,?,?,?)').run(id, p.title, row.authors, md5, Math.floor(Date.now() / 1000), 320, 0, 0);
}
// spread reading sessions over the books in order
const ins = stats.prepare('insert into page_stat_data values(?,?,?,?,320)');
days.reverse().forEach((day, n) => {
  const book = Math.min(plan.length, 1 + Math.floor((n / days.length) * plan.length));
  const start = Math.floor(day.d.setHours(21, 0, 0, 0) / 1000);
  for (let m = 0; m < day.mins; m++) ins.run(book, ((n * 7 + m) % 320) + 1, start + m * 60, 60);
});
stats.exec('update book set total_read_time = (select coalesce(sum(duration),0) from page_stat_data where id_book = book.id)');
stats.close();

console.log('kindle import:', await importFromKindle(kindle));
console.log(`\nDemo pronta em ${demo}\nSubir:  BOOKFLIX_DATA="${path.join(demo, 'data')}" npm start`);
