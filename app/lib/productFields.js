// Gemeinsame Feld-Definitionen für die Produktverwaltung (Client und Server).

export const PRODUCT_TEXT_FIELDS = [
  { key: "bezeichnung", label: "Bezeichnung (Sachbezeichnung)", type: "single_line_text_field" },
  { key: "inhalt", label: "Inhalt", type: "single_line_text_field", help: "z. B. 1000 g, 120 Kapseln" },
  { key: "gewicht", label: "Gewicht", type: "single_line_text_field" },
  { key: "grundpreis", label: "Grundpreis (Text)", type: "single_line_text_field", help: "z. B. 29,90 € / 1 kg" },
  { key: "zutaten", label: "Zutaten", type: "single_line_text_field", multiline: 4 },
  { key: "n_hrwerte", label: "Nährwerte", type: "single_line_text_field", multiline: 4 },
  { key: "allergiehinweis", label: "Allergiehinweis", type: "single_line_text_field", multiline: 2 },
  { key: "zusatzinformationen", label: "Verzehrempfehlung", type: "single_line_text_field", multiline: 3 },
  { key: "eigenschaften", label: "Eigenschaften", type: "single_line_text_field", help: "z. B. Vegan, Glutenfrei, Laktosefrei" },
  { key: "hinweistext", label: "Hinweistext", type: "multi_line_text_field", multiline: 3 },
  { key: "rabatt", label: "Marketing-Beschreibung", type: "single_line_text_field", multiline: 2 },
  { key: "verzehrempfehlung", label: "Verzehrempfehlung 2", type: "single_line_text_field" },
  { key: "hinweis", label: "Warnhinweis", type: "single_line_text_field" },
  { key: "aminos_urenprofil", label: "Aminosäurenprofil (Tabelle)", type: "single_line_text_field" },
  { key: "aminosaurenprofil_text", label: "Aminosäurenprofil (Text)", type: "single_line_text_field" },
  { key: "textilkennzeichen", label: "Textilkennzeichnung", type: "single_line_text_field" },
  { key: "gr_entabelle", label: "Größentabelle", type: "single_line_text_field" },
  { key: "content", label: "Etikett / Download 1 (PDF-Link)", type: "single_line_text_field" },
  { key: "content2", label: "Etikett / Download 2 (PDF-Link)", type: "single_line_text_field" },
  { key: "content3", label: "Etikett / Download 3 (PDF-Link)", type: "single_line_text_field" },
  { key: "crosssell1", label: "Passendes Produkt 1 (SKU)", type: "single_line_text_field" },
  { key: "crosssell2", label: "Passendes Produkt 2 (SKU)", type: "single_line_text_field" },
  { key: "crosssell3", label: "Passendes Produkt 3 (SKU)", type: "single_line_text_field" },
  { key: "crosssell4", label: "Passendes Produkt 4 (SKU)", type: "single_line_text_field" },
  { key: "crosssell5", label: "Passendes Produkt 5 (SKU)", type: "single_line_text_field" },
];

export const PRODUCT_EXPORT_FIELDS = [
  { key: "export_repricer", label: "An Omnia (Repricer) übergeben", type: "single_line_text_field", kind: "flag10" },
  { key: "google_shopping_de", label: "Google Shopping DE", type: "boolean", kind: "bool" },
  { key: "google_shopping_at", label: "Google Shopping AT", type: "boolean", kind: "bool" },
  { key: "idealo", label: "idealo", type: "boolean", kind: "bool" },
  { key: "google_product_category", label: "Google-Produktkategorie", type: "single_line_text_field" },
  { key: "idealo_category", label: "idealo-Kategorie", type: "single_line_text_field" },
  { key: "herstellerinformation", label: "Herstellerinformation (GPSR)", type: "single_line_text_field" },
  { key: "google_custom_label_0", label: "Google Label 0", type: "single_line_text_field" },
  { key: "google_custom_label_1", label: "Google Label 1", type: "single_line_text_field" },
  { key: "google_custom_label_2", label: "Google Label 2", type: "single_line_text_field" },
];

// Werden automatisch gesetzt (Hersteller-Auswahl bzw. Label-Regeln), nicht als Freitext angezeigt
export const PRODUCT_AUTO_FIELDS = [
  { key: "hersteller", label: "Hersteller (Metaobjekt)", type: "metaobject_reference" },
];

// Artikelnummern aus dem Altshop, müssen je Produkt eindeutig sein (SKU beginnt mit dieser Nummer)
export const PRODUCT_ID_FIELDS = [
  { key: "product_model", label: "Product model", type: "number_integer" },
  { key: "products_id", label: "Products id", type: "number_integer" },
];

export const PRODUCT_METAFIELDS = [...PRODUCT_TEXT_FIELDS, ...PRODUCT_EXPORT_FIELDS, ...PRODUCT_AUTO_FIELDS, ...PRODUCT_ID_FIELDS];

// Varianten-Metafelder, die direkt bearbeitet werden (Preis-JSONs werden separat gepflegt)
export const VARIANT_METAFIELDS = [
  { key: "omnia", label: "Omnia-ID", type: "single_line_text_field" },
  { key: "omnia_min", label: "Min-Preis", type: "single_line_text_field" },
  { key: "omnia_max", label: "Max-Preis", type: "single_line_text_field" },
  { key: "aussenlager", label: "Außenlager", type: "number_integer" },
  { key: "melde", label: "Meldebestand", type: "number_integer" },
  { key: "google_unit_pricing_measure", label: "Grundpreis-Menge", type: "single_line_text_field" },
  { key: "google_unit_pricing_base_measure", label: "Grundpreis-Bezug", type: "single_line_text_field" },
  { key: "varianteninhalt", label: "Inhalt dieses Geschmacks", type: "single_line_text_field" },
  { key: "variantengewicht", label: "Gewicht-Text dieses Geschmacks", type: "single_line_text_field" },
];

export const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
};

// Produkt-Check: was fehlt oder ist widersprüchlich?
export function checkProduct(p) {
  const issues = [];
  const add = (level, text) => issues.push({ level, text });
  const exported = String(p.meta?.export_repricer || "") === "1";

  if (!p.title?.trim()) add("critical", "Titel fehlt");
  if (!p.images?.length) add("warning", "Kein Produktbild");
  if (!String(p.descriptionHtml || "").replace(/<[^>]*>/g, "").trim()) add("warning", "Keine Beschreibung");
  if (!p.meta?.herstellerinformation?.trim()) add("warning", "Herstellerinformation (GPSR) fehlt");
  if (!p.meta?.zutaten?.trim() && !p.meta?.inhalt?.trim()) add("info", "Zutaten und Inhalt leer");

  const eans = {};
  for (const v of p.variants || []) {
    const label = v.title || v.option;
    const name = label && label !== "Default Title" ? `„${label}“: ` : "";
    const price = num(v.price);
    const ek = num(v.cost);
    const min = num(v.meta?.omnia_min);
    const max = num(v.meta?.omnia_max);
    if (!v.sku?.trim()) add("critical", `${name}SKU fehlt`);
    if (!v.barcode?.trim()) add(exported ? "critical" : "warning", `${name}EAN fehlt${exported ? " – Omnia kann den Artikel nicht zuordnen" : ""}`);
    else eans[v.barcode.trim()] = (eans[v.barcode.trim()] || 0) + 1;
    if (ek === null || ek <= 0) add("warning", `${name}EK (Kosten pro Artikel) fehlt`);
    if (price === null || price <= 0) add("critical", `${name}Preis fehlt`);
    if (price !== null && ek && price < ek) add("warning", `${name}Preis ${price.toFixed(2)} € liegt unter EK ${ek.toFixed(2)} €`);
    if (exported) {
      if (!v.meta?.omnia?.trim()) add("critical", `${name}Omnia-ID fehlt`);
      if (min === null || max === null || min <= 0 || max <= 0) add("critical", `${name}Min/Max fehlt oder ist 0 – Omnia lehnt ab`);
      else if (min > max) add("critical", `${name}Min ${min} liegt über Max ${max} – Omnia lehnt ab`);
      else if (price !== null && (price < min - 0.001 || price > max + 0.001)) add("info", `${name}Preis liegt außerhalb Min/Max (wird beim nächsten Repricer-Lauf angepasst)`);
    }
    if (!v.meta?.google_unit_pricing_measure?.trim()) add("info", `${name}Grundpreis-Menge fehlt`);
    if (!num(v.weight)) add("warning", `${name}Versandgewicht fehlt`);
  }
  for (const [ean, n] of Object.entries(eans)) if (n > 1) add("critical", `EAN ${ean} ist ${n}× vergeben`);
  return issues;
}

// Google-Labels nach den im Shop gelebten Regeln (aus 1.330 Produkten abgeleitet):
//   Label 0 = Rohertrag je Stück (Preis − EK): < 9 € niedrig, < 15 € mittel, sonst hoch
//   Label 1 = Abverkauf (wird nicht verändert, neue Produkte: „kein“)
//   Label 2 = Preisklasse: < 10 € niedrig, < 30 € mittel, sonst hoch
export const LABEL_RULES = { marginMid: 9, marginHigh: 15, priceMid: 10, priceHigh: 30 };

export function computeLabels(variants, current = {}) {
  const priced = (variants || []).map((v) => ({ price: num(v.price), cost: num(v.cost) })).filter((v) => v.price);
  if (!priced.length) return { ...current };
  const cheapest = priced.reduce((a, b) => (b.price < a.price ? b : a));
  const margin = cheapest.cost !== null ? cheapest.price - cheapest.cost : null;
  const l0 = margin === null ? current.google_custom_label_0 || "niedrig" : margin < LABEL_RULES.marginMid ? "niedrig" : margin < LABEL_RULES.marginHigh ? "mittel" : "hoch";
  const l2 = cheapest.price < LABEL_RULES.priceMid ? "niedrig" : cheapest.price < LABEL_RULES.priceHigh ? "mittel" : "hoch";
  return { google_custom_label_0: l0, google_custom_label_1: current.google_custom_label_1 || "kein", google_custom_label_2: l2 };
}

export const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

const clean = (t) => String(t || "").replace(/\s+-\s+/g, " ").replace(/\s+/g, " ").trim();

export function seoSuggestion(title, vendor) {
  const t = clean(title);
  if (!t) return { seoTitle: "", seoDescription: "", handle: "" };
  const seoTitle = `${t} günstig kaufen | Sportnahrung Kwax`.length <= 70 ? `${t} günstig kaufen | Sportnahrung Kwax` : `${t} | Sportnahrung Kwax`.slice(0, 70);
  const seoDescription = `${t} jetzt bei Sportnahrung Kwax günstig bestellen${vendor ? ` – Original von ${vendor}` : ""}. Schneller Versand und faire Preise.`.slice(0, 160);
  return { seoTitle, seoDescription, handle: slugify(title) };
}
