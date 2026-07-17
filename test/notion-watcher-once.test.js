'use strict';

const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createHash, runOnce } = require('../notion-watcher-once');

async function makeTempConfig() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notion-watcher-test-'));
  return {
    notionPageUrl: 'https://example.test/private-not-logged',
    ntfyServerUrl: 'https://ntfy.example.test',
    ntfyTopic: 'public-topic',
    ntfyToken: 'test-token',
    operatorNtfyTopic: 'operator-topic',
    stateFile: path.join(directory, 'state.json'),
    operationStateFile: path.join(directory, 'operation-state.json'),
    lockFile: path.join(directory, 'watcher.lock'),
    minTextLength: 20,
    maxTextChangeRatio: 0.7,
    staleLockMs: 60_000,
    pageLoadTimeoutMs: 60_000,
    domcontentloadedTimeoutMs: 1,
    renderWaitMs: 1,
    collectionWaitMs: 1,
    extraWaitMs: 1,
    pageFetchMaxAttempts: 3,
    pageFetchRetryDelaysMs: [10_000, 30_000],
    directory
  };
}

function makeSnapshot(text) {
  return {
    text,
    updateText: '',
    tableText: text,
    title: 'Public Notion Page',
    url: 'https://example.test/page',
    renderedCandidateCount: 1
  };
}

test('페이지 조회 실패는 같은 실행 안에서 최대 3회 재시도하고 공개 알림을 보내지 않는다', async () => {
  const config = await makeTempConfig();
  let attempts = 0;
  const delays = [];
  let publicNotifications = 0;

  const exitCode = await runOnce({
    config,
    deps: {
      fetchPageSnapshot: async () => {
        attempts += 1;
        throw new Error('page.goto: Timeout 60000ms exceeded');
      },
      sleep: async (ms) => delays.push(ms),
      sendNotification: async () => {
        publicNotifications += 1;
      },
      sendOperatorNotification: async () => true,
      now: () => new Date('2026-07-17T00:00:00.000Z')
    }
  });

  assert.equal(exitCode, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10_000, 30_000]);
  assert.equal(publicNotifications, 0);

  const operationState = JSON.parse(await fs.readFile(config.operationStateFile, 'utf8'));
  assert.equal(operationState.consecutivePageFetchFailures, 1);
  assert.equal(operationState.pageFetchAlertSent, false);
});

test('재시도 후 정상 본문 추출에 성공하면 일반 상태 저장 흐름으로 진행한다', async () => {
  const config = await makeTempConfig();
  let attempts = 0;
  const delays = [];

  const exitCode = await runOnce({
    config,
    deps: {
      fetchPageSnapshot: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network error: ECONNRESET');
        return makeSnapshot('정상 상품 본문입니다.\n상품 A 10,000원 FOR SALE\n충분히 긴 본문입니다.');
      },
      sleep: async (ms) => delays.push(ms),
      sendNotification: async () => {
        throw new Error('최초 실행에서는 공개 알림이 없어야 합니다.');
      },
      sendOperatorNotification: async () => true,
      now: () => new Date('2026-07-17T00:00:00.000Z')
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [10_000]);

  const state = JSON.parse(await fs.readFile(config.stateFile, 'utf8'));
  assert.match(state.text, /정상 상품 본문/);
});

test('전체 재시도 실패 시 기존 상태 파일을 유지하고 두 번째 연속 실패에만 운영자 알림을 보낸다', async () => {
  const config = await makeTempConfig();
  const previousState = {
    hash: 'previous-hash',
    changeKey: 'hash:previous-hash',
    changeKeyType: 'hash',
    updateText: '',
    text: '기존 정상 본문입니다. 이 내용은 실패 후에도 바뀌면 안 됩니다.',
    tableText: '기존 표',
    checkedAt: '2026-07-16T00:00:00.000Z',
    changedAt: null
  };
  await fs.writeFile(config.stateFile, `${JSON.stringify(previousState, null, 2)}\n`, 'utf8');
  await fs.writeFile(config.operationStateFile, `${JSON.stringify({
    consecutivePageFetchFailures: 1,
    pageFetchAlertSent: false,
    lastFailureReason: 'navigation timeout',
    updatedAt: '2026-07-16T00:00:00.000Z'
  }, null, 2)}\n`, 'utf8');

  let publicNotifications = 0;
  let operatorNotifications = 0;

  const exitCode = await runOnce({
    config,
    deps: {
      fetchPageSnapshot: async () => makeSnapshot('로그인'),
      sleep: async () => undefined,
      sendNotification: async () => {
        publicNotifications += 1;
      },
      sendOperatorNotification: async () => {
        operatorNotifications += 1;
        return true;
      },
      now: () => new Date('2026-07-17T00:00:00.000Z')
    }
  });

  assert.equal(exitCode, 1);
  assert.equal(publicNotifications, 0);
  assert.equal(operatorNotifications, 1);

  const state = JSON.parse(await fs.readFile(config.stateFile, 'utf8'));
  assert.deepEqual(state, previousState);

  const operationState = JSON.parse(await fs.readFile(config.operationStateFile, 'utf8'));
  assert.equal(operationState.consecutivePageFetchFailures, 2);
  assert.equal(operationState.pageFetchAlertSent, true);
});

test('장애 알림 후 정상 조회에 성공하면 연속 실패 횟수를 초기화하고 복구 알림을 보낸다', async () => {
  const config = await makeTempConfig();
  const text = '기존 정상 본문입니다. 장애 이후 정상 조회에 성공한 본문입니다.';
  const hash = createHash(text);
  await fs.writeFile(config.stateFile, `${JSON.stringify({
    hash,
    changeKey: `hash:${hash}`,
    changeKeyType: 'hash',
    updateText: '',
    text,
    tableText: text,
    checkedAt: '2026-07-16T00:00:00.000Z',
    changedAt: null
  }, null, 2)}\n`, 'utf8');
  await fs.writeFile(config.operationStateFile, `${JSON.stringify({
    consecutivePageFetchFailures: 2,
    pageFetchAlertSent: true,
    lastFailureReason: 'navigation timeout',
    updatedAt: '2026-07-16T00:00:00.000Z'
  }, null, 2)}\n`, 'utf8');

  let operatorNotifications = 0;

  const exitCode = await runOnce({
    config,
    deps: {
      fetchPageSnapshot: async () => makeSnapshot(text),
      sleep: async () => undefined,
      sendNotification: async () => {
        throw new Error('변경이 없으면 공개 알림이 없어야 합니다.');
      },
      sendOperatorNotification: async () => {
        operatorNotifications += 1;
        return true;
      },
      now: () => new Date('2026-07-17T00:00:00.000Z')
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(operatorNotifications, 1);

  const operationState = JSON.parse(await fs.readFile(config.operationStateFile, 'utf8'));
  assert.equal(operationState.consecutivePageFetchFailures, 0);
  assert.equal(operationState.pageFetchAlertSent, false);
});
