import { DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { Empty, ErrorBox, Spinner, toast, useAsync } from '../components/ui';

interface Item {
  id: string;
  name: string;
  ext: string;
  tags: string[];
  device: string | null;
  note: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  favorite: boolean;
  reviewed: boolean;
  added_at: number | null;
  url: string;
  warning: string | null;
}
interface Listing {
  items: Item[];
  total: number;
  page: number;
  pages: number;
  per: number;
  facets: {
    tags: { name: string; count: number }[];
    devices: { id: string; label: string; count: number }[];
    counts: { all: number; pending: number; reviewed: number; fav: number };
  };
}
interface Device {
  id: string;
  label: string;
  width?: number;
  height?: number;
}
interface KindleInfo {
  root: string | null;
  dir: string | null;
  exists: boolean;
  count: number;
  hasKoreader: boolean;
}
interface SendResult {
  dest: string;
  copied: string[];
  already: string[];
  failed: { name: string; reason: string }[];
}
interface SyncInfo {
  enabled: boolean;
}

const STATUS: { id: string; label: string; key: keyof Listing['facets']['counts'] }[] = [
  { id: 'all', label: 'Todas', key: 'all' },
  { id: 'pending', label: 'Para revisar', key: 'pending' },
  { id: 'reviewed', label: 'Revisadas', key: 'reviewed' },
  { id: 'fav', label: 'Favoritas', key: 'fav' },
];
const SORTS = [
  { id: 'recent', label: 'Mais recentes' },
  { id: 'name', label: 'Nome' },
  { id: 'size', label: 'Maiores' },
];
const PER = [12, 24, 36, 48];

const kb = (n: number | null) => (n == null ? '' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const dims = (i: Pick<Item, 'width' | 'height'>) => (i.width && i.height ? `${i.width}×${i.height}` : '');

function describeSend(r: SendResult): { text: string; kind: 'ok' | 'err' } {
  const parts: string[] = [];
  if (r.copied.length) parts.push(`${r.copied.length} enviada${r.copied.length > 1 ? 's' : ''}`);
  if (r.already.length) parts.push(`${r.already.length} já estava${r.already.length > 1 ? 'm' : ''} no Kindle`);
  if (r.failed.length) parts.push(`${r.failed.length} com erro: ${r.failed.map((f) => `${f.name} (${f.reason})`).join('; ')}`);
  return { text: `${parts.join(', ') || 'Nada para enviar'} → ${r.dest}`, kind: r.failed.length ? 'err' : 'ok' };
}

function Pagination({ page, pages, go }: { page: number; pages: number; go: (p: number) => void }) {
  if (pages <= 1) return null;
  const shown = [...new Set([1, page - 1, page, page + 1, pages].filter((p) => p >= 1 && p <= pages))].sort((a, b) => a - b);
  return (
    <nav className="mt-6 flex flex-wrap items-center justify-center gap-1.5" aria-label="Páginas">
      <button className="btn-ghost !px-3 !py-1.5" disabled={page <= 1} onClick={() => go(page - 1)}>
        ‹
      </button>
      {shown.map((p, i) => (
        <span key={p} className="flex items-center gap-1.5">
          {i > 0 && p - shown[i - 1] > 1 && <span className="text-muted">…</span>}
          <button className={p === page ? 'btn-primary !px-3 !py-1.5' : 'btn-ghost !px-3 !py-1.5'} onClick={() => go(p)} aria-current={p === page ? 'page' : undefined}>
            {p}
          </button>
        </span>
      ))}
      <button className="btn-ghost !px-3 !py-1.5" disabled={page >= pages} onClick={() => go(page + 1)}>
        ›
      </button>
    </nav>
  );
}

function Detail({
  item,
  devices,
  tags,
  eink,
  onClose,
  onStep,
  onChanged,
  kindleReady,
}: {
  item: Item;
  devices: Device[];
  tags: string[];
  eink: boolean;
  onClose: () => void;
  onStep: (d: -1 | 1) => void;
  onChanged: () => void;
  kindleReady: boolean;
}) {
  const [name, setName] = useState(item.name);
  const [tagText, setTagText] = useState(item.tags.join(', '));
  const [device, setDevice] = useState(item.device ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [fav, setFav] = useState(item.favorite);
  const [preview, setPreview] = useState(eink);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(item.name);
    setTagText(item.tags.join(', '));
    setDevice(item.device ?? '');
    setNote(item.note ?? '');
    setFav(item.favorite);
  }, [item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
      if (!typing && e.key === 'ArrowLeft') onStep(-1);
      if (!typing && e.key === 'ArrowRight') onStep(1);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose, onStep]);

  const patch = () => ({ name, tags: tagText.split(',').map((t) => t.trim()).filter(Boolean), device: device || null, note: note || null, favorite: fav });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      onChanged();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };
  const dev = devices.find((d) => d.id === device);
  const frame = dev?.width && dev.height ? `${dev.width} / ${dev.height}` : '3 / 4';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm" onClick={onClose} role="dialog" aria-label={`Imagem ${item.name}`}>
      <div className="grid max-h-[94vh] w-full max-w-5xl grid-cols-1 overflow-y-auto rounded-xl border border-line bg-surface md:grid-cols-[minmax(0,1fr)_22rem]" onClick={(e) => e.stopPropagation()}>
        <div className="checker relative flex items-center justify-center p-4">
          <div className="max-h-[80vh] overflow-hidden rounded border border-line bg-black/30" style={{ aspectRatio: frame, height: 'min(80vh, 46rem)', maxWidth: '100%' }}>
            <img src={item.url} alt={item.name} className={`h-full w-full object-contain ${preview ? 'eink' : ''}`} />
          </div>
          <button className="btn-ghost absolute left-2 top-1/2 !px-3" onClick={() => onStep(-1)} aria-label="Anterior">
            ‹
          </button>
          <button className="btn-ghost absolute right-2 top-1/2 !px-3" onClick={() => onStep(1)} aria-label="Próxima">
            ›
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="truncate text-lg font-bold">{item.name}</h2>
            <button className="text-muted hover:text-ink" onClick={onClose} aria-label="Fechar">
              ✕
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs">
            <span className="chip">{dims(item) || '?'}</span>
            <span className="chip">{kb(item.size)}</span>
            <span className="chip uppercase">{item.ext}</span>
            <span className={`chip ${item.reviewed ? 'text-ok' : 'text-warn'}`}>{item.reviewed ? 'Revisada' : 'Para revisar'}</span>
            <span className="chip font-mono" title="ID da imagem: é o mesmo em todos os computadores">
              {item.id.slice(0, 8)}
            </span>
          </div>
          {item.warning && <p className="rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-warn">⚠ {item.warning}</p>}

          <label className="block">
            <span className="label">Nome</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Tags — separe por vírgula</span>
            <input className="input" value={tagText} onChange={(e) => setTagText(e.target.value)} list="ss-tags" placeholder="preto e branco, gatos, minimalista" />
            <datalist id="ss-tags">
              {tags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="label">Dispositivo</span>
            <select className="input" value={device} onChange={(e) => setDevice(e.target.value)}>
              <option value="">Não informado</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                  {d.width ? ` — ${d.width}×${d.height}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Observação</span>
            <textarea className="input min-h-16" value={note} onChange={(e) => setNote(e.target.value)} placeholder="De onde veio, para qual livro combina…" />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button className={fav ? 'btn-primary' : 'btn-ghost'} onClick={() => setFav(!fav)} aria-pressed={fav}>
              {fav ? '♥ Favorita' : '♡ Favoritar'}
            </button>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} /> Prévia e-ink
            </label>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {item.reviewed ? (
              <button className="btn-primary" disabled={busy || !name.trim()} onClick={() => run(() => api(`/api/screensavers/${item.id}`, { method: 'PATCH', body: patch() }), 'Salvo')}>
                Salvar
              </button>
            ) : (
              <button className="btn-primary" disabled={busy || !name.trim()} onClick={() => run(() => api('/api/screensavers/review', { body: { ids: [item.id], patch: patch() } }), 'Revisada: vai sincronizar com seus outros computadores')}>
                Revisar e sincronizar
              </button>
            )}
            {!item.reviewed && (
              <button className="btn-ghost" disabled={busy} onClick={() => run(() => api(`/api/screensavers/${item.id}`, { method: 'PATCH', body: patch() }), 'Rascunho salvo')}>
                Salvar rascunho
              </button>
            )}
            <button
              className="btn-ghost"
              disabled={busy || !kindleReady}
              title={kindleReady ? undefined : 'Conecte o Kindle por USB'}
              onClick={() =>
                run(async () => {
                  const r = await api<SendResult>('/api/screensavers/send', { body: { ids: [item.id] } });
                  const d = describeSend(r);
                  toast(d.text, d.kind);
                }, 'Enviar ao Kindle: concluído')
              }
            >
              Enviar ao Kindle
            </button>
            <button
              className="btn-danger ml-auto"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Excluir "${item.name}" do Bookflix${item.reviewed ? ' e dos seus outros computadores' : ''}? O arquivo no Kindle não é apagado.`)) void run(() => api(`/api/screensavers/${item.id}`, { method: 'DELETE' }), 'Excluída').then(onClose);
              }}
            >
              Excluir
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Screensavers() {
  const [params, setParams] = useSearchParams();
  const get = (k: string, d = '') => params.get(k) ?? d;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };

  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [eink, setEink] = useState(() => {
    try {
      return localStorage.getItem('ssPreview') === 'eink';
    } catch {
      return false;
    }
  });
  const [q, setQ] = useState(get('q'));
  const [folder, setFolder] = useState('');
  const [bulkTag, setBulkTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const devices = useAsync(() => api<Device[]>('/api/screensavers/devices'), []);
  const kindle = useAsync(() => api<KindleInfo>('/api/screensavers/kindle'), []);
  const sync = useAsync(() => api<SyncInfo>('/api/sync'), []);

  const status = get('status', 'all');
  const key = `${get('q')}|${get('tag')}|${get('device')}|${status}|${get('sort', 'recent')}|${get('page', '1')}|${get('per', '24')}|${tick}`;
  useEffect(() => {
    setLoading(true);
    api<Listing>(`/api/screensavers?${qs({ q: get('q'), tag: get('tag'), device: get('device'), status, sort: get('sort', 'recent'), page: get('page', '1'), per: get('per', '24') })}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const t = setTimeout(() => q !== get('q') && set({ q: q || null }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const setPreview = (on: boolean) => {
    setEink(on);
    try {
      localStorage.setItem('ssPreview', on ? 'eink' : 'original');
    } catch {
      // private window: the choice just is not remembered
    }
  };

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const upload = (files: File[]) =>
    guard(async () => {
      const images = files.filter((f) => /\.(png|jpe?g|gif|bmp)$/i.test(f.name) || f.type.startsWith('image/'));
      if (!images.length) return void toast('Nenhuma imagem PNG, JPEG, GIF ou BMP nos arquivos escolhidos.', 'err');
      const form = new FormData();
      images.forEach((f) => form.append('file', f, f.name));
      const r = await api<{ added: number; duplicates: number; skipped: number }>('/api/screensavers/upload', { form });
      toast(`${r.added} adicionada${r.added === 1 ? '' : 's'} para revisar${r.duplicates ? `, ${r.duplicates} já existia${r.duplicates > 1 ? 'm' : ''}` : ''}${r.skipped ? `, ${r.skipped} ignorada${r.skipped > 1 ? 's' : ''}` : ''}`);
      set({ status: 'pending' });
      reload();
    });

  const importFrom = (path?: string) =>
    guard(async () => {
      const r = await api<{ found: number; added: number; duplicates: number; skipped: number; errors: string[]; folder: string }>('/api/screensavers/import-folder', { body: { path: path ?? '' } });
      toast(`${r.found} imagem(ns) na pasta: ${r.added} nova${r.added === 1 ? '' : 's'} para revisar, ${r.duplicates} já existia${r.duplicates === 1 ? '' : 'm'}${r.skipped ? `, ${r.skipped} ignorada${r.skipped > 1 ? 's' : ''}` : ''}`, r.errors.length ? 'err' : 'ok');
      if (r.added) set({ status: 'pending' });
      reload();
    });

  const send = (ids?: string[]) =>
    guard(async () => {
      const r = await api<SendResult>('/api/screensavers/send', { body: ids ? { ids } : { all: true } });
      const d = describeSend(r);
      toast(d.text, d.kind);
    });

  const bulk = (fn: () => Promise<unknown>, ok: string) =>
    guard(async () => {
      await fn();
      toast(ok);
      setSelected(new Set());
      reload();
    });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void upload([...e.dataTransfer.files]);
  };

  const items = data?.items ?? [];
  const openIndex = items.findIndex((i) => i.id === open);
  const step = useCallback(
    (d: -1 | 1) => {
      if (!items.length) return;
      const i = items.findIndex((x) => x.id === open);
      setOpen(items[(i + d + items.length) % items.length].id);
    },
    [items, open],
  );
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const sel = [...selected];
  const kindleReady = !!kindle.data?.root && kindle.data.hasKoreader;
  const label = (id: string | null) => devices.data?.find((d) => d.id === id)?.label ?? '';
  const filtered = !!(get('q') || get('tag') || get('device') || status !== 'all');

  return (
    <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-8" onDragOver={(e) => (e.preventDefault(), setDrag(true))} onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)} onDrop={onDrop}>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Protetores de tela</h1>
        <span className="text-sm text-muted">imagens para a tela de descanso do e-reader (KOReader)</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/bmp" multiple hidden onChange={(e) => (void upload([...(e.target.files ?? [])]), (e.target.value = ''))} />
          <button className="btn-primary" disabled={busy} onClick={() => fileInput.current?.click()}>
            + Abrir imagens…
          </button>
          <button className="btn-ghost" disabled={busy || !kindle.data?.root || !kindle.data.exists} onClick={() => importFrom()} title={kindle.data?.dir ?? 'Conecte o Kindle por USB'}>
            Importar do Kindle
          </button>
          <button className="btn-ghost" disabled={busy || !kindleReady || !data?.facets.counts.reviewed} onClick={() => send()} title="Envia todas as revisadas para koreader/screensavers">
            Enviar revisadas ao Kindle
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-xs text-muted md:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface px-3 py-2">
          {kindle.data?.root ? (
            <>
              Kindle em <span className="font-mono text-ink">{kindle.data.root}</span> · {kindle.data.hasKoreader ? (kindle.data.exists ? <>pasta <span className="font-mono text-ink">koreader/screensavers</span> com {kindle.data.count} imagem(ns)</> : <>a pasta <span className="font-mono text-ink">koreader/screensavers</span> será criada no primeiro envio</>) : 'sem a pasta koreader (instale o KOReader)'}
            </>
          ) : (
            'Kindle não detectado. Conecte-o por USB, ou importe uma pasta digitando o caminho abaixo.'
          )}
          <div className="mt-2 flex gap-2">
            <input className="input !py-1 !text-xs" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Ou uma pasta qualquer: C:\Imagens\protetores" />
            {window.bookflix?.pickFolder && (
              <button className="btn-ghost !px-3 !py-1 text-xs" onClick={async () => setFolder((await window.bookflix!.pickFolder(folder || undefined)) ?? folder)}>
                Escolher…
              </button>
            )}
            <button className="btn-ghost !px-3 !py-1 text-xs" disabled={busy || !folder.trim()} onClick={() => importFrom(folder.trim())}>
              Importar pasta
            </button>
          </div>
        </div>
        <div className="rounded-lg border border-line bg-surface px-3 py-2">
          <b className="text-ink">Como funciona:</b> toda imagem nova entra em <b className="text-warn">Para revisar</b>. Ao revisar (nome, tags, dispositivo), ela ganha um ID fixo e passa a sincronizar com seus outros computadores pela pasta do Drive/Dropbox.{' '}
          {sync.data && !sync.data.enabled && (
            <span className="text-warn">
              A sincronização está desativada: por enquanto as imagens ficam só aqui. <Link to="/ajustes" className="underline">Abrir Ajustes</Link>
            </span>
          )}
        </div>
      </div>

      {/* filters, like the site: sort / per page / preview + search + active chips */}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">Mostrar</span>
          <select className="input !w-auto" value={status} onChange={(e) => set({ status: e.target.value === 'all' ? null : e.target.value })}>
            {STATUS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({data?.facets.counts[s.key] ?? 0})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Ordenar</span>
          <select className="input !w-auto" value={get('sort', 'recent')} onChange={(e) => set({ sort: e.target.value === 'recent' ? null : e.target.value })}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Por página</span>
          <select className="input !w-auto" value={get('per', '24')} onChange={(e) => set({ per: e.target.value === '24' ? null : e.target.value })}>
            {PER.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <div>
          <span className="label">Prévia</span>
          <div className="flex overflow-hidden rounded-md border border-line">
            {[
              [false, 'Original'],
              [true, 'E-ink'],
            ].map(([v, l]) => (
              <button key={String(l)} className={`px-3 py-2 text-sm ${eink === v ? 'bg-accent text-white' : 'bg-surface hover:bg-surface2'}`} onClick={() => setPreview(v as boolean)} aria-pressed={eink === v}>
                {l as string}
              </button>
            ))}
          </div>
        </div>
        <input className="input ml-auto max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome, tag ou observação…" aria-label="Buscar" />
      </div>
      {(get('tag') || get('device')) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {get('tag') && (
            <button className="chip hover:bg-surface" onClick={() => set({ tag: null })}>
              Tag: {get('tag')} ✕
            </button>
          )}
          {get('device') && (
            <button className="chip hover:bg-surface" onClick={() => set({ device: null })}>
              Dispositivo: {label(get('device')) || get('device')} ✕
            </button>
          )}
        </div>
      )}

      <div className="mt-5 grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="space-y-5 text-sm">
          <div>
            <h3 className="label">Tags</h3>
            {data?.facets.tags.length ? (
              <ul className="space-y-0.5">
                {data.facets.tags.slice(0, 24).map((t) => (
                  <li key={t.name}>
                    <button className={`flex w-full justify-between rounded px-2 py-1 text-left hover:bg-surface2 ${get('tag').toLowerCase() === t.name.toLowerCase() ? 'bg-surface2 font-semibold' : ''}`} onClick={() => set({ tag: get('tag').toLowerCase() === t.name.toLowerCase() ? null : t.name })}>
                      <span className="truncate">{t.name}</span>
                      <span className="text-muted">{t.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 text-xs text-muted">Ainda sem tags. Elas aparecem ao revisar as imagens.</p>
            )}
          </div>
          <div>
            <h3 className="label">Dispositivos</h3>
            {data?.facets.devices.length ? (
              <ul className="space-y-0.5">
                {data.facets.devices.map((d) => (
                  <li key={d.id}>
                    <button className={`flex w-full justify-between rounded px-2 py-1 text-left hover:bg-surface2 ${get('device') === d.id ? 'bg-surface2 font-semibold' : ''}`} onClick={() => set({ device: get('device') === d.id ? null : d.id })}>
                      <span className="truncate">{d.label}</span>
                      <span className="text-muted">{d.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 text-xs text-muted">Escolha o dispositivo ao revisar.</p>
            )}
          </div>
        </aside>

        <section>
          {error && <ErrorBox message={error} />}
          {loading && !data ? (
            <Spinner />
          ) : !items.length ? (
            filtered ? (
              <Empty title="Nenhuma imagem com esses filtros">
                <button className="btn-ghost" onClick={() => (setQ(''), setParams({}, { replace: true }))}>
                  Limpar filtros
                </button>
              </Empty>
            ) : (
              <Empty title="Nenhum protetor de tela ainda">
                Arraste imagens para cá, use <b>Abrir imagens…</b> ou importe a pasta <span className="font-mono">koreader/screensavers</span> do seu Kindle.
              </Empty>
            )
          ) : (
            <>
              <p className="mb-3 text-sm text-muted">
                {(data!.page - 1) * data!.per + 1} – {(data!.page - 1) * data!.per + items.length} de {data!.total} resultado{data!.total === 1 ? '' : 's'}
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {items.map((i) => (
                  <div key={i.id} className={`group relative overflow-hidden rounded-lg border bg-surface transition ${selected.has(i.id) ? 'border-accent ring-2 ring-accent/60' : 'border-line hover:border-muted'}`}>
                    <button className="checker block aspect-[3/4] w-full" onClick={() => setOpen(i.id)} aria-label={`Abrir ${i.name}`}>
                      <img src={i.url} alt={i.name} loading="lazy" className={`h-full w-full object-contain ${eink ? 'eink' : ''}`} />
                    </button>
                    <input type="checkbox" className={`absolute left-2 top-2 h-5 w-5 cursor-pointer accent-[#e50914] ${selected.size || selected.has(i.id) ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`} checked={selected.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Selecionar ${i.name}`} />
                    <div className="pointer-events-none absolute right-2 top-2 flex flex-col items-end gap-1">
                      {!i.reviewed && <span className="rounded bg-warn/90 px-1.5 py-0.5 text-[10px] font-bold text-black">PARA REVISAR</span>}
                      {i.favorite && <span className="text-lg text-accent2 drop-shadow">♥</span>}
                      {i.warning && (
                        <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-warn" title={i.warning}>
                          ⚠
                        </span>
                      )}
                    </div>
                    <div className="p-2">
                      <div className="truncate text-sm font-medium" title={i.name}>
                        {i.name}
                      </div>
                      <div className="truncate text-xs text-muted">{[dims(i), label(i.device), kb(i.size)].filter(Boolean).join(' · ')}</div>
                    </div>
                  </div>
                ))}
              </div>
              <Pagination page={data!.page} pages={data!.pages} go={(p) => (set({ page: String(p) }), window.scrollTo({ top: 0 }))} />
            </>
          )}
        </section>
      </div>

      {sel.length > 0 && (
        <div className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[96vw] flex-wrap items-center gap-2 rounded-xl border border-line bg-surface/95 p-3 shadow-2xl shadow-black/60 backdrop-blur">
          <b className="px-1 text-sm">{sel.length} selecionada{sel.length > 1 ? 's' : ''}</b>
          <button className="btn-primary !py-1.5" disabled={busy} onClick={() => bulk(() => api('/api/screensavers/review', { body: { ids: sel } }), 'Marcadas como revisadas: vão sincronizar')}>
            Marcar como revisadas
          </button>
          <input className="input !w-36 !py-1.5" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} placeholder="nova tag" aria-label="Tag para as selecionadas" />
          <button
            className="btn-ghost !py-1.5"
            disabled={busy || !bulkTag.trim()}
            onClick={() =>
              bulk(async () => {
                for (const id of sel) {
                  const it = items.find((x) => x.id === id);
                  if (it) await api(`/api/screensavers/${id}`, { method: 'PATCH', body: { tags: [...it.tags, bulkTag.trim()] } });
                }
                setBulkTag('');
              }, 'Tag adicionada')
            }
          >
            + Tag
          </button>
          <select className="input !w-auto !py-1.5" value="" aria-label="Definir dispositivo" onChange={(e) => e.target.value && void bulk(async () => void (await Promise.all(sel.map((id) => api(`/api/screensavers/${id}`, { method: 'PATCH', body: { device: e.target.value } })))), 'Dispositivo definido')}>
            <option value="">Dispositivo…</option>
            {devices.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="btn-ghost !py-1.5" disabled={busy || !kindleReady} title={kindleReady ? undefined : 'Conecte o Kindle por USB'} onClick={() => send(sel)}>
            Enviar ao Kindle
          </button>
          <button
            className="btn-danger !py-1.5"
            disabled={busy}
            onClick={() => window.confirm(`Excluir ${sel.length} imagem(ns) do Bookflix (e dos outros computadores, se já revisadas)? Os arquivos no Kindle não são apagados.`) && void bulk(async () => void (await Promise.all(sel.map((id) => api(`/api/screensavers/${id}`, { method: 'DELETE' })))), 'Excluídas')}
          >
            Excluir
          </button>
          <button className="btn-ghost !py-1.5" onClick={() => setSelected(new Set())}>
            Limpar
          </button>
        </div>
      )}

      {open && openIndex >= 0 && (
        <Detail
          key={open}
          item={items[openIndex]}
          devices={devices.data ?? []}
          tags={data?.facets.tags.map((t) => t.name) ?? []}
          eink={eink}
          kindleReady={kindleReady}
          onClose={() => setOpen(null)}
          onStep={step}
          onChanged={reload}
        />
      )}

      {drag && <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-4 border-dashed border-accent bg-black/60 text-xl font-bold">Solte as imagens aqui</div>}
    </div>
  );
}
