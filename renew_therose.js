/**
 * The Rose Cloud 自动续期（puppeteer-real-browser 版）
 *
 * 过 Cloudflare Turnstile 的核心：puppeteer-real-browser 的 turnstile:true 自动求解，
 * 且其反检测指纹足够真，通常让 CF 直接 invisible 放行、不弹 interactive challenge。
 * 这是 SeleniumBase + uc_gui_click_captcha（在 Xvfb 里物理坐标点 Turnstile）被判可疑、
 * 拿不到 token 的死结所在。
 *
 * 流程：启动过盾浏览器（挂代理）→ 出口 IP 自检 → 打开登录页 → 关 cookie 弹窗 →
 *   填凭证 → 轮询 cf-turnstile-response token 非空为唯一权威信号（fail-closed，无 token 不点 Sign in）
 *   → 点 Sign in → 提交后再判一次是否又冒 Turnstile → 轮询跳转 /panel|/dashboard → 登录成功
 *   → 点 Extend → 点 Order now → 检查成功提示 → TG 通知 + 截图。
 *
 * 环境变量（沿用旧 Python 版，无需改 Secrets）：
 *   EMAIL            登录邮箱
 *   PASSWORD         登录密码
 *   IS_PROXY         "true" 时挂代理（默认走 socks5://127.0.0.1:1080）
 *   PROXY_SERVER     代理地址，默认 socks5://127.0.0.1:1080
 *   TG_BOT_TOKEN     Telegram bot token
 *   TG_CHAT_ID       Telegram chat id
 */

const { connect } = require('puppeteer-real-browser');

const EMAIL = process.env.EMAIL || '';
const PASSWORD = process.env.PASSWORD || '';
const IS_PROXY = (process.env.IS_PROXY || 'false').toLowerCase() === 'true';
const PROXY_SERVER = (process.env.PROXY_SERVER || '').trim() || 'socks5://127.0.0.1:1080';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

const BASE_URL = 'https://client.therose.cloud/login';

// 掩码邮箱（只用于通知展示，脱敏）—— 与旧 Python 版 mask_email 等价
function maskEmail(email) {
    if (!email) return '（未配置）';
    if (email.includes('@')) {
        const [name, domain] = email.split('@', 2);
        if (name.length > 4) return `${name.slice(0, 2)}****${name.slice(-2)}@${domain}`;
        return `${name}@${domain}`;
    }
    return email.length > 2 ? email.slice(0, 2) + '****' : email + '****';
}

// HH:MM:SS → 秒，非法/空返回 0 —— 与 g4 timeToSeconds 等价
function timeToSeconds(t) {
    if (!t) return 0;
    const m = String(t).trim().match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    console.log(`[${t}] [INFO] ${msg}`);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function humanWait(minS = 2, maxS = 4) {
    return sleep((minS + Math.random() * (maxS - minS)) * 1000);
}

// 当前 GMT+8 时间字符串，与旧 Python 版 format_notification 的执行时间一致
function nowBeijing() {
    const d = new Date();
    const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
}

// 掩码出口 IP：只打点分首尾段，如 1.2.***.4
function maskIp(ip) {
    const p = String(ip || '').split('.');
    if (p.length === 4) return `${p[0]}.${p[1]}.***.${p[3]}`;
    return '未知';
}

// 发送 Telegram 通知（与旧 Python 版 send_tg 等价）
async function sendTelegram(message) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        log('⚠️ 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。');
        return;
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message }),
        });
        if (res.ok) log('✅ TG 推送已发送');
        else log(`❌ TG 推送失败: HTTP ${res.status}`);
    } catch (e) {
        log(`❌ TG 推送异常: ${e.message}`);
    }
}

// 与旧 Python 版 format_notification 逐行一致的通知文案
function formatNotification(status, extra = '', error = '') {
    const lines = ['🌹 The Rose Cloud 续期通知', '', status, `👤 登录账户: ${maskEmail(EMAIL)}`];
    if (extra) lines.push(extra);
    if (error) lines.push(`⚠️ 错误信息: ${error}`);
    lines.push(`⏱️ 执行时间: ${nowBeijing()}`);
    return lines.join('\n');
}

// 启动过盾浏览器（puppeteer-real-browser + turnstile:true），按 IS_PROXY 挂 socks5 代理
async function launchRealBrowser() {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,1200',
    ];
    if (IS_PROXY) args.push(`--proxy-server=${PROXY_SERVER}`);

    log('🚀 启动浏览器（puppeteer-real-browser / turnstile）');
    let browser, page;
    try {
        ({ browser, page } = await connect({
            headless: false,
            turnstile: true,             // 自动求解 Cloudflare Turnstile（替代旧版 uc_gui_click_captcha）
            disableXvfb: true,            // 外层 workflow 已用 xvfb-run，避免嵌套 X server 冲突
            connectOption: { defaultViewport: null, executablePath: '/usr/bin/google-chrome' },
            args,
        }));
    } catch (e) {
        throw new Error(`浏览器启动失败: ${e.message}`);
    }
    await page.setViewport({ width: 1280, height: 1200 });
    return { browser, page };
}

// 读取 Turnstile token：先 window.turnstile.getResponse()，再隐藏字段兜底（与 g4 getTurnstileToken 等价）
async function getTurnstileToken(page) {
    try {
        return await page.evaluate(() => {
            try {
                if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
                    const r = window.turnstile.getResponse();
                    if (r && r.length > 20) return r;
                }
            } catch (e) {}
            const el = document.querySelector('[name="cf-turnstile-response"]');
            return el && el.value && el.value.length > 20 ? el.value : '';
        });
    } catch (e) {
        return '';
    }
}

// 轮询等 Turnstile 被 puppeteer-real-browser 自动求解：唯一权威信号 = token 非空
async function waitTurnstileToken(page, timeoutS = 60) {
    log('📡 等待 puppeteer-real-browser 自动求解 Turnstile...');
    for (let i = 0; i < timeoutS; i++) {
        const token = await getTurnstileToken(page);
        if (token) {
            log(`✅ Turnstile token 已就绪（长度 ${token.length}）`);
            return true;
        }
        if (i === 20) log('⏳ Turnstile 仍在求解中（可能出现 interactive checkbox，自动求解器处理中）...');
        await sleep(1500);
    }
    return false;
}

// 关 cookie 同意弹窗（沿用 g4 evaluate 写法，消除遮挡）
async function dismissCookieConsent(page) {
    try {
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, span, a'));
            const b = btns.find((el) => {
                const t = (el.textContent || '').trim().toLowerCase();
                return t === 'consent' || t === 'accept' || t === 'i agree' || t.includes('recommended cookies');
            });
            if (b) b.click();
        });
    } catch (e) { /* 忽略 */ }
}

// 填邮箱/密码，填后校验真写入、非 placeholder，异常重填 —— 对齐旧 Python 版 fill+校验逻辑
async function fillCredentials(page) {
    log('📧 填写邮箱...');
    // 先清空再填，避免残留
    await page.click('#login_form_email', { clickCount: 3 }).catch(() => {});
    await page.type('#login_form_email', EMAIL, { delay: 30 });
    log('🔑 填写密码...');
    await page.click('#login_form_password', { clickCount: 3 }).catch(() => {});
    await page.type('#login_form_password', PASSWORD, { delay: 30 });
    await sleep(400);
    const v = await page.evaluate(() => {
        const e = document.querySelector('#login_form_email');
        return e ? e.value || '' : '';
    });
    if (v && !v.includes(EMAIL.slice(0, 3)) && v !== EMAIL) {
        log(`⚠️ 邮箱字段异常（值前缀 ${v.slice(0, 6)}），重填`);
        await page.click('#login_form_email', { clickCount: 3 });
        await page.type('#login_form_email', EMAIL, { delay: 30 });
        await page.click('#login_form_password', { clickCount: 3 });
        await page.type('#login_form_password', PASSWORD, { delay: 30 });
    }
}

// 为 fail-closed 诊断采集登录页 DOM 状态
async function diagnosePage(page) {
    try {
        return await page.evaluate(() => {
            const errSel = ['.alert-danger', '.alert.alert-danger', 'div[role="alert"]', '.invalid-feedback', '.form-error', '.error-message', 'div.alert'];
            let errText = '';
            for (const s of errSel) {
                const el = document.querySelector(s);
                if (el && (el.offsetParent !== null || getComputedStyle(el).display !== 'none')) {
                    errText = (el.textContent || '').trim();
                    if (errText) break;
                }
            }
            const tEl = document.querySelector('[name="cf-turnstile-response"]');
            const cf = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile');
            return {
                url: location.href,
                title: document.title,
                hasCfIframe: !!cf,
                tokenLen: tEl && tEl.value ? tEl.value.length : 0,
                errText: errText.slice(0, 300),
            };
        });
    } catch (e) {
        return { diagError: e.message };
    }
}

// 登录流程：过盾 → fail-closed → 点 Sign in → 等跳 /panel|/dashboard
async function login(page) {
    log('🌐 打开登录页面...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanWait(2, 4);
    // 若被 CF 拦到 challenge 中间页，puppeteer-real-browser 会自动求解；给一点缓冲
    await dismissCookieConsent(page);

    let tokenOk = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        // 每轮先确保凭证在（Turnstile 重新触发可能清表单）
        await fillCredentials(page);

        // puppeteer-real-browser turnstile:true 在后台自动求解，我们只等 token
        if (await waitTurnstileToken(page, 60)) {
            tokenOk = true;
            break;
        }
        log(`⏳ 第 ${attempt} 次未拿到 token，重试...`);
        // 触发重新渲染 Turnstile：整页重开
        if (attempt < 3) {
            await page.evaluate(() => { try { window.location.reload(); } catch (e) {} });
            await humanWait(4, 7);
            await dismissCookieConsent(page);
        }
    }

    if (!tokenOk) {
        const diag = await diagnosePage(page);
        log(`🩺 登录诊断: ${JSON.stringify(diag)}`);
        try { await page.screenshot({ path: 'artifacts/turnstile_fail.png' }); } catch (e) {}
        throw new Error('Cloudflare Turnstile 验证未通过：未拿到有效 token，已终止（不点 Sign in）。');
    }

    log('🖱️ 点击 Sign in...');
    try {
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const b = btns.find((el) => (el.textContent || '').trim().toLowerCase() === 'sign in');
            if (b) b.click();
            else throw new Error('未找到 Sign in 按钮');
        });
    } catch (e) {
        // JS click 兜底
        await page.evaluate(() => {
            const b = document.querySelector('button');
            if (b) b.click();
        });
    }
    await humanWait(4, 7);

    // 提交后若又冒 Turnstile，再等一次 token
    const tokenAfter = await getTurnstileToken(page);
    if (!tokenAfter) {
        const cfStill = await page.evaluate(() => !!(document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile')));
        if (cfStill) {
            log('🛡 提交后再冒 Turnstile，继续等 token...');
            await waitTurnstileToken(page, 25);
            await sleep(1500);
        }
    }

    for (let i = 0; i < 30; i++) {
        const url = page.url();
        if (url.includes('/panel') || url.includes('/dashboard')) {
            log(`✅ 登录成功，已跳转: ${url}`);
            return url;
        }
        if (i > 0 && i % 5 === 0) {
            const diag = await diagnosePage(page);
            if (diag.errText && /invalid|incorrect|wrong|错误|失败/i.test(diag.errText)) {
                log(`❌ 检测到登录错误: ${diag.errText}`);
                try { await page.screenshot({ path: 'artifacts/login_error.png' }); } catch (e) {}
                throw new Error(`登录被拒: ${diag.errText || '未知错误'} | ${url}`);
            }
        }
        await sleep(1000);
    }
    const diag = await diagnosePage(page);
    try { await page.screenshot({ path: 'artifacts/login_timeout.png' }); } catch (e) {}
    throw new Error(`登录超时未跳转 Dashboard | ${diag.url || ''} | ${diag.errText || ''}`);
}

// 纯逻辑导出，供 tests/ 断言
module.exports = { maskEmail, timeToSeconds };
