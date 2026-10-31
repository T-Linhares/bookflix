import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, coverSrc, describeSend, sendToKindle } from '../api';
import { Book, BookDetail, Highlight, Rec, STATUS_LABEL, Status } from '../types';
import { Cover, ErrorBox, Poster, Row, SourceBadge, Spinner, Stars, toast, useAsync } from '../components/ui';

const fmtTime = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);

function HighlightItem({ h, onChange }: { h: Highlight; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(h.text ?? '');
  const [note, setNote] = useState(h.note ?? '');
  const save = async () => {
    await api(`/api/highlights/${h.id}`, { method: 'PATCH', body: { text, note: note.trim() || null } });
    setEditing(false);
    onChange();
    toast('Nota salva');
  };
  const remove = async () => {
    if (!window.confirm('Apagar este destaque/nota?')) return;
    await api(`/api/highlights/${h.id}`, { method: 'DELETE' });
    onChange();
  };
  return (
    <li className="group rounded-lg border border-line bg-surface p-4">
      {editing ? (
        <div className="space-y-2">
          <textarea className="input min-h-20" value={text} onChange={(e) => setText(e.target.value)} aria-label="Trecho" />
          <textarea className="input min-h-16" placeholder="Sua nota (opcional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Nota" />
          <div className="flex gap-2">
            <button className="btn-primary" onClick={save}>
              Salvar
            </button>
            <button className="btn-ghost" onClick={() => setEditing(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <>
          <blockquote className="whitespace-pre-line border-l-2 border-accent pl-3 text-[15px] leading-relaxed">{h.text}</blockquote>
          {h.note && (
            <div className="mt-2 rounded bg-surface2 px-3 py-2 text-sm">
              <span className="mr-1 font-semibold text-warn">Nota:</span>
              {h.note}
            </div>
          )}
          <div className="mt-2 flex items-center gap-3 text-xs text-muted">
            <span className="truncate">{[h.chapter, h.page && `p. ${h.page}`, h.created_at?.slice(0, 10)].filter(Boolean).join(' · ')}</span>
            {h.edited ? <span className="chip !py-0 text-[10px]">editado</span> : null}
            <span className="ml-auto flex gap-3 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
              <button className="hover:text-ink" onClick={() => setEditing(true)}>
                Editar
              </button>
              <button className="hover:text-accent2" onClick={remove}>
                Apagar
              </button>
            </span>
          </div>
        </>
      )}
    </li>
  );
}

function Recommendations({ book }: { book: BookDetail }) {
  const { data, loading, reload } = useAsync(() => api<Rec[]>(`/api/books/${book.id}/recommendations`), [book.id]);
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const dismiss = async (r: Rec) => {
    await api('/api/recommendations/dismiss', { body: { title: r.title, author: r.authors[0] } });
    setHidden((s) => new Set(s).add(r.key));
    toast('Ok, não vou sugerir esse de novo');
  };
  const wish = async (r: Rec) => {
    const on = local[r.key] ?? r.wishlisted;
    if (on) await api(`/api/wishlist/${encodeURIComponent(r.key)}`, { method: 'DELETE' });
    else await api('/api/wishlist', { body: { key: r.key, title: r.title, authors: r.authors, coverUrl: r.coverUrl, description: r.description, link: r.link, year: r.year } });
    setLocal((s) => ({ ...s, [r.key]: !on }));
    toast(on ? 'Removido de "Quero ler"' : 'Adicionado a "Quero ler"');
  };
  if (loading) return <Spinner label="Buscando recomendações…" />;
  const visible = (data ?? []).filter((r) => !hidden.has(r.key));
  if (!visible.length)
    return (
      <div className="px-4 text-sm text-muted sm:px-8">
        Sem recomendações por enquanto (sem internet ou sem resultados).{' '}
        <button className="text-accent2 underline" onClick={() => api(`/api/books/${book.id}/recommendations?refresh=1`).then(reload)}>
          Tentar de novo
        </button>
      </div>
    );
  return (
    <Row title="Recomendados a partir deste" count={visible.length}>
      {visible.map((r) => {
        const on = local[r.key] ?? r.wishlisted;
        return (
          <div key={r.key} className="group relative w-40 shrink-0 sm:w-44">
            <a href={r.link} target="_blank" rel="noreferrer" title={r.description}>
              <div className="overflow-hidden rounded-md transition group-hover:scale-[1.03]">
                {r.coverUrl ? <img src={r.coverUrl} alt={r.title} loading="lazy" className="aspect-[2/3] w-full object-cover" /> : <Cover book={{ title: r.title, authors: r.authors.join(', '), cover: null }} />}
              </div>
              <div className="mt-2 line-clamp-2 text-sm font-medium leading-tight">{r.title}</div>
              <div className="line-clamp-1 text-xs text-muted">{r.authors.join(', ')}</div>
            </a>
            <div className="mt-1 line-clamp-2 text-[11px] text-accent2/90">{r.reason}</div>
            <div className="mt-2 flex gap-1.5">
              <button onClick={() => wish(r)} className={`flex-1 rounded border px-2 py-1 text-xs transition ${on ? 'border-ok/50 bg-ok/10 text-ok' : 'border-line hover:border-muted'}`}>
                {on ? '✓ Quero ler' : '+ Quero ler'}
              </button>
              <button onClick={() => dismiss(r)} title="Já tenho este livro (talvez em outro idioma) ou não me interessa" className="rounded border border-line px-2 py-1 text-xs text-muted transition hover:border-accent hover:text-accent2">
                Já tenho
              </button>
            </div>
          </div>
        );
      })}
    </Row>
  );
}

export default function BookPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: book, error, loading, reload } = useAsync(() => api<BookDetail>(`/api/books/${id}`), [id]);
  const [tab, setTab] = useState<'notes' | 'review' | 'about'>('notes');
  const [review, setReview] = useState('');
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const [newNote, setNewNote] = useState('');
  const [seriesBooks, setSeriesBooks] = useState<Book[]>([]);

  useEffect(() => {
    setReview(book?.review ?? '');
    if (book?.series) api(`/api/books?series=${encodeURIComponent(book.series)}&sort=series&limit=50`).then((d) => setSeriesBooks(d.items));
    else setSeriesBooks([]);
  }, [book?.id, book?.series, book?.review]);

  if (loading && !book) return <Spinner />;
  if (error || !book) return <ErrorBox message={error ?? 'Livro não encontrado'} />;

  const patch = async (body: object) => {
    await api(`/api/books/${book.id}`, { method: 'PATCH', body });
    reload();
  };
  const organize = async () => {
    try {
      const s = await api(`/api/ingest/from-library/${book.id}`, { method: 'POST' });
      nav(`/editor/${s.id}`);
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };
  const sendKindle = async () => {
    try {
      const m = describeSend(await sendToKindle({ bookIds: [book.id] }));
      toast(m.text, m.kind);
      reload();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };
  const addNote = async () => {
    if (!newText.trim() && !newNote.trim()) return;
    await api(`/api/books/${book.id}/highlights`, { body: { text: newText, note: newNote || null } });
    setNewText('');
    setNewNote('');
    setAdding(false);
    reload();
  };
  const src = coverSrc(book);
  const totalSeconds = book.days.reduce((s, d) => s + d.seconds, 0);

  return (
    <div>
      <section className="relative isolate overflow-hidden">
        {src && <img src={src} alt="" className="absolute inset-0 -z-10 h-full w-full scale-125 object-cover opacity-25 blur-2xl" />}
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-bg via-bg/70 to-bg/30" />
        <div className="flex flex-col gap-6 px-4 pb-8 pt-6 sm:flex-row sm:px-8 sm:pt-10">
          <div className="w-40 shrink-0 sm:w-56">
            <Cover book={book} className="shadow-2xl shadow-black/70" />
          </div>
          <div className="min-w-0 flex-1">
            {book.series && (
              <Link to={`/biblioteca?series=${encodeURIComponent(book.series)}&sort=series`} className="text-xs font-semibold uppercase tracking-widest text-accent2 hover:underline">
                {book.series}
                {book.series_index != null && ` · Livro ${book.series_index}`}
              </Link>
            )}
            <h1 className="text-3xl font-black leading-tight sm:text-4xl">{book.title}</h1>
            {book.subtitle && <div className="text-lg text-muted">{book.subtitle}</div>}
            <div className="mt-1 text-ink/90">
              {book.authors.split(';').map((a, i) => (
                <span key={a}>
                  {i > 0 && ', '}
                  <Link to={`/biblioteca?author=${encodeURIComponent(a.trim())}`} className="hover:underline">
                    {a.trim()}
                  </Link>
                </span>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              {book.publisher && <span>{book.publisher}</span>}
              {book.year && <span>Edição de {book.year}</span>}
              <span className="uppercase">{book.format}</span>
              {book.pages && <span>{book.pages} págs.</span>}
              {book.isbn && <span>ISBN {book.isbn}</span>}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-4">
              <select className="input !w-auto" value={book.status} onChange={(e) => patch({ status: e.target.value as Status })} aria-label="Status de leitura">
                {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              <Stars value={book.rating} onChange={(v) => patch({ rating: v })} size="text-2xl" />
              {(book.status === 'reading' || book.progress > 0) && (
                <div className="flex items-center gap-2 text-sm">
                  <div className="h-1.5 w-32 overflow-hidden rounded bg-line">
                    <div className="h-full bg-accent" style={{ width: `${Math.round(book.progress * 100)}%` }} />
                  </div>
                  {Math.round(book.progress * 100)}%
                </div>
              )}
              {totalSeconds > 0 && <span className="text-sm text-muted">⏱ {fmtTime(totalSeconds)} de leitura</span>}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {book.tags.map((t) => (
                <Link key={t} to={`/biblioteca?tags=${encodeURIComponent(t)}`} className="chip hover:border-accent">
                  {t}
                </Link>
              ))}
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <button className="btn-primary" onClick={organize}>
                Editar metadados / reorganizar
              </button>
              <a className="btn-ghost" href={`/api/books/${book.id}/export.md`}>
                Exportar notas (.md)
              </a>
              {!book.sent_to_kindle && (
                <button className="btn-ghost" onClick={sendKindle}>
                  Enviar ao Kindle
                </button>
              )}
              {book.sent_to_kindle ? <span className="chip self-center">No Kindle</span> : book.organized ? <span className="chip self-center !border-warn/50 text-warn">Pronto para enviar ao Kindle</span> : <span className="chip self-center">Ainda não organizado</span>}
            </div>
          </div>
        </div>
      </section>

      <div className="px-4 sm:px-8">
        <div role="tablist" className="flex gap-1 border-b border-line">
          {(
            [
              ['notes', `Notas e destaques (${book.highlights.length})`],
              ['review', 'Resenha'],
              ['about', 'Sobre'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-4 py-2.5 text-sm transition ${tab === k ? 'border-accent font-semibold' : 'border-transparent text-muted hover:text-ink'}`}>
              {l}
            </button>
          ))}
        </div>

        <div className="max-w-3xl py-6">
          {tab === 'notes' && (
            <div className="space-y-3">
              {!book.highlights.length && !adding && (
                <p className="text-sm text-muted">Nenhum destaque ainda. Importe os dados do Kindle em <Link to="/kindle" className="text-accent2 underline">Kindle</Link> ou adicione uma nota manualmente.</p>
              )}
              <ul className="space-y-3">
                {book.highlights.map((h) => (
                  <HighlightItem key={h.id} h={h} onChange={reload} />
                ))}
              </ul>
              {adding ? (
                <div className="space-y-2 rounded-lg border border-line bg-surface p-4">
                  <textarea className="input min-h-20" placeholder="Trecho (opcional)" value={newText} onChange={(e) => setNewText(e.target.value)} />
                  <textarea className="input min-h-16" placeholder="Sua nota" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
                  <div className="flex gap-2">
                    <button className="btn-primary" onClick={addNote}>
                      Adicionar
                    </button>
                    <button className="btn-ghost" onClick={() => setAdding(false)}>
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn-ghost" onClick={() => setAdding(true)}>
                  + Nova nota
                </button>
              )}
            </div>
          )}

          {tab === 'review' && (
            <div className="space-y-3">
              <textarea className="input min-h-48" placeholder="Escreva sua resenha…" value={review} onChange={(e) => setReview(e.target.value)} />
              <button
                className="btn-primary"
                disabled={review === (book.review ?? '')}
                onClick={async () => {
                  await patch({ review });
                  toast('Resenha salva');
                }}
              >
                Salvar resenha
              </button>
            </div>
          )}

          {tab === 'about' && (
            <div className="space-y-4 text-sm">
              <p className="whitespace-pre-line text-base leading-relaxed text-ink/90">{book.description || 'Sem descrição.'}</p>
              <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 rounded-lg border border-line bg-surface p-4">
                <dt className="text-muted">Arquivo</dt>
                <dd className="break-all">{book.path}</dd>
                <dt className="text-muted">Origem dos dados</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {Object.entries(book.sources).map(([k, v]) => (
                    <span key={k} className="inline-flex items-center gap-1 text-xs text-muted">
                      {k}: <SourceBadge source={v} />
                    </span>
                  ))}
                  {!Object.keys(book.sources).length && '—'}
                </dd>
              </dl>
              {book.days.length > 0 && (
                <div>
                  <div className="label">Dias de leitura</div>
                  <div className="flex flex-wrap gap-1.5">
                    {book.days.slice(-30).map((d) => (
                      <span key={d.day} className="chip" title={`${d.pages} págs.`}>
                        {d.day.slice(5)} · {Math.round(d.seconds / 60)} min
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4 pt-2">
        {seriesBooks.length > 1 && (
          <Row title={`Nesta série: ${book.series}`} count={seriesBooks.length}>
            {seriesBooks.map((b) => (
              <Poster key={b.id} book={b} />
            ))}
          </Row>
        )}
        <Recommendations book={book} />
      </div>
    </div>
  );
}
