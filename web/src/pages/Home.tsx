import { Link } from 'react-router-dom';
import { api, coverSrc } from '../api';
import { Book } from '../types';
import { Cover, Empty, ErrorBox, Poster, Row, Spinner, useAsync } from '../components/ui';

interface HomeData {
  hero: (Book & { description?: string }) | null;
  rows: { id: string; title: string; kind: 'books' | 'series' | 'wishlist'; items: any[]; query?: string; savedId?: number }[];
}

function Hero({ book }: { book: Book & { description?: string } }) {
  const src = coverSrc(book);
  return (
    <section className="relative isolate overflow-hidden">
      {src && <img src={src} alt="" className="absolute inset-0 -z-10 h-full w-full scale-125 object-cover opacity-30 blur-2xl" />}
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-bg via-bg/60 to-bg/20" />
      <div className="flex flex-col gap-6 px-4 pb-10 pt-8 sm:flex-row sm:items-end sm:px-8 sm:pt-14">
        <div className="w-36 shrink-0 sm:w-52">
          <Cover book={book} className="shadow-2xl shadow-black/70" />
        </div>
        <div className="max-w-2xl">
          <div className="text-xs font-semibold uppercase tracking-widest text-accent2">{book.status === 'reading' ? 'Continue de onde parou' : 'Para você'}</div>
          <h1 className="mt-1 text-3xl font-black leading-tight sm:text-5xl">{book.title}</h1>
          <div className="mt-1 text-muted">
            {book.authors}
            {book.series && ` · ${book.series}${book.series_index != null ? ` #${book.series_index}` : ''}`}
          </div>
          {book.status === 'reading' && (
            <div className="mt-3 flex items-center gap-3 text-sm">
              <div className="h-1.5 w-48 overflow-hidden rounded bg-line">
                <div className="h-full bg-accent" style={{ width: `${Math.round(book.progress * 100)}%` }} />
              </div>
              {Math.round(book.progress * 100)}%
            </div>
          )}
          {book.description && <p className="mt-3 line-clamp-3 text-sm text-ink/85 sm:text-base">{book.description}</p>}
          <div className="mt-5 flex gap-3">
            <Link to={`/livro/${book.id}`} className="btn-primary">
              Abrir livro
            </Link>
            {book.series && (
              <Link to={`/biblioteca?series=${encodeURIComponent(book.series)}&sort=series`} className="btn-ghost">
                Ver série
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const { data, error, loading } = useAsync(() => api<HomeData>('/api/home'), []);
  const settings = useAsync(() => api('/api/settings'), []);

  if (loading) return <Spinner />;
  if (error) return <ErrorBox message={error} />;
  if (!data || (!data.rows.length && !data.hero)) {
    const noFolder = settings.data && !settings.data.booksDir;
    return (
      <Empty title={noFolder ? 'Vamos começar' : 'Sua biblioteca está vazia'}>
        {noFolder ? (
          <>
            Escolha a pasta da sua biblioteca (pode ser uma pasta do Dropbox ou do Google Drive, para ter os livros em outros aparelhos) em{' '}
            <Link to="/ajustes" className="text-accent2 underline">
              Ajustes
            </Link>
            .
          </>
        ) : (
          <>
            Passe seu primeiro livro por{' '}
            <Link to="/adicionar" className="text-accent2 underline">
              Adicionar
            </Link>{' '}
            ou coloque arquivos na pasta Livros.
          </>
        )}
      </Empty>
    );
  }

  return (
    <div>
      {data.hero && <Hero book={data.hero} />}
      <div className="space-y-4">
        {data.rows.map((row) => {
          if (row.kind === 'series')
            return (
              <Row key={row.id} title={row.title} to="/biblioteca?sort=series" count={row.items.length}>
                {row.items.map((b: Book) => (
                  <Link key={b.series!} to={`/biblioteca?series=${encodeURIComponent(b.series!)}&sort=series`} className="group w-36 shrink-0 sm:w-40">
                    <div className="relative">
                      <div className="absolute inset-0 -z-10 translate-x-1.5 translate-y-1.5 rounded-md bg-surface2" />
                      <div className="overflow-hidden rounded-md transition group-hover:scale-105">
                        <Cover book={b} />
                      </div>
                    </div>
                    <div className="mt-2 line-clamp-1 text-sm font-medium">{b.series}</div>
                    <div className="text-xs text-muted">
                      {b.series_count} livros · {b.series_read} lidos
                    </div>
                  </Link>
                ))}
              </Row>
            );
          if (row.kind === 'wishlist')
            return (
              <Row key={row.id} title={row.title} count={row.items.length}>
                {row.items.map((w) => (
                  <a key={w.key} href={w.link} target="_blank" rel="noreferrer" className="group w-36 shrink-0 sm:w-40">
                    <div className="overflow-hidden rounded-md transition group-hover:scale-105">
                      <Cover book={{ title: w.title, authors: w.authors, cover: null }} className={w.cover_url ? 'hidden' : ''} />
                      {w.cover_url && <img src={w.cover_url} alt={w.title} className="aspect-[2/3] w-full rounded-md object-cover" loading="lazy" />}
                    </div>
                    <div className="mt-2 line-clamp-1 text-sm font-medium">{w.title}</div>
                    <div className="line-clamp-1 text-xs text-muted">{w.authors}</div>
                  </a>
                ))}
              </Row>
            );
          return (
            <Row key={row.id} title={row.title} to={row.query ? `/biblioteca?${row.query}` : undefined} count={row.items.length}>
              {row.items.map((b: Book) => (
                <Poster key={b.id} book={b} />
              ))}
            </Row>
          );
        })}
      </div>
    </div>
  );
}
