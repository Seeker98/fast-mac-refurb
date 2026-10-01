/**
 * 与运行环境无关的纯逻辑：解析页面、筛选打分、对比上下架。
 * worker.js 和测试都从这里导入，不依赖 cloudflare:workers。
 */

export const BOOTSTRAP_MARKER = "window.REFURB_GRID_BOOTSTRAP = ";
const CHIP_RE = /Apple\s+(M\d+(?:\s+Pro|\s+Max)?)\s+[Cc]hip/;

export function extractBootstrapJson(html) {
  const start = html.indexOf(BOOTSTRAP_MARKER);
  if (start === -1) return null;
  const jsonStart = start + BOOTSTRAP_MARKER.length;

  // 花括号配对，从 jsonStart 处截取出完整的 JSON 对象
  let depth = 0;
  let inStr = false;
  let strChar = "";
  let escape = false;
  let end = -1;

  for (let i = jsonStart; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === strChar) inStr = false;
    } else {
      if (c === '"' || c === "'") {
        inStr = true;
        strChar = c;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
  }

  if (end === -1) return null;
  try {
    return JSON.parse(html.slice(jsonStart, end));
  } catch {
    return null;
  }
}

export function cleanPrice(amountHtml) {
  return (amountHtml || "").replace(/<[^>]+>/g, "").trim();
}

// 优先用 Apple 给的 raw_amount(如 "1699.00")，没有时再从展示文本里抠数字
export function parsePrice(currentPrice) {
  const raw = parseFloat(currentPrice?.raw_amount);
  if (Number.isFinite(raw)) return raw;
  const m = cleanPrice(currentPrice?.amount).match(/[\d,]+\.\d+/);
  return m ? parseFloat(m[0].replace(/,/g, "")) : null;
}

export function extractChip(title) {
  const m = CHIP_RE.exec(title || "");
  return m ? m[1] : null;
}

// 选购条件的默认值，和 wrangler.jsonc 里的 vars 一一对应。
// 部署时在 vars 里改这些值即可，不用改代码。
export const DEFAULT_TARGET_VARS = {
  MODEL: "macbookpro",
  SCREEN_SIZE: "14inch",
  MEMORY_OPTIONS: "32gb,24gb",
  CHIP_OPTIONS: "M5,M5 Pro",
  CHIP_MEMORY_OVERRIDES: "M5 Pro=24gb",
  CAPACITY: "1tb",
  MAX_PRICE_USD: "2249",
  PREFER_NANO_TEXTURE: "true",
  PREFER_COLOR: "spaceblack",
};

const splitList = (s, sep) =>
  s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * 把环境变量(字符串)解析成 buildCandidates 用的 target。
 * 没设置的变量用默认值；设成空字符串表示"不限制"(MAX_PRICE_USD / PREFER_COLOR / CHIP_MEMORY_OVERRIDES)。
 * CHIP_MEMORY_OVERRIDES 格式: "M5 Pro=24gb; M5 Max=36gb|48gb"
 */
export function targetFromEnv(env = {}) {
  const get = (key) => String(env[key] ?? DEFAULT_TARGET_VARS[key]).trim();

  const chipMemoryOverrides = {};
  for (const part of splitList(get("CHIP_MEMORY_OVERRIDES"), ";")) {
    const [chip, memories = ""] = part.split("=");
    if (chip.trim()) chipMemoryOverrides[chip.trim()] = splitList(memories.toLowerCase(), "|");
  }

  const maxPriceText = get("MAX_PRICE_USD");
  const maxPriceUsd = maxPriceText === "" ? null : Number(maxPriceText);
  if (maxPriceUsd !== null && !Number.isFinite(maxPriceUsd)) {
    throw new Error(`MAX_PRICE_USD 不是有效数字: ${maxPriceText}`);
  }

  return {
    screenSize: get("SCREEN_SIZE").toLowerCase(),
    model: get("MODEL").toLowerCase(),
    memoryOptionsByPriority: splitList(get("MEMORY_OPTIONS").toLowerCase(), ","),
    chipOptionsByPriority: splitList(get("CHIP_OPTIONS"), ","),
    chipMemoryOverrides,
    requiredCapacity: get("CAPACITY").toLowerCase(),
    maxPriceUsd,
    preferNanoTexture: get("PREFER_NANO_TEXTURE").toLowerCase() === "true",
    preferColor: get("PREFER_COLOR").toLowerCase() || null,
  };
}

// 状态页上展示用的一行条件摘要
export function describeTarget(target) {
  const overrides = Object.entries(target.chipMemoryOverrides)
    .map(([chip, mems]) => `${chip} 仅 ${mems.join("/")}`)
    .join("，");
  return [
    `${target.screenSize} ${target.model}`,
    `内存 ${target.memoryOptionsByPriority.join(" > ")}`,
    `芯片 ${target.chipOptionsByPriority.join(" > ")}${overrides ? `(${overrides})` : ""}`,
    `容量 ${target.requiredCapacity}`,
    target.maxPriceUsd == null ? "不限价" : `≤ $${target.maxPriceUsd}`,
    target.preferNanoTexture ? "优先 nano-texture" : null,
    target.preferColor ? `优先颜色 ${target.preferColor}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function buildCandidates(data, target) {
  const memoryPriority = target.memoryOptionsByPriority;
  const chipPriority = target.chipOptionsByPriority;
  const candidates = [];

  for (const tile of data.tiles || []) {
    const title = tile.title || "";
    const dims = (tile.filters && tile.filters.dimensions) || {};

    if (dims.dimensionScreensize !== target.screenSize) continue;
    if (dims.refurbClearModel !== target.model) continue;

    const memory = dims.tsMemorySize;
    if (!memoryPriority.includes(memory)) continue;
    if (dims.dimensionCapacity !== target.requiredCapacity) continue;

    const chip = extractChip(title);
    if (!chipPriority.includes(chip)) continue;

    // 某些芯片只接受特定内存搭配，例如 M5 Pro 只考虑 24GB
    const allowedMemory = (target.chipMemoryOverrides && target.chipMemoryOverrides[chip]) || memoryPriority;
    if (!allowedMemory.includes(memory)) continue;

    const currentPrice = tile.price?.currentPrice;
    const priceValue = parsePrice(currentPrice);
    if (target.maxPriceUsd != null && (priceValue == null || priceValue > target.maxPriceUsd)) continue;

    const isNano = title.toLowerCase().includes("nano-texture");
    const color = dims.dimensionColor || "";

    // 分数越高优先级越高: 内存 > 芯片 > nano-texture > 颜色
    let score = 0;
    score += (memoryPriority.length - memoryPriority.indexOf(memory)) * 1000;
    score += (chipPriority.length - chipPriority.indexOf(chip)) * 100;
    if (isNano && target.preferNanoTexture) score += 10;
    if (target.preferColor && color === target.preferColor) score += 1;

    candidates.push({
      partNumber: tile.partNumber,
      title,
      price: cleanPrice(currentPrice?.amount),
      url: "https://www.apple.com" + (tile.productDetailsUrl || ""),
      memory,
      chip,
      capacity: dims.dimensionCapacity,
      color,
      nanoTexture: isNano,
      score,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

export function formatItem(rank, item) {
  return (
    `${rank}. ${item.title}\n` +
    `   价格: ${item.price} | 内存: ${item.memory} | 芯片: ${item.chip} | ` +
    `容量: ${item.capacity} | 颜色: ${item.color} | Nano-texture: ${item.nanoTexture ? "是" : "否"}\n` +
    `   链接: ${item.url}`
  );
}

/**
 * 拿本轮候选和上一轮已知商品做对比。
 *
 * - 新出现的商品放进 newItems，但不放进返回的 items：调用方通知成功后再自己加进去，
 *   这样通知失败时下一轮还会把它当成"新的"重试。
 * - 已知商品本轮没看到只累加 misses，连续 removeAfterMisses 次都没看到才算下架，
 *   避免 CDN 节点之间数据不一致导致"下架→补货"来回跳、重复推送。
 */
export function reconcile(prevItems, candidates, removeAfterMisses) {
  const items = {};
  const newItems = [];
  const removedItems = [];
  const seen = new Set();

  for (const c of candidates) {
    seen.add(c.partNumber);
    if (prevItems[c.partNumber]) {
      items[c.partNumber] = { title: c.title, price: c.price, misses: 0 };
    } else {
      newItems.push(c);
    }
  }

  for (const [id, prev] of Object.entries(prevItems)) {
    if (seen.has(id)) continue;
    const misses = (prev.misses || 0) + 1;
    if (misses >= removeAfterMisses) removedItems.push({ partNumber: id, title: prev.title, price: prev.price });
    else items[id] = { ...prev, misses };
  }

  return { items, newItems, removedItems };
}
