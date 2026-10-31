import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp: string;
let kindle: string;
let send: typeof import('../server/kindle/send.ts');
let db: typeof import('../server/db.ts').db;

function addBook(name: string, content: string, organized = 1): number {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  const r = db.prepare('insert into books(path, filename, format, size, title, organized, added_at) values(?,?,?,?,?,?,?)').run(p, name, 'epub', content.length, name, organized, Date.now());
  return Number(r.lastInsertRowid);
}
const sent = (id: number) => (db.prepare('select sent_to_kindle s from books where id = ?').get(id) as { s: number }).s;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-send-'));
  kindle = path.join(tmp, 'kindle');
  fs.mkdirSync(path.join(kindle, 'documents'), { recursive: true });
  fs.mkdirSync(path.join(kindle, 'system'));
  send = await import('../server/kindle/send.ts');
  db = (await import('../server/db.ts')).db;
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('send to Kindle', () => {
  it('recognizes a Kindle root', () => {
    expect(send.isKindleRoot(kindle)).toBe(true);
    expect(send.isKindleRoot(tmp)).toBe(false);
  });

  it('copies into documents/Livros, creating it, and marks the book as sent', async () => {
    const id = addBook('Autor - Um.epub', 'one');
    const r = await send.sendToKindle([id], kindle);
    expect(r.copied).toEqual(['Autor - Um.epub']);
    expect(fs.readFileSync(path.join(kindle, 'documents', 'Livros', 'Autor - Um.epub'), 'utf8')).toBe('one');
    expect(sent(id)).toBe(1);
  });

  it('reuses an existing folder regardless of case and does not copy twice', async () => {
    fs.renameSync(path.join(kindle, 'documents', 'Livros'), path.join(kindle, 'documents', 'livros'));
    const again = addBook('Autor - Dois.epub', 'two');
    const r = await send.sendToKindle([again], kindle);
    expect(r.dest.endsWith('livros')).toBe(true);
    expect(fs.existsSync(path.join(kindle, 'documents', 'Livros', 'Autor - Dois.epub'))).toBe(true);
    const repeat = await send.sendToKindle([again], kindle);
    expect(repeat.copied).toEqual([]);
    expect(repeat.already).toEqual(['Autor - Dois.epub']);
  });

  it('never overwrites a different file with the same name', async () => {
    const id = addBook('Autor - Tres.epub', 'new version');
    fs.writeFileSync(path.join(kindle, 'documents', 'livros', 'Autor - Tres.epub'), 'old');
    const r = await send.sendToKindle([id], kindle);
    expect(r.conflicts).toEqual(['Autor - Tres.epub']);
    expect(fs.readFileSync(path.join(kindle, 'documents', 'livros', 'Autor - Tres.epub'), 'utf8')).toBe('old');
    expect(sent(id)).toBe(0);
  });

  it('reports a missing file instead of failing the whole batch', async () => {
    const gone = addBook('Autor - Sumiu.epub', 'x');
    fs.rmSync(path.join(tmp, 'Autor - Sumiu.epub'));
    const ok = addBook('Autor - Quatro.epub', 'four');
    const r = await send.sendToKindle([gone, ok], kindle);
    expect(r.failed.map((f) => f.id)).toEqual([gone]);
    expect(r.copied).toEqual(['Autor - Quatro.epub']);
  });

  it('refuses a drive that has no documents folder', async () => {
    await expect(send.sendToKindle([1], tmp)).rejects.toThrow(/documents/);
  });

  it('lists only organized books that were never sent', () => {
    const ready = addBook('Autor - Pronto.epub', 'r');
    const notOrganized = addBook('Autor - Cru.epub', 'c', 0);
    const ids = send.readyBookIds();
    expect(ids).toContain(ready);
    expect(ids).not.toContain(notOrganized);
  });
});
