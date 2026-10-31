import { PLACEHOLDER_REPO } from '../shared/bugReport.ts';

export interface UpdateInfo {
  version: string;
  url: string;
}

const TTL = 6 * 60 * 60 * 1000;
let cache: { at: number; value: UpdateInfo | null } | null = null;
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
 * Looks at the public "latest release" of the repository and says whether it is newer than this app.
 * One anonymous GET (no body, no cookies, no identifiers); nothing is downloaded or installed. Silent on any failure.
 */
export async function checkForUpdate({ current, repo, enabled }: { current: string; repo: string; enabled: boolean }): Promise<UpdateInfo | null> {
  if (!enabled || !repo || repo === PLACEHOLDER_REPO) return null;
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  let value: UpdateInfo | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      method: 'GET',
      credentials: 'omit',
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Bookflix/${current}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const r: any = await res.json();
      if (!r.draft && !r.prerelease && typeof r.tag_name === 'string' && typeof r.html_url === 'string' && isNewer(r.tag_name, current)) {
        value = { version: String(parse(r.tag_name)!.join('.')), url: r.html_url };
      }
    }
  } catch {
    // offline, rate limited, bad JSON: no notice
  }
  cache = { at: Date.now(), value };
  return value;
}
