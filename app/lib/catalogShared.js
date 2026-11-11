// Von Client und Server genutzt.
export const TAX_TAGS = ["7prozent", "19prozent"];
export const SHIPPING_TAGS = ["Versandkosten", "Versandkostenfrei"];
export const SPECIAL_TAGS = [
  { tag: "KP1", label: "Kombi-Preis KP1" },
  { tag: "KPDose1", label: "Kombi-Preis KPDose1" },
  { tag: "KPnur2", label: "Kombi-Preis KPnur2" },
  { tag: "Repo", label: "Bei Ausverkauf auf Entwurf (Repo)" },
  { tag: "Probe", label: "Probe" },
  { tag: "BUNDLE", label: "Bundle" },
];

// Alle Tags, die zu einer Kategorie gehören (Kategorie + Eltern + oberste Ebene)
export function tagsForCategory(catalog, tag) {
  const c = catalog.categories.find((x) => x.tag === tag);
  if (!c) return [tag];
  return [...new Set([c.tag, ...(c.ancestors || [])])];
}
