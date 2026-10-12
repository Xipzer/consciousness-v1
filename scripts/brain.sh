#!/usr/bin/env bash
# Runs the narrator model on the local GPU with the Windows llama.cpp build, plus a TCP proxy so WSL can reach it.
# Usage: scripts/brain.sh start|stop|status
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$root/.env" ]] && { set -a; . "$root/.env"; set +a; }

WIN_DIR='C:\cv1'
WSL_DIR=/mnt/c/cv1
ENGINE="${CV1_ENGINE:-C:\\llm-eval\\engine\\llama-server.exe}"
MODEL="${CV1_MODEL:-C:\\llm-eval\\models\\Qwen3.5-4B-Q4_K_M.gguf}"
PORT=8091
PROXY_PORT=8092
CTX="${CV1_CTX:-32768}"
SLOTS="${CV1_SLOTS:-2}"
WIN=/mnt/c/Windows/System32
NODE='C:\nvm4w\nodejs\node.exe'

start() {
  mkdir -p "$WSL_DIR"
  cat > "$WSL_DIR/proxy.js" <<JS
const net = require('net')
net.createServer((c) => { const u = net.connect($PORT, '127.0.0.1'); c.pipe(u).pipe(c); u.on('error', () => c.destroy()); c.on('error', () => u.destroy()) }).listen($PROXY_PORT, '0.0.0.0')
JS
  printf '@echo off\r\n"%s" -m "%s" --alias narrator --host 127.0.0.1 --port %s -ngl 99 -c %s -np %s -fa on --jinja --metrics --slots --log-file "%s\\server.log"\r\n' \
    "$ENGINE" "$MODEL" "$PORT" "$CTX" "$SLOTS" "$WIN_DIR" > "$WSL_DIR/serve.bat"
  printf '@echo off\r\n"%s" "%s\\proxy.js"\r\n' "$NODE" "$WIN_DIR" > "$WSL_DIR/proxy.bat"
  rm -f "$WSL_DIR/server.log"
  (cd /mnt/c && "$WIN/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -Command \
    "Start-Process -FilePath '$WIN_DIR\\serve.bat' -WindowStyle Hidden; Start-Process -FilePath '$WIN_DIR\\proxy.bat' -WindowStyle Hidden")
  echo "started; poll with: scripts/brain.sh status"
}

stop() {
  (cd /mnt/c && "$WIN/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -Command \
    "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -eq 'llama-server.exe' -and \$_.CommandLine -like '*--port $PORT*') -or (\$_.Name -eq 'node.exe' -and \$_.CommandLine -like '*cv1*proxy.js*') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }")
  echo stopped
}

status() {
  local url="${CV1_LLM_URL:-}"
  [[ -z "$url" ]] && { echo "CV1_LLM_URL not set (see .env.example)"; exit 1; }
  curl -s -m 3 "$url/health" || echo "unreachable"
  echo
}

"${1:-status}"
