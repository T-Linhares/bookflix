# Bookflix

Sua biblioteca pessoal em formato "Netflix", e a etapa **antes** de o livro ir para o Kindle (KOReader).

```
arquivo novo ─► Bookflix (busca metadados, padroniza nome) ─► pasta Livros ─► Kindle
                                                                    ▲
                     importa notas, progresso e estatísticas ◄── USB ┘
```

Software livre (MIT), fornecido **como está, sem garantia**. Faça cópia dos seus livros.

## Instalar

Baixe o instalador da [página de versões](https://github.com/T-Linhares/bookflix/releases):

| Sistema | Arquivo |
|---|---|
| Windows 10/11 | `Bookflix-<versão>-win-x64.exe` (instala só para o seu usuário, sem pedir administrador) |
| Linux | `Bookflix-<versão>-linux-x64.AppImage` (torne executável e abra) ou o `.deb` |

- **Windows:** os instaladores ainda não são assinados digitalmente, então o SmartScreen mostra "O Windows protegeu o computador" na primeira abertura. Clique em *Mais informações → Executar assim mesmo*.
- **Linux (AppImage):** precisa de FUSE (`libfuse2`). Se não quiser, use o `.deb`.
- Não precisa instalar Node nem nada além disso.
- Atualizações: o app **só avisa** quando há versão nova (desligue em Ajustes). Você baixa e instala quando quiser.

## Primeiro uso

1. **Ajustes → Pasta da biblioteca:** escolha qualquer pasta. Para ter os livros em outros aparelhos, use uma pasta do **Dropbox** ou do **Google Drive para computador** (os atalhos aparecem quando o aplicativo do serviço está instalado).
2. **Adicionar:** arraste um livro. O app preenche série, ordem, autor, editora, ano da edição, tags e descrição; mostra o nome final e a pasta; você confirma e ele salva na biblioteca.
3. **Kindle → Enviar para o Kindle** (ou o botão na página do livro): com o Kindle ligado por USB, o app copia os livros prontos para `documents/Livros` e marca cada um como "No Kindle". Nunca sobrescreve um arquivo de mesmo nome e tamanho diferente. Para liberar espaço, o botão **Retirar do Kindle** (página do livro) apaga só a cópia do Kindle, depois de você confirmar: o livro continua na biblioteca e no Drive/Dropbox, e as notas e o progresso do KOReader ficam no Kindle.
4. **Kindle → Importar:** com o Kindle ligado por USB, importe destaques, notas, progresso, nota/resenha e tempo de leitura (KOReader). O caminho de volta também existe: o que você editou no Bookflix (resenha, estrelas, status e o texto das notas dos destaques) é gravado no arquivo de dados do KOReader, só nos livros que já foram abertos no Kindle. Destaques nunca são criados nem apagados no Kindle, e "não lido" não é enviado (o KOReader não tem esse estado).

## Sincronizar entre aparelhos (experimental)

Em **Ajustes → Sincronizar entre aparelhos**. Mantém notas, destaques, progresso, avaliações, metas e lista de desejos iguais nos seus computadores, **usando a própria pasta da biblioteca** no Dropbox ou no Google Drive:

- O primeiro aparelho clica em *Ativar nesta pasta*: nasce um **ID de biblioteca** em `.bookflix-sync/library.json`.
- Nos outros, escolha a mesma pasta sincronizada e clique em *Entrar nela*.
- Cada aparelho grava só o próprio arquivo em `.bookflix-sync/devices/`; o banco de dados de verdade fica sempre local (cliente de nuvem corrompe SQLite). Em edições simultâneas da mesma informação, vale a mais recente.
- O app nunca lê, grava ou apaga os seus livros nessa pasta. Os livros viajam pelo próprio serviço de nuvem.
- As **chaves de API** também sincronizam (dá para desligar em Ajustes → Chaves de API), criptografadas com o ID da biblioteca. Atenção: o ID fica na mesma pasta, então isso só evita texto aberto; quem acessar a pasta consegue ler as chaves. Os protetores de tela revisados também viajam por ela, em `.bookflix-sync/screensavers/`.
- Limites: um livro só recebe notas e progresso depois que o arquivo dele chega ao aparelho; remover um livro não é sincronizado; os relógios dos aparelhos precisam estar certos; no Linux não existe cliente oficial do Google Drive (use Dropbox, ou outro serviço que sincronize uma pasta, escolhendo-a à mão).

## Nome dos arquivos

Padrão da indústria (Calibre), curto: `Autor - Título.epub`, dentro de `Autor/Série/`. Subtítulo cortado, limite de ~100 caracteres. Série e ordem ficam gravadas **dentro** do EPUB (`calibre:series`), e o KOReader as exibe. O modelo é configurável em Ajustes.

## Busca de metadados e chaves

Ordem: Google Books → Open Library / BrasilAPI → gerado. **Tudo sai direto do seu computador para cada serviço**; não existe servidor do Bookflix no meio.

- **Google Books:** sem chave usa a cota compartilhada, que costuma estar esgotada (erro 429); a busca continua no Open Library e na BrasilAPI. Para mais resultados, crie uma chave gratuita no Google Cloud (API "Books API") e cole em Ajustes.
- **Open Library / BrasilAPI:** sem chave. O Open Library só aceita edição no idioma do arquivo; outro idioma aparece como alternativa, nunca é aplicado sozinho.
- **Gerado:** série pelo padrão do título (`Título (Série, #3)`), e sinopse/tags por IA se você colocar uma chave em Ajustes: **Gemini** (grátis, aistudio.google.com), **Anthropic** ou **OpenAI (ChatGPT)**. Você escolhe qual modelo é consultado primeiro; se um falhar, o app tenta o próximo. Campos gerados ficam marcados e são editáveis. (Uma assinatura do ChatGPT não inclui acesso à API; a chave da OpenAI é cobrada à parte.)
- As chaves ficam cifradas pelo sistema (DPAPI no Windows, chaveiro no Linux) quando ele oferece isso; se não, ficam em texto simples no banco local e Ajustes avisa.

## Privacidade

O app não tem conta, servidor, telemetria nem relatório automático de falhas. Nada é enviado ao autor. As únicas conexões de rede são as consultas de metadados/IA que você dispara, a consulta opcional de versão nova (uma requisição anônima à API pública do GitHub) e a sincronização, que só usa a pasta de nuvem escolhida por você.

O botão de bug (canto inferior direito) **não envia nada sozinho**: abre no navegador a página de nova issue do GitHub com o seu texto, e você revisa e envia com a sua conta.

Os dados ficam em `%APPDATA%\Bookflix` (Windows) ou `~/.config/Bookflix` (Linux): banco SQLite, capas e backups para desfazer.

## Limites conhecidos

- Metadados só são gravados dentro de EPUB e PDF. MOBI/AZW3 recebem só o nome e as pastas.
- Não há fonte da Hardcover ainda.
- Recomendações vêm do Google Books e do Open Library em inglês; livros que você tem traduzidos aparecem como novos. Use o botão **Já tenho** para ocultá-los.
- Não renomeie/edite um livro depois de enviado ao Kindle: o KOReader liga notas e progresso ao nome do arquivo (o app avisa).
- Interface só em português por enquanto.

## Desenvolvimento

Requer Node 22.5 ou superior (usa o SQLite embutido, sem compilar nada).

```bash
npm install
npm run dev          # API em :3000 e interface em http://localhost:5173
npm run electron:dev # o app desktop (compila a interface e abre a janela)
npm test             # testes (Vitest)
npm run typecheck
npm run demo         # biblioteca de exemplo isolada; siga a instrução que ele imprime
```

Modo navegador, sem Electron: `npm run build && npm start` e abra http://localhost:3000 (ou `Bookflix.bat` no Windows).

### Gerar os instaladores

```bash
npm run dist:win     # no Windows: release/Bookflix-<versão>-win-x64.exe
npm run dist:linux   # no Linux: .AppImage e .deb
npm run electron:smoke -- release/win-unpacked/Bookflix.exe   # verifica o app empacotado
```

O fluxo [.github/workflows/release.yml](.github/workflows/release.yml) faz isso nos dois sistemas e publica na página de versões quando se cria uma tag `vX.Y.Z`.

Antes da primeira versão pública, defina o repositório real com `node scripts/set-repo.mjs dono/nome`. Ele troca `server/version.ts` (`DEFAULT_REPO`; enquanto for o valor de exemplo, o botão de bug e o aviso de versão ficam desligados), o `homepage` do `package.json` e o link de instalação deste README. Depois apague esta seção e ajuste o nome em `LICENSE`.
