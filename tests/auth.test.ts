import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TOKEN = 'test-token-123';
let app: FastifyInstance;
let open: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import('../server/app.ts');
  app = await buildApp({ token: TOKEN });
  open = await buildApp();
  await app.ready();
  await open.ready();
});

afterAll(async () => {
  await app.close();
  await open.close();
});

describe('API token (T3)', () => {
  it.each(['/api/settings', '/api/books', '/api/facets', '/covers/x.jpg'])('rejects %s without the token', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(403);
  });

  it('accepts the right token and rejects a wrong one', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/facets', headers: { 'x-bookflix-token': TOKEN } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'GET', url: '/api/facets', headers: { 'x-bookflix-token': 'nope' } });
    expect(bad.statusCode).toBe(403);
    const missingCover = await app.inject({ method: 'GET', url: '/covers/x.jpg', headers: { 'x-bookflix-token': TOKEN } });
    expect(missingCover.statusCode).toBe(404);
  });

  it('answers a foreign Origin with 403 and never with CORS headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not leak the settings body on rejection', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.body).not.toMatch(/booksDir|geminiKey/);
  });
});

describe('without a token configured (dev / npm start)', () => {
  it('still refuses cross-site pages and DNS-rebinding hosts', async () => {
    const foreign = await open.inject({ method: 'GET', url: '/api/settings', headers: { origin: 'https://evil.example' } });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    const rebinding = await open.inject({ method: 'GET', url: '/api/settings', headers: { host: 'evil.example' } });
    expect(rebinding.statusCode).toBe(403);
  });

  it('allows loopback origins and requests without Origin', async () => {
    const local = await open.inject({ method: 'GET', url: '/api/settings', headers: { origin: 'http://localhost:5173', host: 'localhost:3000' } });
    expect(local.statusCode).toBe(200);
    const none = await open.inject({ method: 'GET', url: '/api/settings' });
    expect(none.statusCode).toBe(200);
  });
});

describe('server-side folder browser removed (T4)', () => {
  it.each([
    ['GET', '/api/fs/roots'],
    ['GET', '/api/fs/list'],
    ['POST', '/api/fs/mkdir'],
  ])('%s %s is gone', async (method, url) => {
    const res = await app.inject({ method: method as 'GET' | 'POST', url, headers: { 'x-bookflix-token': TOKEN }, payload: method === 'POST' ? { path: '/tmp/x' } : undefined });
    expect(res.statusCode).toBe(404);
  });
});
