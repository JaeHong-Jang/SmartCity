# SmartCity 배포 — Azure VM (Ubuntu 24.04)

Azure for Students로 만든 작은 VM 한 대에 SmartCity 서버를 올리는 방법입니다.
초대 비밀번호를 아는 사람만 들어와 도시를 고치고 AI 비서를 쓸 수 있습니다.

```
브라우저 ──HTTPS/WSS──▶ Caddy (:443, 인증서 자동) ──▶ node 서버 (localhost:8780) ──▶ /var/lib/smartcity
```

| 파일 | 역할 |
|---|---|
| `setup.sh` | 새 VM에서 한 번 실행 (다시 실행해도 안전): Node 22·Caddy·swap·방화벽·서비스·백업 타이머 |
| `update.sh` | 코드 갱신: `git pull` → `npm ci` → `npm run build` → 재시작 (접속자가 있으면 멈춤) |
| `backup.sh` | 데이터 백업 (매일 타이머가 실행) |
| `smartcity.service` | 서버 systemd 유닛 |
| `smartcity-backup.service`, `.timer` | 매일 04:00(한국 시간) 백업 |

VM 안의 위치:

| 경로 | 내용 | 소유 |
|---|---|---|
| `/opt/smartcity` | 저장소(코드·빌드) | root (서버는 읽기만) |
| `/var/lib/smartcity` | 도시 데이터 (`<방>.json`, `<방>.log.jsonl`, `backups/`) | smartcity |
| `/etc/smartcity.env` | 환경 파일 (비밀번호·API 키) | root, 권한 600 |
| `/var/backups/smartcity` | 매일 백업 `YYYY-MM-DD.tar.gz` (14개 보관) | root |
| `/etc/caddy/Caddyfile` | HTTPS 프록시 설정 (`setup.sh`가 만듦) | root |

---

## 1. Azure 포털에서 VM 만들기

[portal.azure.com](https://portal.azure.com) → **가상 머신** → **만들기** → **Azure 가상 머신**.

**기본 사항**
- 구독: Azure for Students / 리소스 그룹: 새로 만들기 (예: `smartcity-rg`)
- 가상 머신 이름: 예) `smartcity`
- 지역: **(Asia Pacific) Korea Central**
- 가용성 옵션: 인프라 중복 필요 없음
- 이미지: **Ubuntu Server 24.04 LTS - x64 Gen2**
- 크기: **Standard_B2ats_v2** (vCPU 2개, 메모리 1 GiB) — '모든 크기 보기'에서 검색
- 인증 형식: **SSH 공개 키**, 사용자 이름: `azureuser`
  - SSH 공개 키 원본: '새 키 쌍 생성'을 고르면 만들기 직전에 `.pem` 개인 키를 내려받습니다. **이 파일은 다시 받을 수 없으니** 잘 보관하세요. 이미 키가 있으면 '기존 공개 키 사용'.
- 공용 인바운드 포트: '선택한 포트 허용' → **SSH (22), HTTP (80), HTTPS (443)**

**디스크**
- OS 디스크 크기: **64 GiB**. `P6`는 프리미엄 SSD 64 GiB의 등급 이름이고, 표준 SSD 64 GiB는 `E6`로 표시됩니다. 학생 무료 혜택에 들어가는 디스크 종류를 포털의 **무료 서비스** 화면에서 확인한 뒤 같은 종류(64 GiB)를 고르세요.

**네트워킹**
- 공용 IP: 새로 만들기(기본값) / NIC 네트워크 보안 그룹: 기본 / 공용 인바운드 포트: 22·80·443 (위에서 고른 값)

**관리**
- 자동 종료: 켜 두면 그 시각에 서버가 꺼집니다. 늘 접속할 수 있어야 하면 끄고, 크레딧을 아끼려면 켜 두세요(VM을 다시 켜면 서버도 자동으로 올라옵니다).

**검토 + 만들기** → **만들기**.

### 공용 IP에 DNS 이름 붙이기 (HTTPS에 필요)

VM 화면 → **개요** → 공용 IP 주소 링크 → **구성** → **DNS 이름 레이블**에 예) `mycity` 입력 → 저장.
주소는 `mycity.koreacentral.cloudapp.azure.com`이 됩니다. 아래에서 `<도메인>`은 이 주소입니다.

> 인바운드 규칙은 VM → **네트워킹** → **네트워크 설정**에서 볼 수 있습니다. 22·80·443만 열려 있어야 합니다(8780은 열지 마세요 — Caddy만 바깥과 통신합니다). SSH(22)의 '원본'을 내 IP로 좁히면 더 안전합니다.

## 2. 첫 설치

내 컴퓨터(Windows PowerShell 또는 WSL)에서 VM에 접속합니다.

```bash
# WSL: 키 권한을 좁혀야 ssh가 받아들입니다.
chmod 600 ~/smartcity_key.pem
ssh -i ~/smartcity_key.pem azureuser@<도메인>
```

VM 안에서:

```bash
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/JaeHong-Jang/SmartCity.git /opt/smartcity
sudo bash /opt/smartcity/deploy/setup.sh <도메인>
```

- 5~10분 걸립니다(패키지 설치, `npm ci`, 빌드). 메모리가 1 GiB라 swap 2 GB를 먼저 만듭니다.
- 저장소가 **비공개**면 clone이 실패합니다. 공개로 바꾸거나, GitHub 토큰/배포 키로 clone한 뒤 `setup.sh`를 실행하세요.
- 환경 파일에 초대 비밀번호가 비어 있으면 서버를 **시작하지 않고** 안내만 출력합니다(비밀번호 없는 공개 서버 방지). 다음 단계로 갑니다.
- 재부팅이나 수동 시작 때도 같습니다. 서비스는 매번 시작 전에 비밀번호를 확인하고(`ExecStartPre`), 서버 자신도 `SC_REQUIRE_INVITE=1`일 때 비밀번호가 비어 있으면 종료 코드 78로 멈춥니다. 비밀번호 없이는 절대 열리지 않습니다.
- 시작 전 확인에서 거부되면 systemd가 3초마다 다시 시도하다가 2분 안에 5번 실패하면 멈춥니다(`failed`). 서버 자신의 78 종료는 재시도하지 않습니다. 비밀번호를 채운 뒤 `sudo systemctl reset-failed smartcity`를 하고 시작하세요.

## 3. 환경 파일 채우기

```bash
sudo nano /etc/smartcity.env
```

```ini
PORT=8780
DATA_DIR=/var/lib/smartcity
SC_INVITE_CODE=여기에-초대-비밀번호
SC_REQUIRE_INVITE=1
ANTHROPIC_API_KEY=여기에-API-키
SC_AI_MODEL=
```

- `SC_INVITE_CODE`(필수): 추측하기 어려운 값으로(예: `openssl rand -base64 12`로 만든 값). 128자 이하, 따옴표 없이.
- `SC_REQUIRE_INVITE=1`: 비밀번호가 비어 있으면 서버가 시작을 거부합니다. 바꾸지 마세요.
- `ANTHROPIC_API_KEY`: 비우면 AI 비서가 꺼집니다. `SC_AI_MODEL`은 비우면 기본 모델.
- `PORT`를 바꾸면 `/etc/caddy/Caddyfile`의 포트도 같이 바꿔야 합니다 — 그대로 두세요.

저장(Ctrl+O, Enter, Ctrl+X) 후:

```bash
sudo systemctl reset-failed smartcity   # 비밀번호 없이 시작을 거부당한 적이 있으면 그 기록을 지움
sudo systemctl restart smartcity
systemctl status smartcity          # active (running), 로그에 'invite password required'
curl -s localhost:8780/health       # {"ok":true,"rooms":0,"clients":0}
```

브라우저로 `https://<도메인>`을 열면 **초대 비밀번호** 창이 뜹니다. 맞게 입력하면 들어가고, 그 브라우저는 다음부터 묻지 않습니다.
처음 접속에서 인증서 오류가 나면 1~2분 기다리세요(Caddy가 Let's Encrypt 인증서를 받는 중, `journalctl -u caddy -f`로 확인).

## 4. 내 컴퓨터의 `main` 도시 옮기기

1. **내 컴퓨터**: 개발 서버(`npm run dev`)를 Ctrl+C로 끕니다 — 끌 때 도시가 `main.json`에 저장되고 `main.log.jsonl`이 비워집니다.
2. **내 컴퓨터**(WSL, 프로젝트 폴더에서) 파일을 VM으로 보냅니다:
   ```bash
   scp -i ~/smartcity_key.pem apps/server/data/main.json apps/server/data/main.log.jsonl azureuser@<도메인>:/tmp/
   ```
3. **VM**: 서버를 멈추고, 있던 `main`은 옆으로 치운 뒤 넣고, 소유자를 바꾸고, 다시 켭니다:
   ```bash
   sudo systemctl stop smartcity
   D=/var/lib/smartcity
   sudo mkdir -p $D/replaced-$(date +%F)
   sudo mv $D/main.json $D/main.log.jsonl $D/replaced-$(date +%F)/   # 처음이라 없으면 나는 오류는 무시
   sudo install -o smartcity -g smartcity -m 640 /tmp/main.json /tmp/main.log.jsonl $D/
   sudo chown -R smartcity:smartcity $D
   sudo systemctl start smartcity
   journalctl -u smartcity -n 20 --no-pager
   ```
   VM에 있던 `main.log.jsonl`을 남겨 두면 안 됩니다 — 다른 도시의 편집 기록이 새 도시 위에 다시 적용됩니다. 그래서 둘 다 치웁니다.

다른 방(`?room=이름`)도 같은 방법으로 `<방>.json`, `<방>.log.jsonl`을 옮기면 됩니다.

## 5. 업데이트

```bash
sudo bash /opt/smartcity/deploy/update.sh
```

- 접속자가 있으면(`/health`의 `clients` > 0) 아무것도 바꾸지 않고 멈춥니다. 재시작하면 모두의 연결이 잠깐 끊기기 때문입니다(서버는 끄기 전에 도시를 저장하고, 앱은 다시 연결합니다). 그래도 진행하려면 `--force`.
- 서버가 실행 중인데 `/health`가 응답하지 않거나 형식이 이상해도 멈춥니다. 접속자 수를 모르면 0명으로 치지 않습니다. 서버가 꺼져 있거나 접속자 0명이 확인될 때만 그냥 진행합니다.
- 빌드 중에 누가 들어오면 재시작 직전에 다시 멈춥니다. 이때 코드는 이미 새것이니, 나중에 `sudo systemctl restart smartcity`만 하면 됩니다.
- `deploy/`의 서비스·타이머 파일이 바뀐 업데이트라면 `sudo bash /opt/smartcity/deploy/setup.sh <도메인>`을 한 번 더 실행하세요(실행 중인 서버는 다시 빌드·재시작하지 않습니다).

## 6. 로그 보기

```bash
journalctl -u smartcity -f              # 서버 로그 실시간
journalctl -u smartcity -n 100 --no-pager
journalctl -u smartcity --since today
journalctl -u caddy -f                  # HTTPS·인증서
systemctl status smartcity caddy
```

## 7. 백업과 복원

매일 04:00(한국 시간)에 `/var/lib/smartcity` 전체가 `/var/backups/smartcity/YYYY-MM-DD.tar.gz`로 묶이고 최근 14개가 남습니다. VM이 꺼져 있던 날은 다음 부팅 때 만듭니다.
서버를 멈추지 않습니다. 방마다 체크포인트(`<방>.json`)와 편집 로그(`<방>.log.jsonl`)를 서로 맞는 쌍으로 복사하고, 실제 서버의 불러오기 코드로 확인한 뒤 묶습니다(`apps/server/src/snapshot.ts`). 그래서 백업 중에 편집·저장이 일어나도 복원한 도시는 실제로 있었던 상태이고, 백업을 시작하기 전에 승인된 편집은 빠지지 않습니다.
서버 자체 백업(`/var/lib/smartcity/backups/<방>/`, 체크포인트마다)도 함께 복사됩니다. 그 파일들은 한 번 쓰이면 바뀌지 않지만, 백업 순간에 막 쓰이던 파일 하나는 불완전할 수 있습니다.

- **손상된 방**: 서버도 읽지 못해 거부하는 방(파일 내용이 깨진 방)은 원래 이름·경로에 **바이트 그대로** 들어가고, 데이터 디렉터리 맨 위의 `BACKUP-MANIFEST.json`에 방 이름·이유·sha256이 기록되며 `경고:`가 남습니다(`journalctl -u smartcity-backup`). 복원하면 서버는 지금처럼 그 방을 거부합니다. 빈 도시로 열리지 않고, 다음 백업도 같은 파일을 계속 보존합니다.
- **실패**: 디스크 읽기·쓰기 오류가 나거나, 편집이 너무 잦아 몇 번을 다시 시도해도 일관된 사본을 못 만든 방이 있으면 그날 백업은 **실패**합니다. 저장소 오류는 데이터 손상으로 취급하지 않습니다. 기존 아카이브는 그대로 두고, 바꾸거나 지우지 않습니다. `systemctl status smartcity-backup`에 `failed`로 보이고, 다음 날 다시 시도합니다(지금 다시: `sudo systemctl start smartcity-backup`).
- 아카이브 안의 권한은 디렉터리 750, 파일 640입니다(아카이브 자체는 600).

```bash
systemctl list-timers smartcity-backup.timer   # 다음 실행 시각
sudo systemctl start smartcity-backup          # 지금 바로 백업
ls -l /var/backups/smartcity
```

**하루 전체 되돌리기** (모든 방):

```bash
sudo systemctl stop smartcity
sudo mv /var/lib/smartcity /var/lib/smartcity.before-restore-$(date +%F-%H%M)
sudo tar -xzf /var/backups/smartcity/2026-10-27.tar.gz -C /var/lib   # → /var/lib/smartcity
# 소유자·권한을 원래대로 (데이터 디렉터리는 750 — 다른 사용자가 읽지 못하게)
sudo chown -R smartcity:smartcity /var/lib/smartcity
sudo chmod 750 /var/lib/smartcity
sudo find /var/lib/smartcity -type d -exec chmod 750 {} +
sudo find /var/lib/smartcity -type f -exec chmod 640 {} +
sudo cat /var/lib/smartcity/BACKUP-MANIFEST.json   # "damaged": 백업 당시 이미 서버가 거부하던 방과 이유
sudo systemctl start smartcity
```

손상된 방이 있어도 따로 할 일은 없습니다. 파일이 원래 자리에 그대로 있어서 복원된 서버도 백업 전처럼 그 방을 거부합니다("도시 파일을 읽을 수 없습니다 — 관리자 확인 필요"). 어떤 방이 왜 거부되는지는 `BACKUP-MANIFEST.json`의 `damaged`에 있습니다. 고칠 때는 서버를 끄고 그 방의 파일을 직접 고칩니다.

**방 하나만 되돌리기** (서버 자체 백업에서): 서버를 끄고 → `/var/lib/smartcity/backups/<방>/<시각>.json`을 `/var/lib/smartcity/<방>.json`으로 **복사**하고 → 같은 방의 `<방>.log.jsonl`을 지우고 → `chown smartcity:smartcity`·`chmod 640`으로 소유자·권한을 맞춘 뒤 → 서버를 켭니다(저장소 루트 `README.md`의 '백업과 복구').

백업은 같은 VM 디스크에 있습니다. 디스크를 잃는 경우까지 대비하려면 가끔 `scp`로 내 컴퓨터에 받아 두세요:
`scp -i ~/smartcity_key.pem azureuser@<도메인>:/var/backups/smartcity/2026-10-27.tar.gz .` (먼저 VM에서 `sudo cp`로 `/tmp`에 복사하고 `sudo chown azureuser`).

## 8. 초대 비밀번호 — 알아 둘 것

- 비밀번호가 없거나 틀리면 서버는 방에 넣지 않고 연결을 닫습니다(도시·참여자 정보가 나가지 않음). 비교는 상수 시간이고, 같은 IP에서 10분에 10번 틀리면 그 IP는 10분 동안 맞는 비밀번호도 거절됩니다.
- 웹 페이지(정적 파일)와 `/health`(접속자 수만)는 비밀번호 없이 열립니다. 도시 데이터·편집·AI는 모두 WebSocket이라 비밀번호가 있어야 합니다.
- 브라우저는 비밀번호를 `localStorage`(`smartcity:invite`)에 **평문으로** 저장합니다. 공용 컴퓨터에서는 사용 후 사이트 데이터를 지우세요.
- 비밀번호를 바꾸려면 `/etc/smartcity.env`를 고치고 `sudo systemctl restart smartcity`. 기존 사용자는 "초대 비밀번호가 틀렸습니다" 창에서 새 비밀번호를 넣으면 됩니다.
- 비밀번호는 메신저 단체방 등 정해진 사람에게만 알려 주세요. 비밀번호가 새면 바꾸는 것 말고는 막을 방법이 없습니다(사용자 계정 개념이 없음).

## 문제 해결

| 증상 | 확인 |
|---|---|
| 브라우저가 접속 못 함 | VM 실행 중인지, NSG 80/443, `sudo ufw status`, `systemctl status caddy` |
| 인증서 오류 | DNS 이름이 맞는지(`<도메인>`과 Caddyfile), 80 포트가 열려 있는지, `journalctl -u caddy` |
| "서버에 연결하는 중…"만 계속 | `systemctl status smartcity`, `journalctl -u smartcity -n 50` |
| 서비스가 `failed`, 로그에 `SC_INVITE_CODE is empty` | `/etc/smartcity.env`에 비밀번호를 채우고 `sudo systemctl reset-failed smartcity && sudo systemctl start smartcity` |
| 빌드가 메모리 부족으로 죽음 | `swapon --show`에 swap이 있는지, 다시 `sudo bash /opt/smartcity/deploy/update.sh` |
| AI가 꺼져 있음 | `/etc/smartcity.env`의 `ANTHROPIC_API_KEY` 후 재시작 |
