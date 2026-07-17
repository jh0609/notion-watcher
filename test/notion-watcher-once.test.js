'use strict';

const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  normalizeCatalog, serializeCatalog, diffCatalog, evaluateProductUrlCandidate,
  canonicalizeNotionProductUrl, resolveCardProductUrl, resolveDebugConfig, waitForProductCards, runOnce
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
