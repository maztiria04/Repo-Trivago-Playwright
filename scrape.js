import { chromium } from "playwright";

const SEARCH_URL = process.env.TRIVAGO_URL;
const WEBAPP_URL = process.env.SHEETS_WEBAPP_URL;
const MAX_ITEMS = Number(process.env.MAX_ITEMS || "30");

if (!SEARCH_URL) throw new Error("Missing env TRIVAGO_URL");
if (!WEBAPP_URL) throw new Error("Missing env SHEETS_WEBAPP_URL");

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function pickPriceFromAny(obj) {
  // Heurística para encontrar un precio en objetos JSON desconocidos
  const s = JSON.stringify(obj);
  const m = s.match(/(US\$|AR\$|ARS|\$|€)\s?[\d.\,]{2,}/);
  return m ? m[0] : "";
}

function deepFindItems(root, limit = 5000) {
  const out = [];
  const stack = [root];
  let steps = 0;

  while (stack.length && steps < limit) {
    steps++;
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    if (typeof cur !== "object") continue;

    // Heurística de “card”
    const name =
      cur.name ||
      cur.title ||
      cur.hotelName ||
      cur.accommodationName ||
      cur.propertyName ||
      "";

    // URL
    const url = cur.url || cur.href || cur.link || cur.clickoutUrl || "";

    // Provider
    const provider = cur.provider || cur.partner || cur.vendor || cur.site || cur.advertiser || "";

    // Precio
    const priceText =
      cur.priceText ||
      cur.displayPrice ||
      cur.formattedPrice ||
      (cur.price && (cur.price.display || cur.price.formatted || cur.price.text)) ||
      "";

    const priceGuess = priceText || pickPriceFromAny(cur);

    if (typeof name === "string" && name.length > 3 && priceGuess) {
      out.push({
        name: String(name).trim(),
        priceText: String(priceGuess).trim(),
        provider: String(provider || "").trim(),
        url: String(url || "").trim()
      });
    }

    for (const k of Object.keys(cur)) stack.push(cur[k]);
  }

  return out;
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    locale: "es-AR",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  });

  const page = await context.newPage();
  page.setDefaultTimeout(120000);

  // Capturar candidates desde la red
  const networkItems = [];
  page.on("response", async (resp) => {
    try {
      const url = resp.url();
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("application/json")) return;

      // Trivago suele pegar endpoints con "search", "offers", "pricing", etc.
      if (!/search|offer|price|pricing|deal|result|accommod/i.test(url)) return;

      const json = await resp.json();
      const found = deepFindItems(json, 6000);
      if (found.length) networkItems.push(...found);
    } catch (_) {}
  });

  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });

  // cookies (best-effort)
  try {
    const btn = page.locator('button:has-text("Aceptar"), button:has-text("Accept")');
    if (await btn.count()) await btn.first().click({ timeout: 3000 });
  } catch (_) {}

  // dar tiempo a XHR
  await page.waitForTimeout(12000);

  // scroll para disparar más requests
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(1200);
  }

  // Si la red no dio nada, fallback DOM (más amplio que article)
  let items = uniqBy(networkItems, it => `${it.name}||${it.priceText}||${it.url}`.toLowerCase());

  if (items.length === 0) {
    const domItems = await page.evaluate(() => {
      const out = [];
      const candidates = Array.from(document.querySelectorAll("article, a[href]"));

      for (const el of candidates) {
        const text = (el.innerText || "").trim();
        if (!text) continue;
        const pm = text.match(/(US\$|AR\$|ARS|\$|€)\s?[\d.\,]+/);
        if (!pm) continue;

        const name =
          (el.querySelector("h1,h2,h3")?.textContent || "").trim() ||
          (text.split("\n").find(l => l.trim().length > 6) || "").trim();

        let href = "";
        const a = el.tagName.toLowerCase() === "a" ? el : el.querySelector("a[href]");
        if (a) href = a.href || "";

        out.push({ name, priceText: pm[0], provider: "", url: href });
        if (out.length >= 60) break;
      }
      return out;
    });

    items = uniqBy(domItems, it => `${it.name}||${it.priceText}||${it.url}`.toLowerCase());
  }

  items = items.filter(it => it.name && it.priceText).slice(0, MAX_ITEMS);

  // DEBUG artifacts (SIEMPRE)
  await page.screenshot({ path: "debug.png", fullPage: true });
  const html = await page.content();
  await import("fs").then(fs => fs.writeFileSync("debug.html", html, "utf8"));
  console.log("DEBUG: saved debug.png and debug.html");

  await browser.close();

  const resp = await fetch(WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ searchUrl: SEARCH_URL, items })
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`WebApp error ${resp.status}: ${text}`);

  console.log(`OK posted ${items.length} items. WebApp response: ${text}`);
})();
