@echo off
rem Abre o Bookflix: prepara o que faltar, sobe o servidor e abre o navegador quando ele estiver pronto.
cd /d "%~dp0"
title Bookflix

if not defined PORT set PORT=3000

if not exist node_modules (
  echo Instalando dependencias...
  call npm install || goto :erro
)
if not exist web\dist\index.html (
  echo Montando a interface...
  call npm run build || goto :erro
)

rem Espera o servidor responder (ate 90 s) e so entao abre o navegador.
start "" /b powershell -NoProfile -Command "$u='http://localhost:%PORT%/api/facets'; for($i=0;$i -lt 90;$i++){ try { Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process 'http://localhost:%PORT%'; exit } catch { Start-Sleep -Seconds 1 } }"

echo.
echo Iniciando o Bookflix em http://localhost:%PORT%
echo O navegador abre sozinho quando estiver pronto. Feche esta janela para encerrar.
echo.
call npm start
echo.
echo O servidor parou. Se houver uma mensagem de erro acima, copie e me envie.
pause
goto :eof

:erro
echo.
echo Algo deu errado. Copie a mensagem acima e me envie.
pause
