#!/bin/bash
# 設定 Threads 海巡機器人的 9 個密鑰。
# 用法：在 app/ 資料夾跑 `bash scripts/set-secrets.sh`，照提示一個一個貼上。
# 你貼的內容不會顯示在畫面上，也不會存成檔案，只會直接交給 Cloudflare。
# 還沒拿到的直接按 Enter 跳過，之後再跑一次這支腳本補上就好（已經設過的會問你要不要換）。
# 要先跑過 `npx wrangler login`，並且 Worker 已經部署過（2026-09-30 已部署）。

set -u
cd "$(dirname "$0")/.." || exit 1
export WRANGLER_SEND_METRICS=false
WR="./node_modules/.bin/wrangler"

if "$WR" whoami 2>&1 | grep -q "not authenticated"; then
  echo "還沒登入 Cloudflare。先跑：npx wrangler login"
  exit 1
fi

echo "讀取目前已經設過的密鑰…"
EXISTING="$("$WR" secret list 2>/dev/null || true)"
has_secret() { printf '%s' "$EXISTING" | grep -Eq "\"name\": *\"$1\""; }

FAILED=0
SKIPPED=()

put_secret() { # $1=名稱 $2=值
  if printf '%s' "$2" | "$WR" secret put "$1" >/dev/null 2>&1; then
    echo "  ✓ $1 已設定"
  else
    echo "  ✗ $1 設定失敗。可以單獨重跑：npx wrangler secret put $1"
    FAILED=1
  fi
}

# 問一個要貼上的密鑰。空白按 Enter＝先跳過
ask() { # $1=名稱 $2=說明 $3=檢查用的正規式（可空） $4=檢查失敗時的提示
  local name="$1" hint="$2" pattern="${3:-}" bad="${4:-}" v yn
  echo
  echo "【$name】$hint"
  if has_secret "$name"; then
    read -r -p "  已經設過了，要換掉嗎？(y/N) " yn
    [[ "$yn" =~ ^[Yy]$ ]] || { echo "  保留原本的"; return; }
  fi
  while true; do
    read -r -s -p "  貼上後按 Enter（畫面不會顯示；還沒有就直接按 Enter 跳過）：" v; echo
    v="$(printf '%s' "$v" | tr -d '[:space:]')"
    if [[ -z "$v" ]]; then
      echo "  先跳過"
      SKIPPED+=("$name")
      return
    fi
    if [[ -n "$pattern" && ! "$v" =~ $pattern ]]; then echo "  $bad"; continue; fi
    break
  done
  put_secret "$name" "$v"
}

echo
echo "=== Threads 海巡機器人：設定密鑰 ==="
echo "前三個現在就能設，設完就能登入線上後台。其他的等你開好帳號再補。"

# 1. 後台密碼：要打兩次確認
echo
echo "【DASH_PASSWORD】後台登入密碼，自己想一組，12 個字以上，存進密碼管理器"
yn=y
if has_secret DASH_PASSWORD; then read -r -p "  已經設過了，要換掉嗎？(y/N) " yn; fi
if [[ "$yn" =~ ^[Yy]$ ]]; then
  while true; do
    read -r -s -p "  輸入密碼（直接按 Enter 跳過）：" p1; echo
    if [[ -z "$p1" ]]; then echo "  先跳過"; SKIPPED+=("DASH_PASSWORD"); break; fi
    read -r -s -p "  再輸入一次：" p2; echo
    if [[ "$p1" != "$p2" ]]; then echo "  兩次不一樣，重來"; continue; fi
    if (( ${#p1} < 12 )); then echo "  太短，至少 12 個字"; continue; fi
    put_secret DASH_PASSWORD "$p1"
    break
  done
  unset p1 p2
else
  echo "  保留原本的"
fi

# 2、3. 兩組亂數：自動產生，不用你貼
echo
echo "【SESSION_SECRET】登入 cookie 的簽章用，自動產生"
if has_secret SESSION_SECRET; then
  echo "  已經有了，保留（換掉會讓已登入的裝置全部登出）"
else
  put_secret SESSION_SECRET "$(openssl rand -base64 32)"
fi

echo
echo "【TOKEN_ENC_KEY】加密 Threads 授權用，自動產生"
if has_secret TOKEN_ENC_KEY; then
  echo "  已經有了，保留（換掉就要重新連結 Threads）"
else
  KEY="$(openssl rand -base64 32)"
  put_secret TOKEN_ENC_KEY "$KEY"
  printf '%s' "$KEY" | pbcopy
  echo "  已複製到剪貼簿。現在就貼進密碼管理器存起來（弄丟只是要重新連結 Threads，不會壞資料）"
  unset KEY
fi

# 4. Anthropic
ask ANTHROPIC_API_KEY "console.anthropic.com → API Keys（sk-ant- 開頭）" '^sk-ant-' "要是 sk-ant- 開頭"

# 5–7. LINE
ask LINE_CHANNEL_SECRET "LINE Developers Console → 你的 channel → Basic settings → Channel secret" '^[0-9a-f]{32}$' "長度不對：Channel secret 是 32 個英數字（0-9、a-f）"
ask LINE_CHANNEL_ACCESS_TOKEN "同一個 channel → Messaging API 分頁 → Channel access token (long-lived)"
ask LINE_ADMIN_USER_ID "同一個 channel → Basic settings 最下面 → Your user ID（U 開頭）" '^U[0-9a-f]{32}$' "格式不對：要是 U 開頭、後面 32 個英數字"

# 8、9. Threads（Meta）
ask THREADS_APP_ID "Meta App Dashboard → Threads 的設定頁 → Threads App ID（不是 Facebook 的 App ID）" '^[0-9]+$' "Threads App ID 只有數字"
ask THREADS_APP_SECRET "同一頁 → Threads App Secret"

echo
if (( FAILED )); then
  echo "有項目失敗，照上面的提示單獨重跑那一項。"
fi
if (( ${#SKIPPED[@]} )); then
  echo "還沒設的：${SKIPPED[*]}"
  echo "拿到之後再跑一次：bash scripts/set-secrets.sh"
else
  (( FAILED )) || echo "9 個密鑰都設好了。"
fi
echo "回到 Claude 說一聲「密鑰設好了」，我會幫你檢查。"
(( FAILED )) && exit 1 || exit 0
