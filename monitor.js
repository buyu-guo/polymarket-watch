const fs = require("fs");

const CONFIG = JSON.parse(fs.readFileSync("config.json", "utf8"));
const STATE_PATH = "state.json";
const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8") || "{}")
  : {};

function extractSlug(url) {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("event");
  if (idx === -1 || !parts[idx + 1]) {
    throw new Error(`无法从 URL 提取 event slug: ${url}`);
  }
  return parts[idx + 1];
}

function parseMaybeJson(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return JSON.parse(v);
  return v;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "accept": "application/json" }
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${url}`);
  }
  return res.json();
}

function findTokenId(market, outcomeName) {
  const outcomes = parseMaybeJson(market.outcomes || market.outcomeNames || []);
  const tokenIds = parseMaybeJson(market.clobTokenIds || market.tokenIds || []);

  const index = outcomes.findIndex(
    x => String(x).toLowerCase() === outcomeName.toLowerCase()
  );

  if (index < 0) {
    throw new Error(`找不到 outcome=${outcomeName}，可选项: ${outcomes.join(", ")}`);
  }

  const tokenId = tokenIds[index];
  if (!tokenId) {
    throw new Error(`找不到 ${outcomeName} 对应的 clobTokenId`);
  }

  return tokenId;
}

async function barkPush(title, body, url) {
  const key = process.env[CONFIG.barkKeyEnv || "BARK_KEY"];
  if (!key) {
    console.log("未设置 BARK_KEY，跳过推送");
    return;
  }

  const barkUrl =
    `https://api.day.app/${encodeURIComponent(key)}/` +
    `${encodeURIComponent(title)}/` +
    `${encodeURIComponent(body)}?url=${encodeURIComponent(url)}`;

  const res = await fetch(barkUrl);
  if (!res.ok) {
    throw new Error(`Bark 推送失败: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  for (const item of CONFIG.markets) {
    const slug = extractSlug(item.url);
    const event = await fetchJson(
      `https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(slug)}`
    );

    const markets = event.markets || [];
    if (!markets.length) {
      throw new Error(`事件没有 markets: ${slug}`);
    }

    const market = item.marketQuestion
      ? markets.find(m => String(m.question || "").includes(item.marketQuestion))
      : markets[0];

    if (!market) {
      throw new Error(`找不到指定 marketQuestion: ${item.marketQuestion}`);
    }

    const outcome = item.outcome || "Yes";
    const tokenId = findTokenId(market, outcome);

    const prices = await fetchJson(
      `https://clob.polymarket.com/last-trades-prices?token_ids=${encodeURIComponent(tokenId)}`
    );

    const row = Array.isArray(prices) ? prices.find(x => x.token_id === tokenId) : prices;
    const price = Number(row.price);
    const pct = price * 100;

    const key = `${slug}:${market.id || market.conditionId}:${outcome}`;
    const prev = state[key];

    console.log(`${item.name}: ${outcome} = ${pct.toFixed(2)}%`);

    if (prev && typeof prev.price === "number") {
      const deltaPctPoints = (price - prev.price) * 100;

      if (deltaPctPoints >= item.thresholdPctPoints) {
        await barkPush(
          `Polymarket 涨幅提醒：${item.name}`,
          `${outcome} 从 ${(prev.price * 100).toFixed(2)}% 涨到 ${pct.toFixed(2)}%，上涨 ${deltaPctPoints.toFixed(2)} 个百分点`,
          item.url
        );
      }
    }

    state[key] = {
      name: item.name,
      url: item.url,
      outcome,
      tokenId,
      price,
      pct,
      checkedAt: new Date().toISOString()
    };
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
