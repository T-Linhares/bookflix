import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { scanLibrary, watchLibrary } from './library.ts';
import { watchInbox } from './ingest.ts';
import { startSyncLoop } from './syncService.ts';

export interface RunningServer {
  app: FastifyInstance;
  port: number;
  close(): Promise<void>;
}

/** Starts the API + web app and the folder watchers. `port: 0` lets the OS pick a free one (desktop app). */
export async function startServer({ port, host, token }: { port: number; host: string; token?: string }): Promise<RunningServer> {
  const app = await buildApp({ token });
  await app.listen({ port, host });
  const addr = app.server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;

  scanLibrary()
    .then((r) => r.added && console.log(`Biblioteca: ${r.added} livros novos`))
    .catch((e) => console.error('Falha ao varrer a biblioteca:', e));
  watchLibrary();
  watchInbox();
  startSyncLoop();

  return { app, port: actual, close: () => app.close() };
}
