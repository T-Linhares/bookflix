import { describe, expect, it } from 'vitest';
import { buildFileName, buildRelPath, shortTitle, displayAuthor } from '../server/naming.ts';

describe('file naming', () => {
  it('uses Autor - Título by default', () => {
    expect(buildFileName({ authors: ['Brandon Sanderson'], title: 'The Final Empire' }, 'epub')).toBe('Brandon Sanderson - The Final Empire.epub');
  });
  it('drops subtitle and trailing groups', () => {
    expect(shortTitle('Dune: The Illustrated Edition')).toBe('Dune');
    expect(shortTitle('Neuromancer (Sprawl Trilogy, #1)')).toBe('Neuromancer');
    expect(shortTitle('Sapiens - Uma Breve História da Humanidade')).toBe('Sapiens');
  });
  it('flips "Last, First" and keeps only the first author', () => {
    expect(displayAuthor('Sanderson, Brandon')).toBe('Brandon Sanderson');
    expect(buildFileName({ authors: ['Neil Gaiman', 'Terry Pratchett'], title: 'Good Omens' }, 'epub')).toBe('Neil Gaiman - Good Omens.epub');
  });
  it('removes invalid Windows characters and keeps accents', () => {
    expect(buildFileName({ authors: ['José Saramago'], title: 'Ensaio sobre a Cegueira?' }, 'epub')).toBe('José Saramago - Ensaio sobre a Cegueira.epub');
    expect(buildFileName({ authors: ['A/B'], title: 'What *is* "this"' }, 'pdf')).toBe('AB - What is this.pdf');
  });
  it('limits the length', () => {
    const n = buildFileName({ authors: ['Autor'], title: 'Palavra '.repeat(40) }, 'epub');
    expect(n.length).toBeLessThanOrEqual(105);
    expect(n.endsWith('.epub')).toBe(true);
  });
  it('handles missing author/title and reserved names', () => {
    expect(buildFileName({ authors: [], title: 'X' }, 'epub')).toBe('Autor Desconhecido - X.epub');
    expect(buildFileName({ authors: ['CON'], title: '' }, 'epub')).toBe('_CON - Sem título.epub');
  });
  it('puts series in the folder, not the name', () => {
    const rel = buildRelPath({ authors: ['Brandon Sanderson'], title: 'The Final Empire', series: 'Mistborn', seriesIndex: 1 }, 'epub');
    expect(rel.split(/[\\/]/)).toEqual(['Brandon Sanderson', 'Mistborn', 'Brandon Sanderson - The Final Empire.epub']);
    expect(buildRelPath({ authors: ['X'], title: 'Y' }, 'epub').split(/[\\/]/)).toEqual(['X', 'X - Y.epub']);
  });
  it('supports custom templates and flat layout', () => {
    expect(buildFileName({ authors: ['A'], title: 'T', series: 'S', seriesIndex: 3 }, 'epub', { template: '{series} {index} - {title}' })).toBe('S 03 - T.epub');
    expect(buildRelPath({ authors: ['A'], title: 'T', series: 'S' }, 'epub', { useFolders: false })).toBe('A - T.epub');
  });
});
