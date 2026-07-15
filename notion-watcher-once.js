'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_NTFY_SERVER_URL = 'https://ntfy.sh';
const DEFAULT_STATE_FILE = './notion-watcher-state.json';
const DEFAULT_LOCK_FILE = './notion-watcher.lock';
const DEFAULT_MIN_TEXT_LENGTH = 50;
const DEFAULT_MAX_TEXT_CHANGE_RATIO = 0.7;
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
const DEFAULT_PAGE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_DOMCONTENTLOADED_TIMEOUT_MS = 15 * 1000;
const DEFAULT_RENDER_WAIT_MS = 8 * 1000;
const DEFAULT_COLLECTION_WAIT_MS = 10 * 1000;
const DEFAULT_EXTRA_WAIT_MS = 1500;

const FALLBACK_CHROME_VERSION = '149.0.0.0';

const COMMON_UI_PATTERNS = [
  /^notion$/i,
  /^search$/i,
  /^share$/i,
  /^updates?$/i,
  /^comments?$/i,
  /^sign in$/i,
  /^sign up$/i,
  /^log in$/i,
  /^continue with google$/i,
  /^continue with apple$/i,
  /^get notion free$/i,
  /^try notion free$/i,
  /^cookie/i,
  /^accept all$/i,
  /^reject all$/i,
  /^loading[.\s]*$/i,
  /^open in notion$/i,
  /^made with notion$/i,
  /^help$/i
];

const ERROR_PAGE_PATTERNS = [
  /log in to view/i,
  /sign in to view/i,
  /this page is private/i,
  /you do not have access/i,
  /page not found/i,
  /something went wrong/i,
  /notion is unavailable/i
];

function log(level, message) {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
}

function resolveConfig(env = process.env) {
  const missing = [];
  if (!env.NOTION_PAGE_URL) missing.push('NOTION_PAGE_URL');
  if (!env.NTFY_TOPIC) missing.push('NTFY_TOPIC');

  if (missing.length > 0) {
    throw new Error(`필수 환경변수가 누락되었습니다: ${missing.join(', ')}`);
  }

  const minTextLength = Number.parseInt(env.MIN_TEXT_LENGTH || `${DEFAULT_MIN_TEXT_LENGTH}`, 10);
  const maxTextChangeRatio = Number.parseFloat(env.MAX_TEXT_CHANGE_RATIO || `${DEFAULT_MAX_TEXT_CHANGE_RATIO}`);
  const staleLockMs = Number.parseInt(env.STALE_LOCK_MS || `${DEFAULT_STALE_LOCK_MS}`, 10);
  const pageTimeoutMs = parsePositiveIntegerEnv(env, 'PAGE_TIMEOUT_MS', DEFAULT_PAGE_TIMEOUT_MS);
  const domcontentloadedTimeoutMs = parsePositiveIntegerEnv(
    env,
    'DOMCONTENTLOADED_TIMEOUT_MS',
    DEFAULT_DOMCONTENTLOADED_TIMEOUT_MS
  );
  const renderWaitMs = parsePositiveIntegerEnv(env, 'RENDER_WAIT_MS', DEFAULT_RENDER_WAIT_MS);
  const collectionWaitMs = parsePositiveIntegerEnv(env, 'COLLECTION_WAIT_MS', DEFAULT_COLLECTION_WAIT_MS);
  const extraWaitMs = parsePositiveIntegerEnv(env, 'EXTRA_WAIT_MS', DEFAULT_EXTRA_WAIT_MS);

  if (!Number.isFinite(minTextLength) || minTextLength < 1) {
    throw new Error('MIN_TEXT_LENGTH는 1 이상의 숫자여야 합니다.');
  }
  if (!Number.isFinite(maxTextChangeRatio) || maxTextChangeRatio <= 0 || maxTextChangeRatio >= 1) {
    throw new Error('MAX_TEXT_CHANGE_RATIO는 0보다 크고 1보다 작은 숫자여야 합니다.');
  }
  if (!Number.isFinite(staleLockMs) || staleLockMs < 1) {
    throw new Error('STALE_LOCK_MS는 1 이상의 숫자여야 합니다.');
  }

  return {
    notionPageUrl: env.NOTION_PAGE_URL,
    ntfyServerUrl: (env.NTFY_SERVER_URL || DEFAULT_NTFY_SERVER_URL).replace(/\/+$/, ''),
    ntfyTopic: env.NTFY_TOPIC,
    stateFile: env.STATE_FILE || DEFAULT_STATE_FILE,
    lockFile: env.LOCK_FILE || DEFAULT_LOCK_FILE,
    minTextLength,
    maxTextChangeRatio,
    staleLockMs,
    pageTimeoutMs,
    domcontentloadedTimeoutMs,
    renderWaitMs,
    collectionWaitMs,
    extraWaitMs
  };
}

function parsePositiveIntegerEnv(env, name, defaultValue) {
  const value = Number.parseInt(env[name] || `${defaultValue}`, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name}는 1 이상의 숫자여야 합니다.`);
  }
  return value;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function acquireLock(lockFile, staleLockMs = DEFAULT_STALE_LOCK_MS) {
  const absoluteLockFile = path.resolve(lockFile);
  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString()
  };

  try {
    await fs.writeFile(absoluteLockFile, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    return { acquired: true, lockFile: absoluteLockFile };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const stale = await isLockStaleOrInvalid(absoluteLockFile, staleLockMs);
  if (!stale) {
    return { acquired: false, lockFile: absoluteLockFile };
  }

  await removeFileIfExists(absoluteLockFile);
  log('INFO', '오래된 잠금 파일을 제거했습니다.');

  try {
    await fs.writeFile(absoluteLockFile, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    return { acquired: true, lockFile: absoluteLockFile };
  } catch (error) {
    if (error.code === 'EEXIST') {
      return { acquired: false, lockFile: absoluteLockFile };
    }
    throw error;
  }
}

async function isLockStaleOrInvalid(lockFile, staleLockMs) {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(lockFile, 'utf8'), fs.stat(lockFile)]);
    try {
      const parsed = JSON.parse(raw);
      const startedAt = Date.parse(parsed.startedAt);
      if (!Number.isFinite(startedAt)) return true;
      return Date.now() - startedAt >= staleLockMs;
    } catch {
      return Date.now() - stat.mtimeMs >= staleLockMs;
    }
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function releaseLock(lockFile) {
  await removeFileIfExists(lockFile);
}

async function readState(stateFile) {
  try {
    const raw = await fs.readFile(path.resolve(stateFile), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`상태 파일 읽기에 실패했습니다: ${error.message}`);
  }
}

async function saveStateAtomic(stateFile, state) {
  const absoluteStateFile = path.resolve(stateFile);
  const directory = path.dirname(absoluteStateFile);
  const tempFile = `${absoluteStateFile}.tmp`;
  const data = `${JSON.stringify(state, null, 2)}\n`;

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(tempFile, data, 'utf8');
  await fs.rename(tempFile, absoluteStateFile);
}

async function fetchNotionPageText(notionPageUrl, config = {}) {
  const snapshot = await fetchNotionPageSnapshot(notionPageUrl, config);
  return snapshot.text;
}

async function fetchNotionPageSnapshot(notionPageUrl, config = {}) {
  let browser;
  const pageTimeoutMs = config.pageTimeoutMs || DEFAULT_PAGE_TIMEOUT_MS;
  const domcontentloadedTimeoutMs = config.domcontentloadedTimeoutMs || DEFAULT_DOMCONTENTLOADED_TIMEOUT_MS;
  const renderWaitMs = config.renderWaitMs || DEFAULT_RENDER_WAIT_MS;
  const collectionWaitMs = config.collectionWaitMs || DEFAULT_COLLECTION_WAIT_MS;
  const extraWaitMs = config.extraWaitMs || DEFAULT_EXTRA_WAIT_MS;

  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const chromeVersion = browser.version() || FALLBACK_CHROME_VERSION;
    const context = await browser.newContext({
      userAgent: createDesktopUserAgent(chromeVersion),
      viewport: { width: 1365, height: 900 },
      locale: 'ko-KR',
      extraHTTPHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(pageTimeoutMs);

    log('INFO', '페이지 접속을 시작합니다.');
    await page.goto(notionPageUrl, {
      waitUntil: 'commit',
      timeout: pageTimeoutMs
    });

    await page.waitForLoadState('domcontentloaded', {
      timeout: domcontentloadedTimeoutMs
    }).catch(() => null);

    await Promise.race([
      page.waitForSelector('[data-block-id], .notion-page-content, main, article', {
        state: 'attached',
        timeout: renderWaitMs
      }).catch(() => null),
      page.waitForTimeout(renderWaitMs)
    ]);

    await page.waitForSelector('.notion-collection-item', {
      state: 'attached',
      timeout: collectionWaitMs
    }).catch(() => null);

    await page.waitForTimeout(extraWaitMs);

    const snapshot = await extractPageSnapshot(page);
    const title = await page.title().catch(() => '');
    assertNotionContentLooksUsable(`${title}\n${snapshot.text}`);
    return snapshot;
  } catch (error) {
    throw new Error(`페이지 조회에 실패했습니다: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

function createDesktopUserAgent(chromeVersion) {
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  );
}

async function extractPageSnapshot(page) {
  return page.evaluate(() => {
    const parseCollectionItemText = (text) => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      const matched = normalized.match(/^(.*?)\s+(\d{1,3}(?:,\d{3})*원)\s+(.+?\(FOR SALE\))(?:\s+(.*))?$/);
      if (!matched) return normalized;

      const [, name, price, status, rest = ''] = matched;
      const options = [];
      const optionPattern = /([^()]+?)\s*\((판매 중|품절|SOLD OUT|FOR SALE)\)/g;
      let optionMatch;

      while ((optionMatch = optionPattern.exec(rest)) !== null) {
        const option = `${optionMatch[1].trim()} (${optionMatch[2]})`;
        options.push(option);
      }

      const note = rest
        .replace(optionPattern, '')
        .replace(/\s+/g, ' ')
        .trim();

      return [name.trim(), price.trim(), status.trim(), options.join(', '), note]
        .map((part) => part.replace(/\s+/g, ' ').trim())
        .join(' | ');
    };

    const collectionItems = [...document.querySelectorAll('.notion-collection-item')]
      .map((element) => (element.innerText || element.textContent || '').trim())
      .filter(Boolean)
      .map(parseCollectionItemText);

    const hiddenSelectors = [
      'nav',
      'aside',
      'header',
      'footer',
      '[role="dialog"]',
      '[aria-label*="cookie" i]',
      '[class*="cookie" i]',
      '[class*="sidebar" i]',
      '[class*="topbar" i]'
    ];

    const cloneAndClean = (node) => {
      const cloned = node.cloneNode(true);
      hiddenSelectors.forEach((selector) => {
        cloned.querySelectorAll(selector).forEach((element) => element.remove());
      });
      return cloned.innerText || cloned.textContent || '';
    };

    const candidates = [
      ...document.querySelectorAll('.notion-page-content'),
      ...document.querySelectorAll('[data-block-id]'),
      ...document.querySelectorAll('article'),
      ...document.querySelectorAll('main')
    ];

    const scored = candidates
      .map((element) => ({ element, text: cloneAndClean(element).trim() }))
      .filter((item) => item.text.length > 0)
      .sort((a, b) => b.text.length - a.text.length);

    const text = scored.length > 0 ? scored[0].text : cloneAndClean(document.body).trim();

    const updateText = [...document.querySelectorAll('.notion-quote-block')]
      .map((element) => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim())
      .find((value) => /업데이트|Update/i.test(value));
    const tableText = [
      updateText || '',
      collectionItems.length > 0 ? '상품명 | 가격 | 상태 | 옵션/세부 | 비고' : '',
      ...collectionItems
    ].filter(Boolean).join('\n');

    return {
      text,
      tableText
    };
  });
}

async function extractVisiblePageText(page) {
  const snapshot = await extractPageSnapshot(page);
  return snapshot.text;
}

function assertNotionContentLooksUsable(text) {
  if (ERROR_PAGE_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error('Notion 로그인 페이지 또는 오류 페이지로 판단되어 본문으로 처리하지 않습니다.');
  }
}

function normalizeText(text) {
  if (typeof text !== 'string') return '';

  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .filter((line) => line.length > 0)
    .filter((line) => !COMMON_UI_PATTERNS.some((pattern) => pattern.test(line)));

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function createHash(normalizedText) {
  return crypto.createHash('sha256').update(normalizedText, 'utf8').digest('hex');
}

function formatKstDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second} KST`;
}

function createTableDiff(previousTableText, currentTableText) {
  const previousLines = normalizeText(previousTableText || '').split('\n').filter(Boolean);
  const currentLines = normalizeText(currentTableText || '').split('\n').filter(Boolean);
  const previousSet = new Set(previousLines);
  const currentSet = new Set(currentLines);
  const added = currentLines.filter((line) => !previousSet.has(line));
  const removed = previousLines.filter((line) => !currentSet.has(line));

  if (previousLines.length === 0 || currentLines.length === 0) {
    return '상품 표를 비교할 수 없습니다.';
  }
  if (added.length === 0 && removed.length === 0) {
    return '상품 표 기준 변경점은 없습니다.';
  }

  const lines = [];
  if (added.length > 0) {
    lines.push('[추가/변경]');
    lines.push(...added.slice(0, 12).map((line) => `+ ${line}`));
  }
  if (removed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('[삭제/이전]');
    lines.push(...removed.slice(0, 12).map((line) => `- ${line}`));
  }
  if (added.length + removed.length > 24) {
    lines.push('');
    lines.push(`표시하지 않은 변경 줄: ${added.length + removed.length - 24}개`);
  }
  return lines.join('\n');
}

function getPreviousTableText(previousState) {
  if (!previousState) return '';
  if (typeof previousState.tableText === 'string') return previousState.tableText;
  if (typeof previousState.text === 'string' && previousState.text.includes('상품명 | 가격 | 상태 | 옵션/세부 | 비고')) {
    return previousState.text;
  }
  return '';
}

function isSuspiciousTextSizeChange(previousText, currentText, maxTextChangeRatio = DEFAULT_MAX_TEXT_CHANGE_RATIO) {
  if (!previousText || !currentText) return false;
  const previousLength = previousText.length;
  const currentLength = currentText.length;
  if (previousLength < DEFAULT_MIN_TEXT_LENGTH || currentLength < DEFAULT_MIN_TEXT_LENGTH) return false;
  const larger = Math.max(previousLength, currentLength);
  const smaller = Math.min(previousLength, currentLength);
  return (larger - smaller) / larger > maxTextChangeRatio;
}

async function sendNtfyNotification(config, checkedAt, previousTextLength, currentTextLength, tableDiff = '') {
  const url = `${config.ntfyServerUrl}/${encodeURIComponent(config.ntfyTopic)}`;
  const checkedAtText = formatKstDateTime(checkedAt);
  const body = [
    '감시 중인 Notion 페이지가 업데이트되었습니다.',
    '',
    `확인 시각: ${checkedAtText}`,
    `이전 본문 길이: ${previousTextLength}자`,
    `현재 본문 길이: ${currentTextLength}자`,
    '',
    '상품 표 변경점:',
    tableDiff || '상품 표를 추출하지 못했습니다.'
  ].join('\n');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Title: encodeHeaderValue('Notion 페이지 업데이트'),
      Priority: 'high',
      Tags: 'memo,eyes',
      Click: config.notionPageUrl,
      'Content-Type': 'text/plain; charset=utf-8'
    },
    body
  });

  if (!response.ok) {
    let responseText = '';
    try {
      responseText = await response.text();
    } catch {
      responseText = '';
    }
    const detail = responseText ? ` 응답: ${responseText.slice(0, 500)}` : '';
    throw new Error(`ntfy 응답 상태 ${response.status}.${detail}`);
  }
}

function encodeHeaderValue(value) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

async function runOnce(options = {}) {
  const deps = {
    fetchPageSnapshot: fetchNotionPageSnapshot,
    fetchPageText: fetchNotionPageText,
    sendNotification: sendNtfyNotification,
    now: () => new Date(),
    ...options.deps
  };
  if (options.deps && options.deps.fetchPageText && !options.deps.fetchPageSnapshot) {
    deps.fetchPageSnapshot = null;
  }

  let config;
  let lock;

  try {
    config = options.config || resolveConfig();
    log('INFO', 'Notion 페이지 확인을 시작합니다.');

    lock = await acquireLock(config.lockFile, config.staleLockMs);
    if (!lock.acquired) {
      log('INFO', '이전 실행이 아직 진행 중이므로 이번 실행을 건너뜁니다.');
      return 0;
    }
    log('INFO', '잠금을 획득했습니다.');

    let snapshot;
    try {
      if (deps.fetchPageSnapshot) {
        snapshot = await deps.fetchPageSnapshot(config.notionPageUrl, config);
      } else {
        snapshot = { text: await deps.fetchPageText(config.notionPageUrl, config), tableText: '' };
      }
    } catch (error) {
      log('ERROR', '페이지 접근 실패');
      throw error;
    }

    const normalizedText = normalizeText(snapshot.text);
    const normalizedTableText = normalizeText(snapshot.tableText || '');
    if (normalizedText.length < config.minTextLength) {
      log('ERROR', '추출된 페이지 본문이 너무 짧아 정상적인 페이지로 판단할 수 없습니다.');
      throw new Error('추출된 페이지 본문이 너무 짧아 정상적인 페이지로 판단할 수 없습니다.');
    }

    log('INFO', '본문 추출에 성공했습니다.');
    const hash = createHash(normalizedText);
    const checkedAt = deps.now().toISOString();

    let previousState;
    try {
      previousState = await readState(config.stateFile);
    } catch (error) {
      log('ERROR', '상태 파일 읽기에 실패했습니다.');
      throw error;
    }

    if (!previousState) {
      await saveStateWithLog(config.stateFile, {
        hash,
        text: normalizedText,
        tableText: normalizedTableText,
        checkedAt,
        changedAt: null
      });
      log('INFO', '최초 상태를 저장했습니다.');
      return 0;
    }

    if (isSuspiciousTextSizeChange(previousState.text || '', normalizedText, config.maxTextChangeRatio)) {
      log('ERROR', '추출된 페이지 본문 길이 변화가 비정상적으로 커서 정상적인 페이지로 판단할 수 없습니다.');
      throw new Error('추출된 페이지 본문 길이 변화가 비정상적으로 커서 정상적인 페이지로 판단할 수 없습니다.');
    }

    if (previousState.hash === hash) {
      await saveStateWithLog(config.stateFile, {
        ...previousState,
        hash,
        text: normalizedText,
        tableText: normalizedTableText,
        checkedAt,
        changedAt: previousState.changedAt || null
      });
      log('INFO', '변경 사항이 없습니다.');
      return 0;
    }

    log('INFO', '페이지 변경을 감지했습니다.');
    const tableDiff = createTableDiff(getPreviousTableText(previousState), normalizedTableText);
    try {
      await deps.sendNotification(config, checkedAt, (previousState.text || '').length, normalizedText.length, tableDiff);
      log('INFO', 'ntfy 알림을 전송했습니다.');
    } catch (error) {
      log('ERROR', 'ntfy 알림 전송에 실패했습니다.');
      throw error;
    }

    await saveStateWithLog(config.stateFile, {
      hash,
      text: normalizedText,
      tableText: normalizedTableText,
      checkedAt,
      changedAt: checkedAt
    });
    log('INFO', '새로운 상태를 저장했습니다.');
    return 0;
  } catch (error) {
    if (/상태 파일/.test(error.message)) {
      log('ERROR', error.message);
    } else if (/ntfy/.test(error.message)) {
      log('ERROR', error.message);
    } else if (/필수 환경변수|MIN_TEXT_LENGTH|MAX_TEXT_CHANGE_RATIO|STALE_LOCK_MS|TIMEOUT_MS|WAIT_MS/.test(error.message)) {
      log('ERROR', error.message);
    } else if (/페이지 조회|본문/.test(error.message)) {
      log('ERROR', error.message);
    } else {
      log('ERROR', `예상하지 못한 오류: ${error.message}`);
    }
    return 1;
  } finally {
    if (lock && lock.acquired) {
      await releaseLock(lock.lockFile).catch((error) => {
        log('ERROR', `잠금 파일 제거에 실패했습니다: ${error.message}`);
      });
    }
  }
}

async function saveStateWithLog(stateFile, state) {
  try {
    await saveStateAtomic(stateFile, state);
    log('INFO', '상태 파일 저장에 성공했습니다.');
  } catch (error) {
    log('ERROR', '상태 파일 저장에 실패했습니다.');
    throw new Error(`상태 파일 저장에 실패했습니다: ${error.message}`);
  }
}

if (require.main === module) {
  runOnce().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  resolveConfig,
  acquireLock,
  releaseLock,
  readState,
  saveStateAtomic,
  fetchNotionPageText,
  fetchNotionPageSnapshot,
  normalizeText,
  createHash,
  formatKstDateTime,
  createTableDiff,
  isSuspiciousTextSizeChange,
  sendNtfyNotification,
  runOnce,
  isLockStaleOrInvalid,
  createDesktopUserAgent,
  DEFAULT_MIN_TEXT_LENGTH,
  DEFAULT_MAX_TEXT_CHANGE_RATIO,
  DEFAULT_STALE_LOCK_MS,
  DEFAULT_PAGE_TIMEOUT_MS,
  DEFAULT_DOMCONTENTLOADED_TIMEOUT_MS,
  DEFAULT_RENDER_WAIT_MS,
  DEFAULT_COLLECTION_WAIT_MS,
  DEFAULT_EXTRA_WAIT_MS
};
