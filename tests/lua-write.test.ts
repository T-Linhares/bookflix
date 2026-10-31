import { describe, expect, it } from 'vitest';
import { parseSidecar, setSummaryNote } from '../server/kindle/lua.ts';
import { SAMPLE } from './lua.test.ts';

describe('writing the review into a KOReader sidecar', () => {
  it('replaces the existing note and leaves everything else as it was', () => {
    const out = setSummaryNote(SAMPLE, 'Minha resenha nova');
    const sc = parseSidecar(out);
    expect(sc.review).toBe('Minha resenha nova');
    const before = parseSidecar(SAMPLE);
    expect({ ...sc, review: undefined }).toEqual({ ...before, review: undefined });
    expect(out.replace('Minha resenha nova', 'Ótimo livro')).toBe(SAMPLE); // byte for byte, apart from the note
  });

  it('adds a note when the summary has none', () => {
    const src = 'return { ["percent_finished"] = 0.5, ["summary"] = { ["rating"] = 4, ["status"] = "complete" } }';
    const sc = parseSidecar(setSummaryNote(src, 'Gostei'));
    expect(sc.review).toBe('Gostei');
    expect(sc.rating).toBe(4);
    expect(sc.status).toBe('complete');
    expect(sc.percent).toBe(0.5);
  });

  it('creates the summary when the file has none', () => {
    const sc = parseSidecar(setSummaryNote('return { ["percent_finished"] = 0.5 }', 'Gostei'));
    expect(sc.review).toBe('Gostei');
    expect(sc.percent).toBe(0.5);
  });

  it('keeps quotes, backslashes, line breaks and accents intact', () => {
    const text = 'Ele disse "oi" \ e saiu.\nSegunda linha: coração, ação, “aspas”.\r\nTerceira.';
    expect(parseSidecar(setSummaryNote(SAMPLE, text)).review).toBe(text.replace('\r\n', '\n'));
  });

  it('refuses a file that is not a data table', () => {
    expect(() => setSummaryNote('print("oi")', 'x')).toThrow();
  });
});
