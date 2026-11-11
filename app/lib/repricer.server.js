import axios from "axios";
import csv from "csv-parser";
import { Readable } from "stream";
import prisma from "../db.server";
import { offlineGraphql } from "./offlineAdmin.server";
import { getSettings } from "./settings.server";

/*
  Repricer: übernimmt die Omnia-Preisempfehlungen in die Varianten-Metafelder
  custom.pricing / pricing_premium / pricing_customer (base_price_google + base_price_idealo).
  Den Shopify-Preis setzt danach der Ein-Preis-Abgleich auf dem Droplet.

  Jede Entscheidung wird als RepricerEvent protokolliert:
    updated        Preis übernommen
    clamped        Omnia-Empfehlung lag außerhalb Min/Max → auf Grenze gesetzt
    ek_block       Preis läge unter EK → verworfen, alter Preis bleibt
    below_ek_ok    unter EK, aber Achims Min liegt selbst unter EK → erlaubt
    not_in_omnia   aktiver Artikel mit Repricer-Export fehlt in der Omnia-Antwort
    data           Datenfehler (Min > Max, Min/Max fehlt oder 0)
    error          Schreibfehler
*/

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round(n * 100) / 100;
const parseJson = (v) => {
  try {
    return v ? JSON.parse(v) : {};
  } catch {
    return {};
  }
};

export async function fetchOmniaPrices(url) {
  const response = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  const rows = await new Promise((resolve, reject) => {
    const out = [];
    Readable.from(response.data.toString("utf8"))
      .pipe(
        csv({
          separator: ";",
          quote: '"',
          strict: false,
          mapHeaders: ({ header }) => header.replace(/"/g, "").trim(),
        }),
      )
      .on("data", (r) => out.push(r))
      .on("end", () => resolve(out))
      .on("error", reject);
  });
  const prices = new Map();
  for (const r of rows) {
    const id = String(r["product id"] || "").trim();
    const p = num(String(r["recommended price"] || "").replace(";", ""));
    if (id && p !== null) prices.set(id, p);
  }
  return prices;
}

const VARIANTS_QUERY = `
  query ($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        sku
        barcode
        displayName
        product {
          id
          status
          exportRepricer: metafield(namespace: "custom", key: "export_repricer") { value }
        }
        inventoryItem { unitCost { amount } }
        omnia: metafield(namespace: "custom", key: "omnia") { value }
        omniaMin: metafield(namespace: "custom", key: "omnia_min") { value }
        omniaMax: metafield(namespace: "custom", key: "omnia_max") { value }
        pricing: metafield(namespace: "custom", key: "pricing") { value }
        pricingPremium: metafield(namespace: "custom", key: "pricing_premium") { value }
        pricingCustomer: metafield(namespace: "custom", key: "pricing_customer") { value }
      }
    }
  }
`;

async function loadVariants() {
  const all = [];
  let cursor = null;
  do {
    const data = await offlineGraphql(VARIANTS_QUERY, { cursor });
    all.push(...data.productVariants.nodes);
    cursor = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (cursor);
  return all;
}

// Gleiche Patch-Logik wie bisher: nur Google/idealo-Preis + Staffel 1 ersetzen, Rest bleibt
function patchPricing(existing, price) {
  const p = { ...existing, base_price_google: price, base_price_idealo: price };
  if (existing.tiered_price_google) p.tiered_price_google = { ...existing.tiered_price_google, 1: price };
  if (existing.tiered_price_idealo) p.tiered_price_idealo = { ...existing.tiered_price_idealo, 1: price };
  return p;
}

const SET_MUTATION = `
  mutation ($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }
`;

async function writeBatch(items) {
  const metafields = [];
  for (const it of items) {
    for (const [key, val] of [
      ["pricing", it.pricing],
      ["pricing_premium", it.premium],
      ["pricing_customer", it.customer],
    ]) {
      metafields.push({ ownerId: it.variantId, namespace: "custom", key, type: "json", value: JSON.stringify(val) });
    }
  }
  const data = await offlineGraphql(SET_MUTATION, { metafields });
  return data.metafieldsSet.userErrors || [];
}

export async function runRepricer({ trigger = "manual", dryRun = false, slotKey = null } = {}) {
  const settings = await getSettings();
  const ekFactor = num(settings.ekFactor) || 1;
  const clamp = settings.clampToMinMax === "true";
  const allowBelowEk = settings.allowBelowEkIfMinBelowEk === "true";

  let run;
  try {
    run = await prisma.repricerRun.create({ data: { trigger, dryRun, slotKey, status: "running" } });
  } catch (err) {
    if (err.code === "P2002") {
      console.log(`⏭️ Repricer-Lauf ${slotKey} läuft bereits auf einer anderen Instanz`);
      return null;
    }
    throw err;
  }

  const events = [];
  const c = { omniaRows: 0, scanned: 0, updated: 0, unchanged: 0, clamped: 0, ekBlocked: 0, notInOmnia: 0, warnings: 0, errors: 0 };
  const ev = (type, level, v, extra = {}) =>
    events.push({
      runId: run.id,
      type,
      level,
      sku: v?.sku || null,
      omniaId: v?.omnia?.value?.trim() || null,
      variantId: v?.id || null,
      productId: v?.product?.id || null,
      title: v?.displayName || null,
      ...extra,
    });

  try {
    const prices = await fetchOmniaPrices(settings.omniaFeedUrl);
    c.omniaRows = prices.size;
    if (prices.size < 100) throw new Error(`Omnia-Export enthält nur ${prices.size} Preise – Lauf abgebrochen`);

    const variants = await loadVariants();
    const pending = [];
    const eanCount = new Map();
    for (const v of variants) {
      const ean = String(v.barcode || "").trim();
      if (ean && v.omnia?.value) eanCount.set(ean, (eanCount.get(ean) || 0) + 1);
    }

    for (const v of variants) {
      const omniaId = v.omnia?.value?.trim();
      if (!omniaId) continue;
      const active = v.product?.status === "ACTIVE";
      const exported = String(v.product?.exportRepricer?.value || "").trim() === "1";
      const rec = prices.get(omniaId);

      if (rec === undefined) {
        if (active && exported) {
          c.notInOmnia++;
          const mn = num(v.omniaMin?.value);
          const mx = num(v.omniaMax?.value);
          let why = "noch nicht von Omnia übernommen (neu, nach dem 08:30-Feed geändert oder Omnia hat keine Angebote)";
          if (!String(v.barcode || "").trim()) why = "EAN fehlt – Omnia kann den Artikel nicht zuordnen";
          else if (mn === null || mx === null || mn <= 0 || mx <= 0) why = "Min/Max fehlt oder ist 0 – Omnia lehnt den Artikel ab";
          else if (mn > mx) why = `Min ${mn} liegt über Max ${mx} – Omnia lehnt den Artikel ab`;
          else if (eanCount.get(String(v.barcode).trim()) > 1) why = `EAN ${v.barcode} ist mehrfach vergeben – Omnia lehnt den Artikel ab`;
          ev("not_in_omnia", "warning", v, { minPrice: mn, maxPrice: mx, message: `Fehlt im Omnia-Ergebnis: ${why}` });
        }
        continue;
      }
      c.scanned++;

      const min = num(v.omniaMin?.value);
      const max = num(v.omniaMax?.value);
      const ek = num(v.inventoryItem?.unitCost?.amount);
      const pricing = parseJson(v.pricing?.value);
      const cur = num(pricing.base_price_google);
      const base = { omniaPrice: rec, oldPrice: cur, minPrice: min, maxPrice: max, ek };

      const validRange = min !== null && max !== null && min > 0 && max > 0 && min <= max;
      if (!validRange && exported) {
        c.warnings++;
        const why = min !== null && max !== null && min > max ? `Min ${min} liegt über Max ${max}` : "Min/Max fehlt oder ist 0";
        ev("data", "warning", v, { ...base, message: `${why} – Omnia überspringt diesen Artikel beim Import` });
      }

      let target = rec;
      let clampedNow = false;
      if (clamp && validRange && (rec < min - 0.001 || rec > max + 0.001)) {
        target = rec < min ? min : max;
        clampedNow = true;
      }

      if (ek && ek > 0) {
        const limit = round2(ek * ekFactor);
        if (target < limit - 0.001) {
          if (allowBelowEk && validRange && min < limit) {
            ev("below_ek_ok", "info", v, { ...base, newPrice: target, message: `Unter EK-Grenze ${limit.toFixed(2)} €, aber Min ${min} liegt bewusst darunter` });
          } else {
            c.ekBlocked++;
            ev("ek_block", "error", v, { ...base, newPrice: target, message: `Preis ${target.toFixed(2)} € unter EK-Grenze ${limit.toFixed(2)} € – alter Preis bleibt` });
            continue;
          }
        }
      }

      if (clampedNow) {
        c.clamped++;
        ev("clamped", "warning", v, {
          ...base,
          newPrice: target,
          message: `Omnia ${rec.toFixed(2)} € außerhalb Min/Max ${min}–${max} → ${target.toFixed(2)} € (Omnia hat die Grenzen vermutlich noch nicht importiert)`,
        });
      }

      if (cur !== null && Math.abs(cur - target) < 0.005) {
        c.unchanged++;
        continue;
      }

      pending.push({
        v,
        base,
        target,
        variantId: v.id,
        pricing: patchPricing(pricing, target),
        premium: patchPricing(parseJson(v.pricingPremium?.value), target),
        customer: patchPricing(parseJson(v.pricingCustomer?.value), target),
      });
    }

    // Schreiben in Paketen à 8 Varianten (= 24 Metafelder, Grenze 25)
    for (let i = 0; i < pending.length; i += 8) {
      const chunk = pending.slice(i, i + 8);
      let errs = [];
      if (!dryRun) {
        try {
          errs = await writeBatch(chunk);
        } catch (err) {
          errs = [{ message: err.message }];
        }
      }
      for (const it of chunk) {
        if (errs.length) {
          c.errors++;
          ev("error", "error", it.v, { ...it.base, newPrice: it.target, message: errs.map((e) => e.message).join("; ") });
        } else {
          c.updated++;
          ev("updated", "info", it.v, { ...it.base, newPrice: it.target, message: dryRun ? "Probelauf – nicht geschrieben" : null });
        }
      }
    }

    await prisma.repricerEvent.createMany({ data: events });
    run = await prisma.repricerRun.update({
      where: { id: run.id },
      data: { ...c, status: c.errors ? "warning" : "success", finishedAt: new Date() },
    });
  } catch (err) {
    console.error("❌ Repricer-Fehler:", err);
    c.errors++;
    await prisma.repricerEvent.createMany({ data: events }).catch(() => {});
    run = await prisma.repricerRun.update({
      where: { id: run.id },
      data: { ...c, status: "failed", message: err.message, finishedAt: new Date() },
    });
  }

  console.log(`✅ Repricer ${trigger}${dryRun ? " (Probelauf)" : ""}:`, c);

  if (trigger === "schedule" && !dryRun && settings.alertEnabled === "true") {
    await sendAlert(run, events).catch((e) => console.log("❌ Meldung nicht gesendet:", e.message));
  }
  await prisma.repricerRun
    .deleteMany({ where: { startedAt: { lt: new Date(Date.now() - 90 * 864e5) } } })
    .catch(() => {});
  return run;
}

async function sendAlert(run, events) {
  if (!process.env.EK_ALERT_WEBHOOK) return;
  if (run.status !== "failed" && !run.ekBlocked && !run.errors) return;
  const items = events
    .filter((e) => e.type === "ek_block")
    .map((e) => ({ sku: e.sku, name: e.title, omnia: e.newPrice, limit: e.ek, ek: e.ek, kept: e.oldPrice }));
  await fetch(process.env.EK_ALERT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run: `${new Date(run.startedAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}${run.status === "failed" ? " – LAUF FEHLGESCHLAGEN: " + run.message : ""}`,
      items,
    }),
  });
}
