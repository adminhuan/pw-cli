import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ts = Date.now();
const outDir = `/tmp/openai-flow-capture-${ts}`;
const outFile = path.join(outDir, 'capture.json');
const screenshotFile = path.join(outDir, 'final.png');

const critical = [
  'sentinel.openai.com/backend-api/sentinel/req',
  '/api/accounts/authorize/continue',
  '/api/accounts/create',
  '/create-account/password',
  '/email-verification',
  '/about-you',
  '/add-phone',
  '/api/accounts/session',
  '/api/auth/session',
  '/oauth/oauth2/auth',
];

const pickReqHeaders = (h) => ({
  'user-agent': h['user-agent'] || '',
  'content-type': h['content-type'] || '',
  'referer': h['referer'] || '',
  'origin': h['origin'] || '',
  'sec-ch-ua': h['sec-ch-ua'] || '',
  'sec-ch-ua-platform': h['sec-ch-ua-platform'] || '',
  'openai-sentinel-token': h['openai-sentinel-token'] ? '[present]' : '',
  'openai-sentinel-so-token': h['openai-sentinel-so-token'] ? '[present]' : '',
});

const pickResHeaders = (h) => ({
  'content-type': h['content-type'] || '',
  'location': h['location'] || '',
  'cf-ray': h['cf-ray'] || '',
});

async function createInbox() {
  const res = await fetch('https://api.tempmail.lol/v2/inbox/create', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/json' },
    body: '{}',
  });
  const data = await res.json();
  if (!data?.address || !data?.token) throw new Error(`create inbox failed: ${JSON.stringify(data)}`);
  return { email: data.address, token: data.token };
}

async function pollCode(token, timeoutSec = 240) {
  const start = Date.now();
  const seen = new Set();
  const codeRe = /\b(\d{6})\b/;

  while ((Date.now() - start) / 1000 < timeoutSec) {
    try {
      const u = new URL('https://api.tempmail.lol/v2/inbox');
      u.searchParams.set('token', token);
      const res = await fetch(u.toString());
      if (res.ok) {
        const data = await res.json();
        for (const m of (data?.emails || [])) {
          const key = `${m.date}-${m.subject}-${m.from}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const content = `${m.from || ''}\n${m.subject || ''}\n${m.body || ''}\n${m.html || ''}`;
          if (!/openai|chatgpt/i.test(content)) continue;
          const mm = content.match(codeRe);
          if (mm) return mm[1];
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

async function maybeClick(page, selectors) {
  for (const s of selectors) {
    const loc = page.locator(s);
    if (await loc.count()) {
      await loc.first().click();
      return true;
    }
  }
  return false;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const captures = [];
  let browser = null;
  let context = null;
  let page = null;
  let inbox = null;

  try {
    browser = await chromium.launch({
      headless: false,
      executablePath: CHROME_PATH,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    context = await browser.newContext({ viewport: { width: 1360, height: 920 } });
    page = await context.newPage();

    page.on('request', req => {
      const url = req.url();
      if (!critical.some(k => url.includes(k))) return;
      captures.push({
        ts: new Date().toISOString(),
        type: 'request',
        method: req.method(),
        url,
        headers: pickReqHeaders(req.headers()),
        postData: (req.postData() || '').slice(0, 1200),
      });
    });

    page.on('response', async res => {
      const url = res.url();
      if (!critical.some(k => url.includes(k))) return;
      let bodySnippet = '';
      try {
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (ct.includes('application/json') || ct.includes('text/html')) {
          bodySnippet = (await res.text()).slice(0, 500);
        }
      } catch {}
      captures.push({
        ts: new Date().toISOString(),
        type: 'response',
        url,
        status: res.status(),
        headers: pickResHeaders(res.headers()),
        bodySnippet,
      });
    });

    inbox = await createInbox();
    const password = 'Aa123456!xYz';
    captures.push({ type: 'meta', stage: 'init', email: inbox.email, inboxToken: inbox.token, password });

    await page.goto('https://auth.openai.com/log-in', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);

    await page.waitForSelector('input[type="email"]', { timeout: 90000 });
    await page.locator('input[type="email"]').first().fill(inbox.email);
    await page.locator('button[type="submit"]').first().click();

    // 可能走 create-account/password 或 login/password
    await page.waitForTimeout(6000);

    if (page.url().includes('create-account/password')) {
      await page.locator('input[type="password"]').first().fill(password);
      await page.locator('button[type="submit"]').first().click();
    }

    await page.waitForTimeout(5000);

    if (page.url().includes('email-verification')) {
      const code = await pollCode(inbox.token, 240);
      captures.push({ type: 'meta', stage: 'otp', code: code || '' });
      if (code) {
        await page.locator('input[type="text"]').first().fill(code);
        await page.locator('button[type="submit"]').first().click();
        await page.waitForTimeout(6000);
      }
    }

    if (page.url().includes('about-you')) {
      const textInput = page.locator('input[type="text"]');
      if (await textInput.count()) {
        await textInput.first().fill('Noah White');
      }

      const numInput = page.locator('input[type="number"]');
      if (await numInput.count()) {
        await numInput.first().fill('31');
      }

      await maybeClick(page, ['button[type="submit"]', 'button:has-text("Continue")', 'button:has-text("Next")']);
      await page.waitForTimeout(7000);
    }

    const finalUrl = page.url();
    const title = await page.title();
    captures.push({ type: 'meta', stage: 'final', finalUrl, title });
    await page.screenshot({ path: screenshotFile, fullPage: true });

    console.log(`FINAL_URL=${finalUrl}`);
    if (inbox?.email) console.log(`EMAIL=${inbox.email}`);
  } catch (e) {
    captures.push({
      type: 'meta',
      stage: 'error',
      error: e?.message || String(e),
      stack: e?.stack || '',
      currentUrl: page ? page.url() : '',
    });
  } finally {
    fs.writeFileSync(outFile, JSON.stringify(captures, null, 2));
    console.log(`OUT_FILE=${outFile}`);
    console.log(`SHOT_FILE=${screenshotFile}`);
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('ERR', e?.stack || e?.message || e);
  process.exit(1);
});
