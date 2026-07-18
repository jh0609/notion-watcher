'use strict';

const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  normalizeCatalog, serializeCatalog, diffCatalog, createHash, evaluateProductUrlCandidate,
  canonicalizeNotionProductUrl, resolveCardProductUrl, resolveConfig, resolveDebugConfig, waitForProductCards,
  attachPageDiagnostics, parseProductText, shouldAbortDetailResource, configureDetailResourcePolicy,
  processDetailPage, createDetailPageSlot, buildDetailContextSettings, parseProductCard, buildHybridDetailPlan,
  isUsableDetailSnapshot, shouldTripHydrationCircuitBreaker, advanceHydrationCircuitState, runOnce,
  validateCatalogMetadata, saveStateWithLog, shouldRotateDetailSession, formatCatalogDiff, formatStatusLabel
} = require('../notion-watcher-once');

async function config() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notion-watcher-test-'));
  return {
    notionPageUrl: 'https://example.test/shop', ntfyServerUrl: 'https://ntfy.test', ntfyTopic: 'topic',
    ntfyToken: 'token', operatorNtfyTopic: '', stateFile: path.join(directory, 'state.json'),
    operationStateFile: path.join(directory, 'operation.json'), lockFile: path.join(directory, 'lock'),
    snapshotDir: path.join(directory, 'snapshots'), staleLockMs: 60_000, pageFetchMaxAttempts: 3,
    pageFetchRetryDelaysMs: [0, 0], detailConcurrency: 2, directory
  };
}

const product = (overrides = {}) => ({
  url: 'https://example.test/11111111111111111111111111111111', name: '상품 A', price: '10,000 원', status: 'FOR SALE',
  characters: [{ name: '캐릭터 B', status: '품절' }, { name: '캐릭터 A', status: '판매 중' }], ...overrides
});

test('debug:cards 스크린샷 저장은 기본적으로 비활성화되고 명시적으로만 활성화된다', () => {
  const base = { NOTION_PAGE_URL: 'https://shop.notion.site/catalog' };
  assert.equal(resolveDebugConfig(base).debugSaveScreenshots, false);
  assert.equal(resolveDebugConfig({ ...base, DEBUG_SAVE_SCREENSHOTS: 'true' }).debugSaveScreenshots, true);
  assert.equal(resolveDebugConfig({ ...base, DEBUG_SAVE_SCREENSHOTS: 'false' }).debugSaveScreenshots, false);
});

test('상품과 캐릭터 DOM 순서가 달라도 직렬화 JSON과 해시는 안정적이다', () => {
  const a = normalizeCatalog([product(), product({ url: 'https://example.test/22222222222222222222222222222222', name: '상품 B' })]);
  const b = normalizeCatalog([
    product({ url: 'https://example.test/22222222222222222222222222222222', name: '상품 B', characters: [...product().characters].reverse() }),
    product({ characters: [...product().characters].reverse() })
  ]);
  assert.equal(serializeCatalog(a), serializeCatalog(b));
  assert.deepEqual(a.products[0].characters.map((item) => item.name), ['캐릭터 A', '캐릭터 B']);
});

test('상세 옵션 8개 중 카드에 6개가 노출된 상품은 requiresDetail=true다', () => {
  const variantRows = ['가', '나', '다', '라', '마', '바'].map((name) => `${name} (판매 중)`);
  const card = parseProductCard({
    innerText: `도트 디폼블럭\n12,000원\n일부 상품 품절\n${variantRows.join('\n')}\n+2개`,
    optionRowTexts: variantRows,
    hrefs: ['/5273f4a9f62683e5b87581c092c3aff2?pvs=25'], blockId: '', pageId: ''
  }, 'https://shop.notion.site/catalog');
  assert.equal(card.visibleVariantCount, 6);
  assert.equal(card.totalVariantCount, 8);
  assert.equal(card.requiresDetail, true);
});

test('포인트 키캡 카드에서 일시 품절 옵션 두 개를 전체 상태와 구분한다', () => {
  const card = parseProductCard({
    innerText: '포인트 키캡\n49,000원\n일시 품절\n김준호 （일시\u00a0품절）\n정예슬 (일시  품절)',
    optionRowTexts: ['김준호 （일시\u00a0품절）', '정예슬 (일시  품절)'],
    hrefs: ['/3973f4a9f62680f699e4e6fb8d3d56bb'], blockId: '', pageId: ''
  }, 'https://shop.notion.site/catalog');
  assert.equal(card.status, '일시 품절');
  assert.equal(card.visibleVariantCount, 2);
  assert.deepEqual(card.characters, [
    { name: '김준호', status: 'temporarily_sold_out' },
    { name: '정예슬', status: 'temporarily_sold_out' }
  ]);
});

test('UUID가 일치하고 본문이 20자 이상이면 readyState와 무관하게 usable하다', () => {
  assert.equal(isUsableDetailSnapshot({
    expectedPageIdMatched: true, documentReadyState: 'interactive', bodyTextLength: 187
  }), true);
});

test('변경 없는 작은 카드는 6시간 전까지 이전 상세 옵션을 재사용한다', () => {
  const mainUrl = 'https://shop.notion.site/catalog';
  const candidate = {
    innerText: '상품 A\n10,000원\n판매 중\n가 (판매 중)',
    optionRowTexts: ['가 (판매 중)'],
    hrefs: ['/5273f4a9f62683e5b87581c092c3aff2'], blockId: '', pageId: ''
  };
  const card = parseProductCard(candidate, mainUrl);
  const checkedAt = '2026-07-17T00:00:00.000Z';
  const previousState = {
    productMetadata: { [card.url]: {
      cardHash: card.cardHash, totalVariantCount: 1, lastDetailCheckedAt: checkedAt,
      fullVariants: [{ name: '가', status: 'for_sale' }]
    } },
    catalog: { products: [] }
  };
  const plan = buildHybridDetailPlan({ urls: [card.url], candidates: [candidate] }, previousState, {
    notionPageUrl: mainUrl, detailRecheckIntervalMs: 21_600_000
  });
  assert.deepEqual(plan.detailUrls, []);
});

function hybridPlanForCandidate(candidate, previousState = null) {
  const mainUrl = 'https://shop.notion.site/catalog';
  const card = parseProductCard(candidate, mainUrl);
  return buildHybridDetailPlan({ urls: [card.url], candidates: [candidate] }, previousState, {
    notionPageUrl: mainUrl
  });
}

test('포인트 키캡 visible=2이고 파싱이 완전하면 최초 실행에서도 상세를 생략한다', () => {
  const candidate = {
    innerText: '포인트 키캡\n49,000원\n일시 품절\n김준호 (일시 품절)\n정예슬 (일시 품절)',
    optionRowTexts: ['김준호 (일시 품절)', '정예슬 (일시 품절)'],
    hrefs: ['/3973f4a9f62680f699e4e6fb8d3d56bb'], blockId: '', pageId: ''
  };
  assert.deepEqual(hybridPlanForCandidate(candidate).detailUrls, []);
});

for (const name of ['팝업 스토어 캐릭터 아크릴 스탠드', '팝업 스토어 SD 아크릴 미니픽',
  '팝업 스토어 캐릭터 도트 디폼블럭', '엠블럼 메탈 뱃지']) {
  test(`${name} visible=6이면 상세 조회 대상으로 둔다`, () => {
    const rows = ['가', '나', '다', '라', '마', '바'].map((value) => `${value} (판매 중)`);
    const candidate = {
      innerText: `${name}\n19,000원\n판매 중\n${rows.join('\n')}`, optionRowTexts: rows,
      hrefs: [`/${createHash(name).slice(0, 32)}`], blockId: '', pageId: ''
    };
    const plan = hybridPlanForCandidate(candidate);
    assert.equal(plan.detailReasonByUrl[plan.detailUrls[0]], 'visible-limit-reached');
  });
}

test('이전 totalVariantCount가 현재 visibleVariantCount보다 크면 상세 조회한다', () => {
  const candidate = {
    innerText: '상품 A\n10,000원\n판매 중\n가 (판매 중)', optionRowTexts: ['가 (판매 중)'],
    hrefs: ['/5273f4a9f62683e5b87581c092c3aff2'], blockId: '', pageId: ''
  };
  const card = parseProductCard(candidate, 'https://shop.notion.site/catalog');
  const previous = { productMetadata: {
    [card.url]: { totalVariantCount: 2, visibleVariantCount: 1, knownHiddenVariants: true }
  }, catalog: { products: [] } };
  const plan = hybridPlanForCandidate(candidate, previous);
  assert.equal(plan.detailReasonByUrl[card.url], 'known-hidden-variants');
});

test('분석 UNKNOWN 상품은 상세 조회 대상으로 유지한다', () => {
  const candidate = {
    innerText: '로맨스 판타지 캐릭터 아크릴 스탠드\n19,000원\n판매 중', optionRowTexts: [],
    hrefs: ['/39f3f4a9f6268046b716ee5e88e71956'], blockId: '', pageId: ''
  };
  const plan = hybridPlanForCandidate(candidate);
  assert.equal(plan.detailReasonByUrl[plan.detailUrls[0]], 'unknown-analysis');
});

test('신규 상품의 카드 필수 필드가 누락되면 상세 조회한다', () => {
  const candidate = { innerText: '신규 상품', optionRowTexts: [],
    hrefs: ['/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], blockId: '', pageId: '' };
  const plan = hybridPlanForCandidate(candidate);
  assert.equal(plan.detailReasonByUrl[plan.detailUrls[0]], 'card-parse-incomplete');
});

test('최초 실행의 검증된 34개 분포는 card-only 29, visible-limit 4, UNKNOWN 1이다', () => {
  const mainUrl = 'https://shop.notion.site/catalog';
  const candidates = [];
  for (let index = 0; index < 29; index += 1) {
    const id = `${index + 1}`.padStart(32, '0');
    candidates.push({ innerText: `카드 상품 ${index}\n10,000원\n판매 중`, optionRowTexts: [], hrefs: [`/${id}`] });
  }
  for (let index = 0; index < 4; index += 1) {
    const id = `${100 + index}`.padStart(32, '0');
    const rows = ['가', '나', '다', '라', '마', '바'].map((name) => `${name} (판매 중)`);
    candidates.push({ innerText: `상세 상품 ${index}\n10,000원\n판매 중\n${rows.join('\n')}`, optionRowTexts: rows, hrefs: [`/${id}`] });
  }
  candidates.push({ innerText: '로맨스 판타지 캐릭터 아크릴 스탠드\n19,000원\n판매 중', optionRowTexts: [],
    hrefs: ['/39f3f4a9f6268046b716ee5e88e71956'] });
  const urls = candidates.map((candidate) => resolveCardProductUrl(candidate, mainUrl).url);
  const plan = buildHybridDetailPlan({ urls, candidates }, null, { notionPageUrl: mainUrl });
  const reasons = Object.values(plan.detailReasonByUrl);
  assert.equal(plan.cards.length - plan.detailUrls.length, 29);
  assert.equal(reasons.filter((reason) => reason === 'visible-limit-reached').length, 4);
  assert.equal(reasons.filter((reason) => reason === 'unknown-analysis').length, 1);
  assert.equal(plan.detailUrls.length, 5);
});

test('레거시 전체 스캔 시각과 환경변수 값이 있어도 전체 상세 조회가 재발하지 않는다', () => {
  const mainUrl = 'https://shop.notion.site/catalog';
  const candidates = [];
  for (let index = 0; index < 29; index += 1) {
    const id = `${index + 1}`.padStart(32, '0');
    candidates.push({ innerText: `카드 상품 ${index}\n10,000원\n판매 중`, optionRowTexts: [], hrefs: [`/${id}`] });
  }
  for (let index = 0; index < 4; index += 1) {
    const id = `${100 + index}`.padStart(32, '0');
    const rows = ['가', '나', '다', '라', '마', '바'].map((name) => `${name} (판매 중)`);
    candidates.push({ innerText: `상세 상품 ${index}\n10,000원\n판매 중\n${rows.join('\n')}`,
      optionRowTexts: rows, hrefs: [`/${id}`] });
  }
  candidates.push({ innerText: '로맨스 판타지 캐릭터 아크릴 스탠드\n19,000원\n판매 중', optionRowTexts: [],
    hrefs: ['/39f3f4a9f6268046b716ee5e88e71956'] });
  const urls = candidates.map((candidate) => resolveCardProductUrl(candidate, mainUrl).url);

  for (const lastFullDetailScanAt of ['2026-07-18T00:00:00.000Z', '2020-01-01T00:00:00.000Z']) {
    const plan = buildHybridDetailPlan({ urls, candidates }, {
      lastFullDetailScanAt,
      productMetadata: {},
      catalog: { products: [] }
    }, { notionPageUrl: mainUrl, detailFullScanIntervalMs: 1 });
    assert.equal(plan.detailUrls.length, 5);
    assert.equal(plan.detailUrls.length < plan.cards.length, true);
    assert.equal(Object.values(plan.detailReasonByUrl).includes('periodic-full-scan'), false);
    assert.equal('firstFullRun' in plan, false);
    assert.equal('fullScanDue' in plan, false);
  }
});

test('DETAIL_FULL_SCAN_INTERVAL_MS는 더 이상 config로 파싱하지 않는다', () => {
  const cfg = resolveConfig({
    NOTION_PAGE_URL: 'https://shop.notion.site/catalog',
    NTFY_SERVER_URL: 'https://ntfy.test', NTFY_TOPIC: 'topic', NTFY_TOKEN: 'token',
    DETAIL_FULL_SCAN_INTERVAL_MS: '1'
  });
  assert.equal('detailFullScanIntervalMs' in cfg, false);
});

test('추가, 삭제, 상품 상태와 캐릭터 상태를 상품 단위로 diff한다', () => {
  const before = normalizeCatalog([product(), product({ url: 'https://example.test/p/old', name: '삭제 상품' })]);
  const after = normalizeCatalog([
    product({ status: '품절', characters: [{ name: '캐릭터 A', status: '품절' }] }),
    product({ url: 'https://example.test/p/new', name: '추가 상품' })
  ]);
  const diff = diffCatalog(before, after);
  assert.deepEqual(diff.map((item) => item.type).sort(), ['added', 'changed', 'removed']);
  const changed = diff.find((item) => item.type === 'changed');
  assert.ok(changed.changes.some((item) => item.field === 'status'));
  assert.ok(changed.changes.some((item) => item.field === 'character_status'));
  assert.ok(changed.changes.some((item) => item.field === 'character_removed'));
});

test('알림의 상품 및 캐릭터 상태를 한글 라벨로 표시한다', () => {
  assert.equal(formatStatusLabel('for_sale'), '판매 중');
  assert.equal(formatStatusLabel('sold_out'), '품절');
  assert.equal(formatStatusLabel('temporarily_sold_out'), '일시 품절');
  assert.equal(formatStatusLabel('partially_sold_out'), '일부 상품 품절');
  assert.equal(formatStatusLabel('discontinued'), '판매 종료');
  const message = formatCatalogDiff([{
    type: 'changed', name: '상품 A', changes: [
      { field: 'status', before: 'for_sale', after: 'sold_out' },
      { field: 'character_status', name: '캐릭터 A', before: 'temporarily_sold_out', after: 'for_sale' },
      { field: 'character_added', name: '캐릭터 B', after: 'partially_sold_out' },
      { field: 'character_removed', name: '캐릭터 C', before: 'discontinued' }
    ]
  }]);
  assert.match(message, /상태: 판매 중 → 품절/);
  assert.match(message, /캐릭터 A: 일시 품절 → 판매 중/);
  assert.match(message, /캐릭터 추가 캐릭터 B: 일부 상품 품절/);
  assert.match(message, /캐릭터 삭제 캐릭터 C: 판매 종료/);
  assert.doesNotMatch(message, /for_sale|sold_out|discontinued/);
});

test('외부 링크와 실제 Notion 상품 링크가 섞여 있어도 상품 링크만 허용한다', () => {
  const main = 'https://shop.notion.site/catalog-abc';
  const candidates = [
    { href: 'https://shop.notion.site/product-one', innerText: '상품 1' },
    { href: 'https://www.notion.so/product-two', innerText: '상품 2' },
    { href: 'https://example.com/help', innerText: '도움말' },
    { href: 'mailto:hello@example.com', innerText: '메일' },
    { href: '#stock', innerText: '재고' },
    { href: main, innerText: '현재 페이지' }
  ].map((candidate) => evaluateProductUrlCandidate(candidate, main));
  assert.deepEqual(candidates.filter((item) => item.allowed).map((item) => item.hostname), [
    'shop.notion.site', 'www.notion.so'
  ]);
  assert.deepEqual(candidates.filter((item) => !item.allowed).map((item) => item.reason), [
    'external host', 'unsupported scheme', 'hash link', 'main page itself'
  ]);
});

test('X 링크는 상품 URL 후보에서 명시적으로 제거한다', () => {
  const result = evaluateProductUrlCandidate(
    { href: 'https://x.com/phoenixcolab', innerText: '불새재단연구소' },
    'https://shop.notion.site/catalog'
  );
  assert.equal(result.allowed, false);
  assert.equal(result.hostname, 'x.com');
  assert.equal(result.reason, 'blocked external host');
});

test('peek, modal, block-id URL을 같은 Notion 상품 URL로 정규화한다', () => {
  const main = 'https://shop.notion.site/MD-3973f4a9f62680f39ddafca527725466';
  const id = '5273f4a9f62683e5b87581c092c3aff2';
  const variants = [
    `https://shop.notion.site/${id}`,
    `${main}?p=${id}&pm=c`,
    `https://shop.notion.site/product-name-${id}?pvs=23`
  ];
  assert.deepEqual([...new Set(variants.map((url) => canonicalizeNotionProductUrl(url, main)))], [
    `https://shop.notion.site/${id}`
  ]);
});

test('카드 URL은 내부 href를 우선하고 없으면 data-block-id를 사용한다', () => {
  const main = 'https://shop.notion.site/catalog-3973f4a9f62680f39ddafca527725466';
  const hrefId = '5273f4a9f62683e5b87581c092c3aff2';
  const blockId = 'fc23f4a9-f626-8239-b103-019493706226';
  assert.deepEqual(resolveCardProductUrl({ hrefs: [`/${hrefId}?pvs=25`], blockId }, main), {
    url: `https://shop.notion.site/${hrefId}`,
    source: 'card-anchor'
  });
  assert.deepEqual(resolveCardProductUrl({ hrefs: [], blockId }, main), {
    url: 'https://shop.notion.site/fc23f4a9f6268239b103019493706226',
    source: 'card-block-id'
  });
  assert.equal(resolveCardProductUrl({ hrefs: ['https://x.com/example'], blockId: '' }, main), null);
});

test('상품 카드 대기는 collection item 자체와 최소 2개 조건을 모두 사용한다', async () => {
  const calls = [];
  await waitForProductCards({
    waitForSelector: async (selector, options) => calls.push({ type: 'selector', selector, options }),
    waitForFunction: async (callback, argument, options) => {
      calls.push({ type: 'function', argument, options, callback: callback.toString() });
    }
  }, 4321);
  assert.equal(calls[0].selector, '.notion-collection-item');
  assert.equal(calls[0].options.timeout, 4321);
  assert.match(calls[1].callback, /length >= 2/);
  assert.equal(calls[1].options.timeout, 4321);
});

test('운영 페이지 진단은 일반 노이즈를 제외하되 Notion API 오류를 보관한다', () => {
  const handlers = {};
  const diagnostics = attachPageDiagnostics({ on: (event, handler) => { handlers[event] = handler; } }, 'test');
  handlers.console({ type: () => 'error', text: () => 'Statsig request failed' });
  handlers.response({ status: () => 401, url: () => 'https://www.notion.so/api/v3/getSubscriptionBanner' });
  handlers.requestfailed({
    url: () => 'https://www.notion.so/api/v3/loadPageChunk',
    failure: () => ({ errorText: 'net::ERR_FAILED' })
  });
  handlers.pageerror(new Error('important Notion renderer failure'));
  assert.equal(diagnostics.entries.length, 4);
  assert.equal(diagnostics.entries[0].ignored, true);
  assert.match(diagnostics.entries[1].message, /getSubscriptionBanner/);
  assert.match(diagnostics.entries[2].message, /loadPageChunk/);
  assert.match(diagnostics.entries[2].message, /resourceType=unknown/);
  assert.match(diagnostics.entries[3].message, /renderer failure/);
});

function createStatsigDetailPage(bodyTextLength) {
  const handlers = {};
  const pageUrl = 'https://example.test/5273f4a9f62683e5b87581c092c3aff2';
  return {
    handlers,
    on: (event, handler) => { handlers[event] = handler; },
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    goto: async () => undefined,
    url: () => pageUrl,
    waitForTimeout: async () => undefined,
    evaluate: async (fn) => fn.toString().includes('documentReadyState')
      ? { expectedPageIdMatched: true, documentReadyState: 'interactive', bodyTextLength }
      : { title: '상품 A', text: '상품 A 10,000원 판매 중', rowTexts: [] },
    isClosed: () => false,
    close: async () => undefined
  };
}

test('Statsig console error가 있어도 정상 본문과 parse 결과면 성공한다', async () => {
  const page = createStatsigDetailPage(187);
  const promise = processDetailPage(page, page.url(), {
    detailNavigationTimeoutMs: 1000, detailReadyTimeoutMs: 100, detailReadyPollIntervalMs: 10, detailHardTimeoutMs: 1000
  }, 'statsig-console-test');
  page.handlers.console({ type: () => 'error', text: () => '[Statsig] networking error during initialize' });
  assert.equal((await promise).name, '상품 A');
});

test('Statsig request failure가 있어도 정상 parse 결과면 성공한다', async () => {
  const page = createStatsigDetailPage(187);
  const promise = processDetailPage(page, page.url(), {
    detailNavigationTimeoutMs: 1000, detailReadyTimeoutMs: 100, detailReadyPollIntervalMs: 10, detailHardTimeoutMs: 1000
  }, 'statsig-request-test');
  page.handlers.requestfailed({
    url: () => 'https://exp.notion.com/v1/initialize', resourceType: () => 'fetch',
    failure: () => ({ errorText: 'net::ERR_FAILED' })
  });
  assert.equal((await promise).status, '판매 중');
});

test('Statsig 오류와 빈 본문이면 원인은 hydration stall이다', async () => {
  const page = createStatsigDetailPage(0);
  const promise = processDetailPage(page, page.url(), {
    detailNavigationTimeoutMs: 1000, detailReadyTimeoutMs: 10, detailReadyPollIntervalMs: 1, detailHardTimeoutMs: 1000
  }, 'statsig-hydration-test');
  page.handlers.console({ type: () => 'error', text: () => '[Statsig] Failed to fetch' });
  await assert.rejects(promise, (error) => error.reason === 'hydration stall' && !/statsig/i.test(error.message));
});

test('Statsig 오류만으로 circuit breaker가 발동하지 않고 hydration stall 두 번이면 발동한다', () => {
  assert.equal(shouldTripHydrationCircuitBreaker(0), false);
  assert.equal(shouldTripHydrationCircuitBreaker(1), false);
  assert.equal(shouldTripHydrationCircuitBreaker(2), true);
});

test('세션별 hydration circuit breaker는 두 번 복구 후 세 번째 구간에서 중단한다', () => {
  let state = { consecutiveStalls: 0, recoveries: 0 };
  state = advanceHydrationCircuitState(state, 'hydration-stall', 2);
  assert.equal(state.action, 'continue');
  state = advanceHydrationCircuitState(state, 'hydration-stall', 2);
  assert.equal(state.action, 'recover');
  assert.equal(state.recoveries, 1);

  state = advanceHydrationCircuitState(state, 'success', 2);
  assert.equal(state.consecutiveStalls, 0);
  state = advanceHydrationCircuitState(state, 'hydration-stall', 2);
  state = advanceHydrationCircuitState(state, 'hydration-stall', 2);
  assert.equal(state.action, 'recover');
  assert.equal(state.recoveries, 2);

  state = advanceHydrationCircuitState(state, 'hydration-stall', 2);
  state = advanceHydrationCircuitState(state, 'hydration-stall', 2);
  assert.equal(state.action, 'abort');
  assert.equal(state.recoveries, 2);
  const shouldFetchNextProduct = state.action !== 'abort';
  assert.equal(shouldFetchNextProduct, false);
});

test('상세 리소스 차단은 image, media, font에만 적용한다', () => {
  assert.deepEqual(['image', 'media', 'font'].map(shouldAbortDetailResource), [true, true, true]);
  assert.deepEqual(
    ['document', 'script', 'xhr', 'fetch', 'stylesheet'].map(shouldAbortDetailResource),
    [false, false, false, false, false]
  );
});

test('상세 context 정책은 차단 대상은 abort하고 필수 리소스는 continue한다', async () => {
  let handler;
  await configureDetailResourcePolicy({ route: async (pattern, callback) => {
    assert.equal(pattern, '**/*');
    handler = callback;
  } });
  const decisions = [];
  for (const type of ['image', 'script', 'xhr', 'fetch', 'stylesheet']) {
    await handler({
      request: () => ({ resourceType: () => type }),
      abort: async () => decisions.push(`${type}:abort`),
      continue: async () => decisions.push(`${type}:continue`)
    });
  }
  assert.deepEqual(decisions, [
    'image:abort', 'script:continue', 'xhr:continue', 'fetch:continue', 'stylesheet:continue'
  ]);
});

test('DETAIL_BLOCK_HEAVY_RESOURCES=false이면 request routing을 설치하지 않는다', async () => {
  let routeCalls = 0;
  await configureDetailResourcePolicy({ route: async () => { routeCalls += 1; } }, false);
  assert.equal(routeCalls, 0);
});

test('상세 리소스와 Service Worker 정책은 환경변수로 비교할 수 있다', () => {
  const base = {
    NOTION_PAGE_URL: 'https://example.notion.site/catalog', NTFY_SERVER_URL: 'https://ntfy.sh',
    NTFY_TOPIC: 'topic', NTFY_TOKEN: 'token'
  };
  const defaults = resolveConfig(base);
  assert.equal(defaults.detailBlockHeavyResources, true);
  assert.equal(defaults.detailServiceWorkers, 'block');
  assert.equal(defaults.mainToDetailDelayMs, 10_000);
  assert.equal(defaults.detailHydrationBackoffMs, 50_000);
  assert.equal(defaults.detailHydrationMaxRetries, 1);
  assert.equal(defaults.detailMaxPagesPerSession, 2);
  assert.equal(defaults.detailSessionRotationDelayMs, 3_000);
  assert.equal(defaults.detailConsecutiveStallThreshold, 1);
  const allowed = resolveConfig({
    ...base, DETAIL_BLOCK_HEAVY_RESOURCES: 'false', DETAIL_SERVICE_WORKERS: 'allow'
  });
  assert.equal(allowed.detailBlockHeavyResources, false);
  assert.equal(allowed.detailServiceWorkers, 'allow');
});

test('preflight를 포함해 상세 두 개 처리 후 정상 세션 순환한다', () => {
  let processedInSession = 1;
  assert.equal(shouldRotateDetailSession(processedInSession, 2), false);
  processedInSession += 1;
  assert.equal(shouldRotateDetailSession(processedInSession, 2), true);
});

test('hydration stall 한 번이면 다음 상품 전에 circuit breaker가 발동한다', () => {
  assert.equal(shouldTripHydrationCircuitBreaker(1, 1), true);
  assert.equal(shouldTripHydrationCircuitBreaker(0, 1), false);
});

test('stall 실패 상품은 새 세션 queue 선두에서 재개되고 5개가 중복·누락 없이 완료된다', () => {
  const pending = [0, 1, 2, 3, 4];
  const completed = [];
  let stalledOnce = false;
  let session = 1;
  while (pending.length) {
    const index = pending.shift();
    if (index === 2 && !stalledOnce) {
      stalledOnce = true;
      session += 1;
      pending.unshift(index);
      assert.equal(pending[0], 2);
      continue;
    }
    completed.push({ index, session });
  }
  assert.deepEqual(completed.map((item) => item.index), [0, 1, 2, 3, 4]);
  assert.equal(new Set(completed.map((item) => item.index)).size, 5);
  assert.equal(completed.find((item) => item.index === 2).session, 2);
});

test('test:transition과 debug:detail은 동일한 상세 context 설정 빌더를 사용한다', () => {
  const browser = { version: () => '149.0.0.0' };
  const operational = buildDetailContextSettings(browser, {
    detailBlockHeavyResources: false, detailServiceWorkers: 'allow'
  });
  const diagnostic = buildDetailContextSettings(browser, {
    detailBlockHeavyResources: false, detailServiceWorkers: 'allow'
  });
  assert.deepEqual(diagnostic, operational);
});

test('10초 초기 대기와 50초 hydration cooldown은 고정 60초 대기와 총 대기시간이 같다', () => {
  assert.equal(10_000 + 50_000, 60_000);
});

test('리소스 차단 적용 전후의 텍스트 본문 파싱 결과는 동일하다', () => {
  const title = '캐릭터 아크릴 스탠드';
  const text = '캐릭터 아크릴 스탠드 19,000원 판매 중 (FOR SALE) 고나래 (판매 중) 김준호 (품절)';
  const beforeBlocking = parseProductText(title, text);
  const afterBlocking = parseProductText(title, text);
  assert.deepEqual(afterBlocking, beforeBlocking);
  assert.equal(afterBlocking.price, '19,000원');
  assert.equal(afterBlocking.status, '판매 중');
});

test('20초 navigation timeout은 page.goto에 직접 적용되어 20~25초 안에 반환된다', { timeout: 30_000 }, async () => {
  let passedOptions;
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    isClosed: () => false,
    close: async () => undefined,
    goto: async (_url, options) => {
      passedOptions = options;
      await new Promise((resolve) => setTimeout(resolve, options.timeout));
      const error = new Error(`Timeout ${options.timeout}ms exceeded`);
      error.name = 'TimeoutError';
      throw error;
    }
  };
  const startedAt = Date.now();
  await assert.rejects(processDetailPage(page, 'https://example.test/product', {
    detailNavigationTimeoutMs: 20_000,
    detailReadyTimeoutMs: 10_000,
    detailHardTimeoutMs: 35_000
  }, 'timeout-test'), /Timeout 20000ms/);
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(passedOptions, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  assert.ok(elapsedMs >= 19_500 && elapsedMs <= 25_000, `elapsed=${elapsedMs}ms`);
});

test('ready polling은 timeout 안에 usable snapshot이 없으면 반환된다', async () => {
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    isClosed: () => false,
    close: async () => undefined,
    goto: async () => undefined,
    waitForTimeout: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    evaluate: async () => ({ expectedPageIdMatched: true, documentReadyState: 'interactive', bodyTextLength: 0 })
  };
  const startedAt = Date.now();
  await assert.rejects(processDetailPage(page, 'https://example.test/5273f4a9f62683e5b87581c092c3aff2', {
    detailNavigationTimeoutMs: 20_000,
    detailReadyTimeoutMs: 50,
    detailReadyPollIntervalMs: 10,
    detailHardTimeoutMs: 35_000
  }, 'ready-timeout-test'), /hydration stall/);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 40 && elapsedMs <= 500, `elapsed=${elapsedMs}ms`);
});

test('본문이 나타난 뒤 500ms 이내에 polling ready가 완료된다', async () => {
  let snapshots = 0;
  const startedAt = Date.now();
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    goto: async () => undefined,
    evaluate: async (fn) => fn.toString().includes('documentReadyState')
      ? { expectedPageIdMatched: true, documentReadyState: 'interactive', bodyTextLength: ++snapshots >= 2 ? 187 : 0 }
      : { title: '상품 A', text: '상품 A 10,000원 판매 중', rowTexts: [] },
    url: () => 'https://example.test/5273f4a9f62683e5b87581c092c3aff2',
    waitForTimeout: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isClosed: () => false,
    close: async () => undefined
  };
  const result = await processDetailPage(page, page.url(), {
    detailNavigationTimeoutMs: 20_000, detailReadyTimeoutMs: 1000,
    detailReadyPollIntervalMs: 250, detailHardTimeoutMs: 35_000
  }, 'ready-condition-test');
  assert.equal(result.price, '10,000원');
  assert.ok(Date.now() - startedAt < 500);
});

test('parse 결과가 불완전하면 1초 대기 후 한 번 재파싱한다', async () => {
  let evaluateCalls = 0;
  const waits = [];
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    goto: async () => undefined,
    waitForFunction: async () => undefined,
    evaluate: async (fn) => {
      if (fn.toString().includes('documentReadyState')) return {
        expectedPageIdMatched: true, documentReadyState: 'interactive', bodyTextLength: 30
      };
      evaluateCalls += 1;
      return evaluateCalls === 1
        ? { title: '상품 A', text: '상세 본문만 먼저 표시되었습니다.', rowTexts: [] }
        : { title: '상품 A', text: '상품 A 10,000원 판매 중 (FOR SALE)', rowTexts: [] };
    },
    url: () => 'https://example.test/5273f4a9f62683e5b87581c092c3aff2',
    waitForTimeout: async (ms) => waits.push(ms),
    isClosed: () => false,
    close: async () => undefined
  };
  const result = await processDetailPage(page, page.url(), {
    detailNavigationTimeoutMs: 20_000, detailReadyTimeoutMs: 10_000, detailHardTimeoutMs: 35_000
  }, 'parse-retry-test');
  assert.equal(result.price, '10,000원');
  assert.deepEqual(waits, [1000]);
  assert.equal(evaluateCalls, 2);
});

test('interactive 상태에서 본문이 0자면 hydration stall로 분류한다', async () => {
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async () => ({
      currentUrl: 'https://example.test/5273f4a9f62683e5b87581c092c3aff2',
      documentReadyState: 'interactive', bodyTextLength: 0, bodyTextPreview: '',
      priceMatched: false, statusMatched: false,
      expectedPageId: '5273f4a9f62683e5b87581c092c3aff2', expectedPageIdMatched: true
    }),
    isClosed: () => false,
    close: async () => undefined
  };
  await assert.rejects(processDetailPage(page,
    'https://example.test/5273f4a9f62683e5b87581c092c3aff2', {
    detailNavigationTimeoutMs: 1000, detailReadyTimeoutMs: 10, detailHardTimeoutMs: 1000
  }, 'hydration-test'), /hydration stall/);
});

test('hard timeout은 page를 닫고 이전 attempt가 정착한 뒤 반환한다', async () => {
  let closed = false;
  let underlyingSettled = false;
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    isClosed: () => closed,
    close: async () => { closed = true; },
    goto: async () => undefined,
    evaluate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      underlyingSettled = true;
      throw new Error('late ready failure');
    },
    waitForTimeout: async () => undefined
  };
  const originalLog = console.log;
  const captured = [];
  console.log = (...args) => captured.push(args.join(' '));
  try {
    await assert.rejects(processDetailPage(page, 'https://example.test/5273f4a9f62683e5b87581c092c3aff2', {
      detailNavigationTimeoutMs: 1000,
      detailReadyTimeoutMs: 1000,
      detailHardTimeoutMs: 20
    }, 'hard-timeout-test'), /detail hard timeout/);
    assert.equal(closed, true);
    assert.equal(underlyingSettled, true);
    const countAtReturn = captured.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(captured.length, countAtReturn);
    assert.equal(captured.some((line) => /late ready failure|Target page.*closed/i.test(line)), false);
  } finally {
    console.log = originalLog;
  }
});

test('worker 두 개가 page를 교체해도 활성 page 수는 동시성 2를 넘지 않는다', async () => {
  let active = 0;
  let maxActive = 0;
  const context = {
    newPage: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      let closed = false;
      return {
        isClosed: () => closed,
        close: async () => {
          if (!closed) {
            closed = true;
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
          }
        }
      };
    }
  };
  const slots = [createDetailPageSlot(context), createDetailPageSlot(context)];
  await Promise.all(slots.map((slot) => slot.get()));
  await Promise.all(slots.map((slot) => slot.get(true)));
  assert.equal(maxActive, 2);
  await Promise.all(slots.map((slot) => slot.discard()));
  assert.equal(active, 0);
});

test('부분 조회 실패 시 기존 상태를 저장하지 않는다', async () => {
  const cfg = await config();
  const previous = { hash: 'old', catalog: normalizeCatalog([product()]), checkedAt: 'old', changedAt: null };
  await fs.writeFile(cfg.stateFile, JSON.stringify(previous));
  const exitCode = await runOnce({ config: cfg, deps: {
    fetchCatalog: async () => { throw new Error('product detail fetch failed'); },
    sendOperatorNotification: async () => false, now: () => new Date('2026-07-17T00:00:00Z')
  } });
  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(cfg.stateFile, 'utf8')), previous);
});

test('변경 시 상태와 전체 스냅샷 및 diff 파일을 저장한다', async () => {
  const cfg = await config();
  await fs.writeFile(cfg.stateFile, JSON.stringify({ hash: 'old', catalog: normalizeCatalog([product()]), checkedAt: 'old' }));
  let notification = '';
  const current = normalizeCatalog([
    product({ status: '품절' }),
    product({ url: 'https://example.test/22222222222222222222222222222222', name: '상품 B' })
  ]);
  const exitCode = await runOnce({ config: cfg, deps: {
    fetchCatalog: async () => current,
    sendNotification: async (_config, _at, _before, _after, body) => { notification = body; },
    sendOperatorNotification: async () => false, now: () => new Date('2026-07-17T00:00:00Z')
  } });
  assert.equal(exitCode, 0);
  assert.match(notification, /상품 A/);
  assert.equal((await fs.readdir(cfg.snapshotDir)).length, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(cfg.stateFile, 'utf8')).catalog, current);
});

test('저장 해시만 달라지고 상품 diff가 비어 있으면 공개 알림을 보내지 않는다', async () => {
  const cfg = await config();
  const previousCatalog = normalizeCatalog([
    product(),
    product({ url: 'https://example.test/22222222222222222222222222222222', name: '상품 B' })
  ]);
  await fs.writeFile(cfg.stateFile, JSON.stringify({
    hash: 'metadata-only-old-hash',
    catalog: previousCatalog,
    checkedAt: 'old',
    changedAt: '2026-07-16T00:00:00.000Z',
    lastFullDetailScanAt: '2020-01-01T00:00:00.000Z'
  }));
  let notificationCount = 0;
  const exitCode = await runOnce({ config: cfg, deps: {
    fetchCatalog: async () => previousCatalog,
    sendNotification: async () => { notificationCount += 1; },
    sendOperatorNotification: async () => false,
    now: () => new Date('2026-07-17T00:00:00Z')
  } });
  const saved = JSON.parse(await fs.readFile(cfg.stateFile, 'utf8'));
  assert.equal(exitCode, 0);
  assert.equal(notificationCount, 0);
  assert.notEqual(saved.hash, 'metadata-only-old-hash');
  assert.equal(saved.changedAt, '2026-07-16T00:00:00.000Z');
  assert.equal('lastFullDetailScanAt' in saved, false);
  await assert.rejects(fs.access(cfg.snapshotDir), { code: 'ENOENT' });
});

test('상품이 1개만 추출되면 최초 실행에서도 상태 저장을 거부한다', async () => {
  const cfg = await config();
  const exitCode = await runOnce({ config: cfg, deps: {
    fetchCatalog: async () => normalizeCatalog([product()]),
    sendNotification: async () => { throw new Error('알림을 보내면 안 됩니다.'); },
    sendOperatorNotification: async () => false,
    now: () => new Date('2026-07-17T00:00:00Z')
  } });
  assert.equal(exitCode, 1);
  await assert.rejects(fs.access(cfg.stateFile), { code: 'ENOENT' });
});

test('카드 전용 상품과 상세 상품 메타데이터가 JSON round-trip 후에도 유지된다', () => {
  const point = {
    ...product({ name: '포인트 키캡' }), pageId: '11111111111111111111111111111111',
    visibleVariants: [{ name: '김준호', status: '일시 품절' }, { name: '정예슬', status: '일시 품절' }],
    fullVariants: [{ name: '김준호', status: '일시 품절' }, { name: '정예슬', status: '일시 품절' }],
    visibleVariantCount: 2, totalVariantCount: 2, hiddenVariantCount: 0, knownHiddenVariants: false,
    cardParseComplete: true, cardHash: 'point-hash', detailReason: null, detailSource: 'card', lastDetailCheckedAt: null
  };
  const hidden = {
    ...product({ url: 'https://example.test/22222222222222222222222222222222', name: '숨김 상품' }),
    pageId: '22222222222222222222222222222222',
    visibleVariants: Array.from({ length: 6 }, (_, index) => ({ name: `옵션 ${index}`, status: '판매 중' })),
    fullVariants: Array.from({ length: 8 }, (_, index) => ({ name: `옵션 ${index}`, status: '판매 중' })),
    visibleVariantCount: 6, totalVariantCount: 8, hiddenVariantCount: 2, knownHiddenVariants: true,
    cardParseComplete: true, cardHash: 'hidden-hash', detailReason: 'visible-limit-reached',
    detailSource: 'detail', lastDetailCheckedAt: '2026-07-17T00:00:00.000Z'
  };
  const catalog = normalizeCatalog([point, hidden]);
  validateCatalogMetadata(catalog);
  const restored = JSON.parse(serializeCatalog(catalog));
  validateCatalogMetadata(restored);
  assert.equal(restored.products.find((item) => item.name === '포인트 키캡').detailSource, 'card');
  const restoredHidden = restored.products.find((item) => item.name === '숨김 상품');
  assert.equal(restoredHidden.hiddenVariantCount, 2);
  assert.equal(restoredHidden.knownHiddenVariants, true);
  assert.equal(restoredHidden.characters.length, 8);
});

test('legacy 상품은 새 필드를 잃지 않고 보수적인 migration 메타데이터를 얻는다', () => {
  const migrated = normalizeCatalog([product()]).products[0];
  assert.equal(migrated.detailSource, 'legacy');
  assert.equal(migrated.detailReason, 'legacy-state-migration');
  assert.equal(migrated.cardParseComplete, false);
  assert.deepEqual(migrated.visibleVariants, migrated.characters);
  assert.deepEqual(migrated.fullVariants, migrated.characters);
});

test('필수 메타데이터가 누락된 catalog는 저장 전에 거부되어 기존 state를 유지한다', async () => {
  const cfg = await config();
  const previous = { marker: 'keep' };
  await fs.writeFile(cfg.stateFile, JSON.stringify(previous));
  await assert.rejects(saveStateWithLog(cfg.stateFile, { catalog: { products: [
    { url: product().url, name: '상품 A', price: '1원', status: 'for_sale', characters: [] },
    { url: 'https://example.test/22222222222222222222222222222222', name: '상품 B', price: '2원', status: 'for_sale', characters: [] }
  ] } }), /metadata validation failed/);
  assert.deepEqual(JSON.parse(await fs.readFile(cfg.stateFile, 'utf8')), previous);
});
