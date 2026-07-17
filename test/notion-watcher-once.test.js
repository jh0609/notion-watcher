'use strict';

const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { normalizeCatalog, serializeCatalog, diffCatalog, runOnce } = require('../notion-watcher-once');

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
  const current = normalizeCatalog([product({ status: '품절' })]);
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
