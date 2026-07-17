'use strict';

const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  normalizeCatalog, serializeCatalog, diffCatalog, evaluateProductUrlCandidate,
  canonicalizeNotionProductUrl, resolveCardProductUrl, resolveDebugConfig, waitForProductCards,
  attachPageDiagnostics, parseProductText, shouldAbortDetailResource, configureDetailResourcePolicy,
  processDetailPage, createDetailPageSlot, runOnce
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
  url: 'https://example.test/p/1', name: '상품 A', price: '10,000 원', status: 'FOR SALE',
  characters: [{ name: '캐릭터 B', status: '품절' }, { name: '캐릭터 A', status: '판매 중' }], ...overrides
});

test('debug:cards 스크린샷 저장은 기본적으로 비활성화되고 명시적으로만 활성화된다', () => {
  const base = { NOTION_PAGE_URL: 'https://shop.notion.site/catalog' };
  assert.equal(resolveDebugConfig(base).debugSaveScreenshots, false);
  assert.equal(resolveDebugConfig({ ...base, DEBUG_SAVE_SCREENSHOTS: 'true' }).debugSaveScreenshots, true);
  assert.equal(resolveDebugConfig({ ...base, DEBUG_SAVE_SCREENSHOTS: 'false' }).debugSaveScreenshots, false);
});

test('상품과 캐릭터 DOM 순서가 달라도 직렬화 JSON과 해시는 안정적이다', () => {
  const a = normalizeCatalog([product(), product({ url: 'https://example.test/p/2', name: '상품 B' })]);
  const b = normalizeCatalog([
    product({ url: 'https://example.test/p/2', name: '상품 B', characters: [...product().characters].reverse() }),
    product({ characters: [...product().characters].reverse() })
  ]);
  assert.equal(serializeCatalog(a), serializeCatalog(b));
  assert.deepEqual(a.products[0].characters.map((item) => item.name), ['캐릭터 A', '캐릭터 B']);
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

test('운영 페이지 진단은 노이즈를 제외하고 중요한 오류를 메모리에 보관한다', () => {
  const handlers = {};
  const diagnostics = attachPageDiagnostics({ on: (event, handler) => { handlers[event] = handler; } }, 'test');
  handlers.console({ type: () => 'error', text: () => 'Statsig request failed' });
  handlers.response({ status: () => 401, url: () => 'https://www.notion.so/api/v3/getSubscriptionBanner' });
  handlers.requestfailed({
    url: () => 'https://www.notion.so/api/v3/loadPageChunk',
    failure: () => ({ errorText: 'net::ERR_FAILED' })
  });
  handlers.pageerror(new Error('important Notion renderer failure'));
  assert.equal(diagnostics.entries.length, 2);
  assert.match(diagnostics.entries[0].message, /loadPageChunk/);
  assert.match(diagnostics.entries[1].message, /renderer failure/);
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

test('10초 ready timeout은 세 번째 인수로 전달되어 약 10초 안에 반환된다', { timeout: 15_000 }, async () => {
  let receivedArgument;
  let receivedOptions;
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    isClosed: () => false,
    close: async () => undefined,
    goto: async () => undefined,
    waitForFunction: async (_fn, argument, options) => {
      receivedArgument = argument;
      receivedOptions = options;
      await new Promise((resolve) => setTimeout(resolve, options.timeout));
      const error = new Error(`Timeout ${options.timeout}ms exceeded`);
      error.name = 'TimeoutError';
      throw error;
    },
    evaluate: async () => ({ bodyTextLength: 20, priceMatched: false, statusMatched: false })
  };
  const startedAt = Date.now();
  await assert.rejects(processDetailPage(page, 'https://example.test/5273f4a9f62683e5b87581c092c3aff2', {
    detailNavigationTimeoutMs: 20_000,
    detailReadyTimeoutMs: 10_000,
    detailHardTimeoutMs: 35_000
  }, 'ready-timeout-test'), /Timeout 10000ms/);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(receivedArgument.expectedPageId, '5273f4a9f62683e5b87581c092c3aff2');
  assert.deepEqual(receivedOptions, { timeout: 10_000 });
  assert.ok(elapsedMs >= 9_500 && elapsedMs <= 13_000, `elapsed=${elapsedMs}ms`);
});

test('가격과 상태가 없어도 UUID, readyState, 본문 20자로 ready 조건을 통과한다', async () => {
  let readyFunctionSource = '';
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    goto: async () => undefined,
    waitForFunction: async (fn, argument, options) => {
      readyFunctionSource = fn.toString();
      assert.equal(argument.expectedPageId, '5273f4a9f62683e5b87581c092c3aff2');
      assert.deepEqual(options, { timeout: 10_000 });
    },
    evaluate: async () => ({
      title: '상품 A', text: '가격 상태 없이도 충분히 유의미한 상세 본문이 렌더링되어 있습니다.', rowTexts: []
    }),
    url: () => 'https://example.test/5273f4a9f62683e5b87581c092c3aff2',
    waitForTimeout: async () => undefined,
    isClosed: () => false,
    close: async () => undefined
  };
  await assert.rejects(processDetailPage(page, page.url(), {
    detailNavigationTimeoutMs: 20_000, detailReadyTimeoutMs: 10_000, detailHardTimeoutMs: 35_000
  }, 'ready-condition-test'), /product price not found/);
  assert.match(readyFunctionSource, /readyState !== 'loading'/);
  assert.match(readyFunctionSource, /length >= 20/);
  assert.doesNotMatch(readyFunctionSource, /판매|SOLD|원/);
});

test('parse 결과가 불완전하면 1초 대기 후 한 번 재파싱한다', async () => {
  let evaluateCalls = 0;
  const waits = [];
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    goto: async () => undefined,
    waitForFunction: async () => undefined,
    evaluate: async () => {
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

test('hard timeout은 page를 닫고 이전 attempt가 정착한 뒤 반환한다', async () => {
  let closed = false;
  let underlyingSettled = false;
  const page = {
    setDefaultNavigationTimeout: () => undefined,
    setDefaultTimeout: () => undefined,
    isClosed: () => closed,
    close: async () => { closed = true; },
    goto: async () => undefined,
    waitForFunction: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      underlyingSettled = true;
      throw new Error('late ready failure');
    }
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
    product({ url: 'https://example.test/p/2', name: '상품 B' })
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
