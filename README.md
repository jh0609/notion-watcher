# Notion Watcher

공개 Notion 페이지를 크론으로 한 번씩 확인하고, 실제 화면에 렌더링된 본문이 바뀌면 ntfy로 휴대폰 푸시 알림을 보내는 Node.js 스크립트입니다. Node.js 내부에서 `setInterval`을 사용하지 않고, 실행될 때 한 번 확인한 뒤 종료합니다.

## 동작 구조

1. `.env`에서 공개 Notion 페이지 URL과 ntfy 설정을 읽습니다.
2. Playwright Chromium headless 브라우저로 페이지를 렌더링합니다.
3. 화면에 표시된 본문 텍스트를 추출하고 공백, 줄바꿈, 공통 UI 문구를 정규화합니다.
4. 페이지의 `업데이트 Update - ...` 문구를 추출합니다.
5. 이전 상태 파일의 업데이트 문구와 비교합니다. 업데이트 문구를 찾지 못하면 정규화된 본문 SHA-256 해시 비교로 fallback합니다.
6. 최초 실행이면 알림 없이 기준 상태만 저장합니다.
7. 변경이 없으면 `checkedAt`만 갱신합니다.
8. 변경이 있으면 ntfy 알림 전송에 성공한 뒤에만 새 상태를 저장합니다. 알림에는 상품 표 기준 변경점도 함께 표시합니다.

## 설치

Node.js 18 이상이 필요합니다.

```bash
node -v
npm install
npx playwright install chromium
cp .env.example .env
npm run check
npm start
```

리눅스 서버에서 Playwright 시스템 의존성이 부족하면 다음 명령이 필요할 수 있습니다.

```bash
npx playwright install --with-deps chromium
```

운영 서버 권한, 배포판, 패키지 정책에 따라 필요한 명령은 달라질 수 있습니다.

## 환경변수

`.env.example`을 `.env`로 복사한 뒤 값을 설정합니다.

```env
NOTION_PAGE_URL=https://www.notion.so/...
NTFY_SERVER_URL=https://ntfy.sh
NTFY_TOPIC=notion-watch-3d9f2c8a7b1e4f6d9a2c
NTFY_TOKEN=tk_xxxxxxxxxxxxxxxxx
STATE_FILE=./notion-watcher-state.json
OPERATION_STATE_FILE=./notion-watcher-operation-state.json
LOCK_FILE=./notion-watcher.lock
MAX_TEXT_CHANGE_RATIO=0.7
PAGE_LOAD_TIMEOUT_MS=60000
PAGE_FETCH_MAX_ATTEMPTS=3
PAGE_FETCH_RETRY_DELAYS_MS=10000,30000
DOMCONTENTLOADED_TIMEOUT_MS=15000
RENDER_WAIT_MS=8000
COLLECTION_WAIT_MS=10000
EXTRA_WAIT_MS=1500
OPERATOR_NTFY_TOPIC=
```

`NOTION_PAGE_URL`, `NTFY_SERVER_URL`, `NTFY_TOPIC`, `NTFY_TOKEN`은 필수입니다. `STATE_FILE` 기본값은 `./notion-watcher-state.json`, `OPERATION_STATE_FILE` 기본값은 `./notion-watcher-operation-state.json`, `LOCK_FILE` 기본값은 `./notion-watcher.lock`입니다.

`MAX_TEXT_CHANGE_RATIO`는 이전 본문과 현재 본문의 길이 차이가 너무 클 때 추출 실패로 보고 상태를 갱신하지 않는 보호장치입니다. 기본값 `0.7`은 길이 변화가 70%를 넘으면 오류로 처리합니다.

느린 서버에서는 다음 대기 시간을 `.env`에서 늘릴 수 있습니다. 값은 모두 밀리초입니다.

- `PAGE_LOAD_TIMEOUT_MS`: 각 페이지 조회 시도의 첫 응답 대기 시간, 기본 `60000`
- `PAGE_FETCH_MAX_ATTEMPTS`: 같은 실행 안에서 페이지 조회를 시도할 최대 횟수, 기본 `3`
- `PAGE_FETCH_RETRY_DELAYS_MS`: 재시도 전 대기 시간 목록, 기본 `10000,30000`
- `DOMCONTENTLOADED_TIMEOUT_MS`: `domcontentloaded` 이벤트 추가 대기 시간, 기본 `15000`
- `RENDER_WAIT_MS`: Notion 본문 DOM 대기 시간, 기본 `8000`
- `COLLECTION_WAIT_MS`: 상품 카드 `.notion-collection-item` 대기 시간, 기본 `10000`
- `EXTRA_WAIT_MS`: 추출 직전 마지막 고정 대기 시간, 기본 `1500`

상품 표가 늦게 렌더링되는 서버라면 예를 들어 `COLLECTION_WAIT_MS=30000`, `EXTRA_WAIT_MS=3000`처럼 늘릴 수 있습니다.

공개 Notion 페이지가 아니거나 로그인이 필요한 페이지라면 정상 본문으로 처리되지 않을 수 있습니다.

페이지 조회 실패는 같은 실행 안에서 새 Playwright browser/context/page로 최대 3회 재시도합니다. 모든 시도가 실패하면 일반 상태 파일은 변경하지 않고 공개 공지 토픽에도 알림을 보내지 않습니다. 대신 `OPERATION_STATE_FILE`에 연속 페이지 조회 실패 횟수를 저장합니다. `OPERATOR_NTFY_TOPIC`을 설정하면 두 번의 cron 실행이 연속 실패했을 때 운영자 전용 토픽으로 장애 알림을 보내고, 이후 정상 조회에 성공하면 복구 알림을 한 번 보냅니다.

## ntfy 설정

휴대폰에 ntfy 앱을 설치하고 `.env`의 `NTFY_TOPIC`과 같은 토픽을 구독합니다. 공개 ntfy 서버의 토픽은 URL을 아는 사람이 접근할 수 있으므로 `notion`, `my-page`, 이름, 이메일 같은 단순하거나 개인정보가 포함된 토픽명을 사용하지 마세요. 충분히 긴 무작위 문자열을 붙인 토픽명을 사용하세요.

알림 발송은 익명 발송이 아니라 `NTFY_TOKEN` Bearer 인증을 사용합니다. 토큰 값은 `.env`에만 저장하고 로그, README, `.env.example`에는 실제 값을 넣지 마세요.

무작위 토픽명 생성 예시:

```bash
node -e "console.log('notion-watch-' + require('crypto').randomBytes(16).toString('hex'))"
```

watcher 실행 전에 ntfy 알림을 먼저 테스트할 수 있습니다.

```bash
curl \
  -H "Title: Notion 알림 테스트" \
  -H "Authorization: Bearer 본인의-ntfy-액세스-토큰" \
  -H "Priority: high" \
  -H "Tags: memo,eyes" \
  -d "ntfy 푸시 알림 테스트입니다." \
  "https://ntfy.sh/본인의-긴-무작위-토픽명"
```

휴대폰 ntfy 앱에서 같은 토픽을 구독한 상태여야 알림이 도착합니다.

## 실행과 테스트

수동 실행:

```bash
npm start
```

최초 실행 시에는 알림을 보내지 않습니다. 현재 페이지 본문을 기준 상태로 저장해야 다음 실행부터 변경 여부를 비교할 수 있기 때문입니다.

실제 변경 감지를 테스트하려면 공개 Notion 페이지의 본문을 수정한 뒤 다음 실행에서 ntfy 알림이 오는지 확인합니다. 단, Notion 반영 지연이 있을 수 있으므로 정각 또는 30분 업데이트 후 2분 뒤 확인하는 운용을 권장합니다.

상태 파일을 초기화하려면 스크립트가 실행 중이 아닐 때 `notion-watcher-state.json`을 삭제한 뒤 다시 실행합니다. 그러면 다음 실행은 다시 최초 실행으로 처리되어 알림 없이 기준 상태만 저장합니다.

## cron 등록

Notion 페이지가 매시 정각과 매시 30분에 업데이트되고 실제 공개 페이지 반영에 시간이 걸릴 수 있으므로 2분 뒤인 `00:02`, `00:32`, `01:02`, `01:32` ... 시각에 확인합니다.

```cron
2,32 * * * * cd /opt/notion-watcher && /usr/bin/node notion-watcher-once.js >> /var/log/notion-watcher.log 2>&1
```

등록:

```bash
crontab -e
```

등록 확인:

```bash
crontab -l
```

로그 확인:

```bash
tail -f /var/log/notion-watcher.log
```

서버 재부팅 후 cron 데몬이 실행 중인지 확인:

```bash
systemctl status cron
```

배포판에 따라 서비스 이름이 `crond`일 수 있습니다.

## cron 단발 실행을 쓰는 이유

이 watcher는 정해진 시각에 한 번 확인하고 종료되도록 설계되어 있습니다. PM2 같은 상시 프로세스에서 내부 타이머를 돌리면 프로세스 재시작, 중복 실행, 서버 시간 변경을 별도로 관리해야 합니다. cron 단발 실행은 실행 시각이 명확하고 실패 로그를 남기기 쉬우며, 작업이 끝나면 프로세스가 남지 않습니다.

## 잠금 파일

`LOCK_FILE`은 cron 실행이 겹쳐 두 프로세스가 동시에 상태 파일을 읽고 쓰는 일을 막습니다. 실행 시작 시 exclusive create 방식으로 잠금 파일을 만들고, 종료 시 제거합니다.

프로세스가 비정상 종료되어 잠금 파일이 남을 수 있으므로 `startedAt`이 10분 이상 지난 잠금은 stale lock으로 보고 제거한 뒤 실행을 계속합니다. JSON으로 파싱할 수 없는 잠금 파일도 오래되었거나 잘못된 잠금으로 판단되면 제거할 수 있게 처리합니다.

## 오류 점검

- `NOTION_PAGE_URL`, `NTFY_TOPIC`이 `.env`에 있는지 확인합니다.
- Notion 페이지가 공개 상태인지, 로그인 없이 브라우저에서 열리는지 확인합니다.
- Playwright Chromium이 설치되어 있는지 확인합니다.
- 리눅스 서버라면 Playwright 시스템 의존성이 설치되어 있는지 확인합니다.
- ntfy 앱에서 같은 긴 무작위 토픽을 구독했는지 확인합니다.
- ntfy 서버 URL과 네트워크 연결을 확인합니다.
- 상태 파일과 잠금 파일 경로에 쓰기 권한이 있는지 확인합니다.
- 본문이 너무 짧다는 오류가 나면 페이지가 로딩, 로그인, 오류 화면으로 추출된 것은 아닌지 확인합니다.
