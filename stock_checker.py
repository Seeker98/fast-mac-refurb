"""
Apple 官翻 14 寸 MacBook Pro (24GB/32GB) 库存监控器

原理:
  Apple 翻新页面在首次加载时，会把当前"有货"的商品列表整体内嵌在
  <script>window.REFURB_GRID_BOOTSTRAP = {...}</script> 这段 JSON 里。
  只要某个配置从这个 tiles 数组里消失，就说明它卖完了；
  重新出现，就说明补货了。所以只需定期下载页面、解析这段 JSON、
  按你的选购条件筛选打分，一旦出现新的匹配项就立刻通知你。

用法:
  1. 复制 config.example.json 为 config.json，按需打开 telegram / email / whatsapp_twilio
     中的一种或多种通知方式并填好凭证(config.json 已被 .gitignore 排除，不会被提交)。
  2. python stock_checker.py            # 常驻后台，每 N 秒检查一次
  3. python stock_checker.py --once     # 只检查一次，方便调试
"""

import argparse
import json
import logging
import re
import smtplib
import sys
import time
from email.mime.text import MIMEText
from pathlib import Path

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"
STATE_FILE = BASE_DIR / "state.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    )
}

BOOTSTRAP_MARKER = "window.REFURB_GRID_BOOTSTRAP = "

# 已知商品连续这么多次没看到才算下架，避免 CDN 节点之间数据不一致导致重复推送
REMOVE_AFTER_MISSES = 3
# 连续失败超过这么久就推送一次告警，恢复后再推送一次
FAILURE_ALERT_AFTER_SECONDS = 10 * 60
# 连续失败时每次间隔翻倍，最长 5 分钟
MAX_BACKOFF_SECONDS = 5 * 60

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("refurb_tracker")


def load_config() -> dict:
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def empty_state() -> dict:
    return {"items": {}, "failure": {"since": None, "count": 0, "alerted": False}}


def load_state() -> dict:
    if not STATE_FILE.exists():
        return empty_state()
    with open(STATE_FILE, "r", encoding="utf-8") as f:
        raw = json.load(f)
    if "items" not in raw:
        # 旧格式: 直接是 {partNumber: {title, price}}
        state = empty_state()
        state["items"] = {pn: {**item, "misses": 0} for pn, item in raw.items()}
        return state
    return {**empty_state(), **raw}


def save_state(state: dict) -> None:
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def extract_bootstrap_json(html: str) -> dict | None:
    """从页面 HTML 中提取内嵌的 REFURB_GRID_BOOTSTRAP JSON，找不到或解析失败返回 None。"""
    start = html.find(BOOTSTRAP_MARKER)
    if start == -1:
        return None
    start += len(BOOTSTRAP_MARKER)

    # 花括号配对，从 start 处截取出完整的 JSON 对象
    depth = 0
    in_str = False
    str_char = ""
    escape = False
    end = None
    for i in range(start, len(html)):
        c = html[i]
        if in_str:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == str_char:
                in_str = False
        else:
            if c in ("'", '"'):
                in_str = True
                str_char = c
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break

    if end is None:
        return None
    try:
        return json.loads(html[start:end])
    except json.JSONDecodeError:
        return None


def fetch_bootstrap_json(url: str) -> dict:
    """下载页面并提取 bootstrap JSON，任何异常情况都抛出异常。"""
    # Apple 页面带 Cache-Control: s-maxage=120，同一个 URL 会被 CDN 缓存最长 2 分钟，
    # 加随机参数直接回源拿最新数据
    resp = requests.get(url, params={"_": int(time.time() * 1000)}, headers=HEADERS, timeout=20)
    resp.raise_for_status()

    data = extract_bootstrap_json(resp.text)
    if data is None:
        raise RuntimeError("页面中未找到 REFURB_GRID_BOOTSTRAP 数据，Apple 可能改版了页面结构")
    # 整页一个商品都没有几乎不可能是真的卖空了，更可能是拿到了异常页面；
    # 当作失败处理，免得把所有已知商品都判成下架
    if not data.get("tiles"):
        raise RuntimeError("页面商品列表为空，疑似异常页面")
    return data


def clean_price(amount_html: str | None) -> str:
    return re.sub(r"<[^>]+>", "", amount_html or "").strip()


def parse_price(current_price: dict | None) -> float | None:
    """优先用 Apple 给的 raw_amount(如 "1699.00")，没有时再从展示文本里抠数字。"""
    current_price = current_price or {}
    try:
        return float(current_price["raw_amount"])
    except (KeyError, TypeError, ValueError):
        pass
    m = re.search(r"[\d,]+\.\d+", clean_price(current_price.get("amount")))
    return float(m.group(0).replace(",", "")) if m else None


CHIP_RE = re.compile(r"Apple\s+(M\d+(?:\s+Pro|\s+Max)?)\s+[Cc]hip")


def extract_chip(title: str) -> str | None:
    m = CHIP_RE.search(title)
    return m.group(1) if m else None


def build_candidates(data: dict, target: dict) -> list[dict]:
    """按硬性条件(尺寸/型号/内存/芯片/容量)筛选，返回附带评分的候选列表。"""
    memory_priority = target["memory_options_by_priority"]
    chip_priority = target["chip_options_by_priority"]
    candidates = []

    for tile in data.get("tiles", []):
        title = tile.get("title", "")
        dims = tile.get("filters", {}).get("dimensions", {})

        if dims.get("dimensionScreensize") != target["screen_size"]:
            continue
        if dims.get("refurbClearModel") != target["model"]:
            continue
        memory = dims.get("tsMemorySize")
        if memory not in memory_priority:
            continue
        if dims.get("dimensionCapacity") != target["required_capacity"]:
            continue
        chip = extract_chip(title)
        if chip not in chip_priority:
            continue

        # 某些芯片只接受特定内存搭配，例如 M5 Pro 只考虑 24GB
        allowed_memory = target.get("chip_memory_overrides", {}).get(chip, memory_priority)
        if memory not in allowed_memory:
            continue

        current_price = tile.get("price", {}).get("currentPrice", {})
        price_value = parse_price(current_price)
        max_price = target.get("max_price_usd")
        if max_price is not None and (price_value is None or price_value > max_price):
            continue

        is_nano = "nano-texture" in title.lower()
        color = dims.get("dimensionColor", "")

        # 分数越高优先级越高: 内存 > 芯片 > nano-texture > 颜色
        score = 0
        score += (len(memory_priority) - memory_priority.index(memory)) * 1000
        score += (len(chip_priority) - chip_priority.index(chip)) * 100
        if is_nano and target.get("prefer_nano_texture"):
            score += 10
        if target.get("prefer_color") and color == target["prefer_color"]:
            score += 1

        candidates.append(
            {
                "part_number": tile.get("partNumber"),
                "title": title,
                "price": clean_price(current_price.get("amount")),
                "url": "https://www.apple.com" + tile.get("productDetailsUrl", ""),
                "memory": memory,
                "chip": chip,
                "capacity": dims.get("dimensionCapacity"),
                "color": color,
                "nano_texture": is_nano,
                "score": score,
            }
        )

    candidates.sort(key=lambda c: c["score"], reverse=True)
    return candidates


def reconcile(prev_items: dict, candidates: list[dict], remove_after_misses: int) -> tuple[dict, list, list]:
    """
    拿本轮候选和上一轮已知商品做对比，返回 (items, new_items, removed_items)。

    - 新出现的商品只放进 new_items，不放进 items：调用方通知成功后再自己加进去，
      这样通知失败时下一轮还会把它当成"新的"重试。
    - 已知商品本轮没看到只累加 misses，连续 remove_after_misses 次都没看到才算下架。
    """
    items = {}
    new_items = []
    removed_items = []
    seen = set()

    for c in candidates:
        seen.add(c["part_number"])
        if c["part_number"] in prev_items:
            items[c["part_number"]] = {"title": c["title"], "price": c["price"], "misses": 0}
        else:
            new_items.append(c)

    for pn, prev in prev_items.items():
        if pn in seen:
            continue
        misses = prev.get("misses", 0) + 1
        if misses >= remove_after_misses:
            removed_items.append({"part_number": pn, "title": prev.get("title"), "price": prev.get("price")})
        else:
            items[pn] = {**prev, "misses": misses}

    return items, new_items, removed_items


def format_item(rank: int, item: dict) -> str:
    nano = "是" if item["nano_texture"] else "否"
    return (
        f"{rank}. {item['title']}\n"
        f"   价格: {item['price']} | 内存: {item['memory']} | 芯片: {item['chip']} | "
        f"容量: {item['capacity']} | 颜色: {item['color']} | Nano-texture: {nano}\n"
        f"   链接: {item['url']}"
    )


def send_telegram(cfg: dict, text: str) -> None:
    token = cfg["bot_token"]
    chat_id = cfg["chat_id"]
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    resp = requests.post(url, data={"chat_id": chat_id, "text": text}, timeout=15)
    resp.raise_for_status()


def send_email(cfg: dict, subject: str, text: str) -> None:
    msg = MIMEText(text, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = cfg["username"]
    msg["To"] = cfg["to_addr"]
    with smtplib.SMTP(cfg["smtp_host"], cfg["smtp_port"], timeout=20) as server:
        server.starttls()
        server.login(cfg["username"], cfg["password"])
        server.sendmail(cfg["username"], [cfg["to_addr"]], msg.as_string())


def send_whatsapp_twilio(cfg: dict, text: str) -> None:
    url = f"https://api.twilio.com/2010-04-01/Accounts/{cfg['account_sid']}/Messages.json"
    resp = requests.post(
        url,
        auth=(cfg["account_sid"], cfg["auth_token"]),
        data={
            "From": cfg["from_whatsapp"],
            "To": cfg["to_whatsapp"],
            "Body": text,
        },
        timeout=15,
    )
    resp.raise_for_status()


def notify_all(cfg: dict, subject: str, text: str) -> bool:
    """给所有已启用的渠道发通知，返回是否至少有一个成功；一个都没启用时视为成功。"""
    notif_cfg = cfg["notifications"]
    channels = []
    if notif_cfg.get("telegram", {}).get("enabled"):
        channels.append(("Telegram", lambda: send_telegram(notif_cfg["telegram"], text)))
    if notif_cfg.get("email", {}).get("enabled"):
        channels.append(("邮件", lambda: send_email(notif_cfg["email"], subject, text)))
    if notif_cfg.get("whatsapp_twilio", {}).get("enabled"):
        channels.append(("WhatsApp", lambda: send_whatsapp_twilio(notif_cfg["whatsapp_twilio"], text)))

    if not channels:
        log.warning("没有启用任何通知渠道，跳过通知")
        return True

    any_ok = False
    for name, send in channels:
        try:
            send()
            log.info("%s 通知已发送", name)
            any_ok = True
        except Exception as e:
            log.error("%s 通知发送失败: %s", name, e)
    return any_ok


def check_stock(cfg: dict, state: dict) -> None:
    data = fetch_bootstrap_json(cfg["page_url"])
    candidates = build_candidates(data, cfg["target"])
    items, new_items, removed_items = reconcile(state["items"], candidates, REMOVE_AFTER_MISSES)

    if not candidates:
        log.info("当前没有符合条件的在售配置(继续监控中)")
    else:
        log.info("当前符合条件的在售配置共 %d 个，最佳: %s (%s)",
                 len(candidates), candidates[0]["title"], candidates[0]["price"])

    if new_items:
        body_lines = [f"发现 {len(new_items)} 个新上架/补货的符合条件的翻新 MacBook Pro:\n"]
        for i, item in enumerate(new_items, 1):
            body_lines.append(format_item(i, item))
        text = "\n\n".join(body_lines)
        log.info("检测到新库存，发送通知:\n%s", text)
        if notify_all(cfg, "🍎 Apple 翻新 MacBook Pro 补货提醒", text):
            for c in new_items:
                items[c["part_number"]] = {"title": c["title"], "price": c["price"], "misses": 0}
        else:
            # 不记入 items，下一轮还会被当成新商品重新通知
            log.error("所有通知渠道都发送失败，下一轮重试")

    for item in removed_items:
        log.info("已下架/卖完: %s (%s)", item["title"], item["price"])

    state["items"] = items


def track_failure(cfg: dict, state: dict, error: str | None) -> None:
    failure = state["failure"]
    if error is None:
        if failure["alerted"]:
            notify_all(cfg, "✅ Apple 翻新监控已恢复",
                       f"监控已恢复正常。此前自 {format_ts(failure['since'])} 起连续失败 {failure['count']} 次。")
        state["failure"] = empty_state()["failure"]
        return

    failure["since"] = failure["since"] or time.time()
    failure["count"] += 1
    if not failure["alerted"] and time.time() - failure["since"] >= FAILURE_ALERT_AFTER_SECONDS:
        failure["alerted"] = notify_all(
            cfg,
            "⚠️ Apple 翻新监控异常",
            f"自 {format_ts(failure['since'])} 起已连续失败 {failure['count']} 次，期间不会检测到补货。\n"
            f"最近一次错误: {error}",
        )


def format_ts(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))


def run_once(cfg: dict) -> int:
    """跑一轮检查并保存状态，返回距离下一轮的秒数(连续失败时指数退避)。"""
    state = load_state()
    error = None
    try:
        check_stock(cfg, state)
    except Exception as e:
        error = str(e)
        log.warning("本轮检查失败: %s", error)

    track_failure(cfg, state, error)
    save_state(state)

    interval = cfg.get("check_interval_seconds", 60)
    count = state["failure"]["count"]
    return interval if count == 0 else min(interval * 2 ** count, max(MAX_BACKOFF_SECONDS, interval))


def run_test_notification(cfg: dict) -> None:
    text = "这是一条测试消息：如果你收到了它，说明库存监控器的通知渠道配置正确。"
    notify_all(cfg, "🍎 Apple 翻新监控器 - 测试通知", text)


def main() -> None:
    parser = argparse.ArgumentParser(description="Apple 翻新 MacBook Pro 库存监控器")
    parser.add_argument("--once", action="store_true", help="只检查一次后退出，用于调试")
    parser.add_argument("--test", action="store_true", help="给所有已启用的通知渠道发一条测试消息后退出")
    args = parser.parse_args()

    cfg = load_config()

    if args.test:
        run_test_notification(cfg)
        return

    if args.once:
        run_once(cfg)
        return

    log.info("库存监控已启动，每 %d 秒检查一次，按 Ctrl+C 停止", cfg.get("check_interval_seconds", 60))
    while True:
        try:
            delay = run_once(cfg)
        except Exception as e:
            log.error("本轮检查出现异常: %s", e)
            delay = cfg.get("check_interval_seconds", 60)
        try:
            time.sleep(delay)
        except KeyboardInterrupt:
            log.info("收到停止信号，退出")
            sys.exit(0)


if __name__ == "__main__":
    main()
