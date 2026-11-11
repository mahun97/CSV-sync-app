import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigate, useNavigation, useSubmit } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
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
  Badge,
  Banner,
  Button,
  Box,
  Divider,
  Thumbnail,
  Icon,
} from "@shopify/polaris";
import { AlertCircleIcon, AlertTriangleIcon, InfoIcon, CheckCircleIcon, DeleteIcon, PlusIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PRODUCT_TEXT_FIELDS, PRODUCT_EXPORT_FIELDS, VARIANT_METAFIELDS, checkProduct, num } from "../lib/productFields";
import { loadProduct, loadLocations, saveProduct, createProduct } from "../lib/products.server";

const gidOf = (id) => `gid://shopify/Product/${id}`;

const emptyVariant = () => ({
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
});

function emptyProduct() {
  return {
    id: null,
    title: "",
    vendor: "",
    productType: "",
    status: "DRAFT",
    tags: "",
    descriptionHtml: "",
    images: [],
    optionName: "Geschmack",
    meta: {
      ...Object.fromEntries(PRODUCT_TEXT_FIELDS.map((f) => [f.key, ""])),
      export_repricer: "1",
      google_shopping_de: "true",
      google_shopping_at: "true",
      idealo: "true",
      google_product_category: "",
      idealo_category: "",
      google_custom_label_0: "",
      google_custom_label_1: "",
      google_custom_label_2: "",
    },
    variants: [emptyVariant()],
  };
}

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const isNew = params.id === "neu";
  const storeHandle = session.shop.replace(".myshopify.com", "");

  if (isNew) {
    const locations = await loadLocations(admin);
    let product = emptyProduct();
    const from = url.searchParams.get("from");
    if (from) {
      const src = await loadProduct(admin, gidOf(from));
      if (src) {
        const p = src.product;
        product = {
          ...product,
          title: `${p.title} (Kopie)`,
          vendor: p.vendor,
          productType: p.productType,
          tags: p.tags,
          descriptionHtml: p.descriptionHtml,
          optionName: p.options?.[0]?.name !== "Title" ? p.options?.[0]?.name || "Geschmack" : "Geschmack",
          meta: { ...product.meta, ...p.meta },
          variants: p.variants.map((v) => ({
            ...emptyVariant(),
            option: v.title === "Default Title" ? "" : v.title,
            price: v.price,
            cost: v.cost,
            meta: { ...emptyVariant().meta, omnia_min: v.meta.omnia_min, omnia_max: v.meta.omnia_max, google_unit_pricing_measure: v.meta.google_unit_pricing_measure, google_unit_pricing_base_measure: v.meta.google_unit_pricing_base_measure },
          })),
        };
      }
    }
    return json({ isNew, product, locations, history: [], storeHandle });
  }

  const loaded = await loadProduct(admin, gidOf(params.id));
  if (!loaded) throw new Response("Produkt nicht gefunden", { status: 404 });

  let history = [];
  try {
    history = await prisma.repricerEvent.findMany({
      where: { productId: loaded.product.id, type: { in: ["updated", "clamped", "ek_block", "not_in_omnia", "data"] }, run: { dryRun: false } },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
  } catch {}

  return json({ isNew, product: loaded.product, locations: loaded.locations, history, storeHandle });
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const data = JSON.parse(form.get("data"));

  if (params.id === "neu") {
    const locations = await loadLocations(admin);
    const { id, errors } = await createProduct(admin, data, locations[0]?.id);
    if (!id) return json({ ok: false, errors });
    return redirect(`/app/produkte/${id.split("/").pop()}?angelegt=1${errors.length ? "&hinweise=" + encodeURIComponent(errors.join(" | ")) : ""}`);
  }

  const loaded = await loadProduct(admin, gidOf(params.id));
  const { errors } = await saveProduct(admin, { ...data, id: loaded.product.id }, loaded.product);
  return json({ ok: errors.length === 0, errors, savedAt: Date.now() });
};

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
const eur = (v) => (v === null || v === undefined || v === "" ? "–" : `${Number(v).toFixed(2).replace(".", ",")} €`);

function Margin({ price, cost }) {
  const p = num(price);
  const c = num(cost);
  if (!p || !c) return <Text as="span" tone="subdued" variant="bodySm">Spanne –</Text>;
  const diff = p - c;
  const pct = (diff / p) * 100;
  const tone = diff < 0 ? "critical" : pct < 10 ? "caution" : "success";
  return (
    <Badge tone={tone === "success" ? "success" : tone === "critical" ? "critical" : "warning"}>
      {`Spanne ${diff.toFixed(2).replace(".", ",")} € · ${pct.toFixed(0)} %`}
    </Badge>
  );
}

function VariantCard({ v, index, isNew, onChange, onRemove, canRemove, optionName }) {
  const set = (k) => (val) => onChange({ ...v, [k]: val });
  const setMeta = (k) => (val) => onChange({ ...v, meta: { ...v.meta, [k]: val } });
  const min = num(v.meta.omnia_min);
  const max = num(v.meta.omnia_max);
  const rangeError = min !== null && max !== null && min > max ? "Min liegt über Max" : undefined;
  return (
    <Box padding="400" background="bg-surface-secondary" borderRadius="300">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="headingSm">
              {isNew ? `Variante ${index + 1}` : v.title === "Default Title" ? "Standard" : v.title}
            </Text>
            <Margin price={v.price} cost={v.cost} />
            {!isNew && num(v.shopPrice) !== null && Math.abs(num(v.shopPrice) - (num(v.price) || 0)) > 0.004 && (
              <Badge tone="info">{`Shop aktuell ${eur(v.shopPrice)}`}</Badge>
            )}
          </InlineStack>
          {isNew && canRemove && <Button icon={DeleteIcon} variant="tertiary" tone="critical" onClick={onRemove} accessibilityLabel="Variante entfernen" />}
        </InlineStack>
        <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
          {isNew && <TextField label={optionName || "Variante"} value={v.option} onChange={set("option")} placeholder="z. B. Schoko" autoComplete="off" />}
          <TextField label="SKU / Artikelnummer" value={v.sku} onChange={set("sku")} autoComplete="off" />
          <TextField label="EAN" value={v.barcode} onChange={set("barcode")} autoComplete="off" error={!v.barcode ? undefined : !/^\d{8,14}$/.test(v.barcode.trim()) ? "Ungültige EAN" : undefined} />
          <TextField label="Verkaufspreis (brutto)" value={String(v.price ?? "")} onChange={set("price")} suffix="€" autoComplete="off" helpText="Google/idealo/Shop" />
          <TextField label="Streichpreis" value={String(v.compareAtPrice ?? "")} onChange={set("compareAtPrice")} suffix="€" autoComplete="off" />
          <TextField label="EK (Kosten pro Artikel)" value={String(v.cost ?? "")} onChange={set("cost")} suffix="€" autoComplete="off" />
          <TextField label="Omnia Min" value={v.meta.omnia_min} onChange={setMeta("omnia_min")} suffix="€" autoComplete="off" error={rangeError} />
          <TextField label="Omnia Max" value={v.meta.omnia_max} onChange={setMeta("omnia_max")} suffix="€" autoComplete="off" />
          <TextField label="Omnia-ID" value={v.meta.omnia} onChange={setMeta("omnia")} autoComplete="off" placeholder={isNew ? "= SKU" : ""} />
          <TextField label={`Bestand${v.stockLocationName ? ` (${v.stockLocationName})` : ""}`} type="number" value={String(v.stock ?? "")} onChange={set("stock")} autoComplete="off" />
          <TextField label="Außenlager" type="number" value={String(v.meta.aussenlager ?? "")} onChange={setMeta("aussenlager")} autoComplete="off" />
          <TextField label="Meldebestand" type="number" value={String(v.meta.melde ?? "")} onChange={setMeta("melde")} autoComplete="off" />
          <TextField label="Grundpreis-Menge" value={v.meta.google_unit_pricing_measure} onChange={setMeta("google_unit_pricing_measure")} placeholder="z. B. 1000 g" autoComplete="off" />
          <TextField label="Grundpreis-Bezug" value={v.meta.google_unit_pricing_base_measure} onChange={setMeta("google_unit_pricing_base_measure")} placeholder="z. B. 1 kg" autoComplete="off" />
        </InlineGrid>
      </BlockStack>
    </Box>
  );
}

export default function ProduktEditor() {
  const { isNew, product: initial, history, storeHandle } = useLoaderData();
  const actionData = useActionData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const nav = useNavigation();
  const [p, setP] = useState(initial);
  const [imageUrl, setImageUrl] = useState("");
  const [newImages, setNewImages] = useState([]);
  const [dirty, setDirty] = useState(false);
  const saving = nav.state === "submitting";

  useEffect(() => {
    setP(initial);
    setNewImages([]);
    setDirty(false);
  }, [initial]);

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const created = params.get("angelegt") === "1";
  const createHints = params.get("hinweise");

  const update = (patch) => { setP((cur) => ({ ...cur, ...patch })); setDirty(true); };
  const setField = (k) => (v) => update({ [k]: v });
  const setMeta = (k) => (v) => update({ meta: { ...p.meta, [k]: typeof v === "boolean" ? String(v) : v } });
  const setVariant = (i) => (v) => update({ variants: p.variants.map((x, j) => (j === i ? v : x)) });

  const issues = useMemo(() => checkProduct({ ...p, images: [...p.images, ...newImages] }), [p, newImages]);
  const critical = issues.filter((x) => x.level === "critical").length;

  const save = () => {
    const payload = { ...p, newImages };
    submit({ data: JSON.stringify(payload) }, { method: "post" });
    setDirty(false);
  };

  const openInShopify = () => {
    if (!p.id) return;
    window.open(`https://admin.shopify.com/store/${storeHandle}/products/${p.id.split("/").pop()}`, "_top");
  };

  return (
    <Page
      backAction={{ content: "Produkte", onAction: () => navigate("/app/produkte") }}
      title={isNew ? "Neues Produkt" : p.title || "Produkt"}
      titleMetadata={!isNew && <Badge tone={p.status === "ACTIVE" ? "success" : p.status === "DRAFT" ? "info" : undefined}>{p.status === "ACTIVE" ? "Aktiv" : p.status === "DRAFT" ? "Entwurf" : "Archiviert"}</Badge>}
    >
      <BlockStack gap="400">
        <InlineStack gap="200" align="end">
          {!isNew && <Button onClick={() => navigate(`/app/produkte/neu?from=${p.id.split("/").pop()}`)}>Als Vorlage für neues Produkt</Button>}
          {!isNew && <Button onClick={openInShopify}>In Shopify öffnen</Button>}
          <Button variant="primary" loading={saving} disabled={!isNew && !dirty && !newImages.length} onClick={save}>
            {isNew ? "Produkt anlegen" : "Speichern"}
          </Button>
        </InlineStack>
        {created && (
          <Banner tone="success" title="Produkt angelegt">
            <p>Das Produkt ist als Entwurf gespeichert. Zum Veröffentlichen Status auf „Aktiv“ setzen und in Shopify die Vertriebskanäle (Online Store, POS) auswählen.</p>
            {createHints && <p>Hinweise: {createHints}</p>}
          </Banner>
        )}
        {actionData?.errors?.length > 0 && (
          <Banner tone="critical" title="Nicht alles wurde gespeichert">
            <ul>{actionData.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </Banner>
        )}
        {actionData?.ok && !dirty && <Banner tone="success" title="Gespeichert" onDismiss={() => {}} />}

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Stammdaten</Text>
                  <TextField label="Titel" value={p.title} onChange={setField("title")} autoComplete="off" helpText="Schema: Hersteller - Produkt - Größe, z. B. „ESN - Designer Whey - 1000g Beutel“" />
                  <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                    <TextField label="Hersteller" value={p.vendor} onChange={setField("vendor")} autoComplete="off" />
                    <TextField label="Produkttyp" value={p.productType} onChange={setField("productType")} autoComplete="off" />
                    <Select
                      label="Status"
                      options={[{ label: "Entwurf", value: "DRAFT" }, { label: "Aktiv", value: "ACTIVE" }, { label: "Archiviert", value: "ARCHIVED" }]}
                      value={p.status}
                      onChange={setField("status")}
                    />
                  </InlineGrid>
                  <TextField label="Tags" value={p.tags} onChange={setField("tags")} autoComplete="off" helpText="Mit Komma trennen, z. B. Versandkosten, Vegan" />
                  <TextField label="Beschreibung (HTML)" value={p.descriptionHtml} onChange={setField("descriptionHtml")} multiline={6} autoComplete="off" />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Varianten, Preise & Omnia</Text>
                    {isNew && (
                      <InlineStack gap="200" blockAlign="center">
                        <div style={{ width: 180 }}>
                          <TextField label="Optionsname" labelHidden value={p.optionName} onChange={setField("optionName")} prefix="Option:" autoComplete="off" />
                        </div>
                        <Button icon={PlusIcon} onClick={() => update({ variants: [...p.variants, emptyVariant()] })}>Variante</Button>
                      </InlineStack>
                    )}
                  </InlineStack>
                  {!isNew && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Der Verkaufspreis wird in die Preisfelder für Google, idealo und Shop geschrieben. Der Repricer passt ihn täglich anhand von Omnia innerhalb von Min/Max an.
                    </Text>
                  )}
                  {p.variants.map((v, i) => (
                    <VariantCard
                      key={v.id || i}
                      v={v}
                      index={i}
                      isNew={isNew}
                      optionName={p.optionName}
                      onChange={setVariant(i)}
                      canRemove={p.variants.length > 1}
                      onRemove={() => update({ variants: p.variants.filter((_, j) => j !== i) })}
                    />
                  ))}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Produkttexte & Pflichtangaben</Text>
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                    {PRODUCT_TEXT_FIELDS.map((f) => (
                      <TextField key={f.key} label={f.label} value={p.meta[f.key] || ""} onChange={setMeta(f.key)} multiline={f.multiline} helpText={f.help} autoComplete="off" />
                    ))}
                  </InlineGrid>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Produkt-Check</Text>
                    {issues.length === 0 ? <Badge tone="success">Alles vollständig</Badge> : critical ? <Badge tone="critical">{`${critical} kritisch`}</Badge> : <Badge tone="warning">{`${issues.length} Hinweise`}</Badge>}
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

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Bilder</Text>
                  <InlineStack gap="200">
                    {[...p.images, ...newImages.map((url) => ({ url, isNew: true }))].map((img, i) => (
                      <Thumbnail key={i} size="large" source={img.url} alt={img.alt || ""} />
                    ))}
                    {!p.images.length && !newImages.length && <Text tone="subdued" as="p">Noch keine Bilder.</Text>}
                  </InlineStack>
                  <TextField
                    label="Bild per URL hinzufügen"
                    value={imageUrl}
                    onChange={setImageUrl}
                    placeholder="https://…/bild.jpg"
                    autoComplete="off"
                    connectedRight={<Button disabled={!/^https?:\/\//.test(imageUrl)} onClick={() => { setNewImages([...newImages, imageUrl]); setImageUrl(""); }}>Hinzufügen</Button>}
                    helpText="Wird beim Speichern hochgeladen. Bilder sortieren/löschen in Shopify."
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Export & Kanäle</Text>
                  {PRODUCT_EXPORT_FIELDS.filter((f) => f.kind).map((f) => (
                    <Checkbox
                      key={f.key}
                      label={f.label}
                      checked={f.kind === "flag10" ? p.meta[f.key] === "1" : p.meta[f.key] === "true"}
                      onChange={(c) => setMeta(f.key)(f.kind === "flag10" ? (c ? "1" : "0") : String(c))}
                    />
                  ))}
                  <Divider />
                  {PRODUCT_EXPORT_FIELDS.filter((f) => !f.kind).map((f) => (
                    <TextField key={f.key} label={f.label} value={p.meta[f.key] || ""} onChange={setMeta(f.key)} autoComplete="off" />
                  ))}
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
                        <Text as="span" variant="bodySm">
                          {h.type === "updated" || h.type === "clamped" ? `${eur(h.oldPrice)} → ${eur(h.newPrice)} (Omnia ${eur(h.omniaPrice)})` : h.message}
                        </Text>
                      </BlockStack>
                    ))}
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Layout.Section>
        </Layout>
        <InlineStack align="end">
          <Button variant="primary" loading={saving} disabled={!isNew && !dirty && !newImages.length} onClick={save}>
            {isNew ? "Produkt anlegen" : "Speichern"}
          </Button>
        </InlineStack>
      </BlockStack>
    </Page>
  );
}
