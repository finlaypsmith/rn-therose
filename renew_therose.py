#!/usr/bin/env python3

import os,re,sys,time,requests
from seleniumbase import SB

# 环境变量
EMAIL = os.environ.get("EMAIL") or ""            # 邮箱
PASSWORD = os.environ.get("PASSWORD") or ""      # 密码
TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN") or ""  # tg通知 bot token
TG_CHAT_ID = os.environ.get("TG_CHAT_ID") or ""      # tg通知 chat_id id

# 代理配置（由 setup_proxy.sh 写入 GITHUB_ENV）
IS_PROXY = os.environ.get("IS_PROXY", "false").lower() == "true"
PROXY_SERVER = os.environ.get("PROXY_SERVER", "").strip() or "socks5://127.0.0.1:1080"

BASE_URL = "https://client.therose.cloud/login"

# 获取当前出口ip（用于确认代理是否生效）
def get_current_ip(proxy_server: str = "") -> str:
    proxies = None
    if proxy_server:
        proxies = {"http": proxy_server, "https": proxy_server}
    response = requests.get("https://api.ip.sb/ip", proxies=proxies, timeout=15)
    response.raise_for_status()
    return response.text.strip()

# 检查必要变量
if not EMAIL or not PASSWORD:
    print("❌ 请设置环境变量 EMAIL 和 PASSWORD")
    sys.exit(1)

# 点击续期按钮
def click_extend_button(sb):
    selectors = [
        'span:contains("Extend")',
        'button:contains(title="Extend")',
    ]
    for sel in selectors:
        try:
            if sb.find_element(sel, timeout=2):
                print(f"✅ 找到按钮，选择器: {sel}")
                sb.uc_click(sel, timeout=5)
                print("✅ 点击成功")
                return True, {}
        except:
            continue
    try:
        btn = sb.find_element('button:contains("Extend")', timeout=2)
        sb.driver.execute_script("arguments[0].click();", btn)
        print("✅ 通过 JavaScript 点击成功")
        return True, {}
    except Exception as e:
        return False, {"error": str(e)}

# 检查续期是否成功
def check_renewal_success(sb):
    """检查是否出现续期成功的提示"""
    success_selectors = [
        '.alert-success',
        '.alert.alert-success',
        'div[role="alert"].alert-success',
        'div.alert-success',
        'span:contains("successfully purchased")',
        'div:contains("successfully purchased")'
    ]

    print("⏳ 等待5秒检查续期结果...")
    time.sleep(5)

    for selector in success_selectors:
        try:
            element = sb.find_element(selector, timeout=2)
            if element:
                text = element.text
                print(f"✅ 发现成功提示！选择器: {selector}")
                print(f"📝 提示内容: {text}")
                return True, text
        except:
            continue

    try:
        page_source = sb.get_page_source()
        if "successfully purchased" in page_source.lower():
            print("✅ 页面源码中发现 'successfully purchased' 关键词")
            return True, "服务器已成功续期"
    except:
        pass

    return False, "未检测到续期成功提示"

# 掩码邮箱（只用于通知展示，脱敏）
def mask_email(email: str) -> str:
    if '@' in email:
        name, domain = email.split('@', 1)
        if len(name) > 4:
            return f"{name[:2]}****{name[-2:]}@{domain}"
        return f"{name}@{domain}"
    return email[:2] + '****' if email else "（未配置）"

# 通知格式
def format_notification(status: str, extra: str = "", error: str = "") -> str:
    local_time = time.gmtime(time.time() + 8 * 3600)
    now = time.strftime("%Y-%m-%d %H:%M:%S", local_time)
    lines = [
        "🌹 The Rose Cloud 续期通知",
        "",
        f"{status}",
        f"👤 登录账户: {mask_email(EMAIL)}",
    ]
    if extra:
        lines.append(extra)
    if error:
        lines.append(f"⚠️ 错误信息: {error}")
    lines.append(f"⏱️ 执行时间: {now}")
    return "\n".join(lines)

# 发送tg通知
def send_tg(token, chat_id, message):
    if not token or not chat_id:
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        resp = requests.post(url, json={"chat_id": chat_id, "text": message}, timeout=10)
        if resp.status_code == 200:
            print("📨 Telegram 通知已发送")
        else:
            print(f"❌ Telegram 发送失败: {resp.text}")
    except Exception as e:
        print(f"❌ Telegram 发送异常: {e}")

# 等待 Turnstile 验证通过（只认真实 token，避免文案误判）
def wait_for_turnstile_pass(sb, timeout=30):
    pending_markers = [
        "verify you are human",
        "确认您是真人",
        "just a moment",
        "checking your browser",
        "正在验证",
        "验证中",
        "stuck?",
        "卡住",
    ]
    start = time.time()
    while time.time() - start < timeout:
        try:
            token = sb.execute_script(
                "var el=document.querySelector("
                "'[name=\"cf-turnstile-response\"], textarea[name=\"cf-turnstile-response\"], "
                "input[name=\"cf-turnstile-response\"]');"
                "return el ? (el.value || '') : '';"
            )
            if token and len(token) > 20:
                print("✅ Turnstile token 已就绪")
                return True
        except Exception:
            pass
        try:
            page_lower = sb.get_page_source().lower()
            if any(x in page_lower for x in pending_markers):
                # 仍在验证中，继续等
                sb.sleep(1)
                continue
        except Exception:
            pass
        sb.sleep(1)
    print("❌ Turnstile 验证超时未通过（未拿到 token）")
    return False

# 采集登录页错误信息
def extract_login_error(sb) -> str:
    selectors = [
        ".alert-danger",
        ".alert.alert-danger",
        "div[role='alert']",
        ".invalid-feedback",
        ".form-error",
        ".error-message",
        "div.alert",
    ]
    for sel in selectors:
        try:
            if sb.is_element_visible(sel):
                text = (sb.get_text(sel) or "").strip()
                if text:
                    return text[:300]
        except Exception:
            continue
    try:
        body = (sb.get_text("body") or "")[:500]
        for kw in ["invalid", "incorrect", "failed", "error", "wrong", "captcha", "验证", "错误", "失败"]:
            if kw in body.lower():
                return body.replace("\n", " ").strip()[:200]
    except Exception:
        pass
    return ""

# 登录流程
def login(sb, email, password):
    print("🌐 打开登录页面...")
    # UC 模式：打开后短暂断开 chromedriver，降低 CF 检测
    sb.uc_open_with_reconnect(BASE_URL, reconnect_time=4)
    sb.wait_for_ready_state_complete()
    sb.sleep(2)

    def fill_credentials():
        print("📧 填写邮箱...")
        sb.type("#login_form_email", email, timeout=10)
        print("🔑 填写密码...")
        sb.type("#login_form_password", password, timeout=10)
        sb.sleep(0.5)
        # 确认已写入（非 placeholder）
        try:
            v = sb.get_value("#login_form_email") or ""
            if email not in v and v != email:
                print(f"⚠️ 邮箱字段异常: {v!r}，重试填写")
                sb.clear("#login_form_email")
                sb.type("#login_form_email", email, timeout=10)
                sb.clear("#login_form_password")
                sb.type("#login_form_password", password, timeout=10)
        except Exception as e:
            print(f"⚠️ 校验表单字段失败: {e}")

    fill_credentials()

    # 处理 Turnstile：最多重试 3 次，通过后再点登录
    print("🛡 处理 Turnstile...")
    turnstile_passed = False
    for attempt in range(1, 4):
        # 每次尝试前确保凭证仍在
        try:
            v = sb.get_value("#login_form_email") or ""
            if not v or email not in v:
                fill_credentials()
        except Exception:
            fill_credentials()

        try:
            sb.uc_gui_click_captcha(retry=True, blind=True)
            print(f"✅ 第 {attempt} 次点击 Turnstile")
            sb.sleep(5)
        except Exception as e:
            print(f"⚠️ uc_gui_click_captcha 异常 (第{attempt}次): {e}")

        if wait_for_turnstile_pass(sb, timeout=25):
            turnstile_passed = True
            break
        print(f"⏳ 第 {attempt} 次未通过，重试...")
        sb.sleep(2)

    if not turnstile_passed:
        err = extract_login_error(sb) or "Turnstile 验证未通过"
        print(f"❌ {err}")
        sb.save_screenshot("login_failed.png")
        return False, f"{sb.get_current_url()} | {err}"

    # 点击前再确认凭证
    try:
        v = sb.get_value("#login_form_email") or ""
        if not v or email not in v:
            fill_credentials()
    except Exception:
        fill_credentials()

    print("🔑 点击登录按钮...")
    try:
        sb.uc_click('button:contains("Sign in")')
    except Exception as e:
        print(f"⚠️ uc_click 失败，尝试 JS 点击: {e}")
        try:
            btn = sb.find_element('button:contains("Sign in")', timeout=5)
            sb.driver.execute_script("arguments[0].click();", btn)
        except Exception as e2:
            sb.save_screenshot("login_failed.png")
            return False, f"点击 Sign in 失败: {e2}"

    sb.sleep(4)

    # 提交后若再次出现验证码，再点一次
    try:
        page_lower = sb.get_page_source().lower()
        if any(x in page_lower for x in ["正在验证", "verify you are human", "cf-turnstile"]):
            print("🛡 登录后再次出现 Turnstile，继续处理...")
            sb.uc_gui_click_captcha(retry=True, blind=True)
            wait_for_turnstile_pass(sb, timeout=20)
            sb.sleep(2)
    except Exception:
        pass

    for i in range(30):
        current_url = sb.get_current_url()
        page_title = sb.get_title() or ""
        print(f"📄 [{i+1}/30] URL: {current_url} | Title: {page_title}")
        if "panel" in current_url or "/dashboard" in current_url:
            print("✅ 登录成功，已跳转到 Dashboard")
            return True, current_url
        if i >= 3 and i % 5 == 0:
            err = extract_login_error(sb)
            if err and any(k in err.lower() for k in ["invalid", "incorrect", "wrong", "错误", "失败"]):
                print(f"❌ 检测到登录错误: {err}")
                sb.save_screenshot("login_failed.png")
                return False, f"{current_url} | {err}"
        time.sleep(1)

    err = extract_login_error(sb) or "超时未跳转 Dashboard"
    print(f"❌ 登录失败: {err} | URL: {sb.get_current_url()}")
    sb.save_screenshot("login_failed.png")
    return False, f"{sb.get_current_url()} | {err}"

# 主流程
def main():
    print("🚀 启动浏览器")

    sb_kwargs = {"uc": True, "headless": False}

    if IS_PROXY:
        print(f"🔗 挂载代理: {PROXY_SERVER}")
        sb_kwargs["proxy"] = PROXY_SERVER
    else:
        print("🍭 未使用代理，直连访问")

    with SB(**sb_kwargs) as sb:
        ip = ""
        try:
            ip = get_current_ip(PROXY_SERVER if IS_PROXY else "")
            print(f"📍 当前出口IP: {ip}")
        except Exception as e:
            print(f"⚠️ 获取出口 IP 失败: {e}")

        success, url = login(sb, EMAIL, PASSWORD)

        if not success:
            msg = format_notification("❌ 登录失败", error=str(url))
            print(msg)
            send_tg(TG_BOT_TOKEN, TG_CHAT_ID, msg)
            return

        print("📄 开始续期流程...")

        ok, info = click_extend_button(sb)
        if not ok:
            msg = format_notification("❌ 续期失败", error=f"点击 Extend 按钮失败: {info.get('error')}")
            print(msg)
            send_tg(TG_BOT_TOKEN, TG_CHAT_ID, msg)
            return

        time.sleep(1)

        try:
            button = sb.find_element('button:contains("Order now")', timeout=5)
            if button:
                print("🛒 点击 Order now 按钮...")
                sb.uc_click('button:contains("Order now")')
                print("✅ 已点击 Order now 按钮")
            else:
                msg = format_notification("❌ 续期失败", error="未找到 Order now 按钮")
                print(msg)
                send_tg(TG_BOT_TOKEN, TG_CHAT_ID, msg)
                return
        except Exception as e:
            msg = format_notification("❌ 续期失败", error=f"点击 Order now 失败: {e}")
            print(msg)
            send_tg(TG_BOT_TOKEN, TG_CHAT_ID, msg)
            return

        print("🔍 检查续期结果...")
        renewal_success, renewal_msg = check_renewal_success(sb)

        ip_extra = f"🌐 出口IP: {ip}" if ip else ""

        if renewal_success:
            status = "✅ 续期成功"
            extra = renewal_msg
            print(f"✅ 续期成功！{renewal_msg}")
            sb.save_screenshot("renewal_success.png")
        else:
            status = "❌ 续期可能失败"
            extra = "请登录后台检查"
            print(f"❌ 续期可能失败: {renewal_msg}")
            sb.save_screenshot("renewal_failed.png")

        msg = format_notification(
            status,
            extra=" | ".join(filter(None, [extra, ip_extra])),
            error="" if renewal_success else renewal_msg,
        )
        print(msg)
        send_tg(TG_BOT_TOKEN, TG_CHAT_ID, msg)

    print("🏁 脚本执行完毕")

if __name__ == "__main__":
    main()
