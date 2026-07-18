'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const DEFAULT_STATE_FILE = './notion-watcher-state.json';
const DEFAULT_LOCK_FILE = './notion-watcher.lock';
const DEFAULT_OPERATION_STATE_FILE = './notion-watcher-operation-state.json';
const DEFAULT_MIN_TEXT_LENGTH = 50;
const DEFAULT_SNAPSHOT_DIR = './snapshots';
const DEFAULT_DETAIL_CONCURRENCY = 1;
const DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS = 20 * 1000;
const DEFAULT_DETAIL_READY_TIMEOUT_MS = 10 * 1000;
const DEFAULT_DETAIL_READY_POLL_INTERVAL_MS = 250;
const DEFAULT_DETAIL_HARD_TIMEOUT_MS = 35 * 1000;
const DEFAULT_MAIN_TO_DETAIL_DELAY_MS = 10 * 1000;
const DEFAULT_DETAIL_HYDRATION_BACKOFF_MS = 50 * 1000;
const DEFAULT_DETAIL_HYDRATION_MAX_RETRIES = 1;
const DEFAULT_DETAIL_SESSION_RECOVERY_MAX_RETRIES = 2;
const DEFAULT_DETAIL_MAX_PAGES_PER_SESSION = 2;
const DEFAULT_DETAIL_SESSION_ROTATION_DELAY_MS = 3 * 1000;
const DEFAULT_DETAIL_CONSECUTIVE_STALL_THRESHOLD = 1;
const DEFAULT_DETAIL_RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
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
// Not an optimization allowlist: this analysis-failure marker only forces the
// conservative detail path until the page has a verified comparison result.
const ANALYSIS_UNKNOWN_PAGE_IDS = new Set(['39f3f4a9f6268046b716ee5e88e71956']);

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
  const detailReadyPollIntervalMs = parsePositiveIntegerEnv(env, 'DETAIL_READY_POLL_INTERVAL_MS', DEFAULT_DETAIL_READY_POLL_INTERVAL_MS);
  const detailHardTimeoutMs = parsePositiveIntegerEnv(env, 'DETAIL_HARD_TIMEOUT_MS', DEFAULT_DETAIL_HARD_TIMEOUT_MS);
  const mainToDetailDelayMs = parsePositiveIntegerEnv(env, 'MAIN_TO_DETAIL_DELAY_MS', DEFAULT_MAIN_TO_DETAIL_DELAY_MS);
  const detailBlockHeavyResources = parseBooleanEnv(env.DETAIL_BLOCK_HEAVY_RESOURCES, true);
  const detailServiceWorkers = parseDetailServiceWorkers(env.DETAIL_SERVICE_WORKERS);
  const detailHydrationBackoffMs = parsePositiveIntegerEnv(env, 'DETAIL_HYDRATION_BACKOFF_MS', DEFAULT_DETAIL_HYDRATION_BACKOFF_MS);
  const detailHydrationMaxRetries = parseNonNegativeIntegerEnv(env, 'DETAIL_HYDRATION_MAX_RETRIES', DEFAULT_DETAIL_HYDRATION_MAX_RETRIES);
  const detailSessionRecoveryMaxRetries = parseNonNegativeIntegerEnv(env, 'DETAIL_SESSION_RECOVERY_MAX_RETRIES', DEFAULT_DETAIL_SESSION_RECOVERY_MAX_RETRIES);
  const detailMaxPagesPerSession = parsePositiveIntegerEnv(env, 'DETAIL_MAX_PAGES_PER_SESSION', DEFAULT_DETAIL_MAX_PAGES_PER_SESSION);
  const detailSessionRotationDelayMs = parsePositiveIntegerEnv(env, 'DETAIL_SESSION_ROTATION_DELAY_MS', DEFAULT_DETAIL_SESSION_ROTATION_DELAY_MS);
  const detailConsecutiveStallThreshold = parsePositiveIntegerEnv(env, 'DETAIL_CONSECUTIVE_STALL_THRESHOLD', DEFAULT_DETAIL_CONSECUTIVE_STALL_THRESHOLD);
  const detailRecheckIntervalMs = parsePositiveIntegerEnv(env, 'DETAIL_RECHECK_INTERVAL_MS', DEFAULT_DETAIL_RECHECK_INTERVAL_MS);

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
    detailReadyPollIntervalMs,
    detailHardTimeoutMs,
    detailReusePages: parseBooleanEnv(env.DETAIL_REUSE_PAGES, true),
    mainToDetailDelayMs,
    detailBlockHeavyResources,
    detailServiceWorkers,
    detailHydrationBackoffMs,
    detailHydrationMaxRetries,
    detailSessionRecoveryMaxRetries,
    detailMaxPagesPerSession,
    detailSessionRotationDelayMs,
    detailConsecutiveStallThreshold,
    detailRecheckIntervalMs,
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
    detailReadyPollIntervalMs: parsePositiveIntegerEnv(env, 'DETAIL_READY_POLL_INTERVAL_MS', DEFAULT_DETAIL_READY_POLL_INTERVAL_MS),
    detailHardTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_HARD_TIMEOUT_MS', DEFAULT_DETAIL_HARD_TIMEOUT_MS)
  };
}

function resolveSingleDetailConfig(env = process.env) {
  const url = env.DETAIL_DIAGNOSTIC_URL || env.DETAIL_BENCHMARK_URL;
  if (!url) throw new Error('필수 환경변수가 누락되었습니다: DETAIL_DIAGNOSTIC_URL');
  return {
    url,
    debugDom: true,
    detailNavigationTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_NAVIGATION_TIMEOUT_MS', DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS),
    detailReadyTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_READY_TIMEOUT_MS', DEFAULT_DETAIL_READY_TIMEOUT_MS),
    detailReadyPollIntervalMs: parsePositiveIntegerEnv(env, 'DETAIL_READY_POLL_INTERVAL_MS', DEFAULT_DETAIL_READY_POLL_INTERVAL_MS),
    detailHardTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_HARD_TIMEOUT_MS', DEFAULT_DETAIL_HARD_TIMEOUT_MS),
    detailBlockHeavyResources: parseBooleanEnv(env.DETAIL_BLOCK_HEAVY_RESOURCES, true),
    detailServiceWorkers: parseDetailServiceWorkers(env.DETAIL_SERVICE_WORKERS)
  };
}

function resolveTransitionDiagnosticConfig(env = process.env) {
  const base = resolveDebugConfig(env);
  return {
    ...base,
    // This diagnostic must exercise the same quiet operational path as a full run.
    debugDom: false,
    pageFetchMaxAttempts: parsePositiveIntegerEnv(env, 'PAGE_FETCH_MAX_ATTEMPTS', DEFAULT_PAGE_FETCH_MAX_ATTEMPTS),
    pageFetchRetryDelaysMs: parseRetryDelaysEnv(env.PAGE_FETCH_RETRY_DELAYS_MS, DEFAULT_PAGE_FETCH_RETRY_DELAYS_MS),
    detailNavigationTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_NAVIGATION_TIMEOUT_MS', DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS),
    detailReadyTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_READY_TIMEOUT_MS', DEFAULT_DETAIL_READY_TIMEOUT_MS),
    detailReadyPollIntervalMs: parsePositiveIntegerEnv(env, 'DETAIL_READY_POLL_INTERVAL_MS', DEFAULT_DETAIL_READY_POLL_INTERVAL_MS),
    detailHardTimeoutMs: parsePositiveIntegerEnv(env, 'DETAIL_HARD_TIMEOUT_MS', DEFAULT_DETAIL_HARD_TIMEOUT_MS),
    detailConcurrency: parsePositiveIntegerEnv(env, 'DETAIL_CONCURRENCY', DEFAULT_DETAIL_CONCURRENCY),
    detailReusePages: parseBooleanEnv(env.DETAIL_REUSE_PAGES, true),
    detailBlockHeavyResources: parseBooleanEnv(env.DETAIL_BLOCK_HEAVY_RESOURCES, true),
    detailServiceWorkers: parseDetailServiceWorkers(env.DETAIL_SERVICE_WORKERS),
    detailHydrationBackoffMs: parsePositiveIntegerEnv(env, 'DETAIL_HYDRATION_BACKOFF_MS', DEFAULT_DETAIL_HYDRATION_BACKOFF_MS),
    detailHydrationMaxRetries: parseNonNegativeIntegerEnv(env, 'DETAIL_HYDRATION_MAX_RETRIES', DEFAULT_DETAIL_HYDRATION_MAX_RETRIES),
    detailSessionRecoveryMaxRetries: parseNonNegativeIntegerEnv(env, 'DETAIL_SESSION_RECOVERY_MAX_RETRIES', DEFAULT_DETAIL_SESSION_RECOVERY_MAX_RETRIES),
    detailMaxPagesPerSession: parsePositiveIntegerEnv(env, 'DETAIL_MAX_PAGES_PER_SESSION', DEFAULT_DETAIL_MAX_PAGES_PER_SESSION),
    detailSessionRotationDelayMs: parsePositiveIntegerEnv(env, 'DETAIL_SESSION_ROTATION_DELAY_MS', DEFAULT_DETAIL_SESSION_ROTATION_DELAY_MS),
    detailConsecutiveStallThreshold: parsePositiveIntegerEnv(env, 'DETAIL_CONSECUTIVE_STALL_THRESHOLD', DEFAULT_DETAIL_CONSECUTIVE_STALL_THRESHOLD),
    mainToDetailDelayMs: parsePositiveIntegerEnv(env, 'MAIN_TO_DETAIL_DELAY_MS', DEFAULT_MAIN_TO_DETAIL_DELAY_MS)
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

function parseNonNegativeIntegerEnv(env, name, defaultValue) {
  const value = Number.parseInt(env[name] ?? `${defaultValue}`, 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name}는 0 이상의 숫자여야 합니다.`);
  return value;
}

function parseDetailServiceWorkers(value) {
  const normalized = `${value || 'block'}`.trim().toLowerCase();
  if (normalized !== 'block' && normalized !== 'allow') {
    throw new Error('DETAIL_SERVICE_WORKERS는 block 또는 allow여야 합니다.');
  }
  return normalized;
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

function getMemoryStats() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    osFreeMemory: os.freemem()
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
  // These are essential to diagnosing an empty Notion shell and must never be hidden.
  if (/notion[^\s]*\/api\/v3\/|\/api\/v3\/|\/_assets\/.*(?:\.js|js\/)|\.js(?:[?#\s]|$)/i.test(message)) return false;
  return IGNORED_OPERATION_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(message));
}

function attachPageDiagnostics(page, label = 'main-page', options = {}) {
  const entries = [];
  const verbose = Boolean(options.verbose);
  const record = (level, message) => {
    const ignored = isIgnoredOperationDiagnostic(message);
    const entry = { level, message, ignored };
    entries.push(entry);
    if (entries.length > 100) entries.shift();
    if (verbose) log(level, message);
  };
  page.on('pageerror', (error) => record('ERROR', `[${label}] pageerror: URL=${page.url?.() || 'unknown'} HTTP=none resourceType=document errorText=${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      record(message.type() === 'error' ? 'ERROR' : 'WARN', `[${label}] console ${message.type()}: URL=${page.url?.() || 'unknown'} HTTP=none resourceType=console errorText=${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => {
    record('WARN', `[${label}] requestfailed: URL=${request.url()} HTTP=none resourceType=${request.resourceType?.() || 'unknown'} errorText=${request.failure()?.errorText || 'unknown error'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const request = response.request?.();
      record('WARN', `[${label}] response: URL=${response.url()} HTTP=${response.status()} resourceType=${request?.resourceType?.() || 'unknown'} errorText=none`);
    }
  });
  return {
    entries,
    flush(limit = 30) {
      if (verbose) return;
      entries.filter((entry) => !entry.ignored).slice(-limit).forEach((entry) => log(entry.level, entry.message));
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
  return `${value || ''}`.normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeStatus(value) {
  const text = normalizeValue(value);
  if (/일부\s*(?:상품\s*)?품절/i.test(text)) return 'partially_sold_out';
  if (/일시\s*품절/i.test(text)) return 'temporarily_sold_out';
  if (/품절|sold\s*out|out\s*of\s*stock/i.test(text)) return 'sold_out';
  if (/판매\s*중|for\s*sale|in\s*stock|available/i.test(text)) return 'for_sale';
  if (/판매\s*종료|discontinued|closed/i.test(text)) return 'discontinued';
  return text.toLowerCase();
}

function formatStatusLabel(value) {
  const status = normalizeStatus(value);
  return {
    for_sale: '판매 중',
    sold_out: '품절',
    temporarily_sold_out: '일시 품절',
    partially_sold_out: '일부 상품 품절',
    discontinued: '판매 종료'
  }[status] || normalizeValue(value) || '(없음)';
}

const CARD_OPTION_LINE_PATTERN = /^([^()（）\r\n]+?)\s*[\(（]\s*(일시\s*품절|판매\s*중|품절|FOR\s*SALE|SOLD\s*OUT)\s*[\)）]$/i;
const CARD_STATUS_LINE_PATTERN = /^(일부\s*(?:상품\s*)?품절|일시\s*품절|판매\s*중|품절|FOR\s*SALE|SOLD\s*OUT)$/i;

function parseCardVisibleVariants(text, optionRowTexts = []) {
  const lines = `${text || ''}`.normalize('NFKC').replace(/\u00a0/g, ' ').split(/\r?\n/)
    .map(normalizeValue).filter(Boolean);
  const candidates = [...lines, ...(optionRowTexts || []).map(normalizeValue)];
  const variants = [];
  for (const candidate of candidates) {
    const match = candidate.match(CARD_OPTION_LINE_PATTERN);
    if (!match) continue;
    if (CARD_STATUS_LINE_PATTERN.test(normalizeValue(match[1]))) continue;
    if (/\d{1,3}(?:,\d{3})*\s*원|₩\s*\d/i.test(match[1])) continue;
    variants.push({ name: normalizeValue(match[1]), status: normalizeStatus(match[2]) });
  }
  return [...new Map(variants.map((variant) => [`${variant.name}\u0000${variant.status}`, variant])).values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'ko-KR') || a.status.localeCompare(b.status));
}

function normalizeVariants(variants) {
  const variantMap = new Map((Array.isArray(variants) ? variants : []).map((variant) => [normalizeValue(variant?.name), {
    name: normalizeValue(variant?.name),
    status: normalizeStatus(variant?.status)
  }]));
  return [...variantMap.values()].filter((variant) => variant.name).sort((a, b) =>
    a.name.localeCompare(b.name, 'ko-KR') || a.status.localeCompare(b.status, 'ko-KR'));
}

function normalizeProduct(product) {
  const legacy = !Array.isArray(product.visibleVariants) || !Array.isArray(product.fullVariants) ||
    !Number.isInteger(product.visibleVariantCount) || !Number.isInteger(product.totalVariantCount);
  const legacyVariants = normalizeVariants(product.characters);
  const visibleVariants = legacy ? legacyVariants : normalizeVariants(product.visibleVariants);
  const fullVariants = legacy ? legacyVariants : normalizeVariants(product.fullVariants);
  const visibleVariantCount = legacy ? visibleVariants.length : product.visibleVariantCount;
  const totalVariantCount = legacy ? fullVariants.length : product.totalVariantCount;
  const hiddenVariantCount = legacy ? 0 : Math.max(0, Number.isInteger(product.hiddenVariantCount)
    ? product.hiddenVariantCount : totalVariantCount - visibleVariantCount);
  const url = canonicalizeUrl(product.url, product.url);
  return {
    pageId: normalizeValue(product.pageId) || extractNotionPageId(url, url) || '',
    url,
    name: normalizeValue(product.name),
    price: normalizeValue(product.price).replace(/\s+/g, ''),
    status: normalizeStatus(product.status),
    characters: fullVariants,
    visibleVariants,
    fullVariants,
    visibleVariantCount,
    totalVariantCount,
    hiddenVariantCount,
    knownHiddenVariants: legacy ? false : Boolean(product.knownHiddenVariants),
    cardParseComplete: legacy ? false : Boolean(product.cardParseComplete),
    cardHash: normalizeValue(product.cardHash),
    detailReason: legacy ? 'legacy-state-migration' : (product.detailReason == null ? null : normalizeValue(product.detailReason)),
    detailSource: legacy ? 'legacy' : (['card', 'detail', 'legacy'].includes(product.detailSource) ? product.detailSource : 'card'),
    lastDetailCheckedAt: legacy ? null : (product.lastDetailCheckedAt || null)
  };
}

function validateCatalogMetadata(catalog) {
  validateCatalog(catalog);
  for (const product of catalog.products) {
    const invalid = [];
    if (!normalizeValue(product.pageId)) invalid.push('pageId');
    if (!Array.isArray(product.visibleVariants)) invalid.push('visibleVariants');
    if (!Array.isArray(product.fullVariants)) invalid.push('fullVariants');
    if (!Number.isInteger(product.visibleVariantCount)) invalid.push('visibleVariantCount');
    if (!Number.isInteger(product.totalVariantCount)) invalid.push('totalVariantCount');
    if (!Number.isInteger(product.hiddenVariantCount) || product.hiddenVariantCount < 0) invalid.push('hiddenVariantCount');
    if (typeof product.knownHiddenVariants !== 'boolean') invalid.push('knownHiddenVariants');
    if (typeof product.cardParseComplete !== 'boolean') invalid.push('cardParseComplete');
    if (product.detailReason !== null && typeof product.detailReason !== 'string') invalid.push('detailReason');
    if (!['card', 'detail', 'legacy'].includes(product.detailSource)) invalid.push('detailSource');
    if (invalid.length) throw new PageFetchError('catalog metadata validation failed',
      `${product.name || product.url}: ${invalid.join(', ')}`);
  }
  return catalog;
}

function normalizeCatalog(products) {
  if (!Array.isArray(products) && Array.isArray(products?.products)) products = products.products;
  return {
    version: 1,
    products: products.map(normalizeProduct).sort((a, b) =>
      a.url.localeCompare(b.url) || a.name.localeCompare(b.name, 'ko-KR'))
  };
}

function parseProductCard(candidate, mainUrl) {
  const resolved = resolveCardProductUrl(candidate, mainUrl);
  if (!resolved?.url) return null;
  const url = canonicalizeNotionProductUrl(resolved.url, mainUrl);
  const originalText = `${candidate.innerText || ''}`.normalize('NFKC').replace(/\u00a0/g, ' ');
  const rawText = normalizeValue(originalText);
  const firstFieldIndex = rawText.search(/\d{1,3}(?:,\d{3})*\s*원|₩\s*\d|판매\s*중|품절|SOLD\s*OUT|FOR\s*SALE/i);
  const cardTitle = normalizeValue(firstFieldIndex > 0 ? rawText.slice(0, firstFieldIndex) : '');
  const parsed = parseProductText(cardTitle, rawText, []);
  const lines = originalText.split(/\r?\n/).map(normalizeValue).filter(Boolean);
  const statusLine = lines.find((line) => CARD_STATUS_LINE_PATTERN.test(line));
  const visibleVariants = parseCardVisibleVariants(originalText, candidate.optionRowTexts || []);
  const visibleVariantCount = visibleVariants.length;
  const explicitTotal = [
    ...rawText.matchAll(/(?:총|전체)\s*(\d+)\s*(?:개|종)/gi),
    ...rawText.matchAll(/(\d+)\s*(?:개|종)\s*(?:옵션|캐릭터|디자인)/gi)
  ].map((match) => Number.parseInt(match[1], 10)).filter(Number.isFinite);
  const hiddenCount = Number.parseInt(rawText.match(/(?:외|\+)\s*(\d+)\s*(?:개|종)?/i)?.[1] || '0', 10);
  const totalVariantCount = Math.max(visibleVariantCount, ...explicitTotal, visibleVariantCount + hiddenCount);
  const cardStatus = statusLine || parsed.status;
  const cardIncomplete = !parsed.name || !parsed.price || !cardStatus;
  const requiresDetail = visibleVariantCount >= 6 || totalVariantCount > visibleVariantCount ||
    /일부\s*(?:상품\s*)?품절|일시\s*품절/i.test(rawText) || cardIncomplete;
  const stableCard = {
    url, name: parsed.name, price: parsed.price, status: cardStatus,
    characters: visibleVariants, visibleVariantCount, totalVariantCount, cardIncomplete
  };
  return { ...stableCard, cardHash: createHash(JSON.stringify(stableCard)), requiresDetail, rawText };
}

function buildHybridDetailPlan(discovery, previousState, config = {}) {
  const cardsByUrl = new Map();
  for (const candidate of discovery.candidates || []) {
    const card = parseProductCard(candidate, config.notionPageUrl);
    if (card) cardsByUrl.set(card.url, card);
  }
  const previousMetadata = previousState?.productMetadata || {};
  const previousProducts = new Map((previousState?.catalog?.products || []).map((product) => [product.url, product]));
  const cards = discovery.urls.map((url) => cardsByUrl.get(url) || {
    url, name: '', price: '', status: '', characters: [], visibleVariantCount: 0,
    totalVariantCount: 0, cardIncomplete: true, requiresDetail: true,
    cardHash: createHash(JSON.stringify({ url, missing: true }))
  });
  const detailReasonByUrl = {};
  const detailUrls = cards.filter((card) => {
    const previous = previousMetadata[card.url];
    const pageId = extractNotionPageId(card.url, card.url);
    let reason = '';
    if (card.cardIncomplete) reason = 'card-parse-incomplete';
    else if (ANALYSIS_UNKNOWN_PAGE_IDS.has(pageId)) reason = 'unknown-analysis';
    else if (previous?.knownHiddenVariants || Number(previous?.totalVariantCount || 0) > card.visibleVariantCount) {
      reason = 'known-hidden-variants';
    } else if (card.visibleVariantCount >= 6) reason = 'visible-limit-reached';
    if (reason) detailReasonByUrl[card.url] = reason;
    return Boolean(reason);
  }).map((card) => card.url);
  return { cards, detailUrls, detailReasonByUrl, previousMetadata, previousProducts };
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
      const rawInnerText = element.innerText || element.textContent || '';
      const text = clean(rawInnerText);
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
      return { element, score, text, rawInnerText, role, className, hasImage, hasProductText, clickable, galleryLike, collectionItem };
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
      const optionPattern = /^([^()（）\r\n]+?)\s*[\(（]\s*(일시\s*품절|판매\s*중|품절|FOR\s*SALE|SOLD\s*OUT)\s*[\)）]$/i;
      const statusPatternExact = /^(일부\s*(?:상품\s*)?품절|일시\s*품절|판매\s*중|품절|FOR\s*SALE|SOLD\s*OUT)$/i;
      const optionRowTexts = [...new Set([...item.element.querySelectorAll('*')].map((node) =>
        `${node.textContent || ''}`.normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
      ).filter((candidate) => {
        const match = candidate.match(optionPattern);
        return match && !statusPatternExact.test(match[1].trim()) && !/\d{1,3}(?:,\d{3})*\s*원/.test(match[1]);
      }))];
      return {
        id: index, score: item.score, outerHTML: item.element.outerHTML.slice(0, 4000), innerText: item.rawInnerText,
        optionRowTexts,
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

async function configureDetailResourcePolicy(context, enabled = true) {
  if (!enabled) return;
  await context.route('**/*', async (route) => {
    if (shouldAbortDetailResource(route.request().resourceType())) await route.abort();
    else await route.continue();
  });
}

function logMemoryStage(stage) {
  const memory = getMemoryStats();
  log('INFO', `${stage} 메모리: ${JSON.stringify({ rss: memory.rss, heapUsed: memory.heapUsed, osFreeMemory: memory.osFreeMemory })}`);
}

async function createDetailBrowserSession(config = {}) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(getChromiumLaunchOptions());
  log('INFO', '상세 browser 생성 완료');
  logMemoryStage('상세 browser 생성 완료');
  try {
    const browserContextOptions = getBrowserContextOptions(browser);
    const contextSettings = buildDetailContextSettings(browser, config);
    log('INFO', `상세 context 설정: ${JSON.stringify(contextSettings)}`);
    const context = await browser.newContext({
      ...browserContextOptions,
      serviceWorkers: contextSettings.serviceWorkers
    });
    await configureDetailResourcePolicy(context, contextSettings.blockHeavyResources);
    log('INFO', '상세 context 생성 완료');
    logMemoryStage('상세 context 생성 완료');
    return { browser, context };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function closeDetailBrowserSession(session) {
  if (!session) return;
  await session.context.close().catch(() => undefined);
  await session.browser.close().catch(() => undefined);
}

async function runDetailPreflight(url, config, session, attempt, maxAttempts) {
  const page = await session.context.newPage();
  const startedAt = Date.now();
  log('INFO', `상세 preflight 시작 (${attempt}/${maxAttempts}): ${url}`);
  try {
    const product = await processDetailPage(page, url, {
      ...config,
      detailAttemptIsLast: attempt === maxAttempts
    }, `상세 preflight [workerId=preflight, pageId=${attempt}]`);
    return { product, durationMs: Date.now() - startedAt };
  } finally {
    await closePageSafely(page);
  }
}

function buildDetailContextSettings(browser, config = {}) {
  return {
    ...getBrowserContextOptions(browser),
    serviceWorkers: config.detailServiceWorkers || 'block',
    blockHeavyResources: config.detailBlockHeavyResources !== false
  };
}

const DETAIL_DIAGNOSTICS = Symbol('detailDiagnostics');

function getDetailPageDiagnostics(page, label, config) {
  if (typeof page.on !== 'function') return { entries: [], flush: () => undefined };
  if (!page[DETAIL_DIAGNOSTICS]) {
    page[DETAIL_DIAGNOSTICS] = attachPageDiagnostics(page, label, { verbose: Boolean(config.debugDom) });
  }
  return page[DETAIL_DIAGNOSTICS];
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

async function collectDetailSnapshot(page, expectedPageId) {
  return page.evaluate((pageId) => {
    const text = document.body?.innerText || '';
    const compactUrl = location.href.replace(/-/g, '').toLowerCase();
    return {
      currentUrl: location.href,
      documentReadyState: document.readyState,
      bodyTextLength: text.trim().length,
      bodyTextPreview: text.slice(0, 1000),
      priceMatched: /\d{1,3}(?:,\d{3})*\s*원|₩\s*\d[\d,]*/.test(text),
      statusMatched: /판매\s*중|품절|SOLD\s*OUT|FOR\s*SALE|IN\s*STOCK|OUT\s*OF\s*STOCK/i.test(text),
      expectedPageId: pageId,
      expectedPageIdMatched: !pageId || compactUrl.includes(pageId)
    };
  }, expectedPageId);
}

function isUsableDetailSnapshot(snapshot = {}) {
  return snapshot.expectedPageIdMatched === true && Number(snapshot.bodyTextLength) >= 20;
}

function isHydrationStallSnapshot(snapshot = {}) {
  return snapshot.expectedPageIdMatched === true && Number(snapshot.bodyTextLength) < 20;
}

function shouldTripHydrationCircuitBreaker(count, threshold = 2) {
  return Number(count) >= Number(threshold);
}

function shouldRotateDetailSession(processedCount, maxPagesPerSession = DEFAULT_DETAIL_MAX_PAGES_PER_SESSION) {
  return Number(processedCount) >= Number(maxPagesPerSession);
}

function advanceHydrationCircuitState(state, outcome, maxRecoveries = DEFAULT_DETAIL_SESSION_RECOVERY_MAX_RETRIES) {
  const next = { consecutiveStalls: state?.consecutiveStalls || 0, recoveries: state?.recoveries || 0 };
  if (outcome === 'success') return { ...next, consecutiveStalls: 0, action: 'continue' };
  if (outcome !== 'hydration-stall') return { ...next, consecutiveStalls: 0, action: 'continue' };
  next.consecutiveStalls += 1;
  const observedStalls = next.consecutiveStalls;
  if (!shouldTripHydrationCircuitBreaker(observedStalls)) return { ...next, observedStalls, action: 'continue' };
  if (next.recoveries >= maxRecoveries) return { ...next, observedStalls, action: 'abort' };
  return { consecutiveStalls: 0, recoveries: next.recoveries + 1, observedStalls, action: 'recover' };
}

async function processDetailPage(page, url, config, logPrefix) {
  const navigationTimeoutMs = config.detailNavigationTimeoutMs || DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS;
  const readyTimeoutMs = config.detailReadyTimeoutMs || DEFAULT_DETAIL_READY_TIMEOUT_MS;
  const readyPollIntervalMs = config.detailReadyPollIntervalMs || DEFAULT_DETAIL_READY_POLL_INTERVAL_MS;
  const hardTimeoutMs = config.detailHardTimeoutMs || DEFAULT_DETAIL_HARD_TIMEOUT_MS;
  page.setDefaultNavigationTimeout(navigationTimeoutMs);
  page.setDefaultTimeout(readyTimeoutMs);
  const pageDiagnostics = getDetailPageDiagnostics(page, logPrefix, config);
  log('INFO', `${logPrefix} timeout 설정: navigation=${navigationTimeoutMs}ms, ready=${readyTimeoutMs}ms, hard=${hardTimeoutMs}ms`);

  const expectedPageId = extractNotionPageId(url, url);
  const attemptState = { cancelled: false };
  let hardTimer;
  const work = async () => {
    if (!attemptState.cancelled) log('INFO', `${logPrefix} goto 시작`);
    let readyRecoveredAfterTimeout = false;
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
      let diagnostic;
      while (Date.now() - readyStartedAt < readyTimeoutMs) {
        diagnostic = await collectDetailSnapshot(page, expectedPageId);
        if (isUsableDetailSnapshot(diagnostic)) break;
        await page.waitForTimeout(readyPollIntervalMs);
      }
      if (!isUsableDetailSnapshot(diagnostic)) diagnostic = await collectDetailSnapshot(page, expectedPageId);
      if (!isUsableDetailSnapshot(diagnostic)) {
        const error = new Error(`ready timeout after ${readyTimeoutMs}ms`);
        error.name = 'TimeoutError';
        error.detailReadySnapshot = diagnostic;
        throw error;
      }
      if (!attemptState.cancelled) log('INFO', `${logPrefix} ready 완료 (${Date.now() - readyStartedAt}ms)`);
    } catch (error) {
      if (!attemptState.cancelled) {
        const diagnostic = error.detailReadySnapshot || await collectDetailSnapshot(page, expectedPageId)
          .catch(() => ({ diagnosticUnavailable: true }));
        if (isUsableDetailSnapshot(diagnostic)) {
          log('WARN', `${logPrefix} polling timeout 직후 ready 조건 충족, parse를 계속합니다: ${JSON.stringify(diagnostic)}`);
          readyRecoveredAfterTimeout = true;
        } else {
          log('WARN', `${logPrefix} ready 실패 진단: ${JSON.stringify(diagnostic)}`);
          log('WARN', `${logPrefix} ready 실패: ${error.name}: ${error.message} (설정 timeout=${readyTimeoutMs}ms, 실제=${Date.now() - readyStartedAt}ms)`);
          pageDiagnostics.flush(30);
          if (isHydrationStallSnapshot(diagnostic)) {
            if (config.detailAttemptIsLast) {
              const failedHtmlPath = path.resolve(config.debugDir || DEFAULT_DEBUG_DIR, 'detail-page-failed.html');
              try {
                await fs.mkdir(path.dirname(failedHtmlPath), { recursive: true });
                await fs.writeFile(failedHtmlPath, await page.content(), 'utf8');
                log('INFO', `마지막 상세 실패 HTML 저장: ${failedHtmlPath}`);
              } catch (saveError) {
                log('WARN', `마지막 상세 실패 HTML 저장 실패: ${saveError.message}`);
              }
            }
            throw new PageFetchError('hydration stall', `expectedPageIdMatched=true, bodyTextLength=${diagnostic.bodyTextLength}`);
          }
        }
      }
      if (!readyRecoveredAfterTimeout) throw error;
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
  const statusPattern = /일부\s*(?:상품\s*)?품절|일시\s*품절|판매\s*중|품절|SOLD\s*OUT|FOR\s*SALE|IN\s*STOCK|OUT\s*OF\s*STOCK/i;
  const status = normalizedText.match(statusPattern)?.[0] || '';
  const characters = [];
  const optionPattern = /([^|\n,()]{1,80}?)\s*[\(（]\s*(일시\s*품절|판매\s*중|품절|SOLD\s*OUT|FOR\s*SALE|IN\s*STOCK|OUT\s*OF\s*STOCK)\s*[\)）]/gi;
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
  // Keep the parsed body internally for readiness/transition metrics. Catalog
  // normalization deliberately drops this field before hashing or persistence.
  return { url, name: raw.name, price: raw.price, status: raw.status, characters: raw.characters, text: raw.text };
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
      if (page) {
        await closePageSafely(page);
        log('INFO', `메인 page 종료 완료 (${attempt}/${maxAttempts})`);
        logMemoryStage('메인 page 종료 완료');
      }
      await context.close();
      log('INFO', `메인 context 종료 완료 (${attempt}/${maxAttempts})`);
      logMemoryStage('메인 context 종료 완료');
    }
  }
  throw lastError || new PageFetchError('main page fetch failed');
}

async function fetchProductCatalog(notionPageUrl, config = {}) {
  const { chromium } = require('playwright');
  const mainBrowser = await chromium.launch(getChromiumLaunchOptions());
  let discovery;
  try {
    discovery = await discoverProductUrlsWithRetries(mainBrowser, notionPageUrl, config);
  } finally {
    await mainBrowser.close();
    log('INFO', '메인 browser 종료 완료');
    logMemoryStage('메인 browser 종료 완료');
  }

  const hybridNow = config.hybridNow instanceof Date ? config.hybridNow : new Date();
  const hybridPlan = buildHybridDetailPlan(discovery, config.previousState, { ...config, notionPageUrl });
  const urls = hybridPlan.detailUrls;
  const buildHybridResult = (detailProducts) => {
    const detailsByUrl = new Map(detailProducts.filter(Boolean).map((product) => [canonicalizeUrl(product.url, product.url), product]));
    let reusedDetailCount = 0;
    let cardOnlyCount = 0;
    const metadata = {};
    const combined = hybridPlan.cards.map((card) => {
      const previous = hybridPlan.previousMetadata[card.url];
      const previousProduct = hybridPlan.previousProducts.get(card.url);
      const detail = detailsByUrl.get(card.url);
      const detailVariants = detail ? sanitizeAnalysisVariants(detail.characters) : null;
      const fullVariants = detailVariants || card.characters;
      const totalVariantCount = detail ? detailVariants.length : card.visibleVariantCount;
      const hiddenVariantCount = Math.max(0, totalVariantCount - card.visibleVariantCount);
      const knownHiddenVariants = hiddenVariantCount > 0;
      const detailReason = hybridPlan.detailReasonByUrl[card.url] || null;
      const lastDetailCheckedAt = detail ? hybridNow.toISOString() : null;
      if (!detail) cardOnlyCount += 1;
      metadata[card.url] = {
        id: extractNotionPageId(card.url, card.url) || card.url,
        cardHash: card.cardHash,
        name: card.name,
        price: card.price,
        status: normalizeStatus(card.status),
        visibleVariants: card.characters,
        visibleVariantCount: card.visibleVariantCount,
        totalVariantCount,
        hiddenVariantCount,
        knownHiddenVariants,
        cardParseComplete: !card.cardIncomplete,
        detailReason,
        lastDetailCheckedAt,
        fullVariants: normalizeProduct({ characters: fullVariants }).characters
      };
      return {
        pageId: extractNotionPageId(card.url, card.url) || '',
        url: card.url,
        name: detail?.name || card.name || previousProduct?.name || '',
        price: detail?.price || card.price || previousProduct?.price || '',
        status: detail?.status || card.status || previousProduct?.status || '',
        characters: fullVariants,
        visibleVariants: card.characters,
        fullVariants,
        visibleVariantCount: card.visibleVariantCount,
        totalVariantCount,
        hiddenVariantCount,
        knownHiddenVariants,
        cardParseComplete: !card.cardIncomplete,
        cardHash: card.cardHash,
        detailReason,
        detailSource: detail ? 'detail' : 'card',
        lastDetailCheckedAt
      };
    });
    const catalog = validateCatalogMetadata(normalizeCatalog(combined));
    catalog.productMetadata = metadata;
    const reasons = Object.values(hybridPlan.detailReasonByUrl);
    catalog.hybridSummary = {
      totalProducts: hybridPlan.cards.length,
      cardOnlyCount,
      reusedDetailCount,
      visibleLimitDetailCount: reasons.filter((reason) => reason === 'visible-limit-reached').length,
      knownHiddenDetailCount: reasons.filter((reason) => reason === 'known-hidden-variants').length,
      unknownDetailCount: reasons.filter((reason) => reason === 'unknown-analysis').length,
      detailFetchCount: detailProducts.filter(Boolean).length,
      detailTargetCount: urls.length,
      detailSuccessCount: detailProducts.filter(Boolean).length,
      hydrationStallCount: 0
    };
    return catalog;
  };
  if (!urls.length) return buildHybridResult([]);

  await sleep(config.mainToDetailDelayMs || DEFAULT_MAIN_TO_DETAIL_DELAY_MS);
  let detailSession = await createDetailBrowserSession(config);
  let detailContext = detailSession.context;
  try {
    if (!urls.length) throw new PageFetchError('product detail URLs not found');

    const products = new Array(urls.length);
    const failures = [];
    const detailConcurrency = 1;
    const detailStartedAt = Date.now();
    const detailDurationsMs = [];
    const hydrationMaxRetries = config.detailHydrationMaxRetries ?? DEFAULT_DETAIL_HYDRATION_MAX_RETRIES;
    const preflightMaxAttempts = hydrationMaxRetries + 1;
    for (let attempt = 1; attempt <= preflightMaxAttempts; attempt += 1) {
      try {
        const preflight = await runDetailPreflight(urls[0], config, detailSession, attempt, preflightMaxAttempts);
        products[0] = preflight.product;
        detailDurationsMs.push(preflight.durationMs);
        log('INFO', attempt > 1
          ? `preflight 복구 성공: ${preflight.product.name}`
          : `상세 preflight 성공: ${preflight.product.name}`);
        break;
      } catch (error) {
        const failure = createPageFetchError(error);
        if (failure.reason !== 'hydration stall' || attempt === preflightMaxAttempts) throw failure;
        log('WARN', '상세 preflight hydration stall 감지');
        await closeDetailBrowserSession(detailSession);
        const backoffMs = config.detailHydrationBackoffMs || DEFAULT_DETAIL_HYDRATION_BACKOFF_MS;
        log('INFO', `${Math.round(backoffMs / 1000)}초 cooldown 시작`);
        await sleep(backoffMs);
        detailSession = await createDetailBrowserSession(config);
        detailContext = detailSession.context;
        log('INFO', 'hydration 재시도용 새 상세 browser 생성 완료');
      }
    }
    const reusePages = config.detailReusePages !== false;
    log('INFO', `상세 대상 조회 시작: URL ${urls.length}개, 동시성 ${detailConcurrency}`);
    let cursor = 1;
    const retryQueue = [];
    const hydrationResumeQueue = [];
    let consecutiveHydrationStalls = 0;
    let hydrationStallCount = 0;
    let hydrationRecoveryCount = 0;
    const sessionRecoveryMaxRetries = config.detailSessionRecoveryMaxRetries ?? DEFAULT_DETAIL_SESSION_RECOVERY_MAX_RETRIES;
    const maxPagesPerSession = config.detailMaxPagesPerSession || DEFAULT_DETAIL_MAX_PAGES_PER_SESSION;
    const sessionRotationDelayMs = config.detailSessionRotationDelayMs || DEFAULT_DETAIL_SESSION_ROTATION_DELAY_MS;
    const stallThreshold = config.detailConsecutiveStallThreshold || DEFAULT_DETAIL_CONSECUTIVE_STALL_THRESHOLD;
    // The successful preflight used the current browser/context and therefore
    // consumes one slot from that session's bounded lifetime.
    let sessionProcessedCount = 1;
    let traversalAborted = false;
    const activePages = new Set();
    let downgradedToSerial = false;
    const firstWaveOutcomes = new Map();
    let resolveFirstWave;
    const firstWaveDone = new Promise((resolve) => { resolveFirstWave = resolve; });
    const recordFirstWave = (index, hydrationStall) => {
      if (index > 1 || firstWaveOutcomes.has(index)) return;
      firstWaveOutcomes.set(index, hydrationStall);
      if (firstWaveOutcomes.size === Math.min(2, urls.length)) resolveFirstWave();
    };
    // URL 0 was already completed by preflight; include it in the first-wave
    // barrier so concurrency=2 cannot wait forever for a worker-owned index 0.
    recordFirstWave(0, false);
    const worker = async (workerIndex) => {
      const workerId = workerIndex + 1;
      let pageSlot = createDetailPageSlot(detailContext);
      try {
        while (!traversalAborted && (retryQueue.length > 0 || cursor < urls.length || hydrationResumeQueue.length > 0)) {
          if (shouldRotateDetailSession(sessionProcessedCount, maxPagesPerSession)) {
            log('INFO', `정상 세션 순환: ${sessionProcessedCount}개 처리 완료`);
            const rotatingPage = pageSlot.current().page;
            if (rotatingPage) activePages.delete(rotatingPage);
            await pageSlot.discard();
            await closeDetailBrowserSession(detailSession);
            await sleep(sessionRotationDelayMs);
            detailSession = await createDetailBrowserSession(config);
            detailContext = detailSession.context;
            pageSlot = createDetailPageSlot(detailContext);
            sessionProcessedCount = 0;
            consecutiveHydrationStalls = 0;
          }
          if (!retryQueue.length && cursor >= urls.length && hydrationResumeQueue.length) {
            if (hydrationRecoveryCount >= sessionRecoveryMaxRetries) {
              const pending = hydrationResumeQueue.splice(0);
              pending.forEach((index) => failures.push({ url: urls[index], reason: 'hydration stall' }));
              traversalAborted = true;
              log('ERROR', `복구 한도 초과로 상세 대상 순회 중단: 실패 지점=${pending[0] + 1}/${urls.length}, 남은 상품=${pending.length}`);
              break;
            } else {
            await pageSlot.discard();
            await closeDetailBrowserSession(detailSession);
            const backoffMs = config.detailHydrationBackoffMs || DEFAULT_DETAIL_HYDRATION_BACKOFF_MS;
            log('WARN', `남은 hydration stall ${hydrationResumeQueue.length}개 재개를 위해 상세 세션을 재생성합니다.`);
            await sleep(backoffMs);
            detailSession = await createDetailBrowserSession(config);
            detailContext = detailSession.context;
            pageSlot = createDetailPageSlot(detailContext);
            retryQueue.push(...hydrationResumeQueue.splice(0));
            consecutiveHydrationStalls = 0;
            sessionProcessedCount = 0;
            hydrationRecoveryCount += 1;
            log('WARN', `상세 session 복구: ${hydrationRecoveryCount}/${sessionRecoveryMaxRetries}`);
            }
          }
          const index = retryQueue.length > 0 ? retryQueue.shift() : cursor++;
          const url = urls[index];
          const position = index + 1;
          const productStartedAt = Date.now();
          const hardTimeoutMs = config.detailHardTimeoutMs || DEFAULT_DETAIL_HARD_TIMEOUT_MS;
          const deadline = productStartedAt + hardTimeoutMs;
          log('INFO', `상세 페이지 조회 ${position}/${urls.length}: ${url} (workerId=${workerId})`);
          let lastError;
          let deferredHydration = false;
          const maxAttempts = config.pageFetchMaxAttempts || DEFAULT_PAGE_FETCH_MAX_ATTEMPTS;
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const remainingMs = deadline - Date.now();
            const minimumAttemptBudgetMs = Math.min(
              config.detailNavigationTimeoutMs || DEFAULT_DETAIL_NAVIGATION_TIMEOUT_MS,
              5000
            ) + (config.detailReadyTimeoutMs || DEFAULT_DETAIL_READY_TIMEOUT_MS) + 2000;
            if (remainingMs < minimumAttemptBudgetMs) {
              lastError = new PageFetchError('detail hard timeout', `${hardTimeoutMs}ms`);
              log('WARN', `상세 페이지 조회 ${position}/${urls.length} 추가 attempt 생략: 남은 ${remainingMs}ms < 최소 예산 ${minimumAttemptBudgetMs}ms`);
              break;
            }
            const allocated = await pageSlot.get(!reusePages);
            const page = allocated.page;
            const pageGeneration = allocated.generation;
            activePages.add(page);
            log('INFO', `상세 page 생성/사용: workerId=${workerId}, pageId=${pageGeneration}, 활성=${activePages.size}, 메모리=${JSON.stringify(getMemoryStats())}`);
            const logPrefix = `상세 페이지 조회 ${position}/${urls.length} [workerId=${workerId}, pageId=${pageGeneration}, attempt=${attempt}]`;
            try {
              products[index] = await processDetailPage(page, url, {
                ...config,
                detailHardTimeoutMs: Math.min(hardTimeoutMs, remainingMs),
                detailAttemptIsLast: attempt === maxAttempts
              }, logPrefix);
              recordFirstWave(index, false);
              if (index <= 1 && detailConcurrency === 2) await firstWaveDone;
              lastError = null;
              consecutiveHydrationStalls = 0;
              sessionProcessedCount += 1;
              const durationMs = Date.now() - productStartedAt;
              detailDurationsMs.push(durationMs);
              log('INFO', `상세 동시성 지표: 활성 page=${activePages.size}, bodyTextLength=${products[index].text.length}, 성공=true`);
              log('INFO', `상세 페이지 조회 ${position}/${urls.length} 완료: ${products[index].name} (${(durationMs / 1000).toFixed(1)}초)`);
              if (reusePages) {
                log('INFO', `${logPrefix} page cleanup 시작 (재사용)`);
                await page.evaluate(() => window.stop()).catch(() => undefined);
                log('INFO', `${logPrefix} page cleanup 완료 (재사용)`);
              } else {
                log('INFO', `${logPrefix} page cleanup 시작`);
                activePages.delete(page);
                await pageSlot.discard();
                log('INFO', `${logPrefix} page cleanup 완료`);
              }
              break;
            } catch (error) {
              lastError = createPageFetchError(error);
              const hydrationStall = lastError.reason === 'hydration stall';
              recordFirstWave(index, hydrationStall);
              if (index <= 1 && detailConcurrency === 2) await firstWaveDone;
              if (detailConcurrency === 2 && firstWaveOutcomes.size === 2 && [...firstWaveOutcomes.values()].every(Boolean)) {
                downgradedToSerial = true;
                log('WARN', '첫 두 상세 page가 hydration stall이므로 남은 실행을 동시성 1로 낮춥니다.');
              }
              log('INFO', `${logPrefix} page cleanup 시작`);
              activePages.delete(page);
              await pageSlot.discard(Math.max(0, Math.min(2000, deadline - Date.now())));
              log('INFO', `${logPrefix} page cleanup 완료`);
              if (hydrationStall) {
                hydrationStallCount += 1;
                consecutiveHydrationStalls += 1;
                log('WARN', `연속 hydration stall: ${consecutiveHydrationStalls}/${stallThreshold}`);
                if (!hydrationResumeQueue.includes(index)) hydrationResumeQueue.push(index);
                deferredHydration = true;
                if (shouldTripHydrationCircuitBreaker(consecutiveHydrationStalls, stallThreshold)) {
                  if (hydrationRecoveryCount >= sessionRecoveryMaxRetries) {
                    traversalAborted = true;
                    deferredHydration = false;
                    hydrationResumeQueue.filter((pendingIndex) => pendingIndex !== index)
                      .forEach((pendingIndex) => failures.push({ url: urls[pendingIndex], reason: 'hydration stall' }));
                    hydrationResumeQueue.length = 0;
                    const remainingCount = retryQueue.length + (urls.length - cursor);
                    log('ERROR', `복구 한도 초과로 상세 대상 순회 중단: 실패 지점=${position}/${urls.length}, 남은 상품=${remainingCount}`);
                    break;
                  }
                  await closeDetailBrowserSession(detailSession);
                  const backoffMs = config.detailHydrationBackoffMs || DEFAULT_DETAIL_HYDRATION_BACKOFF_MS;
                  log('WARN', `hydration stall 세션 폐기: ${consecutiveHydrationStalls}회 감지`);
                  log('WARN', `${Math.round(backoffMs / 1000)}초 cooldown 후 실패 상품부터 재개합니다.`);
                  await sleep(backoffMs);
                  detailSession = await createDetailBrowserSession(config);
                  detailContext = detailSession.context;
                  pageSlot = createDetailPageSlot(detailContext);
                  retryQueue.unshift(...hydrationResumeQueue.splice(0));
                  consecutiveHydrationStalls = 0;
                  sessionProcessedCount = 0;
                  hydrationRecoveryCount += 1;
                  log('WARN', `상세 session 복구: ${hydrationRecoveryCount}/${sessionRecoveryMaxRetries}`);
                }
                break;
              }
              if (downgradedToSerial && workerId !== 1) {
                retryQueue.push(index);
                return;
              }
              if (lastError.reason === 'detail hard timeout') break;
            }
          }
          if (deferredHydration) continue;
          if (lastError) {
            const durationMs = Date.now() - productStartedAt;
            detailDurationsMs.push(durationMs);
          const reason = lastError.reason || lastError.message || 'unknown error';
          failures.push({ url, reason });
          log('INFO', `상세 동시성 지표: 활성 page=${activePages.size}, bodyTextLength=0, 성공=false, reason=${reason}`);
            log('WARN', `상세 페이지 조회 ${position}/${urls.length} 실패: ${reason} (${(durationMs / 1000).toFixed(1)}초)`);
          }
          if (traversalAborted) break;
        }
      } finally {
        const currentPage = pageSlot.current();
        if (currentPage.page) {
          const prefix = `workerId=${workerId}, pageId=${currentPage.generation}`;
          log('INFO', `${prefix} page cleanup 시작`);
          activePages.delete(currentPage.page);
          await pageSlot.discard();
          log('INFO', `${prefix} page cleanup 완료`);
        }
      }
    };
    await Promise.all(Array.from({ length: detailConcurrency }, (_, index) => worker(index)));
    const elapsedMs = Date.now() - detailStartedAt;
    const averageMs = detailDurationsMs.length ? detailDurationsMs.reduce((sum, value) => sum + value, 0) / detailDurationsMs.length : 0;
    log('INFO', `상세 대상 조회 완료: 성공 ${products.filter(Boolean).length}개, 실패 ${failures.length}개, 소요시간 ${(elapsedMs / 1000).toFixed(1)}초, 상품 평균 ${(averageMs / 1000).toFixed(1)}초`);
    if (failures.length) {
      const error = new PageFetchError('product detail fetch failed', failures.map((item) => item.url).join(', '));
      error.failures = failures;
      throw error;
    }
    const result = buildHybridResult(products);
    result.hybridSummary.hydrationStallCount = hydrationStallCount;
    result.hybridSummary.detailTargetCount = urls.length;
    result.hybridSummary.detailSuccessCount = products.filter(Boolean).length;
    return result;
  } finally {
    await closeDetailBrowserSession(detailSession);
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
  const session = await createDetailBrowserSession(config);
  const browser = session.browser;
  const context = session.context;
  try {
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

async function diagnoseMainToDetailTransition(config = resolveTransitionDiagnosticConfig()) {
  log('INFO', '메인→상세 통합 진단은 npm start와 동일한 상세 조회 파이프라인을 사용합니다.');
  const catalog = await fetchProductCatalog(config.notionPageUrl, config);
  log('INFO', `메인→상세 통합 진단 성공: 상품 ${catalog.products.length}개`);
  return catalog;
}

async function benchmarkMainToDetailTransition(baseConfig = resolveTransitionDiagnosticConfig()) {
  const scenarios = [
    { name: '10초 + hydration 50초 cooldown', mainToDetailDelayMs: 10_000, detailHydrationBackoffMs: 50_000, detailHydrationMaxRetries: 1 },
    { name: '고정 60초 대기', mainToDetailDelayMs: 60_000, detailHydrationBackoffMs: 50_000, detailHydrationMaxRetries: 0 }
  ];
  const results = [];
  for (const scenario of scenarios) {
    const startedAt = Date.now();
    try {
      const catalog = await fetchProductCatalog(baseConfig.notionPageUrl, { ...baseConfig, ...scenario });
      results.push({ name: scenario.name, success: true, products: catalog.products.length, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      results.push({ name: scenario.name, success: false, error: error.message, elapsedMs: Date.now() - startedAt });
    }
  }
  log('INFO', `메인→상세 전환 벤치마크 결과: ${JSON.stringify(results)}`);
  if (results.some((result) => !result.success)) throw new PageFetchError('transition benchmark failed');
  return results;
}

function resolveCardDetailAnalysisConfig(env = process.env) {
  const notionPageUrl = env.NOTION_PAGE_URL || 'https://flaxen-catshark-648.notion.site/MD-3973f4a9f62680f39ddafca527725466';
  return {
    ...resolveTransitionDiagnosticConfig({ ...env, NOTION_PAGE_URL: notionPageUrl }),
    notionPageUrl,
    debugDom: false,
    debugDir: env.DEBUG_DIR || DEFAULT_DEBUG_DIR,
    detailConcurrency: 1,
    detailReusePages: false
  };
}

async function collectCardStructureAnalysis(page, mainUrl) {
  const rows = await page.evaluate(() => [...document.querySelectorAll('.notion-collection-item')].map((card, index) => {
    const descendants = [...card.querySelectorAll('*')];
    const styleOf = (element) => getComputedStyle(element);
    const count = (predicate) => descendants.filter(predicate).length;
    const innerText = card.innerText || '';
    const textContent = card.textContent || '';
    const href = card.getAttribute('href') || card.querySelector('a[href]')?.getAttribute('href') || '';
    const dataBlockId = card.getAttribute('data-block-id') || card.querySelector('[data-block-id]')?.getAttribute('data-block-id') || '';
    const dataPageId = card.getAttribute('data-page-id') || card.querySelector('[data-page-id]')?.getAttribute('data-page-id') || '';
    const normalize = (value) => `${value || ''}`.normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const optionPattern = /^([^()（）\r\n]+?)\s*[\(（]\s*(일시\s*품절|판매\s*중|품절|FOR\s*SALE|SOLD\s*OUT)\s*[\)）]$/i;
    const statusPattern = /^(일부\s*(?:상품\s*)?품절|일시\s*품절|판매\s*중|품절|FOR\s*SALE|SOLD\s*OUT)$/i;
    const isOption = (value) => {
      const match = normalize(value).match(optionPattern);
      return Boolean(match && !statusPattern.test(normalize(match[1])) &&
        !/\d{1,3}(?:,\d{3})*\s*원|₩\s*\d/i.test(match[1]));
    };
    const textNodes = [];
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) textNodes.push(walker.currentNode.textContent || '');
    const optionRowCandidates = descendants.map((element) => element.textContent || '').filter(isOption);
    const overflowElements = descendants.filter((element) => /hidden|clip/.test(`${styleOf(element).overflow} ${styleOf(element).overflowY}`));
    const clamped = descendants.filter((element) => {
      const style = styleOf(element);
      return style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '0' && style.webkitLineClamp !== '';
    });
    return {
      index, href, dataBlockId, dataPageId, innerText, innerTextLines: innerText.split(/\r?\n/), textContent,
      descendantTextNodes: textNodes,
      optionRowCandidates,
      optionLineMatches: innerText.split(/\r?\n/).map((line) => ({ line, normalized: normalize(line), matches: isOption(line) })),
      childElementCount: descendants.length,
      displayNoneCount: count((element) => styleOf(element).display === 'none'),
      visibilityHiddenCount: count((element) => styleOf(element).visibility === 'hidden'),
      ariaHiddenCount: count((element) => element.getAttribute('aria-hidden') === 'true'),
      hiddenAttributeCount: count((element) => element.hasAttribute('hidden')),
      overflowHiddenOrClipCount: overflowElements.length,
      scrollHeightClientHeightDifference: card.scrollHeight - card.clientHeight,
      textContentInnerTextDifferent: textContent.replace(/\s+/g, ' ').trim() !== innerText.replace(/\s+/g, ' ').trim(),
      lineClampCount: clamped.length,
      moreIndicator: /더\s*보기|more|\+\s*\d+|…|\.\.\./i.test(`${innerText}\n${textContent}`)
    };
  }));
  return rows.map((row) => {
    const candidate = {
      innerText: row.innerText, hrefs: row.href ? [row.href] : [],
      blockId: row.dataBlockId, pageId: row.dataPageId, optionRowTexts: row.optionRowCandidates
    };
    const card = parseProductCard(candidate, mainUrl);
    const humanVisibleOptionTexts = new Set([
      ...row.optionLineMatches.filter((item) => item.matches).map((item) => item.normalized),
      ...row.optionRowCandidates.map(normalizeValue).filter((value) => CARD_OPTION_LINE_PATTERN.test(value))
    ]);
    return {
      ...row,
      id: card ? extractNotionPageId(card.url, card.url) : row.dataPageId || row.dataBlockId || '',
      url: card?.url || '', name: card?.name || '', price: card?.price || '', status: card?.status || '',
      visibleVariants: card?.characters || [], visibleVariantCount: card?.visibleVariantCount || 0,
      humanVisibleOptionRowCount: humanVisibleOptionTexts.size,
      cardHash: card?.cardHash || '', cardParseIncomplete: !card || card.cardIncomplete
    };
  });
}

function evaluateAnalysisRule(items, predicate) {
  const result = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0,
    missedHiddenVariantCount: 0, unnecessaryDetailCount: 0, products: [] };
  for (const item of items.filter((entry) => entry.detailSuccess)) {
    const predictedNeedsDetail = Boolean(predicate(item));
    const actualNeedsDetail = item.actualNeedsDetail;
    const bucket = predictedNeedsDetail
      ? (actualNeedsDetail ? 'truePositive' : 'falsePositive')
      : (actualNeedsDetail ? 'falseNegative' : 'trueNegative');
    result[bucket] += 1;
    if (bucket === 'falseNegative') result.missedHiddenVariantCount += item.hiddenVariantCount;
    if (bucket === 'falsePositive') result.unnecessaryDetailCount += 1;
    result.products.push({ id: item.id, name: item.name, predictedNeedsDetail, actualNeedsDetail, outcome: bucket });
  }
  result.safe = result.falseNegative === 0;
  return result;
}

function sanitizeAnalysisVariants(characters) {
  const cleaned = (characters || []).map((variant) => ({
    name: normalizeValue(variant.name).replace(/^내용\s*\d+\s*/i, '').replace(/\s*일시$/i, ''),
    status: normalizeStatus(variant.status)
  })).filter((variant) => variant.name && !/현황|가격|비어\s*있음|\d{1,3}(?:,\d{3})*\s*원/i.test(variant.name));
  return [...new Map(cleaned.map((variant) => [`${variant.name}\u0000${variant.status}`, variant])).values()];
}

async function analyzeCardDetail(config = resolveCardDetailAnalysisConfig()) {
  const { chromium } = require('playwright');
  const debugDir = path.resolve(config.debugDir);
  await fs.mkdir(debugDir, { recursive: true });
  let browser = await chromium.launch(getChromiumLaunchOptions());
  let context = await browser.newContext(getBrowserContextOptions(browser));
  let page = await context.newPage();
  let cards;
  try {
    await page.goto(config.notionPageUrl, { waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeoutMs });
    await waitForProductCards(page, config.collectionWaitMs);
    cards = await collectCardStructureAnalysis(page, config.notionPageUrl);
    if (!cards.length) throw new PageFetchError('analysis product cards not found');
    await saveStateAtomic(path.join(debugDir, 'card-structure-analysis.json'), cards);
    const pointKeycap = cards.find((card) => /포인트\s*키캡/.test(card.name) || /포인트\s*키캡/.test(card.innerText));
    if (pointKeycap) {
      await saveStateAtomic(path.join(debugDir, 'point-keycap-card-diagnostic.json'), {
        pageId: pointKeycap.dataPageId,
        href: pointKeycap.href,
        dataBlockId: pointKeycap.dataBlockId,
        innerText: pointKeycap.innerText,
        innerTextLines: pointKeycap.innerTextLines,
        textContent: pointKeycap.textContent,
        descendantTextNodes: pointKeycap.descendantTextNodes,
        optionLineMatches: pointKeycap.optionLineMatches,
        optionRowCandidates: pointKeycap.optionRowCandidates,
        visibleVariants: pointKeycap.visibleVariants,
        visibleVariantCount: pointKeycap.visibleVariantCount
      });
    }
  } finally {
    await closePageSafely(page);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  await sleep(config.mainToDetailDelayMs);
  let session = await createDetailBrowserSession(config);
  const comparisons = [];
  let consecutiveStalls = 0;
  let recoveries = 0;
  try {
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      let detail;
      let failureReason = '';
      const detailPage = await session.context.newPage();
      try {
        detail = await processDetailPage(detailPage, card.url, { ...config, detailAttemptIsLast: true },
          `카드-상세 분석 ${index + 1}/${cards.length}`);
        consecutiveStalls = 0;
      } catch (error) {
        const failure = createPageFetchError(error);
        failureReason = failure.reason;
        if (failure.reason === 'hydration stall') consecutiveStalls += 1;
        else consecutiveStalls = 0;
      } finally {
        await closePageSafely(detailPage);
      }
      if (!detail && failureReason === 'hydration stall' && shouldTripHydrationCircuitBreaker(consecutiveStalls) &&
          recoveries < (config.detailSessionRecoveryMaxRetries ?? DEFAULT_DETAIL_SESSION_RECOVERY_MAX_RETRIES)) {
        await closeDetailBrowserSession(session);
        await sleep(config.detailHydrationBackoffMs || DEFAULT_DETAIL_HYDRATION_BACKOFF_MS);
        session = await createDetailBrowserSession(config);
        recoveries += 1;
        consecutiveStalls = 0;
      }
      const fullVariants = detail ? sanitizeAnalysisVariants(detail.characters) : [];
      const visible = normalizeProduct({ characters: card.visibleVariants }).characters;
      const prefix = visible.every((variant, variantIndex) =>
        fullVariants[variantIndex]?.name === variant.name && fullVariants[variantIndex]?.status === variant.status);
      const visibleSubset = visible.every((variant) => fullVariants.some((full) =>
        full.name === variant.name && full.status === variant.status));
      const hiddenVariantCount = detail ? fullVariants.length - visible.length : null;
      const statusMatches = detail ? normalizeStatus(card.status) === normalizeStatus(detail.status) : null;
      const priceMatches = detail ? normalizeValue(card.price).replace(/\s+/g, '') === normalizeValue(detail.price).replace(/\s+/g, '') : null;
      const hiddenDomSignal = card.textContentInnerTextDifferent || card.displayNoneCount > 0 || card.visibilityHiddenCount > 0 ||
        card.ariaHiddenCount > 0 || card.hiddenAttributeCount > 0 || card.overflowHiddenOrClipCount > 0 || card.lineClampCount > 0;
      const actualNeedsDetail = Boolean(detail && (hiddenVariantCount > 0 || !statusMatches || !priceMatches || card.cardParseIncomplete));
      comparisons.push({ ...card, detailSuccess: Boolean(detail), failureReason,
        detail: detail ? { name: detail.name, price: detail.price, status: detail.status,
          fullVariants, totalVariantCount: fullVariants.length, bodyText: detail.text } : null,
        cardOptionRaw: card.optionLineMatches.filter((line) => line.matches).map((line) => line.line),
        detailOptionRaw: fullVariants.map((variant) => `${variant.name} (${variant.status})`),
        totalVariantCount: detail ? fullVariants.length : null, hiddenVariantCount,
        visibleVariantsArePrefix: detail ? prefix : null, hasActuallyHiddenVariants: detail ? hiddenVariantCount > 0 : null,
        visibleVariantsAreSubset: detail ? visibleSubset : null,
        invariantViolations: detail ? [
          ...(card.humanVisibleOptionRowCount !== card.visibleVariantCount ? ['human-visible-option-count-mismatch'] : []),
          ...(!visibleSubset ? ['visible-variants-not-subset'] : []),
          ...(hiddenVariantCount !== fullVariants.length - visible.length ? ['hidden-count-formula-mismatch'] : []),
          ...(hiddenVariantCount < 0 ? ['negative-hidden-count'] : [])
        ] : [],
        statusMatches, priceMatches, hiddenDomSignal, actualNeedsDetail });
    }
  } finally {
    await closeDetailBrowserSession(session);
  }
  await saveStateAtomic(path.join(debugDir, 'card-detail-comparison.json'), comparisons);

  const rules = {
    A_visible_under_6_card_sufficient: evaluateAnalysisRule(comparisons, (item) => item.visibleVariantCount >= 6),
    B_visible_6_or_more_needs_detail: evaluateAnalysisRule(comparisons, (item) => item.visibleVariantCount >= 6),
    C_text_content_diff_needs_detail: evaluateAnalysisRule(comparisons, (item) => item.textContentInnerTextDifferent),
    D_hidden_dom_signal_needs_detail: evaluateAnalysisRule(comparisons, (item) => item.hiddenDomSignal),
    E_partial_sold_out_needs_detail: evaluateAnalysisRule(comparisons, (item) => /일부\s*(?:상품\s*)?품절/i.test(item.innerText)),
    F_no_variants_card_sufficient: evaluateAnalysisRule(comparisons, (item) => item.visibleVariantCount > 0)
  };
  const classifications = comparisons.map((item) => {
    if (!item.detailSuccess) return { id: item.id, name: item.name, classification: 'UNKNOWN', reasons: [item.failureReason || 'detail-fetch-failed'] };
    if (item.invariantViolations.length) return { id: item.id, name: item.name, classification: 'UNKNOWN', reasons: item.invariantViolations };
    if (item.actualNeedsDetail) return { id: item.id, name: item.name, classification: 'REQUIRES_DETAIL', reasons: [
      `visibleVariantCount=${item.visibleVariantCount}`, `totalVariantCount=${item.totalVariantCount}`,
      `hiddenVariantCount=${item.hiddenVariantCount}`,
      ...(!item.statusMatches ? ['card-detail-status-mismatch'] : []), ...(!item.priceMatches ? ['card-detail-price-mismatch'] : []),
      ...(item.cardParseIncomplete ? ['card-parse-incomplete'] : [])
    ] };
    return { id: item.id, name: item.name, classification: 'SAFE_CARD_ONLY', reasons: ['card-and-detail-match', `totalVariantCount=${item.totalVariantCount}`] };
  });
  await saveStateAtomic(path.join(debugDir, 'detail-requirement-classification.json'), { rules, products: classifications });
  const summary = {
    totalProducts: cards.length,
    safeCardOnly: classifications.filter((item) => item.classification === 'SAFE_CARD_ONLY').length,
    requiresDetail: classifications.filter((item) => item.classification === 'REQUIRES_DETAIL').length,
    unknown: classifications.filter((item) => item.classification === 'UNKNOWN').length,
    productsWithHiddenVariants: comparisons.filter((item) => item.hasActuallyHiddenVariants).length,
    visibleCount6FalseNegatives: rules.B_visible_6_or_more_needs_detail.falseNegative,
    recommendedInitialDetailCount: classifications.filter((item) => item.classification !== 'SAFE_CARD_ONLY').length
  };
  comparisons.forEach((item) => log('INFO', `상품 비교표: ${JSON.stringify({
    name: item.name, cardOptions: item.cardOptionRaw, visibleVariantCount: item.visibleVariantCount,
    detailOptions: item.detailOptionRaw, totalVariantCount: item.totalVariantCount,
    hiddenVariantCount: item.hiddenVariantCount,
    classification: classifications.find((classified) => classified.id === item.id)?.classification
  })}`));
  log('INFO', `카드-상세 분석 요약: ${JSON.stringify(summary)}`);
  return { summary, rules, classifications, comparisons };
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
      if (change.field === 'character_status') {
        return `- ${change.name}: ${formatStatusLabel(change.before)} → ${formatStatusLabel(change.after)}`;
      }
      if (change.field === 'character_added') return `- 캐릭터 추가 ${change.name}: ${formatStatusLabel(change.after)}`;
      if (change.field === 'character_removed') return `- 캐릭터 삭제 ${change.name}: ${formatStatusLabel(change.before)}`;
      if (change.field === 'product') return '- 상품 전체';
      if (change.field === 'status') {
        return `- 상태: ${formatStatusLabel(change.before)} → ${formatStatusLabel(change.after)}`;
      }
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
      if (previousState) {
        await fs.copyFile(path.resolve(config.stateFile), `${path.resolve(config.stateFile)}.backup`);
        log('INFO', `기존 state 백업 완료: ${path.resolve(config.stateFile)}.backup`);
      }
    } catch (error) {
      log('ERROR', '상태 파일 읽기에 실패했습니다.');
      throw error;
    }

    let catalog;
    let hybridState = {};
    try {
      const fetched = await deps.fetchCatalog(config.notionPageUrl, {
        ...config, previousState, hybridNow: deps.now()
      });
      hybridState = {
        productMetadata: fetched.productMetadata || previousState?.productMetadata || {},
        hybridSummary: fetched.hybridSummary || null
      };
      catalog = validateCatalogMetadata(normalizeCatalog(fetched));
    } catch (error) {
      const fetchError = createPageFetchError(error);
      await recordPageFetchFailure(config, deps, fetchError.reason);
      if (!previousState && config.operatorNtfyTopic) {
        try {
          await deps.sendOperatorNotification(
            config,
            'Notion watcher 최초 기준 스캔 실패',
            `필수 상세 대상 조회가 불완전하여 신규 기준 state를 생성하지 않았습니다.\n실패 이유: ${fetchError.reason}`
          );
          log('INFO', '최초 기준 스캔 실패 관리자 알림을 전송했습니다.');
        } catch (alertError) {
          log('ERROR', `최초 기준 스캔 실패 관리자 알림 전송 실패: ${alertError.message}`);
        }
      }
      throw fetchError;
    }
    const metadataSummary = {
      totalProducts: catalog.products.length,
      withVisibleCount: catalog.products.filter((product) => Number.isInteger(product.visibleVariantCount)).length,
      withTotalCount: catalog.products.filter((product) => Number.isInteger(product.totalVariantCount)).length,
      withKnownHidden: catalog.products.filter((product) => typeof product.knownHiddenVariants === 'boolean').length,
      withCardParseComplete: catalog.products.filter((product) => typeof product.cardParseComplete === 'boolean').length
    };
    log('INFO', `저장 예정 메타데이터 요약: ${JSON.stringify(metadataSummary)}`);
    if (config.debugDom) log('DEBUG', `저장 예정 상품: ${JSON.stringify(catalog.products, null, 2)}`);
    await recordPageFetchSuccess(config, deps);
    const json = serializeCatalog(catalog);
    const hash = createHash(json);
    const checkedAt = deps.now().toISOString();
    const stateToCarryForward = { ...previousState };
    delete stateToCarryForward.lastFullDetailScanAt;

    if (!previousState) {
      await saveStateWithLog(config.stateFile, {
        hash,
        catalog,
        ...hybridState,
        checkedAt,
        changedAt: null
      });
      log('INFO', '최초 상태를 저장했습니다.');
      if (hybridState.hybridSummary) log('INFO', `실행 요약: ${JSON.stringify({ ...hybridState.hybridSummary, changedProducts: 0 })}`);
      return 0;
    }

    if (previousState.hash === hash) {
      await saveStateWithLog(config.stateFile, {
        ...stateToCarryForward,
        hash,
        catalog,
        ...hybridState,
        checkedAt,
        changedAt: previousState.changedAt || null
      });
      log('INFO', '변경 사항이 없습니다.');
      if (hybridState.hybridSummary) log('INFO', `실행 요약: ${JSON.stringify({ ...hybridState.hybridSummary, changedProducts: 0 })}`);
      return 0;
    }

    const diff = diffCatalog(previousState.catalog || { products: [] }, catalog);
    if (hybridState.hybridSummary) log('INFO', `실행 요약: ${JSON.stringify({ ...hybridState.hybridSummary, changedProducts: diff.length })}`);

    if (diff.length === 0) {
      await saveStateWithLog(config.stateFile, {
        ...stateToCarryForward,
        hash,
        catalog,
        ...hybridState,
        checkedAt,
        changedAt: previousState.changedAt || null
      });
      log('INFO', '저장 메타데이터만 변경되어 공개 알림을 건너뜁니다.');
      return 0;
    }

    log('INFO', '상품 변경을 감지했습니다.');
    const diffText = formatCatalogDiff(diff);
    try {
      await deps.sendNotification(config, checkedAt, previousState.catalog?.products?.length || 0, catalog.products.length, diffText);
      log('INFO', 'ntfy 알림을 전송했습니다.');
    } catch (error) {
      log('ERROR', 'ntfy 알림 전송에 실패했습니다.');
      throw error;
    }

    await saveChangeArtifacts(config.snapshotDir, checkedAt, catalog, diff);
    await saveStateWithLog(config.stateFile, { hash, catalog, ...hybridState, checkedAt, changedAt: checkedAt });
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
    if (state.catalog) validateCatalogMetadata(state.catalog);
    await saveStateAtomic(stateFile, state);
    const roundTrip = await readState(stateFile);
    if (roundTrip?.catalog) validateCatalogMetadata(roundTrip.catalog);
    log('INFO', '상태 파일 저장에 성공했습니다.');
  } catch (error) {
    log('ERROR', '상태 파일 저장에 실패했습니다.');
    throw new Error(`상태 파일 저장에 실패했습니다: ${error.message}`);
  }
}

async function dryRun() {
  const config = resolveConfig({
    ...process.env,
    NOTION_PAGE_URL: process.env.NOTION_PAGE_URL || 'https://flaxen-catshark-648.notion.site/MD-3973f4a9f62680f39ddafca527725466',
    NTFY_SERVER_URL: process.env.NTFY_SERVER_URL || 'https://ntfy.invalid',
    NTFY_TOPIC: process.env.NTFY_TOPIC || 'dry-run',
    NTFY_TOKEN: process.env.NTFY_TOKEN || 'dry-run'
  });
  const previousState = await readState(config.stateFile);
  log('INFO', 'dry-run 시작: state와 ntfy는 변경하지 않습니다.');
  const fetched = await fetchProductCatalog(config.notionPageUrl, {
    ...config, previousState, hybridNow: new Date()
  });
  const catalog = validateCatalogMetadata(normalizeCatalog(fetched));
  const summary = fetched.hybridSummary || {};
  log('INFO', `dry-run 실행 요약: ${JSON.stringify(summary)}`);
  log('INFO', `dry-run 메타데이터 요약: ${JSON.stringify({
    totalProducts: catalog.products.length,
    withVisibleCount: catalog.products.filter((product) => Number.isInteger(product.visibleVariantCount)).length,
    withTotalCount: catalog.products.filter((product) => Number.isInteger(product.totalVariantCount)).length,
    withKnownHidden: catalog.products.filter((product) => typeof product.knownHiddenVariants === 'boolean').length,
    withCardParseComplete: catalog.products.filter((product) => typeof product.cardParseComplete === 'boolean').length
  })}`);
  for (const product of catalog.products) {
    log('INFO', `dry-run 상품: ${product.name} detailReason=${product.detailReason || 'none'} ` +
      `source=${product.detailSource} visible=${product.visibleVariantCount} total=${product.totalVariantCount} hidden=${product.hiddenVariantCount}`);
  }
  return catalog;
}

if (require.main === module) {
  if (process.argv.includes('--dry-run')) {
    dryRun().catch((error) => {
      log('ERROR', error.message);
      process.exitCode = 1;
    });
  } else if (process.argv.includes('--analyze-card-detail')) {
    analyzeCardDetail().catch((error) => {
      log('ERROR', error.message);
      process.exitCode = 1;
    });
  } else if (process.argv.includes('--benchmark-transition')) {
    benchmarkMainToDetailTransition().catch((error) => {
      log('ERROR', error.message);
      process.exitCode = 1;
    });
  } else if (process.argv.includes('--debug-transition')) {
    diagnoseMainToDetailTransition().catch((error) => {
      log('ERROR', error.message);
      process.exitCode = 1;
    });
  } else if (process.argv.includes('--debug-detail')) {
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
  resolveTransitionDiagnosticConfig,
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
  validateCatalogMetadata,
  normalizeProduct,
  normalizeCatalog,
  parseProductCard,
  buildHybridDetailPlan,
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
  buildDetailContextSettings,
  createDetailBrowserSession,
  closePageSafely,
  createDetailPageSlot,
  processDetailPage,
  collectDetailSnapshot,
  isUsableDetailSnapshot,
  isHydrationStallSnapshot,
  shouldTripHydrationCircuitBreaker,
  shouldRotateDetailSession,
  advanceHydrationCircuitState,
  fetchProductCatalog,
  discoverProductUrlsWithRetries,
  benchmarkDetailMode,
  benchmarkDetails,
  diagnoseSingleDetail,
  diagnoseMainToDetailTransition,
  benchmarkMainToDetailTransition,
  collectCardStructureAnalysis,
  evaluateAnalysisRule,
  analyzeCardDetail,
  debugCards,
  formatCatalogDiff,
  formatStatusLabel,
  sendNtfyNotification,
  dryRun,
  saveStateWithLog,
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
  DEFAULT_MAIN_TO_DETAIL_DELAY_MS,
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
