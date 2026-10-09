# Turnstile 求解器误点 Sign in 导致登录失败（排查记录）

- 日期：2026-10-09
- 影响文件：`renew_therose.js`
- 修复提交：`4596a18`

## 摘要

登录阶段稳定失败、Turnstile token 永远为空，根因**不是** CF 变严、代理或凭证问题，
而是 `puppeteer-real-browser` 内置的 Turnstile 求解器反复误点 **Sign in 按钮**，
把页面打得不停重导航，Turnstile 流程永远无法完成。

修复：`connect({ turnstile: true })` → `turnstile: false`。该指纹 + 出口 IP 下
CF 本来就 invisible 放行，不需要求解器点击。

## 现象

CI 手动触发 `workflow_dispatch`，登录阶段三轮重试全部超时：

```
[03:58:18] 📡 等待 puppeteer-real-browser 自动求解 Turnstile...
[03:58:48] ⏳ Turnstile 仍在求解中（可能出现 interactive checkbox，自动求解器处理中）...
[03:59:48] ⏳ 第 1 次未拿到 token，重试...
...（第 2、3 轮相同）...
[04:03:00] 🩺 登录诊断: {"url":"https://client.therose.cloud/login","title":"TheRose Cloud | Login",
                       "hasCfIframe":true,"tokenLen":0,"errText":""}
[04:03:00] ❌ 登录失败: Cloudflare Turnstile 验证未通过：未拿到有效 token，已终止（不点 Sign in）。
```

特征：登录页正常打开、Turnstile 容器存在，但 token 始终为空，页面无任何错误文案。

## 排查

### 环境

本机出口 IP `190.5.208.24`，与 CI 日志中的 `190.5.***.24` 为同一节点
（本机 `198.18.x` 是 TUN 代理的 fake-ip 内部地址），因此可在本机忠实复现。

### 对照实验

用与生产一致的启动参数（`headless:false` + `xvfb-run` + 同一 `google-chrome`）
打开登录页，只观察不填凭证：

| 实验条件 | 主框架导航 | 求解器点击 | 结果 |
|---|---|---|---|
| `turnstile: true`（原状） | 每 2–3 秒重导航一次 | 34 次，固定 (718, 682) | token 恒为 0 |
| `turnstile: false` | 1 次 | 0 | 25 秒拿到 token（长度 730） |
| `turnstile: true` + 拦截落在按钮上的点击 | 1 次 | 拦截 3 次后放行 9 次 | 15 秒拿到 token（长度 709） |

第三组是关键：只挡住那 3 次误点，一切恢复正常，因果确认。

### 定位

```
.cf-turnstile 实测 rect = { x: 688, y: 647, w: 480, h: 70 }，渲染完成前 h: 0
求解器点击点          = (688 + 30, 647 + 70/2) = (718, 682)
elementFromPoint(718, 682) → "BUTTON | Sign in"     ← 容器渲染前该坐标与按钮重叠
```

## 根因

`puppeteer-real-browser@1.4.4` 的求解器
（`lib/cjs/module/turnstile.js`）内置两条假设：

1. widget 是 **300×65** 的标准尺寸——据此用「宽度 290–310 且无子元素的 div」
   兜底定位；
2. 点击点取 `[name="cf-turnstile-response"]` 父元素的 `(左边缘 + 30, 垂直中心)`。

而本站登录页的 `.cf-turnstile` 是 **480×70 的整宽 Bootstrap 容器**，且
**Turnstile 渲染完成前高度为 0**，此时容器与下方 Sign in 按钮位置重叠。求解器每 1 秒
点一次，在渲染完成前直接命中 Sign in：

```
点中 Sign in → 表单提交（凭证可能还是空的）→ 服务端返回 /login
   → 页面重导航 → Turnstile 重新渲染 → 又被点击打断 → 死循环
```

这解释了日志里「容器在、token 永远为空」以及诊断中 `errText` 为空——页面根本没走完
验证流程，也就没有错误文案。

> 原先能成功，推测是当时 CF 在本 IP / 指纹下即时 invisible 放行，token 在求解器第一次
> 误点之前就已就绪，误点虽发生但无害。CF 判定一旦变慢，误点就开始破坏流程——这是个
> 正反馈死锁：CF 越慢，误点越多，页面被破坏得越彻底。

## 修复

`renew_therose.js` 一行：

```diff
- turnstile: true,   // 自动求解 Cloudflare Turnstile（替代旧版 uc_gui_click_captcha）
+ turnstile: false,
```

已核对 `puppeteer-real-browser/lib/cjs/index.js`：该开关**只**控制
`pageController` 里的点击循环（`solveStatus = turnstile`），**不影响**反检测 flags
（`--disable-features=...,AutomationControlled`）与指纹注入。关闭它不削弱过盾能力。

保留不变：以「token 非空」为唯一权威信号、fail-closed（无 token 绝不点 Sign in）、
3 轮重试、TG 通知。

同一提交内的附带改动：

- 修正因此失真的 4 处注释/日志文案（原文案仍写「自动求解器处理中」，会把后续排障带偏）；
- 导出各阶段函数（`module.exports`），使验证脚本能调用真实流程而不必复制代码；
- 出口 IP 在日志与 TG 通知中改为**明文**输出，删除失效的 `maskIp`。

## 验证

用真实 `launchRealBrowser()` + `login()`（只登录，不执行 `renew()`，无续期副作用）：

```
[12:48:42] 🌐 打开登录页面...
[12:48:53] 📧 填写邮箱...
[12:49:04] ✅ Turnstile token 已就绪（长度 709）
[12:49:09] ✅ 登录成功，已跳转: https://client.therose.cloud/panel
```

两次独立运行均通过（28s / 33s 完成登录）。修复前为 3 轮 × 90s 全部失败。

CI 侧走 `--proxy-server=socks5://127.0.0.1:1080`，与本机 TUN 传输路径不同，出口 IP
相同——**结论在 CI 上仍需一次 `workflow_dispatch` 手动复核**。

## 遗留与后续

以下两项为排查中顺带发现，**未在本次修复范围内**：

1. **`page.goto` 无重试兜底**：`login()` 开头的导航偶发 60 秒超时后直接抛错退出。
   本机两次运行中命中过一次。
2. **无 interactive challenge 兜底**：若 CF 某天改判为需要点击的交互式挑战，关闭求解器
   后将无人点击，脚本会 fail-closed 干净失败并推 TG 通知（相比误点 Sign in，这是更可
   接受的降级）。如需兜底，应实现「仅在容器已渲染完成（高度 > 0）时才点击」的安全版本，
   而不是直接恢复 `turnstile: true`。

## 参考

- 最小复现与验证脚本：`.tmp/probe/`（已被 .gitignore 忽略，不入库）
  - `turnstile-diagnose3.js` 对照实验
  - `turnstile-diagnose4.js` 拦截误点验证因果
  - `verify-login.js` 端到端登录验证
  - `ip-check.js` 出口 IP 明文验证
- 相关设计文档：`docs/superpowers/specs/2026-07-24-renew-therose-puppeteer-real-design.md`
