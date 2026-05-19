const fs = require("fs");

const CONFIG_PATH = "config.json";
const STATE_PATH = "state.json";

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8") || "{}")
  : {};

function extractSlug(url) {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("event");

  if (idx === -1 || !parts[idx + 1]) {
    throw new Error(`无法从 URL 中提取 event slug: ${url}`);
  }

  return parts[idx + 1];
}

function parseMaybeJson(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return JSON.parse(value);
  return value || [];
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "polymarket-watch"
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${url}\n${text}`);
  }

  return res.json();
}

function getMarketFromEvent(event, item) {
  const markets = event.markets || [];

  if (!markets.length) {
    throw new Error(`事件没有 markets: ${item.url}`);
  }

  if (item.marketQuestion) {
    const market = markets.find(m =>
      String(m.question || "")
        .toLowerCase()
        .includes(item.marketQuestion.toLowerCase())
    );

    if (!market) {
      throw new Error(`找不到 marketQuestion: ${item.marketQuestion}`);
    }

    return market;
  }

  return markets[0];
}

function getTokenId(market, outcomeName) {
  const outcomes = parseMaybeJson(market.outcomes || market.outcomeNames);
  const tokenIds = parseMaybeJson(market.clobTokenIds || market.tokenIds);

  const index = outcomes.findIndex(
    x => String(x).toLowerCase() === outcomeName.toLowerCase()
  );

  if (index === -1) {
    throw new Error(
      `找不到 outcome=${outcomeName}，可选项: ${outcomes.join(", ")}`
    );
  }

  const tokenId = tokenIds[index];

  if (!tokenId) {
    throw new Error(`找不到 ${outcomeName} 对应的 tokenId`);
  }

  return String(tokenId);
}

async function barkPush(title, body, url) {
  const envName = CONFIG.barkKeyEnv || "BARK_KEY";
  const barkKey = process.env[envName];

  if (!barkKey) {
    console.log(`未设置 ${envName}，跳过 Bark 推送`);
    return;
  }

  const barkUrl =
    `https://api.day.app/${encodeURIComponent(barkKey)}/` +
    `${encodeURIComponent(title)}/` +
    `${encodeURIComponent(body)}` +
    `?url=${encodeURIComponent(url)}`;

  const res = await fetch(barkUrl);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bark 推送失败: ${res.status} ${text}`);
  }
}

async function main() {
  const watchItems = [];

  for (const item of CONFIG.markets) {
    const slug = extractSlug(item.url);
    const eventUrl =
      `https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(slug)}`;

    const event = await fetchJson(eventUrl);
    const market = getMarketFromEvent(event, item);
    const outcome = item.outcome || "Yes";
    const tokenId = getTokenId(market, outcome);

    watchItems.push({
      ...item,
      slug,
      market,
      outcome,
      tokenId
    });
  }

  const tokenIds = watchItems.map(x => x.tokenId);

  if (!tokenIds.length) {
    console.log("config.json 中没有可监控的交易");
    return;
  }

  const priceUrl =
    "https://clob.polymarket.com/last-trades-prices?" +
    tokenIds.map(id => `token_ids=${encodeURIComponent(id)}`).join("&");

  const pricesResp = await fetchJson(priceUrl);

  const pricesMap = new Map();

  if (Array.isArray(pricesResp)) {
    for (const p of pricesResp) {
      pricesMap.set(String(p.token_id || p.tokenId), Number(p.price));
    }
  } else {
    for (const [tokenId, price] of Object.entries(pricesResp)) {
      pricesMap.set(String(tokenId), Number(price));
    }
  }

  for (const item of watchItems) {
    const price = pricesMap.get(item.tokenId);

    if (!Number.isFinite(price)) {
      console.log(`跳过 ${item.name}，没有查到价格，tokenId=${item.tokenId}`);
      continue;
    }

    const pct = price * 100;
    const stateKey = `${item.slug}:${item.market.id || item.market.conditionId}:${item.outcome}`;
    const prev = state[stateKey];

    console.log(`${item.name} / ${item.outcome}: ${pct.toFixed(2)}%`);

    if (prev && Number.isFinite(prev.price)) {
      const risePctPoints = (price - prev.price) * 100;
      const threshold = Number(item.thresholdPctPoints || 0);

      if (risePctPoints >= threshold) {
        await barkPush(
          `Polymarket 涨幅提醒`,
          `${item.name} / ${item.outcome}: 从 ${(prev.price * 100).toFixed(2)}% 涨到 ${pct.toFixed(2)}%，上涨 ${risePctPoints.toFixed(2)} 个百分点`,
          item.url
        );
      }
    }

    state[stateKey] = {
      name: item.name,
      url: item.url,
      outcome: item.outcome,
      tokenId: item.tokenId,
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
