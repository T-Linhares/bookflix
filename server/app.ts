import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { COVERS_DIR, WEB_DIST, clean, db, getBook, parseBook, reindexBook } from './db.ts';
import { SECRET_KEYS, anthropicKey, geminiKey, getSettings, openaiKey, updateSettings } from './settings.ts';
import { secretsProtected } from './secrets.ts';
import { testAiKey } from './metadata/generate.ts';
import { enableSync, disableSync, runSync, scheduleSync, syncStatus } from './syncService.ts';
import { APP_VERSION, getRepo } from './version.ts';
import { checkForUpdate } from './versionCheck.ts';
import { CloudFolders, detectCloudFolders } from './cloudFolders.ts';
import { listBooks, parseFilters, facets, homeRows } from './query.ts';
import { scanLibrary, watchLibrary } from './library.ts';
import {
  commitStaging, discardStaging, listHistory, listStaging, lookupForStaging, previewCommit, stageExistingBook, stageUpload, undoHistory, watchInbox, getStaging,
} from './ingest.ts';
import { importFromKindle, linkUnmatched } from './kindle/import.ts';
import { detectKindle, readyBookIds, sendToKindle } from './kindle/send.ts';
import { planRemoval, removeFromKindle } from './kindle/remove.ts';
import { dismissRecommendation, recommendationsFor } from './recommend.ts';
import { testGoogleKey } from './metadata/providers.ts';
import { dashboard } from './dashboard.ts';
import { now } from './util.ts';
import { isBookFile } from './util.ts';

const num = (v: unknown) => Number(v);

const MASK = '••••';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** "localhost:3000" -> "localhost"; anything unparsable -> null */
function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

export interface AppOptions {
  /** when set, every request must carry it in `x-bookflix-token` (the desktop shell injects it) */
  token?: string;
  /** where the Dropbox / Drive folders are; tests inject a fake */
  cloudFolders?: () => CloudFolders;
}

export async function buildApp({ token, cloudFolders = detectCloudFolders }: AppOptions = {}) {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 20 * 1024 * 1024 });

  // The API can read the disk and write to the Kindle, so no web page may drive it. No CORS plugin on purpose:
  // browsers only reach it same-origin. Host/Origin checks stop other sites and DNS-rebinding; the token (desktop) stops
  // any other local program that does not know it.
  app.addHook('onRequest', async (req, reply) => {
    const host = hostnameOf(String(req.headers.host ?? ''));
    const origin = req.headers.origin;
    const originHost = origin ? hostnameOf(String(origin).replace(/^[a-z]+:\/\//i, '')) : null;
    const hostOk = host !== null && LOOPBACK.has(host);
    const originOk = !origin || (originHost !== null && LOOPBACK.has(originHost));
    const given = String(req.headers['x-bookflix-token'] ?? '');
    const tokenOk = !token || (given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token)));
    if (!hostOk || !originOk || !tokenOk) return reply.code(403).send({ error: 'Acesso negado' });
  });

  // anything the user changed gets synced soon after (debounced; does nothing while sync is off)
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && req.url.startsWith('/api/') && !req.url.startsWith('/api/sync') && reply.statusCode < 400) scheduleSync();
  });

  await app.register(multipart, { limits: { fileSize: 800 * 1024 * 1024, files: 50 } });
  await app.register(fastifyStatic, { root: COVERS_DIR, prefix: '/covers/', decorateReply: false, maxAge: '1h' });

  app.setErrorHandler((err: any, _req, reply) => {
    const msg = String(err?.message ?? err);
    if (err?.name === 'SyncError') return reply.code(409).send({ code: err.code, error: msg });
    if (msg === 'KINDLE_SENT') return reply.code(409).send({ code: 'KINDLE_SENT', error: 'Livro já enviado ao Kindle.' });
    if (msg === 'NOT_EPUB') return reply.code(409).send({ code: 'NOT_EPUB', error: 'Este arquivo não é um EPUB.' });
    if (msg === 'DUPLICATE') return reply.code(409).send({ code: 'DUPLICATE', error: 'Já existe um livro igual na biblioteca.' });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: msg });
    app.log.error(err);
    return reply.code(500).send({ error: msg });
  });

  // ---------- settings ----------
  app.get('/api/settings', async () => {
    const s = getSettings();
    const masked = Object.fromEntries(SECRET_KEYS.map((k) => [k, s[k] ? MASK : '']));
    return { ...s, ...masked, secretsEncrypted: secretsProtected() };
  });
  app.put('/api/settings', async (req) => {
    const body = { ...(req.body as any) };
    delete body.secretsEncrypted;
    for (const k of SECRET_KEYS) if (body[k] === MASK) delete body[k];
    for (const k of ['booksDir', 'inboxDir']) {
      if (body[k] && !fs.existsSync(body[k])) throw Object.assign(new Error(`Pasta não encontrada: ${body[k]}`), { statusCode: 400 });
    }
    const s = updateSettings(body);
    watchLibrary();
    watchInbox();
    void scanLibrary().catch(() => {});
    return s;
  });

  // checks the Google Books key (typed in Ajustes, or the saved one) with a known ISBN
  app.post('/api/settings/test-google', async (req) => {
    const typed = String((req.body as any)?.key ?? '');
    return testGoogleKey(typed && typed !== MASK ? typed : undefined);
  });

  // ---------- sync between devices (see sync.ts) ----------
  app.get('/api/sync', async () => syncStatus());
  app.post('/api/sync/enable', async (req) => {
    const mode: unknown = (req.body as any)?.mode;
    if (mode !== 'create' && mode !== 'join') throw Object.assign(new Error('Modo inválido'), { statusCode: 400 });
    return enableSync(mode);
  });
  app.post('/api/sync/disable', async () => (disableSync(), { ok: true }));
  app.post('/api/sync/now', async () => runSync());

  // ---------- about / updates / cloud folders ----------
  app.get('/api/about', async () => ({ version: APP_VERSION, repo: getRepo(), platform: process.platform, arch: process.arch }));
  // a notice only: the app never downloads or installs anything by itself
  app.get('/api/update-check', async () => ({ update: await checkForUpdate({ current: APP_VERSION, repo: getRepo(), enabled: getSettings().checkUpdates }) }));
  app.get('/api/cloud-folders', async () => cloudFolders());
  // the only place the server creates a folder on its own: "Livros" inside the Dropbox / Drive folder it detected
  app.post('/api/cloud-folders/library', async (req) => {
    const service: unknown = (req.body as any)?.service;
    if (service !== 'dropbox' && service !== 'drive') throw Object.assign(new Error('Serviço desconhecido'), { statusCode: 400 });
    const root = cloudFolders()[service];
    if (!root) throw Object.assign(new Error(`Não encontrei a pasta do ${service === 'dropbox' ? 'Dropbox' : 'Google Drive'} neste computador. O aplicativo dele está instalado e conectado? Se não, escolha a pasta manualmente.`), { statusCode: 400 });
    const dir = path.join(root, 'Livros');
    fs.mkdirSync(dir, { recursive: true });
    return { path: dir };
  });

  // checks a Gemini / Anthropic / OpenAI key (typed in Ajustes, or the saved one) with a one-line prompt
  app.post('/api/settings/test-ai', async (req) => {
    const { provider, key } = req.body as { provider?: string; key?: string };
    if (provider !== 'gemini' && provider !== 'anthropic' && provider !== 'openai') throw Object.assign(new Error('Provedor desconhecido'), { statusCode: 400 });
    const saved = { gemini: geminiKey, anthropic: anthropicKey, openai: openaiKey }[provider]();
    const k = key && key !== MASK ? key : saved;
    if (!k) return { ok: false, message: 'Nenhuma chave informada.' };
    return testAiKey(provider, k);
  });

  // ---------- library ----------
  app.post('/api/library/scan', async () => scanLibrary());
  app.get('/api/home', async () => homeRows());
  app.get('/api/facets', async () => facets());
  app.get('/api/books', async (req) => listBooks(parseFilters(req.query as any)));

  app.get('/api/books/:id', async (req, reply) => {
    const b = getBook(num((req.params as any).id));
    if (!b) return reply.code(404).send({ error: 'Livro não encontrado' });
    const highlights = db.prepare('select * from highlights where book_id = ? and deleted = 0 order by coalesce(created_at, \'\'), id').all(b.id);
    const days = db.prepare('select day, seconds, pages from reading_days where book_id = ? order by day').all(b.id);
    return { ...b, highlights, days };
  });

  app.patch('/api/books/:id', async (req) => {
    const id = num((req.params as any).id);
    const b = getBook(id);
    if (!b) throw Object.assign(new Error('Livro não encontrado'), { statusCode: 404 });
    const body = req.body as any;
    const edited = new Set(b.edited_fields);
    const sets: string[] = [];
    const p: Record<string, unknown> = { id };
    if ('status' in body && ['unread', 'reading', 'read', 'abandoned'].includes(body.status)) {
      sets.push('status = :status');
      p.status = body.status;
      edited.add('status');
      if (body.status === 'read' && !b.finished_at) (sets.push('finished_at = :fin'), (p.fin = now()));
      if (body.status === 'read') (sets.push('progress = 1'));
    }
    if ('rating' in body) {
      const r = body.rating === null ? null : Math.max(0, Math.min(5, Math.round(Number(body.rating)))) || null;
      sets.push('rating = :rating');
      p.rating = r;
      edited.add('rating');
    }
    if ('review' in body) {
      sets.push('review = :review');
      p.review = body.review || null;
      edited.add('review');
    }
    if (!sets.length) return getBook(id);
    sets.push('edited_fields = :ef');
    p.ef = JSON.stringify([...edited]);
    db.prepare(`update books set ${sets.join(', ')} where id = :id`).run(clean(p));
    return getBook(id);
  });

  app.get('/api/books/:id/recommendations', async (req) =>
    recommendationsFor(num((req.params as any).id), (req.query as any).refresh === '1'),
  );

  app.get('/api/books/:id/export.md', async (req, reply) => {
    const b = getBook(num((req.params as any).id));
    if (!b) return reply.code(404).send({ error: 'Livro não encontrado' });
    const hs = db.prepare('select * from highlights where book_id = ? and deleted = 0 order by coalesce(created_at, \'\'), id').all(b.id) as any[];
    const lines = [`# ${b.title}`, `**${b.authors}**${b.series ? ` · ${b.series}${b.series_index != null ? ` #${b.series_index}` : ''}` : ''}`, ''];
    if (b.rating) lines.push(`Nota: ${'★'.repeat(b.rating)}${'☆'.repeat(5 - b.rating)}`, '');
    if (b.review) lines.push('## Resenha', '', b.review, '');
    lines.push('## Destaques e notas', '');
    for (const h of hs) {
      lines.push(`> ${(h.text ?? '').replace(/\n+/g, ' ')}`);
      if (h.note) lines.push('', `**Nota:** ${h.note}`);
      lines.push('', `*${[h.chapter, h.page && `p. ${h.page}`, h.created_at].filter(Boolean).join(' · ')}*`, '');
    }
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(b.title ?? 'livro')}.md"`);
    return lines.join('\n');
  });

  // ---------- highlights ----------
  app.post('/api/books/:id/highlights', async (req) => {
    const id = num((req.params as any).id);
    const { text, note, chapter } = req.body as any;
    const res = db
      .prepare("insert into highlights(book_id, uid, kind, text, note, chapter, created_at, source, edited) values(?,?,?,?,?,?,?, 'user', 1)")
      .run(id, crypto.randomUUID(), note ? 'note' : 'highlight', text ?? '', note ?? null, chapter ?? null, new Date().toISOString().slice(0, 19).replace('T', ' '));
    reindexBook(id);
    return db.prepare('select * from highlights where id = ?').get(Number(res.lastInsertRowid));
  });
  app.patch('/api/highlights/:id', async (req) => {
    const id = num((req.params as any).id);
    const { text, note } = req.body as any;
    const h = db.prepare('select * from highlights where id = ?').get(id) as any;
    if (!h) throw Object.assign(new Error('Não encontrado'), { statusCode: 404 });
    db.prepare('update highlights set text = ?, note = ?, kind = ?, edited = 1 where id = ?').run(text ?? h.text, note ?? null, note ? 'note' : 'highlight', id);
    reindexBook(h.book_id);
    return db.prepare('select * from highlights where id = ?').get(id);
  });
  app.delete('/api/highlights/:id', async (req) => {
    const id = num((req.params as any).id);
    const h = db.prepare('select * from highlights where id = ?').get(id) as any;
    if (!h) return { ok: true };
    // Always hidden, never erased: a Kindle import would bring Kindle rows back, and the sync needs the deletion to travel
    db.prepare('update highlights set deleted = 1, edited = 1 where id = ?').run(id);
    reindexBook(h.book_id);
    return { ok: true };
  });

  app.post('/api/recommendations/dismiss', async (req) => {
    const { title, author } = req.body as { title: string; author?: string };
    dismissRecommendation(title, author);
    return { ok: true };
  });

  // ---------- wishlist / saved filters ----------
  app.post('/api/wishlist', async (req) => {
    const r = req.body as any;
    db.prepare('insert or ignore into wishlist(key, title, authors, isbn, cover_url, description, link, year, added_at) values(?,?,?,?,?,?,?,?,?)').run(
      r.key, r.title, (r.authors ?? []).join('; '), r.isbn ?? null, r.coverUrl ?? null, r.description ?? null, r.link ?? null, r.year ?? null, now(),
    );
    return { ok: true };
  });
  app.delete('/api/wishlist/:key', async (req) => {
    db.prepare('delete from wishlist where key = ?').run(decodeURIComponent((req.params as any).key));
    return { ok: true };
  });
  app.get('/api/saved-filters', async () => db.prepare('select * from saved_filters').all());
  app.post('/api/saved-filters', async (req) => {
    const { name, query } = req.body as any;
    const res = db.prepare('insert into saved_filters(name, query) values(?,?)').run(name, query);
    return { id: Number(res.lastInsertRowid) };
  });
  app.delete('/api/saved-filters/:id', async (req) => {
    db.prepare('delete from saved_filters where id = ?').run(num((req.params as any).id));
    return { ok: true };
  });

  // ---------- ingest ----------
  app.get('/api/ingest', async () => listStaging());
  app.post('/api/ingest/upload', async (req) => {
    const out = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (!isBookFile(part.filename)) continue;
      out.push(await stageUpload(part.filename, await part.toBuffer()));
    }
    return out;
  });
  app.post('/api/ingest/from-library/:bookId', async (req) => stageExistingBook(num((req.params as any).bookId)));
  app.get('/api/ingest/:id', async (req, reply) => getStaging(num((req.params as any).id)) ?? reply.code(404).send({ error: 'Item não encontrado' }));
  app.post('/api/ingest/:id/lookup', async (req) => lookupForStaging(num((req.params as any).id), (req.body as any) ?? {}));
  app.post('/api/ingest/:id/preview', async (req) => previewCommit(num((req.params as any).id), (req.body as any).meta ?? {}));
  app.post('/api/ingest/:id/commit', async (req) => commitStaging(num((req.params as any).id), req.body as any));
  app.delete('/api/ingest/:id', async (req) => {
    await discardStaging(num((req.params as any).id));
    return { ok: true };
  });
  app.get('/api/history', async () => listHistory());
  app.post('/api/history/:id/undo', async (req) => {
    await undoHistory(num((req.params as any).id));
    return { ok: true };
  });

  // ---------- kindle ----------
  app.post('/api/kindle/import', async (req) => {
    const root = String((req.body as any)?.path ?? '') || detectKindle();
    if (!root) throw Object.assign(new Error('Kindle não encontrado. Conecte-o por USB ou informe a unidade (ex.: E:\\).'), { statusCode: 400 });
    return importFromKindle(root);
  });
  app.get('/api/kindle/detect', async () => ({ root: detectKindle(), ready: readyBookIds().length }));
  app.post('/api/kindle/send', async (req) => {
    const body = (req.body ?? {}) as { bookIds?: unknown[]; path?: string; allReady?: boolean };
    const ids = body.allReady ? readyBookIds() : (body.bookIds ?? []).map(num).filter(Number.isFinite);
    if (!ids.length) throw Object.assign(new Error('Nenhum livro para enviar.'), { statusCode: 400 });
    return sendToKindle(ids, body.path || undefined);
  });
  app.get('/api/kindle/unmatched', async () => db.prepare('select * from unmatched where ignored = 0 order by id desc').all());
  app.get('/api/kindle/unmatched/ignored-count', async () => ({ count: (db.prepare('select count(*) c from unmatched where ignored = 1').get() as { c: number }).c }));
  app.post('/api/kindle/unmatched/:id/link', async (req) => linkUnmatched(num((req.params as any).id), num((req.body as any).bookId)));
  /** Hides rows (they are kept as "ignored" so the next import does not recreate them). */
  app.post('/api/kindle/unmatched/ignore', async (req) => {
    const ids = (((req.body as any)?.ids ?? []) as unknown[]).map(num).filter(Number.isInteger);
    if (!ids.length) throw Object.assign(new Error('Nenhum item selecionado.'), { statusCode: 400 });
    const r = db.prepare(`update unmatched set ignored = 1 where id in (${ids.map(() => '?').join(',')})`).run(...ids);
    return { ok: true, hidden: Number(r.changes) };
  });
  const idList = (body: any) => ((body?.ids ?? []) as unknown[]).map(num).filter(Number.isInteger);
  /** Dry run: lists the files that "remove" would delete from the Kindle. */
  app.post('/api/kindle/unmatched/remove-preview', async (req) => {
    const ids = idList(req.body);
    if (!ids.length) throw Object.assign(new Error('Nenhum item selecionado.'), { statusCode: 400 });
    return planRemoval(ids);
  });
  app.post('/api/kindle/unmatched/remove', async (req) => {
    const ids = idList(req.body);
    if (!ids.length) throw Object.assign(new Error('Nenhum item selecionado.'), { statusCode: 400 });
    if ((req.body as any)?.confirm !== true) throw Object.assign(new Error('Confirmação necessária para apagar do Kindle.'), { statusCode: 400 });
    return removeFromKindle(ids);
  });
  app.post('/api/kindle/unmatched/restore', async () => {
    const r = db.prepare('update unmatched set ignored = 0 where ignored = 1').run();
    return { ok: true, restored: Number(r.changes) };
  });
  app.delete('/api/kindle/unmatched/:id', async (req) => {
    db.prepare('update unmatched set ignored = 1 where id = ?').run(num((req.params as any).id));
    return { ok: true };
  });

  app.get('/api/dashboard', async (req) => dashboard(num((req.query as any).year) || undefined));

  // ---------- built web app (production) ----------
  const dist = WEB_DIST;
  if (fs.existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', decorateReply: true });
    app.setNotFoundHandler((req, reply) => {
      // a missing cover must not come back as the app's HTML with a 200
      if (req.url.startsWith('/api/') || req.url.startsWith('/covers/')) return reply.code(404).send({ error: 'Rota não encontrada' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}

export { parseBook };
