/**
 * Apple 官翻 Mac 库存监控 - Cloudflare Worker 版
 *
 * 与仓库根目录的 stock_checker.py 逻辑对应，只是运行在 Cloudflare 上，
 * 不需要自己维护服务器。解析/筛选/对比等纯逻辑在 core.js 里。
 * 选购条件在 wrangler.jsonc 的 vars 里配置(默认值见 core.js 的 DEFAULT_TARGET_VARS)。
 *
 * 检查频率: 真正的检查由 Poller 这个 Durable Object 用 Alarms 驱动，
 * 大约每 POLL_INTERVAL_MS 跑一次；连续失败时按指数退避放慢，避免被 Apple 风控。
 * 1 分钟一次的 Cron Trigger 只是"看门狗"：确认 Poller 的 alarm 还活着，
 * 万一意外断掉就重新武装。所有状态(当前在售、历史、失败计数)都存在
 * Poller 自己的存储里，强一致，也不占 KV 的写入额度。
 *
 * 部署和配置方法见仓库根目录的 README.md。
 */

import { DurableObject } from "cloudflare:workers";
import { buildCandidates, describeTarget, extractBootstrapJson, formatItem, reconcile, targetFromEnv } from "./core.js";

// 这个页面的内嵌数据里其实包含了全部在售的翻新 Mac，筛选全靠 core.js 自己做
const DEFAULT_PAGE_URL = "https://www.apple.com/shop/refurbished/mac/14-inch-macbook-pro-24gb-32gb";

// Apple 页面带 Cache-Control: s-maxage=120，同一个 URL 会被 Apple 的 CDN 缓存最长 2 分钟，
// 所以每次请求都加随机参数直接回源。回源比命中缓存更容易触发风控，间隔不宜太小。
const POLL_INTERVAL_MS = 30_000;
// 连续失败时每次间隔翻倍，最长 5 分钟
const MAX_BACKOFF_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
// 已知商品连续这么多次没看到才算下架(30 秒一次 ≈ 90 秒)
const REMOVE_AFTER_MISSES = 3;
// 连续失败超过这么久就推送一次告警，恢复后再推送一次
const FAILURE_ALERT_AFTER_MS = 10 * 60_000;
const MAX_HISTORY_ENTRIES = 50;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchBootstrapJson(url) {
  const bustedUrl = `${url}?_=${Date.now()}`;
  const resp = await fetch(bustedUrl, {
    headers: { "User-Agent": USER_AGENT },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`下载页面失败: HTTP ${resp.status}`);
  const html = await resp.text();
  const data = extractBootstrapJson(html);
  if (!data) throw new Error("页面中未找到 REFURB_GRID_BOOTSTRAP 数据，Apple 可能改版了页面结构");
  // 整页一个商品都没有几乎不可能是真的卖空了，更可能是拿到了异常页面；
  // 当作失败处理，免得把所有已知商品都判成下架
  if (!Array.isArray(data.tiles) || data.tiles.length === 0) throw new Error("页面商品列表为空，疑似异常页面");
  return data;
}

function telegramChannel(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return null;
  return async (_subject, text) => {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
    if (!resp.ok) throw new Error(`Telegram 通知失败 HTTP ${resp.status}: ${await resp.text()}`);
  };
}

function emailChannel(env) {
  if (!env.RESEND_API_KEY || !env.EMAIL_TO) return null;
  return async (subject, text) => {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || "Refurb Tracker <onboarding@resend.dev>",
        to: [env.EMAIL_TO],
        subject,
        text,
      }),
    });
    if (!resp.ok) throw new Error(`邮件通知失败 HTTP ${resp.status}: ${await resp.text()}`);
  };
}

// 返回是否至少有一个渠道发送成功；一个渠道都没配置时视为成功(没有可重试的对象)
async function notifyAll(env, subject, text) {
  const channels = [telegramChannel(env), emailChannel(env)].filter(Boolean);
  if (channels.length === 0) {
    console.warn("没有配置任何通知渠道，跳过通知");
    return true;
  }
  const results = await Promise.allSettled(channels.map((send) => send(subject, text)));
  results.forEach((r) => {
    if (r.status === "rejected") console.error("通知渠道发送失败:", r.reason);
  });
  return results.some((r) => r.status === "fulfilled");
}

function emptyState() {
  return {
    items: {},
    candidates: [],
    changedAt: null,
    history: [],
    lastRun: null,
    failure: { since: null, count: 0, alerted: false },
  };
}

// Durable Object：用 alarm() 实现比 1 分钟更细的检查频率，并保存全部状态。
export class Poller extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    // 同一个实例里 alarm 和 cron 看门狗可能同时触发，用它保证同一时刻只跑一轮检查
    this.running = false;
  }

  // 跑一轮检查并保存状态，返回距离下一轮的毫秒数；已有一轮在跑时返回 null
  async runCheck() {
    if (this.running) return null;
    this.running = true;
    try {
      const state = { ...emptyState(), ...((await this.ctx.storage.get("state")) || {}) };
      const at = new Date().toISOString();
      let error = null;

      try {
        await this.checkStock(state, at);
      } catch (err) {
        error = String((err && err.message) || err);
        console.error("检查失败:", err);
      }

      state.lastRun = { at, ok: error == null, error };
      await this.trackFailure(state, error, at);
      await this.ctx.storage.put("state", state);

      const { count } = state.failure;
      return count === 0 ? POLL_INTERVAL_MS : Math.min(POLL_INTERVAL_MS * 2 ** count, MAX_BACKOFF_MS);
    } finally {
      this.running = false;
    }
  }

  async checkStock(state, at) {
    const target = targetFromEnv(this.env);
    const data = await fetchBootstrapJson(this.env.PAGE_URL || DEFAULT_PAGE_URL);
    const candidates = buildCandidates(data, target);
    const { items, newItems, removedItems } = reconcile(state.items, candidates, REMOVE_AFTER_MISSES);

    if (newItems.length > 0) {
      const text = [
        `发现 ${newItems.length} 个新上架/补货的符合条件的翻新 Mac:`,
        ...newItems.map((item, i) => formatItem(i + 1, item)),
      ].join("\n\n");
      const notified = await notifyAll(this.env, "🍎 Apple 翻新 Mac 补货提醒", text);
      if (notified) {
        for (const c of newItems) items[c.partNumber] = { title: c.title, price: c.price, misses: 0 };
        state.history.push({ at, type: "new", items: newItems.map((c) => ({ title: c.title, price: c.price })) });
        state.changedAt = at;
      } else {
        // 不记入 items，下一轮还会被当成新商品重新通知
        console.error("所有通知渠道都发送失败，下一轮重试");
      }
    }

    if (removedItems.length > 0) {
      state.history.push({ at, type: "removed", items: removedItems.map((c) => ({ title: c.title, price: c.price })) });
      state.changedAt = at;
    }

    state.history = state.history.slice(-MAX_HISTORY_ENTRIES);
    state.items = items;
    state.candidates = candidates;
  }

  async trackFailure(state, error, at) {
    const failure = state.failure;
    if (error == null) {
      if (failure.alerted) {
        await notifyAll(
          this.env,
          "✅ Apple 翻新监控已恢复",
          `监控已恢复正常。此前自 ${failure.since} 起连续失败 ${failure.count} 次。`
        );
      }
      state.failure = { since: null, count: 0, alerted: false };
      return;
    }

    failure.since = failure.since || at;
    failure.count += 1;
    if (!failure.alerted && Date.now() - Date.parse(failure.since) >= FAILURE_ALERT_AFTER_MS) {
      failure.alerted = await notifyAll(
        this.env,
        "⚠️ Apple 翻新监控异常",
        `自 ${failure.since} 起已连续失败 ${failure.count} 次，期间不会检测到补货。\n最近一次错误: ${error}`
      );
    }
  }

  // Cron 看门狗调用 /ensure-alarm：如果 alarm 还活着就什么都不做；
  // 如果 alarm 丢了（比如第一次部署、或者 Durable Object 被驱逐后状态重建），
  // 立刻补跑一次检查并重新武装 alarm。/status 给状态页读取全部状态。
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      const state = (await this.ctx.storage.get("state")) || emptyState();
      const nextAlarmAt = await this.ctx.storage.getAlarm();
      return Response.json({ state, nextAlarmAt });
    }

    const existing = await this.ctx.storage.getAlarm();
    if (existing == null && !this.running) {
      const delay = await this.runCheck();
      await this.ctx.storage.setAlarm(Date.now() + (delay ?? POLL_INTERVAL_MS));
    }
    return new Response("ok");
  }

  async alarm() {
    const delay = await this.runCheck();
    // 不管上面成功还是失败，都要重新武装，否则整条链会断掉。
    await this.ctx.storage.setAlarm(Date.now() + (delay ?? POLL_INTERVAL_MS));
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// 服务端只输出 UTC 时间，浏览器端的小脚本再把它换成本地时间
function timeTag(iso, fallback = "尚未运行") {
  if (!iso) return escapeHtml(fallback);
  const value = escapeHtml(new Date(iso).toISOString());
  return `<time datetime="${value}">${value}</time>`;
}

function renderDashboard(pollerStatus, env) {
  let targetLine;
  try {
    targetLine = escapeHtml(describeTarget(targetFromEnv(env)));
  } catch (err) {
    targetLine = `❌ 配置有误: ${escapeHtml(err.message)}`;
  }
  const state = pollerStatus?.state || emptyState();
  const candidates = state.candidates || [];
  const history = (state.history || []).slice().reverse(); // 最新的在最上面
  const { lastRun, failure } = state;

  const lastRunLine = lastRun
    ? `${timeTag(lastRun.at)} — ${lastRun.ok ? "✅ 正常" : `❌ 出错: ${escapeHtml(lastRun.error)}`}`
    : pollerStatus
      ? "尚未运行（等下一次 cron 看门狗触发，最多 1 分钟）"
      : "❌ 读取 Poller 状态失败";
  const failureLine =
    failure && failure.count > 0
      ? `<br>⚠️ 自 ${timeTag(failure.since)} 起连续失败 ${failure.count} 次，已自动放慢检查频率${failure.alerted ? "（已推送告警）" : ""}`
      : "";

  const rows = candidates.length
    ? candidates
        .map(
          (c, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a></td>
            <td>${escapeHtml(c.price)}</td>
            <td>${escapeHtml(c.memory)}</td>
            <td>${escapeHtml(c.chip)}</td>
            <td>${c.nanoTexture ? "是" : "否"}</td>
            <td>${escapeHtml(c.color)}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="7">当前没有符合条件的在售配置</td></tr>`;

  const historyItems = history.length
    ? history
        .map((h) => {
          const label = h.type === "new" ? "✅ 新上架/补货" : "⚪ 下架/卖完";
          const detail = (h.items || [])
            .map((it) => `${escapeHtml(it.title || "未知型号")} (${escapeHtml(it.price || "-")})`)
            .join("; ");
          return `<li><strong>${timeTag(h.at)}</strong> — ${label}: ${detail}</li>`;
        })
        .join("")
    : "<li>暂无历史变化记录</li>";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apple 翻新 Mac 库存监控</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 2rem; background:#f5f5f7; color:#1d1d1f; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #d2d2d7; padding: 8px 12px; text-align: left; font-size: 14px; }
  th { background: #f0f0f3; }
  h1 { font-size: 1.4rem; }
  .meta { color: #6e6e73; margin-bottom: 1rem; }
  ul.history { background:#fff; border:1px solid #d2d2d7; padding: 12px 24px; font-size: 13px; max-height: 300px; overflow-y: auto; }
</style>
</head>
<body>
  <h1>🍎 Apple 翻新 Mac 库存监控</h1>
  <p class="meta">监控条件: ${targetLine}<br>约每 ${Math.round(POLL_INTERVAL_MS / 1000)} 秒检查一次(Durable Object alarm 驱动，1 分钟 cron 仅作看门狗) | 最近一次候选实际变化时间: ${timeTag(state.changedAt, "暂无")}<br>最近一次检查: ${lastRunLine}${failureLine}<br>下一次检查预计时间: ${timeTag(pollerStatus?.nextAlarmAt, "未知")}</p>
  <table>
    <thead>
      <tr><th>#</th><th>型号</th><th>价格</th><th>内存</th><th>芯片</th><th>Nano-texture</th><th>颜色</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <h2>历史变化记录（最近 ${MAX_HISTORY_ENTRIES} 条）</h2>
  <ul class="history">${historyItems}</ul>
<script>
  for (const t of document.querySelectorAll("time[datetime]")) {
    t.textContent = new Date(t.dateTime).toLocaleString();
  }
</script>
</body>
</html>`;
}

export default {
  async scheduled(controller, env, ctx) {
    const stub = env.POLLER.get(env.POLLER.idFromName("singleton"));
    ctx.waitUntil(stub.fetch("https://poller/ensure-alarm").catch((err) => console.error("唤醒 Poller 失败:", err)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/test-notify") {
      const key = url.searchParams.get("key");
      if (!env.TEST_NOTIFY_SECRET || key !== env.TEST_NOTIFY_SECRET) {
        return new Response("Not Found", { status: 404 });
      }
      const ok = await notifyAll(
        env,
        "🍎 Apple 翻新监控器 - 测试通知",
        "这是一条测试消息：如果你收到了它，说明 Cloudflare Worker 的通知渠道配置正确。"
      );
      return ok
        ? new Response("测试消息已发送，去检查你的 Telegram/邮箱。")
        : new Response("所有通知渠道都发送失败，看 wrangler tail 日志里的错误信息。", { status: 502 });
    }

    let pollerStatus = null;
    try {
      const stub = env.POLLER.get(env.POLLER.idFromName("singleton"));
      pollerStatus = await (await stub.fetch("https://poller/status")).json();
    } catch (err) {
      console.error("读取 Poller 状态失败:", err);
    }

    return new Response(renderDashboard(pollerStatus, env), { headers: { "Content-Type": "text/html; charset=UTF-8" } });
  },
};
