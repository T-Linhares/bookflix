import crypto from 'node:crypto';

/**
 * API keys that travel through the sync folder are encrypted with a key derived from the library's ID.
 * This keeps them out of plain sight (cloud previews, search, backups read by eye), but the ID sits in the same folder,
 * so it is NOT protection against someone who can open that folder. Ajustes says so and lets each computer opt out.
 *
 * The IV is derived from the key and the text (a synthetic IV), so the same key always gives the same output and an
 * unchanged key never makes the cloud file look modified.
 */

const PREFIX = 'bfk1:';
const SALT = 'bookflix-sync-keys-v1';
const derived = new Map<string, Buffer>();

const keyFor = (libraryId: string): Buffer => {
  let k = derived.get(libraryId);
  if (!k) {
    k = crypto.scryptSync(libraryId, SALT, 32);
    derived.set(libraryId, k);
  }
  return k;
};
const b64 = (b: Buffer) => b.toString('base64url');

export function sealForLibrary(plain: string, libraryId: string): string {
  const key = keyFor(libraryId);
  const iv = crypto.createHmac('sha256', key).update(`iv:${plain}`).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(data)}`;
}

/** The text, or null when the token is not ours, was altered, or belongs to another library. */
export function openForLibrary(token: string, libraryId: string): string | null {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  const [iv, tag, data] = token.slice(PREFIX.length).split('.').map((p) => Buffer.from(p ?? '', 'base64url'));
  if (!iv || iv.length !== 12 || !tag || tag.length !== 16 || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(libraryId), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
