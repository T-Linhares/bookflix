/**
 * API keys typed in Ajustes are stored encrypted when the OS offers a store for it (Electron's safeStorage: DPAPI on
 * Windows, libsecret/kwallet on Linux). Without one they stay as plain text in the local database, and the UI says so.
 * The cipher is injected by the desktop shell, so the server stays free of any Electron import.
 */
export interface Cipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

const PREFIX = 'enc:v1:';
let cipher: Cipher | null = null;

export const setCipher = (c: Cipher | null) => {
  cipher = c;
};
export const secretsProtected = () => !!cipher?.available();

export function seal(plain: string): string {
  if (!plain || plain.startsWith(PREFIX) || !secretsProtected()) return plain;
  return PREFIX + cipher!.encrypt(plain);
}

/** Empty string when the value cannot be read (other machine/user, or no cipher any more): the user just types the key again. */
export function unseal(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  if (!secretsProtected()) return '';
  try {
    return cipher!.decrypt(stored.slice(PREFIX.length));
  } catch {
    return '';
  }
}
