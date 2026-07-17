# Notion Watcher

공개 Notion 메인 페이지에서 상품 링크를 수집하고 각 상세 페이지의 재고를 확인해, 상품 단위 변경을 ntfy로 알리는 Node.js 스크립트입니다.

## 동작 구조

1. `.env`에서 공개 Notion 페이지 URL과 ntfy 설정을 읽습니다.
2. Playwright Chromium headless 브라우저로 페이지를 렌더링합니다.
3. 메인 페이지의 상품 상세 URL을 수집하고 중복을 제거합니다.
4. 최대 동시성 2로 각 상세 페이지를 별도 context/page에서 조회합니다. 실패한 상세 페이지만 재시도합니다.
5. 상품명, 가격, 전체 판매 상태, 캐릭터별 재고를 정규화·정렬한 JSON의 SHA-256을 비교합니다.
6. 최초 실행이면 알림 없이 기준 상태만 저장합니다.
7. 변경이 없으면 `checkedAt`만 갱신합니다.
8. 변경이 있으면 상품별 diff를 알리고 전체 JSON 스냅샷과 diff 파일을 저장합니다. 상세 페이지가 하나라도 최종 실패하면 전체 상태를 저장하지 않습니다.

URL 후보는 메인 페이지와 같은 호스트 또는 `notion.so`/`notion.site` 내부 페이지만 허용합니다. X, Twitter, Instagram, YouTube, Facebook과 기타 외부 호스트, `mailto:`, `tel:`, `javascript:`, 해시 링크 및 메인 페이지 자체는 제외합니다. 각 후보의 링크 문구, 호스트, 판정과 제외 사유는 `DEBUG product-url-candidate` JSON 로그로 출력됩니다. 갤러리 카드에 `href`가 없으면 `role=link`, `data-page-id`, `data-block-id` 카드 구조와 클릭 후 이동 URL을 확인합니다.

카드 후보는 갤러리/데이터베이스 구조, 가격·판매 상태 문구, 클릭 가능한 스타일이나 역할, Notion ID 속성, 이미지와 텍스트 조합을 점수화해 선정합니다. 운영 모드는 카드 내부 `a[href]`의 32자리 page UUID를 먼저 사용하고, 없으면 카드의 `data-block-id`를 사용합니다. 두 방식으로 URL을 얻지 못한 카드만 클릭 fallback으로 조사합니다. 운영 모드에서는 modal HTML, 스크린샷, 클릭 진단 결과 파일을 저장하지 않습니다.

수동 `debug:cards` 모드는 각 후보를 실제로 클릭한 뒤 현재 URL과 history 변경, popup, peek/modal, modal 내부 링크를 조사합니다. 후보별 실패는 다음 후보 조사를 막지 않으며 `card-click-results.json`에 남습니다.

상품이 2개 미만이거나 외부 서비스 제목이 감지되거나 상세 페이지 하나라도 실패하면 최초 실행을 포함해 카탈로그 상태를 저장하지 않습니다.

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
SNAPSHOT_DIR=./snapshots
DETAIL_CONCURRENCY=1
DETAIL_NAVIGATION_TIMEOUT_MS=20000
DETAIL_READY_TIMEOUT_MS=10000
DETAIL_READY_POLL_INTERVAL_MS=250
DETAIL_HARD_TIMEOUT_MS=35000
DETAIL_REUSE_PAGES=true
DETAIL_BLOCK_HEAVY_RESOURCES=true
DETAIL_SERVICE_WORKERS=block
DETAIL_HYDRATION_BACKOFF_MS=50000
DETAIL_HYDRATION_MAX_RETRIES=1
DETAIL_SESSION_RECOVERY_MAX_RETRIES=2
DETAIL_RECHECK_INTERVAL_MS=21600000
DETAIL_FULL_SCAN_INTERVAL_MS=86400000
MAIN_TO_DETAIL_DELAY_MS=10000
DEBUG_DOM=false
DEBUG_DIR=./debug
DEBUG_SAVE_SCREENSHOTS=false
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

`SNAPSHOT_DIR`은 변경 시 전체 상품 JSON과 상품별 diff JSON을 저장할 디렉터리이며 기본값은 `./snapshots`입니다. `DETAIL_CONCURRENCY`는 `1` 또는 `2`만 허용하며 1GB 서버를 고려한 기본값은 `1`입니다. 동시성 `2`의 첫 두 page가 모두 hydration stall이면 실행 중 자동으로 `1`로 낮춥니다.

상세 조회는 하나의 전용 BrowserContext를 공유하고 기본적으로 worker별 page를 재사용합니다. `DETAIL_REUSE_PAGES=false`이면 context만 공유하고 상품마다 새 page를 만듭니다. 기본적으로 `image`, `media`, `font`만 차단하며 document, script, XHR, fetch, stylesheet는 항상 허용합니다. `DETAIL_BLOCK_HEAVY_RESOURCES=false`이면 이미지·미디어·폰트도 허용합니다. `DETAIL_SERVICE_WORKERS=block|allow`로 Service Worker 정책을 비교할 수 있습니다. Navigation timeout은 `DETAIL_NAVIGATION_TIMEOUT_MS=20000`, 준비 timeout은 `DETAIL_READY_TIMEOUT_MS=10000`, 상품 하나의 cleanup 포함 hard timeout은 `DETAIL_HARD_TIMEOUT_MS=35000`이 기본값입니다.

상세 ready는 `DETAIL_READY_POLL_INTERVAL_MS`(기본 `250`) 간격으로 UUID 일치와 본문 20자 이상만 확인합니다. 카드 파싱이 완전하고 노출 옵션이 6개 미만인 상품은 카드만 사용합니다. 옵션 6개 이상, 이전 숨김 옵션 이력, 분석 `UNKNOWN`, 카드 파싱 불완전 상품은 상세 조회하며 `DETAIL_FULL_SCAN_INTERVAL_MS`의 기본값인 24시간마다 전체 상세 검증합니다.

메인 URL 수집 browser는 page와 context를 닫은 뒤 완전히 종료합니다. `MAIN_TO_DETAIL_DELAY_MS`(기본 `10000`)만큼 기다린 다음 별도의 상세 browser/context를 생성합니다. 첫 URL preflight가 hydration stall이면 그 세션을 완전히 종료하고 `DETAIL_HYDRATION_BACKOFF_MS`(기본 `50000`) 후 새 세션으로 재시도합니다. 재시도 횟수는 `DETAIL_HYDRATION_MAX_RETRIES`(기본 `1`)로 제한하며, 성공한 preflight 결과는 첫 상품 결과로 재사용합니다.

상세 순회 중 연속 hydration stall 2회가 발생하면 circuit breaker가 세션을 재생성하고 최초 실패 상품부터 재개합니다. 실행당 세션 복구 횟수는 `DETAIL_SESSION_RECOVERY_MAX_RETRIES`(기본 `2`)로 제한하며, 초과 시 남은 상품을 조회하지 않고 전체 실행을 실패 처리합니다.

`DEBUG_DOM=true`이면 카드 수집 시 `DEBUG_DIR` 아래에 다음 진단 파일을 저장합니다.

- `main-page.html`
- `card-candidates.json`
- `card-click-results.json`
- modal/peek이 열린 카드의 `modal-N.html`

`DEBUG_SAVE_SCREENSHOTS`의 기본값은 `false`입니다. `true`로 설정한 경우에만 `main-page.png`와 `modal-N.png`를 저장합니다. 스크린샷 저장이 실패해도 HTML/JSON 진단과 카드 조사는 계속 진행합니다.

ntfy 설정 없이 실제 Notion 카드만 수동 진단하려면 `NOTION_PAGE_URL`을 설정한 뒤 실행합니다.

```bash
npm run debug:cards
```

수동 진단 모드는 항상 DOM 진단 파일을 저장하며 카탈로그 상태나 알림 상태는 변경하지 않습니다.

동일한 상세 URL을 page 재사용/상품별 새 page 방식으로 각각 5회 비교하려면 실행합니다.

```bash
DETAIL_BENCHMARK_URL=https://example.notion.site/<page-id> npm run benchmark:details
```

각 방식의 개별 시간, 평균 및 최댓값이 로그에 출력됩니다.

운영과 동일한 goto/ready/parse 경로로 상세 URL 하나만 진단할 수 있습니다. 먼저 `DETAIL_CONCURRENCY=1`로 검증한 뒤 정상 동작하면 `2`로 올리는 것을 권장합니다.

```bash
DETAIL_DIAGNOSTIC_URL=https://example.notion.site/<page-id> npm run debug:detail
```

메인 페이지 수집 후 browser를 종료하고 새 상세 browser로 첫 상품을 파싱하는 전체 전환 경로는 다음 명령으로 진단합니다.

```bash
NOTION_PAGE_URL=https://example.notion.site/<catalog-id> npm run debug:transition
```

이 명령은 `npm run test:transition`으로도 실행할 수 있으며, 새 상세 browser에서 본문이 비어 있거나 파싱에 실패하면 0이 아닌 종료 코드로 끝나는 실제 페이지 통합 테스트입니다.

`npm run benchmark:transition`은 `10초 초기 대기 + hydration stall 시 50초 cooldown`과 `고정 60초 초기 대기`를 실제 전체 파이프라인으로 각각 실행해 성공 여부와 소요시간을 JSON으로 비교합니다.

느린 서버에서는 다음 대기 시간을 `.env`에서 늘릴 수 있습니다. 값은 모두 밀리초입니다.

- `PAGE_LOAD_TIMEOUT_MS`: 각 페이지 조회 시도의 첫 응답 대기 시간, 기본 `60000`
- `PAGE_FETCH_MAX_ATTEMPTS`: 같은 실행 안에서 페이지 조회를 시도할 최대 횟수, 기본 `3`
- `PAGE_FETCH_RETRY_DELAYS_MS`: 재시도 전 대기 시간 목록, 기본 `10000,30000`
- `DOMCONTENTLOADED_TIMEOUT_MS`: `domcontentloaded` 이벤트 추가 대기 시간, 기본 `15000`
- `RENDER_WAIT_MS`: Notion 본문 DOM 대기 시간, 기본 `8000`
- `COLLECTION_WAIT_MS`: 상품 카드 `.notion-collection-item` 대기 시간, 기본 `10000`
- `EXTRA_WAIT_MS`: 추출 직전 마지막 고정 대기 시간, 기본 `1500`

상품 카드나 상세 내용이 늦게 렌더링되는 서버라면 예를 들어 `COLLECTION_WAIT_MS=30000`, `EXTRA_WAIT_MS=3000`처럼 늘릴 수 있습니다.

공개 Notion 페이지가 아니거나 로그인이 필요한 페이지라면 정상 본문으로 처리되지 않을 수 있습니다.

상세 페이지 조회 실패는 해당 URL만 새 Playwright context/page로 최대 3회 재시도합니다. 상세 페이지가 하나라도 끝내 실패하면 일반 상태 파일은 변경하지 않고 공개 공지 토픽에도 알림을 보내지 않습니다. 대신 `OPERATION_STATE_FILE`에 연속 조회 실패 횟수를 저장합니다. `OPERATOR_NTFY_TOPIC`을 설정하면 두 번의 cron 실행이 연속 실패했을 때 운영자 전용 토픽으로 장애 알림을 보내고, 이후 정상 조회에 성공하면 복구 알림을 한 번 보냅니다.

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

최초 실행 시에는 알림을 보내지 않고 현재 상품 JSON을 기준 상태로 저장합니다.

실제 변경 감지를 테스트하려면 상품 상세 페이지의 판매 상태나 캐릭터 재고를 수정한 뒤 다음 실행에서 ntfy 알림이 오는지 확인합니다. 단, Notion 반영 지연이 있을 수 있으므로 정각 또는 30분 업데이트 후 2분 뒤 확인하는 운용을 권장합니다.

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
