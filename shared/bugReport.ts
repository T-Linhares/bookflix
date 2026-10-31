// Used by the web app (BugReport panel) and by the desktop shell (openExternal allow-list). No imports on purpose.

/** Replace with the real "owner/repo" before the first release; while it is the placeholder nothing is sent anywhere. */
export const PLACEHOLDER_REPO = 'SEU-USUARIO/bookflix';

/** GitHub accepts long URLs, but proxies and browsers do not: stay well under the common 8 KB limit once percent-encoded. */
export const BODY_LIMIT = 6000;

const CUT_NOTE = '\n\n[texto cortado: cole o restante aqui, ele foi copiado para a área de transferência]';

export interface Diagnostic {
  version: string;
  platform: string;
  arch: string;
}

/** Exactly these three fields, never paths, book titles, user names or keys. Extra properties on the argument are ignored. */
export function diagnosticText({ version, platform, arch }: Diagnostic): string {
  return `Versão do app: ${version}\nSistema: ${platform} ${arch}`;
}

export interface IssueUrl {
  url: string;
  /** the body was cut to fit a URL: put `fullText` on the clipboard */
  truncated: boolean;
  fullText: string;
}

export function buildIssueUrl({ repo, text, diagnostic }: { repo: string; text: string; diagnostic?: Diagnostic }): IssueUrl | null {
  if (!repo || repo === PLACEHOLDER_REPO) return null;
  const typed = text.trim();
  if (!typed) return null;

  const fullText = diagnostic ? `${typed}\n\n---\n${diagnosticText(diagnostic)}` : typed;
  const truncated = fullText.length > BODY_LIMIT;
  const body = truncated ? fullText.slice(0, BODY_LIMIT - CUT_NOTE.length) + CUT_NOTE : fullText;

  const firstLine = typed.split(/\r?\n/).find((l) => l.trim())!.replace(/\s+/g, ' ').trim();
  const title = `[Bug] ${firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine}`;

  const q = new URLSearchParams({ title, body, labels: 'bug' });
  return { url: `https://github.com/${repo}/issues/new?${q}`, truncated, fullText };
}

// the last four are the sites where API keys are created (see keyPages.ts; a test keeps both lists in step)
const ALLOWED_HOSTS = new Set(['github.com', 'console.cloud.google.com', 'aistudio.google.com', 'console.anthropic.com', 'platform.openai.com']);

/** The only links the app ever opens in the browser: https on an allow-listed host (GitHub and the API key pages), no credentials, default port. */
export function isAllowedExternalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
}
