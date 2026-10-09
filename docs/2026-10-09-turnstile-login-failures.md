# The Rose Cloud 续期登录失败排查记录

- 日期：2026-10-09
- 影响文件：`renew_therose.js`
- 修复提交：`4596a18`（根因一）、`3ecd9f0`（根因二）、`b27c9f6`（根因三）

## 摘要

同一个现象——登录阶段稳定失败、Turnstile token 恒为 0——背后是**三个互相独立的根因**，
必须逐个排查。三者都不在预期方向上：既不是 CF 变严，也不是代理或凭证问题。

| # | 根因 | 修复 |
|---|---|---|
| 一 | `puppeteer-real-browser` 内置求解器误点 **Sign in**，表单反复提交、页面不断重导航，Turnstile 流程被打断 | `turnstile: true` → `false` |
| 二 | `--proxy-server=socks5` 只代理 TCP，**WebRTC 的 STUN(UDP) 绕过代理**，把 runner 真实 IP 经 ICE candidate 交给页面 JS | 加 `--webrtc-ip-handling-policy=disable_non_proxied_udp` |
| 三 | GitHub Actions runner 默认时区为 **UTC**，真人浏览器几乎不会是 UTC，CF 据此判为数据中心/自动化而拒绝放行 | 将 `process.env.TZ` 设为正常时区 |

排查过程是一层层剥出来的，前两次修复都"确实生效了、但没能解决问题"，直到下一个根因暴露：

- 修完根因一：**本机通过、CI 仍失败** → "只在 CI 复现"这个差异指向根因二；
- 修完根因二：WebRTC 泄漏确实消除（`srflx` 从 candidate 列表消失），**CI 仍失败**
  → 它是个真实缺陷，却不是本次失败的原因。**这一步的教训：修复"生效了"不等于"修对了地方"**；
- 根因三是最后一块拼图：本机把 `TZ` 设为 `UTC` 即可稳定复现 CI 的失败。

## 共同现象

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

## 根因一：求解器误点 Sign in

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

### 根因

`puppeteer-real-browser@1.4.4` 的求解器（`lib/cjs/module/turnstile.js`）内置两条假设：

1. widget 是 **300×65** 的标准尺寸——据此用「宽度 290–310 且无子元素的 div」兜底定位；
2. 点击点取 `[name="cf-turnstile-response"]` 父元素的 `(左边缘 + 30, 垂直中心)`。

而本站登录页的 `.cf-turnstile` 是 **480×70 的整宽 Bootstrap 容器**，且
**Turnstile 渲染完成前高度为 0**，此时容器与下方 Sign in 按钮位置重叠。求解器每 1 秒
点一次，在渲染完成前直接命中 Sign in：

```
点中 Sign in → 表单提交（凭证可能还是空的）→ 服务端返回 /login
   → 页面重导航 → Turnstile 重新渲染 → 又被点击打断 → 死循环
```

这解释了「容器在、token 永远为空」以及诊断中 `errText` 为空——页面根本没走完验证流程，
也就没有错误文案。

> 原先能成功，推测是当时 CF 在本 IP / 指纹下即时 invisible 放行，token 在求解器第一次
> 误点之前就已就绪，误点虽发生但无害。CF 判定一旦变慢，误点就开始破坏流程——这是个
> 正反馈死锁：CF 越慢，误点越多，页面被破坏得越彻底。

### 修复

```diff
- turnstile: true,   // 自动求解 Cloudflare Turnstile（替代旧版 uc_gui_click_captcha）
+ turnstile: false,
```

已核对 `puppeteer-real-browser/lib/cjs/index.js`：该开关**只**控制 `pageController`
里的点击循环（`solveStatus = turnstile`），**不影响**反检测 flags
（`--disable-features=...,AutomationControlled`）与指纹注入。关闭它不削弱过盾能力。

保留不变：以「token 非空」为唯一权威信号、fail-closed（无 token 绝不点 Sign in）、
3 轮重试、TG 通知。

## 根因二：WebRTC 泄漏 runner 真实 IP

修完根因一后，本机 11–14 秒稳定通过，**CI 上三轮 90 秒仍全部失败**。同一个脚本、
同一个代理出口 IP，差异只可能来自运行环境。

### 为什么本机复现不出来

本机是 TUN 代理：网络层把 **UDP 也一并代理**，WebRTC 的 STUN 反射地址同样是
`190.5.208.24`，与 HTTP 出口一致，不构成矛盾。CI 是 `--proxy-server=socks5://...`：
Chrome 只把 TCP 的 HTTP(S) 交给代理，**WebRTC 的 UDP 不经过它**。

本机也无法用实验去测这件事——本机到 Google STUN 的 UDP 根本不通，连 baseline 都拿不到
srflx，任何结果都是假阴性：

```
baseline（完全不挂代理）:  srflx(公网映射): 0 个   ← 本机 STUN 不通，测不出差异
挂 socks5:                srflx: 0 个
```

所以这项只能在 CI 上直接测量 → 在失败诊断里加了 WebRTC 探测。

### 确诊

下一次 CI 运行拿到决定性证据：

```
📍 当前出口IP: 190.5.208.24                                    ← HTTP 走 socks5 代理
🩺 WebRTC 泄漏诊断: {"candidates":["f5a85156-…local (host)","134.33.77.212 (srflx)"]}
                                                               ↑ UDP 绕过代理
```

`134.33.77.212` 是 GitHub runner 的真实公网 IP（Azure），与出口 IP `190.5.208.24`
不一致。CF 同时看到「代理 IP + 数据中心 IP」，判定为明显的代理/自动化流量，因而拒绝
invisible 放行——正是「页面正常、容器在、就是不给 token」的表现。

### 修复

```js
'--webrtc-ip-handling-policy=disable_non_proxied_udp',
```

**开关名不带 `force-` 前缀。** `force-webrtc-ip-handling-policy` 是凭记忆容易写出的名字，
但 Chrome 155 二进制里并不存在，写了会被静默忽略、白跑一次 CI：

```bash
$ grep -a -c "force-webrtc" /opt/google/chrome/chrome
0
$ grep -a -o -E "force-webrtc[a-z-]*|webrtc-ip-handling-policy[a-z-]*" /opt/google/chrome/chrome
webrtc-ip-handling-policy
```

生效与否可在本机直接判定（不挂代理时，所有 UDP 都属"非代理"，该策略生效会让 candidate
消失）：

| 启动参数 | candidate 数 |
|---|---|
| baseline（无开关） | 1 个 `…local (host)` |
| `--webrtc-ip-handling-policy=disable_non_proxied_udp` | **0** |

策略语义是「WebRTC 不使用非代理的 UDP」：CI 上 UDP 只能经 socks5 走，代理支持
UDP ASSOCIATE 就得到与 HTTP 出口一致的 srflx，不支持则没有 UDP candidate——两种结果都
不再泄漏真实 IP。

## 根因三：浏览器时区为 UTC

根因二修复后，CI 的 `srflx` 确实消失了（`candidates: []`），**但 token 依然拿不到**。
本机在完全相同的 WebRTC 状态下却 15 秒通过——说明 WebRTC 虽是真缺陷，却不是失败原因。

于是回到"本机 vs CI 的差异"清单，把诊断里那几个本机可模拟的信号逐个试：

| 变量 | CI | 本机 | 结论 |
|---|---|---|---|
| 代理方式 | `--proxy-server=socks5` | TUN | 本机自建 socks5 中继复现后也通过 → **排除** |
| WebRTC | 已修复为 `[]` | `[]` | 两者一致 → **排除** |
| **时区** | **UTC** | Asia/Hong_Kong | `TZ` 环境变量可直接模拟 → **复现** |

socks5 那项值得单独记一笔：本机没有 socks5 端口，为此写了个只做 TCP CONNECT 转发的
中继（`.tmp/probe/socks5-relay.js`）来模拟 CI 的代理方式，结果**本机走 socks5 也 9 秒通过**，
据此把"代理方式"整个排除。

### 确诊

```
$ TZ=UTC xvfb-run -a node …verify-login.js
[07:16:46] ⏳ 仍未拿到 token（若持续如此，CF 可能改判为 interactive challenge）...
[07:17:46] ⏳ 第 1 次未拿到 token，重试...
[07:18:21] ⏳ 仍未拿到 token...
```

同一出口 IP、同一份代码，仅改 `TZ`：

| 浏览器时区 | 结果 |
|---|---|
| `Asia/Hong_Kong`（本机默认） | 成功 ×5 |
| `America/Sao_Paulo` | 成功（13s） |
| `UTC` | **失败 ×2** |

`UTC` 是 GitHub Actions runner 的默认时区，也是真人浏览器的**非典型**时区——普通用户的
浏览器时区跟着物理位置走，几乎不会停在 UTC，因此它被 CF 当作数据中心/自动化特征。

注意这与"时区要匹配 IP 地理位置"不是一回事：出口 IP 在巴西，本机用 `Asia/Hong_Kong`
（相差 11 小时）照样通过，说明 CF 并不强求时区与 IP 一致，而是对 `UTC` 这个**特定值**敏感。

### 修复

```js
process.env.TZ = process.env.RENEW_TZ || 'America/Sao_Paulo';
```

必须早于浏览器启动——Chrome 由 chrome-launcher 以子进程拉起，继承 `process.env`。

两处细节：

- **不读系统 `TZ`**，改用独立的 `RENEW_TZ` 作为覆盖点。CI 上系统 `TZ`（或 runner 的
  `/etc/localtime`）恰恰就是出问题的 UTC，若写成 `process.env.TZ || '…'` 会保留 UTC、修复失效。
- 取与该代理出口 IP（190.5.208.24，巴西 Recife）地理一致的时区。实测 CF 并不强求一致，
  但一致总归更自然；节点若更换，可用 `RENEW_TZ` 覆盖。

## 验证

端到端（真实 `launchRealBrowser()` + `login()`，只登录、不执行 `renew()`，无续期副作用）。
最关键的一次是**外部强制 `TZ=UTC` 模拟 runner 条件**，由脚本内部覆盖：

```
$ TZ=UTC xvfb-run -a node …verify-diag.js
🩺 环境诊断: {…,"timezone":"America/Sao_Paulo",…}
                                ↑ 外部给的是 UTC，已被脚本覆盖

$ TZ=UTC xvfb-run -a node …verify-login.js
[04:28:48] ✅ Turnstile token 已就绪（长度 709）
[04:28:55] ✅ 登录成功，已跳转: https://client.therose.cloud/panel
```

即：CI 的时区条件 + 修复后的脚本 = 通过。

各阶段汇总：

| 阶段 | 本机 | CI |
|---|---|---|
| 修复前 | 3 轮 × 90s 超时 | 3 轮 × 90s 超时 |
| 只修根因一 | 11–14s 通过 | 3 轮 × 90s 仍超时 |
| 修根因一 + 二 | 15s 通过，`candidates: []` | 仍超时，`candidates: []` |
| 修根因一 + 二 + 三 | 通过（含 `TZ=UTC` 模拟） | **15s 过盾、登录成功** |

另有一条附带的排除性证据：加 WebRTC 策略后本机 WebRTC 完全不可用（0 个 candidate），
**登录依然成功**——说明「WebRTC 无 candidate」不会反过来被 CF 判死，否则本机就会立刻失败。

### CI 实跑复核

`workflow_dispatch`（2026-10-09）已跑通，登录阶段从此前的 3 轮 × 90s 超时变为 15 秒过盾：

```
[04:42:54] 🌐 打开登录页面...
[04:43:09] ✅ Turnstile token 已就绪（长度 794）
[04:43:15] ✅ 登录成功，已跳转: https://client.therose.cloud/panel
[04:43:20] 🕒 续期前 Valid until: 2026-10-09 19:38
[04:43:26] ⏳ 未到续期时间: Renewal is available only within 30 minutes before expiration.
[04:43:41] 🏁 脚本执行完毕
```

后续流程（My servers → Extend → Order now → 结果检查）正常走完。续期本身返回 `not_due`
——站点要求到期前 30 分钟内才可续期，属业务限制，脚本按设计给出 `⏳ 未到续期时间`
而非误报为失败。

## 遗留与后续

1. **`page.goto` 无重试兜底**：`login()` 开头的导航偶发 60 秒超时后直接抛错退出。
   本机多次运行中命中过一次。
2. **无 interactive challenge 兜底**：若 CF 某天改判为需要点击的交互式挑战，关闭求解器
   后将无人点击，脚本会 fail-closed 干净失败并推 TG 通知（相比误点 Sign in，这是更可
   接受的降级）。如需兜底，应实现「仅在容器已渲染完成（高度 > 0）时才点击」的安全版本，
   而不是直接恢复 `turnstile: true`。
3. **诊断代码保留**：环境诊断与 WebRTC 探测挂在登录失败分支上，后续 CF 侧再出问题时可
   直接复用，不必重新搭排查脚手架。
4. **时区按出口 IP 硬编码**：`America/Sao_Paulo` 是依当前代理出口 IP（巴西）选的，节点
   若换到别国可用 `RENEW_TZ` 调整。实测 CF 并不强求时区与 IP 一致（本机用
   `Asia/Hong_Kong` 也能过），但这属于未验证的边界，不宜依赖。
5. **CF 判定会变**：三个根因都是多信号综合判定的结果，CF 侧规则也随时可能调整。再出
   问题时先跑失败诊断（环境 + WebRTC）拿数据，不要直接改代码猜。
6. **服务器状态识别未匹配**：CI 实跑时状态诊断输出
   `{"offline":false,"running":false,"canStart":false,"stopReady":false,"stopDisabled":false}`
   —— 四个状态全部落空，脚本据此判为「未检测到停止状态，无需启动」而跳过启动检查。该
   判定本身是保守的（不误操作），但四种状态同时不匹配，说明识别逻辑没对上页面实际状态，
   值得单独确认一次。

## 参考

- 最小复现与验证脚本：`.tmp/probe/`（已被 .gitignore 忽略，不入库）
  - `turnstile-diagnose3.js` 对照实验（开/关求解器）
  - `turnstile-diagnose4.js` 拦截误点，验证因果
  - `webrtc-flag-test.js` 比对 candidate 数，确认开关名有效
  - `socks5-relay.js` 本机 SOCKS5 中继，模拟 CI 的 `--proxy-server` 条件
  - `verify-login.js` 端到端登录验证
  - `verify-diag.js` 诊断输出验证
- 相关设计文档：`docs/superpowers/specs/2026-07-24-renew-therose-puppeteer-real-design.md`
