# fast-mac-refurb

**Apple 官翻 Mac 补货提醒** —— 每 30 秒检查一次 Apple 美国官网翻新页面，一旦出现符合你条件的配置，立刻推送到 Telegram / 邮箱。免费跑在 Cloudflare 上，不用自己维护服务器。

> ### 🎉 作者已经靠它上车了
>
> **14 寸 MacBook Pro · M5 · 32GB · 1TB · 银色 · Nano-texture 屏 · $2,169**
>
> 正好命中下面优先级最高的组合：32GB 内存 > M5 芯片 > Nano-texture。翻新的热门配置往往几小时内就被抢光，提醒来得够快才抢得到。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Seeker98/fast-mac-refurb/tree/main/cloudflare-worker)

---

## 抢购思路：大内存 + 基础版芯片

作者的策略是把预算花在内存上，而不是芯片档位上：

- **内存决定一台 Mac 能用几年。** Apple Silicon 的内存焊在主板上，买了就不能升级。芯片性能多年后依然够用，内存不够却会越用越卡。
- **基础版芯片已经够用。** M5 基础版应付日常、开发和大部分创作都绰绰有余。Pro 芯片多出来的性能很多人用不上，却要多花不少钱。
- **翻新再省一笔。** 大内存的基础版在官网属于定制配置，翻新渠道通常比同配置新机便宜 15% 左右。

所以默认条件把 **32GB 内存放在最高优先级**，芯片里 M5 排在 M5 Pro 前面，M5 Pro 只在 24GB 的价位才考虑。省钱，也更耐用。

## 为什么不直接用现成的 refurb tracker

**经作者实测，市面上成熟的翻新库存提醒服务都有延迟：等它的邮件发到你手里，那台机器可能已经被别人买走了。** 热门配置往往上架没多久就会被抢光，晚几分钟就是错过。

这个项目为了快做了这些事：

- 每 30 秒检查一次，并且绕过 Apple 的 CDN 缓存（同一个地址最长会被缓存 2 分钟），拿到的是最新库存。
- 只盯你自己的条件，第一时间推送到 Telegram，比邮件更容易马上看到。
- 跑在你自己的 Cloudflare 账号上，只为你一个人服务。

## 瞄准的型号

默认条件就是作者自己用的那套：

| 条件 | 默认值 |
| --- | --- |
| 机型 | 14 寸 MacBook Pro |
| 芯片 | M5 或 M5 Pro（M5 优先） |
| 内存 | 32GB 或 24GB（32GB 优先）；M5 Pro 只要 24GB |
| 容量 | 1TB |
| 价格 | ≤ $2,249 |
| 同等条件下 | 优先 Nano-texture 屏，再优先深空黑 |

所有条件都能在部署时改，换成 MacBook Air、16 寸或者别的配置都行，见[修改监控条件](#修改监控条件)。

## 它是怎么工作的

- Apple 翻新页面会把**当前所有有货的翻新 Mac** 以 JSON 形式内嵌在 `window.REFURB_GRID_BOOTSTRAP` 里。程序下载页面、解析这段 JSON，再按你的条件筛选和排序。
- **绕过 CDN 缓存**：Apple 页面会在 CDN 上缓存最长 2 分钟，每次请求都带随机参数直接回源，拿到的是最新库存。
- **补货才提醒**：只在新出现符合条件的配置时推送。通知全部发送失败时，下一轮会重试，不会漏掉。
- **不误报**：连续 3 次检查都没看到才算下架，避免 CDN 节点数据不一致导致反复推送。
- **不会悄悄失效**：被限流或 Apple 改版导致抓取失败时，会自动放慢检查频率（最长 5 分钟一次）。连续失败超过 10 分钟会推送告警，恢复后再推送一次。
- 自带一个状态页，能看到当前在售的匹配配置、最近一次检查的结果和上下架历史。

> 只支持 Apple **美国**官网（apple.com/shop，价格为美元）。

## 一键部署到 Cloudflare（推荐）

需要准备：一个 Cloudflare 账号（免费计划就够），以及一个 Telegram 机器人。

**1. 准备 Telegram 机器人**

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示创建，拿到 **bot token**。
2. 给你的新机器人随便发一条消息。
3. 浏览器打开 `https://api.telegram.org/bot<你的token>/getUpdates`，在返回内容里找到 `"chat":{"id":...}`，这个数字就是 **chat id**。

**2. 点上面的 Deploy to Cloudflare 按钮**

1. 登录 Cloudflare，并授权连接你的 GitHub（会在你的账号下创建一个仓库副本，以后改条件直接改这个副本就会自动重新部署）。
2. 按页面提示填写：
   - `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`：上一步拿到的值。
   - `TEST_NOTIFY_SECRET`：随便设一个长字符串，用来测试通知。
   - 监控条件（`MEMORY_OPTIONS`、`MAX_PRICE_USD` 等）：保持默认，或者改成你想要的配置。
3. 点 Deploy，等一两分钟。

**3. 验证**

- 打开 `https://<你的 worker 地址>/test-notify?key=<你的 TEST_NOTIFY_SECRET>`，Telegram 应该收到一条测试消息。
- 打开 `https://<你的 worker 地址>/` 看状态页。部署后最多 1 分钟开始第一次检查，之后每 30 秒一次。

完成。之后只要出现符合条件的配置，Telegram 就会响。

## 用命令行部署

不想用按钮，或者想在本地改代码：

```bash
git clone https://github.com/Seeker98/fast-mac-refurb.git
cd fast-mac-refurb/cloudflare-worker
npm install
npx wrangler login

npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TEST_NOTIFY_SECRET

# 按需修改 wrangler.jsonc 里的 vars，然后：
npm run deploy
```

查看实时日志：`npm run tail`。

### 邮件通知（可选）

除了 Telegram，还可以通过 [Resend](https://resend.com) 发邮件。注册后再加几个 secret 即可（一键部署的用户可以在 Cloudflare 后台 Worker → Settings → Variables and Secrets 里添加）：

| Secret | 说明 |
| --- | --- |
| `RESEND_API_KEY` | Resend 的 API key |
| `EMAIL_TO` | 收件地址 |
| `EMAIL_FROM` | 发件地址（可选，默认 Resend 的测试发件人，只能发给你注册 Resend 的邮箱） |

## 修改监控条件

条件都在 `cloudflare-worker/wrangler.jsonc` 的 `vars` 里（一键部署时也会显示成表单）。改完重新部署即可生效，状态页顶部会显示当前生效的条件。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MODEL` | `macbookpro` | 产品线，如 `macbookpro`、`macbookair` |
| `SCREEN_SIZE` | `14inch` | 屏幕尺寸，如 `13inch`、`15inch`、`16inch` |
| `MEMORY_OPTIONS` | `32gb,24gb` | 可接受的内存，**按优先级从高到低**，逗号分隔 |
| `CHIP_OPTIONS` | `M5,M5 Pro` | 可接受的芯片，**按优先级从高到低**，逗号分隔 |
| `CHIP_MEMORY_OVERRIDES` | `M5 Pro=24gb` | 某些芯片只接受特定内存，如 `M5 Pro=24gb; M5 Max=36gb\|48gb`；留空表示不限制 |
| `CAPACITY` | `1tb` | 硬盘容量 |
| `MAX_PRICE_USD` | `2249` | 最高价格（美元）；留空表示不限价 |
| `PREFER_NANO_TEXTURE` | `true` | 同等条件下是否优先 Nano-texture 屏 |
| `PREFER_COLOR` | `spaceblack` | 同等条件下优先的颜色，如 `silver`；留空表示无偏好 |

排序规则：内存 > 芯片 > Nano-texture > 颜色。同一条通知里排第一的就是最符合你偏好的。

**不确定某个值该怎么写？** 运行 `node cloudflare-worker/check_live.mjs`，它会列出当前所有 14 寸 MacBook Pro 在 Apple 数据里的原始字段（尺寸、内存、容量、颜色的写法都在里面）。想看别的机型，改一下脚本里的过滤条件就行。

## 自建服务器版（Python）

如果你更想跑在自己的 Linux 服务器上，仓库根目录有一个逻辑相同的 Python 版，除了 Telegram 还支持 SMTP 邮件和 Twilio WhatsApp：

```bash
cp config.example.json config.json   # 填入你的条件和通知凭证
pip install -r requirements.txt
python stock_checker.py --test       # 给已启用的渠道发一条测试消息
python stock_checker.py --once       # 只检查一次
python stock_checker.py              # 常驻运行
```

`deploy/setup_vm.sh` 可以在 Ubuntu 上一键装成 systemd 服务。`config.json` 已在 `.gitignore` 里，不会被提交。

## 开发与测试

```bash
cd cloudflare-worker && npm test           # Worker 版
python -m unittest test_stock_checker      # Python 版
```

测试用的是一份真实抓取的 Apple 页面（`cloudflare-worker/test/fixtures/`）。

## 说明

- 免费计划完全够用：每天大约 2,900 次检查，远低于 Cloudflare Workers / Durable Objects 的免费额度。
- 每次检查都直接请求 Apple 服务器，请不要把检查间隔调得太短。
- 本项目与 Apple 无关，只读取公开的网页，不会自动下单。
