import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigate, useNavigation, useSubmit } from "@remix-run/react";
import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  TextField,
  Select,
  Checkbox,
  ChoiceList,
  Badge,
  Banner,
  Button,
  Box,
  Divider,
  Icon,
  Tabs,
  Modal,
  Combobox,
  Listbox,
  Tag,
  Tooltip,
} from "@shopify/polaris";
import { SaveBar } from "@shopify/app-bridge-react";
import { AlertCircleIcon, AlertTriangleIcon, InfoIcon, CheckCircleIcon, DeleteIcon, PlusIcon, SearchIcon, EditIcon, DuplicateIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { VARIANT_METAFIELDS, checkProduct, computeLabels, seoSuggestion, num } from "../lib/productFields";
import { loadProduct, loadLocations, saveProduct, createProduct } from "../lib/products.server";
import { getCatalog } from "../lib/catalog.server";
import { tagsForCategory, TAX_TAGS, SHIPPING_TAGS, SPECIAL_TAGS } from "../lib/catalogShared";
import RichTextEditor, { HtmlPreview } from "../components/RichTextEditor";
import ImageManager from "../components/ImageManager";

const gidOf = (id) => `gid://shopify/Product/${id}`;
const eur = (v) => (v === null || v === undefined || v === "" ? "–" : `${Number(v).toFixed(2).replace(".", ",")} €`);

const emptyVariant = (extra = {}) => ({
  id: null,
  option: "",
  title: "",
  sku: "",
  barcode: "",
  price: "",
  compareAtPrice: "",
  cost: "",
  stock: "",
  meta: Object.fromEntries(VARIANT_METAFIELDS.map((f) => [f.key, ""])),
  ...extra,
});

function emptyProduct() {
  return {
    id: null,
    title: "",
    handle: "",
    seoTitle: "",
    seoDescription: "",
    vendor: "",
    productType: "",
    status: "DRAFT",
    tags: "Sportnahrung, 7prozent, Versandkosten",
    descriptionHtml: "",
    images: [],
    optionName: "Geschmack",
    meta: {
      bezeichnung: "", inhalt: "", gewicht: "", grundpreis: "", zutaten: "", n_hrwerte: "", allergiehinweis: "",
      zusatzinformationen: "", eigenschaften: "", hinweistext: "", herstellerinformation: "", rabatt: "",
      export_repricer: "1", google_shopping_de: "true", google_shopping_at: "true", idealo: "true",
      google_product_category: "", idealo_category: "", google_custom_label_0: "", google_custom_label_1: "kein", google_custom_label_2: "", hersteller: "",
    },
    variants: [emptyVariant()],
  };
}

const gqlFor = (admin) => async (query, variables) => {
  const r = await admin.graphql(query, { variables });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
};

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const storeHandle = session.shop.replace(".myshopify.com", "");
  const catalog = await getCatalog(gqlFor(admin));
  const isNew = params.id === "neu";

  if (isNew) {
    const from = url.searchParams.get("from");
    const kategorie = url.searchParams.get("kategorie");
    const suche = (url.searchParams.get("suche") || "").trim();

    // Startbildschirm: Vorlage suchen
    if (!from && !kategorie && url.searchParams.get("leer") !== "1") {
      let results = [];
      if (suche) {
        const r = await admin.graphql(
          `query ($q: String) { products(first: 12, query: $q, sortKey: UPDATED_AT, reverse: true) { nodes { id title vendor status featuredMedia { preview { image { url } } } variantsCount { count } } } }`,
          { variables: { q: `title:*${suche.replace(/["\\:()]/g, " ")}* OR sku:${suche.replace(/["\\:()]/g, " ")}*` } },
        );
        results = (await r.json()).data.products.nodes;
      }
      return json({ mode: "start", catalog, results, suche, storeHandle });
    }

    let product = emptyProduct();
    let media = [];
    let origin = null;
    if (from) {
      const src = await loadProduct(admin, gidOf(from));
      if (src) {
        const p = src.product;
        origin = p.title;
        product = {
          ...product,
          title: p.title,
          vendor: p.vendor,
          productType: p.productType,
          tags: p.tags,
          descriptionHtml: p.descriptionHtml,
          optionName: p.optionName,
          meta: { ...product.meta, ...p.meta, google_custom_label_1: "kein" },
          variants: p.variants.map((v) =>
            emptyVariant({
              option: v.title === "Default Title" ? "" : v.title,
              price: v.price,
              cost: v.cost,
              compareAtPrice: v.compareAtPrice,
              meta: {
                ...emptyVariant().meta,
                omnia_min: v.meta.omnia_min,
                omnia_max: v.meta.omnia_max,
                google_unit_pricing_measure: v.meta.google_unit_pricing_measure,
                google_unit_pricing_base_measure: v.meta.google_unit_pricing_base_measure,
              },
            }),
          ),
        };
        media = p.images.map((i, n) => ({ key: `c-${n}`, url: i.url, kind: "new", resourceUrl: i.url }));
      }
    }
    if (kategorie) {
      const cat = catalog.categories.find((c) => c.tag === kategorie);
      if (cat) {
        const tags = new Set(String(product.tags).split(",").map((t) => t.trim()).filter(Boolean));
        [...TAX_TAGS, ...SHIPPING_TAGS].forEach((t) => tags.delete(t));
        tagsForCategory(catalog, cat.tag).forEach((t) => tags.add(t));
        tags.add(cat.defaults.taxTag || "7prozent");
        tags.add(cat.defaults.shippingTag || "Versandkosten");
        product.tags = [...tags].join(", ");
        product.meta.google_product_category = cat.defaults.googleCategory || "";
        product.meta.idealo_category = cat.defaults.idealoCategory || "";
        origin = origin || `Kategorie ${cat.title}`;
      }
    }
    const s = seoSuggestion(product.title, product.vendor);
    product = { ...product, handle: s.handle, seoTitle: s.seoTitle, seoDescription: s.seoDescription };
    return json({ mode: "edit", isNew: true, product, media, catalog, history: [], storeHandle, origin, seoSync: true });
  }

  const loaded = await loadProduct(admin, gidOf(params.id));
  if (!loaded) throw new Response("Produkt nicht gefunden", { status: 404 });
  let history = [];
  try {
    history = await prisma.repricerEvent.findMany({
      where: { productId: loaded.product.id, type: { in: ["updated", "clamped", "ek_block", "not_in_omnia", "data"] }, run: { dryRun: false } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  } catch {}
  const media = loaded.product.images.map((i) => ({ key: i.id, id: i.id, url: i.url, kind: "existing" }));
  return json({ mode: "edit", isNew: false, product: loaded.product, media, catalog, history, storeHandle, origin: null, seoSync: !loaded.product.seoTitle });
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const data = JSON.parse(form.get("data"));
  const locations = await loadLocations(admin);

  if (params.id === "neu") {
    const { id, errors } = await createProduct(admin, data, locations[0]?.id);
    if (!id) return json({ ok: false, errors });
    return redirect(`/app/produkte/${id.split("/").pop()}?angelegt=1${errors.length ? "&hinweise=" + encodeURIComponent(errors.join(" | ")) : ""}`);
  }
  const loaded = await loadProduct(admin, gidOf(params.id));
  const { errors } = await saveProduct(admin, { ...data, id: loaded.product.id }, loaded.product, locations[0]?.id);
  return json({ ok: errors.length === 0, errors, savedAt: Date.now() });
};

/* ---------- Startbildschirm „Neues Produkt“ ---------- */

function StartScreen({ catalog, results, suche }) {
  const navigate = useNavigate();
  const [q, setQ] = useState(suche);
  const [cat, setCat] = useState("");
  const catOptions = [
    { label: "Kategorie wählen …", value: "" },
    ...catalog.categories.map((c) => ({ label: c.parentTag ? `${c.parentTag} › ${c.title}` : c.title, value: c.tag })),
  ];
  return (
    <Page backAction={{ content: "Produkte", onAction: () => navigate("/app/produkte") }} title="Neues Produkt" subtitle="Wie möchtest du starten?">
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center"><Icon source={DuplicateIcon} tone="base" /><Text as="h2" variant="headingMd">Ähnliches Produkt kopieren</Text></InlineStack>
              <Text as="p" tone="subdued">Texte, Sorten, Preise, Kategorie und Bilder übernehmen – nur Titel, SKU und EAN anpassen. SEO und URL werden aus dem Titel erzeugt.</Text>
              <TextField label="Produkt suchen" labelHidden placeholder="Titel oder SKU …" value={q} onChange={setQ} prefix={<Icon source={SearchIcon} />} autoComplete="off"
                connectedRight={<Button onClick={() => navigate(`/app/produkte/neu?suche=${encodeURIComponent(q)}`)}>Suchen</Button>} />
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">In einer Kategorie anlegen</Text>
              <Text as="p" tone="subdued">Kategorie-Tags, MwSt, Versand sowie Google- und idealo-Kategorie werden passend vorbelegt.</Text>
              <Select label="Kategorie" labelHidden options={catOptions} value={cat} onChange={setCat} />
              <InlineStack><Button variant="primary" disabled={!cat} onClick={() => navigate(`/app/produkte/neu?kategorie=${encodeURIComponent(cat)}`)}>Weiter</Button></InlineStack>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Leeres Produkt</Text>
              <Text as="p" tone="subdued">Alles selbst eintragen. Standard: Sportnahrung, 7 % MwSt, Versandkosten, Export an Omnia, Google und idealo.</Text>
              <InlineStack><Button onClick={() => navigate("/app/produkte/neu?leer=1")}>Leer starten</Button></InlineStack>
            </BlockStack>
          </Card>
        </InlineGrid>
        {suche && (
          <Card padding="0">
            <Box padding="400"><Text as="h2" variant="headingMd">{results.length ? `Treffer für „${suche}“` : `Keine Treffer für „${suche}“`}</Text></Box>
            {results.map((r) => (
              <Box key={r.id} paddingInline="400" paddingBlock="300" borderBlockStartWidth="025" borderColor="border-secondary">
                <InlineStack align="space-between" blockAlign="center" wrap={false} gap="300">
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <div style={{ width: 44, height: 44, borderRadius: 8, overflow: "hidden", background: "var(--p-color-bg-surface-secondary)", flexShrink: 0 }}>
                      {r.featuredMedia?.preview?.image?.url && <img src={r.featuredMedia.preview.image.url} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />}
                    </div>
                    <BlockStack gap="050">
                      <Text as="span" fontWeight="semibold">{r.title}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">{r.vendor} · {r.variantsCount?.count} Sorten</Text>
                    </BlockStack>
                  </InlineStack>
                  <Button onClick={() => navigate(`/app/produkte/neu?from=${r.id.split("/").pop()}`)}>Als Vorlage nehmen</Button>
                </InlineStack>
              </Box>
            ))}
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

/* ---------- Bausteine ---------- */

const LEVEL = {
  critical: { icon: AlertCircleIcon, tone: "critical" },
  warning: { icon: AlertTriangleIcon, tone: "caution" },
  info: { icon: InfoIcon, tone: "subdued" },
};
const HIST = {
  updated: { tone: "success", label: "Übernommen" },
  clamped: { tone: "attention", label: "Begrenzt" },
  ek_block: { tone: "critical", label: "EK-Sperre" },
  not_in_omnia: { tone: "warning", label: "Fehlt in Omnia" },
  data: { tone: "warning", label: "Datenfehler" },
};

function marginInfo(price, cost) {
  const p = num(price);
  const c = num(cost);
  if (!p || c === null) return null;
  const diff = p - c;
  return { diff, pct: (diff / p) * 100 };
}

const cellInput = { width: "100%", minWidth: 0, maxWidth: "100%", display: "block", border: "1px solid var(--p-color-border)", borderRadius: 8, padding: "6px 8px", font: "inherit", fontSize: 13, background: "var(--p-color-bg-surface)", boxSizing: "border-box" };

function Cell({ value, onChange, placeholder, align = "left", invalid, width }) {
  return (
    <input
      size={1}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...cellInput, textAlign: align, ...(width ? { width } : {}), borderColor: invalid ? "var(--p-color-border-critical)" : "var(--p-color-border)" }}
    />
  );
}

function VariantTable({ variants, isNew, optionName, setOptionName, onChange, onAdd, onRemove, onMore, onApplyFirst }) {
  const head = { fontSize: 12, color: "var(--p-color-text-secondary)", fontWeight: 600, padding: "0 4px 6px", textAlign: "left", whiteSpace: "nowrap" };
  const td = { padding: "6px 4px", verticalAlign: "middle", overflow: "hidden" };
  return (
    <BlockStack gap="300">
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 940, tableLayout: "fixed" }}>
          <colgroup>
            <col />
            <col style={{ width: 120 }} />
            <col style={{ width: 140 }} />
            <col style={{ width: 82 }} />
            <col style={{ width: 82 }} />
            <col style={{ width: 118 }} />
            <col style={{ width: 76 }} />
            <col style={{ width: 76 }} />
            <col style={{ width: 76 }} />
            <col style={{ width: 76 }} />
          </colgroup>
          <thead>
            <tr>
              <th style={head}>{optionName || "Sorte"}</th>
              <th style={head}>SKU</th>
              <th style={head}>EAN</th>
              <th style={{ ...head, textAlign: "right" }}>Preis €</th>
              <th style={{ ...head, textAlign: "right" }}>EK €</th>
              <th style={head}>Spanne</th>
              <th style={{ ...head, textAlign: "right" }}>Min €</th>
              <th style={{ ...head, textAlign: "right" }}>Max €</th>
              <th style={{ ...head, textAlign: "right" }}>Bestand</th>
              <th style={head} />
            </tr>
          </thead>
          <tbody>
            {variants.map((v, i) => {
              const m = marginInfo(v.price, v.cost);
              const min = num(v.meta.omnia_min);
              const max = num(v.meta.omnia_max);
              const set = (k) => (val) => onChange(i, { ...v, [k]: val });
              const setMeta = (k) => (val) => onChange(i, { ...v, meta: { ...v.meta, [k]: val } });
              return (
                <tr key={v.id || `n${i}`} style={{ borderTop: "1px solid var(--p-color-border-secondary)" }}>
                  <td style={{ ...td }}>
                    {v.id ? (
                      <Text as="span" fontWeight="semibold">{v.title === "Default Title" ? "Standard" : v.title}</Text>
                    ) : (
                      <Cell value={v.option} onChange={set("option")} placeholder="z. B. Schoko" />
                    )}
                  </td>
                  <td style={{ ...td }}><Cell value={v.sku} onChange={set("sku")} invalid={!v.sku} /></td>
                  <td style={{ ...td }}><Cell value={v.barcode} onChange={set("barcode")} invalid={v.barcode && !/^\d{8,14}$/.test(v.barcode.trim())} /></td>
                  <td style={{ ...td }}><Cell value={v.price} onChange={set("price")} align="right" invalid={!num(v.price)} /></td>
                  <td style={{ ...td }}><Cell value={v.cost} onChange={set("cost")} align="right" /></td>
                  <td style={{ ...td }}>
                    {m ? (
                      <span style={{
                        display: "inline-block", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600, padding: "3px 8px", borderRadius: 999,
                        background: m.diff < 0 ? "var(--p-color-bg-fill-critical-secondary)" : m.pct < 10 ? "var(--p-color-bg-fill-caution-secondary)" : "var(--p-color-bg-fill-success-secondary)",
                        color: m.diff < 0 ? "var(--p-color-text-critical)" : m.pct < 10 ? "var(--p-color-text-caution)" : "var(--p-color-text-success)",
                      }}>{`${m.diff.toFixed(2).replace(".", ",")} € · ${m.pct.toFixed(0)} %`}</span>
                    ) : <Text as="span" tone="subdued">–</Text>}
                  </td>
                  <td style={{ ...td }}><Cell value={v.meta.omnia_min} onChange={setMeta("omnia_min")} align="right" invalid={min !== null && max !== null && min > max} /></td>
                  <td style={{ ...td }}><Cell value={v.meta.omnia_max} onChange={setMeta("omnia_max")} align="right" invalid={min !== null && max !== null && min > max} /></td>
                  <td style={{ ...td }}><Cell value={v.stock} onChange={set("stock")} align="right" /></td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <Tooltip content="Weitere Felder"><Button size="slim" variant="tertiary" icon={EditIcon} onClick={() => onMore(i)} accessibilityLabel="Weitere Felder" /></Tooltip>
                    {variants.length > 1 && (
                      <Tooltip content="Sorte entfernen"><Button size="slim" variant="tertiary" tone="critical" icon={DeleteIcon} onClick={() => onRemove(i)} accessibilityLabel="Entfernen" /></Tooltip>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <InlineStack align="space-between" blockAlign="center" gap="200">
        <InlineStack gap="200">
          <Button icon={PlusIcon} onClick={onAdd}>Sorte hinzufügen</Button>
          {variants.length > 1 && <Button variant="tertiary" onClick={onApplyFirst}>Preis, EK und Min/Max der ersten Zeile für alle übernehmen</Button>}
        </InlineStack>
        {isNew && (
          <div style={{ width: 220 }}>
            <TextField label="Name der Option" labelHidden prefix="Option:" value={optionName} onChange={setOptionName} autoComplete="off" />
          </div>
        )}
      </InlineStack>
    </BlockStack>
  );
}

function CategoryPicker({ catalog, tags, onChange }) {
  const [input, setInput] = useState("");
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  const selected = catalog.categories.filter((c) => tagSet.has(c.tag.toLowerCase()));
  // Nur die tiefste Ebene anzeigen (Eltern sind implizit)
  const shown = selected.filter((c) => !selected.some((o) => o !== c && o.parentTag === c.tag));
  const options = catalog.categories
    .filter((c) => !tagSet.has(c.tag.toLowerCase()))
    .filter((c) => !input || `${c.parentTag || ""} ${c.title}`.toLowerCase().includes(input.toLowerCase()))
    .slice(0, 40);

  const add = (tag) => {
    const next = new Set(tags);
    tagsForCategory(catalog, tag).forEach((t) => next.add(t));
    onChange([...next], catalog.categories.find((c) => c.tag === tag));
    setInput("");
  };
  const remove = (cat) => {
    const keep = shown.filter((c) => c !== cat);
    const needed = new Set(keep.flatMap((c) => tagsForCategory(catalog, c.tag)).map((t) => t.toLowerCase()));
    const own = tagsForCategory(catalog, cat.tag).map((t) => t.toLowerCase());
    onChange(tags.filter((t) => !own.includes(t.toLowerCase()) || needed.has(t.toLowerCase())));
  };

  return (
    <BlockStack gap="200">
      <Combobox
        activator={<Combobox.TextField prefix={<Icon source={SearchIcon} />} label="Kategorien" value={input} onChange={setInput} placeholder="Kategorie suchen …" autoComplete="off" />}
      >
        {options.length > 0 ? (
          <Listbox onSelect={add}>
            {options.map((c) => (
              <Listbox.Option key={c.tag} value={c.tag}>
                <Listbox.TextOption>{c.parentTag ? `${c.parentTag} › ${c.title}` : c.title}</Listbox.TextOption>
              </Listbox.Option>
            ))}
          </Listbox>
        ) : null}
      </Combobox>
      <InlineStack gap="150">
        {shown.map((c) => (
          <Tag key={c.tag} onRemove={() => remove(c)}>{c.parentTag ? `${c.parentTag} › ${c.title}` : c.title}</Tag>
        ))}
        {!shown.length && <Text as="span" tone="subdued" variant="bodySm">Noch keine Kategorie gewählt.</Text>}
      </InlineStack>
    </BlockStack>
  );
}

function GooglePreview({ title, description, handle }) {
  return (
    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">sportnahrung-kwax.de › products › {handle || "…"}</Text>
        <span style={{ color: "#1a0dab", fontSize: 17, lineHeight: 1.3 }}>{title || "Titel"}</span>
        <Text as="span" variant="bodySm">{description || "Beschreibung"}</Text>
      </BlockStack>
    </Box>
  );
}

const TEXT_TABS = [
  { id: "inhalt", content: "Inhalt & Zutaten", fields: [["bezeichnung", "Bezeichnung (Sachbezeichnung)", "html"], ["inhalt", "Inhalt", "html"], ["zutaten", "Zutaten", "html"]], plain: [["gewicht", "Gewicht"], ["grundpreis", "Grundpreis-Text"]] },
  { id: "naehr", content: "Nährwerte & Allergene", fields: [["n_hrwerte", "Nährwerte", "html"], ["allergiehinweis", "Allergiehinweis", "html"]] },
  { id: "verzehr", content: "Verzehr & Hinweise", fields: [["zusatzinformationen", "Verzehrempfehlung", "html"], ["hinweistext", "Hinweistext", "html"]], plain: [["eigenschaften", "Eigenschaften (z. B. Vegan, Glutenfrei)"]] },
  { id: "marketing", content: "Marketing", fields: [["rabatt", "Marketing-Beschreibung", "html"]] },
];

/* ---------- Editor ---------- */

function Editor() {
  const { isNew, product: initial, media: initialMedia, catalog, history, storeHandle, origin, seoSync: initialSeoSync } = useLoaderData();
  const actionData = useActionData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const nav = useNavigation();
  const [p, setP] = useState(initial);
  const [media, setMedia] = useState(initialMedia);
  const [dirty, setDirty] = useState(isNew);
  const [seoSync, setSeoSync] = useState(initialSeoSync);
  const [tab, setTab] = useState(0);
  const [moreIndex, setMoreIndex] = useState(null);
  const [newVendor, setNewVendor] = useState(false);
  const [gpsrEdit, setGpsrEdit] = useState(false);
  const saving = nav.state === "submitting";

  useEffect(() => {
    setP(initial);
    setMedia(initialMedia);
    setDirty(isNew);
    setSeoSync(initialSeoSync);
  }, [initial, initialMedia, isNew, initialSeoSync]);

  const update = useCallback((patch) => { setP((cur) => ({ ...cur, ...patch })); setDirty(true); }, []);
  const setMeta = (k) => (v) => update({ meta: { ...p.meta, [k]: typeof v === "boolean" ? String(v) : v } });
  const setMediaDirty = (fn) => { setMedia(fn); setDirty(true); };

  // SEO/URL automatisch aus Titel
  const setTitle = (title) => {
    if (seoSync) {
      const s = seoSuggestion(title, p.vendor);
      update({ title, handle: isNew ? s.handle : p.handle, seoTitle: s.seoTitle, seoDescription: s.seoDescription });
    } else update({ title });
  };

  const tags = useMemo(() => String(p.tags || "").split(",").map((t) => t.trim()).filter(Boolean), [p.tags]);
  const setTags = (list) => update({ tags: [...new Set(list)].join(", ") });
  const hasTag = (t) => tags.some((x) => x.toLowerCase() === t.toLowerCase());
  const catTags = new Set(catalog.categories.map((c) => c.tag.toLowerCase()));
  const topTags = new Set(catalog.categories.map((c) => c.topTag).filter(Boolean).map((t) => t.toLowerCase()));
  const fixedTags = new Set([...TAX_TAGS, ...SHIPPING_TAGS, ...SPECIAL_TAGS.map((s) => s.tag)].map((t) => t.toLowerCase()));
  const otherTags = tags.filter((t) => !catTags.has(t.toLowerCase()) && !topTags.has(t.toLowerCase()) && !fixedTags.has(t.toLowerCase()));

  const vendorInfo = catalog.vendors.find((v) => v.name === p.vendor);
  const chooseVendor = (name) => {
    if (name === "__neu") { setNewVendor(true); update({ vendor: "" }); return; }
    const v = catalog.vendors.find((x) => x.name === name);
    const oldDefault = vendorInfo?.gpsr || "";
    const gpsr = !p.meta.herstellerinformation || p.meta.herstellerinformation === oldDefault ? v?.gpsr || p.meta.herstellerinformation : p.meta.herstellerinformation;
    const s = seoSync ? seoSuggestion(p.title, name) : null;
    update({ vendor: name, meta: { ...p.meta, hersteller: v?.herstellerRef || "", herstellerinformation: gpsr || "" }, ...(s ? { seoDescription: s.seoDescription } : {}) });
  };

  const gpsrOptions = [
    { label: "Herstellerangabe wählen …", value: "" },
    ...catalog.gpsr.map((g, i) => ({ label: `${g.label}${g.count > 1 ? ` (${g.count})` : ""}`, value: String(i) })),
    { label: "Eigene Angabe …", value: "eigen" },
  ];
  const gpsrIndex = catalog.gpsr.findIndex((g) => g.html === p.meta.herstellerinformation);
  const gpsrValue = gpsrIndex >= 0 ? String(gpsrIndex) : p.meta.herstellerinformation ? "eigen" : "";

  const labels = computeLabels(p.variants, p.meta);
  const issues = useMemo(() => checkProduct({ ...p, images: media }), [p, media]);
  const critical = issues.filter((x) => x.level === "critical").length;
  const uploading = media.some((m) => m.uploading);

  const setVariant = (i, v) => update({ variants: p.variants.map((x, j) => (j === i ? v : x)) });
  const addVariant = () => {
    const first = p.variants[0];
    update({ variants: [...p.variants, emptyVariant({ price: first?.price || "", cost: first?.cost || "", meta: { ...emptyVariant().meta, omnia_min: first?.meta.omnia_min || "", omnia_max: first?.meta.omnia_max || "", google_unit_pricing_measure: first?.meta.google_unit_pricing_measure || "", google_unit_pricing_base_measure: first?.meta.google_unit_pricing_base_measure || "" } })] });
  };
  const removeVariant = (i) => {
    const v = p.variants[i];
    if (v.id && !window.confirm(`Sorte „${v.title}“ beim Speichern wirklich löschen?`)) return;
    update({ variants: p.variants.filter((_, j) => j !== i) });
  };
  const applyFirst = () => {
    const f = p.variants[0];
    update({ variants: p.variants.map((v, i) => (i === 0 ? v : { ...v, price: f.price, cost: f.cost, meta: { ...v.meta, omnia_min: f.meta.omnia_min, omnia_max: f.meta.omnia_max } })) });
  };

  const save = () => {
    submit({ data: JSON.stringify({ ...p, meta: { ...p.meta, ...labels }, media }) }, { method: "post" });
    setDirty(false);
  };
  const discard = () => { setP(initial); setMedia(initialMedia); setDirty(false); };

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const created = params.get("angelegt") === "1";
  const createHints = params.get("hinweise");
  const mv = moreIndex !== null ? p.variants[moreIndex] : null;

  return (
    <Page
      backAction={{ content: "Produkte", onAction: () => navigate("/app/produkte") }}
      title={isNew ? "Neues Produkt" : p.title}
      subtitle={isNew && origin ? `Vorlage: ${origin}` : !isNew ? p.vendor : undefined}
      titleMetadata={!isNew && <Badge tone={p.status === "ACTIVE" ? "success" : p.status === "DRAFT" ? "info" : undefined}>{p.status === "ACTIVE" ? "Aktiv" : p.status === "DRAFT" ? "Entwurf" : "Archiviert"}</Badge>}
    >
      <SaveBar id="produkt-savebar" open={dirty}>
        <button variant="primary" onClick={save} loading={saving ? "" : undefined} disabled={uploading}>{isNew ? "Produkt anlegen" : "Speichern"}</button>
        {!isNew && <button onClick={discard}>Verwerfen</button>}
      </SaveBar>

      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200">
            {!isNew && <Button icon={DuplicateIcon} onClick={() => navigate(`/app/produkte/neu?from=${p.id.split("/").pop()}`)}>Duplizieren</Button>}
            {!isNew && <Button onClick={() => window.open(`https://admin.shopify.com/store/${storeHandle}/products/${p.id.split("/").pop()}`, "_top")}>In Shopify öffnen</Button>}
            {!isNew && p.onlineStoreUrl && <Button url={p.onlineStoreUrl} external>Im Shop ansehen</Button>}
          </InlineStack>
          <Button variant="primary" onClick={save} loading={saving} disabled={(!dirty && !isNew) || uploading}>{isNew ? "Produkt anlegen" : "Speichern"}</Button>
        </InlineStack>

        {created && (
          <Banner tone="success" title="Produkt angelegt">
            <p>Gespeichert als {p.status === "ACTIVE" ? "aktives Produkt" : "Entwurf"}. Zum Verkauf: Status auf „Aktiv“ und in Shopify die Kanäle Online Store und POS aktivieren.</p>
            {createHints && <p>Hinweise: {createHints}</p>}
          </Banner>
        )}
        {actionData?.errors?.length > 0 && (
          <Banner tone="critical" title="Nicht alles wurde gespeichert"><ul>{actionData.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Banner>
        )}
        {actionData?.ok && !dirty && <Banner tone="success" title="Gespeichert" />}

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Sorten, Preise & Omnia</Text>
              <Text as="span" variant="bodySm" tone="subdued">Preis = Google, idealo und Shop · Min/Max = Grenzen für Omnia</Text>
            </InlineStack>
            <VariantTable
              variants={p.variants}
              isNew={isNew}
              optionName={p.optionName}
              setOptionName={(v) => update({ optionName: v })}
              onChange={setVariant}
              onAdd={addVariant}
              onRemove={removeVariant}
              onMore={setMoreIndex}
              onApplyFirst={applyFirst}
            />
          </BlockStack>
        </Card>
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <TextField label="Titel" value={p.title} onChange={setTitle} autoComplete="off" helpText="Schema: Hersteller - Produkt - Größe/Packung, z. B. „ESN - Designer Whey - 1000g Beutel“" />
                  <RichTextEditor label="Beschreibung" value={p.descriptionHtml} onChange={(v) => update({ descriptionHtml: v })} minHeight={180} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Bilder</Text>
                  <ImageManager media={media} onChange={setMediaDirty} />
                </BlockStack>
              </Card>


              <Card padding="0">
                <Box padding="400" paddingBlockEnd="0"><Text as="h2" variant="headingMd">Produktinformationen</Text></Box>
                <Tabs tabs={TEXT_TABS.map((t) => ({ id: t.id, content: t.content }))} selected={tab} onSelect={setTab} />
                <Box padding="400">
                  <BlockStack gap="400">
                    {(TEXT_TABS[tab].plain || []).length > 0 && (
                      <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                        {TEXT_TABS[tab].plain.map(([k, label]) => (
                          <TextField key={k} label={label} value={p.meta[k] || ""} onChange={setMeta(k)} autoComplete="off" />
                        ))}
                      </InlineGrid>
                    )}
                    {TEXT_TABS[tab].fields.map(([k, label]) => (
                      <RichTextEditor key={`${tab}-${k}`} label={label} value={p.meta[k] || ""} onChange={setMeta(k)} minHeight={90} />
                    ))}
                  </BlockStack>
                </Box>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Suchmaschinen-Eintrag</Text>
                    <Checkbox label="Automatisch aus Titel" checked={seoSync} onChange={(c) => { setSeoSync(c); if (c) { const s = seoSuggestion(p.title, p.vendor); update({ seoTitle: s.seoTitle, seoDescription: s.seoDescription, ...(isNew ? { handle: s.handle } : {}) }); } }} />
                  </InlineStack>
                  <GooglePreview title={p.seoTitle || p.title} description={p.seoDescription} handle={p.handle} />
                  <TextField label="Seitentitel" value={p.seoTitle} onChange={(v) => { setSeoSync(false); update({ seoTitle: v }); }} showCharacterCount maxLength={70} autoComplete="off" />
                  <TextField label="Meta-Beschreibung" value={p.seoDescription} onChange={(v) => { setSeoSync(false); update({ seoDescription: v }); }} multiline={3} showCharacterCount maxLength={160} autoComplete="off" />
                  <TextField label="URL" prefix="/products/" value={p.handle} onChange={(v) => update({ handle: v.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} autoComplete="off" helpText={!isNew ? "Bei Änderung wird automatisch eine Weiterleitung von der alten URL angelegt." : undefined} />
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Status</Text>
                  <Select label="Status" labelHidden options={[{ label: "Entwurf", value: "DRAFT" }, { label: "Aktiv", value: "ACTIVE" }, { label: "Archiviert", value: "ARCHIVED" }]} value={p.status} onChange={(v) => update({ status: v })} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Hersteller & Kategorie</Text>
                  {!newVendor ? (
                    <Select
                      label="Hersteller"
                      options={[
                        { label: "Hersteller wählen …", value: "" },
                        ...catalog.vendors.map((v) => ({ label: `${v.name} (${v.count})`, value: v.name })),
                        ...(p.vendor && !vendorInfo ? [{ label: p.vendor, value: p.vendor }] : []),
                        { label: "+ Neuer Hersteller …", value: "__neu" },
                      ]}
                      value={p.vendor}
                      onChange={chooseVendor}
                    />
                  ) : (
                    <TextField label="Neuer Hersteller" value={p.vendor} onChange={(v) => update({ vendor: v })} autoComplete="off"
                      connectedRight={<Button onClick={() => setNewVendor(false)}>Liste</Button>} helpText="GPSR-Angabe unten bitte als „Eigene Angabe“ ergänzen." />
                  )}
                  <CategoryPicker
                    catalog={catalog}
                    tags={tags}
                    onChange={(list, cat) => {
                      const patch = { tags: [...new Set(list)].join(", ") };
                      if (cat) {
                        const m = { ...p.meta };
                        if (!m.google_product_category && cat.defaults.googleCategory) m.google_product_category = cat.defaults.googleCategory;
                        if (!m.idealo_category && cat.defaults.idealoCategory) m.idealo_category = cat.defaults.idealoCategory;
                        patch.meta = m;
                      }
                      update(patch);
                    }}
                  />
                  <Divider />
                  <InlineGrid columns={2} gap="300">
                    <ChoiceList title="MwSt" choices={[{ label: "7 %", value: "7prozent" }, { label: "19 %", value: "19prozent" }]} selected={TAX_TAGS.filter(hasTag)}
                      onChange={([v]) => setTags([...tags.filter((t) => !TAX_TAGS.includes(t)), v])} />
                    <ChoiceList title="Versand" choices={[{ label: "Versandkosten", value: "Versandkosten" }, { label: "Versandkostenfrei", value: "Versandkostenfrei" }]} selected={SHIPPING_TAGS.filter(hasTag)}
                      onChange={([v]) => setTags([...tags.filter((t) => !SHIPPING_TAGS.includes(t)), v])} />
                  </InlineGrid>
                  <ChoiceList
                    allowMultiple
                    title="Aktionen & Automatik"
                    choices={SPECIAL_TAGS.map((s) => ({ label: s.label, value: s.tag }))}
                    selected={SPECIAL_TAGS.map((s) => s.tag).filter(hasTag)}
                    onChange={(sel) => setTags([...tags.filter((t) => !SPECIAL_TAGS.some((s) => s.tag === t)), ...sel])}
                  />
                  <TextField label="Weitere Tags" value={otherTags.join(", ")} autoComplete="off"
                    onChange={(v) => setTags([...tags.filter((t) => !otherTags.includes(t)), ...v.split(",").map((x) => x.trim()).filter(Boolean)])} helpText="Mit Komma trennen" />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Herstellerangaben (GPSR)</Text>
                    {p.meta.herstellerinformation && <Button variant="plain" onClick={() => setGpsrEdit(!gpsrEdit)}>{gpsrEdit ? "Fertig" : "Bearbeiten"}</Button>}
                  </InlineStack>
                  <Select label="Vorlage" labelHidden options={gpsrOptions} value={gpsrValue}
                    onChange={(v) => { if (v === "eigen") { setGpsrEdit(true); return; } setGpsrEdit(false); setMeta("herstellerinformation")(v === "" ? "" : catalog.gpsr[Number(v)].html); }} />
                  {gpsrEdit ? (
                    <RichTextEditor value={p.meta.herstellerinformation} onChange={setMeta("herstellerinformation")} minHeight={100} />
                  ) : (
                    p.meta.herstellerinformation && <HtmlPreview html={p.meta.herstellerinformation} />
                  )}
                  {vendorInfo?.gpsr && p.meta.herstellerinformation !== vendorInfo.gpsr && (
                    <Button variant="plain" onClick={() => setMeta("herstellerinformation")(vendorInfo.gpsr)}>Standard für {p.vendor} übernehmen</Button>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Marktplätze & Preise</Text>
                  <Checkbox label="An Omnia (Repricer) übergeben" checked={p.meta.export_repricer === "1"} onChange={(c) => setMeta("export_repricer")(c ? "1" : "0")} />
                  <Checkbox label="Google Shopping DE" checked={p.meta.google_shopping_de === "true"} onChange={setMeta("google_shopping_de")} />
                  <Checkbox label="Google Shopping AT" checked={p.meta.google_shopping_at === "true"} onChange={setMeta("google_shopping_at")} />
                  <Checkbox label="idealo" checked={p.meta.idealo === "true"} onChange={setMeta("idealo")} />
                  <Select label="Google-Kategorie" options={[{ label: "–", value: "" }, ...catalog.googleCategories.map((c) => ({ label: c.split(" > ").slice(-2).join(" › "), value: c }))]} value={p.meta.google_product_category} onChange={setMeta("google_product_category")} />
                  <Select label="idealo-Kategorie" options={[{ label: "–", value: "" }, ...catalog.idealoCategories.map((c) => ({ label: c, value: c }))]} value={p.meta.idealo_category} onChange={setMeta("idealo_category")} />
                  <Divider />
                  <BlockStack gap="150">
                    <InlineStack align="space-between"><Text as="span" variant="bodySm">Label 0 · Rohertrag</Text><Badge>{labels.google_custom_label_0 || "–"}</Badge></InlineStack>
                    <InlineStack align="space-between"><Text as="span" variant="bodySm">Label 1 · Abverkauf</Text><Badge>{labels.google_custom_label_1 || "–"}</Badge></InlineStack>
                    <InlineStack align="space-between"><Text as="span" variant="bodySm">Label 2 · Preisklasse</Text><Badge>{labels.google_custom_label_2 || "–"}</Badge></InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">Werden automatisch aus Preis und EK berechnet (Rohertrag &lt; 9 € niedrig, &lt; 15 € mittel; Preis &lt; 10 € niedrig, &lt; 30 € mittel).</Text>
                  </BlockStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Produkt-Check</Text>
                    {issues.length === 0 ? <Badge tone="success">Vollständig</Badge> : critical ? <Badge tone="critical">{`${critical} kritisch`}</Badge> : <Badge tone="warning">{`${issues.length} Hinweise`}</Badge>}
                  </InlineStack>
                  {issues.length === 0 ? (
                    <InlineStack gap="200" blockAlign="center"><Icon source={CheckCircleIcon} tone="success" /><Text as="span">Bereit für Shop und Omnia.</Text></InlineStack>
                  ) : (
                    <BlockStack gap="200">
                      {issues.map((x, i) => (
                        <InlineStack key={i} gap="200" wrap={false} blockAlign="start">
                          <div style={{ flexShrink: 0 }}><Icon source={LEVEL[x.level].icon} tone={LEVEL[x.level].tone} /></div>
                          <Text as="span" variant="bodySm">{x.text}</Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {!isNew && (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Repricer-Verlauf</Text>
                    {!history.length && <Text tone="subdued" as="p">Noch keine Einträge.</Text>}
                    {history.map((h) => (
                      <BlockStack key={h.id} gap="050">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="span" variant="bodySm" tone="subdued">
                            {new Date(h.createdAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} · {h.sku}
                          </Text>
                          <Badge tone={HIST[h.type]?.tone}>{HIST[h.type]?.label}</Badge>
                        </InlineStack>
                        <Text as="span" variant="bodySm">{h.type === "updated" || h.type === "clamped" ? `${eur(h.oldPrice)} → ${eur(h.newPrice)} (Omnia ${eur(h.omniaPrice)})` : h.message}</Text>
                      </BlockStack>
                    ))}
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>

      <Modal
        open={mv !== null}
        onClose={() => setMoreIndex(null)}
        title={mv ? `Weitere Angaben · ${mv.id ? (mv.title === "Default Title" ? "Standard" : mv.title) : mv.option || "neue Sorte"}` : ""}
        primaryAction={{ content: "Fertig", onAction: () => setMoreIndex(null) }}
      >
        {mv && (
          <Modal.Section>
            <InlineGrid columns={2} gap="300">
              <TextField label="Omnia-ID" value={mv.meta.omnia} placeholder={mv.sku || "= SKU"} onChange={(v) => setVariant(moreIndex, { ...mv, meta: { ...mv.meta, omnia: v } })} autoComplete="off" helpText="Standard ist die SKU" />
              <TextField label="Streichpreis" suffix="€" value={mv.compareAtPrice} onChange={(v) => setVariant(moreIndex, { ...mv, compareAtPrice: v })} autoComplete="off" />
              <TextField label="Außenlager" type="number" value={String(mv.meta.aussenlager ?? "")} onChange={(v) => setVariant(moreIndex, { ...mv, meta: { ...mv.meta, aussenlager: v } })} autoComplete="off" />
              <TextField label="Meldebestand" type="number" value={String(mv.meta.melde ?? "")} onChange={(v) => setVariant(moreIndex, { ...mv, meta: { ...mv.meta, melde: v } })} autoComplete="off" />
              <TextField label="Grundpreis-Menge" placeholder="z. B. 1000 g" value={mv.meta.google_unit_pricing_measure} onChange={(v) => setVariant(moreIndex, { ...mv, meta: { ...mv.meta, google_unit_pricing_measure: v } })} autoComplete="off" />
              <TextField label="Grundpreis-Bezug" placeholder="z. B. 1 kg" value={mv.meta.google_unit_pricing_base_measure} onChange={(v) => setVariant(moreIndex, { ...mv, meta: { ...mv.meta, google_unit_pricing_base_measure: v } })} autoComplete="off" />
            </InlineGrid>
            {mv.id && num(mv.shopPrice) !== null && (
              <Box paddingBlockStart="300"><Text as="p" variant="bodySm" tone="subdued">Aktueller Shop-Preis: {eur(mv.shopPrice)}</Text></Box>
            )}
          </Modal.Section>
        )}
      </Modal>
    </Page>
  );
}

export default function ProduktSeite() {
  const data = useLoaderData();
  if (data.mode === "start") return <StartScreen catalog={data.catalog} results={data.results} suche={data.suche} />;
  return <Editor />;
}
