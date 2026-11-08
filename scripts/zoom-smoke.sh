#!/usr/bin/env bash
# Zoom smoke test helper. Run it before going live (see README, step 1).
# Reads the ZOOM_* settings from the environment or from ./.env.
#
#   scripts/zoom-smoke.sh create            create a meeting with the bot's settings
#   scripts/zoom-smoke.sh get <meetingId>   show the meeting's status and current UUID
#   scripts/zoom-smoke.sh recordings <meetingId|uuid>
#                                           list recording files (look for TRANSCRIPT)
#   scripts/zoom-smoke.sh hostkey           set a random host key (tests the scope)
#   scripts/zoom-smoke.sh end <meetingId>   end a running meeting
#   scripts/zoom-smoke.sh delete-recordings <meetingId|uuid>
#                                           move the recordings to Zoom's trash
set -euo pipefail

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
: "${ZOOM_ACCOUNT_ID:?set ZOOM_ACCOUNT_ID}" "${ZOOM_CLIENT_ID:?}" "${ZOOM_CLIENT_SECRET:?}" "${ZOOM_HOST_USER:?}"
API="${ZOOM_API_BASE:-https://api.zoom.us/v2}"

token() {
  curl -fsS -X POST -u "$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET" \
    "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).access_token))'
}

enc() { node -e 'const u=process.argv[1];const o=encodeURIComponent(u);console.log(u.startsWith("/")||u.includes("//")?encodeURIComponent(o):o)' "$1"; }

call() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -X "$method" -H "Authorization: Bearer $(token)" -w '\nHTTP %{http_code}\n')
  [[ -n $body ]] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$API$path"
}

host=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$ZOOM_HOST_USER")

case "${1:-}" in
  create)
    pass=$(node -e 'const c="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";let s="";for(let i=0;i<8;i++)s+=c[require("crypto").randomInt(c.length)];console.log(s)')
    call POST "/users/$host/meetings" "{\"topic\":\"Smoke test\",\"type\":1,\"password\":\"$pass\",\"settings\":{\"join_before_host\":true,\"jbh_time\":0,\"waiting_room\":false,\"auto_recording\":\"cloud\",\"mute_upon_entry\":true,\"meeting_authentication\":false}}"
    ;;
  get) call GET "/meetings/$2" ;;
  recordings) call GET "/meetings/$(enc "$2")/recordings" ;;
  hostkey)
    key=$(node -e 'console.log(String(require("crypto").randomInt(0,1e6)).padStart(6,"0"))')
    call PATCH "/users/$host" "{\"host_key\":\"$key\"}"
    echo "If that says HTTP 204, the new host key is $key"
    ;;
  end) call PUT "/meetings/$2/status" '{"action":"end"}' ;;
  delete-recordings) call DELETE "/meetings/$(enc "$2")/recordings?action=trash" ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
