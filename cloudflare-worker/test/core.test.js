import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildCandidates, describeTarget, extractBootstrapJson, parsePrice, reconcile, targetFromEnv } from "../src/core.js";

// 2026-09-29 抓取的真实页面，只保留了 14 寸 MacBook Pro 的 tile(当天没有符合条件的配置)
const FIXTURE_HTML = readFileSync(new URL("./fixtures/refurb-14inch-2026-09-29.html", import.meta.url), "utf8");

const TARGET = {
  screenSize: "14inch",
  model: "macbookpro",
  memoryOptionsByPriority: ["32gb", "24gb"],
  chipOptionsByPriority: ["M5", "M5 Pro"],
  chipMemoryOverrides: { "M5 Pro": ["24gb"] },
  requiredCapacity: "1tb",
  maxPriceUsd: 2249,
  preferNanoTexture: true,
  preferColor: "spaceblack",
};

const realTiles = extractBootstrapJson(FIXTURE_HTML).tiles;

// 以真实 tile 为模板造一个指定配置的 tile
function makeTile({ partNumber, chip = "M5", memory = "32gb", capacity = "1tb", price = 2099, color = "spaceblack", nano = false }) {
  const tile = structuredClone(realTiles[0]);
  tile.partNumber = partNumber;
  tile.title = `Refurbished 14-inch MacBook Pro Apple ${chip} chip with 10‑Core CPU and 10‑Core GPU${nano ? ", Nano-texture display" : ""} - Space Black`;
  Object.assign(tile.filters.dimensions, { tsMemorySize: memory, dimensionCapacity: capacity, dimensionColor: color });
  const text = `$${price.toLocaleString("en-US")}.00`;
  tile.price.currentPrice = { amount: `<span class="visuallyhidden">Now </span>${text}`, raw_amount: price.toFixed(2) };
  return tile;
}

test("extractBootstrapJson 能从真实页面解析出 tile，并跳过其它 script", () => {
  assert.equal(realTiles.length, 11);
  assert.ok(realTiles.every((t) => t.filters.dimensions.dimensionScreensize === "14inch"));
});

test("extractBootstrapJson 找不到标记或 JSON 被截断时返回 null", () => {
  assert.equal(extractBootstrapJson("<html></html>"), null);
  assert.equal(extractBootstrapJson('window.REFURB_GRID_BOOTSTRAP = {"tiles": [{"a": "}"'), null);
});

test("真实页面当天没有符合条件的配置", () => {
  assert.deepEqual(buildCandidates({ tiles: realTiles }, TARGET), []);
});

test("buildCandidates 按硬性条件筛选，并按 内存 > 芯片 > nano > 颜色 排序", () => {
  const tiles = [
    makeTile({ partNumber: "PRO24", chip: "M5 Pro", memory: "24gb", price: 2119 }),
    makeTile({ partNumber: "PRO32", chip: "M5 Pro", memory: "32gb" }), // M5 Pro 只要 24GB
    makeTile({ partNumber: "M5-24", memory: "24gb", price: 1869 }),
    makeTile({ partNumber: "M5-32-SILVER", color: "silver" }),
    makeTile({ partNumber: "M5-32-NANO", nano: true, color: "silver" }),
    makeTile({ partNumber: "M5-32-BLACK" }),
    makeTile({ partNumber: "TOO-EXPENSIVE", price: 2250 }),
    makeTile({ partNumber: "M5-16", memory: "16gb" }),
    makeTile({ partNumber: "M5-2TB", capacity: "2tb" }),
    makeTile({ partNumber: "MAX", chip: "M5 Max" }),
  ];
  const ids = buildCandidates({ tiles }, TARGET).map((c) => c.partNumber);
  assert.deepEqual(ids, ["M5-32-NANO", "M5-32-BLACK", "M5-32-SILVER", "M5-24", "PRO24"]);
});

test("parsePrice 优先用 raw_amount，没有时退回解析展示文本", () => {
  assert.equal(parsePrice({ amount: "<span>Now </span>$2,119.00", raw_amount: "2119.00" }), 2119);
  assert.equal(parsePrice({ amount: "<span>Now </span>$2,119.00" }), 2119);
  assert.equal(parsePrice(undefined), null);
});

test("reconcile: 新商品只出现在 newItems 里，由调用方通知成功后再记入", () => {
  const c = { partNumber: "A", title: "A", price: "$1" };
  const { items, newItems, removedItems } = reconcile({}, [c], 3);
  assert.deepEqual(items, {});
  assert.deepEqual(newItems, [c]);
  assert.deepEqual(removedItems, []);
});

test("reconcile: 连续缺席达到阈值才算下架，中途重新出现不算补货", () => {
  const c = { partNumber: "A", title: "A", price: "$1" };
  let items = { A: { title: "A", price: "$1", misses: 0 } };

  let r = reconcile(items, [], 3);
  assert.equal(r.items.A.misses, 1);
  r = reconcile(r.items, [], 3);
  assert.equal(r.items.A.misses, 2);

  const back = reconcile(r.items, [c], 3);
  assert.deepEqual(back.newItems, []);
  assert.equal(back.items.A.misses, 0);

  r = reconcile(r.items, [], 3);
  assert.deepEqual(r.items, {});
  assert.deepEqual(r.removedItems, [{ partNumber: "A", title: "A", price: "$1" }]);
});

test("targetFromEnv: 不设置任何变量时等于默认条件", () => {
  assert.deepEqual(targetFromEnv({}), TARGET);
});

test("targetFromEnv: wrangler.jsonc 里的 vars 和代码默认值一致", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.deepEqual(targetFromEnv(JSON.parse(config).vars), TARGET);
});

test("targetFromEnv: 解析自定义条件，空字符串表示不限制", () => {
  const target = targetFromEnv({
    MODEL: "MacBookAir",
    SCREEN_SIZE: "15inch",
    MEMORY_OPTIONS: " 24GB , 16gb ",
    CHIP_OPTIONS: "M5, M4",
    CHIP_MEMORY_OVERRIDES: "M5 Pro=24gb; M5 Max=36gb|48gb",
    CAPACITY: "512GB",
    MAX_PRICE_USD: "",
    PREFER_NANO_TEXTURE: "false",
    PREFER_COLOR: "",
  });
  assert.deepEqual(target, {
    screenSize: "15inch",
    model: "macbookair",
    memoryOptionsByPriority: ["24gb", "16gb"],
    chipOptionsByPriority: ["M5", "M4"],
    chipMemoryOverrides: { "M5 Pro": ["24gb"], "M5 Max": ["36gb", "48gb"] },
    requiredCapacity: "512gb",
    maxPriceUsd: null,
    preferNanoTexture: false,
    preferColor: null,
  });
  assert.match(describeTarget(target), /不限价/);
});

test("targetFromEnv: 价格不是数字时报错", () => {
  assert.throws(() => targetFromEnv({ MAX_PRICE_USD: "两千" }), /MAX_PRICE_USD/);
});
