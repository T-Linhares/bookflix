import { db } from './db.ts';
import { getSettings } from './settings.ts';
import { splitAuthors } from './util.ts';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function streaks(days: string[]) {
  const set = new Set(days);
  let longest = 0;
  let run = 0;
  const sorted = [...set].sort();
  let prev: Date | null = null;
  for (const d of sorted) {
    const cur = new Date(`${d}T12:00:00`);
    run = prev && Math.round((cur.getTime() - prev.getTime()) / 86400000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = cur;
  }
  // current streak counts today or yesterday as the end
  let current = 0;
  const cursor = new Date();
  if (!set.has(iso(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (set.has(iso(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}

function topCounts(values: string[], limit = 8) {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => ({ name, count }));
}

export function dashboard(year = new Date().getFullYear()) {
  const books = db.prepare('select * from books where missing = 0').all() as any[];
  const read = books.filter((b) => b.status === 'read');
  const days = db.prepare('select day, sum(seconds) as seconds, sum(pages) as pages from reading_days group by day').all() as { day: string; seconds: number; pages: number }[];

  const totalSeconds = days.reduce((s, d) => s + d.seconds, 0);
  const totalPages = days.reduce((s, d) => s + d.pages, 0);
  const rated = books.filter((b) => b.rating);

  const finishedYear = (b: any) => (b.finished_at ? new Date(b.finished_at * 1000).getFullYear() : null);
  const readThisYear = read.filter((b) => finishedYear(b) === year);

  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, books: 0, hours: 0, pages: 0 }));
  for (const b of readThisYear) months[new Date(b.finished_at * 1000).getMonth()].books++;
  for (const d of days) {
    if (d.day.startsWith(String(year))) {
      const m = months[Number(d.day.slice(5, 7)) - 1];
      m.hours += d.seconds / 3600;
      m.pages += d.pages;
    }
  }
  months.forEach((m) => (m.hours = Math.round(m.hours * 10) / 10));

  const yearsAvailable = [...new Set([...read.map(finishedYear), ...days.map((d) => Number(d.day.slice(0, 4)))].filter((y): y is number => !!y))].sort((a, b) => b - a);
  const since = new Date();
  since.setDate(since.getDate() - 7 * 53);
  const heatmap = days.filter((d) => d.day >= iso(since)).map((d) => ({ day: d.day, minutes: Math.round(d.seconds / 60) }));

  const readAuthors = read.flatMap((b) => splitAuthors(b.authors).slice(0, 1));
  const ratingDist = [1, 2, 3, 4, 5].map((r) => ({ rating: r, count: rated.filter((b) => b.rating === r).length }));

  // reading speed from days with both time and pages
  const speedDays = days.filter((d) => d.seconds > 300 && d.pages > 0);
  const speedPages = speedDays.reduce((s, d) => s + d.pages, 0);
  const speedHours = speedDays.reduce((s, d) => s + d.seconds, 0) / 3600;

  return {
    year,
    yearsAvailable: yearsAvailable.length ? yearsAvailable : [year],
    totals: {
      books: books.length,
      read: read.length,
      reading: books.filter((b) => b.status === 'reading').length,
      unread: books.filter((b) => b.status === 'unread').length,
      hours: Math.round((totalSeconds / 3600) * 10) / 10,
      pages: totalPages,
      highlights: (db.prepare('select count(*) as n from highlights where deleted = 0').get() as { n: number }).n,
      avgRating: rated.length ? Math.round((rated.reduce((s, b) => s + b.rating, 0) / rated.length) * 10) / 10 : null,
      readingDays: days.length,
    },
    goal: { target: getSettings().yearlyGoal, done: readThisYear.length },
    months,
    heatmap,
    streak: streaks(days.map((d) => d.day)),
    pagesPerHour: speedHours > 0 ? Math.round(speedPages / speedHours) : null,
    avgHoursPerBook: read.length && totalSeconds ? Math.round((read.filter((b) => b.read_time).reduce((s, b) => s + b.read_time, 0) / Math.max(1, read.filter((b) => b.read_time).length) / 3600) * 10) / 10 : null,
    topAuthors: topCounts(readAuthors),
    topSeries: topCounts(read.map((b) => b.series)),
    topTags: topCounts(read.flatMap((b) => JSON.parse(b.tags || '[]'))),
    ratingDist,
    recentlyFinished: readThisYear
      .sort((a, b) => b.finished_at - a.finished_at)
      .slice(0, 8)
      .map((b) => ({ id: b.id, title: b.title, authors: b.authors, cover: b.cover, finishedAt: b.finished_at })),
  };
}
