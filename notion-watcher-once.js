'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_STATE_FILE = './notion-watcher-state.json';
const DEFAULT_LOCK_FILE = './notion-watcher.lock';
const DEFAULT_OPERATION_STATE_FILE = './notion-watcher-operation-state.json';
const DEFAULT_MIN_TEXT_LENGTH = 50;
const DEFAULT_SNAPSHOT_DIR = './snapshots';
const DEFAULT_DETAIL_CONCURRENCY = 2;
const DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS = 20 * 1000;
const DEFAULT_DETAIL_READY_TIMEOUT_MS = 10 * 1000;
const DEFAULT_DETAIL_HARD_TIMEOUT_MS = 35 * 1000;
const DEFAULT_DEBUG_DIR = './debug';
const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
const DEFAULT_PAGE_LOAD_TIMEOUT_MS = 60 * 1000;
const DEFAULT_DOMCONTENTLOADED_TIMEOUT_MS = 15 * 1000;
const DEFAULT_RENDER_WAIT_MS = 8 * 1000;
const DEFAULT_COLLECTION_WAIT_MS = 10 * 1000;
const DEFAULT_EXTRA_WAIT_MS = 1500;
const DEFAULT_PAGE_FETCH_MAX_ATTEMPTS = 3;
const DEFAULT_PAGE_FETCH_RETRY_DELAYS_MS = [10 * 1000, 30 * 1000];
const OPERATOR_ALERT_FAILURE_THRESHOLD = 2;
const MIN_PRODUCT_COUNT = 2;
const BLOCKED_EXTERNAL_HOSTS = new Set([
  'x.com', 'twitter.com', 'instagram.com', 'youtube.com', 'youtu.be', 'facebook.com'
]);
const EXTERNAL_SERVICE_TITLE_PATTERNS = [/\s\/\sX\s*$/i, /Instagram/i, /YouTube/i, /Facebook/i];

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

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || `${value}`.trim() === '') return defaultValue;
  return /^(?:1|true|yes|on)$/i.test(`${value}`.trim());
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
  const detailConcurrency = parsePositiveIntegerEnv(env, 'DETAIL_CONCURRENCY', DEFAULT_DETAIL_CONCURRENCY);
  const detailNavigationTimeoutMs = parsePositiveIntegerEnv(
    env, 'DETAIL_NAVIGATION_TIMEOUT_MS', DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS
  );
  const detailReadyTimeoutMs = parsePositiveIntegerEnv(env, 'DETAIL_READY_TIMEOUT_MS', DEFAULT_DETAIL_READY_TIMEOUT_MS);
  const detailHardTimeoutMs = parsePositiveIntegerEnv(env, 'DETAIL_HARD_TIMEOUT_MS', DEFAULT_DETAIL_HARD_TIMEOUT_MS);

  if (!Number.isFinite(minTextLength) || minTextLength < 1) {
    throw new Error('MIN_TEXT_LENGTH는 1 이상의 숫자여야 합니다.');
  }
  if (detailConcurrency > 2) throw new Error('DETAIL_CONCURRENCY는 1 또는 2여야 합니다.');
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
    snapshotDir: env.SNAPSHOT_DIR || DEFAULT_SNAPSHOT_DIR,
    debugDom: parseBooleanEnv(env.DEBUG_DOM),
    debugDir: env.DEBUG_DIR || DEFAULT_DEBUG_DIR,
    debugSaveScreenshots: parseBooleanEnv(env.DEBUG_SAVE_SCREENSHOTS),
    detailConcurrency,
    detailNavigationTimeoutMs,
    detailReadyTimeoutMs,
    detailHardTimeoutMs,
    detailReusePages: parseBooleanEnv(env.DETAIL_REUSE_PAGES, true),
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

function resolveDebugConfig(env = process.env) {
  if (!env.NOTION_PAGE_URL) throw new Error('필수 환경변수가 누락되었습니다: NOTION_PAGE_URL');
  return {
    notionPageUrl: env.NOTION_PAGE_URL,
    pageLoadTimeoutMs: parsePositiveIntegerEnv(
      { PAGE_LOAD_TIMEOUT_MS: env.PAGE_LOAD_TIMEOUT_MS || env.PAGE_TIMEOUT_MS },
      'PAGE_LOAD_TIMEOUT_MS', DEFAULT_PAGE_LOAD_TIMEOUT_MS
    ),
    collectionWaitMs: parsePositiveIntegerEnv(env, 'COLLECTION_WAIT_MS', DEFAULT_COLLECTION_WAIT_MS),
    extraWaitMs: parsePositiveIntegerEnv(env, 'EXTRA_WAIT_MS', DEFAULT_EXTRA_WAIT_MS),
    debugDom: true,
    debugDir: env.DEBUG_DIR || DEFAULT_DEBUG_DIR,
    debugSaveScreenshots: parseBooleanEnv(env.DEBUG_SAVE_SCREENSHOTS)
  };
}

function resolveDetailBenchmarkConfig(env = process.env) {
  if (!env.DETAIL_BENCHMARK_URL) throw new Error('필수 환경변수가 누락되었습니다: DETAIL_BENCHMARK_URL');
  return {
    url: env.DETAIL_BENCHMARK_URL,
    detailNavigationTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_NAVIGATION_TIMEOUT_MS', DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS),
    detailReadyTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_READY_TIMEOUT_MS', DEFAULT_DETAIL_READY_TIMEOUT_MS),
    detailHardTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_HARD_TIMEOUT_MS', DEFAULT_DETAIL_HARD_TIMEOUT_MS)
  };
}

function resolveSingleDetailConfig(env = process.env) {
  const url = env.DETAIL_DIAGNOSTIC_URL || env.DETAIL_BENCHMARK_URL;
  if (!url) throw new Error('필수 환경변수가 누락되었습니다: DETAIL_DIAGNOSTIC_URL');
  return {
    url,
    detailNavigationTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_NAVIGATION_TIMEOUT_MS', DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS),
    detailReadyTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_READY_TIMEOUT_MS', DEFAULT_DETAIL_READY_TIMEOUT_MS),
    detailHardTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_HARD_TIMEOUT_MS', DEFAULT_DETAIL_HARD_TIMEOUT_MS)
  };
}

async function saveDebugScreenshot(action, label) {
  try {
    await action();
  } catch (error) {
    log('WARN', `${label} 스크린샷 저장 실패: ${error.message}`);
  }
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
    browser = await chromium.launch(getChromiumLaunchOptions());
    const context = await browser.newContext(getBrowserContextOptions(browser));
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

    await waitForProductCards(page, collectionWaitMs);

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

function getChromiumLaunchOptions() {
  return { headless: true };
}

function getBrowserContextOptions(browser) {
  const chromeVersion = browser.version() || FALLBACK_CHROME_VERSION;
  return {
    userAgent: createDesktopUserAgent(chromeVersion),
    viewport: { width: 1365, height: 900 },
    locale: 'ko-KR',
    extraHTTPHeaders: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  };
}

const IGNORED_OPERATION_DIAGNOSTIC_PATTERNS = [
  /exp\.notion\.com/i,
  /statsig/i,
  /amplitude/i,
  /OPFS.*sqlite3_vfs|sqlite3_vfs.*OPFS/i,
  /emojiData/i,
  /getSubscriptionBanner.*401|401.*getSubscriptionBanner/i,
  /google\.com\/(?:ccm|rmkt)\/collect/i,
  /googleadservices\.com/i,
  /cdn\.metadata\.io\/pixel/i
];

function isIgnoredOperationDiagnostic(message) {
  return IGNORED_OPERATION_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(message));
}

function attachPageDiagnostics(page, label = 'main-page', options = {}) {
  const entries = [];
  const verbose = Boolean(options.verbose);
  const record = (level, message) => {
    if (!verbose && isIgnoredOperationDiagnostic(message)) return;
    const entry = { level, message };
    entries.push(entry);
    if (entries.length > 100) entries.shift();
    if (verbose) log(level, message);
  };
  page.on('pageerror', (error) => record('ERROR', `[${label}] pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      record(message.type() === 'error' ? 'ERROR' : 'WARN', `[${label}] console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => {
    record('WARN', `[${label}] requestfailed: ${request.url()} (${request.failure()?.errorText || 'unknown error'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) record('WARN', `[${label}] HTTP ${response.status()}: ${response.url()}`);
  });
  return {
    entries,
    flush(limit = 30) {
      if (verbose) return;
      entries.slice(-limit).forEach((entry) => log(entry.level, entry.message));
    }
  };
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

async function sendNtfyNotification(config, checkedAt, previousProductCount, currentProductCount, catalogDiff = '') {
  const url = `${config.ntfyServerUrl}/${encodeURIComponent(config.ntfyTopic)}`;
  const checkedAtText = formatKstDateTime(checkedAt);
  const body = [
    '감시 중인 Notion 상품 재고가 업데이트되었습니다.',
    '',
    `확인 시각: ${checkedAtText}`,
    `이전 상품 수: ${previousProductCount}개`,
    `현재 상품 수: ${currentProductCount}개`,
    '',
    '상품별 변경점:',
    catalogDiff || '변경 상세가 없습니다.'
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

function validateFetchedSnapshot(snapshot, config) {
  const unusableReason = getUnusablePageReason(snapshot);
  if (unusableReason) throw new PageFetchError(unusableReason);

  const normalizedText = normalizeText(snapshot.text || '');
  if (normalizedText.length < config.minTextLength) {
    throw new PageFetchError('body below minimum length');
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

function canonicalizeUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    url.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((key) => url.searchParams.delete(key));
    return url.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function isHostOrSubdomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function extractNotionPageId(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    const fromQuery = url.searchParams.get('p') || '';
    const queryMatch = fromQuery.replace(/-/g, '').match(/[0-9a-f]{32}/i);
    if (queryMatch) return queryMatch[0].toLowerCase();
    const path = decodeURIComponent(url.pathname);
    const compactMatch = path.match(/([0-9a-f]{32})\/?$/i);
    if (compactMatch) return compactMatch[1].toLowerCase();
    const uuidMatch = path.match(/([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\/?$/i);
    return uuidMatch ? uuidMatch.slice(1).join('').toLowerCase() : '';
  } catch {
    return '';
  }
}

function canonicalizeNotionProductUrl(value, mainUrl) {
  const evaluated = evaluateProductUrlCandidate({ href: value }, mainUrl);
  if (!evaluated.allowed) return '';
  const pageId = extractNotionPageId(evaluated.href, mainUrl);
  if (!pageId) return evaluated.href;
  const main = new URL(mainUrl);
  return `${main.origin}/${pageId}`;
}

function resolveCardProductUrl(candidate, mainUrl) {
  for (const href of candidate?.hrefs || []) {
    const url = canonicalizeNotionProductUrl(href, mainUrl);
    if (url && extractNotionPageId(url, mainUrl)) return { url, source: 'card-anchor' };
  }
  const blockId = `${candidate?.blockId || ''}`;
  if (/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(blockId)) {
    return { url: new URL(`/${blockId.replace(/-/g, '').toLowerCase()}`, mainUrl).href, source: 'card-block-id' };
  }
  return null;
}

function evaluateProductUrlCandidate(candidate, mainUrl) {
  const href = normalizeValue(candidate?.href);
  const innerText = normalizeValue(candidate?.innerText);
  const result = { href, innerText, hostname: '', allowed: false, reason: '' };
  if (!href) return { ...result, reason: 'missing href' };
  if (href.startsWith('#')) return { ...result, reason: 'hash link' };
  if (/^(?:mailto|tel|javascript):/i.test(href)) return { ...result, reason: 'unsupported scheme' };
  let url;
  let main;
  try {
    url = new URL(href, mainUrl);
    main = new URL(mainUrl);
  } catch {
    return { ...result, reason: 'invalid URL' };
  }
  result.hostname = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol)) return { ...result, reason: 'unsupported scheme' };
  if ([...BLOCKED_EXTERNAL_HOSTS].some((host) => isHostOrSubdomain(result.hostname, host))) {
    return { ...result, reason: 'blocked external host' };
  }
  const sameHost = result.hostname === main.hostname.toLowerCase();
  const notionInternal = isHostOrSubdomain(result.hostname, 'notion.so') || isHostOrSubdomain(result.hostname, 'notion.site');
  if (!sameHost && !notionInternal) return { ...result, reason: 'external host' };
  const normalizedUrl = canonicalizeUrl(url.href, mainUrl);
  if (normalizedUrl === canonicalizeUrl(mainUrl, mainUrl)) return { ...result, reason: 'main page itself' };
  return { ...result, href: normalizedUrl, allowed: true, reason: 'allowed Notion product page' };
}

function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.products)) throw new PageFetchError('invalid product catalog');
  if (catalog.products.length < MIN_PRODUCT_COUNT) {
    throw new PageFetchError('insufficient product count', `expected at least ${MIN_PRODUCT_COUNT}, got ${catalog.products.length}`);
  }
  for (const product of catalog.products) {
    const title = normalizeValue(product.name);
    if (EXTERNAL_SERVICE_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
      throw new PageFetchError('external service title detected', `${title} (${product.url})`);
    }
  }
  return catalog;
}

function normalizeValue(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim();
}

function normalizeStatus(value) {
  const text = normalizeValue(value);
  if (/품절|sold\s*out|out\s*of\s*stock/i.test(text)) return 'sold_out';
  if (/판매\s*중|for\s*sale|in\s*stock|available/i.test(text)) return 'for_sale';
  if (/판매\s*종료|discontinued|closed/i.test(text)) return 'discontinued';
  return text.toLowerCase();
}

function normalizeProduct(product) {
  const characterMap = new Map((product.characters || []).map((character) => [normalizeValue(character.name), {
    name: normalizeValue(character.name),
    status: normalizeStatus(character.status)
  }]));
  const characters = [...characterMap.values()].filter((character) => character.name).sort((a, b) =>
    a.name.localeCompare(b.name, 'ko-KR') || a.status.localeCompare(b.status, 'ko-KR'));
  return {
    url: canonicalizeUrl(product.url, product.url),
    name: normalizeValue(product.name),
    price: normalizeValue(product.price).replace(/\s+/g, ''),
    status: normalizeStatus(product.status),
    characters
  };
}

function normalizeCatalog(products) {
  if (!Array.isArray(products) && Array.isArray(products?.products)) products = products.products;
  return {
    version: 1,
    products: products.map(normalizeProduct).sort((a, b) =>
      a.url.localeCompare(b.url) || a.name.localeCompare(b.name, 'ko-KR'))
  };
}

function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function diffCatalog(previousCatalog, currentCatalog) {
  const previous = new Map((previousCatalog?.products || []).map((product) => [product.url, product]));
  const current = new Map((currentCatalog?.products || []).map((product) => [product.url, product]));
  const changes = [];
  for (const [url, product] of current) {
    if (!previous.has(url)) {
      changes.push({ type: 'added', url, name: product.name, changes: [{ field: 'product', after: product }] });
      continue;
    }
    const before = previous.get(url);
    const fields = [];
    for (const field of ['name', 'price', 'status']) {
      if (before[field] !== product[field]) fields.push({ field, before: before[field], after: product[field] });
    }
    const oldCharacters = new Map(before.characters.map((item) => [item.name, item.status]));
    const newCharacters = new Map(product.characters.map((item) => [item.name, item.status]));
    for (const [name, status] of newCharacters) {
      if (!oldCharacters.has(name)) fields.push({ field: 'character_added', name, after: status });
      else if (oldCharacters.get(name) !== status) fields.push({ field: 'character_status', name, before: oldCharacters.get(name), after: status });
    }
    for (const [name, status] of oldCharacters) {
      if (!newCharacters.has(name)) fields.push({ field: 'character_removed', name, before: status });
    }
    if (fields.length) changes.push({ type: 'changed', url, name: product.name || before.name, changes: fields });
  }
  for (const [url, product] of previous) {
    if (!current.has(url)) changes.push({ type: 'removed', url, name: product.name, changes: [{ field: 'product', before: product }] });
  }
  return changes.sort((a, b) => a.url.localeCompare(b.url));
}

async function collectProductCardCandidates(page) {
  return page.evaluate(() => {
    const clean = (value) => `${value || ''}`.replace(/\s+/g, ' ').trim();
    const pricePattern = /\d{1,3}(?:,\d{3})*\s*원|₩\s*\d[\d,]*/i;
    const statusPattern = /판매\s*중|품절|SOLD\s*OUT|FOR\s*SALE|IN\s*STOCK|OUT\s*OF\s*STOCK/i;
    const galleryPattern = /collection|gallery|board|card/i;
    const all = [...document.querySelectorAll('div, article, li, a, button, [role]')];
    const scored = all.map((element) => {
      const style = getComputedStyle(element);
      const text = clean(element.innerText || element.textContent || '');
      const role = element.getAttribute('role') || '';
      const className = typeof element.className === 'string' ? element.className : '';
      const hasImage = Boolean(element.querySelector('img, [role="img"], [style*="background-image"]'));
      const hasText = text.length >= 2 && text.length <= 1000;
      const hasProductText = pricePattern.test(text) || statusPattern.test(text);
      const clickable = style.cursor === 'pointer' || Boolean(element.onclick) || role === 'button' || role === 'link' ||
        element.tabIndex >= 0 || element.hasAttribute('data-page-id');
      const galleryLike = galleryPattern.test(className) || Boolean(element.closest('.notion-collection-view, [class*="collection"], [class*="gallery"]'));
      const collectionItem = element.classList.contains('notion-collection-item');
      const hasIds = element.hasAttribute('data-block-id') || element.hasAttribute('data-page-id');
      let score = 0;
      if (galleryLike) score += 3;
      if (hasProductText) score += 4;
      if (clickable) score += 3;
      if (hasIds) score += 2;
      if (hasImage && hasText) score += 2;
      if (role === 'button' || role === 'link') score += 1;
      return { element, score, text, role, className, hasImage, hasProductText, clickable, galleryLike, collectionItem };
    }).filter((item) => item.text && (
      item.collectionItem || (item.hasProductText && item.hasImage && item.clickable && item.text.length <= 500)
    ));
    scored.sort((a, b) => b.score - a.score || a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top);
    const selected = [];
    for (const item of scored) {
      if (selected.some((chosen) => chosen.element.contains(item.element) || item.element.contains(chosen.element))) continue;
      selected.push(item);
    }
    return selected.map((item, index) => {
      item.element.setAttribute('data-notion-watcher-card-id', `${index}`);
      return {
        id: index, score: item.score, outerHTML: item.element.outerHTML.slice(0, 4000), innerText: item.text,
        role: item.role, class: item.className, blockId: item.element.getAttribute('data-block-id') || '',
        pageId: item.element.getAttribute('data-page-id') || '', pageUrl: location.href,
        hrefs: [...new Set([item.element.getAttribute('href') || '',
          ...[...item.element.querySelectorAll('a[href]')].map((anchor) => anchor.getAttribute('href') || '')
        ].filter(Boolean))],
        hasImage: item.hasImage, hasProductText: item.hasProductText, clickable: item.clickable, galleryLike: item.galleryLike
      };
    });
  });
}

async function getCollectionRenderStats(page) {
  return page.evaluate(() => ({
    collectionItemCount: document.querySelectorAll('.notion-collection-item').length,
    collectionItemAnchorCount: document.querySelectorAll('.notion-collection-item a[href]').length,
    dataBlockIdCount: document.querySelectorAll('.notion-collection-item[data-block-id], .notion-collection-item [data-block-id]').length,
    bodyTextLength: (document.body?.innerText || '').length,
    bodyTextPreview: (document.body?.innerText || '').slice(0, 1000),
    currentUrl: location.href,
    documentReadyState: document.readyState,
    navigatorUserAgent: navigator.userAgent,
    navigatorWebdriver: navigator.webdriver
  }));
}

async function waitForProductCards(page, timeoutMs) {
  try {
    await page.waitForSelector('.notion-collection-item', { state: 'attached', timeout: timeoutMs });
    await page.waitForFunction(() => document.querySelectorAll('.notion-collection-item').length >= 2, null, { timeout: timeoutMs });
  } catch (error) {
    const stats = await getCollectionRenderStats(page).catch(() => ({}));
    throw new PageFetchError('product cards not rendered', `${error.message}; ${JSON.stringify(stats)}`);
  }
}

async function collectProductUrls(page, mainUrl) {
  const config = arguments[2] || {};
  const debugDir = path.resolve(config.debugDir || DEFAULT_DEBUG_DIR);
  const clickDiagnosticMode = Boolean(config.diagnosticMode);
  if (config.debugDom) {
    await fs.mkdir(debugDir, { recursive: true });
    const oldDebugFiles = await fs.readdir(debugDir).catch(() => []);
    await Promise.all(oldDebugFiles.filter((name) =>
      /^(?:main-page\.(?:html|png)|card-(?:candidates|click-results)\.json|modal-\d+\.(?:html|png))$/.test(name)
    ).map((name) => fs.unlink(path.join(debugDir, name)).catch(() => undefined)));
    await fs.writeFile(path.join(debugDir, 'main-page.html'), await page.content(), 'utf8');
    if (clickDiagnosticMode && config.debugSaveScreenshots) {
      await saveDebugScreenshot(
        () => page.screenshot({ path: path.join(debugDir, 'main-page.png'), fullPage: true }),
        'main-page'
      );
    }
  }

  /* Candidate extraction is shared by operational and manual diagnostic modes. */
  const candidates = await collectProductCardCandidates(page);

  if (config.debugDom) await saveStateAtomic(path.join(debugDir, 'card-candidates.json'), candidates);
  if (!candidates.length) {
    if (clickDiagnosticMode) await saveStateAtomic(path.join(debugDir, 'card-click-results.json'), []);
    throw new PageFetchError('product card candidates not found');
  }

  const clickResults = [];
  const diagnostics = [];
  const urls = new Map();
  for (const candidate of candidates) {
    const result = {
      candidateId: candidate.id,
      before: candidate,
      detected: [],
      modalOpened: false,
      success: false,
      failureReason: ''
    };
    let popup = null;
    try {
      const beforeUrl = canonicalizeUrl(page.url(), mainUrl);
      const directUrl = resolveCardProductUrl(candidate, mainUrl);
      if (directUrl) result.detected.push({ source: directUrl.source, href: directUrl.url });

      if (result.detected.length) {
        for (const detected of result.detected) {
          const diagnostic = evaluateProductUrlCandidate({ href: detected.href, innerText: candidate.innerText }, mainUrl);
          diagnostics.push({ ...diagnostic, candidateId: candidate.id, source: detected.source });
          if (diagnostic.allowed) {
            const stableUrl = canonicalizeNotionProductUrl(diagnostic.href, mainUrl);
            const key = extractNotionPageId(stableUrl, mainUrl) || stableUrl;
            if (stableUrl && !urls.has(key)) urls.set(key, stableUrl);
          }
        }
        result.success = true;
        if (!clickDiagnosticMode) continue;
      }

      const popupPromise = page.context().waitForEvent('page', { timeout: 700 }).catch(() => null);
      await page.evaluate((item) => {
        const clean = (value) => `${value || ''}`.replace(/\s+/g, ' ').trim();
        const elements = [...document.querySelectorAll('div, article, li, a, button, [role]')];
        const matched = elements.find((element) =>
          (item.pageId && element.getAttribute('data-page-id') === item.pageId) ||
          (item.blockId && element.getAttribute('data-block-id') === item.blockId && clean(element.innerText) === item.innerText) ||
          (clean(element.innerText) === item.innerText && `${element.className || ''}` === item.class)
        );
        if (matched) matched.setAttribute('data-notion-watcher-card-id', `${item.id}`);
      }, candidate);
      const locator = page.locator(`[data-notion-watcher-card-id="${candidate.id}"]`).first();
      await locator.scrollIntoViewIfNeeded();
      await locator.click({ timeout: 5000 });
      popup = await popupPromise;
      await page.waitForTimeout(800);

      const afterUrl = canonicalizeUrl(page.url(), mainUrl);
      if (afterUrl && afterUrl !== beforeUrl) result.detected.push({ source: 'page-url-or-history', href: afterUrl });
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => null);
        result.detected.push({ source: 'popup', href: popup.url() });
      }

      const modal = page.locator('[role="dialog"]:visible, .notion-peek-renderer:visible').last();
      if (await modal.count()) {
        result.modalOpened = true;
        const modalNumber = candidate.id + 1;
        const modalData = await modal.evaluate((element) => ({
          html: element.outerHTML,
          links: [...element.querySelectorAll('a[href]')].map((anchor) => ({
            href: anchor.getAttribute('href') || '',
            innerText: (anchor.innerText || anchor.textContent || '').trim()
          }))
        }));
        modalData.links.forEach((link) => result.detected.push({ source: 'modal-link', ...link }));
        if (clickDiagnosticMode) {
          await fs.writeFile(path.join(debugDir, `modal-${modalNumber}.html`), modalData.html, 'utf8');
          if (config.debugSaveScreenshots) {
            await saveDebugScreenshot(async () => {
              try {
                await modal.screenshot({ path: path.join(debugDir, `modal-${modalNumber}.png`) });
              } catch {
                await page.screenshot({ path: path.join(debugDir, `modal-${modalNumber}.png`) });
              }
            }, `modal-${modalNumber}`);
          }
        }

        if (!result.detected.some((item) => evaluateProductUrlCandidate(item, mainUrl).allowed)) {
          const openButton = modal.getByText(/Open as page|전체 페이지로 열기|페이지로 열기/i).first();
          if (await openButton.count()) {
            const openPopupPromise = page.context().waitForEvent('page', { timeout: 700 }).catch(() => null);
            await openButton.click({ timeout: 3000 }).catch(() => null);
            const openPopup = await openPopupPromise;
            await page.waitForTimeout(500);
            if (openPopup) {
              result.detected.push({ source: 'modal-open-popup', href: openPopup.url() });
              await openPopup.close().catch(() => undefined);
            }
            if (canonicalizeUrl(page.url(), mainUrl) !== beforeUrl) {
              result.detected.push({ source: 'modal-open-page-url', href: page.url() });
            }
          }
        }
      }

      for (const detected of result.detected) {
        const diagnostic = evaluateProductUrlCandidate({ href: detected.href, innerText: detected.innerText || candidate.innerText }, mainUrl);
        diagnostics.push({ ...diagnostic, candidateId: candidate.id, source: detected.source });
        if (diagnostic.allowed) {
          const stableUrl = canonicalizeNotionProductUrl(diagnostic.href, mainUrl);
          const key = extractNotionPageId(stableUrl, mainUrl) || stableUrl;
          if (stableUrl && !urls.has(key)) urls.set(key, stableUrl);
        }
      }
      result.success = result.detected.some((item) => evaluateProductUrlCandidate(item, mainUrl).allowed);
      if (!result.success) result.failureReason = result.modalOpened ? 'modal contained no allowed Notion URL' : 'click produced no allowed Notion URL';
    } catch (error) {
      result.failureReason = error.message;
    } finally {
      if (popup) await popup.close().catch(() => undefined);
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(150);
      if (canonicalizeUrl(page.url(), mainUrl) !== canonicalizeUrl(mainUrl, mainUrl)) {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
      }
      if (canonicalizeUrl(page.url(), mainUrl) !== canonicalizeUrl(mainUrl, mainUrl)) {
        await page.goto(mainUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
      }
      clickResults.push(result);
      if (clickDiagnosticMode) await saveStateAtomic(path.join(debugDir, 'card-click-results.json'), clickResults);
    }
  }

  if (config.debugDom) diagnostics.forEach((item) => log('DEBUG', `product-url-candidate ${JSON.stringify(item)}`));
  if (clickDiagnosticMode) {
    clickResults.forEach((item) => log('DEBUG', `card-click-result ${JSON.stringify(item)}`));
    await saveStateAtomic(path.join(debugDir, 'card-click-results.json'), clickResults);
  }
  if (!urls.size) throw new PageFetchError('product detail URLs not found');
  return { urls: [...urls.values()], diagnostics, candidates, clickResults };
}

function shouldAbortDetailResource(resourceType) {
  return resourceType === 'image' || resourceType === 'media' || resourceType === 'font';
}

async function configureDetailResourcePolicy(context) {
  await context.route('**/*', async (route) => {
    if (shouldAbortDetailResource(route.request().resourceType())) await route.abort();
    else await route.continue();
  });
}

async function closePageSafely(page, timeoutMs = 2000) {
  if (!page || page.isClosed()) return;
  await Promise.race([
    page.close({ runBeforeUnload: false }).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

function createDetailPageSlot(context) {
  let page = null;
  let generation = 0;
  return {
    async get(forceNew = false) {
      if (forceNew && page) await this.discard();
      if (!page || page.isClosed()) {
        page = await context.newPage();
        generation += 1;
      }
      return { page, generation };
    },
    async discard(timeoutMs = 2000) {
      const oldPage = page;
      page = null;
      if (oldPage) await closePageSafely(oldPage, timeoutMs);
    },
    current() {
      return { page, generation };
    }
  };
}

async function processDetailPage(page, url, config, logPrefix) {
  const navigationTimeoutMs = config.detailNavigationTimeoutMs || DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS;
  const readyTimeoutMs = config.detailReadyTimeoutMs || DEFAULT_DETAIL_READY_TIMEOUT_MS;
  const hardTimeoutMs = config.detailHardTimeoutMs || DEFAULT_DETAIL_HARD_TIMEOUT_MS;
  page.setDefaultNavigationTimeout(navigationTimeoutMs);
  page.setDefaultTimeout(readyTimeoutMs);
  log('INFO', `${logPrefix} timeout 설정: navigation=${navigationTimeoutMs}ms, ready=${readyTimeoutMs}ms, hard=${hardTimeoutMs}ms`);

  const expectedPageId = extractNotionPageId(url, url);
  const attemptState = { cancelled: false };
  let hardTimer;
  const work = async () => {
    if (!attemptState.cancelled) log('INFO', `${logPrefix} goto 시작`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
      if (!attemptState.cancelled) log('INFO', `${logPrefix} goto 완료`);
    } catch (error) {
      if (!attemptState.cancelled) log('WARN', `${logPrefix} goto 실패: ${error.name}: ${error.message} (설정 timeout=${navigationTimeoutMs}ms)`);
      throw error;
    }
    const readyStartedAt = Date.now();
    if (!attemptState.cancelled) log('INFO', `${logPrefix} ready 대기 시작`);
    try {
      await page.waitForFunction(({ expectedPageId: pageId }) => {
        const text = document.body?.innerText || '';
        const compactUrl = location.href.replace(/-/g, '').toLowerCase();
        return document.readyState !== 'loading' && text.trim().length >= 20 && (!pageId || compactUrl.includes(pageId));
      }, { expectedPageId }, { timeout: readyTimeoutMs });
      if (!attemptState.cancelled) log('INFO', `${logPrefix} ready 완료 (${Date.now() - readyStartedAt}ms)`);
    } catch (error) {
      if (!attemptState.cancelled) {
        const diagnostic = await page.evaluate((pageId) => {
          const text = document.body?.innerText || '';
          const compactUrl = location.href.replace(/-/g, '').toLowerCase();
          return {
            currentUrl: location.href,
            documentReadyState: document.readyState,
            bodyTextLength: text.length,
            bodyTextPreview: text.slice(0, 1000),
            priceMatched: /\d{1,3}(?:,\d{3})*\s*원|₩\s*\d[\d,]*/.test(text),
            statusMatched: /판매\s*중|품절|SOLD\s*OUT|FOR\s*SALE|IN\s*STOCK|OUT\s*OF\s*STOCK/i.test(text),
            expectedPageId: pageId,
            expectedPageIdMatched: !pageId || compactUrl.includes(pageId)
          };
        }, expectedPageId).catch(() => ({ diagnosticUnavailable: true }));
        log('WARN', `${logPrefix} ready 실패 진단: ${JSON.stringify(diagnostic)}`);
        log('WARN', `${logPrefix} ready 실패: ${error.name}: ${error.message} (설정 timeout=${readyTimeoutMs}ms, 실제=${Date.now() - readyStartedAt}ms)`);
      }
      throw error;
    }
    if (!attemptState.cancelled) log('INFO', `${logPrefix} parse 시작`);
    try {
      const product = await extractProductDetail(page, url);
      if (!attemptState.cancelled) log('INFO', `${logPrefix} parse 완료`);
      return product;
    } catch (error) {
      const incomplete = /product (?:name|price|status) not found/i.test(error.message || '');
      if (!incomplete) {
        if (!attemptState.cancelled) log('WARN', `${logPrefix} parse 실패: ${error.name}: ${error.message}`);
        throw error;
      }
      if (!attemptState.cancelled) log('WARN', `${logPrefix} parse 불완전, 1초 후 재파싱: ${error.message}`);
      await page.waitForTimeout(1000);
      try {
        const product = await extractProductDetail(page, url);
        if (!attemptState.cancelled) log('INFO', `${logPrefix} parse 재시도 완료`);
        return product;
      } catch (retryError) {
        if (!attemptState.cancelled) log('WARN', `${logPrefix} parse 실패: ${retryError.name}: ${retryError.message}`);
        throw retryError;
      }
    }
  };

  const settledWork = work().then(
    (value) => ({ kind: 'work', value }),
    (error) => ({ kind: 'error', error })
  );
  const hardTimeout = new Promise((resolve) => {
    hardTimer = setTimeout(async () => {
      attemptState.cancelled = true;
      await closePageSafely(page, 1000);
      resolve({ kind: 'hard-timeout' });
    }, hardTimeoutMs);
  });
  try {
    const result = await Promise.race([settledWork, hardTimeout]);
    if (result.kind === 'work') return result.value;
    if (result.kind === 'error') throw result.error;
    await settledWork;
    throw new PageFetchError('detail hard timeout', `${hardTimeoutMs}ms`);
  } finally {
    clearTimeout(hardTimer);
  }
}

function parseProductText(title, text, rowTexts = []) {
  const clean = (value) => `${value || ''}`.replace(/\s+/g, ' ').trim();
  const name = clean(title).replace(/\s*[|–-]\s*Notion.*$/i, '');
  const normalizedText = clean(text);
  const price = normalizedText.match(/\d{1,3}(?:,\d{3})*\s*원|₩\s*\d[\d,]*/)?.[0] || '';
  const statusPattern = /판매\s*중|품절|SOLD\s*OUT|FOR\s*SALE|IN\s*STOCK|OUT\s*OF\s*STOCK/i;
  const status = normalizedText.match(statusPattern)?.[0] || '';
  const characters = [];
  const optionPattern = /([^|\n,()]{1,80}?)\s*\((판매\s*중|품절|SOLD\s*OUT|FOR\s*SALE|IN\s*STOCK|OUT\s*OF\s*STOCK)\)/gi;
  let match;
  while ((match = optionPattern.exec(normalizedText))) characters.push({ name: clean(match[1]), status: clean(match[2]) });
  rowTexts.forEach((value) => {
    const rowText = clean(value);
    const rowStatus = rowText.match(statusPattern)?.[0];
    if (!rowStatus) return;
    const characterName = clean(rowText.replace(rowStatus, '').replace(/[|:()]/g, ' '));
    if (characterName && characterName !== name && characterName.length <= 80) characters.push({ name: characterName, status: rowStatus });
  });
  return { name, price, status, characters, text: normalizedText };
}

async function extractProductDetail(page, url) {
  const source = await page.evaluate(() => ({
    title: document.querySelector('h1, [contenteditable="true"][data-content-editable-leaf="true"]')?.textContent || document.title,
    text: document.querySelector('.notion-page-content, main, article')?.innerText || document.body.innerText,
    rowTexts: [...document.querySelectorAll('tr, [role="row"], .notion-toggle-block, details')]
      .map((row) => row.innerText || row.textContent || '')
  }));
  const raw = parseProductText(source.title, source.text, source.rowTexts);
  assertNotionContentLooksUsable({ url: page.url(), title: raw.name, text: raw.text, renderedCandidateCount: 1 });
  if (!raw.name) throw new PageFetchError('product name not found');
  if (!raw.price) throw new PageFetchError('product price not found');
  if (!raw.status) throw new PageFetchError('product status not found');
  if (EXTERNAL_SERVICE_TITLE_PATTERNS.some((pattern) => pattern.test(raw.name))) {
    throw new PageFetchError('external service title detected', raw.name);
  }
  return { url, name: raw.name, price: raw.price, status: raw.status, characters: raw.characters };
}

async function discoverProductUrlsWithRetries(browser, notionPageUrl, config) {
  const maxAttempts = config.pageFetchMaxAttempts || DEFAULT_PAGE_FETCH_MAX_ATTEMPTS;
  const failedHtmlPath = path.resolve(config.debugDir || DEFAULT_DEBUG_DIR, 'main-page-failed.html');
  await removeFileIfExists(failedHtmlPath);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const context = await browser.newContext(getBrowserContextOptions(browser));
    let page;
    let pageDiagnostics;
    try {
      page = await context.newPage();
      pageDiagnostics = attachPageDiagnostics(page, `main-page attempt ${attempt}/${maxAttempts}`, {
        verbose: config.debugDom
      });
      if (config.debugDom) log('INFO', 'request interception/resource blocking: disabled (script, xhr, fetch allowed)');
      await page.goto(notionPageUrl, { waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeoutMs });
      await waitForProductCards(page, config.collectionWaitMs);
      await page.waitForTimeout(config.extraWaitMs);
      const stats = await getCollectionRenderStats(page);
      if (config.debugDom) log('INFO', `상품 카드 수집 직전 DOM 통계: ${JSON.stringify(stats)}`);
      const result = await collectProductUrls(page, notionPageUrl, config);
      log('INFO', `메인 페이지 조회 ${attempt}/${maxAttempts} 성공`);
      return result;
    } catch (error) {
      lastError = createPageFetchError(error);
      pageDiagnostics?.flush(30);
      const stats = page ? await getCollectionRenderStats(page).catch(() => ({})) : {};
      log('WARN', `메인 페이지 실패 본문 앞 1000자: ${JSON.stringify(stats.bodyTextPreview || '')}`);
      if (Object.keys(stats).length) log('WARN', `메인 페이지 실패 DOM 통계: ${JSON.stringify(stats)}`);
      if (attempt === maxAttempts && page) {
        try {
          await fs.mkdir(path.dirname(failedHtmlPath), { recursive: true });
          await fs.writeFile(failedHtmlPath, await page.content(), 'utf8');
          log('INFO', `마지막 실패 HTML 저장: ${failedHtmlPath}`);
        } catch (saveError) {
          log('WARN', `마지막 실패 HTML 저장 실패: ${saveError.message}`);
        }
      }
      log('WARN', `메인 페이지 조회 ${attempt}/${maxAttempts} 실패: ${lastError.message}`);
      if (attempt < maxAttempts) await sleep(getRetryDelayMs(config.pageFetchRetryDelaysMs, attempt));
    } finally {
      await context.close().catch(() => undefined);
    }
  }
  throw lastError || new PageFetchError('main page fetch failed');
}

async function fetchProductCatalog(notionPageUrl, config = {}) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(getChromiumLaunchOptions());
  try {
    const { urls } = await discoverProductUrlsWithRetries(browser, notionPageUrl, config);
    if (!urls.length) throw new PageFetchError('product detail URLs not found');

    const products = new Array(urls.length);
    const failures = [];
    const detailConcurrency = Math.min(config.detailConcurrency || DEFAULT_DETAIL_CONCURRENCY, urls.length);
    const detailStartedAt = Date.now();
    const detailDurationsMs = [];
    const reusePages = config.detailReusePages !== false;
    log('INFO', `전체 상세 조회 시작: URL ${urls.length}개, 동시성 ${detailConcurrency}`);
    const detailContext = await browser.newContext({ ...getBrowserContextOptions(browser), serviceWorkers: 'block' });
    await configureDetailResourcePolicy(detailContext);
    let cursor = 0;
    const worker = async (workerIndex) => {
      const workerId = workerIndex + 1;
      const pageSlot = createDetailPageSlot(detailContext);
      try {
        while (cursor < urls.length) {
          const index = cursor++;
          const url = urls[index];
          const position = index + 1;
          const productStartedAt = Date.now();
          const hardTimeoutMs = config.detailHardTimeoutMs || DEFAULT_DETAIL_HARD_TIMEOUT_MS;
          const deadline = productStartedAt + hardTimeoutMs;
          log('INFO', `상세 페이지 조회 ${position}/${urls.length}: ${url} (workerId=${workerId})`);
          let lastError;
          const maxAttempts = config.pageFetchMaxAttempts || DEFAULT_PAGE_FETCH_MAX_ATTEMPTS;
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
              lastError = new PageFetchError('detail hard timeout', `${hardTimeoutMs}ms`);
              break;
            }
            const allocated = await pageSlot.get(!reusePages);
            const page = allocated.page;
            const pageGeneration = allocated.generation;
            const logPrefix = `상세 페이지 조회 ${position}/${urls.length} [workerId=${workerId}, pageId=${pageGeneration}, attempt=${attempt}]`;
            try {
              products[index] = await processDetailPage(page, url, {
                ...config,
                detailHardTimeoutMs: Math.min(hardTimeoutMs, remainingMs)
              }, logPrefix);
              lastError = null;
              const durationMs = Date.now() - productStartedAt;
              detailDurationsMs.push(durationMs);
              log('INFO', `상세 페이지 조회 ${position}/${urls.length} 완료: ${products[index].name} (${(durationMs / 1000).toFixed(1)}초)`);
              if (reusePages) {
                log('INFO', `${logPrefix} page cleanup 시작 (재사용)`);
                await page.evaluate(() => window.stop()).catch(() => undefined);
                log('INFO', `${logPrefix} page cleanup 완료 (재사용)`);
              } else {
                log('INFO', `${logPrefix} page cleanup 시작`);
                await pageSlot.discard();
                log('INFO', `${logPrefix} page cleanup 완료`);
              }
              break;
            } catch (error) {
              lastError = createPageFetchError(error);
              log('INFO', `${logPrefix} page cleanup 시작`);
              await pageSlot.discard(Math.max(0, Math.min(2000, deadline - Date.now())));
              log('INFO', `${logPrefix} page cleanup 완료`);
              if (lastError.reason === 'detail hard timeout') break;
            }
          }
          if (lastError) {
            const durationMs = Date.now() - productStartedAt;
            detailDurationsMs.push(durationMs);
            const reason = lastError.reason || lastError.message || 'unknown error';
            failures.push({ url, reason });
            log('WARN', `상세 페이지 조회 ${position}/${urls.length} 실패: ${reason} (${(durationMs / 1000).toFixed(1)}초)`);
          }
        }
      } finally {
        const currentPage = pageSlot.current();
        if (currentPage.page) {
          const prefix = `workerId=${workerId}, pageId=${currentPage.generation}`;
          log('INFO', `${prefix} page cleanup 시작`);
          await pageSlot.discard();
          log('INFO', `${prefix} page cleanup 완료`);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: detailConcurrency }, (_, index) => worker(index)));
    } finally {
      await detailContext.close().catch(() => undefined);
    }
    const elapsedMs = Date.now() - detailStartedAt;
    const averageMs = detailDurationsMs.length ? detailDurationsMs.reduce((sum, value) => sum + value, 0) / detailDurationsMs.length : 0;
    log('INFO', `전체 상세 조회 완료: 성공 ${products.filter(Boolean).length}개, 실패 ${failures.length}개, 소요시간 ${(elapsedMs / 1000).toFixed(1)}초, 상품 평균 ${(averageMs / 1000).toFixed(1)}초`);
    if (failures.length) {
      const error = new PageFetchError('product detail fetch failed', failures.map((item) => item.url).join(', '));
      error.failures = failures;
      throw error;
    }
    return validateCatalog(normalizeCatalog(products));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function benchmarkDetailMode(browser, url, config, reusePage, count = 5) {
  const context = await browser.newContext({ ...getBrowserContextOptions(browser), serviceWorkers: 'block' });
  await configureDetailResourcePolicy(context);
  const durations = [];
  let page;
  try {
    for (let index = 0; index < count; index += 1) {
      if (!page || !reusePage) page = await context.newPage();
      const startedAt = Date.now();
      await processDetailPage(page, url, config, `벤치마크 ${reusePage ? '재사용' : '새 page'} ${index + 1}/${count}`);
      durations.push(Date.now() - startedAt);
      if (!reusePage) {
        await closePageSafely(page);
        page = null;
      }
    }
  } finally {
    if (page) await closePageSafely(page);
    await context.close().catch(() => undefined);
  }
  return {
    mode: reusePage ? 'reuse-page' : 'new-page-per-product',
    count,
    averageMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    maxMs: Math.max(...durations),
    durationsMs: durations
  };
}

async function benchmarkDetails(config = resolveDetailBenchmarkConfig()) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(getChromiumLaunchOptions());
  try {
    const reuse = await benchmarkDetailMode(browser, config.url, config, true, 5);
    const fresh = await benchmarkDetailMode(browser, config.url, config, false, 5);
    log('INFO', `상세 벤치마크 결과: ${JSON.stringify({ reuse, fresh })}`);
    return { reuse, fresh };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function diagnoseSingleDetail(config = resolveSingleDetailConfig()) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(getChromiumLaunchOptions());
  try {
    const context = await browser.newContext({ ...getBrowserContextOptions(browser), serviceWorkers: 'block' });
    await configureDetailResourcePolicy(context);
    const page = await context.newPage();
    try {
      const startedAt = Date.now();
      const product = await processDetailPage(page, config.url, config, '단일 상세 진단 [workerId=1, pageId=1]');
      log('INFO', `단일 상세 진단 완료: ${product.name} (${((Date.now() - startedAt) / 1000).toFixed(1)}초)`);
      return product;
    } finally {
      await closePageSafely(page);
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function debugCards(config = resolveDebugConfig()) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(getChromiumLaunchOptions());
  try {
    const context = await browser.newContext(getBrowserContextOptions(browser));
    const page = await context.newPage();
    attachPageDiagnostics(page, 'debug-cards', { verbose: true });
    log('INFO', 'request interception/resource blocking: disabled (script, xhr, fetch allowed)');
    await page.goto(config.notionPageUrl, { waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeoutMs });
    await waitForProductCards(page, config.collectionWaitMs);
    await page.waitForTimeout(config.extraWaitMs);
    const stats = await getCollectionRenderStats(page);
    log('INFO', `상품 카드 수집 직전 DOM 통계: ${JSON.stringify(stats)}`);
    const result = await collectProductUrls(page, config.notionPageUrl, {
      ...config,
      debugDom: true,
      diagnosticMode: true
    });
    log('INFO', `카드 ${result.candidates.length}개를 조사해 상품 상세 URL ${result.urls.length}개를 찾았습니다.`);
    result.urls.forEach((url) => log('INFO', url));
    return result;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function formatCatalogDiff(diff) {
  return diff.flatMap((item) => {
    const header = `${item.type === 'added' ? '추가' : item.type === 'removed' ? '삭제' : '변경'}: ${item.name || item.url}`;
    const details = item.changes.map((change) => {
      if (change.field === 'character_status') return `- ${change.name}: ${change.before} → ${change.after}`;
      if (change.field === 'character_added') return `- 캐릭터 추가 ${change.name}: ${change.after}`;
      if (change.field === 'character_removed') return `- 캐릭터 삭제 ${change.name}: ${change.before}`;
      if (change.field === 'product') return '- 상품 전체';
      return `- ${change.field}: ${change.before || '(없음)'} → ${change.after || '(없음)'}`;
    });
    return [header, ...details];
  }).join('\n');
}

async function saveChangeArtifacts(snapshotDir, checkedAt, catalog, diff) {
  const stamp = checkedAt.replace(/[:.]/g, '-');
  const directory = path.resolve(snapshotDir);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    saveStateAtomic(path.join(directory, `${stamp}.snapshot.json`), catalog),
    saveStateAtomic(path.join(directory, `${stamp}.diff.json`), { checkedAt, changes: diff })
  ]);
}

async function runOnce(options = {}) {
  const deps = {
    fetchCatalog: fetchProductCatalog,
    sendNotification: sendNtfyNotification,
    sendOperatorNotification,
    sleep,
    now: () => new Date(),
    ...options.deps
  };

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

    let catalog;
    try {
      catalog = validateCatalog(normalizeCatalog(await deps.fetchCatalog(config.notionPageUrl, config)));
    } catch (error) {
      const fetchError = createPageFetchError(error);
      await recordPageFetchFailure(config, deps, fetchError.reason);
      throw fetchError;
    }
    await recordPageFetchSuccess(config, deps);
    const json = serializeCatalog(catalog);
    const hash = createHash(json);
    const checkedAt = deps.now().toISOString();

    if (!previousState) {
      await saveStateWithLog(config.stateFile, {
        hash,
        catalog,
        checkedAt,
        changedAt: null
      });
      log('INFO', '최초 상태를 저장했습니다.');
      return 0;
    }

    if (previousState.hash === hash) {
      await saveStateWithLog(config.stateFile, {
        ...previousState,
        hash,
        catalog,
        checkedAt,
        changedAt: previousState.changedAt || null
      });
      log('INFO', '변경 사항이 없습니다.');
      return 0;
    }

    log('INFO', '상품 변경을 감지했습니다.');
    const diff = diffCatalog(previousState.catalog || { products: [] }, catalog);
    const diffText = formatCatalogDiff(diff);
    try {
      await deps.sendNotification(config, checkedAt, previousState.catalog?.products?.length || 0, catalog.products.length, diffText);
      log('INFO', 'ntfy 알림을 전송했습니다.');
    } catch (error) {
      log('ERROR', 'ntfy 알림 전송에 실패했습니다.');
      throw error;
    }

    await saveChangeArtifacts(config.snapshotDir, checkedAt, catalog, diff);
    await saveStateWithLog(config.stateFile, { hash, catalog, checkedAt, changedAt: checkedAt });
    log('INFO', '새로운 상태를 저장했습니다.');
    return 0;
  } catch (error) {
    if (/상태 파일/.test(error.message)) {
      log('ERROR', error.message);
    } else if (/ntfy/.test(error.message)) {
      log('ERROR', error.message);
    } else if (/필수 환경변수|MIN_TEXT_LENGTH|DETAIL_CONCURRENCY|STALE_LOCK_MS|TIMEOUT_MS|WAIT_MS/.test(error.message)) {
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
  if (process.argv.includes('--debug-detail')) {
    diagnoseSingleDetail().catch((error) => {
      log('ERROR', error.message);
      process.exitCode = 1;
    });
  } else if (process.argv.includes('--benchmark-details')) {
    benchmarkDetails().catch((error) => {
      log('ERROR', error.message);
      process.exitCode = 1;
    });
  } else if (process.argv.includes('--debug-cards')) {
    debugCards().catch((error) => {
      log('ERROR', error.message);
      process.exitCode = 1;
    });
  } else {
    runOnce().then((exitCode) => {
      process.exitCode = exitCode;
    });
  }
}

module.exports = {
  resolveConfig,
  resolveDebugConfig,
  resolveDetailBenchmarkConfig,
  resolveSingleDetailConfig,
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
  canonicalizeUrl,
  extractNotionPageId,
  canonicalizeNotionProductUrl,
  resolveCardProductUrl,
  evaluateProductUrlCandidate,
  validateCatalog,
  normalizeProduct,
  normalizeCatalog,
  serializeCatalog,
  diffCatalog,
  collectProductCardCandidates,
  getCollectionRenderStats,
  waitForProductCards,
  collectProductUrls,
  extractProductDetail,
  parseProductText,
  shouldAbortDetailResource,
  configureDetailResourcePolicy,
  closePageSafely,
  createDetailPageSlot,
  processDetailPage,
  fetchProductCatalog,
  discoverProductUrlsWithRetries,
  benchmarkDetailMode,
  benchmarkDetails,
  diagnoseSingleDetail,
  debugCards,
  formatCatalogDiff,
  sendNtfyNotification,
  runOnce,
  isLockStaleOrInvalid,
  createDesktopUserAgent,
  getChromiumLaunchOptions,
  getBrowserContextOptions,
  attachPageDiagnostics,
  DEFAULT_MIN_TEXT_LENGTH,
  DEFAULT_DETAIL_CONCURRENCY,
  DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS,
  DEFAULT_DETAIL_READY_TIMEOUT_MS,
  DEFAULT_DETAIL_HARD_TIMEOUT_MS,
  MIN_PRODUCT_COUNT,
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
