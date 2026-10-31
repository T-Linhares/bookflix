import { ReactNode, useEffect, useState } from 'react';
import { api } from '../api';
import { Settings } from '../types';
import { ErrorBox, Spinner, toast, useAsync } from '../components/ui';

/** The native dialog exists only inside the desktop app; in a plain browser the path is typed. */
function PathField({ label, hint, value, onChange }: { label: string; hint: ReactNode; value: string; onChange: (v: string) => void }) {
  const pick = window.bookflix?.pickFolder;
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex gap-2">
        <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Nenhuma pasta escolhida" />
        {pick && (
          <button
            className="btn-ghost shrink-0"
            onClick={async () => {
              const p = await pick(value || undefined);
              if (p) onChange(p); // null = dialog cancelled: keep the current value
            }}
          >
            Escolher…
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

function About() {
  const { data } = useAsync(() => api<{ version: string; repo: string }>('/api/about'), []);
  const repo = data && !data.repo.startsWith('SEU-USUARIO/') ? data.repo : null;
  const open = (url: string) => (window.bookflix ? void window.bookflix.openExternal(url) : void window.open(url, '_blank', 'noopener,noreferrer'));
  return (
    <section className="card space-y-2 text-sm">
      <h2 className="font-semibold">Sobre</h2>
      <p className="text-xs text-muted">
        Bookflix {data?.version ?? ''} · licença MIT · software livre, fornecido “como está”, sem garantia de nenhum tipo. Faça cópia dos seus livros e do que importa para você.
      </p>
      <p className="text-xs text-muted">
        Privacidade: o app não tem conta, servidor, telemetria nem relatório automático de falhas. Seus dados ficam neste computador (e na pasta de nuvem que você escolheu, se ativar a sincronização). As únicas conexões são as consultas de metadados e de IA que você dispara, feitas direto a cada serviço com a sua chave, e a consulta de versão nova, se estiver ligada.
      </p>
      {repo && (
        <button className="text-xs text-accent2 underline" onClick={() => open(`https://github.com/${repo}`)}>
          Página do projeto
        </button>
      )}
    </section>
  );
}

interface SyncInfo {
  booksDir: boolean;
  enabled: boolean;
  libraryId: string | null;
  foundInFolder: string | null;
  mismatch: boolean;
  deviceId: string;
  peers: { id: string; writtenAt: number }[];
  lastSync: { at: number; summary?: { applied: number; pending: number; warnings: string[] }; error?: string } | null;
}

/** Keeps notes, progress and ratings the same on every computer through the library folder itself (Dropbox / Google Drive). */
function SyncSection({ savedBooksDir }: { savedBooksDir: string }) {
  const [info, setInfo] = useState<SyncInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<SyncInfo>('/api/sync').then(setInfo).catch(() => {});
  useEffect(() => void load(), [savedBooksDir]);

  const act = async (what: 'create' | 'join' | 'disable' | 'now') => {
    setBusy(true);
    try {
      if (what === 'disable') await api('/api/sync/disable', { method: 'POST' });
      else if (what === 'now') {
        const r = await api('/api/sync/now', { method: 'POST' });
        toast(r.applied ? `${r.applied} alteração(ões) vieram de outros aparelhos.` : 'Tudo em dia.');
      } else await api('/api/sync/enable', { body: { mode: what } });
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
      load();
    }
  };

  if (!info) return null;
  const last = info.lastSync;
  return (
    <section className="card space-y-3">
      <h2 className="font-semibold">
        Sincronizar entre aparelhos <span className="chip ml-2 align-middle text-[10px]">experimental</span>
      </h2>
      <p className="text-xs text-muted">
        Mantém notas, destaques, progresso e metas iguais em todos os seus computadores, usando a própria pasta da biblioteca (no Dropbox ou no Google Drive). Os livros viajam pelo serviço da nuvem; o app só grava arquivos próprios dentro de <code>.bookflix-sync</code> e nunca mexe nos seus livros.
        Não há servidor do Bookflix: seus dados só passam pelo serviço que você escolheu.
      </p>
      {!info.booksDir && <p className="text-sm text-muted">Escolha e salve a pasta da biblioteca acima para ativar.</p>}
      {info.booksDir && !info.enabled && (
        <div className="flex flex-wrap items-center gap-3">
          {info.foundInFolder ? (
            <>
              <span className="text-sm">
                Há uma biblioteca sincronizada nesta pasta (ID <code>{info.foundInFolder.slice(0, 8)}…</code>).
              </span>
              <button className="btn-primary" disabled={busy} onClick={() => act('join')}>
                Entrar nela
              </button>
            </>
          ) : (
            <button className="btn-primary" disabled={busy} onClick={() => act('create')}>
              Ativar nesta pasta
            </button>
          )}
        </div>
      )}
      {info.enabled && (
        <div className="space-y-2 text-sm">
          <div>
            ID da biblioteca: <code className="break-all">{info.libraryId}</code>
          </div>
          <div className="text-xs text-muted">
            {info.peers.length ? `Outros aparelhos: ${info.peers.length}.` : 'Nenhum outro aparelho apareceu ainda.'}{' '}
            {last?.error ? `Última tentativa falhou: ${last.error}` : last ? `Última sincronização: ${new Date(last.at).toLocaleTimeString()}.` : ''}
            {last?.summary && last.summary.pending > 0 && ` ${last.summary.pending} item(ns) esperam o livro correspondente chegar a este computador.`}
          </div>
          {last?.summary?.warnings.map((w) => (
            <div key={w} className="text-xs text-accent2">
              {w}
            </div>
          ))}
          {info.mismatch && (
            <div className="rounded-md border border-accent/40 bg-accent/10 p-2 text-xs text-accent2">
              Esta pasta agora pertence a outra biblioteca sincronizada. Nada foi alterado.{' '}
              <button className="underline" disabled={busy} onClick={() => act('join')}>
                Entrar na biblioteca desta pasta
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" disabled={busy} onClick={() => act('now')}>
              Sincronizar agora
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => act('disable')}>
              Desativar neste aparelho
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** One-click "Livros" folder inside the Dropbox / Google Drive folder that their desktop apps already sync here. */
function CloudShortcuts({ onPick }: { onPick: (path: string) => void }) {
  const { data } = useAsync(() => api<{ dropbox: string | null; drive: string | null }>('/api/cloud-folders'), []);
  const use = async (service: 'dropbox' | 'drive') => {
    try {
      const r = await api('/api/cloud-folders/library', { body: { service } });
      onPick(r.path);
      toast('Pasta escolhida. Clique em "Salvar ajustes" para confirmar.');
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };
  if (!data || (!data.dropbox && !data.drive)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <span>Atalhos:</span>
      {data.dropbox && (
        <button className="chip hover:border-accent" onClick={() => use('dropbox')}>
          Usar o Dropbox
        </button>
      )}
      {data.drive && (
        <button className="chip hover:border-accent" onClick={() => use('drive')}>
          Usar o Google Drive
        </button>
      )}
    </div>
  );
}

function AiKeyField({ label, provider, value, onChange, hint }: { label: string; provider: 'gemini' | 'anthropic' | 'openai'; value: string; onChange: (v: string) => void; hint: ReactNode }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const test = async () => {
    setTesting(true);
    try {
      setResult(await api('/api/settings/test-ai', { body: { provider, key: value } }));
    } catch (e: any) {
      setResult({ ok: false, message: e.message });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex gap-2">
        <input className="input" type="password" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" aria-label={label} />
        <button className="btn-ghost shrink-0" disabled={testing || !value} onClick={test}>
          {testing ? 'Testando…' : 'Testar chave'}
        </button>
      </div>
      {result && (
        <p className={`mt-1.5 text-xs ${result.ok ? 'text-ok' : 'text-accent2'}`} role="status">
          {result.message}
        </p>
      )}
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

const EXAMPLE = { author: 'Brandon Sanderson', title: 'The Final Empire', series: 'Mistborn', index: '01' };

export default function SettingsPage() {
  const { data, error, loading } = useAsync(() => api<Settings>('/api/settings'), []);
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [scan, setScan] = useState('');
  const [testing, setTesting] = useState(false);
  const [googleTest, setGoogleTest] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (data) setS(data);
  }, [data]);

  if (loading && !s) return <Spinner />;
  if (error || !s) return <ErrorBox message={error ?? 'Erro'} />;
  const up = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/settings', { method: 'PUT', body: s });
      toast('Ajustes salvos');
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  };
  const testGoogle = async () => {
    setTesting(true);
    try {
      setGoogleTest(await api('/api/settings/test-google', { body: { key: s.googleBooksKey } }));
    } catch (e: any) {
      setGoogleTest({ ok: false, message: e.message });
    } finally {
      setTesting(false);
    }
  };
  const rescan = async () => {
    setScan('Varrendo…');
    try {
      const r = await api('/api/library/scan', { method: 'POST' });
      setScan(`${r.added} novos · ${r.moved} movidos · ${r.missing} ausentes · ${r.duplicates} duplicados ignorados`);
    } catch (e: any) {
      setScan(e.message);
    }
  };
  const example = (s.nameTemplate || '{author} - {title}')
    .replace('{author}', EXAMPLE.author)
    .replace('{title}', EXAMPLE.title)
    .replace('{series}', EXAMPLE.series)
    .replace('{index}', EXAMPLE.index);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 pt-6 sm:px-8">
      <h1 className="text-2xl font-bold">Ajustes</h1>

      <section className="card space-y-5">
        <h2 className="font-semibold">Pastas</h2>
        <PathField
          label="Pasta da biblioteca (Livros)"
          value={s.booksDir}
          onChange={(v) => up('booksDir', v)}
          hint="É a biblioteca do app: os livros prontos são salvos aqui e é daqui que você envia para o Kindle. Pode ser qualquer pasta; para ter os livros em outros aparelhos, use uma pasta sincronizada pelo Dropbox ou pelo Google Drive para computador."
        />
        <CloudShortcuts onPick={(p) => up('booksDir', p)} />
        <PathField
          label="Pasta de Entrada (opcional)"
          value={s.inboxDir}
          onChange={(v) => up('inboxDir', v)}
          hint="Arquivos soltos aqui aparecem automaticamente na fila de Adicionar."
        />
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-ghost" onClick={rescan} disabled={!s.booksDir}>
            Varrer pasta Livros agora
          </button>
          <span className="text-xs text-muted">{scan}</span>
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Nome dos arquivos</h2>
        <label className="block">
          <span className="label">Modelo</span>
          <input className="input font-mono" value={s.nameTemplate} onChange={(e) => up('nameTemplate', e.target.value)} />
          <p className="mt-1 text-xs text-muted">
            Variáveis: <code>{'{author}'}</code> <code>{'{title}'}</code> <code>{'{series}'}</code> <code>{'{index}'}</code>. Padrão da indústria (Calibre): <code>{'{author} - {title}'}</code>. Exemplo: <b className="font-mono text-ok">{example}.epub</b>
          </p>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 accent-[#e50914]" checked={s.useFolders} onChange={(e) => up('useFolders', e.target.checked)} />
          <span>
            Organizar em pastas <code>Autor/Série/</code>
            <span className="block text-xs text-muted">A série e a ordem ficam gravadas nos metadados do arquivo (o KOReader as exibe) e nas pastas, não no nome.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 accent-[#e50914]" checked={s.moveOriginals} onChange={(e) => up('moveOriginals', e.target.checked)} />
          <span>
            Apagar o arquivo original da pasta de Entrada depois de salvar
            <span className="block text-xs text-muted">Desligado: o original permanece onde estava.</span>
          </span>
        </label>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Leitura</h2>
        <label className="block max-w-xs">
          <span className="label">Meta anual (livros)</span>
          <input className="input" type="number" min="0" value={s.yearlyGoal} onChange={(e) => up('yearlyGoal', Number(e.target.value))} />
        </label>
      </section>

      <SyncSection savedBooksDir={data?.booksDir ?? ''} />

      <section className="card space-y-4">
        <h2 className="font-semibold">Atualizações</h2>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 accent-[#e50914]" checked={s.checkUpdates} onChange={(e) => up('checkUpdates', e.target.checked)} />
          <span>
            Avisar quando houver uma versão nova
            <span className="block text-xs text-muted">Ao abrir, o app faz uma consulta anônima à página pública de versões no GitHub (nenhum dado seu é enviado). Nada é baixado nem instalado sozinho.</span>
          </span>
        </label>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Chaves de API (opcional)</h2>
        <p className="text-xs text-muted">Sem chaves o app usa o Google Books (cota compartilhada), o Open Library e a BrasilAPI gratuitamente. As chaves são suas, ficam salvas só neste computador e as consultas vão direto do seu computador para cada serviço.</p>
        <div>
          <span className="label">Google Books API key</span>
          <div className="flex gap-2">
            <input className="input" type="password" value={s.googleBooksKey} onChange={(e) => up('googleBooksKey', e.target.value)} placeholder="aumenta o limite de buscas" autoComplete="off" aria-label="Google Books API key" />
            <button className="btn-ghost shrink-0" disabled={testing} onClick={testGoogle}>
              {testing ? 'Testando…' : 'Testar chave'}
            </button>
          </div>
          {googleTest && (
            <p className={`mt-1.5 text-xs ${googleTest.ok ? 'text-ok' : 'text-accent2'}`} role="status">
              {googleTest.message}
            </p>
          )}
          <p className="mt-1 text-xs text-muted">
            Como criar (grátis): Google Cloud Console → criar projeto → APIs e serviços → ativar "Books API" → Credenciais → Criar chave de API.
          </p>
        </div>
        <AiKeyField
          label="Gemini API key (grátis)"
          provider="gemini"
          value={s.geminiKey}
          onChange={(v) => up('geminiKey', v)}
          hint="Crie em aistudio.google.com → Get API key."
        />
        <AiKeyField label="Anthropic API key" provider="anthropic" value={s.anthropicKey} onChange={(v) => up('anthropicKey', v)} hint="console.anthropic.com → API keys (pago por uso)." />
        <AiKeyField label="OpenAI API key (ChatGPT)" provider="openai" value={s.openaiKey} onChange={(v) => up('openaiKey', v)} hint="platform.openai.com → API keys (pago por uso). Uma assinatura do ChatGPT não inclui acesso à API." />
        <label className="block max-w-xs">
          <span className="label">Qual modelo consultar primeiro</span>
          <select className="input" value={s.aiOrder} onChange={(e) => up('aiOrder', e.target.value as Settings['aiOrder'])}>
            <option value="auto">Automático (Gemini, Anthropic, OpenAI)</option>
            <option value="gemini">Gemini</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
          <p className="mt-1 text-xs text-muted">Só os que tiverem chave são usados; se um falhar, o app tenta o próximo. A IA só preenche sinopse, tags e série quando nenhum site tem o livro.</p>
        </label>
        {!s.secretsEncrypted && (
          <p className="rounded-md border border-line bg-bg p-2 text-xs text-muted">
            Este sistema não oferece armazenamento seguro de senhas ao app: as chaves ficam em texto simples no banco de dados local, neste computador.
          </p>
        )}
      </section>

      <About />

      <div className="sticky bottom-3">
        <button className="btn-primary shadow-xl shadow-black/50" onClick={save} disabled={saving}>
          {saving ? 'Salvando…' : 'Salvar ajustes'}
        </button>
      </div>
    </div>
  );
}
