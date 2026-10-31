import { Meta } from '../formats/types.ts';
import { saneSeriesIndex, splitSeriesFromTitle } from '../formats/filename.ts';
import { AiProvider, aiAvailable, anthropicKey, geminiKey, getSettings, openaiKey } from '../settings.ts';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
// Not verified against the live API from here: override with OPENAI_MODEL if OpenAI retires this one.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const TIMEOUT = AbortSignal.timeout.bind(AbortSignal, 20000);

/** Each provider returns the model's text, or null when it answered but with nothing usable. HTTP errors throw "<status>". */
const PROVIDERS: Record<AiProvider, { key: () => string; ask: (key: string, prompt: string) => Promise<string | null> }> = {
  gemini: {
    key: geminiKey,
    async ask(key, prompt) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
        signal: TIMEOUT(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as any).candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    },
  },
  anthropic: {
    key: anthropicKey,
    async ask(key, prompt) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
        signal: TIMEOUT(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as any).content?.[0]?.text ?? null;
    },
  },
  openai: {
    key: openaiKey,
    async ask(key, prompt) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
        signal: TIMEOUT(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as any).choices?.[0]?.message?.content ?? null;
    },
  },
};

const DEFAULT_ORDER: AiProvider[] = ['gemini', 'anthropic', 'openai'];

let lastError: string | null = null;
/** Why the last model call failed, for the UI: provider and HTTP status only, never the provider's message (it may echo the key). */
export const getLastAiError = () => lastError;

/** Preferred provider first (when set in Ajustes), then the default order; only providers that have a key. */
function providerOrder(): AiProvider[] {
  const first = getSettings().aiOrder;
  const order = first === 'auto' ? DEFAULT_ORDER : [first, ...DEFAULT_ORDER.filter((p) => p !== first)];
  return order.filter((p) => PROVIDERS[p].key());
}

/** Plain-text answer from the first configured model that works. Null when none answers. */
export async function askModel(prompt: string): Promise<string | null> {
  lastError = null;
  for (const name of providerOrder()) {
    try {
      const text = await PROVIDERS[name].ask(PROVIDERS[name].key(), prompt);
      if (text) return text;
      lastError = `${name}: resposta vazia`;
    } catch (e: any) {
      lastError = `${name}: ${/^HTTP \d+$/.test(String(e?.message)) ? e.message : 'sem conexão'}`;
    }
  }
  return null;
}

/** For the "testar chave" button in Ajustes. */
export async function testAiKey(provider: AiProvider, key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const text = await PROVIDERS[provider].ask(key, 'Responda somente com o JSON {"ok": true}');
    return text ? { ok: true, message: 'Chave válida.' } : { ok: false, message: 'O serviço respondeu sem conteúdo.' };
  } catch (e: any) {
    const m = String(e?.message);
    if (m === 'HTTP 401' || m === 'HTTP 403' || m === 'HTTP 400') return { ok: false, message: 'Chave recusada. Confira se copiou inteira e se tem permissão.' };
    if (m === 'HTTP 429') return { ok: false, message: 'Chave válida, mas o limite de uso foi atingido. Tente mais tarde.' };
    return { ok: false, message: /^HTTP/.test(m) ? `O serviço respondeu ${m.replace('HTTP ', 'erro ')}.` : 'Sem conexão com o serviço.' };
  }
}

export interface Generated {
  series?: string;
  seriesIndex?: number;
  description?: string;
  tags?: string[];
  viaAi: boolean;
}

/** Last resort: fills what no site had. Uses Claude when a key is configured, plain heuristics otherwise. */
export async function generateMissing(meta: Meta, missing: Set<string>): Promise<Generated> {
  const out: Generated = { viaAi: false };
  const author = meta.authors[0];

  if (missing.has('series') && meta.title) {
    const s = splitSeriesFromTitle(meta.title);
    if (s.series) {
      out.series = s.series;
      out.seriesIndex = s.seriesIndex;
    }
  }

  if (aiAvailable() && meta.title && (missing.has('description') || missing.has('tags') || missing.has('series'))) {
    const ask = [...missing].filter((k) => ['description', 'tags', 'series'].includes(k) && !(k === 'series' && out.series));
    if (ask.length) {
      const prompt =
        `Livro: "${meta.title}"${author ? ` de ${author}` : ''}${meta.year ? ` (${meta.year})` : ''}.\n` +
        `Retorne SOMENTE um JSON com os campos pedidos (${ask.join(', ')}). ` +
        `description: sinopse neutra de 2 a 4 frases, no idioma do título, sem spoilers. ` +
        `tags: lista de 3 a 6 gêneros/assuntos curtos. ` +
        `series: {"name": string, "index": number} apenas se tiver certeza de que o livro pertence a uma série; senão omita.`;
      try {
        const text = await askModel(prompt);
        if (text) {
          const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
          if (typeof json.description === 'string' && missing.has('description')) out.description = json.description.trim();
          if (Array.isArray(json.tags) && missing.has('tags')) out.tags = json.tags.map(String).slice(0, 6);
          if (json.series?.name && missing.has('series') && !out.series) {
            out.series = String(json.series.name);
            out.seriesIndex = saneSeriesIndex(json.series.index);
          }
          out.viaAi = true;
        }
      } catch {
        // fall through to heuristics
      }
    }
  }

  if (missing.has('description') && !out.description && meta.title) {
    out.description =
      `${meta.title}${author ? `, de ${author}` : ''}${meta.year ? `, edição de ${meta.year}` : ''}` +
      `${meta.publisher ? ` (${meta.publisher})` : ''}. Sinopse não encontrada: edite este campo.`;
  }
  return out;
}
