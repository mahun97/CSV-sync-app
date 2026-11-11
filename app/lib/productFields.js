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
  { key: "herstellerinformation", label: "Herstellerinformation (GPSR)", type: "single_line_text_field", multiline: 2, help: "Name und Anschrift des Herstellers – Pflichtangabe" },
  { key: "rabatt", label: "Marketing-Beschreibung", type: "single_line_text_field", multiline: 2 },
];

export const PRODUCT_EXPORT_FIELDS = [
  { key: "export_repricer", label: "An Omnia (Repricer) übergeben", type: "single_line_text_field", kind: "flag10" },
  { key: "google_shopping_de", label: "Google Shopping DE", type: "boolean", kind: "bool" },
  { key: "google_shopping_at", label: "Google Shopping AT", type: "boolean", kind: "bool" },
  { key: "idealo", label: "idealo", type: "boolean", kind: "bool" },
  { key: "google_product_category", label: "Google-Produktkategorie", type: "single_line_text_field" },
  { key: "idealo_category", label: "idealo-Kategorie", type: "single_line_text_field" },
  { key: "google_custom_label_0", label: "Google Label 0", type: "single_line_text_field" },
  { key: "google_custom_label_1", label: "Google Label 1", type: "single_line_text_field" },
  { key: "google_custom_label_2", label: "Google Label 2", type: "single_line_text_field" },
];

export const PRODUCT_METAFIELDS = [...PRODUCT_TEXT_FIELDS, ...PRODUCT_EXPORT_FIELDS];

// Varianten-Metafelder, die direkt bearbeitet werden (Preis-JSONs werden separat gepflegt)
export const VARIANT_METAFIELDS = [
  { key: "omnia", label: "Omnia-ID", type: "single_line_text_field" },
  { key: "omnia_min", label: "Min-Preis", type: "single_line_text_field" },
  { key: "omnia_max", label: "Max-Preis", type: "single_line_text_field" },
  { key: "aussenlager", label: "Außenlager", type: "number_integer" },
  { key: "melde", label: "Meldebestand", type: "number_integer" },
  { key: "google_unit_pricing_measure", label: "Grundpreis-Menge", type: "single_line_text_field" },
  { key: "google_unit_pricing_base_measure", label: "Grundpreis-Bezug", type: "single_line_text_field" },
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
    const name = v.title && v.title !== "Default Title" ? `„${v.title}“: ` : "";
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
  }
  for (const [ean, n] of Object.entries(eans)) if (n > 1) add("critical", `EAN ${ean} ist ${n}× vergeben`);
  return issues;
}
