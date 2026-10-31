import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, describeSend, sendToKindle } from '../api';
import { Book } from '../types';
import { toast, useAsync } from '../components/ui';

interface Summary {
  root: string;
  sidecars: number;
  matched: number;
  unmatched: number;
  highlights: number;
  pushed: { reviews: number; ratings: number; statuses: number; notes: number };
  statsBooks: number;
  readingDays: number;
  errors: string[];
}
const sent = (p: Summary['pushed']) => p.reviews + p.ratings + p.statuses + p.notes;
interface Unmatched {
  id: number;
  title: string;
  authors: string;
  md5: string | null;
  sdr_path: string | null;
  payload: string;
}

function LinkBox({ u, onDone }: { u: Unmatched; onDone: () => void }) {
  const [q, setQ] = useState(u.title ?? '');
  const [res, setRes] = useState<Book[]>([]);
  const search = async (v: string) => {
    setQ(v);
    if (v.trim().length < 2) return setRes([]);
    setRes((await api<{ items: Book[] }>(`/api/books?q=${encodeURIComponent(v)}&limit=6`)).items);
  };
  const link = async (b: Book) => {
    await api(`/api/kindle/unmatched/${u.id}/link`, { body: { bookId: b.id } });
    toast(`Vinculado a "${b.title}"`);
    onDone();
  };
  return (
    <div className="mt-2 rounded-lg bg-bg p-3">
      <input className="input" value={q} onChange={(e) => search(e.target.value)} placeholder="Buscar o livro correspondente…" autoFocus />
      <ul className="mt-2 space-y-1">
        {res.map((b) => (
          <li key={b.id}>
            <button className="w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-surface2" onClick={() => link(b)}>
              {b.title} <span className="text-muted">· {b.authors}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function KindleImport() {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [linking, setLinking] = useState<number | null>(null);
  const unmatched = useAsync(() => api<Unmatched[]>('/api/kindle/unmatched'), []);

  const ignored = useAsync(() => api<{ count: number }>('/api/kindle/unmatched/ignored-count'), []);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const hideSelected = async () => {
    const r = await api<{ hidden: number }>('/api/kindle/unmatched/ignore', { body: { ids: [...selected] } });
    toast(`${r.hidden} oculto${r.hidden > 1 ? 's' : ''}. Não voltam nas próximas sincronizações.`);
    setSelected(new Set());
    unmatched.reload();
    ignored.reload();
  };
  /** Shows exactly what will be deleted from the device and only deletes after an explicit OK. */
  const deleteFromKindle = async (ids: number[]) => {
    try {
      const plan = await api<{ items: { id: number; title: string; targets: string[]; note?: string }[] }>('/api/kindle/unmatched/remove-preview', { body: { ids } });
      const files = plan.items.reduce((n, i) => n + i.targets.length, 0);
      const lines = plan.items.slice(0, 8).map((i) => `• ${i.title}: ${i.targets.length ? `${i.targets.length} item(ns) no Kindle` : i.note}`);
      if (plan.items.length > 8) lines.push(`… e mais ${plan.items.length - 8}`);
      const ok = window.confirm(
        `Apagar do Kindle, definitivamente?\n\n${lines.join('\n')}\n\n` +
          (files
            ? `Serão removidos ${files} arquivo(s)/pasta(s): o livro e as notas, destaques e progresso dele (pasta .sdr). Esses dados ainda não estão na biblioteca e não dá para desfazer.`
            : 'Não há arquivos para apagar: os itens só saem desta lista.'),
      );
      if (!ok) return;
      const r = await api<{ deleted: number; errors: string[] }>('/api/kindle/unmatched/remove', { body: { ids, confirm: true } });
      toast(r.errors.length ? `${r.deleted} apagado(s), com erros: ${r.errors.join('; ')}` : `${r.deleted} arquivo(s)/pasta(s) apagado(s) do Kindle.`, r.errors.length ? 'err' : 'ok');
      setSelected(new Set());
      unmatched.reload();
      ignored.reload();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };
  const restoreHidden = async () => {
    await api('/api/kindle/unmatched/restore', { method: 'POST', body: {} });
    unmatched.reload();
    ignored.reload();
  };

  const detected = useAsync(() => api<{ root: string | null; ready: number }>('/api/kindle/detect'), []);
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      const m = describeSend(await sendToKindle({ allReady: true }));
      toast(m.text, m.kind);
      detected.reload();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setSending(false);
    }
  };

  /** Syncs from the Kindle that is plugged in (the server detects it). */
  const run = async () => {
    setBusy(true);
    try {
      const s = await api<Summary>('/api/kindle/import', { body: {} });
      setSummary(s);
      unmatched.reload();
      detected.reload();
      toast(`Sincronizado: ${s.matched} livros, ${s.highlights} destaques${sent(s.pushed) ? `, ${sent(s.pushed)} alteraç${sent(s.pushed) > 1 ? 'ões' : 'ão'} enviada${sent(s.pushed) > 1 ? 's' : ''} ao Kindle` : ''}${s.errors.length ? ` (${s.errors.length} aviso${s.errors.length > 1 ? 's' : ''})` : ''}`, s.matched || !s.errors.length ? 'ok' : 'err');
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 pt-6 sm:px-8">
      <h1 className="text-2xl font-bold">Kindle</h1>

      <section className="mt-4 rounded-xl border border-line bg-surface p-5">
        <h2 className="text-lg font-semibold">Enviar para o Kindle</h2>
        <p className="mt-1 text-sm text-muted">
          Copia os livros prontos para a pasta <code className="rounded bg-bg px-1">documents/Livros</code> do Kindle (criada se não existir) e marca cada um como "No Kindle".
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={sending || !detected.data?.ready} onClick={send}>
            {sending ? 'Enviando…' : `Enviar ${detected.data?.ready ?? 0} livro${detected.data?.ready === 1 ? '' : 's'} pronto${detected.data?.ready === 1 ? '' : 's'}`}
          </button>
          <span className="text-sm text-muted">
            {detected.data?.root ? `Kindle detectado em ${detected.data.root}` : 'Kindle não detectado: conecte por USB e clique em "verificar de novo".'}
          </span>
          <button className="text-xs text-muted underline hover:text-ink" onClick={detected.reload}>
            verificar de novo
          </button>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-surface p-5">
        <h2 className="text-lg font-semibold">Sincronizar notas e progresso</h2>
        <p className="mt-1 text-sm text-muted">Procura no Kindle conectado os destaques, notas, progresso e tempo de leitura do KOReader e traz para a biblioteca. Pode repetir quando quiser: nada é duplicado e o que você editou aqui é preservado.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={busy || !detected.data?.root} onClick={run}>
            {busy ? 'Sincronizando…' : 'Sincronizar com o Kindle'}
          </button>
          {!detected.data?.root && <span className="text-sm text-muted">Conecte o Kindle por USB.</span>}
        </div>
        {summary && (
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              ['Livros pareados', summary.matched],
              ['Destaques/notas', summary.highlights],
              ['Enviado ao Kindle', sent(summary.pushed)],
              ['Com estatísticas', summary.statsBooks],
              ['Dias de leitura', summary.readingDays],
            ].map(([l, v]) => (
              <div key={l} className="card !p-4">
                <div className="text-xs uppercase tracking-wide text-muted">{l}</div>
                <div className="mt-1 text-2xl font-black tabular-nums">{v}</div>
              </div>
            ))}
            {summary.errors.length > 0 && (
              <ul className="col-span-full space-y-1 rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
                {summary.errors.map((e) => (
                  <li key={e}>⚠ {e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <h2 className="mb-1 mt-10 text-lg font-semibold">Não pareados {unmatched.data ? `(${unmatched.data.length})` : ''}</h2>
      <p className="mb-3 text-sm text-muted">Livros do Kindle que o app não conseguiu ligar a nenhum livro da biblioteca (normalmente porque não passaram por <Link to="/adicionar" className="text-accent2 underline">Adicionar</Link>).</p>
      {!unmatched.data?.length ? (
        <p className="text-sm text-muted">Tudo pareado ✓</p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selected.size === unmatched.data.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(unmatched.data!.map((u) => u.id)) : new Set())}
              />
              Selecionar todos
            </label>
            <button className="btn-danger" disabled={!selected.size} onClick={() => deleteFromKindle([...selected])}>
              Apagar do Kindle{selected.size ? ` (${selected.size})` : ''}
            </button>
            <button className="text-xs text-muted underline hover:text-ink disabled:opacity-40" disabled={!selected.size} onClick={hideSelected}>
              só ocultar da lista
            </button>
          </div>
        <ul className="space-y-2">
          {unmatched.data.map((u) => (
            <li key={u.id} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  aria-label={`Selecionar ${u.title}`}
                  checked={selected.has(u.id)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(u.id);
                      else n.delete(u.id);
                      return n;
                    })
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{u.title}</div>
                  <div className="truncate text-xs text-muted">{u.authors || 'autor desconhecido'} · {u.sdr_path ? 'notas e progresso' : 'só estatísticas'}</div>
                </div>
                <button className="btn-ghost" onClick={() => setLinking(linking === u.id ? null : u.id)}>
                  Vincular
                </button>
                <button className="text-xs text-muted hover:text-accent2" onClick={() => deleteFromKindle([u.id])}>
                  apagar do Kindle
                </button>
              </div>
              {linking === u.id && (
                <LinkBox
                  u={u}
                  onDone={() => {
                    setLinking(null);
                    unmatched.reload();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
        </>
      )}
      {!!ignored.data?.count && (
        <p className="mt-3 text-xs text-muted">
          {ignored.data.count} oculto{ignored.data.count > 1 ? 's' : ''} (não voltam nas próximas sincronizações).{' '}
          <button className="underline hover:text-ink" onClick={restoreHidden}>
            Mostrar de novo
          </button>
        </p>
      )}
    </div>
  );
}
