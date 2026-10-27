#!/usr/bin/env bash
# SmartCity 업데이트: git pull → npm ci → npm run build → 서버 재시작.
#   sudo bash /opt/smartcity/deploy/update.sh           # 접속자가 있으면 멈춤
#   sudo bash /opt/smartcity/deploy/update.sh --force   # 접속자가 있어도 진행
# 재시작하면 접속자들의 연결이 잠시 끊긴다(서버는 종료 전 도시를 저장하고, 앱은 다시 연결한다).
# 그래도 편집 중인 사람이 있을 때는 피한다 — 그래서 /health의 접속자 수를 먼저 확인한다.
set -euo pipefail

APP_DIR=/opt/smartcity
ENV_FILE=/etc/smartcity.env

die() {
  echo "오류: $*" >&2
  exit 1
}

health_url() {
  local port
  port=$(sed -n 's/^PORT=\([0-9][0-9]*\).*/\1/p' "$ENV_FILE" 2>/dev/null | tail -n1)
  echo "http://127.0.0.1:${port:-8780}/health"
}

# Connected users per /health; prints nothing (and fails) when the query fails or the answer is not
# {"ok":true,...,"clients":<n>,...}.
clients() {
  local body
  body=$(curl -fsS --max-time 5 "$(health_url)" 2>/dev/null) || return 1
  [[ $body =~ ^\{\"ok\":true,.*\"clients\":([0-9]+)[,}] ]] || return 1
  echo "${BASH_REMATCH[1]}"
}

# Fails closed (Sol deploy review #3): goes on only when the service is stopped or /health says 0 users.
# Someone connected, or a running server that cannot be asked, stops the update (exit 2) unless --force.
check_clients() {
  local n
  if ! systemctl is-active --quiet smartcity; then
    echo "서버가 꺼져 있음 — 접속자 없음"
    return 0
  fi
  if ! n=$(clients); then
    if ((force)); then
      echo "경고: 서버가 실행 중인데 접속자 수를 확인하지 못했습니다 — --force로 계속합니다"
      return 0
    fi
    echo "!! 서버가 실행 중인데 접속자 수를 확인하지 못했습니다 ($(health_url) 응답 없음 또는 형식 오류)." >&2
    echo "   접속자가 있을 수 있어 멈춥니다. 확인 후 그래도 진행하려면: sudo bash $0 --force" >&2
    exit 2
  fi
  if ((n > 0)); then
    if ((force)); then
      echo "경고: 접속자 ${n}명 — --force로 계속합니다"
    else
      echo "!! 지금 접속자 ${n}명이 있습니다. 재시작하면 모두의 연결이 끊깁니다." >&2
      echo "   나중에 다시 실행하거나, 그래도 진행하려면: sudo bash $0 --force" >&2
      exit 2
    fi
  fi
}

main() {
  force=0
  for a in "$@"; do
    case $a in
      --force) force=1 ;;
      *) die "모르는 인자: $a (사용: sudo bash $0 [--force])" ;;
    esac
  done
  [[ $EUID -eq 0 ]] || die "root로 실행하세요: sudo bash $0"
  [[ -d $APP_DIR/.git ]] || die "$APP_DIR 에 저장소가 없습니다 — 먼저 deploy/setup.sh"

  check_clients
  cd "$APP_DIR"
  echo "==> git pull"
  git pull --ff-only
  echo "==> npm ci"
  npm ci
  echo "==> npm run build"
  npm run build

  # Someone may have joined during the build.
  check_clients
  echo "==> systemctl restart smartcity"
  systemctl restart smartcity
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "$(health_url)" >/dev/null 2>&1; then
      echo "완료: $(curl -fsS --max-time 2 "$(health_url)")"
      return
    fi
    sleep 1
  done
  die "서버가 30초 안에 응답하지 않습니다 — journalctl -u smartcity -n 50 로 확인"
}

# The whole script is read before it runs, so `git pull` may replace this file safely. (Sourced, as by
# the tests, it only defines the functions.)
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
  exit
fi
