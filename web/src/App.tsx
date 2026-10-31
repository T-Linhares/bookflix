import { useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from './api';
import { Toaster } from './components/ui';
import BugReport from './components/BugReport';
import Home from './pages/Home';
import Library from './pages/Library';
import BookPage from './pages/BookPage';
import Add from './pages/Add';
import Editor from './pages/Editor';
import Dashboard from './pages/Dashboard';
import KindleImport from './pages/KindleImport';
import SettingsPage from './pages/SettingsPage';

const links = [
  { to: '/', label: 'Início', end: true },
  { to: '/biblioteca', label: 'Biblioteca' },
  { to: '/adicionar', label: 'Adicionar' },
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/kindle', label: 'Kindle' },
  { to: '/ajustes', label: 'Ajustes' },
];

function NavBar() {
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [pending, setPending] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (loc.pathname === '/biblioteca') setQ(params.get('q') ?? '');
  }, [loc.pathname, params]);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', on);
    return () => window.removeEventListener('scroll', on);
  }, []);
  useEffect(() => {
    api('/api/ingest').then((l) => setPending(l.length)).catch(() => {});
  }, [loc.pathname]);

  // search-as-you-type: the Biblioteca page owns the filters, the bar only edits `q`
  useEffect(() => {
    const t = setTimeout(() => {
      const cur = params.get('q') ?? '';
      if (q === cur) return;
      if (loc.pathname === '/biblioteca') {
        const next = new URLSearchParams(params);
        q ? next.set('q', q) : next.delete('q');
        nav(`/biblioteca?${next}`, { replace: true });
      } else if (q) nav(`/biblioteca?q=${encodeURIComponent(q)}`);
    }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <header className={`sticky top-0 z-40 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 transition sm:px-8 ${scrolled ? 'bg-bg/95 shadow-lg shadow-black/40 backdrop-blur' : 'bg-gradient-to-b from-black/70 to-transparent'}`}>
      <Link to="/" className="text-2xl font-black tracking-tight text-accent">
        BOOKFLIX
      </Link>
      <nav className="order-3 flex w-full gap-1 overflow-x-auto text-sm sm:order-none sm:w-auto">
        {links.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `relative whitespace-nowrap rounded px-3 py-1.5 transition ${isActive ? 'font-semibold text-ink' : 'text-muted hover:text-ink'}`}>
            {l.label}
            {l.to === '/adicionar' && pending > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">{pending}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="ml-auto w-full max-w-xs sm:w-64">
        <input
          className="input !rounded-full !bg-black/50 !px-4"
          type="search"
          placeholder="Buscar título, autor, nota…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Buscar na biblioteca"
        />
      </div>
    </header>
  );
}

/** One quiet notice when a newer release exists on GitHub. Never downloads or installs anything. */
function UpdateNotice() {
  const [update, setUpdate] = useState<{ version: string; url: string } | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    api('/api/update-check').then((r) => setUpdate(r.update)).catch(() => {});
  }, []);
  if (!update || hidden) return null;
  const open = () => (window.bookflix ? void window.bookflix.openExternal(update.url) : void window.open(update.url, '_blank', 'noopener,noreferrer'));
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 bg-surface2 px-4 py-2 text-sm" role="status">
      <span>Há uma versão nova do Bookflix: {update.version}.</span>
      <button className="font-semibold text-accent2 underline" onClick={open}>
        Ver e baixar
      </button>
      <button className="text-muted hover:text-ink" onClick={() => setHidden(true)} aria-label="Dispensar aviso">
        ✕
      </button>
    </div>
  );
}

export default function App() {
  return (
    <div className="min-h-screen">
      <UpdateNotice />
      <NavBar />
      <main className="pb-16">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/biblioteca" element={<Library />} />
          <Route path="/livro/:id" element={<BookPage />} />
          <Route path="/adicionar" element={<Add />} />
          <Route path="/editor/:id" element={<Editor />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/kindle" element={<KindleImport />} />
          <Route path="/ajustes" element={<SettingsPage />} />
          <Route path="*" element={<div className="p-12 text-center text-muted">Página não encontrada.</div>} />
        </Routes>
      </main>
      <Toaster />
      <BugReport />
    </div>
  );
}
