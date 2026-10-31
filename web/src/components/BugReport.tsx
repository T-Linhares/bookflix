import { useState } from 'react';
import { api } from '../api';
import { buildIssueUrl, diagnosticText } from '../../../shared/bugReport';
import { toast } from './ui';

interface About {
  version: string;
  repo: string;
  platform: string;
  arch: string;
}

/**
 * Floating bug button. It sends nothing itself: it opens GitHub's "new issue" page with the text filled in, and the
 * person reviews it and submits with their own GitHub account. No server of ours, no token inside the app.
 */
export default function BugReport() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [withDiag, setWithDiag] = useState(false);
  const [about, setAbout] = useState<About | null>(null);

  const toggle = () => {
    setOpen((o) => !o);
    if (!about) api('/api/about').then(setAbout).catch(() => {});
  };

  const diag = about ? { version: about.version, platform: about.platform, arch: about.arch } : undefined;
  const built = about ? buildIssueUrl({ repo: about.repo, text, diagnostic: withDiag ? diag : undefined }) : null;
  const unavailable = !!about && about.repo.startsWith('SEU-USUARIO/');

  const send = async () => {
    if (!built) return;
    if (built.truncated) {
      try {
        await (window.bookflix ? window.bookflix.copyText(built.fullText) : navigator.clipboard.writeText(built.fullText));
      } catch {
        toast('Não consegui copiar o texto completo; ele passou do limite e será cortado.', 'err');
      }
    }
    // the text stays in the box until the page opens, so nothing typed is lost if the browser does not
    const opened = window.bookflix ? await window.bookflix.openExternal(built.url) : !!window.open(built.url, '_blank', 'noopener,noreferrer');
    if (opened) {
      toast('Abrimos o GitHub. Revise e clique em "Submit new issue" para enviar.');
      setText('');
      setOpen(false);
    } else toast('Não foi possível abrir o navegador. Seu texto continua aqui.', 'err');
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {open && (
        <div className="w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-4 shadow-2xl shadow-black/60" role="dialog" aria-label="Relatar um problema">
          <div className="text-sm font-semibold">Relatar um problema</div>
          <textarea
            className="input mt-2 h-32 resize-y"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="O que aconteceu? O que você esperava?"
            aria-label="Descrição do problema"
          />
          <label className="mt-2 flex items-start gap-2 text-xs text-muted">
            <input type="checkbox" className="mt-0.5 accent-[#e50914]" checked={withDiag} onChange={(e) => setWithDiag(e.target.checked)} />
            <span>Incluir versão do app e sistema operacional</span>
          </label>
          {withDiag && diag && <pre className="mt-1 whitespace-pre-wrap rounded bg-bg p-2 text-[11px] text-muted">{diagnosticText(diag)}</pre>}
          <p className="mt-2 text-[11px] leading-snug text-muted">
            {unavailable
              ? 'O envio ainda não está configurado nesta versão.'
              : 'Nada é enviado por este app. Ao clicar, abrimos a página de novo problema do GitHub com este texto; você revisa e envia com a sua conta do GitHub (é preciso ter uma). Não inclua senhas nem chaves.'}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setOpen(false)}>
              Fechar
            </button>
            <button className="btn-primary" disabled={!built} onClick={send}>
              Enviar para o GitHub
            </button>
          </div>
        </div>
      )}
      <button
        className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-lg shadow-black/50 transition hover:border-accent hover:text-ink"
        onClick={toggle}
        aria-label="Relatar um problema"
        aria-expanded={open}
        title="Relatar um problema"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 2l1.9 1.9M16 2l-1.9 1.9" />
          <path d="M9 7.1V6a3 3 0 0 1 6 0v1.1" />
          <path d="M12 21a6 6 0 0 1-6-6v-3a6 6 0 0 1 12 0v3a6 6 0 0 1-6 6z" />
          <path d="M12 21v-9M6 13H2M22 13h-4M6 18l-3 2M18 18l3 2M6 8L3 6M18 8l3-2" />
        </svg>
      </button>
    </div>
  );
}
