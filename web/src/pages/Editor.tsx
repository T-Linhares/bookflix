import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from '../api';
import { Meta, Staging } from '../types';
import { ErrorBox, SourceBadge, Spinner, toast } from '../components/ui';

interface Form {
  title: string;
  subtitle: string;
  authors: string;
  series: string;
  seriesIndex: string;
  publisher: string;
  year: string;
  isbn: string;
  language: string;
  tags: string;
  description: string;
}
type Field = keyof Form;

interface Candidate {
  source: string;
  crossLanguage?: boolean;
  meta: Partial<Meta>;
  coverUrl?: string;
  link?: string;
}
interface Lookup {
  merged: Partial<Record<Field | 'cover', { value: any; source: string }>>;
  candidates: Candidate[];
  warnings?: string[];
  generated?: string[];
  empty?: string[];
  foundOnline?: boolean;
  ai?: boolean;
}
interface Preview {
  fileName: string;
  relPath: string;
  before: { name: string };
  duplicates: { id: number; title: string; authors: string; path: string }[];
  warnings: string[];
  sentToKindle: boolean;
}

const FIELD_LABEL: Record<string, string> = { title: 'título', series: 'série', seriesIndex: 'ordem na série', publisher: 'editora', year: 'ano', tags: 'tags', description: 'descrição', isbn: 'ISBN' };
const names = (l: string[]) => l.map((k) => FIELD_LABEL[k] ?? k).join(', ');

function buildNotes(res: Lookup): { tone: 'warn' | 'info'; text: string; link?: boolean }[] {
  const out: { tone: 'warn' | 'info'; text: string; link?: boolean }[] = [];
  for (const w of res.warnings ?? []) out.push({ tone: 'warn', text: w, link: /chave/i.test(w) });
  if (res.foundOnline === false) out.push({ tone: 'warn', text: 'Nenhum site encontrou este livro com os dados que o arquivo tem (título/autor/ISBN).' });
  if (res.generated?.length)
    out.push({ tone: 'info', text: `Criado automaticamente (marcado como "Gerado"): ${names(res.generated)}.${res.ai ? '' : ' Sem chave de IA (Gemini ou Anthropic), a sinopse é só um texto-padrão e as tags não são criadas.'}` });
  if (res.empty?.length) out.push({ tone: 'warn', text: `Ainda em branco: ${names(res.empty)}. Preencha à mão abaixo.`, link: !res.ai });
  return out;
}

const empty: Form = { title: '', subtitle: '', authors: '', series: '', seriesIndex: '', publisher: '', year: '', isbn: '', language: '', tags: '', description: '' };

const toForm = (m: Partial<Meta>): Partial<Form> => ({
  title: m.title ?? '',
  subtitle: m.subtitle ?? '',
  authors: (m.authors ?? []).join('; '),
  series: m.series ?? '',
  seriesIndex: m.seriesIndex != null ? String(m.seriesIndex) : '',
  publisher: m.publisher ?? '',
  year: m.year != null ? String(m.year) : '',
  isbn: m.isbn ?? '',
  language: m.language ?? '',
  tags: (m.tags ?? []).join(', '),
  description: m.description ?? '',
});

const toMeta = (f: Form): Meta => ({
  title: f.title.trim() || undefined,
  subtitle: f.subtitle.trim() || undefined,
  authors: f.authors.split(/\s*;\s*|\s+&\s+/).map((a) => a.trim()).filter(Boolean),
  series: f.series.trim() || undefined,
  seriesIndex: f.seriesIndex.trim() ? Number(f.seriesIndex.replace(',', '.')) : undefined,
  publisher: f.publisher.trim() || undefined,
  year: f.year.trim() ? Number(f.year) : undefined,
  isbn: f.isbn.trim() || undefined,
  language: f.language.trim() || undefined,
  tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
  description: f.description.trim() || undefined,
});

function Labeled({ label, source, children, className = '' }: { label: string; source?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label">
        {label} <SourceBadge source={source} />
      </span>
      {children}
    </label>
  );
}

export default function Editor() {
  const { id } = useParams();
  const nav = useNavigate();
  const [item, setItem] = useState<Staging | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<Form>(empty);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState<{ tone: 'warn' | 'info'; text: string; link?: boolean }[]>([]);
  const manual = useRef(new Set<Field>());
  const formRef = useRef(form);
  formRef.current = form;
  const itemRef = useRef<Staging | null>(null);

  const applyFields = useCallback((values: Partial<Form>, src: (f: Field) => string, respectManual: boolean) => {
    setForm((f) => {
      const next = { ...f };
      for (const [k, v] of Object.entries(values) as [Field, string][]) {
        if (respectManual && manual.current.has(k)) continue;
        if (v === '' || v === undefined) continue;
        next[k] = v;
      }
      return next;
    });
    setSources((s) => {
      const next = { ...s };
      for (const [k, v] of Object.entries(values) as [Field, string][]) {
        if (respectManual && manual.current.has(k)) continue;
        if (v === '' || v === undefined) continue;
        next[k === 'seriesIndex' ? 'seriesIndex' : k] = src(k);
      }
      return next;
    });
  }, []);

  const runLookup = useCallback(
    async (initial = false) => {
      setLooking(true);
      try {
        const f = formRef.current;
        const body = initial ? {} : { title: f.title, authors: toMeta(f).authors, isbn: f.isbn };
        const res = await api<Lookup>(`/api/ingest/${id}/lookup`, { body });
        setLookup(res);
        const online = res.merged.cover?.value as string | undefined;
        if (online && !itemRef.current?.cover) setCoverUrl((cur) => cur ?? online);
        const values: Partial<Form> = {};
        const srcMap: Record<string, string> = {};
        for (const [k, s] of Object.entries(res.merged)) {
          if (k === 'cover') continue;
          const asForm = toForm({ [k === 'authors' ? 'authors' : k]: s!.value } as Partial<Meta>);
          (values as any)[k] = (asForm as any)[k];
          srcMap[k] = s!.source;
        }
        applyFields(values, (k) => srcMap[k] ?? 'manual', true);
        setNotes(buildNotes(res));
      } catch (e: any) {
        toast(`Busca de metadados falhou: ${e.message}`, 'err');
      } finally {
        setLooking(false);
      }
    },
    [id, applyFields],
  );

  useEffect(() => {
    let alive = true;
    setItem(null);
    api<Staging>(`/api/ingest/${id}`)
      .then((s) => {
        if (!alive) return;
        setItem(s);
        itemRef.current = s;
        setForm({ ...empty, ...toForm(s.meta) });
        setSources(s.sources);
        void runLookup(true);
      })
      .catch((e) => setLoadError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // live preview of the final file name and folder
  const meta = useMemo(() => toMeta(form), [form]);
  useEffect(() => {
    if (!item) return;
    const t = setTimeout(() => {
      api<Preview>(`/api/ingest/${id}/preview`, { body: { meta } })
        .then((p) => {
          setPreview(p);
          setPreviewError('');
        })
        .catch((e) => setPreviewError(e.message));
    }, 300);
    return () => clearTimeout(t);
  }, [meta, item, id]);

  const edit = (k: Field) => (e: { target: { value: string } }) => {
    manual.current.add(k);
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setSources((s) => ({ ...s, [k]: 'manual' }));
  };

  const useCandidate = (c: Candidate) => {
    applyFields(toForm(c.meta), () => c.source, false);
    for (const k of Object.keys(toForm(c.meta)) as Field[]) manual.current.delete(k);
    if (c.coverUrl) setCoverUrl(c.coverUrl);
  };

  const save = async (force = false) => {
    setSaving(true);
    try {
      const book = await api(`/api/ingest/${id}/commit`, { body: { meta, sources, coverUrl, force } });
      toast('Livro salvo na pasta Livros ✓');
      nav(`/livro/${book.id}`);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'DUPLICATE' && window.confirm('Já existe um livro igual na biblioteca. Salvar mesmo assim?')) return save(true);
      if (err.code === 'KINDLE_SENT' && window.confirm('Este livro já está no Kindle. Mudar nome/metadados faz o KOReader tratá-lo como livro novo (notas e progresso ficam no arquivo antigo). Continuar?')) return save(true);
      if (err.code !== 'DUPLICATE' && err.code !== 'KINDLE_SENT') toast(err.message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const discard = async () => {
    if (!window.confirm('Descartar este item da fila? O arquivo original não é apagado.')) return;
    await api(`/api/ingest/${id}`, { method: 'DELETE' });
    nav('/adicionar');
  };

  if (loadError) return <ErrorBox message={loadError} />;
  if (!item) return <Spinner />;

  const alternatives = (lookup?.candidates ?? []).filter((c) => c.source !== 'embedded' && c.source !== 'filename');
  const covers = [...new Set(alternatives.map((c) => c.coverUrl).filter(Boolean) as string[])];
  const src = (k: Field) => sources[k];

  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/adicionar" className="text-sm text-muted hover:text-ink">
          ‹ Fila
        </Link>
        <h1 className="text-2xl font-bold">{item.book_id ? 'Reorganizar livro' : 'Revisar livro'}</h1>
        <span className="chip max-w-xs truncate">{item.original_name}</span>
        <button className="btn-ghost ml-auto" onClick={() => runLookup(false)} disabled={looking}>
          {looking ? 'Buscando…' : '↻ Buscar metadados de novo'}
        </button>
      </div>

      {notes.length > 0 && (
        <ul className="mt-4 space-y-1.5 rounded-lg border border-line bg-surface p-3 text-sm" aria-live="polite">
          {notes.map((n, i) => (
            <li key={i} className={n.tone === 'warn' ? 'text-warn' : 'text-ink/85'}>
              {n.tone === 'warn' ? '⚠ ' : 'ℹ '}
              {n.text}
              {n.link && (
                <>
                  {' '}
                  <Link to="/ajustes" className="underline">
                    Abrir Ajustes
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-[14rem_1fr]">
        <aside className="space-y-4">
          <div>
            <div className="label">Capa</div>
            {coverUrl || item.cover ? (
              <img src={coverUrl ?? `/covers/${item.cover}`} alt="Capa" className="aspect-[2/3] w-full rounded-md object-cover" />
            ) : (
              <div className="flex aspect-[2/3] w-full items-center justify-center rounded-md bg-surface2 text-xs text-muted">sem capa</div>
            )}
            {covers.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {item.cover && (
                  <button onClick={() => setCoverUrl(null)} className={`h-14 w-10 overflow-hidden rounded border-2 ${!coverUrl ? 'border-accent' : 'border-line'}`} title="Manter a capa do arquivo">
                    <img src={`/covers/${item.cover}`} alt="" className="h-full w-full object-cover" />
                  </button>
                )}
                {covers.map((c) => (
                  <button key={c} onClick={() => setCoverUrl(c)} className={`h-14 w-10 overflow-hidden rounded border-2 ${coverUrl === c ? 'border-accent' : 'border-line'}`}>
                    <img src={c} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
            {!item.cover && !coverUrl && covers[0] && (
              <button className="mt-2 text-xs text-accent2 hover:underline" onClick={() => setCoverUrl(covers[0])}>
                usar capa encontrada
              </button>
            )}
          </div>
        </aside>

        <div className="space-y-8">
          <section className="card">
            <div className="grid gap-4 sm:grid-cols-2">
              <Labeled label="Título" source={src('title')} className="sm:col-span-2">
                <input className="input" value={form.title} onChange={edit('title')} />
              </Labeled>
              <Labeled label="Subtítulo" source={src('subtitle')} className="sm:col-span-2">
                <input className="input" value={form.subtitle} onChange={edit('subtitle')} />
              </Labeled>
              <Labeled label="Autor(es) — separe por ;" source={src('authors')} className="sm:col-span-2">
                <input className="input" value={form.authors} onChange={edit('authors')} />
              </Labeled>
              <Labeled label="Série" source={src('series')}>
                <input className="input" value={form.series} onChange={edit('series')} placeholder="Ex.: Mistborn" />
              </Labeled>
              <Labeled label="Ordem na série" source={src('seriesIndex')}>
                <input className="input" type="number" step="0.5" min="0" value={form.seriesIndex} onChange={edit('seriesIndex')} disabled={!form.series} />
              </Labeled>
              <Labeled label="Editora" source={src('publisher')}>
                <input className="input" value={form.publisher} onChange={edit('publisher')} />
              </Labeled>
              <Labeled label="Ano desta edição" source={src('year')}>
                <input className="input" type="number" min="1400" max="2100" value={form.year} onChange={edit('year')} />
              </Labeled>
              <Labeled label="ISBN" source={src('isbn')}>
                <input className="input" value={form.isbn} onChange={edit('isbn')} />
              </Labeled>
              <Labeled label="Idioma" source={src('language')}>
                <input className="input" value={form.language} onChange={edit('language')} placeholder="pt, en…" />
              </Labeled>
              <Labeled label="Tags — separe por vírgula" source={src('tags')} className="sm:col-span-2">
                <input className="input" value={form.tags} onChange={edit('tags')} />
              </Labeled>
              <Labeled label="Descrição" source={src('description')} className="sm:col-span-2">
                <textarea className="input min-h-32" value={form.description} onChange={edit('description')} />
              </Labeled>
            </div>
          </section>

          {alternatives.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold">Outras correspondências encontradas</h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                {alternatives.map((c, i) => (
                  <li key={i} className="flex gap-3 rounded-lg border border-line bg-surface p-3">
                    {c.coverUrl ? <img src={c.coverUrl} alt="" className="h-20 w-14 shrink-0 rounded object-cover" /> : <div className="h-20 w-14 shrink-0 rounded bg-surface2" />}
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="line-clamp-2 font-medium leading-tight">{c.meta.title}</div>
                      <div className="truncate text-xs text-muted">{c.meta.authors?.join(', ')}</div>
                      <div className="truncate text-xs text-muted">{[c.meta.publisher, c.meta.year].filter(Boolean).join(' · ')}</div>
                      <div className="mt-1 flex items-center gap-2">
                        <SourceBadge source={c.source} />
                        {c.crossLanguage && <span className="chip !py-0 text-[10px] text-warn" title="Edição em outro idioma que o do arquivo">outro idioma</span>}
                        <button className="text-xs text-accent2 hover:underline" onClick={() => useCandidate(c)}>
                          usar este
                        </button>
                        {c.link && (
                          <a className="text-xs text-muted hover:text-ink" href={c.link} target="_blank" rel="noreferrer">
                            abrir ↗
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card sticky bottom-3 z-10 border-accent/40 bg-surface/95 shadow-2xl shadow-black/50 backdrop-blur">
            <div className="label">Arquivo final</div>
            {previewError ? (
              <div className="text-sm text-accent2">{previewError}</div>
            ) : preview ? (
              <div className="space-y-1 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-muted line-through decoration-muted/40">{preview.before.name}</span>
                  <span className="text-muted">→</span>
                  <span className="break-all font-mono font-semibold text-ok">{preview.fileName}</span>
                </div>
                <div className="break-all font-mono text-xs text-muted">Livros\{preview.relPath}</div>
                {preview.warnings.map((w) => (
                  <div key={w} className="text-xs text-warn">
                    ⚠ {w}
                  </div>
                ))}
                {preview.duplicates.length > 0 && (
                  <div className="text-xs text-warn">
                    ⚠ Já existe na biblioteca:{' '}
                    {preview.duplicates.map((d) => (
                      <Link key={d.id} to={`/livro/${d.id}`} className="underline">
                        {d.title}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm text-muted">Calculando…</div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-primary" disabled={saving || !!previewError || !meta.title} onClick={() => save(false)}>
                {saving ? 'Salvando…' : 'Salvar na pasta Livros'}
              </button>
              <button className="btn-ghost" onClick={discard}>
                Descartar
              </button>
              <span className="self-center text-xs text-muted">O original não é alterado. Desfazer fica disponível em Adicionar.</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
