// Artikelnummern (custom.product_model / custom.products_id) aus dem Altshop.
// Shopify kann bei Metafeldern keine Eindeutigkeit prüfen, darum halten wir hier
// einen Index aller vergebenen Nummern (5 Minuten Cache) und melden Doppelungen.

import { PRODUCT_ID_FIELDS } from "./productFields";

const TTL = 5 * 60 * 1000;
// Ausreißer wie 227211111111111 nicht als „höchste Nummer“ werten
const PLAUSIBLE_MAX = 99999;

let cache = null; // { at, entries: [{ id, title, status, product_model, products_id }] }

async function fetchAll(admin) {
  const entries = [];
  let after = null;
  for (let page = 0; page < 40; page++) {
    const res = await admin.graphql(
      `query ($after: String) {
        products(first: 250, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title status
            pm: metafield(namespace: "custom", key: "product_model") { value }
            pi: metafield(namespace: "custom", key: "products_id") { value }
            variants(first: 1) { nodes { sku } }
          }
        }
      }`,
      { variables: { after } },
    );
    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    const d = json.data.products;
    for (const n of d.nodes) {
      entries.push({ id: n.id, title: n.title, status: n.status, sku: n.variants?.nodes?.[0]?.sku || "", product_model: n.pm?.value || "", products_id: n.pi?.value || "" });
    }
    if (!d.pageInfo.hasNextPage) break;
    after = d.pageInfo.endCursor;
  }
  return entries;
}

export async function getNumberIndex(admin, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL) return cache;
  cache = { at: Date.now(), entries: await fetchAll(admin) };
  return cache;
}

// Nach dem Speichern den Eintrag sofort aktualisieren, damit die nächste Prüfung stimmt
export function rememberNumbers(product) {
  if (!cache || !product?.id) return;
  const e = cache.entries.find((x) => x.id === product.id);
  const values = { product_model: String(product.product_model ?? ""), products_id: String(product.products_id ?? "") };
  if (e) Object.assign(e, values, product.title ? { title: product.title } : {});
  else cache.entries.push({ id: product.id, title: product.title || "", status: product.status || "DRAFT", ...values });
}

const norm = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const n = parseInt(s.replace(",", "."), 10);
  return Number.isFinite(n) ? String(n) : s;
};

// Höchste Nummer im fortlaufenden Bereich (mind. 3 Nummern innerhalb von 10), damit
// Tippfehler wie 19271 oder 227211111111111 die Vorschlagsnummer nicht hochtreiben.
export function nextFreeNumber(index) {
  const taken = new Set();
  for (const e of index.entries) for (const f of PRODUCT_ID_FIELDS) {
    const n = parseInt(e[f.key], 10);
    if (Number.isFinite(n) && n > 0 && n <= PLAUSIBLE_MAX) taken.add(n);
  }
  const sorted = [...taken].sort((a, b) => a - b);
  let top = 0;
  for (let i = 2; i < sorted.length; i++) if (sorted[i] - sorted[i - 2] <= 10) top = sorted[i];
  let next = top + 1;
  while (taken.has(next)) next++;
  return String(next);
}

// Nummern weit oberhalb des fortlaufenden Bereichs (vermutlich Tippfehler)
export function listOutliers(index) {
  const limit = Number(nextFreeNumber(index)) + 50;
  return index.entries
    .filter((e) => PRODUCT_ID_FIELDS.some((f) => Number(e[f.key]) > limit))
    .map((e) => ({ id: e.id, title: e.title, status: e.status, sku: e.sku || "", product_model: e.product_model, products_id: e.products_id }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// Liefert je Feld die anderen Produkte, die in DEMSELBEN Feld dieselbe Nummer tragen.
// (Product model und Products id sind im Altshop getrennte Nummernkreise.)
export function findConflicts(index, { productId, product_model, products_id }) {
  const out = [];
  const values = { product_model: norm(product_model), products_id: norm(products_id) };
  for (const f of PRODUCT_ID_FIELDS) {
    const value = values[f.key];
    if (!value) continue;
    const others = index.entries
      .filter((e) => e.id !== productId && norm(e[f.key]) === value)
      .map((e) => ({ id: e.id, title: e.title, status: e.status }));
    if (others.length) out.push({ field: f.key, label: f.label, value, others });
  }
  return out;
}

// Alle Nummern, die im selben Feld bei mehr als einem Produkt stehen
export function listDuplicates(index) {
  const groups = [];
  for (const f of PRODUCT_ID_FIELDS) {
    const byValue = new Map();
    for (const e of index.entries) {
      const v = norm(e[f.key]);
      if (!v) continue;
      if (!byValue.has(v)) byValue.set(v, []);
      byValue.get(v).push(e);
    }
    for (const [value, list] of byValue) {
      if (list.length < 2) continue;
      groups.push({
        field: f.key,
        label: f.label,
        value,
        products: list.map((e) => ({ id: e.id, title: e.title, status: e.status, sku: e.sku || "", product_model: e.product_model, products_id: e.products_id })),
        active: list.filter((e) => e.status === "ACTIVE").length,
      });
    }
  }
  return groups.sort((a, b) => a.label.localeCompare(b.label) || Number(a.value) - Number(b.value));
}
