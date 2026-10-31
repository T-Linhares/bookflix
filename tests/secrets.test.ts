import { afterEach, beforeAll, describe, expect, it } from 'vitest';

let db: typeof import('../server/db.ts').db;
let settings: typeof import('../server/settings.ts');
let secrets: typeof import('../server/secrets.ts');

/** reversible stand-in for Electron's safeStorage */
const fake = {
  available: () => true,
  encrypt: (s: string) => Buffer.from([...s].reverse().join('')).toString('base64'),
  decrypt: (e: string) => [...Buffer.from(e, 'base64').toString()].reverse().join(''),
};
const raw = (key: string) => (db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined)?.value;

beforeAll(async () => {
  db = (await import('../server/db.ts')).db;
  settings = await import('../server/settings.ts');
  secrets = await import('../server/secrets.ts');
});

afterEach(() => {
  secrets.setCipher(null);
  settings.updateSettings({ openaiKey: '', geminiKey: '' });
});

describe('secret storage (T5)', () => {
  it('without a cipher the key is stored as-is and the app says it is not protected', () => {
    settings.updateSettings({ openaiKey: 'sk-plain' });
    expect(raw('openaiKey')).toBe('"sk-plain"');
    expect(secrets.secretsProtected()).toBe(false);
    expect(settings.getSettings().openaiKey).toBe('sk-plain');
  });

  it('encrypts a key saved while a cipher is active, and reads it back', () => {
    secrets.setCipher(fake);
    settings.updateSettings({ openaiKey: 'sk-new-key' });
    expect(raw('openaiKey')).not.toContain('sk-new-key');
    expect(raw('openaiKey')).toContain('enc:v1:');
    expect(settings.getSettings().openaiKey).toBe('sk-new-key');
    expect(settings.openaiKey()).toBe('sk-new-key');
  });

  it('migrates a key that was saved in plain text before the cipher existed', () => {
    settings.updateSettings({ geminiKey: 'AIza-old-plain' });
    expect(raw('geminiKey')).toContain('AIza-old-plain');
    secrets.setCipher(fake);
    settings.protectStoredSecrets();
    expect(raw('geminiKey')).not.toContain('AIza-old-plain');
    expect(settings.getSettings().geminiKey).toBe('AIza-old-plain');
    settings.protectStoredSecrets(); // second run changes nothing
    expect(settings.getSettings().geminiKey).toBe('AIza-old-plain');
  });

  it('never throws when a stored key cannot be decrypted (other machine/user): the key is just empty', () => {
    secrets.setCipher(fake);
    settings.updateSettings({ openaiKey: 'sk-lost' });
    secrets.setCipher({ available: () => true, encrypt: fake.encrypt, decrypt: () => { throw new Error('bad data'); } });
    expect(settings.getSettings().openaiKey).toBe('');
    secrets.setCipher(null);
    expect(settings.getSettings().openaiKey).toBe('');
  });

  it('GET /api/settings masks every key and reports whether secrets are encrypted', async () => {
    secrets.setCipher(fake);
    settings.updateSettings({ openaiKey: 'sk-visible-never' });
    const { buildApp } = await import('../server/app.ts');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(res.body);
    expect(res.body).not.toContain('sk-visible-never');
    expect(body.openaiKey).toBe('••••');
    expect(body.secretsEncrypted).toBe(true);
    // what the UI does after loading: sends the masks back. (Only the keys: other settings left by other test files may point to deleted folders.)
    const put = await app.inject({ method: 'PUT', url: '/api/settings', payload: { openaiKey: body.openaiKey, geminiKey: body.geminiKey } });
    expect(put.statusCode).toBe(200);
    expect(settings.getSettings().openaiKey).toBe('sk-visible-never'); // the mask coming back must not overwrite the key
    await app.close();
  });
});
