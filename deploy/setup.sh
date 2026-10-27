#!/usr/bin/env bash
# SmartCity 서버 첫 설치 — 새 Ubuntu 24.04 VM에서 root로 한 번 실행한다 (다시 실행해도 안전).
#   sudo bash deploy/setup.sh <도메인>
#   예) sudo bash deploy/setup.sh mycity.koreacentral.cloudapp.azure.com
#
# 하는 일: 패키지·Node 22·Caddy 설치, 사용자 smartcity, 저장소 /opt/smartcity, npm ci·빌드,
# 데이터 /var/lib/smartcity, 환경 파일 /etc/smartcity.env(템플릿만), systemd 서비스·백업 타이머,
# swap(없을 때만), Caddy 자동 HTTPS, ufw(22/80/443).
# 코드(/opt/smartcity)는 root 소유·서비스는 읽기만 한다: 서버가 뚫려도 코드·스크립트를 바꿀 수 없다.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/JaeHong-Jang/SmartCity.git}"
APP_DIR=/opt/smartcity
DATA_DIR=/var/lib/smartcity
ENV_FILE=/etc/smartcity.env
APP_USER=smartcity
APP_PORT=8780
NODE_MAJOR=22
SWAP_SIZE=2G

die() {
  echo "오류: $*" >&2
  exit 1
}
step() { echo; echo "==> $*"; }

main() {
  [[ $EUID -eq 0 ]] || die "root로 실행하세요: sudo bash $0 <도메인>"
  local domain="${1:-}"
  [[ -n $domain ]] || die "도메인을 주세요. 예) sudo bash $0 mycity.koreacentral.cloudapp.azure.com"
  [[ $domain =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && $domain == *.* ]] || die "도메인 형식이 이상합니다: $domain"
  # shellcheck source=/dev/null
  . /etc/os-release
  [[ ${ID:-} == ubuntu ]] || echo "경고: Ubuntu 24.04용 스크립트입니다 (현재: ${PRETTY_NAME:-알 수 없음})" >&2

  export DEBIAN_FRONTEND=noninteractive

  step "기본 패키지"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg git ufw debian-keyring debian-archive-keyring apt-transport-https
  install -d -m 755 /etc/apt/keyrings

  step "Node.js ${NODE_MAJOR} (NodeSource 공식 apt 저장소, node_${NODE_MAJOR}.x 채널 고정)"
  if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  fi
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" >/etc/apt/sources.list.d/nodesource.list

  step "Caddy (공식 apt 저장소 dl.cloudsmith.io/public/caddy/stable)"
  if [[ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  fi
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list

  apt-get update -y
  apt-get install -y nodejs caddy
  [[ $(node -v) == v${NODE_MAJOR}.* ]] || die "Node ${NODE_MAJOR}이 아닙니다: $(node -v)"
  echo "node $(node -v), npm $(npm -v), $(caddy version | head -n1)"

  step "swap ${SWAP_SIZE} (메모리 1 GiB 대비, 이미 있으면 건너뜀)"
  if [[ -z $(swapon --show --noheadings) ]]; then
    if [[ ! -f /swapfile ]]; then
      fallocate -l "$SWAP_SIZE" /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
    fi
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi
  swapon --show

  step "사용자 ${APP_USER}, 데이터 ${DATA_DIR}"
  id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"

  step "저장소 ${APP_DIR}"
  if [[ -d $APP_DIR/.git ]]; then
    echo "이미 있음 — 그대로 둠 (코드 갱신은 deploy/update.sh)"
  elif [[ -e $APP_DIR && -n $(ls -A "$APP_DIR") ]]; then
    die "$APP_DIR 가 비어 있지 않은데 git 저장소가 아닙니다"
  else
    git clone "$REPO_URL" "$APP_DIR"
  fi
  chown -R root:root "$APP_DIR"

  # A re-run while the server runs only refreshes the system setup: replacing node_modules under a live
  # server, or restarting it with people connected, is update.sh's job (it checks for them first).
  local running=0
  systemctl is-active --quiet smartcity 2>/dev/null && running=1

  step "npm ci, npm run build"
  if ((running)); then
    echo "서버가 실행 중 — 건너뜀 (코드 갱신·빌드는 sudo bash ${APP_DIR}/deploy/update.sh)"
  else
    (cd "$APP_DIR" && npm ci && npm run build)
  fi
  [[ -f $APP_DIR/apps/web/dist/index.html ]] || die "웹 빌드 결과(apps/web/dist/index.html)가 없습니다"

  step "환경 파일 ${ENV_FILE} (없을 때만 템플릿 생성 — 값은 직접 채움)"
  if [[ ! -f $ENV_FILE ]]; then
    cat >"$ENV_FILE" <<EOF
# SmartCity 서버 환경 (systemd EnvironmentFile). 고친 뒤: sudo systemctl restart smartcity
# 따옴표 없이 '이름=값'만 쓴다.
PORT=${APP_PORT}
DATA_DIR=${DATA_DIR}
# 초대 비밀번호 (필수) — 비어 있으면 서버가 시작을 거부한다(재부팅 포함). 추측하기 어려운 값으로.
SC_INVITE_CODE=
# 1 = 위 비밀번호가 비어 있으면 서버가 시작하지 않음. 공개 서버에서는 바꾸지 말 것.
SC_REQUIRE_INVITE=1
# Claude API 키 — 비워 두면 AI 비서가 꺼진다.
ANTHROPIC_API_KEY=
# AI 모델 이름 — 비워 두면 기본값.
SC_AI_MODEL=
EOF
  fi
  chown root:root "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  step "systemd: smartcity.service, 매일 백업 타이머"
  install -m 644 "$APP_DIR/deploy/smartcity.service" /etc/systemd/system/smartcity.service
  install -m 644 "$APP_DIR/deploy/smartcity-backup.service" /etc/systemd/system/smartcity-backup.service
  install -m 644 "$APP_DIR/deploy/smartcity-backup.timer" /etc/systemd/system/smartcity-backup.timer
  systemctl daemon-reload
  systemctl enable smartcity.service
  systemctl enable --now smartcity-backup.timer

  step "Caddy: https://${domain} → localhost:${APP_PORT} (WebSocket 포함, 인증서 자동)"
  cat >/etc/caddy/Caddyfile <<EOF
# deploy/setup.sh가 만든 파일 — 다시 실행하면 덮어쓴다.
${domain} {
	encode zstd gzip
	reverse_proxy localhost:${APP_PORT}
}
EOF
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl enable caddy
  systemctl reload-or-restart caddy

  step "방화벽 ufw: 22, 80, 443만 (Azure NSG와 별개)"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  ufw status verbose

  step "서버 시작"
  if ((running)); then
    echo "이미 실행 중 — 재시작하지 않음 (바뀐 설정 반영: 접속자가 없을 때 sudo systemctl restart smartcity)"
  elif grep -Eq '^SC_INVITE_CODE=[^[:space:]]' "$ENV_FILE"; then
    systemctl restart smartcity
    sleep 3
    systemctl --no-pager --lines=5 status smartcity || true
  else
    echo "!! SC_INVITE_CODE가 비어 있어 서버를 아직 시작하지 않았습니다 (재부팅해도 비밀번호 없이는 시작을 거부합니다)."
    echo "   sudo nano ${ENV_FILE}   # SC_INVITE_CODE(필수)·ANTHROPIC_API_KEY 채우기"
    echo "   sudo systemctl start smartcity"
  fi

  echo
  echo "완료. 주소: https://${domain}   로그: journalctl -u smartcity -f"
}

main "$@"
exit
