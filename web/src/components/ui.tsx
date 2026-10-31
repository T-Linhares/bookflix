import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, coverSrc } from '../api';
import { Book, SOURCE_LABEL } from '../types';

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(() => {
    setLoading(true);
    fn()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { data, error, loading, reload: run, setData };
}

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Cover image, or a generated cover when the book has none. */
export function Cover({ book, className = '' }: { book: Pick<Book, 'title' | 'authors' | 'cover'>; className?: string }) {
  const src = coverSrc(book);
  const h = hue(book.title ?? '?');
  return src ? (
    <img src={src} alt={book.title ?? ''} loading="lazy" className={`aspect-[2/3] w-full rounded-md object-cover ${className}`} />
  ) : (
    <div
      className={`flex aspect-[2/3] w-full flex-col justify-between rounded-md p-3 text-left ${className}`}
      style={{ background: `linear-gradient(160deg, hsl(${h} 55% 28%), hsl(${(h + 40) % 360} 60% 14%))` }}
    >
      <span className="line-clamp-4 text-sm font-bold leading-tight text-white/95">{book.title ?? 'Sem título'}</span>
      <span className="line-clamp-2 text-[11px] text-white/70">{book.authors}</span>
    </div>
  );
}

export function Poster({ book, to }: { book: Book; to?: string }) {
  return (
    <Link to={to ?? `/livro/${book.id}`} className="group relative block w-36 shrink-0 sm:w-40" title={book.title ?? ''}>
      <div className="relative overflow-hidden rounded-md transition duration-200 group-hover:z-10 group-hover:scale-105 group-hover:shadow-2xl group-hover:shadow-black/60">
        <Cover book={book} />
        {book.status === 'reading' && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <div className="h-full bg-accent" style={{ width: `${Math.round(book.progress * 100)}%` }} />
          </div>
        )}
        <div className="absolute right-1.5 top-1.5 flex flex-col gap-1">
          {book.status === 'read' && <Badge title="Lido" className="bg-ok text-black">✓</Badge>}
          {book.sent_to_kindle ? <Badge title="No Kindle" className="bg-black/70 text-white">K</Badge> : book.organized ? <Badge title="Pronto para o Kindle" className="bg-warn text-black">↑</Badge> : null}
        </div>
      </div>
      <div className="mt-2 px-0.5">
        <div className="line-clamp-1 text-sm font-medium">{book.title}</div>
        <div className="line-clamp-1 text-xs text-muted">{book.authors}</div>
      </div>
    </Link>
  );
}

function Badge({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${className}`}>
      {children}
    </span>
  );
}

export function Row({ title, children, to, count }: { title: string; children: ReactNode; to?: string; count?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: number) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <section className="group/row relative">
      <div className="mb-2 flex items-baseline gap-3 px-4 sm:px-8">
        <h2 className="text-lg font-semibold">{title}</h2>
        {count !== undefined && <span className="text-xs text-muted">{count}</span>}
        {to && (
          <Link to={to} className="text-xs text-muted opacity-0 transition hover:text-ink group-hover/row:opacity-100">
            Ver tudo ›
          </Link>
        )}
      </div>
      <div className="relative">
        <button aria-label="Anterior" onClick={() => scroll(-1)} className="absolute left-0 top-0 z-20 hidden h-[calc(100%-3rem)] w-10 items-center justify-center bg-gradient-to-r from-bg to-transparent text-2xl opacity-0 transition group-hover/row:opacity-100 md:flex">
          ‹
        </button>
        <div ref={ref} className="no-scrollbar flex gap-3 overflow-x-auto px-4 pb-4 pt-2 sm:px-8">
          {children}
        </div>
        <button aria-label="Próximo" onClick={() => scroll(1)} className="absolute right-0 top-0 z-20 hidden h-[calc(100%-3rem)] w-10 items-center justify-center bg-gradient-to-l from-bg to-transparent text-2xl opacity-0 transition group-hover/row:opacity-100 md:flex">
          ›
        </button>
      </div>
    </section>
  );
}

export function Stars({ value, onChange, size = 'text-xl' }: { value: number | null; onChange?: (v: number | null) => void; size?: string }) {
  return (
    <span className={`inline-flex ${size} leading-none`} role={onChange ? 'radiogroup' : 'img'} aria-label={`Nota ${value ?? 0} de 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={!onChange}
          aria-label={`${n} estrelas`}
          onClick={() => onChange?.(value === n ? null : n)}
          className={`px-0.5 transition ${n <= (value ?? 0) ? 'text-warn' : 'text-line'} ${onChange ? 'hover:scale-125 hover:text-warn' : 'cursor-default'}`}
        >
          ★
        </button>
      ))}
    </span>
  );
}

export function SourceBadge({ source }: { source?: string }) {
  if (!source) return null;
  const color =
    source === 'gerado' ? 'bg-warn/15 text-warn' : source === 'manual' ? 'bg-accent/15 text-accent2' : source === 'google' || source === 'openlibrary' || source === 'brasilapi' ? 'bg-ok/15 text-ok' : 'bg-surface2 text-muted';
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal ${color}`}>{SOURCE_LABEL[source] ?? source}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 p-8 text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label ?? 'Carregando…'}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-6 py-20 text-center">
      <div className="text-lg font-semibold">{title}</div>
      <div className="mt-2 text-sm text-muted">{children}</div>
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="m-4 rounded-md border border-accent/40 bg-accent/10 p-3 text-sm text-accent2">{message}</div>;
}

// ---------- toast ----------

type ToastMsg = { id: number; text: string; kind: 'ok' | 'err' };
let push: ((t: Omit<ToastMsg, 'id'>) => void) | null = null;
export const toast = (text: string, kind: 'ok' | 'err' = 'ok') => push?.({ text, kind });

export function Toaster() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  useEffect(() => {
    let n = 0;
    push = (t) => {
      const id = ++n;
      setItems((s) => [...s, { ...t, id }]);
      setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 4500);
    };
    return () => {
      push = null;
    };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
      {items.map((t) => (
        <div key={t.id} className={`pointer-events-auto max-w-sm rounded-md border px-4 py-2.5 text-sm shadow-xl ${t.kind === 'ok' ? 'border-ok/40 bg-surface text-ink' : 'border-accent/50 bg-surface text-accent2'}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
