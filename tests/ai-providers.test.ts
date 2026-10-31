import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let settings: typeof import('../server/settings.ts');
let gen: typeof import('../server/metadata/generate.ts');
let calls: { url: string; init: RequestInit }[];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const openaiOk = (content: string) => json({ choices: [{ message: { content } }] });
const geminiOk = (text: string) => json({ candidates: [{ content: { parts: [{ text }] } }] });
const anthropicOk = (text: string) => json({ content: [{ text }] });
const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

function stubFetch(route: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return route(String(url));
    }),
  );
}

const book = { title: 'O Livro', authors: ['Fulano'], tags: [] as string[] };
const ask = () => gen.generateMissing(book, new Set(['description', 'tags']));

beforeEach(async () => {
  calls = [];
  settings = await import('../server/settings.ts');
  gen = await import('../server/metadata/generate.ts');
  settings.updateSettings({ geminiKey: '', anthropicKey: '', openaiKey: '', aiOrder: 'auto' });
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
  settings.updateSettings({ geminiKey: '', anthropicKey: '', openaiKey: '', aiOrder: 'auto' });
});

describe('OpenAI provider (T6)', () => {
  it('calls api.openai.com with the bearer key and turns the JSON answer into description + tags', async () => {
    settings.updateSettings({ openaiKey: 'sk-test-123' });
    stubFetch(() => openaiOk('{"description":"Uma sinopse.","tags":["fantasia","aventura"]}'));

    const r = await ask();

    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith('https://api.openai.com/')).toBe(true);
    expect(header(calls[0].init, 'authorization')).toBe('Bearer sk-test-123');
    expect(r.viaAi).toBe(true);
    expect(r.description).toBe('Uma sinopse.');
    expect(r.tags).toEqual(['fantasia', 'aventura']);
  });

  it('reads the key from OPENAI_API_KEY when Ajustes has none', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    stubFetch(() => openaiOk('{"description":"x","tags":["a"]}'));
    await ask();
    expect(header(calls[0].init, 'authorization')).toBe('Bearer sk-env');
  });
});

describe('provider order and fallback (T7)', () => {
  it('tries the preferred provider first and falls through on 401 without leaking the key', async () => {
    settings.updateSettings({ openaiKey: 'sk-secret-AAA', geminiKey: 'gem-secret-BBB', aiOrder: 'openai' });
    stubFetch((url) =>
      url.includes('api.openai.com') ? json({ error: { message: 'Incorrect API key provided: sk-secret-AAA' } }, 401) : geminiOk('{"description":"Da Gemini","tags":["x"]}'),
    );

    const r = await ask();

    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['api.openai.com', 'generativelanguage.googleapis.com']);
    expect(r.viaAi).toBe(true);
    expect(r.description).toBe('Da Gemini');
    const err = gen.getLastAiError() ?? '';
    expect(err).toMatch(/openai/i);
    expect(err).toMatch(/401/);
    expect(err).not.toContain('sk-secret-AAA');
    expect(err).not.toContain('gem-secret-BBB');
  });

  it('defaults to Gemini, then Anthropic, then OpenAI when the order is "auto"', async () => {
    settings.updateSettings({ openaiKey: 'o', geminiKey: 'g', anthropicKey: 'a' });
    stubFetch((url) => (url.includes('generativelanguage') ? geminiOk('{"description":"g","tags":["t"]}') : openaiOk('{}')));
    await ask();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('generativelanguage');
  });

  it('still works with only an Anthropic key', async () => {
    settings.updateSettings({ anthropicKey: 'sk-ant' });
    stubFetch(() => anthropicOk('{"description":"da Claude","tags":["t"]}'));
    const r = await ask();
    expect(new URL(calls[0].url).hostname).toBe('api.anthropic.com');
    expect(header(calls[0].init, 'x-api-key')).toBe('sk-ant');
    expect(r.description).toBe('da Claude');
  });

  it('with no key at all: no network call, aiAvailable() is false and the heuristic text is used', async () => {
    stubFetch(() => json({}));
    expect(settings.aiAvailable()).toBe(false);
    const r = await ask();
    expect(calls).toHaveLength(0);
    expect(r.viaAi).toBe(false);
    expect(r.description).toMatch(/Sinopse não encontrada/);
  });

  it('counts an OpenAI key as an available model', () => {
    settings.updateSettings({ openaiKey: 'sk-x' });
    expect(settings.aiAvailable()).toBe(true);
  });
});
