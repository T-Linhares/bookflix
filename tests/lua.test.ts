import { describe, expect, it } from 'vitest';
import { parseSidecar } from '../server/kindle/lua.ts';

export const SAMPLE = `-- we can read Lua syntax here!
return {
    ["annotations"] = {
        [1] = {
            ["chapter"] = "Capítulo 1",
            ["color"] = "yellow",
            ["datetime"] = "2024-03-01 21:15:00",
            ["drawer"] = "lighten",
            ["page"] = "/body/DocFragment[3]/body/p[2]/text().0",
            ["pageno"] = 12,
            ["text"] = "Uma frase \\"marcada\\"\\ncom quebra",
        },
        [2] = {
            ["chapter"] = "Capítulo 2",
            ["datetime"] = "2024-03-02 10:00:00",
            ["drawer"] = "underscore",
            ["note"] = "Minha nota",
            ["pageno"] = 40,
            ["text"] = "Outro trecho",
        },
        [3] = { ["datetime"] = "2024-03-03 10:00:00", ["pageno"] = 50, ["text"] = "Página 50" },
    },
    ["doc_pages"] = 300,
    ["doc_props"] = { ["authors"] = "Brandon Sanderson", ["language"] = "en", ["title"] = "The Final Empire" },
    ["partial_md5_checksum"] = "abc123",
    ["percent_finished"] = 0.42,
    ["summary"] = { ["modified"] = "2024-03-05", ["note"] = "Ótimo livro", ["rating"] = 5, ["status"] = "reading" },
}`;

describe('KOReader sidecar parser', () => {
  const sc = parseSidecar(SAMPLE);
  it('reads progress and props', () => {
    expect(sc.percent).toBeCloseTo(0.42);
    expect(sc.docPages).toBe(300);
    expect(sc.partialMd5).toBe('abc123');
    expect(sc.props.title).toBe('The Final Empire');
  });
  it('reads summary', () => {
    expect(sc.rating).toBe(5);
    expect(sc.review).toBe('Ótimo livro');
    expect(sc.status).toBe('reading');
  });
  it('keeps highlights and notes, skips bookmarks', () => {
    expect(sc.annotations).toHaveLength(2);
    expect(sc.annotations[0]).toMatchObject({ kind: 'highlight', chapter: 'Capítulo 1', page: '12' });
    expect(sc.annotations[0].text).toBe('Uma frase "marcada"\ncom quebra');
    expect(sc.annotations[1]).toMatchObject({ kind: 'note', note: 'Minha nota' });
  });
  it('understands the legacy highlight table', () => {
    const old = parseSidecar(
      `return { ["highlight"] = { [5] = { [1] = { ["text"] = "velho", ["datetime"] = "2020-01-01 00:00:00" } } }, ["percent_finished"] = 0.1 }`,
    );
    expect(old.annotations).toHaveLength(1);
    expect(old.annotations[0].text).toBe('velho');
  });
});
