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

function pickPrice(text) {
  // Ejemplos típicos: "AR$ 12.345", "US$ 120", "$ 10.000", "€ 99"
  const m = text.match(/(US\$|AR\$|ARS|\$|€)\s?[\d.\,]+/);
  return m ? m[0] : "";
}

(async () => {
  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    locale: "es-AR",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  });

  const page = await context.newPage();
  page.setDefaultTimeout(120000);

  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded" });

  // Aceptar cookies si aparece (best-effort)
  try {
    // Trivago cambia textos; cubrimos varios
    const cookieButtons = [
      'button:has-text("Aceptar")',
      'button:has-text("I agree")',
      'button:has-text("Accept")',
      'button:has-text("Agree")'
    ];
    for (const sel of cookieButtons) {
      const btn = page.locator(sel);
      if (await btn.count()) {
        await btn.first().click({ timeout: 3000 });
        break;
      }
    }
  } catch (_) {}

  // Espera a que haya contenido real
  await page.waitForTimeout(6000);

  // Scroll para disparar lazy-load
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(1200);
  }

  // Extraer resultados
  const items = await page.evaluate(() => {
    const out = [];

    // Heurística: cards en "article" suele capturar list items
    const cards = Array.from(document.querySelectorAll("article"));

    for (const c of cards) {
      const text = (c.innerText || "").trim();
      if (!text) continue;

      // Buscar precio
      const priceMatch = text.match(/(US\$|AR\$|ARS|\$|€)\s?[\d.\,]+/);
      if (!priceMatch) continue;

      // Nombre: h1/h2/h3 dentro de card
      const name =
        (c.querySelector("h1,h2,h3")?.textContent || "").trim() ||
        (text.split("\n").find((l) => l.trim().length > 6) || "").trim();

      // Proveedor: a veces aparece como "Booking.com", "Expedia", etc. (best-effort)
      const providerLine = text.split("\n").find(l =>
        /booking|expedia|agoda|despegar|hotels\.com|airbnb|trip\.com/i.test(l)
      ) || "";

      const a = c.querySelector('a[href]');
      const url = a ? a.href : "";

      out.push({
        name,
        priceText: priceMatch[0],
        provider: providerLine.trim(),
        url
      });
    }

    return out;
  });

  await browser.close();

  // Dedupe + limit
  const cleaned = uniqBy(
    items
      .map(it => ({
        name: (it.name || "").trim(),
        priceText: (it.priceText || "").trim(),
        provider: (it.provider || "").trim(),
        url: (it.url || "").trim()
      }))
      .filter(it => it.name && it.priceText),
    it => `${it.name}||${it.priceText}||${it.url}`.toLowerCase()
  ).slice(0, MAX_ITEMS);

  // Post a Apps Script Web App
  const resp = await fetch(WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      searchUrl: SEARCH_URL,
      items: cleaned
    })
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`WebApp error ${resp.status}: ${text}`);
  }

  console.log(`OK posted ${cleaned.length} items. WebApp response: ${text}`);
})();
