/**
 * The Rose Cloud 自动续期（puppeteer-real-browser 版）
 *
 * 过 Cloudflare Turnstile 的策略（两条腿走路）：
 *   1) 首选 puppeteer-real-browser 的反检测指纹，让 CF 直接 invisible 放行；
 *   2) 不放行时主动点击验证框，做法参照 bothosting-rn/app.py：只点「可见」控件，
 *      并用 xdotool 在 Xvfb 里发真实 X11 鼠标事件（CDP 合成事件容易被判可疑）。
 * 注意：puppeteer-real-browser 内置的自动求解器（turnstile:true）在本站登录页会误点
 * Sign in 按钮、导致页面反复重导航，已关闭 —— 原因见 launchRealBrowser() 的注释。
 *
 * 流程：启动过盾浏览器（挂代理）→ 出口 IP 自检 → 打开 https://therose.cloud/login →
 *   关 cookie 弹窗 → 填凭证 → 等 token（invisible 放行，必要时点击验证框；以
 *   cf-turnstile-response token 非空为唯一权威信号，fail-closed，无 token 不点 Sign in）
 *   → 点 Sign in → 等跳转 /dashboard 并写入 localStorage.trc_token → GET /api/servers →
 *   对 suspended 或进入 30 分钟续期窗口的免费服务器，点击卡片上的
 *   data-testid="renew-<id>" 按钮（失败回退 POST /api/servers/{id}/renew）→
 *   复核 expires_at → TG 通知 + 截图。
 *
 * 说明：旧的 client.therose.cloud 面板（cart_renew / Order now / SSO Manage server）已废弃，
 * 续期入口迁移到主站 dashboard 的 "Renew for another Xh"。主站登录是 React 受控表单
 * （data-testid=login-email/login-password/login-submit），鉴权为 JWT（Bearer）。
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
const { execFileSync } = require('child_process');

// 时区修正（必须早于浏览器启动，子进程要继承到）：
// GitHub Actions runner 的默认时区是 UTC，而 CF 会把 UTC 视为数据中心/自动化特征，
// 拒绝 Turnstile invisible 放行。实测本机 TZ=UTC 可稳定复现 CI 的失败（两轮均无 token），
// 换回正常时区即 13 秒通过 —— 真人浏览器的时区几乎不会是 UTC。
// 这里只给默认值；真正生效的时区在 launchRealBrowser() 里按出口 IP 动态解析
// （参照 rn-dishost/app.py）：硬编码时区与出口 IP 的地理位置对不上同样是可疑信号。
process.env.TZ = process.env.RENEW_TZ || 'America/Sao_Paulo';

const EMAIL = process.env.EMAIL || '';
const PASSWORD = process.env.PASSWORD || '';
const IS_PROXY = (process.env.IS_PROXY || 'false').toLowerCase() === 'true';
const PROXY_SERVER = (process.env.PROXY_SERVER || '').trim() || 'socks5://127.0.0.1:1080';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

const SITE_URL = 'https://therose.cloud';
const BASE_URL = `${SITE_URL}/login`;
const DASHBOARD_URL = `${SITE_URL}/dashboard`;
const API_BASE = '/api';
const DEFAULT_RENEW_WINDOW_MINUTES = 30;

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

// 查询出口 IP 与其时区：api.ip.sb/geoip 优先，失败降级 ip-api.com。
// 走与浏览器相同的代理；socks5 换成 socks5h，让 DNS 也在代理端解析。
// 用 curl 而非 fetch：Node 内置 fetch 不直接支持 socks5 代理。
function getEgressInfo(proxyServer = '') {
    const proxy = proxyServer ? proxyServer.replace(/^socks5:\/\//i, 'socks5h://') : '';
    const sources = [
        ['https://api.ip.sb/geoip', (d) => ({ ip: d.ip, tz: d.timezone })],
        ['http://ip-api.com/json/?fields=query,timezone', (d) => ({ ip: d.query, tz: d.timezone })],
    ];
    for (const [url, pick] of sources) {
        try {
            const args = ['-sS', '--max-time', '15'];
            if (proxy) args.push('-x', proxy);
            args.push(url);
            const data = JSON.parse(execFileSync('curl', args, { encoding: 'utf8', timeout: 20000 }));
            const { ip, tz } = pick(data);
            if (ip) return { ip, tz: tz || '' };
        } catch (e) {
            log(`⚠️ 获取出口信息失败（${url}）: ${String(e.message).split('\n')[0]}`);
        }
    }
    return { ip: '', tz: '' };
}

// 浏览器时区与出口 IP 对齐：在 Chrome 启动前写 TZ，子进程会继承。
// RENEW_TZ 显式指定时跳过查询（保留手动覆盖能力）。
function applyEgressTimezone() {
    if (process.env.RENEW_TZ) {
        process.env.TZ = process.env.RENEW_TZ;
        log(`🕒 使用 RENEW_TZ=${process.env.TZ}`);
        return;
    }
    const { ip, tz } = getEgressInfo(IS_PROXY ? PROXY_SERVER : '');
    if (tz) {
        process.env.TZ = tz;
        log(`📍 出口IP: ${ip}，时区: ${tz}（与出口一致）`);
    } else {
        log(`⚠️ 未获取到出口时区（出口IP: ${ip || '未知'}），沿用 ${process.env.TZ}`);
    }
}

// 当前 GMT+8 时间字符串，与旧 Python 版 format_notification 的执行时间一致
function nowBeijing() {
    const d = new Date();
    const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
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
    applyEgressTimezone();

    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,1200',
        // 禁止 WebRTC 使用「非代理的 UDP」。--proxy-server=socks5 只代理 TCP，WebRTC 的
        // STUN(UDP) 会绕过它直连，把真实 IP 经 ICE candidate 暴露给页面 JS。
        // 实测 CI 上 HTTP 出口 IP 为 190.5.208.24，而 srflx candidate 泄漏 runner 真实 IP
        // 134.33.77.212，CF 判定两者不一致因而拒绝 invisible 放行（本机走 TUN、UDP 也一并
        // 代理，故无此问题，这也是本机能过早盾的原因）。
        // 注意开关名不带 force- 前缀：Chrome 155 二进制中不存在 force-webrtc-ip-handling-policy，
        // 写错会被静默忽略。
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ];
    if (IS_PROXY) args.push(`--proxy-server=${PROXY_SERVER}`);

    log('🚀 启动浏览器（puppeteer-real-browser / turnstile）');
    let browser, page;
    try {
        ({ browser, page } = await connect({
            headless: false,
            // 关闭内置 Turnstile 求解器（原 turnstile:true）。该求解器按「widget 宽 300×65」假设，
            // 取 [name="cf-turnstile-response"] 父元素的 (左边缘+30, 垂直中心) 作为点击点；
            // 本站 .cf-turnstile 实为 480×70 整宽容器，且渲染完成前高度为 0，
            // 该坐标此时正好落在下方重叠的 Sign in 按钮上 —— 求解器每 1s 点一次，
            // 表单被反复提交、页面不断重导航回 /login，Turnstile 流程被打断，token 永远为空。
            // 实测本反检测指纹 + 出口 IP 下 CF 直接 invisible 放行（15–25s 出 token），无需点击。
            // 该开关只控制求解循环，不影响反检测 flags 与指纹注入。
            turnstile: false,
            disableXvfb: true,            // 外层 workflow 已用 xvfb-run，避免嵌套 X server 冲突
            connectOption: { defaultViewport: null, executablePath: '/usr/bin/google-chrome' },
            args,
        }));
    } catch (e) {
        throw new Error(`浏览器启动失败: ${e.message}`);
    }
    // 不能用 page.setViewport() 覆盖视口：Emulation 会把 innerHeight 强制成设定值，
    // 而 xdotool 点击的屏幕坐标要靠 (outerHeight - innerHeight) 换算浏览器 UI 高度，
    // 覆盖后该差值为 0，坐标会整体上移一个地址栏的高度。窗口尺寸由 --window-size 决定。
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

// 轮询等 Turnstile 通过：唯一权威信号 = token 非空（不点击，供只读探针使用）
async function waitTurnstileToken(page, timeoutS = 60) {
    log('📡 等待 Cloudflare Turnstile 自动放行（invisible 验证，以 token 非空为准）...');
    for (let i = 0; i < timeoutS; i++) {
        const token = await getTurnstileToken(page);
        if (token) {
            log(`✅ Turnstile token 已就绪（长度 ${token.length}）`);
            return true;
        }
        if (i === 20) log('⏳ 仍未拿到 token（若持续如此，CF 可能改判为 interactive challenge）...');
        await sleep(1500);
    }
    return false;
}

// ---- Turnstile 主动过盾：参照 bothosting-rn/app.py ----
// CF 有时不放行 invisible 验证，需要像真人一样点一次验证框。关键点：
//   1) 只认「可见」控件（宽 > 50、高 > 20），排除渲染完成前 0×0 的 iframe 与
//      480×70 的整宽容器（内置求解器就是在这里点到了下方的 Sign in）；
//   2) 点击走 X11 真实鼠标事件（xdotool），而不是 CDP Input.dispatchMouseEvent ——
//      前者是 X server 派发的可信输入，后者容易被判为合成事件；
//   3) 节奏：首次等 8s，之后每 10~13s 点一次，总超时 90s。

let xdotoolReady = null;
function hasXdotool() {
    if (xdotoolReady !== null) return xdotoolReady;
    try {
        execFileSync('xdotool', ['help'], { stdio: 'ignore', timeout: 3000 });
        xdotoolReady = true;
    } catch (e) {
        xdotoolReady = false;
        log(`⚠️ xdotool 不可用（${e.code || e.message}），Turnstile 点击将回退 CDP`);
    }
    return xdotoolReady;
}

// 定位可见的 Turnstile 控件，返回页面坐标；找不到返回 null
async function findTurnstileBox(page) {
    return await page.evaluate(() => {
        const visible = (r) => r.width > 50 && r.height > 20;
        const findIn = (root) => {
            const sel = 'iframe[src*="challenges.cloudflare.com"], [class*="turnstile"], [id*="cf-chl"]';
            for (const el of root.querySelectorAll(sel)) {
                const r = el.getBoundingClientRect();
                if (visible(r)) return { x: r.left, y: r.top, w: r.width, h: r.height };
            }
            for (const el of root.querySelectorAll('*')) {
                if (!el.shadowRoot) continue;
                const hit = findIn(el.shadowRoot);
                if (hit) return hit;
            }
            return null;
        };
        const hit = findIn(document);
        if (hit) return hit;
        // 兜底：从 token 隐藏域往上找一个尺寸合理的容器
        let cur = document.querySelector('[name="cf-turnstile-response"]');
        cur = cur ? cur.parentElement : null;
        for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
            const r = cur.getBoundingClientRect();
            if (r.width > 100 && r.width < 600 && r.height > 30 && r.height < 140) {
                return { x: r.left, y: r.top, w: r.width, h: r.height };
            }
        }
        return null;
    }).catch(() => null);
}

// 定位失败时输出现场快照（iframe 列表、turnstile 元素、组件状态）
async function describeTurnstile(page) {
    return await page.evaluate(() => {
        const out = { rt: document.readyState, turnstile: typeof window.turnstile, iframes: [], widgets: [] };
        for (const f of document.querySelectorAll('iframe')) {
            const r = f.getBoundingClientRect();
            out.iframes.push(`w=${Math.round(r.width)} h=${Math.round(r.height)} src=${(f.src || '').slice(0, 70)}`);
        }
        for (const el of document.querySelectorAll('[class*="turnstile"], [id*="cf-chl"], [name="cf-turnstile-response"]')) {
            const r = el.getBoundingClientRect();
            out.widgets.push(`${el.tagName} cls=${String(el.className || '').slice(0, 36)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
        }
        return out;
    }).catch(() => null);
}

// 页面坐标 → 屏幕坐标，用 xdotool 发真实鼠标事件；xdotool 不可用时回退 CDP 点击
async function physicalClickTurnstile(page, px, py) {
    const geo = await page.evaluate(() => ({
        sx: Math.round(window.screenX || 0),
        sy: Math.round(window.screenY || 0),
        // outerHeight 比 innerHeight 多出来的就是浏览器自身 UI（tab/地址栏）的高度
        bar: Math.max(0, Math.round((window.outerHeight || 0) - (window.innerHeight || 0))),
    })).catch(() => null);
    if (!geo) return false;

    const x = geo.sx + Math.round(px);
    const y = geo.sy + Math.round(py) + geo.bar;
    if (hasXdotool()) {
        try {
            execFileSync('xdotool', ['mousemove', '--sync', String(x), String(y)], { timeout: 3000, stdio: 'ignore' });
            await sleep(150);
            execFileSync('xdotool', ['click', '1'], { timeout: 3000, stdio: 'ignore' });
            log(`🖱️ xdotool 点击 Turnstile 屏幕坐标 (${x}, ${y})`);
            return true;
        } catch (e) {
            log(`⚠️ xdotool 点击失败: ${e.message}`);
        }
    }
    try {
        await page.mouse.click(px, py);
        log(`🖱️ CDP 兜底点击 Turnstile (${Math.round(px)}, ${Math.round(py)})`);
        return true;
    } catch (e) {
        log(`⚠️ 坐标点击失败: ${e.message}`);
        return false;
    }
}

// 等待 token；期间按间隔主动点击验证框（点左侧 30px，即复选框位置）
async function solveTurnstile(page, { timeoutS = 90, firstWait = 8 } = {}) {
    log(`🛡️ 处理 Turnstile：轮询 token，必要时点击验证框（上限 ${timeoutS}s）...`);
    const deadline = Date.now() + timeoutS * 1000;
    let nextClick = Date.now() + firstWait * 1000;
    let clicks = 0;
    let dumped = false;

    while (Date.now() < deadline) {
        const token = await getTurnstileToken(page);
        if (token) {
            log(`✅ Turnstile token 已就绪（长度 ${token.length}）`);
            return true;
        }
        if (Date.now() >= nextClick) {
            const box = await findTurnstileBox(page);
            if (box) {
                clicks++;
                const hit = await page.evaluate((x, y) => {
                    const el = document.elementFromPoint(x, y);
                    return el ? `${el.tagName} ${String(el.className || '').slice(0, 28)}` : 'none';
                }, box.x + 30, box.y + box.h / 2).catch(() => '');
                log(`🖱️ 第 ${clicks} 次点击 Turnstile 验证框（${Math.round(box.w)}×${Math.round(box.h)}），命中 ${hit}...`);
                await physicalClickTurnstile(page, box.x + 30, box.y + box.h / 2);
                await sleep(3000);
            } else {
                if (!dumped) {
                    dumped = true;
                    const snap = await describeTurnstile(page);
                    log(`🩺 暂无可点击的 Turnstile 控件: ${JSON.stringify(snap)}`);
                }
                if (clicks === 0) log('ℹ️ 等待 Turnstile 渲染（CF 可能仍在 invisible 校验）...');
            }
            nextClick = Date.now() + 10000 + Math.random() * 3000;
        }
        await sleep(1500);
    }
    const ok = !!(await getTurnstileToken(page));
    log(`${ok ? '✅' : '❌'} Turnstile ${ok ? '已通过' : '未通过'}`);
    return ok;
}

// 关 cookie 同意弹窗（主站是 React 渲染的 "Reject all / Accept all"）
async function dismissCookieConsent(page) {
    try {
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const b = btns.find((el) => /^(reject all|accept all)$/i.test((el.textContent || '').trim()));
            if (b) b.click();
        });
    } catch (e) { /* 忽略 */ }
}

// 填邮箱/密码：主站是 React 受控输入，直接改 value 不会触发 onChange，
// 必须走原生 setter + input/change 事件；失败再回退 page.type
async function fillCredentials(page) {
    log('📧 填写邮箱...');
    await page.waitForSelector('[data-testid="login-email"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="login-password"]', { timeout: 15000 });

    const written = await page.evaluate((email, password) => {
        const setVal = (el, v) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const e = document.querySelector('[data-testid="login-email"]');
        const p = document.querySelector('[data-testid="login-password"]');
        if (!e || !p) return { ok: false, reason: 'missing-fields' };
        e.focus();
        setVal(e, email);
        p.focus();
        setVal(p, password);
        return { ok: true, emailVal: e.value || '' };
    }, EMAIL, PASSWORD);

    if (!written || !written.ok || written.emailVal !== EMAIL) {
        log('⚠️ evaluate 写入异常，回退 page.type');
        try {
            await page.click('[data-testid="login-email"]', { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type('[data-testid="login-email"]', EMAIL, { delay: 20 });
            await page.click('[data-testid="login-password"]', { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type('[data-testid="login-password"]', PASSWORD, { delay: 20 });
        } catch (e) {
            throw new Error(`填写凭证失败: ${e.message}`);
        }
    } else {
        log('🔑 填写密码...');
    }
    await sleep(400);
}

// 为 fail-closed 诊断采集登录页 DOM 状态（主站错误提示是 .trc-error / [data-testid=login-error]）
async function diagnosePage(page) {
    try {
        return await page.evaluate(() => {
            const errSel = ['[data-testid="login-error"]', '.trc-error', '[role="alert"]'];
            let errText = '';
            for (const s of errSel) {
                for (const el of Array.from(document.querySelectorAll(s))) {
                    if (el.offsetParent !== null || getComputedStyle(el).display !== 'none') {
                        errText = (el.textContent || '').trim();
                        if (errText) break;
                    }
                }
                if (errText) break;
            }
            const tEl = document.querySelector('[name="cf-turnstile-response"]');
            const cf = document.querySelector('.trc-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
            let hasAuthToken = false;
            try { hasAuthToken = !!localStorage.getItem('trc_token'); } catch (e) {}
            return {
                url: location.href,
                title: document.title,
                hasCfWidget: !!cf,
                tokenLen: tEl && tEl.value ? tEl.value.length : 0,
                hasAuthToken,
                errText: errText.slice(0, 300),
            };
        });
    } catch (e) {
        return { diagError: e.message };
    }
}

// 采集环境信号：CI 与本机环境的差异点（Chrome 版本、时区、语言、自动化标记）
async function probeEnvironment(page) {
    try {
        return await page.evaluate(() => ({
            ua: (navigator.userAgent || '').slice(0, 120),
            platform: navigator.platform,
            languages: (navigator.languages || []).join(','),
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
            webdriver: navigator.webdriver,
            timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return '未知'; } })(),
            screen: `${window.screen.width}x${window.screen.height}`,
            dpr: window.devicePixelRatio,
        }));
    } catch (e) {
        return { error: e.message };
    }
}

// 探测 WebRTC 是否泄露：ICE candidate 里的地址即页面 JS 能读到的出口地址。
// 出现 srflx（STUN 公网映射）且与本机/代理出口 IP 不一致 = 真实 IP 被暴露。
// 经 --proxy-server=socks5 时 UDP 不代理，STUN 会直连出去，故此项在 CI 上尤需确认。
async function probeWebRtc(page) {
    try {
        const out = await page.evaluate(() => new Promise((resolve) => {
            const res = { candidates: [], error: null };
            try {
                const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
                const finish = () => { try { pc.close(); } catch (e) {} resolve(res); };
                const timer = setTimeout(finish, 8000);
                pc.onicecandidate = (e) => {
                    if (!e.candidate) { clearTimeout(timer); finish(); return; }
                    const c = e.candidate.candidate || '';
                    const m = /candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\w+)/.exec(c);
                    res.candidates.push(m ? `${m[1]} (${m[2]})` : c.slice(0, 60));
                };
                pc.createDataChannel('t');
                pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => { res.error = e.message; });
            } catch (e) { res.error = e.message; resolve(res); }
        }));
        return { candidates: [...new Set(out.candidates)], error: out.error };
    } catch (e) {
        return { error: e.message };
    }
}

// 登录流程：过盾 → fail-closed → 点 Sign in → 等 /dashboard + localStorage.trc_token
async function login(page) {
    log('🌐 打开主站登录页...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanWait(2, 4);
    // 若被 CF 拦到 challenge 中间页，CF 会自行 invisible 放行；给一点缓冲
    await dismissCookieConsent(page);
    // 轻微的人类交互，帮助 CF 的被动检测（无 token 时不必走到这里）
    await page.bringToFront();
    for (let i = 0; i < 5; i++) {
        await page.mouse.move(420 + i * 35, 380 + i * 12, { steps: 6 });
        await sleep(250);
    }

    let tokenOk = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
        // 每轮先确保凭证在（Turnstile 重新触发可能清表单）
        await fillCredentials(page);

        // 先等 CF invisible 放行；不放行则按节奏真实点击验证框
        if (await solveTurnstile(page, { timeoutS: attempt === 1 ? 90 : 60 })) {
            tokenOk = true;
            break;
        }
        log(`⏳ 第 ${attempt} 次未拿到 token，重试...`);
        // 触发重新渲染 Turnstile：整页重开
        if (attempt < 2) {
            await page.evaluate(() => { try { window.location.reload(); } catch (e) {} });
            await humanWait(4, 7);
            await dismissCookieConsent(page);
        }
    }

    if (!tokenOk) {
        const diag = await diagnosePage(page);
        log(`🩺 登录诊断: ${JSON.stringify(diag)}`);
        // Turnstile 不放行时排查环境信号：WebRTC 是否绕过 socks5 代理暴露真实 IP
        log(`🩺 环境诊断: ${JSON.stringify(await probeEnvironment(page))}`);
        log(`🩺 WebRTC 泄漏诊断: ${JSON.stringify(await probeWebRtc(page))}`);
        try { await page.screenshot({ path: 'artifacts/turnstile_fail.png' }); } catch (e) {}
        throw new Error('Cloudflare Turnstile 验证未通过：未拿到有效 token，已终止（不点 Sign in）。');
    }

    // Turnstile 求解期间表单可能被重渲染清空，点 Sign in 前再确认填入
    await fillCredentials(page);

    log('🖱️ 点击 Sign in...');
    // 登录按钮在 token 就绪前是 disabled，等它解除后再点
    let clicked = false;
    for (let i = 0; i < 10 && !clicked; i++) {
        clicked = await page.evaluate(() => {
            const b = document.querySelector('[data-testid="login-submit"]');
            if (b && !b.disabled) { b.click(); return true; }
            return false;
        }).catch(() => false);
        if (!clicked) await sleep(1000);
    }
    await humanWait(3, 5);

    for (let i = 0; i < 30; i++) {
        const diag = await diagnosePage(page);
        if (diag.hasAuthToken && /\/dashboard/.test(page.url())) {
            log(`✅ 登录成功，已跳转: ${page.url()}`);
            return page.url();
        }
        if (diag.errText && /invalid|incorrect|wrong|failed|security check|错误|失败/i.test(diag.errText)) {
            log(`❌ 检测到登录错误: ${diag.errText}`);
            try { await page.screenshot({ path: 'artifacts/login_error.png' }); } catch (e) {}
            throw new Error(`登录被拒: ${diag.errText}`);
        }
        await sleep(1000);
    }
    const diag = await diagnosePage(page);
    try { await page.screenshot({ path: 'artifacts/login_timeout.png' }); } catch (e) {}
    throw new Error(`登录超时未跳转 Dashboard | ${diag.url || ''} | ${diag.errText || ''}`);
}

// 在主站页面上下文里调 API：页面里的 axios 拦截器就是用 localStorage.trc_token 加 Bearer
async function apiFetch(page, path, options = {}) {
    return await page.evaluate(async (p, opt) => {
        const token = localStorage.getItem('trc_token') || '';
        const headers = Object.assign({}, opt.headers || {});
        if (token) headers.Authorization = 'Bearer ' + token;
        if (opt.body !== undefined && opt.body !== null) headers['Content-Type'] = 'application/json';
        try {
            const res = await fetch(p, {
                method: opt.method || 'GET',
                headers,
                body: opt.body === undefined || opt.body === null ? undefined : JSON.stringify(opt.body),
            });
            const raw = await res.text();
            let body = raw;
            try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw.slice(0, 300); }
            return { status: res.status, body };
        } catch (e) {
            return { status: 0, body: null, error: e.message };
        }
    }, `${API_BASE}${path}`, options);
}

// 续期窗口（分钟）：主站 /api/settings/public 暴露 renew_window_minutes，默认 30
async function fetchRenewWindowMinutes(page) {
    const r = await apiFetch(page, '/settings/public');
    const n = r.status === 200 && r.body ? Number(r.body.renew_window_minutes) : 0;
    return n > 0 ? n : DEFAULT_RENEW_WINDOW_MINUTES;
}

// GET /api/servers：dashboard 渲染用的同一份数据
async function listServers(page) {
    const r = await apiFetch(page, '/servers');
    if (r.status !== 200 || !Array.isArray(r.body)) {
        throw new Error(`读取服务器列表失败: HTTP ${r.status} ${JSON.stringify(r.body || r.error || '').slice(0, 200)}`);
    }
    return r.body;
}

function expiresAtMs(server) {
    const t = server && server.expires_at ? new Date(server.expires_at).getTime() : 0;
    return Number.isFinite(t) ? t : 0;
}

function serverLabel(server) {
    const name = server.name || `#${server.id}`;
    return server.pterodactyl_identifier ? `${name} #${server.pterodactyl_identifier}` : name;
}

function fmtTime(ms) {
    if (!ms) return '未知';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 点击 dashboard 卡片上的续期按钮：<button data-testid="renew-<serverId>">
// 返回 { ok, detail }。按钮未出现/被禁用时返回 ok=false，由调用方决定回退 API。
async function clickRenewButton(page, serverId) {
    const sel = `[data-testid="renew-${serverId}"]`;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const state = await page.evaluate((s) => {
            const b = document.querySelector(s);
            if (!b) return 'missing';
            const r = b.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return 'hidden';
            if (b.disabled) return 'disabled';
            b.click();
            return 'clicked';
        }, sel).catch(() => 'error');
        if (state === 'clicked') return { ok: true, detail: '' };
        if (state === 'disabled') return { ok: false, detail: '按钮处于 disabled（可能已在处理中）' };
        await sleep(500);
    }
    return { ok: false, detail: '未找到可点击的续期按钮' };
}

// 续期：主站 dashboard 的 "↻ Renew and restore for another 12 hours"。优先点击真实按钮，
// 按钮不可用时回退到按钮背后的同名接口 POST /api/servers/{id}/renew。
// 判定与前端一致：免费服务器处于 suspended，或距离 expires_at 不足续期窗口。
async function renew(page) {
    log('📂 打开 dashboard...');
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => log(`⚠️ 打开 dashboard 失败: ${e.message}`));
    await humanWait(2, 4);

    const windowMinutes = await fetchRenewWindowMinutes(page);
    const windowMs = windowMinutes * 60 * 1000;
    const servers = await listServers(page);
    // 与前端 m 列表同款过滤：排除 cancelled，以及 expired 且没有面板 ID（已彻底释放）的
    const free = servers.filter((s) => s.is_free && s.status !== 'cancelled' && !(s.status === 'expired' && !s.pterodactyl_server_id));
    log(`📋 服务器 ${servers.length} 台（免费 ${free.length} 台），续期窗口 ${windowMinutes} 分钟`);

    const now = Date.now();
    const eligible = free.filter((s) => {
        const exp = expiresAtMs(s);
        return s.status === 'suspended' || (exp > 0 && exp - now <= windowMs);
    });

    if (!eligible.length) {
        const upcoming = free
            .filter((s) => expiresAtMs(s) > now)
            .sort((a, b) => expiresAtMs(a) - expiresAtMs(b))[0];
        const text = upcoming
            ? `未到续期窗口：${serverLabel(upcoming)} 于 ${fmtTime(expiresAtMs(upcoming))} 到期（窗口 ${windowMinutes} 分钟）`
            : '没有需要续期的免费服务器';
        log(`⏳ ${text}`);
        try { await page.screenshot({ path: 'artifacts/renewal_not_due.png', fullPage: true }); } catch (e) {}
        return { ok: false, status: 'not_due', text };
    }

    log(`🖱️ 续期 ${eligible.length} 台: ${eligible.map(serverLabel).join(', ')}`);
    const done = [];
    const problems = [];
    for (const s of eligible) {
        const before = expiresAtMs(s);
        const click = await clickRenewButton(page, s.id);
        if (!click.ok) {
            log(`⚠️ ${serverLabel(s)} ${click.detail}，回退调用续期接口...`);
            const r = await apiFetch(page, `/servers/${s.id}/renew`, { method: 'POST' });
            if (r.status !== 200) {
                const detail = (r.body && r.body.detail) || r.error || `HTTP ${r.status}`;
                problems.push(`${serverLabel(s)}: ${detail}`);
                log(`❌ ${serverLabel(s)} 续期失败: ${detail}`);
                continue;
            }
        } else {
            log(`🖱️ 已点击 ${serverLabel(s)} 的续期按钮`);
        }
        done.push({ id: s.id, label: serverLabel(s), before });
        log(`✅ ${serverLabel(s)} 续期请求已提交`);
    }

    // 复核：重新拉列表，确认 expires_at 变长（后端可能有几秒延迟，最多等 8 秒）
    let after = [];
    for (let i = 0; i < 4; i++) {
        await sleep(2000);
        after = await listServers(page).catch((e) => { log(`⚠️ 复核列表失败: ${e.message}`); return []; });
        const map = new Map(after.map((s) => [s.id, s]));
        const allExtended = done.every((d) => {
            const s = map.get(d.id);
            return s && (expiresAtMs(s) > d.before || (s.status === 'active' && expiresAtMs(s) > Date.now()));
        });
        if (allExtended) break;
    }
    const byId = new Map(after.map((s) => [s.id, s]));
    const renewed = [];
    for (const d of done) {
        const s = byId.get(d.id);
        if (!s) { problems.push(`${d.label}: 刷新后找不到该服务器`); continue; }
        const exp = expiresAtMs(s);
        if (exp > d.before) renewed.push(`${d.label}: ${fmtTime(d.before)} → ${fmtTime(exp)}`);
        else if (s.status === 'active' && exp > Date.now()) renewed.push(`${d.label}: 到期时间 ${fmtTime(exp)}`);
        else problems.push(`${d.label}: expires_at 未变化（前 ${fmtTime(d.before)} / 后 ${fmtTime(exp)}）`);
    }

    if (renewed.length && !problems.length) {
        const text = `已续期 ${renewed.length} 台｜${renewed.join('；')}`;
        log(`✅ ${text}`);
        try { await page.screenshot({ path: 'artifacts/renewal_ok.png', fullPage: true }); } catch (e) {}
        return { ok: true, status: 'success', text };
    }
    if (renewed.length) {
        const text = `部分成功 ${renewed.length}/${eligible.length}｜${renewed.join('；')}｜失败: ${problems.join('；')}`;
        log(`⚠️ ${text}`);
        try { await page.screenshot({ path: 'artifacts/renewal_fail.png', fullPage: true }); } catch (e) {}
        return { ok: false, status: 'failed', text };
    }
    const text = `续期失败: ${problems.join('；') || '未知原因'}`;
    log(`❌ ${text}`);
    try { await page.screenshot({ path: 'artifacts/renewal_fail.png', fullPage: true }); } catch (e) {}
    return { ok: false, status: 'failed', text };
}



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
        log(`📍 当前出口IP: ${egressIp || '未知'}`);
    } catch (e) {
        log(`⚠️ 获取出口 IP 失败: ${e.message}`);
        // 代理异常提前暴露，但不直接终止：继续尝试登录，让 Turnstile 失败做最终判定
    }

    try {
        await login(page);
    } catch (e) {
        log(`❌ 登录失败: ${e.message}`);
        const extra = egressIp ? `🌐 出口IP: ${egressIp}` : '';
        await sendTelegram(formatNotification('❌ 登录失败', extra, e.message));
        try { await browser.close(); } catch (x) {}
        return;
    }

    try {
        const r = await renew(page);
        const renewalText = r.status === 'not_due' ? `⏳ ${r.text}` : r.text;
        const extra = [
            renewalText,
            egressIp ? `🌐 出口IP: ${egressIp}` : '',
        ].filter(Boolean).join(' | ');
        if (r.ok) {
            await sendTelegram(formatNotification('✅ 续期成功', extra));
        } else if (r.status === 'not_due') {
            await sendTelegram(formatNotification('⏳ 未到续期时间', extra));
        } else {
            await sendTelegram(formatNotification('❌ 续期失败', extra));
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

// 导出各阶段函数，便于验证脚本直接跑真实流程（不改变 `node renew_therose.js` 的行为）
module.exports = { launchRealBrowser, login, getTurnstileToken, waitTurnstileToken, solveTurnstile, fillCredentials, diagnosePage, probeEnvironment, probeWebRtc, listServers, renew, main };
