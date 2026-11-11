// Katalog-Wissen aus den bestehenden Produkten ableiten (30 Min. zwischengespeichert):
// Hersteller → Metaobjekt + GPSR-Text, Kategoriebaum aus den Smart-Kollektionen (Tags),
// Standardwerte je Kategorie (Google-/idealo-Kategorie, MwSt-, Versand-Tag).

const TTL = 30 * 60 * 1000;
let cache = { at: 0, data: null, building: null };

import { TAX_TAGS, SHIPPING_TAGS, SPECIAL_TAGS } from "./catalogShared";
export { TAX_TAGS, SHIPPING_TAGS, SPECIAL_TAGS, tagsForCategory } from "./catalogShared";

const most = (arr) => {
  const c = new Map();
  for (const x of arr) if (x) c.set(x, (c.get(x) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
};

const firstLine = (html) =>
  String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&szlig;/g, "ß").replace(/&uuml;/g, "ü").replace(/&ouml;/g, "ö").replace(/&auml;/g, "ä")
    .replace(/&Uuml;/g, "Ü").replace(/&Ouml;/g, "Ö").replace(/&Auml;/g, "Ä").replace(/&#\d+;/g, "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^(vertrieb|hersteller|inverkehrbringer)\s*:?$/i.test(s))[0] || "";

async function build(gql) {
  const products = [];
  let cursor = null;
  do {
    const d = await gql(
      `query ($c: String) {
        products(first: 250, after: $c) {
          pageInfo { hasNextPage endCursor }
          nodes {
            vendor tags
            h: metafield(namespace: "custom", key: "hersteller") { value }
            gp: metafield(namespace: "custom", key: "herstellerinformation") { value }
            gpc: metafield(namespace: "custom", key: "google_product_category") { value }
            ic: metafield(namespace: "custom", key: "idealo_category") { value }
          }
        }
      }`,
      { c: cursor },
    );
    products.push(...d.products.nodes);
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);

  const cd = await gql(`{
    collections(first: 250) { nodes { id title handle productsCount { count } ruleSet { rules { column relation condition } } } }
  }`);

  // Hersteller
  const byVendor = new Map();
  for (const p of products) {
    if (!p.vendor) continue;
    if (!byVendor.has(p.vendor)) byVendor.set(p.vendor, []);
    byVendor.get(p.vendor).push(p);
  }
  const vendors = [...byVendor.entries()]
    .map(([name, ps]) => ({
      name,
      count: ps.length,
      herstellerRef: most(ps.map((p) => p.h?.value)),
      gpsr: most(ps.map((p) => p.gp?.value)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));

  // GPSR-Vorlagen
  const gpsrCount = new Map();
  for (const p of products) {
    const v = p.gp?.value?.trim();
    if (v) gpsrCount.set(v, (gpsrCount.get(v) || 0) + 1);
  }
  const gpsr = [...gpsrCount.entries()]
    .map(([html, count]) => ({ html, count, label: firstLine(html) || html.slice(0, 60) }))
    .sort((a, b) => a.label.localeCompare(b.label, "de"));

  // Kategorien aus Smart-Kollektionen (Tag-Regeln)
  const tagCount = new Map();
  for (const p of products) for (const t of p.tags) tagCount.set(t.toLowerCase(), (tagCount.get(t.toLowerCase()) || 0) + 1);
  const canonicalTag = new Map();
  for (const p of products) for (const t of p.tags) if (!canonicalTag.has(t.toLowerCase())) canonicalTag.set(t.toLowerCase(), t);

  const cats = [];
  for (const c of cd.collections.nodes) {
    const rules = c.ruleSet?.rules?.filter((r) => r.column === "TAG" && r.relation === "EQUALS") || [];
    if (!rules.length) continue;
    // Haupt-Tag: der Tag, der am besten zum Titel passt, sonst der erste
    const primary =
      rules.find((r) => r.condition.toLowerCase() === c.title.toLowerCase())?.condition || rules[0].condition;
    const tag = canonicalTag.get(primary.toLowerCase()) || primary;
    cats.push({ id: c.id, title: c.title, handle: c.handle, tag, count: c.productsCount?.count || 0, ruleTags: rules.map((r) => r.condition.toLowerCase()) });
  }

  // Steuer-, Versand- und Sonder-Tags sind keine Kategorien; gleiche Tags nur einmal
  const excluded = new Set([...TAX_TAGS, ...SHIPPING_TAGS, ...SPECIAL_TAGS.map((t) => t.tag)].map((t) => t.toLowerCase()));
  const seenTags = new Set();
  const catList = cats.filter((c) => {
    const k = c.tag.toLowerCase();
    if (excluded.has(k) || seenTags.has(k) || !tagCount.get(k)) return false;
    seenTags.add(k);
    return true;
  });

  // Hierarchie über gemeinsame Tags: Vorfahr = Kategorie-Tag, der bei ≥ 90 % der Produkte
  // mit diesem Tag ebenfalls gesetzt ist und insgesamt häufiger vorkommt.
  const hasTag = (p, t) => p.tags.some((x) => x.toLowerCase() === t.toLowerCase());
  for (const c of catList) {
    const withTag = products.filter((p) => hasTag(p, c.tag));
    const own = withTag.length;
    const ancestors = catList
      .filter((a) => a !== c && (tagCount.get(a.tag.toLowerCase()) || 0) > own && own > 0 && withTag.filter((p) => hasTag(p, a.tag)).length / own >= 0.9)
      .sort((a, b) => (tagCount.get(a.tag.toLowerCase()) || 0) - (tagCount.get(b.tag.toLowerCase()) || 0));
    c.ancestors = ancestors.map((a) => a.tag);
    const top = ancestors[ancestors.length - 1];
    c.topTag = top && (tagCount.get(top.tag.toLowerCase()) || 0) > 500 ? top.tag : null;
    c.parentTag = ancestors.find((a) => a.tag !== c.topTag)?.tag || null;
    c.defaults = {
      googleCategory: most(withTag.map((p) => p.gpc?.value)),
      idealoCategory: most(withTag.map((p) => p.ic?.value)),
      taxTag: most(withTag.map((p) => p.tags.find((t) => TAX_TAGS.includes(t)))),
      shippingTag: most(withTag.map((p) => p.tags.find((t) => SHIPPING_TAGS.includes(t)))),
    };
    c.count = own;
    delete c.ruleTags;
  }
  // Oberste Ebene (z. B. Sportnahrung) nicht als auswählbare Kategorie
  const tops = new Set(catList.map((c) => c.topTag).filter(Boolean));
  const categories = catList.filter((c) => !tops.has(c.tag));
  const groupOf = (c) => c.parentTag || c.tag;
  categories.sort((a, b) => groupOf(a).localeCompare(groupOf(b), "de") || (a.parentTag ? 1 : 0) - (b.parentTag ? 1 : 0) || a.title.localeCompare(b.title, "de"));

  const googleCategories = [...new Set(products.map((p) => p.gpc?.value).filter(Boolean))].sort();
  const idealoCategories = [...new Set(products.map((p) => p.ic?.value).filter(Boolean))].sort();

  return { vendors, gpsr, categories, googleCategories, idealoCategories, builtAt: Date.now() };
}

export async function getCatalog(gql, { force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < TTL) return cache.data;
  if (cache.building) return cache.building;
  cache.building = build(gql)
    .then((data) => {
      cache = { at: Date.now(), data, building: null };
      return data;
    })
    .catch((e) => {
      cache.building = null;
      if (cache.data) return cache.data;
      throw e;
    });
  return cache.building;
}

