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

// 纯逻辑导出，供 tests/ 断言
module.exports = { maskEmail, timeToSeconds };
