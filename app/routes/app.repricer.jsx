import { json, redirect } from "@remix-run/node";
import { useLoaderData, useNavigate, useRevalidator, useSubmit, useNavigation, Link as RemixLink } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Button,
  Banner,
  TextField,
  Checkbox,
  Tabs,
  IndexTable,
  Box,
  Divider,
  EmptyState,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings, saveSettings, parseTimes } from "../lib/settings.server";
import { runRepricer } from "../lib/repricer.server";

const TYPES = [
  { id: "all", label: "Alle" },
  { id: "updated", label: "Übernommen" },
  { id: "clamped", label: "Auf Min/Max begrenzt" },
  { id: "ek_block", label: "EK-Sperre" },
  { id: "below_ek_ok", label: "Unter EK erlaubt" },
  { id: "not_in_omnia", label: "Fehlt in Omnia" },
  { id: "data", label: "Datenfehler" },
  { id: "error", label: "Fehler" },
];

const TYPE_BADGE = {
  updated: { tone: "success", label: "Übernommen" },
  clamped: { tone: "attention", label: "Begrenzt" },
  ek_block: { tone: "critical", label: "EK-Sperre" },
  below_ek_ok: { tone: "info", label: "Unter EK erlaubt" },
  not_in_omnia: { tone: "warning", label: "Fehlt in Omnia" },
  data: { tone: "warning", label: "Datenfehler" },
  error: { tone: "critical", label: "Fehler" },
};

const STATUS_BADGE = {
  running: { tone: "info", label: "Läuft …" },
  success: { tone: "success", label: "Erfolgreich" },
  warning: { tone: "warning", label: "Mit Fehlern" },
  failed: { tone: "critical", label: "Fehlgeschlagen" },
};

const TRIGGER_LABEL = { schedule: "Zeitplan", manual: "Manuell", test: "Test" };

const fmtTime = (d) =>
  d ? new Date(d).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–";
const eur = (v) => (v === null || v === undefined ? "–" : `${Number(v).toFixed(2).replace(".", ",")} €`);

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const settings = await getSettings();

  let runs = [];
  let dbError = null;
  try {
    runs = await prisma.repricerRun.findMany({ orderBy: { startedAt: "desc" }, take: 40 });
  } catch (err) {
    dbError = err.message;
  }

  const runId = url.searchParams.get("run") || runs[0]?.id || null;
  const type = url.searchParams.get("type") || "all";
  const q = (url.searchParams.get("q") || "").trim();
  let run = null;
  let events = [];
  let typeCounts = {};
  if (runId && !dbError) {
    run = runs.find((r) => r.id === runId) || (await prisma.repricerRun.findUnique({ where: { id: runId } }));
    const grouped = await prisma.repricerEvent.groupBy({ by: ["type"], where: { runId }, _count: true });
    typeCounts = Object.fromEntries(grouped.map((g) => [g.type, g._count]));
    events = await prisma.repricerEvent.findMany({
      where: {
        runId,
        ...(type !== "all" ? { type } : {}),
        ...(q ? { OR: [{ sku: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] } : {}),
      },
      orderBy: [{ level: "asc" }, { title: "asc" }],
      take: 500,
    });
  }

  return json({ settings, runs, run, events, typeCounts, type, q, dbError, times: parseTimes(settings.repricerTimes) });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "run" || intent === "dry") {
    // Läuft im Hintergrund weiter, die Seite aktualisiert sich selbst
    runRepricer({ trigger: "manual", dryRun: intent === "dry" }).catch((e) => console.error(e));
    await new Promise((r) => setTimeout(r, 800));
    return redirect("/app/repricer");
  }

  if (intent === "settings") {
    const times = parseTimes(form.get("repricerTimes"));
    await saveSettings({
      repricerEnabled: form.get("repricerEnabled") === "true",
      repricerTimes: times.join(","),
      ekFactor: String(form.get("ekFactor") || "1").replace(",", "."),
      clampToMinMax: form.get("clampToMinMax") === "true",
      allowBelowEkIfMinBelowEk: form.get("allowBelowEkIfMinBelowEk") === "true",
      alertEnabled: form.get("alertEnabled") === "true",
    });
    return json({ ok: true });
  }
  return json({ ok: false });
};

function Kpi({ label, value, tone, hint }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="heading2xl" tone={tone}>{value}</Text>
        {hint && <Text as="p" variant="bodySm" tone="subdued">{hint}</Text>}
      </BlockStack>
    </Card>
  );
}

function Timeline({ times }) {
  const steps = [
    { time: "08:30", title: "Multifeeds", text: "Feed für Omnia (Min/Max, EAN, Preise)" },
    { time: "09:00", title: "Omnia-Import", text: "Produkte und Grenzen einlesen" },
    { time: "09:25", title: "Angebote", text: "Google und idealo erfassen (ca. 15–25 Min.)" },
    { time: "≈ 09:45", title: "Berechnung", text: "Omnia berechnet die Preise" },
    { time: times.join(" + ") || "–", title: "Repricer", text: "Preise prüfen und übernehmen", highlight: true },
    { time: "10:30", title: "Multifeeds", text: "Google, idealo & Co. mit neuen Preisen" },
  ];
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Tagesablauf</Text>
        <InlineGrid columns={{ xs: 2, md: 6 }} gap="300">
          {steps.map((s) => (
            <Box
              key={s.title + s.time}
              padding="300"
              borderRadius="200"
              background={s.highlight ? "bg-fill-info-secondary" : "bg-surface-secondary"}
            >
              <BlockStack gap="100">
                <Text as="p" variant="headingSm">{s.time}</Text>
                <Text as="p" variant="bodyMd" fontWeight="semibold">{s.title}</Text>
                <Text as="p" variant="bodySm" tone="subdued">{s.text}</Text>
              </BlockStack>
            </Box>
          ))}
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

function Settings({ settings }) {
  const submit = useSubmit();
  const nav = useNavigation();
  const [s, setS] = useState(settings);
  const set = (k) => (v) => setS({ ...s, [k]: typeof v === "boolean" ? String(v) : v });
  const save = () => submit({ intent: "settings", ...s }, { method: "post" });
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Einstellungen</Text>
        <Checkbox label="Repricer aktiv (Zeitplan)" checked={s.repricerEnabled === "true"} onChange={set("repricerEnabled")} />
        <TextField label="Uhrzeiten (Europe/Berlin)" value={s.repricerTimes} onChange={set("repricerTimes")} helpText="Mehrere Zeiten mit Komma, z. B. 10:00,10:30" autoComplete="off" />
        <TextField label="EK-Faktor" value={s.ekFactor} onChange={set("ekFactor")} helpText="Grenze = Kosten pro Artikel × Faktor. Kosten sind brutto → 1" autoComplete="off" />
        <Checkbox label="Omnia-Preis auf Achims Min/Max begrenzen" checked={s.clampToMinMax === "true"} onChange={set("clampToMinMax")} helpText="Schützt vor veralteten Omnia-Werten, wenn Omnia neue Grenzen noch nicht importiert hat" />
        <Checkbox label="Unter EK erlauben, wenn Min selbst unter EK liegt" checked={s.allowBelowEkIfMinBelowEk === "true"} onChange={set("allowBelowEkIfMinBelowEk")} helpText="Für bewusste Abverkäufe (MHD)" />
        <Checkbox label="Slack-Meldung bei EK-Sperre oder Fehlern" checked={s.alertEnabled === "true"} onChange={set("alertEnabled")} />
        <InlineStack align="end">
          <Button variant="primary" onClick={save} loading={nav.state === "submitting" && nav.formData?.get("intent") === "settings"}>Speichern</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function Repricer() {
  const { settings, runs, run, events, typeCounts, type, q, dbError, times } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const nav = useNavigation();
  const revalidator = useRevalidator();
  const [search, setSearch] = useState(q);
  const running = runs.some((r) => r.status === "running");

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
  }, [running]);

  const go = (params) => {
    const p = new URLSearchParams({ run: run?.id || "", type, q, ...params });
    navigate(`/app/repricer?${p.toString()}`);
  };
  const busy = nav.state !== "idle" && ["run", "dry"].includes(nav.formData?.get("intent"));
  const last = runs.find((r) => !r.dryRun && r.status !== "running");

  const tabs = TYPES.map((t) => ({
    id: t.id,
    content: t.id === "all" ? t.label : `${t.label} (${typeCounts[t.id] || 0})`,
  }));
  const tabIndex = Math.max(0, TYPES.findIndex((t) => t.id === type));

  return (
    <Page
      title="Repricer"
      subtitle="Omnia-Preise prüfen, begrenzen und übernehmen – mit vollständigem Protokoll"
    >
      <BlockStack gap="400">
        <InlineStack gap="200" align="end">
          <Button disabled={running} loading={busy && nav.formData?.get("intent") === "dry"} onClick={() => submit({ intent: "dry" }, { method: "post" })}>
            Probelauf (ohne Schreiben)
          </Button>
          <Button variant="primary" disabled={running} loading={busy && nav.formData?.get("intent") === "run"} onClick={() => submit({ intent: "run" }, { method: "post" })}>
            Jetzt ausführen
          </Button>
        </InlineStack>
        {dbError && (
          <Banner tone="critical" title="Protokoll-Datenbank nicht erreichbar">
            <p>{dbError}</p>
          </Banner>
        )}
        {last?.status === "failed" && (
          <Banner tone="critical" title={`Letzter Lauf fehlgeschlagen (${fmtTime(last.startedAt)})`}>
            <p>{last.message}</p>
          </Banner>
        )}
        {running && <Banner tone="info" title="Ein Lauf ist gerade aktiv – die Seite aktualisiert sich automatisch." />}

        <Timeline times={times} />

        {last && (
          <InlineGrid columns={{ xs: 2, md: 5 }} gap="300">
            <Kpi label={`Letzter Lauf · ${fmtTime(last.startedAt)}`} value={last.updated} hint="Preise übernommen" />
            <Kpi label="Auf Min/Max begrenzt" value={last.clamped} tone={last.clamped ? "caution" : undefined} hint="Omnia kannte Grenzen noch nicht" />
            <Kpi label="EK-Sperre" value={last.ekBlocked} tone={last.ekBlocked ? "critical" : undefined} hint="Preis bleibt stehen" />
            <Kpi label="Fehlt in Omnia" value={last.notInOmnia} tone={last.notInOmnia ? "caution" : undefined} hint="Aktive Artikel ohne Omnia-Preis" />
            <Kpi label="Omnia-Preise" value={last.omniaRows} hint={`${last.unchanged} unverändert`} />
          </InlineGrid>
        )}

        <Layout>
          <Layout.Section>
            <Card padding="0">
              {!run ? (
                <EmptyState heading="Noch kein Lauf protokolliert" image="">
                  <p>Starte einen Probelauf, um zu sehen, was der Repricer tun würde.</p>
                </EmptyState>
              ) : (
                <BlockStack gap="0">
                  <Box padding="400">
                    <InlineStack align="space-between" blockAlign="center" gap="200">
                      <BlockStack gap="100">
                        <Text as="h2" variant="headingMd">
                          Lauf vom {fmtTime(run.startedAt)} {run.dryRun && <Badge tone="info">Probelauf</Badge>}
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          {TRIGGER_LABEL[run.trigger] || run.trigger} · {run.scanned} geprüft · {run.updated} übernommen · {run.unchanged} unverändert
                          {run.finishedAt && ` · Dauer ${Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000)} s`}
                        </Text>
                      </BlockStack>
                      <Badge tone={STATUS_BADGE[run.status]?.tone}>{STATUS_BADGE[run.status]?.label || run.status}</Badge>
                    </InlineStack>
                    {run.message && <Box paddingBlockStart="200"><Banner tone="critical">{run.message}</Banner></Box>}
                  </Box>
                  <Tabs tabs={tabs} selected={tabIndex} onSelect={(i) => go({ type: TYPES[i].id })} />
                  <Box padding="300">
                    <TextField
                      label="Suche"
                      labelHidden
                      placeholder="SKU oder Artikel suchen …"
                      value={search}
                      onChange={setSearch}
                      clearButton
                      onClearButtonClick={() => { setSearch(""); go({ q: "" }); }}
                      connectedRight={<Button onClick={() => go({ q: search })}>Suchen</Button>}
                      autoComplete="off"
                    />
                  </Box>
                  <IndexTable
                    resourceName={{ singular: "Eintrag", plural: "Einträge" }}
                    itemCount={events.length}
                    selectable={false}
                    emptyState={<Box padding="400"><Text tone="subdued">Keine Einträge in dieser Ansicht.</Text></Box>}
                    headings={[
                      { title: "Art" },
                      { title: "Artikel" },
                      { title: "Omnia", alignment: "end" },
                      { title: "Alt", alignment: "end" },
                      { title: "Neu", alignment: "end" },
                      { title: "Min / Max", alignment: "end" },
                      { title: "EK", alignment: "end" },
                      { title: "Hinweis" },
                    ]}
                  >
                    {events.map((e, i) => (
                      <IndexTable.Row id={e.id} key={e.id} position={i}>
                        <IndexTable.Cell>
                          <Badge tone={TYPE_BADGE[e.type]?.tone}>{TYPE_BADGE[e.type]?.label || e.type}</Badge>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <BlockStack gap="050">
                            {e.productId ? (
                              <RemixLink to={`/app/produkte/${e.productId.split("/").pop()}`} style={{ color: "inherit" }}>
                                <Text as="span" fontWeight="semibold">{(e.title || "").slice(0, 70)}</Text>
                              </RemixLink>
                            ) : (
                              <Text as="span" fontWeight="semibold">{e.title}</Text>
                            )}
                            <Text as="span" variant="bodySm" tone="subdued">SKU {e.sku} {e.omniaId && e.omniaId !== e.sku ? `· Omnia ${e.omniaId}` : ""}</Text>
                          </BlockStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell><Text alignment="end" as="span">{eur(e.omniaPrice)}</Text></IndexTable.Cell>
                        <IndexTable.Cell><Text alignment="end" as="span" tone="subdued">{eur(e.oldPrice)}</Text></IndexTable.Cell>
                        <IndexTable.Cell><Text alignment="end" as="span" fontWeight="semibold">{eur(e.newPrice)}</Text></IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text alignment="end" as="span">{e.minPrice !== null || e.maxPrice !== null ? `${eur(e.minPrice)} / ${eur(e.maxPrice)}` : "–"}</Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell><Text alignment="end" as="span">{eur(e.ek)}</Text></IndexTable.Cell>
                        <IndexTable.Cell>
                          <div style={{ whiteSpace: "normal", minWidth: 260 }}>
                            <Text as="span" variant="bodySm">{e.message}</Text>
                          </div>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>
                  {events.length === 500 && (
                    <Box padding="300"><Text tone="subdued" variant="bodySm">Es werden die ersten 500 Einträge angezeigt – Suche oder Filter nutzen.</Text></Box>
                  )}
                </BlockStack>
              )}
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Settings settings={settings} />
              <Card padding="0">
                <Box padding="400"><Text as="h2" variant="headingMd">Letzte Läufe</Text></Box>
                <Divider />
                <BlockStack gap="0">
                  {runs.map((r) => (
                    <div
                      key={r.id}
                      onClick={() => navigate(`/app/repricer?run=${r.id}`)}
                      style={{ cursor: "pointer", background: r.id === run?.id ? "var(--p-color-bg-surface-selected)" : undefined }}
                    >
                      <Box padding="300" borderBlockEndWidth="025" borderColor="border-secondary">
                        <InlineStack align="space-between" blockAlign="center">
                          <BlockStack gap="050">
                            <Text as="span" fontWeight="semibold">{fmtTime(r.startedAt)}</Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {TRIGGER_LABEL[r.trigger] || r.trigger}{r.dryRun ? " · Probelauf" : ""} · {r.updated} übernommen
                              {r.ekBlocked ? ` · ${r.ekBlocked} EK` : ""}{r.clamped ? ` · ${r.clamped} begrenzt` : ""}
                            </Text>
                          </BlockStack>
                          <Badge tone={STATUS_BADGE[r.status]?.tone}>{STATUS_BADGE[r.status]?.label || r.status}</Badge>
                        </InlineStack>
                      </Box>
                    </div>
                  ))}
                  {!runs.length && <Box padding="400"><Text tone="subdued">Noch keine Läufe.</Text></Box>}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
