import { describe, expect, it } from 'vitest';
import { parseSidecar, setAnnotationNote, setSummaryNote, setSummaryRating, setSummaryStatus } from '../server/kindle/lua.ts';
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

describe('writing rating, status and highlight notes', () => {
  it('exposes the table key of each annotation', () => {
    expect(parseSidecar(SAMPLE).annotations.map((a) => a.key)).toEqual(['1', '2']); // [3] is a plain bookmark
  });

  it('sets rating and status in the summary, touching nothing else', () => {
    const out = setSummaryStatus(setSummaryRating(SAMPLE, 3), 'complete');
    const sc = parseSidecar(out);
    expect([sc.rating, sc.status, sc.review]).toEqual([3, 'complete', 'Ótimo livro']);
    expect(out.replace('["rating"] = 3', '["rating"] = 5').replace('"complete"', '"reading"')).toBe(SAMPLE);
  });

  it('adds rating and status when the summary lacks them', () => {
    const sc = parseSidecar(setSummaryStatus(setSummaryRating('return { ["summary"] = { ["note"] = "x" } }', 4), 'abandoned'));
    expect([sc.rating, sc.status, sc.review]).toEqual([4, 'abandoned', 'x']);
  });

  it('corrects the note of a highlight, only that one', () => {
    const out = setAnnotationNote(SAMPLE, '2', 'Minha nota corrigida');
    const sc = parseSidecar(out);
    expect(sc.annotations[1].note).toBe('Minha nota corrigida');
    expect(sc.annotations[0]).toEqual(parseSidecar(SAMPLE).annotations[0]);
    expect(out.replace('Minha nota corrigida', 'Minha nota')).toBe(SAMPLE);
  });

  it('adds a note to a highlight that had none, keeping its text and position', () => {
    const sc = parseSidecar(setAnnotationNote(SAMPLE, '1', 'Agora com "nota"\ne acentuação'));
    expect(sc.annotations[0]).toMatchObject({ kind: 'note', note: 'Agora com "nota"\ne acentuação', text: 'Uma frase "marcada"\ncom quebra', page: '12', chapter: 'Capítulo 1' });
  });

  it('refuses an annotation that does not exist', () => {
    expect(() => setAnnotationNote(SAMPLE, '99', 'x')).toThrow();
  });
});
