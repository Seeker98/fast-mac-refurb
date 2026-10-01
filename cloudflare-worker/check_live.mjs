// 手动排查用：直接抓 Apple 页面，列出所有 14 寸 MacBook Pro 的原始维度和价格
import { cleanPrice, extractBootstrapJson } from './src/core.js';

const PAGE_URL = 'https://www.apple.com/shop/refurbished/mac/14-inch-macbook-pro-24gb-32gb';

const resp = await fetch(`${PAGE_URL}?_=${Date.now()}`, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
});
const data = extractBootstrapJson(await resp.text());
if (!data) {
  console.log('NO BOOTSTRAP FOUND');
} else {
  const mbp = data.tiles.filter(t => t.title && t.title.includes('MacBook Pro') && t.title.includes('14-inch'));
  for (const t of mbp) {
    console.log(t.title, '|', JSON.stringify(t.filters.dimensions), '|', cleanPrice(t.price.currentPrice.amount));
  }
}
