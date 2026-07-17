'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_STATE_FILE = './notion-watcher-state.json';
const DEFAULT_LOCK_FILE = './notion-watcher.lock';
const DEFAULT_OPERATION_STATE_FILE = './notion-watcher-operation-state.json';
const DEFAULT_MIN_TEXT_LENGTH = 50;
const DEFAULT_MAX_TEXT_CHANGE_RATIO = 0.7;
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
const DEFAULT_PAGE_LOAD_TIMEOUT_MS = 60 * 1000;
const DEFAULT_DOMCONTENTLOADED_TIMEOUT_MS = 15 * 1000;
const DEFAULT_RENDER_WAIT_MS = 8 * 1000;
const DEFAULT_COLLECTION_WAIT_MS = 10 * 1000;
const DEFAULT_EXTRA_WAIT_MS = 1500;
const DEFAULT_PAGE_FETCH_MAX_ATTEMPTS = 3;
const DEFAULT_PAGE_FETCH_RETRY_DELAYS_MS = [10 * 1000, 30 * 1000];
const OPERATOR_ALERT_FAILURE_THRESHOLD = 2;

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

const NETWORK_ERROR_PATTERNS = [
  /net::/i,
  /network/i,
  /dns/i,
  /socket/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /enotfound/i,
  /err_/i
];

function log(level, message) {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
}

function resolveConfig(env = process.env) {
  const missing = [];
  if (!env.NOTION_PAGE_URL) missing.push('NOTION_PAGE_URL');
  if (!env.NTFY_SERVER_URL) missing.push('NTFY_SERVER_URL');
  if (!env.NTFY_TOPIC) missing.push('NTFY_TOPIC');
  if (!env.NTFY_TOKEN) missing.push('NTFY_TOKEN');

  if (missing.length > 0) {
    throw new Error(`필수 환경변수가 누락되었습니다: ${missing.join(', ')}`);
  }

  const minTextLength = Number.parseInt(env.MIN_TEXT_LENGTH || `${DEFAULT_MIN_TEXT_LENGTH}`, 10);
  const maxTextChangeRatio = Number.parseFloat(env.MAX_TEXT_CHANGE_RATIO || `${DEFAULT_MAX_TEXT_CHANGE_RATIO}`);
  const staleLockMs = Number.parseInt(env.STALE_LOCK_MS || `${DEFAULT_STALE_LOCK_MS}`, 10);
  const pageLoadTimeoutMs = parsePositiveIntegerEnv(
    { PAGE_LOAD_TIMEOUT_MS: env.PAGE_LOAD_TIMEOUT_MS || env.PAGE_TIMEOUT_MS },
    'PAGE_LOAD_TIMEOUT_MS',
    DEFAULT_PAGE_LOAD_TIMEOUT_MS
  );
  const domcontentloadedTimeoutMs = parsePositiveIntegerEnv(
    env,
    'DOMCONTENTLOADED_TIMEOUT_MS',
    DEFAULT_DOMCONTENTLOADED_TIMEOUT_MS
  );
  const renderWaitMs = parsePositiveIntegerEnv(env, 'RENDER_WAIT_MS', DEFAULT_RENDER_WAIT_MS);
  const collectionWaitMs = parsePositiveIntegerEnv(env, 'COLLECTION_WAIT_MS', DEFAULT_COLLECTION_WAIT_MS);
  const extraWaitMs = parsePositiveIntegerEnv(env, 'EXTRA_WAIT_MS', DEFAULT_EXTRA_WAIT_MS);
  const pageFetchMaxAttempts = parsePositiveIntegerEnv(
    env,
    'PAGE_FETCH_MAX_ATTEMPTS',
    DEFAULT_PAGE_FETCH_MAX_ATTEMPTS
  );
  const pageFetchRetryDelaysMs = parseRetryDelaysEnv(
    env.PAGE_FETCH_RETRY_DELAYS_MS,
    DEFAULT_PAGE_FETCH_RETRY_DELAYS_MS
  );

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
    ntfyServerUrl: env.NTFY_SERVER_URL.replace(/\/+$/, ''),
    ntfyTopic: env.NTFY_TOPIC,
    ntfyToken: env.NTFY_TOKEN,
    operatorNtfyTopic: env.OPERATOR_NTFY_TOPIC || '',
    stateFile: env.STATE_FILE || DEFAULT_STATE_FILE,
    operationStateFile: env.OPERATION_STATE_FILE || DEFAULT_OPERATION_STATE_FILE,
    lockFile: env.LOCK_FILE || DEFAULT_LOCK_FILE,
    minTextLength,
    maxTextChangeRatio,
    staleLockMs,
    pageLoadTimeoutMs,
    pageTimeoutMs: pageLoadTimeoutMs,
    domcontentloadedTimeoutMs,
    renderWaitMs,
    collectionWaitMs,
    extraWaitMs,
    pageFetchMaxAttempts,
    pageFetchRetryDelaysMs
  };
}

function parsePositiveIntegerEnv(env, name, defaultValue) {
  const value = Number.parseInt(env[name] || `${defaultValue}`, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name}는 1 이상의 숫자여야 합니다.`);
  }
  return value;
}

function parseRetryDelaysEnv(value, defaultValue) {
  if (!value) return [...defaultValue];
  const delays = value.split(',').map((part) => Number.parseInt(part.trim(), 10));
  if (delays.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new Error('PAGE_FETCH_RETRY_DELAYS_MS는 0 이상의 숫자를 쉼표로 구분해야 합니다.');
  }
  return delays;
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
  const pageLoadTimeoutMs = config.pageLoadTimeoutMs || config.pageTimeoutMs || DEFAULT_PAGE_LOAD_TIMEOUT_MS;
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
    page.setDefaultTimeout(pageLoadTimeoutMs);

    log('INFO', '페이지 접속을 시작합니다.');
    await page.goto(notionPageUrl, {
      waitUntil: 'commit',
      timeout: pageLoadTimeoutMs
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
    const url = page.url();
    assertNotionContentLooksUsable({
      url,
      title,
      text: snapshot.text,
      renderedCandidateCount: snapshot.renderedCandidateCount
    });
    return { ...snapshot, title, url };
  } catch (error) {
    throw createPageFetchError(error);
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
      updateText: updateText || '',
      tableText,
      renderedCandidateCount: scored.length + collectionItems.length
    };
  });
}

async function extractVisiblePageText(page) {
  const snapshot = await extractPageSnapshot(page);
  return snapshot.text;
}

function assertNotionContentLooksUsable(snapshot) {
  const reason = getUnusablePageReason(snapshot);
  if (reason) {
    throw new PageFetchError(reason, 'login or error page suspected');
  }
}

function getUnusablePageReason(snapshot = {}) {
  const url = `${snapshot.url || ''}`.toLowerCase();
  const title = `${snapshot.title || ''}`.trim();
  const text = `${snapshot.text || ''}`;
  const combined = `${title}\n${text}`;
  const textLength = text.trim().length;
  const hasExplicitErrorPhrase = ERROR_PAGE_PATTERNS.some((pattern) => pattern.test(combined));
  const urlLooksLikeAuth = /\/(login|signup|sign-in|sign-up)(?:[/?#]|$)/i.test(url);
  const titleLooksLikeAuthOrError = /\b(log in|sign in|sign up|login|error|not found)\b/i.test(title);
  const titleLooksGeneric = /^notion$/i.test(title) || title.length === 0;
  const bodyLooksTooSmallForAuthPage = textLength < Math.max(DEFAULT_MIN_TEXT_LENGTH, 120);
  const renderedCandidateCount = Number.parseInt(snapshot.renderedCandidateCount || 0, 10);

  if (hasExplicitErrorPhrase) return 'login or error page suspected';
  if (urlLooksLikeAuth && (titleLooksLikeAuthOrError || bodyLooksTooSmallForAuthPage)) {
    return 'login or error page suspected';
  }
  if (titleLooksLikeAuthOrError && titleLooksGeneric && bodyLooksTooSmallForAuthPage) {
    return 'login or error page suspected';
  }
  if (renderedCandidateCount === 0 && textLength === 0) return 'body not rendered';
  return '';
}

class PageFetchError extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'PageFetchError';
    this.reason = reason;
    this.retryable = true;
  }
}

function createPageFetchError(error) {
  if (error instanceof PageFetchError) return error;
  const message = error && error.message ? error.message : `${error}`;
  if (/timeout/i.test(message)) {
    return new PageFetchError('navigation timeout');
  }
  if (NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return new PageFetchError('network error');
  }
  return new PageFetchError('page fetch failed', message);
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

function getChangeKey(hash, updateText) {
  const normalizedUpdateText = normalizeText(updateText || '');
  if (normalizedUpdateText) {
    return {
      changeKey: `update:${normalizedUpdateText}`,
      changeKeyType: 'updateText'
    };
  }
  return {
    changeKey: `hash:${hash}`,
    changeKeyType: 'hash'
  };
}

function extractUpdateTextFromText(text) {
  const normalized = normalizeText(text || '');
  const matched = normalized.match(/업데이트\s+Update\s*-\s*\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\s+\d{1,2}:\d{2}/i);
  return matched ? matched[0].replace(/\s+/g, ' ').trim() : '';
}

function getPreviousChangeKey(previousState) {
  if (!previousState) return '';
  if (previousState.changeKey) return previousState.changeKey;
  const previousUpdateText = previousState.updateText || extractUpdateTextFromText(previousState.text);
  if (previousUpdateText) return getChangeKey(previousState.hash || '', previousUpdateText).changeKey;
  return `hash:${previousState.hash}`;
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
      Authorization: `Bearer ${config.ntfyToken}`,
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
    const authHint = response.status === 401 || response.status === 403
      ? ' 인증 또는 ACL 설정을 확인하세요.'
      : '';
    const detail = responseText ? ` 응답: ${responseText.slice(0, 500)}` : '';
    throw new Error(`ntfy 응답 상태 ${response.status}.${authHint}${detail}`);
  }
}

async function sendOperatorNotification(config, title, body) {
  if (!config.operatorNtfyTopic) return false;
  const url = `${config.ntfyServerUrl}/${encodeURIComponent(config.operatorNtfyTopic)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Title: encodeHeaderValue(title),
      Authorization: `Bearer ${config.ntfyToken}`,
      Priority: 'high',
      Tags: 'warning',
      'Content-Type': 'text/plain; charset=utf-8'
    },
    body
  });

  if (!response.ok) {
    throw new Error(`operator ntfy 응답 상태 ${response.status}`);
  }
  return true;
}

function encodeHeaderValue(value) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

async function fetchPageSnapshotWithRetries(deps, config, previousState) {
  const maxAttempts = config.pageFetchMaxAttempts || DEFAULT_PAGE_FETCH_MAX_ATTEMPTS;
  let lastReason = 'page fetch failed';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const snapshot = deps.fetchPageSnapshot
        ? await deps.fetchPageSnapshot(config.notionPageUrl, config)
        : { text: await deps.fetchPageText(config.notionPageUrl, config), tableText: '', updateText: '' };
      validateFetchedSnapshot(snapshot, config, previousState);
      log('INFO', `페이지 조회 ${attempt}/${maxAttempts} 성공`);
      return { ok: true, snapshot };
    } catch (error) {
      const pageFetchError = createPageFetchError(error);
      lastReason = pageFetchError.reason;
      log('WARN', `페이지 조회 ${attempt}/${maxAttempts} 실패: ${lastReason}`);
      if (attempt >= maxAttempts) break;

      const delayMs = getRetryDelayMs(config.pageFetchRetryDelaysMs, attempt);
      if (delayMs > 0) {
        log('INFO', `${Math.round(delayMs / 1000)}초 후 다시 시도합니다.`);
        await deps.sleep(delayMs);
      }
    }
  }

  return { ok: false, reason: lastReason };
}

function validateFetchedSnapshot(snapshot, config, previousState) {
  const unusableReason = getUnusablePageReason(snapshot);
  if (unusableReason) throw new PageFetchError(unusableReason);

  const normalizedText = normalizeText(snapshot.text || '');
  if (normalizedText.length < config.minTextLength) {
    throw new PageFetchError('body below minimum length');
  }

  if (previousState && isSuspiciousTextSizeChange(previousState.text || '', normalizedText, config.maxTextChangeRatio)) {
    throw new PageFetchError('body length changed suspiciously');
  }
}

function getRetryDelayMs(delays, failedAttemptNumber) {
  if (!Array.isArray(delays) || delays.length === 0) return 0;
  return delays[Math.min(failedAttemptNumber - 1, delays.length - 1)] || 0;
}

async function readOperationState(operationStateFile) {
  const defaultState = {
    consecutivePageFetchFailures: 0,
    pageFetchAlertSent: false,
    lastFailureReason: '',
    updatedAt: null
  };
  try {
    const raw = await fs.readFile(path.resolve(operationStateFile), 'utf8');
    return { ...defaultState, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') return defaultState;
    throw new Error(`운영 상태 파일 읽기에 실패했습니다: ${error.message}`);
  }
}

async function saveOperationState(operationStateFile, state) {
  await saveStateAtomic(operationStateFile, state);
}

async function recordPageFetchFailure(config, deps, reason) {
  const operationState = await readOperationState(config.operationStateFile);
  const nextState = {
    ...operationState,
    consecutivePageFetchFailures: (operationState.consecutivePageFetchFailures || 0) + 1,
    lastFailureReason: reason,
    updatedAt: deps.now().toISOString()
  };

  if (
    nextState.consecutivePageFetchFailures >= OPERATOR_ALERT_FAILURE_THRESHOLD &&
    !operationState.pageFetchAlertSent &&
    config.operatorNtfyTopic
  ) {
    try {
      await deps.sendOperatorNotification(
        config,
        'Notion watcher 페이지 조회 실패',
        [
          'Notion watcher 페이지 조회가 두 번의 cron 실행에서 연속 실패했습니다.',
          `연속 실패 횟수: ${nextState.consecutivePageFetchFailures}`,
          `마지막 실패 이유: ${reason}`
        ].join('\n')
      );
      nextState.pageFetchAlertSent = true;
      log('INFO', '운영자 장애 알림을 전송했습니다.');
    } catch (error) {
      log('ERROR', `운영자 장애 알림 전송에 실패했습니다: ${error.message}`);
    }
  }

  await saveOperationState(config.operationStateFile, nextState);
}

async function recordPageFetchSuccess(config, deps) {
  const operationState = await readOperationState(config.operationStateFile);
  if ((operationState.consecutivePageFetchFailures || 0) === 0 && !operationState.pageFetchAlertSent) return;

  const nextState = {
    ...operationState,
    consecutivePageFetchFailures: 0,
    lastFailureReason: '',
    updatedAt: deps.now().toISOString()
  };

  if (operationState.pageFetchAlertSent && config.operatorNtfyTopic) {
    try {
      await deps.sendOperatorNotification(
        config,
        'Notion watcher 페이지 조회 복구',
        'Notion watcher 페이지 조회가 정상으로 복구되었습니다.'
      );
      log('INFO', '운영자 복구 알림을 전송했습니다.');
    } catch (error) {
      log('ERROR', `운영자 복구 알림 전송에 실패했습니다: ${error.message}`);
    }
  }

  nextState.pageFetchAlertSent = false;
  await saveOperationState(config.operationStateFile, nextState);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce(options = {}) {
  const deps = {
    fetchPageSnapshot: fetchNotionPageSnapshot,
    fetchPageText: fetchNotionPageText,
    sendNotification: sendNtfyNotification,
    sendOperatorNotification,
    sleep,
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

    let previousState;
    try {
      previousState = await readState(config.stateFile);
    } catch (error) {
      log('ERROR', '상태 파일 읽기에 실패했습니다.');
      throw error;
    }

    const fetchResult = await fetchPageSnapshotWithRetries(deps, config, previousState);
    if (!fetchResult.ok) {
      await recordPageFetchFailure(config, deps, fetchResult.reason);
      throw new PageFetchError(fetchResult.reason || 'page fetch failed');
    }

    await recordPageFetchSuccess(config, deps);

    const snapshot = fetchResult.snapshot;
    const normalizedText = normalizeText(snapshot.text);
    const normalizedTableText = normalizeText(snapshot.tableText || '');
    const normalizedUpdateText = normalizeText(snapshot.updateText || '');

    log('INFO', '본문 추출에 성공했습니다.');
    const hash = createHash(normalizedText);
    const { changeKey, changeKeyType } = getChangeKey(hash, normalizedUpdateText);
    const checkedAt = deps.now().toISOString();

    if (!previousState) {
      await saveStateWithLog(config.stateFile, {
        hash,
        changeKey,
        changeKeyType,
        updateText: normalizedUpdateText,
        text: normalizedText,
        tableText: normalizedTableText,
        checkedAt,
        changedAt: null
      });
      log('INFO', '최초 상태를 저장했습니다.');
      return 0;
    }

    const previousChangeKey = getPreviousChangeKey(previousState);
    if (previousChangeKey === changeKey) {
      await saveStateWithLog(config.stateFile, {
        ...previousState,
        hash,
        changeKey,
        changeKeyType,
        updateText: normalizedUpdateText,
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
      changeKey,
      changeKeyType,
      updateText: normalizedUpdateText,
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
    } else if (error instanceof PageFetchError || /페이지 조회|본문|navigation timeout|network error|body/.test(error.message)) {
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
  getChangeKey,
  getPreviousChangeKey,
  extractUpdateTextFromText,
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
  DEFAULT_PAGE_LOAD_TIMEOUT_MS,
  DEFAULT_PAGE_TIMEOUT_MS: DEFAULT_PAGE_LOAD_TIMEOUT_MS,
  DEFAULT_DOMCONTENTLOADED_TIMEOUT_MS,
  DEFAULT_RENDER_WAIT_MS,
  DEFAULT_COLLECTION_WAIT_MS,
  DEFAULT_EXTRA_WAIT_MS,
  DEFAULT_PAGE_FETCH_MAX_ATTEMPTS,
  DEFAULT_PAGE_FETCH_RETRY_DELAYS_MS
};
