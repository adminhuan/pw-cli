#!/usr/bin/env node
/**
 * pw - Playwright Browser CLI for Codex
 *
 * 通过 shell 命令操控浏览器，支持会话持久化。
 * 浏览器在 start 后保持运行，后续命令复用同一会话。
 *
 * Usage:
 *   pw start [--headless]        启动浏览器会话
 *   pw open <url>                导航到 URL
 *   pw click <selector>          点击元素
 *   pw fill <selector> <text>    填写输入框
 *   pw select <selector> <value> 选择下拉框
 *   pw text <selector>           获取元素文本
 *   pw exists <selector>         检查元素是否存在
 *   pw wait <selector> [timeout] 等待元素出现
 *   pw screenshot [filename]     截图
 *   pw snapshot                  获取页面结构（可交互元素）
 *   pw eval <js-code>            执行 JS 代码
 *   pw title                     获取页面标题
 *   pw url                       获取当前 URL
 *   pw html <selector>           获取元素 innerHTML
 *   pw count <selector>          统计匹配元素数量
 *   pw table <selector>          提取表格数据为 JSON
 *   pw download-wait <action-selector> [dir]  点击并等待下载
 *   pw network-log <action-selector>  点击并记录网络请求
 *   pw status                    查看当前会话状态
 *   pw logs [lines]              查看最近日志
 *   pw restart [--headless]      重启浏览器
 *   pw stop                      关闭浏览器
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const SESSION_FILE = join(process.env.HOME || '/tmp', '.pw-session.json');
const LOG_FILE = join(process.env.HOME || '/tmp', '.pw.log');
const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR || '/tmp/pw-screenshots';
function resolveChromePath() {
  const absCandidates = [
    process.env.PW_CHROME_PATH || '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of absCandidates) {
    if (p && existsSync(p)) return p;
  }
  // 回退到 PATH 搜索
  return 'google-chrome';
}
const CHROME_PATH = resolveChromePath();
const CHROME_PROFILE_DIR = join(process.env.HOME || '/tmp', '.pw-chrome-profile');
const WS_ENDPOINT = 'http://127.0.0.1:9222';

mkdirSync(SCREENSHOT_DIR, { recursive: true });
mkdirSync(CHROME_PROFILE_DIR, { recursive: true });


function writeLog(level, message, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...extra,
  });
  appendFileSync(LOG_FILE, line + '\n');
}

function saveSession(session) {
  writeFileSync(SESSION_FILE, JSON.stringify({ ...session, ts: Date.now() }));
}

function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function clearSession() {
  if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE);
}

function normalizeWsEndpoint(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    return raw.wsEndpoint || raw.endpointURL || '';
  }
  return '';
}

function isProcessAlive(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForBrowser(endpoint, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(endpoint);
      await browser.close().catch(() => {});
      return;
    } catch (error) {
      lastError = error?.message || String(error);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(lastError || '浏览器启动超时');
}

async function launchDetachedChrome(headless) {
  const args = [
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
    '--remote-debugging-port=9222',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-extensions',
    '--no-proxy-server',
    '--proxy-server=direct://',
    '--proxy-bypass-list=*',
    'about:blank',
  ];

  if (headless) {
    args.unshift('--headless=new');
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(CHROME_PATH, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

async function stopSession(session = loadSession()) {
  const endpoint = normalizeWsEndpoint(session?.wsEndpoint || session?.endpointURL);

  if (endpoint) {
    try {
      const browser = await chromium.connectOverCDP(endpoint);
      await browser.close().catch(() => {});
    } catch {}
  }

  const pids = [session?.browserPid, session?.pid]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  for (const pid of pids) {
    if (!isProcessAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }

  clearSession();
}

async function connectBrowser() {
  const session = loadSession();
  const endpoint = normalizeWsEndpoint(session?.wsEndpoint || session?.endpointURL);

  if (!endpoint) {
    writeLog('warn', 'no_session');
    console.error('ERROR: 浏览器未启动。先运行: pw start');
    process.exit(1);
  }

  try {
    await waitForBrowser(endpoint, 3000);
    const browser = await chromium.connectOverCDP(endpoint);
    const contexts = browser.contexts();
    const context = contexts[0] || await browser.newContext();
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    return { browser, context, page, session };
  } catch (e) {
    const browserPidAlive = session?.browserPid && isProcessAlive(session.browserPid);

    if (!browserPidAlive) {
      clearSession();
      writeLog('warn', 'session_expired', { endpoint });
      console.error('ERROR: 无法连接浏览器，会话可能已过期。重新运行: pw start');
      process.exit(1);
    }

    writeLog('warn', 'cdp_unreachable', { endpoint, browserPid: session?.browserPid || null });
    console.error('ERROR: 无法连接浏览器调试端口，浏览器可能仍在启动或调试端口被占用。可重试一次；若仍失败请运行: pw stop && pw start');
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`pw - Playwright 浏览器 CLI

命令:
  pw start [--headless]           启动浏览器
  pw restart [--headless]         重启浏览器
  pw open <url>                   打开网址
  pw click <selector>             点击元素
  pw fill <selector> <text>       填写输入框
  pw select <selector> <value>    选择下拉选项
  pw text <selector>              获取元素文本
  pw exists <selector>            元素是否存在
  pw wait <selector> [timeout]    等待元素出现
  pw screenshot [filename]        截图保存到 ${SCREENSHOT_DIR}
  pw snapshot                     页面可交互元素快照
  pw eval <js-code>               执行 JavaScript
  pw title                        页面标题
  pw url                          当前 URL
  pw html <selector>              元素 innerHTML
  pw count <selector>             匹配元素数量
  pw table <selector>             提取表格为 JSON
  pw download-wait <selector>     点击并等待下载
  pw network-log <selector>       点击并记录网络请求
  pw status                       查看当前会话状态
  pw logs [lines]                 查看最近日志
  pw stop                         关闭浏览器`);
    return;
  }

  // ─── start ───
  if (cmd === 'start') {
    const headless = args.includes('--headless');
    const existingSession = loadSession();
    const existingEndpoint = normalizeWsEndpoint(existingSession?.wsEndpoint || existingSession?.endpointURL);

    if (existingEndpoint) {
      try {
        const browser = await chromium.connectOverCDP(existingEndpoint);
        await browser.close().catch(() => {});
        console.log('OK: 浏览器已在运行');
        console.log(`会话文件: ${SESSION_FILE}`);
        console.log(`截图目录: ${SCREENSHOT_DIR}`);
        return;
      } catch {
        await stopSession(existingSession);
      }
    }

    console.log(`启动浏览器... (${headless ? 'headless' : 'headed'}, Chrome)`);

    let browserPid;
    try {
      browserPid = await launchDetachedChrome(headless);
      saveSession({ wsEndpoint: WS_ENDPOINT, browserPid, headless });
      await waitForBrowser(WS_ENDPOINT, 10000);
    } catch (error) {
      await stopSession(loadSession());
      writeLog('error', 'start_failed', { error: error?.message || '浏览器启动失败' });
      console.error(`ERROR: ${error?.message || '浏览器启动失败'}`);
      process.exit(1);
    }

    writeLog('info', 'started', { browserPid, headless, endpoint: WS_ENDPOINT });
    console.log('OK: 浏览器已启动');
    console.log(`浏览器进程: ${browserPid}`);
    console.log(`会话文件: ${SESSION_FILE}`);
    console.log(`截图目录: ${SCREENSHOT_DIR}`);
    return;
  }


  // ─── status ───
  if (cmd === 'status') {
    const session = loadSession();
    const endpoint = normalizeWsEndpoint(session?.wsEndpoint || session?.endpointURL);
    const pid = Number(session?.browserPid || session?.pid || 0);
    const pidAlive = pid > 0 ? isProcessAlive(pid) : false;

    console.log(`session_file: ${SESSION_FILE}`);
    console.log(`session_exists: ${session ? 'yes' : 'no'}`);
    console.log(`headless: ${session?.headless ? 'yes' : 'no'}`);
    console.log(`browser_pid: ${pid || '-'}`);
    console.log(`pid_alive: ${pidAlive ? 'yes' : 'no'}`);
    console.log(`cdp_endpoint: ${endpoint || '-'}`);
    console.log(`log_file: ${LOG_FILE}`);

    if (!endpoint) {
      console.log('cdp_connectable: no');
      console.log('current_url: -');
      console.log('title: -');
      return;
    }

    try {
      await waitForBrowser(endpoint, 1500);
      const browser = await chromium.connectOverCDP(endpoint);
      const context = browser.contexts()[0] || await browser.newContext();
      const page = context.pages()[0] || await context.newPage();
      console.log('cdp_connectable: yes');
      console.log(`current_url: ${page.url() || '-'}`);
      console.log(`title: ${await page.title() || '-'}`);
      await browser.close().catch(() => {});
    } catch {
      console.log('cdp_connectable: no');
      console.log('current_url: -');
      console.log('title: -');
    }
    return;
  }


  // ─── restart ───
  if (cmd === 'restart') {
    const headless = args.includes('--headless');
    const existingSession = loadSession();
    if (existingSession) {
      await stopSession(existingSession);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log(`重启浏览器... (${headless ? 'headless' : 'headed'}, Chrome)`);

    let browserPid;
    try {
      browserPid = await launchDetachedChrome(headless);
      saveSession({ wsEndpoint: WS_ENDPOINT, browserPid, headless });
      await waitForBrowser(WS_ENDPOINT, 10000);
    } catch (error) {
      await stopSession(loadSession());
      writeLog('error', 'restart_failed', { error: error?.message || '浏览器重启失败' });
      console.error(`ERROR: ${error?.message || '浏览器重启失败'}`);
      process.exit(1);
    }

    writeLog('info', 'restarted', { browserPid, headless, endpoint: WS_ENDPOINT });
    console.log('OK: 浏览器已重启');
    console.log(`浏览器进程: ${browserPid}`);
    console.log(`会话文件: ${SESSION_FILE}`);
    console.log(`截图目录: ${SCREENSHOT_DIR}`);
    return;
  }


  // ─── logs ───
  if (cmd === 'logs') {
    const lines = Math.max(1, Number(args[1] || 20));
    if (!existsSync(LOG_FILE)) {
      console.log(`log_file: ${LOG_FILE}`);
      console.log('暂无日志');
      return;
    }
    const raw = readFileSync(LOG_FILE, 'utf-8').trim();
    const items = raw ? raw.split('\n').slice(-lines) : [];
    console.log(`log_file: ${LOG_FILE}`);
    if (!items.length) {
      console.log('暂无日志');
      return;
    }
    for (const line of items) console.log(line);
    return;
  }

  // ─── stop ───
  if (cmd === 'stop') {
    await stopSession();
    writeLog('info', 'stopped');
    console.log('OK: 浏览器已关闭');
    return;
  }

  // 其余命令需要连接已有浏览器
  const { browser, context, page } = await connectBrowser();

  try {
    switch (cmd) {
      case 'open': {
        const url = args[1];
        if (!url) { console.error('用法: pw open <url>'); break; }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(500);
        writeLog('info', 'opened', { url: page.url() });
        console.log(`OK: 已打开 ${page.url()}`);
        console.log(`标题: ${await page.title()}`);
        break;
      }

      case 'click': {
        const selector = args[1];
        if (!selector) { console.error('用法: pw click <selector>'); break; }
        await page.click(selector, { timeout: 5000 });
        await page.waitForTimeout(300);
        console.log(`OK: 已点击 "${selector}"`);
        break;
      }

      case 'fill': {
        const selector = args[1];
        const text = args.slice(2).join(' ');
        if (!selector || !text) { console.error('用法: pw fill <selector> <text>'); break; }
        await page.fill(selector, text, { timeout: 5000 });
        console.log(`OK: 已填写 "${selector}" = "${text}"`);
        break;
      }

      case 'select': {
        const selector = args[1];
        const value = args[2];
        if (!selector || !value) { console.error('用法: pw select <selector> <value>'); break; }
        await page.selectOption(selector, value, { timeout: 5000 });
        console.log(`OK: 已选择 "${selector}" = "${value}"`);
        break;
      }

      case 'text': {
        const selector = args[1];
        if (!selector) { console.error('用法: pw text <selector>'); break; }
        const el = page.locator(selector).first();
        const text = await el.textContent({ timeout: 5000 });
        console.log(text?.trim() || '(empty)');
        break;
      }

      case 'exists': {
        const selector = args[1];
        if (!selector) { console.error('用法: pw exists <selector>'); break; }
        const count = await page.locator(selector).count();
        console.log(count > 0 ? `YES: 找到 ${count} 个` : 'NO: 未找到');
        break;
      }

      case 'wait': {
        const selector = args[1];
        const timeout = Number(args[2]) || 10000;
        if (!selector) { console.error('用法: pw wait <selector> [timeout_ms]'); break; }
        await page.waitForSelector(selector, { timeout });
        console.log(`OK: "${selector}" 已出现`);
        break;
      }

      case 'screenshot': {
        const name = args[1] || `screenshot-${Date.now()}.png`;
        const filepath = name.startsWith('/') ? name : join(SCREENSHOT_DIR, name);
        await page.screenshot({ path: filepath, fullPage: true });
        console.log(`OK: 截图已保存 ${filepath}`);
        break;
      }

      case 'snapshot': {
        const elements = await page.evaluate(() => {
          const items = [];
          const selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]';
          document.querySelectorAll(selectors).forEach((el, i) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;
            const tag = el.tagName.toLowerCase();
            const type = el.getAttribute('type') || '';
            const text = (el.textContent || '').trim().slice(0, 60);
            const placeholder = el.getAttribute('placeholder') || '';
            const value = el.value || '';
            const role = el.getAttribute('role') || '';
            const id = el.id || '';
            const cls = el.className?.toString?.()?.slice(0, 40) || '';

            let desc = `[${tag}`;
            if (type) desc += ` type="${type}"`;
            if (role) desc += ` role="${role}"`;
            if (id) desc += ` #${id}`;
            desc += ']';
            if (text) desc += ` "${text}"`;
            if (placeholder) desc += ` placeholder="${placeholder}"`;
            if (value) desc += ` value="${value}"`;

            items.push({ ref: `e${i}`, desc, cls });
          });
          return items;
        });

        console.log(`页面: ${page.url()}`);
        console.log(`可交互元素 (${elements.length}):\n`);
        elements.forEach(el => {
          console.log(`  ${el.ref}  ${el.desc}`);
        });
        break;
      }

      case 'eval': {
        const code = args.slice(1).join(' ');
        if (!code) { console.error('用法: pw eval <js-code>'); break; }
        const result = await page.evaluate(code);
        console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result));
        break;
      }

      case 'title': {
        console.log(await page.title());
        break;
      }

      case 'url': {
        console.log(page.url());
        break;
      }

      case 'html': {
        const selector = args[1];
        if (!selector) { console.error('用法: pw html <selector>'); break; }
        const html = await page.locator(selector).first().innerHTML({ timeout: 5000 });
        console.log(html);
        break;
      }

      case 'count': {
        const selector = args[1];
        if (!selector) { console.error('用法: pw count <selector>'); break; }
        const count = await page.locator(selector).count();
        console.log(count);
        break;
      }

      case 'table': {
        const selector = args[1] || 'table';
        const data = await page.evaluate((sel) => {
          const table = document.querySelector(sel);
          if (!table) return null;
          const headers = [...table.querySelectorAll('thead th, thead td')].map(th => th.textContent.trim());
          const rows = [...table.querySelectorAll('tbody tr')].map(tr =>
            [...tr.querySelectorAll('td')].map(td => td.textContent.trim())
          );
          return { headers, rows };
        }, selector);

        if (!data) { console.log('未找到表格'); break; }
        console.log(JSON.stringify(data, null, 2));
        break;
      }

      case 'download-wait': {
        const selector = args[1];
        const dir = args[2] || SCREENSHOT_DIR;
        if (!selector) { console.error('用法: pw download-wait <selector> [dir]'); break; }

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.click(selector),
        ]);
        const filename = download.suggestedFilename();
        const filepath = join(dir, filename);
        await download.saveAs(filepath);
        console.log(`OK: 下载完成`);
        console.log(`文件名: ${filename}`);
        console.log(`路径: ${filepath}`);
        break;
      }

      case 'network-log': {
        const selector = args[1];
        if (!selector) { console.error('用法: pw network-log <selector>'); break; }

        const requests = [];
        const handler = (response) => {
          requests.push({
            url: response.url(),
            status: response.status(),
            method: response.request().method(),
          });
        };
        page.on('response', handler);
        await page.click(selector);
        await page.waitForTimeout(3000);
        page.off('response', handler);

        if (requests.length === 0) {
          console.log('未捕获到网络请求');
        } else {
          requests.forEach(r => {
            const flag = r.status >= 400 ? 'FAIL' : 'OK';
            console.log(`[${flag}] ${r.method} ${r.status} ${r.url}`);
          });
        }
        break;
      }

      default:
        console.error(`未知命令: ${cmd}\n运行 pw 查看帮助`);
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  } finally {
    // 断开连接但不关闭浏览器
    browser.close().catch(() => {});
  }
}

main().catch(e => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
