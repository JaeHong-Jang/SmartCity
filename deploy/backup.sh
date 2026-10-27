#!/usr/bin/env bash
# SmartCity 데이터 백업: DATA_DIR → BACKUP_DIR/YYYY-MM-DD.tar.gz, 최근 KEEP개 보관.
# smartcity-backup.timer가 매일 root로 실행한다. 서버는 멈추지 않는다.
# 실행 중인 데이터 디렉터리를 그대로 tar로 묶으면 체크포인트와 로그가 서로 다른 시점의 것으로 짝지어져
# 승인된 편집이 복원에서 빠질 수 있다. 그래서 방마다 일관된 체크포인트+로그 쌍을 스테이징 폴더에 복사하고
# (apps/server/src/snapshot.ts, 실제 loadRoom으로 확인) 그 사본을 묶는다.
# 서버 자체 백업(DATA_DIR/backups)도 함께 복사된다. 서버도 읽지 못하는 손상된 방은 원래 경로에 바이트
# 그대로 두고 BACKUP-MANIFEST.json에 기록한다(경고) — 복원한 서버도 지금처럼 그 방을 거부한다.
# 저장소 오류가 나거나, 계속 바뀌어 일관된 사본을 못 만든 방이 있으면 백업 전체가 실패한다:
# 기존 아카이브는 그대로, 교체·정리 없음, 종료 코드 1 (systemctl에서 failed로 보임).
#   sudo bash /opt/smartcity/deploy/backup.sh
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/smartcity}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/smartcity}"
KEEP="${KEEP:-14}"
APP_DIR="${APP_DIR:-/opt/smartcity}"

main() {
  umask 077
  [[ -d $DATA_DIR ]] || { echo "데이터 디렉터리가 없습니다: $DATA_DIR" >&2; exit 1; }
  [[ $KEEP =~ ^[1-9][0-9]*$ ]] || { echo "KEEP는 1 이상의 정수: $KEEP" >&2; exit 1; }
  install -d -m 700 "$BACKUP_DIR"

  local day out tmp staging name
  day=$(TZ=Asia/Seoul date +%F)
  out="$BACKUP_DIR/$day.tar.gz"
  name=$(basename "$DATA_DIR")
  # Staging on the backup disk (not a tmpfs /tmp), removed in any case.
  staging=$(mktemp -d "$BACKUP_DIR/.staging.XXXXXX")
  tmp=$(mktemp "$BACKUP_DIR/.$day.XXXXXX")
  trap 'rm -rf "$staging" "$tmp"' EXIT
  if ! (cd "$APP_DIR" && node --import tsx apps/server/src/snapshotMain.ts "$DATA_DIR" "$staging/$name"); then
    echo "백업 실패: 일관된 사본을 만들지 못했습니다. 기존 백업은 그대로 둡니다 (교체·정리 안 함)." >&2
    exit 1
  fi
  tar -czf "$tmp" -C "$staging" "$name"
  chmod 600 "$tmp"
  mv -f "$tmp" "$out"
  rm -rf "$staging"
  trap - EXIT
  echo "백업: $out ($(du -h "$out" | cut -f1))"

  # Keep the newest KEEP (names sort by date).
  find "$BACKUP_DIR" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].tar.gz' -printf '%f\n' |
    sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
      rm -f -- "${BACKUP_DIR:?}/$old"
      echo "삭제: $old"
    done
}

main "$@"
exit
