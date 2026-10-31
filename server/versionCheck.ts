import { PLACEHOLDER_REPO } from '../shared/bugReport.ts';

export interface UpdateInfo {
  version: string;
  url: string;
}

export type UpdateCheck =
  | { status: 'newer'; update: UpdateInfo }
  | { status: 'current' }
  /** no-repo: not configured; not-found: private repository or no release yet; rate-limited; offline; error */
  | { status: 'unavailable'; reason: 'no-repo' | 'not-found' | 'rate-limited' | 'offline' | 'error' };

const TTL = 6 * 60 * 60 * 1000;
/** only answers GitHub really gave are remembered: a failed check must not hide an update for hours */
let cache: { at: number; value: UpdateCheck } | null = null;
export const resetUpdateCache = () => {
  cache = null;
};

const parse = (v: string) => /(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);

/** Numeric semver comparison; anything unparsable is "not newer". */
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * Looks at the public "latest release" of the repository and says whether it is newer than this app, or why it could not tell.
 * One anonymous GET (no body, no cookies, no identifiers); nothing is downloaded or installed.
 * `force` skips the 6 hour memory (the "Procurar atualização" button).
 */
export async function checkUpdateStatus({ current, repo, force = false }: { current: string; repo: string; force?: boolean }): Promise<UpdateCheck> {
  if (!repo || repo === PLACEHOLDER_REPO) return { status: 'unavailable', reason: 'no-repo' };
  if (!force && cache && Date.now() - cache.at < TTL) return cache.value;
  let value: UpdateCheck;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Bookflix/${current}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const r: any = await res.json();
      value =
        !r.draft && !r.prerelease && typeof r.tag_name === 'string' && typeof r.html_url === 'string' && isNewer(r.tag_name, current)
          ? { status: 'newer', update: { version: String(parse(r.tag_name)!.join('.')), url: r.html_url } }
          : { status: 'current' };
    } else value = { status: 'unavailable', reason: res.status === 404 ? 'not-found' : res.status === 403 || res.status === 429 ? 'rate-limited' : 'error' };
  } catch (e) {
    // a bad JSON body is an answer we cannot read; anything else (DNS, timeout, no network) is being offline
    value = { status: 'unavailable', reason: e instanceof SyntaxError ? 'error' : 'offline' };
  }
  if (value.status !== 'unavailable') cache = { at: Date.now(), value };
  return value;
}

/** The automatic check: the newer release, or null (also null when switched off or on any failure). */
export async function checkForUpdate({ current, repo, enabled }: { current: string; repo: string; enabled: boolean }): Promise<UpdateInfo | null> {
  if (!enabled) return null;
  const r = await checkUpdateStatus({ current, repo });
  return r.status === 'newer' ? r.update : null;
}
