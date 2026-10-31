import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { Book, STATUS_LABEL } from '../types';
import { Cover, Empty, ErrorBox, Poster, Spinner, Stars, toast, useAsync } from '../components/ui';

type Facet = { value: string | number; count: number };
interface Facets {
  status: Facet[];
  series: Facet[];
  authors: Facet[];
  publishers: Facet[];
  years: Facet[];
  tags: Facet[];
  formats: Facet[];
  total: number;
}

const SORTS = [
  ['title', 'Título'],
  ['author', 'Autor'],
  ['series', 'Série e ordem'],
  ['year', 'Ano da edição'],
  ['added', 'Adicionado'],
  ['last_read', 'Última leitura'],
  ['rating', 'Nota'],
  ['progress', 'Progresso'],
] as const;

const PAGE = 60;

function Select({ label, value, options, onChange }: { label: string; value: string; options: Facet[]; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Todos</option>
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.value} ({o.count})
          </option>
        ))}
      </select>
    </label>
  );
}

function Tri({ label, value, yes, no, onChange }: { label: string; value: string; yes: string; no: string; onChange: (v: string) => void }) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="grid grid-cols-3 overflow-hidden rounded-md border border-line text-xs">
        {[
          ['', 'Todos'],
          ['1', yes],
          ['0', no],
        ].map(([v, l]) => (
          <button key={v} onClick={() => onChange(v)} className={`px-1 py-1.5 transition ${value === v ? 'bg-accent font-semibold text-white' : 'bg-surface hover:bg-surface2'}`}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Library() {
  const [params, setParams] = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('view') as 'grid' | 'list') || 'grid');
  const [tagQuery, setTagQuery] = useState('');
  const [tagsOpen, setTagsOpen] = useState(false);
  const [items, setItems] = useState<Book[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const get = (k: string) => params.get(k) ?? '';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };
  const list = (k: string) => get(k).split(',').filter(Boolean);
  const toggle = (k: string, v: string) => {
    const cur = list(k);
    set({ [k]: (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]).join(',') || null });
  };

  const facets = useAsync(() => api<Facets>('/api/facets'), []);
  const query = useMemo(() => {
    const p = new URLSearchParams(params);
    p.delete('limit');
    p.delete('offset');
    return p.toString();
  }, [params]);

  useEffect(() => {
    setLoading(true);
    api<{ items: Book[]; total: number }>(`/api/books?${query}&limit=${PAGE}`)
      .then((d) => {
        setItems(d.items);
        setTotal(d.total);
        setError('');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [query]);

  const more = async () => {
    const d = await api<{ items: Book[]; total: number }>(`/api/books?${query}&limit=${PAGE}&offset=${items.length}`);
    setItems((s) => [...s, ...d.items]);
  };

  const FILTER_KEYS = ['q', 'status', 'series', 'author', 'publisher', 'year', 'tags', 'format', 'rating', 'progressMin', 'progressMax', 'hasNotes', 'complete', 'sent', 'organized'];
  const active = FILTER_KEYS.filter((k) => get(k));
  const labels: Record<string, string> = { q: 'Busca', status: 'Status', series: 'Série', author: 'Autor', publisher: 'Editora', year: 'Ano', tags: 'Tags', format: 'Formato', rating: 'Nota ≥', progressMin: 'Progresso ≥', progressMax: 'Progresso ≤', hasNotes: 'Notas', complete: 'Metadados', sent: 'Kindle', organized: 'Organizado' };
  const pretty = (k: string) => {
    const v = get(k);
    if (['hasNotes', 'complete', 'sent', 'organized'].includes(k)) return v === '1' ? 'sim' : 'não';
    if (k === 'status') return list(k).map((s) => STATUS_LABEL[s as keyof typeof STATUS_LABEL] ?? s).join(', ');
    if (k.startsWith('progress')) return `${Math.round(Number(v) * 100)}%`;
    return v.replace(/,/g, ', ');
  };

  const saveFilter = async () => {
    const name = window.prompt('Nome da linha na tela inicial:', get('series') || get('author') || list('tags')[0] || 'Meu filtro');
    if (!name) return;
    const p = new URLSearchParams(params);
    await api('/api/saved-filters', { body: { name, query: p.toString() } });
    toast(`Filtro "${name}" salvo na tela inicial`);
  };

  const tags = (facets.data?.tags ?? []).filter((t) => String(t.value).toLowerCase().includes(tagQuery.toLowerCase()));
  const shownTags = tagsOpen || tagQuery ? tags : tags.slice(0, 12);

  const panel = (
    <div className="space-y-4">
      <div>
        <span className="label">Status</span>
        <div className="flex flex-wrap gap-1.5">
          {(facets.data?.status ?? []).map((s) => (
            <button key={String(s.value)} onClick={() => toggle('status', String(s.value))} className={`chip transition ${list('status').includes(String(s.value)) ? '!border-accent !bg-accent text-white' : 'hover:border-muted'}`}>
              {STATUS_LABEL[s.value as keyof typeof STATUS_LABEL]} <span className="opacity-60">{s.count}</span>
            </button>
          ))}
        </div>
      </div>
      <Select label="Série" value={get('series')} options={facets.data?.series ?? []} onChange={(v) => set({ series: v || null })} />
      <Select label="Autor" value={get('author')} options={facets.data?.authors ?? []} onChange={(v) => set({ author: v || null })} />
      <Select label="Editora" value={get('publisher')} options={facets.data?.publishers ?? []} onChange={(v) => set({ publisher: v || null })} />
      <div className="grid grid-cols-2 gap-3">
        <Select label="Ano da edição" value={get('year')} options={facets.data?.years ?? []} onChange={(v) => set({ year: v || null })} />
        <Select label="Formato" value={get('format')} options={facets.data?.formats ?? []} onChange={(v) => set({ format: v || null })} />
      </div>
      <div>
        <span className="label">Tags {list('tags').length > 1 && <span className="normal-case">(todas)</span>}</span>
        <input className="input mb-2" placeholder="Filtrar tags…" value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} />
        <div className="flex flex-wrap gap-1.5">
          {shownTags.map((t) => (
            <button key={String(t.value)} onClick={() => toggle('tags', String(t.value))} className={`chip transition ${list('tags').includes(String(t.value)) ? '!border-accent !bg-accent text-white' : 'hover:border-muted'}`}>
              {t.value} <span className="opacity-60">{t.count}</span>
            </button>
          ))}
          {!tagQuery && tags.length > 12 && (
            <button className="chip text-muted" onClick={() => setTagsOpen(!tagsOpen)}>
              {tagsOpen ? 'menos' : `+${tags.length - 12}`}
            </button>
          )}
        </div>
      </div>
      <div>
        <span className="label">Nota mínima</span>
        <Stars value={Number(get('rating')) || null} onChange={(v) => set({ rating: v ? String(v) : null })} />
      </div>
      <div>
        <span className="label">Progresso</span>
        <div className="flex flex-wrap gap-1.5">
          {[
            ['Não iniciado', null, '0'],
            ['Em andamento', '0.01', '0.99'],
            ['Quase lá (>75%)', '0.75', '0.99'],
            ['Terminado', '1', null],
          ].map(([l, min, max]) => {
            const on = (get('progressMin') || null) === min && (get('progressMax') || null) === max;
            return (
              <button key={l} onClick={() => set(on ? { progressMin: null, progressMax: null } : { progressMin: min, progressMax: max })} className={`chip transition ${on ? '!border-accent !bg-accent text-white' : 'hover:border-muted'}`}>
                {l}
              </button>
            );
          })}
        </div>
      </div>
      <Tri label="Tem notas/destaques" value={get('hasNotes')} yes="Sim" no="Não" onChange={(v) => set({ hasNotes: v || null })} />
      <Tri label="Metadados" value={get('complete')} yes="Completos" no="Incompletos" onChange={(v) => set({ complete: v || null })} />
      <Tri label="No Kindle" value={get('sent')} yes="Enviado" no="Não" onChange={(v) => set({ sent: v || null })} />
      <Tri label="Organizado no app" value={get('organized')} yes="Sim" no="Não" onChange={(v) => set({ organized: v || null })} />
    </div>
  );

  return (
    <div className="px-4 pt-4 sm:px-8">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="mr-2 text-2xl font-bold">Biblioteca</h1>
        <span className="pb-1 text-sm text-muted" aria-live="polite">
          {loading ? 'buscando…' : `${total} ${total === 1 ? 'livro' : 'livros'}${facets.data && total !== facets.data.total ? ` de ${facets.data.total}` : ''}`}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button className="btn-ghost lg:hidden" onClick={() => setShowFilters(!showFilters)}>
            Filtros{active.length ? ` (${active.length})` : ''}
          </button>
          <select className="input !w-auto" value={get('sort') || (get('q') ? 'relevance' : 'title')} onChange={(e) => set({ sort: e.target.value, dir: null })} aria-label="Ordenar por">
            {get('q') && <option value="relevance">Relevância</option>}
            {SORTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <button className="btn-ghost" title="Inverter ordem" onClick={() => set({ dir: get('dir') === 'desc' ? 'asc' : 'desc' })}>
            {get('dir') === 'desc' ? '↓' : get('dir') === 'asc' ? '↑' : '⇅'}
          </button>
          <div className="flex overflow-hidden rounded-md border border-line">
            {(['grid', 'list'] as const).map((v) => (
              <button
                key={v}
                aria-label={v === 'grid' ? 'Grade' : 'Lista'}
                onClick={() => {
                  setView(v);
                  localStorage.setItem('view', v);
                }}
                className={`px-3 py-2 text-sm ${view === v ? 'bg-accent text-white' : 'bg-surface hover:bg-surface2'}`}
              >
                {v === 'grid' ? '▦' : '☰'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {active.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {active.map((k) => (
            <button key={k} className="chip hover:border-accent" onClick={() => set({ [k]: null })} title="Remover filtro">
              <span className="text-muted">{labels[k]}:</span> {pretty(k)} ✕
            </button>
          ))}
          <button className="text-xs text-accent2 hover:underline" onClick={() => setParams({}, { replace: true })}>
            limpar tudo
          </button>
          <button className="text-xs text-muted hover:text-ink hover:underline" onClick={saveFilter}>
            salvar como linha da tela inicial
          </button>
        </div>
      )}

      <div className="mt-5 flex gap-8">
        <aside className={`${showFilters ? 'block' : 'hidden'} w-full shrink-0 lg:block lg:w-64`}>
          <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-6 pr-1">{panel}</div>
        </aside>

        <section className="min-w-0 flex-1">
          {error && <ErrorBox message={error} />}
          {loading && !items.length ? (
            <Spinner />
          ) : !items.length ? (
            <Empty title="Nenhum livro encontrado">
              {active.length ? 'Tente remover algum filtro.' : 'Passe livros por Adicionar ou coloque arquivos na pasta Livros.'}
            </Empty>
          ) : view === 'grid' ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-4 gap-y-6">
              {items.map((b) => (
                <div key={b.id} className="[&>a]:w-full">
                  <Poster book={b} />
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {items.map((b) => (
                <Link key={b.id} to={`/livro/${b.id}`} className="flex items-center gap-4 p-3 transition hover:bg-surface2">
                  <div className="w-10 shrink-0">
                    <Cover book={b} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{b.title}</div>
                    <div className="truncate text-xs text-muted">
                      {b.authors}
                      {b.series && ` · ${b.series}${b.series_index != null ? ` #${b.series_index}` : ''}`}
                    </div>
                  </div>
                  <div className="hidden w-40 truncate text-xs text-muted md:block">{[b.publisher, b.year].filter(Boolean).join(' · ')}</div>
                  <div className="hidden w-24 md:block">
                    <Stars value={b.rating} size="text-sm" />
                  </div>
                  <div className="w-24 text-right text-xs">
                    <div>{STATUS_LABEL[b.status]}</div>
                    {b.status === 'reading' && <div className="text-muted">{Math.round(b.progress * 100)}%</div>}
                  </div>
                </Link>
              ))}
            </div>
          )}
          {items.length < total && (
            <div className="mt-8 text-center">
              <button className="btn-ghost" onClick={more}>
                Carregar mais ({total - items.length})
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
