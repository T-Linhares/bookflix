import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './db.ts';

// Command-line / development entry (`npm start`, `npm run dev`). The desktop app uses electron/main.ts instead.

// tiny .env loader (no dependency)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { startServer } = await import('./start.ts');

const port = Number(process.env.PORT ?? 3000);
try {
  // "localhost" makes Fastify bind both 127.0.0.1 and ::1, so http://localhost:3000 works whichever one the browser picks
  await startServer({ port, host: 'localhost' });
} catch (e: any) {
  if (e?.code === 'EADDRINUSE')
    console.error(`\nA porta ${port} já está em uso por outro programa (talvez outro Bookflix aberto).\nFeche-o, ou use outra porta: defina PORT=3001 e rode de novo.\n`);
  else console.error(e);
  process.exit(1);
}
console.log(`Bookflix pronto em http://localhost:${port}`);
