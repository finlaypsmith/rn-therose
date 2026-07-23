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

// 填邮箱/密码：优先 evaluate 直接写值（比 type 更抗 CF 重渲染），失败再回退 type
async function fillCredentials(page) {
    log('📧 填写邮箱...');
    await page.waitForSelector('#login_form_email', { timeout: 15000 });
    await page.waitForSelector('#login_form_password', { timeout: 15000 });

    const written = await page.evaluate((email, password) => {
        const e = document.querySelector('#login_form_email');
        const p = document.querySelector('#login_form_password');
        if (!e || !p) return { ok: false, reason: 'missing-fields' };
        e.focus();
        e.value = '';
        e.value = email;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        p.focus();
        p.value = '';
        p.value = password;
        p.dispatchEvent(new Event('input', { bubbles: true }));
        p.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, emailVal: e.value || '' };
    }, EMAIL, PASSWORD);

    if (!written || !written.ok || written.emailVal !== EMAIL) {
        log('⚠️ evaluate 写入异常，回退 page.type');
        try {
            await page.click('#login_form_email', { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type('#login_form_email', EMAIL, { delay: 20 });
            await page.click('#login_form_password', { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type('#login_form_password', PASSWORD, { delay: 20 });
        } catch (e) {
            throw new Error(`填写凭证失败: ${e.message}`);
        }
    } else {
        log('🔑 填写密码...');
    }
    await sleep(400);
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

    // Turnstile 求解期间表单可能被重渲染清空，点 Sign in 前再确认填入
    await fillCredentials(page);

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

// 读取 My servers 页的 Valid until 时间文本
async function readValidUntil(page) {
    return await page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        // "Valid until\n2026-07-23 21:27" 或同一行
        const m = body.match(/Valid until\s*[\n\r\t ]*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i);
        return m ? m[1].trim() : '';
    });
}

// 检查续期结果：优先读成功/失败 alert，再比对 Valid until
async function checkRenewalSuccess(page, validBefore = '') {
    log('🔍 等待检查续期结果...');
    // 给跳转/渲染一点时间
    for (let i = 0; i < 12; i++) {
        await sleep(1000);
        const hit = await page.evaluate(() => {
            // 失败 alert 优先
            const dangerSels = ['.alert-danger', '.alert.alert-danger', 'div[role="alert"].alert-danger'];
            for (const s of dangerSels) {
                const el = document.querySelector(s);
                if (el && (el.offsetParent !== null || getComputedStyle(el).display !== 'none')) {
                    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
                    if (txt) return { kind: 'error', text: txt };
                }
            }
            const sels = ['.alert-success', '.alert.alert-success', 'div[role="alert"].alert-success', 'div.alert-success'];
            for (const s of sels) {
                const el = document.querySelector(s);
                if (el && (el.offsetParent !== null || getComputedStyle(el).display !== 'none')) {
                    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
                    if (txt) return { kind: 'ok', text: txt };
                }
            }
            const body = document.body ? document.body.innerText : '';
            if (/successfully purchased/i.test(body)) return { kind: 'ok', text: 'successfully purchased' };
            if (/order (has been )?completed|payment successful|server (has been )?extended|renewed successfully/i.test(body)) {
                return { kind: 'ok', text: body.match(/successfully purchased|order (has been )?completed|payment successful|server (has been )?extended|renewed successfully/i)?.[0] || 'order completed' };
            }
            // 业务拒绝文案
            if (/renewal is available only|within \d+ minutes before expiration|insufficient|not enough|error during/i.test(body)) {
                const m = body.match(/Error during[^\n]+|Renewal is available only[^\n]+|insufficient[^\n]+/i);
                return { kind: 'error', text: (m && m[0] || '续期被服务器拒绝').trim() };
            }
            return null;
        });
        if (hit) {
            if (hit.kind === 'error') return { ok: false, text: hit.text };
            return { ok: true, text: hit.text };
        }
    }

    // 回 My servers 比对 Valid until 是否变长
    try {
        await page.goto('https://client.therose.cloud/panel?routeName=servers', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await sleep(2000);
        const validAfter = await readValidUntil(page);
        if (validAfter && validBefore && validAfter !== validBefore) {
            return { ok: true, text: `Valid until ${validBefore} → ${validAfter}` };
        }
        if (validAfter && !validBefore) {
            return { ok: true, text: `Valid until ${validAfter}` };
        }
        return {
            ok: false,
            text: `Valid until 未增加（前: ${validBefore || '未知'} / 后: ${validAfter || '未知'}）`,
        };
    } catch (e) {
        return { ok: false, text: `结果页检查异常: ${e.message}` };
    }
}

// 登录后续期：
// Dashboard 没有 Extend；真正入口在 My servers 页的 a[href*="cart_renew"]
// → cart_renew 页 #order-submit (Order now) → 检查成功提示 / Valid until 变化
async function renew(page) {
    log('📂 进入 My servers...');
    await page.goto('https://client.therose.cloud/panel?routeName=servers', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });
    await humanWait(2, 4);

    const validBefore = await readValidUntil(page);
    log(`🕒 续期前 Valid until: ${validBefore || '未知'}`);

    // 优先点 cart_renew 链接，文本 Extend 兜底
    log('🖱️ 点击 Extend...');
    const extendHref = await page.evaluate(() => {
        const byHref = document.querySelector('a[href*="cart_renew"]');
        if (byHref) {
            const href = byHref.getAttribute('href') || '';
            byHref.click();
            return href;
        }
        const all = Array.from(document.querySelectorAll('a, button, span, [role="button"]'));
        const byText = all.find((el) => {
            const t = (el.textContent || el.getAttribute('title') || '').trim().toLowerCase();
            return t === 'extend' || t.includes('extend');
        });
        if (byText) {
            byText.click();
            return byText.getAttribute('href') || 'clicked-by-text';
        }
        return '';
    });
    if (!extendHref) {
        try { await page.screenshot({ path: 'artifacts/no_extend.png', fullPage: true }); } catch (e) {}
        throw new Error('未找到 Extend 按钮（My servers 页无 cart_renew 链接）');
    }
    log(`✅ 已点击 Extend（${extendHref}）`);

    // 等进入 cart_renew 或出现 Order now
    let onCart = false;
    for (let i = 0; i < 20; i++) {
        const url = page.url();
        const hasOrder = await page.evaluate(() => {
            if (document.querySelector('#order-submit')) return true;
            return Array.from(document.querySelectorAll('button, a')).some(
                (el) => /order now/i.test((el.textContent || '').trim())
            );
        }).catch(() => false);
        if (url.includes('cart_renew') || hasOrder) {
            onCart = true;
            break;
        }
        await sleep(500);
    }
    if (!onCart && extendHref.startsWith('/')) {
        // click 可能没导航成功，直接 goto
        await page.goto(`https://client.therose.cloud${extendHref}`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        await humanWait(2, 3);
    } else {
        await humanWait(1, 2);
    }

    log('🛒 点击 Order now...');
    const ordered = await page.evaluate(() => {
        const byId = document.querySelector('#order-submit');
        if (byId) { byId.click(); return true; }
        const btns = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
        const b = btns.find((el) => /order now/i.test((el.textContent || el.value || '').trim()));
        if (b) { b.click(); return true; }
        return false;
    });
    if (!ordered) {
        try { await page.screenshot({ path: 'artifacts/no_order_now.png', fullPage: true }); } catch (e) {}
        throw new Error('未找到 Order now 按钮');
    }
    log('✅ 已点击 Order now');

    // 等导航/响应
    await sleep(3000);

    const result = await checkRenewalSuccess(page, validBefore);
    if (result.ok) {
        log(`✅ 续期成功: ${result.text}`);
        try { await page.screenshot({ path: 'artifacts/renewal_ok.png', fullPage: true }); } catch (e) {}
        return { ok: true, text: result.text };
    }
    log(`❌ 续期可能失败: ${result.text}`);
    try { await page.screenshot({ path: 'artifacts/renewal_fail.png', fullPage: true }); } catch (e) {}
    return { ok: false, text: result.text };
}

// 纯逻辑导出，供 tests/ 断言
module.exports = { maskEmail, timeToSeconds };

async function main() {
    if (!EMAIL || !PASSWORD) {
        log('❌ 请设置环境变量 EMAIL 和 PASSWORD');
        process.exit(1);
    }
    try { require('fs').mkdirSync('artifacts', { recursive: true }); } catch (e) {}

    let browser, page;
    try {
        ({ browser, page } = await launchRealBrowser());
    } catch (e) {
        log(`❌ ${e.message}`);
        await sendTelegram(formatNotification('❌ 登录失败', '', e.message));
        return;
    }

    let egressIp = '';
    try {
        if (IS_PROXY) log(`🔗 挂载代理: ${PROXY_SERVER}`);
        else log('🍭 未使用代理，直连访问');
        await page.goto('https://api.ip.sb/ip', { waitUntil: 'domcontentloaded', timeout: 30000 });
        egressIp = await page.evaluate(() => (document.body.innerText || '').trim()).catch(() => '');
        log(`📍 当前出口IP: ${maskIp(egressIp)}`);
    } catch (e) {
        log(`⚠️ 获取出口 IP 失败: ${e.message}`);
        // 代理异常提前暴露，但不直接终止：继续尝试登录，让 Turnstile 失败做最终判定
    }

    try {
        await login(page);
    } catch (e) {
        log(`❌ 登录失败: ${e.message}`);
        const extra = egressIp ? `🌐 出口IP: ${maskIp(egressIp)}` : '';
        await sendTelegram(formatNotification('❌ 登录失败', extra, e.message));
        try { await browser.close(); } catch (x) {}
        return;
    }

    try {
        const r = await renew(page);
        const extra = [r.text, egressIp ? `🌐 出口IP: ${maskIp(egressIp)}` : ''].filter(Boolean).join(' | ');
        if (r.ok) {
            await sendTelegram(formatNotification('✅ 续期成功', extra));
        } else {
            await sendTelegram(formatNotification('❌ 续期可能失败', extra, r.text));
        }
    } catch (e) {
        log(`❌ 续期异常: ${e.message}`);
        try { await page.screenshot({ path: 'artifacts/renew_error.png' }); } catch (x) {}
        await sendTelegram(formatNotification('❌ 续期异常', '', e.message));
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log('🏁 脚本执行完毕');
}

if (require.main === module) {
    main();
}
