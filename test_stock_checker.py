"""stock_checker 的测试: python -m unittest test_stock_checker"""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import stock_checker as sc

# 2026-09-29 抓取的真实页面，只保留了 14 寸 MacBook Pro 的 tile(当天没有符合条件的配置)
FIXTURE_HTML = (
    Path(__file__).parent / "cloudflare-worker" / "test" / "fixtures" / "refurb-14inch-2026-09-29.html"
).read_text(encoding="utf-8")
REAL_TILES = sc.extract_bootstrap_json(FIXTURE_HTML)["tiles"]

TARGET = {
    "screen_size": "14inch",
    "model": "macbookpro",
    "memory_options_by_priority": ["32gb", "24gb"],
    "chip_options_by_priority": ["M5", "M5 Pro"],
    "chip_memory_overrides": {"M5 Pro": ["24gb"]},
    "required_capacity": "1tb",
    "max_price_usd": 2249,
    "prefer_nano_texture": True,
    "prefer_color": "spaceblack",
}

CFG = {
    "check_interval_seconds": 30,
    "page_url": "https://www.apple.com/shop/refurbished/mac/14-inch-macbook-pro-24gb-32gb",
    "target": TARGET,
    "notifications": {"telegram": {"enabled": True, "bot_token": "fake", "chat_id": "1"}},
}


def make_tile(part_number, chip="M5", memory="32gb", capacity="1tb", price=2099, color="spaceblack", nano=False):
    """以真实 tile 为模板造一个指定配置的 tile。"""
    tile = copy.deepcopy(REAL_TILES[0])
    tile["partNumber"] = part_number
    tile["title"] = (
        f"Refurbished 14-inch MacBook Pro Apple {chip} chip with 10‑Core CPU and 10‑Core GPU"
        f"{', Nano-texture display' if nano else ''} - Space Black"
    )
    tile["filters"]["dimensions"].update(tsMemorySize=memory, dimensionCapacity=capacity, dimensionColor=color)
    tile["price"]["currentPrice"] = {"amount": f"<span>Now </span>${price:,}.00", "raw_amount": f"{price}.00"}
    return tile


def page(tiles):
    return f"<script>window.REFURB_GRID_BOOTSTRAP = {json.dumps({'tiles': tiles})};</script>"


class ParsingTest(unittest.TestCase):
    def test_extracts_real_page(self):
        self.assertEqual(len(REAL_TILES), 11)

    def test_missing_or_truncated_returns_none(self):
        self.assertIsNone(sc.extract_bootstrap_json("<html></html>"))
        self.assertIsNone(sc.extract_bootstrap_json('window.REFURB_GRID_BOOTSTRAP = {"tiles": [{"a": "}"'))

    def test_real_page_has_no_match(self):
        self.assertEqual(sc.build_candidates({"tiles": REAL_TILES}, TARGET), [])

    def test_filters_and_ranks(self):
        tiles = [
            make_tile("PRO24", chip="M5 Pro", memory="24gb", price=2119),
            make_tile("PRO32", chip="M5 Pro", memory="32gb"),
            make_tile("M5-24", memory="24gb", price=1869),
            make_tile("M5-32-SILVER", color="silver"),
            make_tile("M5-32-NANO", nano=True, color="silver"),
            make_tile("M5-32-BLACK"),
            make_tile("TOO-EXPENSIVE", price=2250),
            make_tile("M5-16", memory="16gb"),
            make_tile("M5-2TB", capacity="2tb"),
            make_tile("MAX", chip="M5 Max"),
        ]
        ids = [c["part_number"] for c in sc.build_candidates({"tiles": tiles}, TARGET)]
        self.assertEqual(ids, ["M5-32-NANO", "M5-32-BLACK", "M5-32-SILVER", "M5-24", "PRO24"])

    def test_parse_price(self):
        self.assertEqual(sc.parse_price({"amount": "<span>Now </span>$2,119.00", "raw_amount": "2119.00"}), 2119)
        self.assertEqual(sc.parse_price({"amount": "<span>Now </span>$2,119.00"}), 2119)
        self.assertIsNone(sc.parse_price(None))


class RunOnceTest(unittest.TestCase):
    """模拟 Apple 页面和 Telegram，完整跑 run_once。"""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patcher = mock.patch.object(sc, "STATE_FILE", Path(tmp.name) / "state.json")
        patcher.start()
        self.addCleanup(patcher.stop)

        self.tiles = list(REAL_TILES)
        self.apple_status = 200
        self.tg_status = 200
        self.sent = []
        self.now = 1_000_000.0

        def fake_get(url, params=None, **kwargs):
            self.assertIn("_", params)  # 每次都带随机参数绕过 CDN 缓存
            return self._response(self.apple_status, page(self.tiles))

        def fake_post(url, data=None, **kwargs):
            self.sent.append(data["text"])
            return self._response(self.tg_status, "{}")

        for target, fake in (("get", fake_get), ("post", fake_post)):
            p = mock.patch.object(sc.requests, target, side_effect=fake)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(sc.time, "time", side_effect=lambda: self.now)
        p.start()
        self.addCleanup(p.stop)

    @staticmethod
    def _response(status, text):
        resp = mock.Mock(status_code=status, text=text)
        if status >= 400:
            resp.raise_for_status.side_effect = sc.requests.HTTPError(f"{status} Error")
        return resp

    def test_notification_failure_is_retried(self):
        self.tiles = REAL_TILES + [make_tile("NEW")]
        self.tg_status = 500
        sc.run_once(CFG)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(sc.load_state()["items"], {})

        self.tg_status = 200
        sc.run_once(CFG)
        self.assertEqual(len(self.sent), 2)
        self.assertIn("NEW", sc.load_state()["items"])

        sc.run_once(CFG)
        self.assertEqual(len(self.sent), 2)

    def test_removal_is_debounced(self):
        self.tiles = REAL_TILES + [make_tile("NEW")]
        sc.run_once(CFG)
        self.tiles = list(REAL_TILES)
        sc.run_once(CFG)
        sc.run_once(CFG)
        self.assertEqual(sc.load_state()["items"]["NEW"]["misses"], 2)

        self.tiles = REAL_TILES + [make_tile("NEW")]
        sc.run_once(CFG)
        self.assertEqual(len(self.sent), 1)  # 重新出现不算补货

        self.tiles = list(REAL_TILES)
        for _ in range(3):
            sc.run_once(CFG)
        self.assertEqual(sc.load_state()["items"], {})

    def test_failure_backoff_alert_and_recovery(self):
        self.apple_status = 403
        self.assertEqual(sc.run_once(CFG), 60)
        self.assertEqual(sc.run_once(CFG), 120)
        self.assertEqual(self.sent, [])

        self.now += 11 * 60
        self.assertEqual(sc.run_once(CFG), 240)
        self.assertEqual(len(self.sent), 1)
        self.assertIn("连续失败 3 次", self.sent[-1])
        self.assertEqual(sc.run_once(CFG), 300)  # 封顶 5 分钟
        self.assertEqual(len(self.sent), 1)  # 只告警一次

        self.apple_status = 200
        self.assertEqual(sc.run_once(CFG), 30)
        self.assertIn("已恢复", self.sent[-1])
        self.assertEqual(sc.load_state()["failure"]["count"], 0)

    def test_empty_page_is_failure_not_sellout(self):
        self.tiles = REAL_TILES + [make_tile("NEW")]
        sc.run_once(CFG)
        self.tiles = []
        sc.run_once(CFG)
        state = sc.load_state()
        self.assertEqual(state["failure"]["count"], 1)
        self.assertEqual(state["items"]["NEW"]["misses"], 0)

    def test_legacy_state_is_migrated(self):
        sc.STATE_FILE.write_text(json.dumps({"OLD": {"title": "t", "price": "$1"}}), encoding="utf-8")
        state = sc.load_state()
        self.assertEqual(state["items"], {"OLD": {"title": "t", "price": "$1", "misses": 0}})
        self.assertEqual(state["failure"]["count"], 0)


if __name__ == "__main__":
    unittest.main()
