import { getSetting, setSetting } from './db.ts';
import { DEFAULT_TEMPLATE } from './naming.ts';
import { seal, unseal } from './secrets.ts';

export type AiProvider = 'gemini' | 'anthropic' | 'openai';

export interface Settings {
  booksDir: string;
  inboxDir: string;
  nameTemplate: string;
  useFolders: boolean;
  moveOriginals: boolean;
  yearlyGoal: number;
  anthropicKey: string;
  geminiKey: string;
  openaiKey: string;
  /** which model is asked first; "auto" = Gemini (free tier), then Anthropic, then OpenAI */
  aiOrder: 'auto' | AiProvider;
  googleBooksKey: string;
  /** share the API keys above with the other computers of the same sync library (encrypted with the library id) */
  syncKeys: boolean;
  /** shows a notice when a newer release exists on GitHub (one anonymous GET, never installs anything) */
  checkUpdates: boolean;
}

const DEFAULTS: Settings = {
  booksDir: '',
  inboxDir: '',
  nameTemplate: DEFAULT_TEMPLATE,
  useFolders: true,
  moveOriginals: false,
  yearlyGoal: 24,
  anthropicKey: '',
  geminiKey: '',
  openaiKey: '',
  aiOrder: 'auto',
  googleBooksKey: '',
  syncKeys: true,
  checkUpdates: true,
};

export const SECRET_KEYS = ['anthropicKey', 'geminiKey', 'openaiKey', 'googleBooksKey'] as const satisfies readonly (keyof Settings)[];
const isSecret = (k: string) => (SECRET_KEYS as readonly string[]).includes(k);

export function getSettings(): Settings {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const v = getSetting(k);
    if (v !== undefined) (out as any)[k] = isSecret(k) && typeof v === 'string' ? unseal(v) : v;
  }
  return out;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (patch[k] === undefined) continue;
    const v = patch[k];
    setSetting(k, isSecret(k) && typeof v === 'string' ? seal(v) : v);
  }
  return getSettings();
}

/** Encrypts keys that were saved in plain text before a cipher was available. Safe to run repeatedly. */
export function protectStoredSecrets() {
  for (const k of SECRET_KEYS) {
    const v = getSetting(k);
    if (typeof v === 'string' && v) setSetting(k, seal(v));
  }
}

/** Keys can come from Ajustes or from the environment (.env). */
export const anthropicKey = () => getSettings().anthropicKey || process.env.ANTHROPIC_API_KEY || '';
export const geminiKey = () => getSettings().geminiKey || process.env.GEMINI_API_KEY || '';
export const openaiKey = () => getSettings().openaiKey || process.env.OPENAI_API_KEY || '';
/** Any configured text model (Gemini has a free tier, so it is tried first). */
export const aiAvailable = () => !!(geminiKey() || anthropicKey() || openaiKey());
export const googleKey = () => getSettings().googleBooksKey || process.env.GOOGLE_BOOKS_KEY || '';
