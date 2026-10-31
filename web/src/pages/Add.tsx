import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Staging } from '../types';
import { Empty, ErrorBox, Spinner, toast, useAsync } from '../components/ui';

const ACCEPT = '.epub,.pdf,.mobi,.azw3,.azw,.fb2,.cbz,.djvu';

export default function Add() {
  const staging = useAsync(() => api<Staging[]>('/api/ingest'), []);
  const history = useAsync(() => api<any[]>('/api/history'), []);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    setBusy(true);
    try {
      const form = new FormData();
      list.forEach((f) => form.append('file', f, f.name));
      const added = await api<Staging[]>('/api/ingest/upload', { form });
      toast(added.length ? `${added.length} arquivo(s) para revisar` : 'Nenhum arquivo de livro reconhecido', added.length ? 'ok' : 'err');
      staging.reload();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const discard = async (id: number) => {
    await api(`/api/ingest/${id}`, { method: 'DELETE' });
    staging.reload();
  };
  const undo = async (id: number) => {
    if (!window.confirm('Desfazer? O arquivo gerado na pasta Livros será removido (ou o anterior restaurado).')) return;
    try {
      await api(`/api/history/${id}/undo`, { method: 'POST' });
      toast('Desfeito');
      history.reload();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-8">
      <h1 className="text-2xl font-bold">Adicionar livros</h1>
      <p className="mt-1 text-sm text-muted">Passe o arquivo por aqui antes de mandar para o Kindle: o app completa os metadados, padroniza o nome e salva o arquivo pronto na sua pasta Livros.</p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          upload(e.dataTransfer.files);
        }}
        className={`mt-6 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition ${over ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:border-muted'}`}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}
      >
        <div className="text-4xl">📚</div>
        <div className="font-semibold">{busy ? 'Enviando…' : 'Arraste os livros aqui ou clique para escolher'}</div>
        <div className="text-xs text-muted">EPUB, PDF, MOBI, AZW3… Também funciona soltando arquivos na pasta de Entrada (em Ajustes).</div>
        <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => e.target.files && upload(e.target.files)} />
      </div>

      <h2 className="mb-3 mt-10 text-lg font-semibold">Para revisar {staging.data ? `(${staging.data.length})` : ''}</h2>
      {staging.loading && !staging.data ? (
        <Spinner />
      ) : staging.error ? (
        <ErrorBox message={staging.error} />
      ) : !staging.data?.length ? (
        <Empty title="Nada na fila">Os livros que você adicionar aparecem aqui até serem salvos na biblioteca.</Empty>
      ) : (
        <ul className="space-y-2">
          {staging.data.map((s) => (
            <li key={s.id} className="flex items-center gap-4 rounded-xl border border-line bg-surface p-4">
              {s.cover ? <img src={`/covers/${s.cover}`} alt="" className="h-20 w-14 rounded object-cover" /> : <div className="flex h-20 w-14 items-center justify-center rounded bg-surface2 text-xs uppercase text-muted">{s.format}</div>}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.meta.title || s.original_name}</div>
                <div className="truncate text-sm text-muted">{s.meta.authors.join(', ') || 'Autor desconhecido'}</div>
                <div className="truncate text-xs text-muted/70">
                  {s.original_name} · {s.source === 'inbox' ? 'pasta de Entrada' : s.source === 'library' ? 'já na biblioteca' : 'upload'}
                </div>
              </div>
              <Link to={`/editor/${s.id}`} className="btn-primary">
                Revisar
              </Link>
              <button className="btn-ghost" onClick={() => discard(s.id)} aria-label="Descartar">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mb-3 mt-10 text-lg font-semibold">Últimas gravações</h2>
      {!history.data?.length ? (
        <p className="text-sm text-muted">Nenhuma ainda.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface text-sm">
          {history.data.slice(0, 15).map((h) => (
            <li key={h.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className={`chip ${h.undone ? 'opacity-50' : ''}`}>{h.action === 'add' ? 'adicionado' : 'reorganizado'}</span>
              <span className={`min-w-0 flex-1 truncate ${h.undone ? 'text-muted line-through' : ''}`} title={h.new_path}>
                {h.title ?? h.new_path}
              </span>
              <span className="hidden text-xs text-muted sm:block">{new Date(h.at * 1000).toLocaleString()}</span>
              {!h.undone && (
                <button className="text-xs text-accent2 hover:underline" onClick={() => undo(h.id)}>
                  desfazer
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
