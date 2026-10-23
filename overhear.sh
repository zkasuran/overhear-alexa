#!/usr/bin/env bash
# Overhear launcher: one command from a fresh clone to a running app.
#
#   ./overhear.sh            interactive menu
#   ./overhear.sh demo       mock mode, no keys, no spend: server + Alexa+ simulator on http://127.0.0.1:5173
#   ./overhear.sh live       real voices (Amazon Polly) and real scripts (Amazon Bedrock or an OpenAI-compatible model)
#   ./overhear.sh echo       live mode plus the Overhear Studio skill on your own Echo
#   ./overhear.sh configure  set or change the live-mode settings
#   ./overhear.sh status | logs | stop | verify
#
# Needs Node 22+ and ffmpeg. Linux or macOS (on Windows, use WSL). Settings live in
# ~/.config/overhear/config.env (chmod 600). Keys are read from files, never passed on a command line.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"
CONF_DIR=${OVERHEAR_CONFIG_DIR:-$HOME/.config/overhear}
CONF=$CONF_DIR/config.env
RUN=$ROOT/.run
LOGS=$RUN/logs
mkdir -p "$LOGS"

b=$'\033[1m'; g=$'\033[32m'; y=$'\033[33m'; r=$'\033[31m'; d=$'\033[2m'; n=$'\033[0m'
[ -t 1 ] || { b=; g=; y=; r=; d=; n=; }
say() { printf '%s\n' "$*"; }
ok() { printf '%s✓%s %s\n' "$g" "$n" "$*"; }
warn() { printf '%s!%s %s\n' "$y" "$n" "$*"; }
die() { printf '%s✗ %s%s\n' "$r" "$*" "$n" >&2; exit 1; }
ask() { local q=$1 def=${2:-} a; read -r -p "$q${def:+ [$def]}: " a </dev/tty || true; printf '%s' "${a:-$def}"; }
yes_no() { local a; a=$(ask "$1 (y/n)" "${2:-y}"); [[ $a =~ ^[Yy] ]]; }

# ---------- prerequisites ----------

need_node() {
  command -v node >/dev/null || die "Node.js 22 or newer is required. Install it from https://nodejs.org (or: nvm install 22), then run this again."
  local major; major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || die "Node.js $(node -v) found, 22 or newer is required (nvm install 22)."
  command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || die "ffmpeg is required. Install it: sudo apt install ffmpeg  (macOS: brew install ffmpeg)"
  ok "Node $(node -v), $(ffmpeg -version | head -1 | cut -d' ' -f1-3)"
}

build() {
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    say "Installing dependencies (first run only, about a minute)..."
    npm ci --no-audit --no-fund --loglevel=error >"$LOGS/npm-ci.log" 2>&1 || die "npm ci failed, see $LOGS/npm-ci.log"
  fi
  if [ ! -f packages/server/dist/main.js ] || [ -n "$(find packages/*/src -newer packages/server/dist/main.js -name '*.ts' -print -quit 2>/dev/null)" ]; then
    say "Building..."
    npx tsc -b >"$LOGS/build.log" 2>&1 || die "build failed, see $LOGS/build.log"
    npm run --silent build -w @overhear/sim-web >>"$LOGS/build.log" 2>&1 || die "simulator build failed, see $LOGS/build.log"
  fi
  [ -f packages/sim-web/dist/index.html ] || npm run --silent build -w @overhear/sim-web >>"$LOGS/build.log" 2>&1
  ok "built"
}

# ---------- process control ----------

pid_of() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null && cat "$RUN/$1.pid"; }
start_bg() { # name, then the command
  local name=$1; shift
  "$@" >"$LOGS/$name.log" 2>&1 &
  echo $! >"$RUN/$name.pid"
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_http() { node scripts/wait-for.mjs "$1" "${2:-40}" >/dev/null 2>&1; }

stop_all() {
  local any=0
  for name in tunnel alexa web host server; do
    local p; p=$(pid_of "$name" || true)
    if [ -n "$p" ]; then kill "$p" 2>/dev/null || true; any=1; fi
    rm -f "$RUN/$name.pid"
  done
  pkill -f "vite preview --host 127.0.0.1 --port 5173" 2>/dev/null || true
  local i p
  for i in $(seq 1 20); do
    local busy=0
    for p in 8787 8788 5173 8790; do port_busy "$p" && busy=1; done
    [ $busy = 0 ] && break
    sleep 0.5
  done
  [ $any = 1 ] && ok "stopped" || say "nothing was running"
}

check_ports() {
  for p in 8787 8788 5173 "$@"; do
    port_busy "$p" && die "port $p is already in use. Run ./overhear.sh stop, or stop whatever else uses it."
  done
  return 0
}

# ---------- configuration ----------

load_conf() { [ -f "$CONF" ] && { set -a; . "$CONF"; set +a; }; return 0; }

configure() {
  mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
  load_conf
  say ""
  say "${b}Live-mode settings${n}  ${d}(saved to $CONF)${n}"
  say ""
  say "Voices use ${b}Amazon Polly${n} (generative engine). You need AWS credentials that can call"
  say "polly:SynthesizeSpeech: run 'aws configure', or 'aws sso login', or export AWS_PROFILE."
  local region; region=$(ask "AWS region for Polly and Bedrock" "${AWS_REGION:-us-west-2}")
  local profile; profile=$(ask "AWS profile (leave empty for the default credentials)" "${AWS_PROFILE:-}")
  say ""
  say "Who writes the scripts?"
  say "  1) Amazon Bedrock, Nova (default; your account needs Bedrock model access)"
  say "  2) Any OpenAI-compatible API (GMI Cloud, OpenAI, OpenRouter, a local server...)"
  local choice; choice=$(ask "Choose 1 or 2" "$([ "${OVERHEAR_TEXT:-bedrock}" = openai ] && echo 2 || echo 1)")
  local text=bedrock base="" model="" keyfile="$CONF_DIR/text-api.key"
  if [ "$choice" = 2 ]; then
    text=openai
    base=$(ask "API base URL" "${OVERHEAR_OPENAI_BASE_URL:-https://api.gmi-serving.com/v1}")
    model=$(ask "Model id" "${OVERHEAR_OPENAI_MODEL:-deepseek-ai/deepseek-v4.1-flash-1017}")
    if [ -s "$keyfile" ] && ! yes_no "An API key is already saved. Replace it?" n; then :; else
      local key; read -r -s -p "API key (hidden): " key </dev/tty; echo
      [ -n "$key" ] || die "no key entered"
      umask 077; printf '%s\n' "$key" >"$keyfile"; unset key
    fi
  fi
  umask 077
  {
    echo "# Overhear live-mode settings. Written by ./overhear.sh configure."
    echo "AWS_REGION=$region"
    [ -n "$profile" ] && echo "AWS_PROFILE=$profile"
    echo "OVERHEAR_TEXT=$text"
    if [ "$text" = openai ]; then
      echo "OVERHEAR_OPENAI_BASE_URL=$base"
      echo "OVERHEAR_OPENAI_MODEL=$model"
      echo "OVERHEAR_OPENAI_KEY_FILE=$keyfile"
    fi
  } >"$CONF"
  ok "saved $CONF"
  check_live
}

check_live() {
  load_conf
  say "Checking Amazon Polly..."
  local probe; probe=$(mktemp)
  if AWS_REGION=${AWS_REGION:-us-west-2} node --input-type=module -e '
    import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
    const c = new PollyClient({ region: process.env.AWS_REGION });
    const r = await c.send(new SynthesizeSpeechCommand({ Engine: "generative", VoiceId: "Ruth", OutputFormat: "mp3", Text: "ok" }));
    if (!r.AudioStream) process.exit(1);' 2>"$probe"; then
    ok "Amazon Polly works in ${AWS_REGION:-us-west-2}"
  else
    warn "Amazon Polly call failed: $(tail -1 "$probe")"
    warn "Fix the AWS credentials (aws configure / aws sso login), then run ./overhear.sh configure again."
    rm -f "$probe"; return 1
  fi
  rm -f "$probe"
  if [ "${OVERHEAR_TEXT:-bedrock}" = openai ]; then
    say "Checking the text model..."
    local code; code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "${OVERHEAR_OPENAI_BASE_URL%/}/chat/completions" \
      -H "authorization: Bearer $(head -1 "$OVERHEAR_OPENAI_KEY_FILE")" -H 'content-type: application/json' \
      -d "{\"model\":\"$OVERHEAR_OPENAI_MODEL\",\"max_tokens\":5,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" || true)
    [ "$code" = 200 ] && ok "text model $OVERHEAR_OPENAI_MODEL answers" || { warn "text model returned HTTP $code. Check the URL, model id and key."; return 1; }
  else
    say "Checking Amazon Bedrock..."
    if AWS_REGION=${AWS_REGION:-us-west-2} node --input-type=module -e '
      import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
      const c = new BedrockRuntimeClient({ region: process.env.AWS_REGION });
      await c.send(new ConverseCommand({ modelId: "amazon.nova-pro-v1:0", messages: [{ role: "user", content: [{ text: "hi" }] }], inferenceConfig: { maxTokens: 5 } }));' 2>"$LOGS/bedrock-check.log"; then
      ok "Amazon Bedrock Nova answers"
    else
      warn "Bedrock call failed: $(tail -1 "$LOGS/bedrock-check.log")"
      warn "Enable Nova model access in the Bedrock console, or choose option 2 in ./overhear.sh configure."
      return 1
    fi
  fi
}

# ---------- run modes ----------

start_stack() { # mock|live
  local mode=$1
  check_ports
  # The server refuses a token file others can read (git checks files out 0644).
  chmod 600 fixtures/server-tokens fixtures/server-tokens-2 fixtures/test-token fixtures/test-token2
  local data; data=$(mktemp -d)
  if [ "$mode" = live ]; then
    load_conf
    [ -f "$CONF" ] || { say "Live mode is not configured yet."; configure || die "live mode is not ready"; load_conf; }
    start_bg server env OVERHEAR_MODELS=aws OVERHEAR_STORE=local OVERHEAR_DATA_DIR="$data/data" \
      OVERHEAR_MEDIA_DIR="$data/media" OVERHEAR_TOKENS_FILE=fixtures/server-tokens node packages/server/dist/main.js
  else
    start_bg server env OVERHEAR_MODELS=mock OVERHEAR_STORE=local OVERHEAR_DATA_DIR="$data/data" \
      OVERHEAR_MEDIA_DIR="$data/media" OVERHEAR_TOKENS_FILE=fixtures/server-tokens node packages/server/dist/main.js
  fi
  wait_http http://127.0.0.1:8787/health 40 || die "the server did not start, see $LOGS/server.log"
  ok "MCP server on http://127.0.0.1:8787/mcp ($(curl -s 127.0.0.1:8787/health))"
  start_bg host env SIM_TOKEN_FILE=fixtures/test-token node packages/sim-host/dist/main.js
  wait_http http://127.0.0.1:8788/health 20 || sleep 2
  (cd packages/sim-web && exec npx vite preview --host 127.0.0.1 --port 5173 --strictPort) >"$LOGS/web.log" 2>&1 &
  echo $! >"$RUN/web.pid"
  wait_http http://127.0.0.1:5173/ 30 || die "the simulator did not start, see $LOGS/web.log"
  ok "Alexa+ simulator on ${b}http://127.0.0.1:5173${n}"
}

open_browser() {
  if command -v xdg-open >/dev/null; then xdg-open "$1" >/dev/null 2>&1 &
  elif command -v open >/dev/null; then open "$1"; fi
  return 0
}

how_to_use() {
  say ""
  say "${b}Open http://127.0.0.1:5173${n}, then:"
  say "  1. Type any topic, paste a https:// link or some text, pick a format, press Plan episode."
  say "  2. Press Play. Part 1 starts while the rest is still being written."
  say "  3. Cut in: Go deeper, Skip, Back, Time left, or type a question like 'what did they say about X?'"
  say ""
  say "${d}Logs: ./overhear.sh logs    Stop: ./overhear.sh stop${n}"
}

cmd_demo() { need_node; build; start_stack mock; how_to_use; open_browser http://127.0.0.1:5173; }
cmd_live() { need_node; build; start_stack live; how_to_use; open_browser http://127.0.0.1:5173; }

ensure_cloudflared() {
  command -v cloudflared >/dev/null && return 0
  local bin=$HOME/.local/bin/cloudflared os arch
  [ -x "$bin" ] && { export PATH=$HOME/.local/bin:$PATH; return 0; }
  os=$(uname -s); arch=$(uname -m)
  say "Installing cloudflared (the free https tunnel the Echo reaches this machine through)..."
  mkdir -p "$HOME/.local/bin"
  case "$os-$arch" in
    Linux-x86_64) curl -fsSL -o "$bin" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 ;;
    Linux-aarch64) curl -fsSL -o "$bin" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 ;;
    Darwin-*) command -v brew >/dev/null && brew install cloudflared || die "install cloudflared: brew install cloudflared" ;;
    *) die "install cloudflared for $os $arch: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" ;;
  esac
  [ -f "$bin" ] && chmod +x "$bin"
  export PATH=$HOME/.local/bin:$PATH
  ok "cloudflared installed"
}

ensure_ask() {
  if ! command -v ask >/dev/null; then
    say "Installing the Alexa Skills Kit CLI (npm install -g ask-cli)..."
    npm install -g ask-cli --loglevel=error >"$LOGS/ask-cli.log" 2>&1 || die "could not install ask-cli, see $LOGS/ask-cli.log"
  fi
  if ! ask smapi list-skills-for-vendor >/dev/null 2>&1; then
    say ""
    say "${b}Sign in to the Alexa developer console once.${n}"
    say "Use the ${b}same Amazon account your Echo is signed in to${n}."
    say "A browser opens. Sign in and press Allow. Then:"
    say "  - Profile name: press Enter (default)"
    say "  - 'Do you want to link your AWS account...?': answer ${b}No${n} (this skill is hosted on this machine)"
    say ""
    ask configure </dev/tty || die "ask configure did not finish"
    ask smapi list-skills-for-vendor >/dev/null 2>&1 || die "still not signed in to the Alexa developer console"
  fi
  ok "Alexa developer console signed in"
}

cmd_echo() {
  need_node; build
  load_conf
  if [ -f "$CONF" ] && check_live >/dev/null 2>&1; then :; else
    warn "The Echo plays real audio best in live mode."
    if yes_no "Configure live mode now? (No runs the Echo in mock mode, a test tone)" y; then configure || true; fi
  fi
  ensure_ask
  ensure_cloudflared
  check_ports 8790
  if [ -f "$CONF" ] && check_live >/dev/null 2>&1; then start_stack live; else start_stack mock; fi

  start_bg tunnel cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8790
  local url="" i
  for i in $(seq 1 30); do
    url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOGS/tunnel.log" | head -1 || true)
    [ -n "$url" ] && break; sleep 1
  done
  [ -n "$url" ] || die "the tunnel did not start, see $LOGS/tunnel.log"
  ok "public https tunnel $url"

  say "Creating or updating the Overhear Studio skill (about 1 minute)..."
  alexa/deploy.sh "$url" >"$LOGS/deploy.log" 2>&1 || die "skill deploy failed, see $LOGS/deploy.log"
  local id; id=$(cat alexa/.skill-id)
  ok "skill $id ready (development stage)"

  start_bg alexa env SIM_TOKEN_FILE=fixtures/test-token ALEXA_PUBLIC_BASE="$url" ALEXA_SKILL_ID="$id" \
    node packages/sim-host/dist/alexa/main.js
  for i in $(seq 1 20); do curl -s -m 3 "$url/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -s -m 5 "$url/health" >/dev/null 2>&1 && ok "skill endpoint reachable at $url/alexa" || warn "the tunnel is still warming up; give it 30 seconds"

  say ""
  say "${b}Now talk to your Echo${n} (signed in to the same Amazon account):"
  say "  \"Alexa, open overhear studio\""
  say "  \"Brief me on <any topic>\"            e.g. the James Webb telescope, how sourdough rises"
  say "  wait about 10 seconds, then: \"Alexa, ask overhear studio to play\""
  say "  while it plays:"
  say "    \"Alexa, tell overhear studio to go deeper\""
  say "    \"Alexa, ask overhear studio what did they say about <something>\""
  say "    \"Alexa, ask overhear studio how long is left\""
  say "    \"Alexa, next\"  \"Alexa, pause\"  \"Alexa, resume\""
  say ""
  say "If Alexa says she is not sure how to help: in the Alexa app open More > Skills & Games >"
  say "Your Skills > Dev and check Overhear Studio is there and enabled, and set the Echo's language to"
  say "an English locale (US, India, UK, Australia or Canada)."
  say "The simulator also runs at http://127.0.0.1:5173. Keep this machine awake while you use the Echo."
}

cmd_status() {
  for name in server host web alexa tunnel; do
    local p; p=$(pid_of "$name" || true)
    [ -n "$p" ] && ok "$name running (pid $p)" || say "  $name not running"
  done
  curl -s -m 2 127.0.0.1:8787/health 2>/dev/null && echo
}

cmd_logs() { tail -n 30 "$LOGS"/{server,host,web,alexa,tunnel}.log 2>/dev/null || say "no logs yet"; }
cmd_verify() { need_node; ./verify.sh; }

menu() {
  say ""
  say "${b}Overhear for Alexa+${n}  ${d}the podcast you can interrupt${n}"
  say ""
  say "  1) Demo        mock mode, no keys, opens the Alexa+ simulator"
  say "  2) Live        real Amazon Polly voices and real scripts"
  say "  3) Echo        live mode on your own Echo device"
  say "  4) Configure   set the live-mode keys and models"
  say "  5) Status      6) Logs      7) Stop      8) Verify (run the release gate)"
  say "  q) Quit"
  say ""
  case "$(ask "Choose" 1)" in
    1) cmd_demo ;; 2) cmd_live ;; 3) cmd_echo ;; 4) need_node; build; configure ;;
    5) cmd_status ;; 6) cmd_logs ;; 7) stop_all ;; 8) cmd_verify ;; *) exit 0 ;;
  esac
}

case "${1:-menu}" in
  demo) cmd_demo ;; live) cmd_live ;; echo) cmd_echo ;;
  configure) need_node; build; configure ;; status) cmd_status ;; logs) cmd_logs ;;
  stop) stop_all ;; verify) cmd_verify ;; menu) menu ;;
  -h | --help | help) sed -n '2,13p' "$0" ;;
  *) die "unknown command $1 (try: ./overhear.sh help)" ;;
esac
