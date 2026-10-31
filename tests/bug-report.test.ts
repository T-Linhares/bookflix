import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';

import { BODY_LIMIT, buildIssueUrl, diagnosticText, isAllowedExternalUrl } from '../shared/bugReport.ts';

const REPO = 'dono/bookflix';
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchMock).not.toHaveBeenCalled(); // building a report never touches the network
});

const params = (url: string) => new URL(url).searchParams;

describe('issue URL (T21)', () => {
  it('opens the new-issue page of the repository with the typed text as the body', () => {
    const r = buildIssueUrl({ repo: REPO, text: 'O botão Salvar não faz nada.' })!;
    expect(r.url.startsWith(`https://github.com/${REPO}/issues/new?`)).toBe(true);
    expect(params(r.url).get('body')).toBe('O botão Salvar não faz nada.');
    expect(params(r.url).get('title')).toMatch(/^\[Bug\] O botão Salvar/);
    expect(params(r.url).get('labels')).toBe('bug');
    expect(r.truncated).toBe(false);
  });

  it('round-trips accents, &, #, = and line breaks exactly', () => {
    const text = 'Título: "Cem anos & uma noite" #1\nLinha 2 com = e ?\r\nLinha 3 — ação';
    const r = buildIssueUrl({ repo: REPO, text })!;
    expect(params(r.url).get('body')).toBe(text);
  });

  it('keeps the title to one short line', () => {
    const r = buildIssueUrl({ repo: REPO, text: `${'a'.repeat(300)}\nsegunda linha` })!;
    const title = params(r.url).get('title')!;
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title).not.toContain('\n');
  });

  it('cuts a huge text to the limit, says so, and hands back the full text for the clipboard', () => {
    const text = 'x'.repeat(20_000);
    const r = buildIssueUrl({ repo: REPO, text })!;
    expect(r.truncated).toBe(true);
    expect(params(r.url).get('body')!.length).toBeLessThanOrEqual(BODY_LIMIT);
    expect(params(r.url).get('body')).toMatch(/cole o restante/i);
    expect(r.fullText).toBe(text);
    expect(r.url.length).toBeLessThan(8000 * 3); // even fully percent-encoded, far below what GitHub/browsers refuse
  });

  it('returns null for empty or whitespace-only text', () => {
    expect(buildIssueUrl({ repo: REPO, text: '' })).toBeNull();
    expect(buildIssueUrl({ repo: REPO, text: '  \n\t ' })).toBeNull();
  });

  it('returns null while the repository is still the placeholder', () => {
    expect(buildIssueUrl({ repo: 'SEU-USUARIO/bookflix', text: 'oi' })).toBeNull();
  });
});

describe('diagnostic (T22)', () => {
  const diag = { version: '0.2.0', platform: 'win32', arch: 'x64' };

  it('is not added unless asked', () => {
    const r = buildIssueUrl({ repo: REPO, text: 'travou' })!;
    expect(params(r.url).get('body')).toBe('travou');
  });

  it('adds version, OS and architecture and nothing else', () => {
    const r = buildIssueUrl({ repo: REPO, text: 'travou', diagnostic: diag })!;
    const body = params(r.url).get('body')!;
    expect(body.startsWith('travou')).toBe(true);
    expect(body).toContain('0.2.0');
    expect(body).toContain('win32');
    expect(body).toContain('x64');
    expect(body).toBe(`travou\n\n---\n${diagnosticText(diag)}`);
  });

  it('cannot leak paths, user names or keys even if the caller passes extra fields', () => {
    const polluted = { ...diag, booksDir: 'C:\\Users\\Thiago\\Livros', user: os.userInfo().username, openaiKey: 'sk-secret-key' } as typeof diag;
    const text = diagnosticText(polluted);
    expect(text).not.toMatch(/C:\\|\/home\/|\/Users\//);
    expect(text).not.toContain('sk-secret-key');
    expect(text).not.toContain(os.userInfo().username);
    expect(text).not.toContain('Livros');
  });
});

describe('external links (T23)', () => {
  it.each([
    'https://github.com/dono/bookflix/issues/new?title=x',
    'https://github.com/dono/bookflix/releases/tag/v0.3.0',
    'https://GITHUB.com/dono/bookflix',
  ])('allows %s', (u) => expect(isAllowedExternalUrl(u)).toBe(true));

  it.each([
    'http://github.com/dono/bookflix',
    'https://evil.example/',
    'https://github.com.evil.example/',
    'https://github.com@evil.example/',
    'https://evilgithub.com/',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'smb://servidor/pasta',
    'not a url',
    '',
  ])('refuses %s', (u) => expect(isAllowedExternalUrl(u)).toBe(false));
});
