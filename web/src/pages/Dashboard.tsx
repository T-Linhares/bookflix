import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, coverSrc } from '../api';
import { Cover, Empty, ErrorBox, Spinner, useAsync } from '../components/ui';

interface Dash {
  year: number;
  yearsAvailable: number[];
  totals: { books: number; read: number; reading: number; unread: number; hours: number; pages: number; highlights: number; avgRating: number | null; readingDays: number };
  goal: { target: number; done: number };
  months: { month: number; books: number; hours: number; pages: number }[];
  heatmap: { day: string; minutes: number }[];
  streak: { current: number; longest: number };
  pagesPerHour: number | null;
  avgHoursPerBook: number | null;
  topAuthors: { name: string; count: number }[];
  topSeries: { name: string; count: number }[];
  topTags: { name: string; count: number }[];
  ratingDist: { rating: number; count: number }[];
  recentlyFinished: { id: number; title: string; authors: string; cover: string | null; finishedAt: number }[];
}

const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const ACCENT = '#e50914';
const tooltipStyle = { background: '#15151d', border: '1px solid #2c2c3a', borderRadius: 8, color: '#f3f3f7', fontSize: 12 };

function Tile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card !p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-3xl font-black tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

function Bars({ title, data, to }: { title: string; data: { name: string; count: number }[]; to: (n: string) => string }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="card">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {!data.length ? (
        <p className="text-sm text-muted">Sem dados ainda.</p>
      ) : (
        <ul className="space-y-2">
          {data.map((d) => (
            <li key={d.name}>
              <Link to={to(d.name)} className="group block">
                <div className="flex justify-between text-xs">
                  <span className="truncate group-hover:underline">{d.name}</span>
                  <span className="text-muted tabular-nums">{d.count}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-surface2">
                  <div className="h-full rounded bg-accent" style={{ width: `${(d.count / max) * 100}%` }} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Heatmap({ data }: { data: { day: string; minutes: number }[] }) {
  const { weeks, byDay } = useMemo(() => {
    const byDay = new Map(data.map((d) => [d.day, d.minutes]));
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 7 * 52 - end.getDay());
    const weeks: { day: string; minutes: number; future: boolean }[][] = [];
    const cur = new Date(start);
    while (cur <= end) {
      const w: { day: string; minutes: number; future: boolean }[] = [];
      for (let i = 0; i < 7; i++) {
        const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
        w.push({ day: iso, minutes: byDay.get(iso) ?? 0, future: cur > end });
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push(w);
    }
    return { weeks, byDay };
  }, [data]);
  const level = (m: number) => (m === 0 ? 0 : m < 15 ? 1 : m < 30 ? 2 : m < 60 ? 3 : 4);
  const colors = ['#1f1f2b', '#5a0f14', '#8f1119', '#c20d17', '#ff3b47'];
  return (
    <div className="card overflow-x-auto">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Ritmo diário (últimas 52 semanas)</h3>
        <span className="text-xs text-muted">{byDay.size} dias lendo</span>
      </div>
      <div className="flex gap-[3px]" role="img" aria-label="Mapa de calor de leitura diária">
        {weeks.map((w, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            {w.map((d) => (
              <div key={d.day} title={d.future ? '' : `${new Date(d.day + 'T12:00').toLocaleDateString()} · ${d.minutes} min`} className="h-3 w-3 rounded-[3px]" style={{ background: d.future ? 'transparent' : colors[level(d.minutes)] }} />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-muted">
        menos
        {colors.map((c) => (
          <span key={c} className="h-3 w-3 rounded-[3px]" style={{ background: c }} />
        ))}
        mais
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [year, setYear] = useState<number | undefined>();
  const { data: d, error, loading } = useAsync(() => api<Dash>(`/api/dashboard${year ? `?year=${year}` : ''}`), [year]);
  if (loading && !d) return <Spinner />;
  if (error || !d) return <ErrorBox message={error ?? 'Sem dados'} />;
  if (!d.totals.books) return <Empty title="Ainda não há dados">Adicione livros e importe os dados do Kindle para ver seu desempenho.</Empty>;

  const goalPct = d.goal.target ? Math.min(100, Math.round((d.goal.done / d.goal.target) * 100)) : 0;
  const months = d.months.map((m) => ({ ...m, name: MONTHS[m.month - 1] }));

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 pt-6 sm:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Dashboard de leitura</h1>
        <select className="input !w-auto" value={d.year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Ano">
          {d.yearsAvailable.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label={`Lidos em ${d.year}`} value={d.goal.done} sub={`${d.totals.read} no total`} />
        <Tile label="Horas lendo" value={d.totals.hours} sub={`${d.totals.readingDays} dias com leitura`} />
        <Tile label="Páginas" value={d.totals.pages.toLocaleString()} sub={d.pagesPerHour ? `${d.pagesPerHour} págs/hora` : undefined} />
        <Tile label="Sequência" value={`${d.streak.current} d`} sub={`maior: ${d.streak.longest} dias`} />
        <Tile label="Lendo agora" value={d.totals.reading} sub={`${d.totals.unread} na fila`} />
        <Tile label="Nota média" value={d.totals.avgRating ? `${d.totals.avgRating} ★` : '—'} />
        <Tile label="Destaques e notas" value={d.totals.highlights} />
        <Tile label="Tempo médio/livro" value={d.avgHoursPerBook ? `${d.avgHoursPerBook} h` : '—'} />
      </div>

      <div className="card">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">Meta de {d.year}</h3>
          <span className="text-sm tabular-nums">
            {d.goal.done} / {d.goal.target} livros · {goalPct}%
          </span>
        </div>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-surface2" role="progressbar" aria-valuenow={goalPct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent2 transition-all" style={{ width: `${goalPct}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted">Altere a meta em Ajustes.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <h3 className="mb-3 text-sm font-semibold">Livros terminados por mês</h3>
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={months}>
                <CartesianGrid stroke="#2c2c3a" vertical={false} />
                <XAxis dataKey="name" stroke="#9b9bb0" fontSize={11} tickLine={false} />
                <YAxis stroke="#9b9bb0" fontSize={11} allowDecimals={false} tickLine={false} axisLine={false} width={28} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#ffffff10' }} formatter={(v) => [v, 'livros']} />
                <Bar dataKey="books" fill={ACCENT} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card">
          <h3 className="mb-3 text-sm font-semibold">Horas de leitura por mês</h3>
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={months}>
                <CartesianGrid stroke="#2c2c3a" vertical={false} />
                <XAxis dataKey="name" stroke="#9b9bb0" fontSize={11} tickLine={false} />
                <YAxis stroke="#9b9bb0" fontSize={11} tickLine={false} axisLine={false} width={28} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#ffffff10' }} formatter={(v, _n, p) => [`${v} h · ${p.payload.pages} págs`, 'leitura']} />
                <Bar dataKey="hours" fill="#ff7a82" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <Heatmap data={d.heatmap} />

      <div className="grid gap-4 md:grid-cols-3">
        <Bars title="Autores mais lidos" data={d.topAuthors} to={(n) => `/biblioteca?author=${encodeURIComponent(n)}&status=read`} />
        <Bars title="Séries mais lidas" data={d.topSeries} to={(n) => `/biblioteca?series=${encodeURIComponent(n)}`} />
        <Bars title="Tags mais lidas" data={d.topTags} to={(n) => `/biblioteca?tags=${encodeURIComponent(n)}&status=read`} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <h3 className="mb-3 text-sm font-semibold">Distribuição das notas</h3>
          <div className="h-44">
            <ResponsiveContainer>
              <BarChart data={d.ratingDist.map((r) => ({ ...r, name: '★'.repeat(r.rating) }))}>
                <XAxis dataKey="name" stroke="#9b9bb0" fontSize={11} tickLine={false} />
                <YAxis hide allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#ffffff10' }} formatter={(v) => [v, 'livros']} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {d.ratingDist.map((r) => (
                    <Cell key={r.rating} fill={r.rating >= 4 ? '#f5b84b' : r.rating === 3 ? '#c9953a' : '#8a6a35'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="card">
          <h3 className="mb-3 text-sm font-semibold">Terminados recentemente</h3>
          {!d.recentlyFinished.length ? (
            <p className="text-sm text-muted">Nenhum livro terminado em {d.year}.</p>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-1">
              {d.recentlyFinished.map((b) => (
                <Link key={b.id} to={`/livro/${b.id}`} className="w-20 shrink-0" title={b.title}>
                  <Cover book={{ ...b, cover: coverSrc(b) ? b.cover : null }} />
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
