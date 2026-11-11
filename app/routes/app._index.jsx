import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, InlineStack, InlineGrid, Text, Badge, Button, Box, Banner, Thumbnail, Divider } from "@shopify/polaris";
import { ImageIcon, PlusIcon, DuplicateIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings, parseTimes } from "../lib/settings.server";

const berlinDate = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(d);

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const settings = await getSettings();
  const gql = async (query) => (await (await admin.graphql(query)).json()).data;

  const shopData = await gql(`{
    aktiv: productsCount(query: "status:active") { count }
    entwurf: productsCount(query: "status:draft") { count }
    leer: productsCount(query: "status:active AND inventory_total:<=0") { count }
    recent: products(first: 6, sortKey: UPDATED_AT, reverse: true) { nodes { id title vendor status updatedAt featuredMedia { preview { image { url } } } } }
  }`);

  let runs = [];
  let last = null;
  let problems = [];
  let problemCounts = {};
  try {
    runs = await prisma.repricerRun.findMany({ where: { dryRun: false, startedAt: { gte: new Date(Date.now() - 15 * 864e5) } }, orderBy: { startedAt: "asc" } });
    last = [...runs].reverse().find((r) => r.status !== "running") || null;
    if (last) {
      problems = await prisma.repricerEvent.findMany({ where: { runId: last.id, type: { in: ["ek_block", "data", "error"] } }, orderBy: { title: "asc" }, take: 6 });
      const g = await prisma.repricerEvent.groupBy({ by: ["type"], where: { runId: last.id }, _count: true });
      problemCounts = Object.fromEntries(g.map((x) => [x.type, x._count]));
    }
  } catch {}

  // Pro Tag: übernommene Preise (alle Läufe des Tages)
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = berlinDate(new Date(Date.now() - i * 864e5));
    const dayRuns = runs.filter((r) => berlinDate(r.startedAt) === d);
    days.push({ date: d, updated: dayRuns.reduce((s, r) => s + r.updated, 0), clamped: dayRuns.reduce((s, r) => s + r.clamped, 0), failed: dayRuns.some((r) => r.status === "failed"), ran: dayRuns.length > 0 });
  }
  const today = berlinDate();
  const todayRuns = runs.filter((r) => berlinDate(r.startedAt) === today);

  return json({
    counts: { aktiv: shopData.aktiv.count, entwurf: shopData.entwurf.count, leer: shopData.leer.count },
    recent: shopData.recent.nodes,
    last,
    problems,
    problemCounts,
    days,
    todayRuns,
    times: parseTimes(settings.repricerTimes),
    enabled: settings.repricerEnabled === "true",
  });
};

const fmt = (d) => new Date(d).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtTime = (d) => new Date(d).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });

function Kpi({ label, value, hint, tone, onClick }) {
  return (
    <div onClick={onClick} style={{ cursor: onClick ? "pointer" : "default", height: "100%" }}>
      <Card>
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
          <Text as="p" variant="heading2xl" tone={tone}>{value ?? "–"}</Text>
          {hint && <Text as="p" variant="bodySm" tone="subdued">{hint}</Text>}
        </BlockStack>
      </Card>
    </div>
  );
}

function Chart({ days }) {
  const max = Math.max(10, ...days.map((d) => d.updated));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 140, paddingTop: 8 }}>
      {days.map((d) => (
        <div key={d.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }} title={`${d.date}: ${d.updated} Preise übernommen, ${d.clamped} begrenzt`}>
          <span style={{ fontSize: 11, color: "var(--p-color-text-secondary)" }}>{d.ran ? d.updated : ""}</span>
          <div style={{ width: "100%", maxWidth: 28, height: `${Math.max(d.ran ? 4 : 2, (d.updated / max) * 100)}px`, borderRadius: 6, background: d.failed ? "var(--p-color-bg-fill-critical)" : d.ran ? "var(--p-color-bg-fill-info)" : "var(--p-color-bg-fill-disabled)" }} />
          <span style={{ fontSize: 10, color: "var(--p-color-text-secondary)" }}>{d.date.slice(8)}.{d.date.slice(5, 7)}</span>
        </div>
      ))}
    </div>
  );
}

function TodayChain({ times, todayRuns }) {
  const now = new Date();
  const hm = Number(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", hour12: false }).format(now)) * 60 + Number(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", minute: "2-digit" }).format(now));
  const at = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const steps = [
    { t: "08:30", label: "Feed für Omnia", sub: "Multifeeds" },
    { t: "09:00", label: "Omnia-Import", sub: "Produkte & Min/Max" },
    { t: "09:25", label: "Angebote", sub: "Google & idealo" },
    { t: "09:45", label: "Berechnung", sub: "Omnia" },
    ...times.map((t) => {
      const run = todayRuns.find((r) => fmtTime(r.startedAt) === t);
      return { t, label: "Repricer", sub: run ? `${run.updated} übernommen` : "geplant", run };
    }),
    { t: "10:30", label: "Feeds", sub: "Google, idealo & Co." },
  ].sort((a, b) => at(a.t) - at(b.t));
  return (
    <div style={{ display: "flex", gap: 0, overflowX: "auto" }}>
      {steps.map((s, i) => {
        const done = s.run ? s.run.status !== "running" : at(s.t) <= hm;
        const failed = s.run?.status === "failed";
        return (
          <div key={i} style={{ flex: 1, minWidth: 110, position: "relative", padding: "0 6px" }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <div style={{ width: 14, height: 14, borderRadius: 7, flexShrink: 0, background: failed ? "var(--p-color-bg-fill-critical)" : done ? "var(--p-color-bg-fill-success)" : "var(--p-color-bg-fill-disabled)" }} />
              {i < steps.length - 1 && <div style={{ height: 2, flex: 1, background: done ? "var(--p-color-bg-fill-success)" : "var(--p-color-border)" }} />}
            </div>
            <div style={{ marginTop: 8 }}>
              <Text as="p" variant="headingSm">{s.t}</Text>
              <Text as="p" variant="bodySm">{s.label}</Text>
              <Text as="p" variant="bodySm" tone="subdued">{s.sub}</Text>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const { counts, recent, last, problems, problemCounts, days, todayRuns, times, enabled } = useLoaderData();
  const navigate = useNavigate();
  const status = last ? (last.status === "failed" ? { tone: "critical", label: "Fehler" } : last.ekBlocked || last.errors ? { tone: "warning", label: "Hinweise" } : { tone: "success", label: "OK" }) : null;

  return (
    <Page title="Sportnahrung Kwax · Shop-Cockpit" subtitle={new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}>
      <BlockStack gap="400">
        {!enabled && <Banner tone="warning" title="Der Repricer-Zeitplan ist ausgeschaltet." action={{ content: "Einstellungen öffnen", onAction: () => navigate("/app/repricer") }} />}
        {last?.status === "failed" && (
          <Banner tone="critical" title={`Repricer-Lauf vom ${fmt(last.startedAt)} fehlgeschlagen`} action={{ content: "Protokoll", onAction: () => navigate(`/app/repricer?run=${last.id}`) }}>
            <p>{last.message}</p>
          </Banner>
        )}

        <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
          <Kpi label="Aktive Produkte" value={counts.aktiv} hint={`${counts.entwurf} Entwürfe`} onClick={() => navigate("/app/produkte?status=active")} />
          <Kpi label="Preise zuletzt übernommen" value={last ? last.updated : "–"} hint={last ? `Lauf ${fmt(last.startedAt)}` : "noch kein Lauf"} onClick={() => navigate("/app/repricer")} />
          <Kpi label="Fehlen in Omnia" value={last ? last.notInOmnia : "–"} tone={last?.notInOmnia ? "caution" : undefined} hint="aktive Artikel ohne Omnia-Preis" onClick={() => navigate("/app/repricer?type=not_in_omnia")} />
          <Kpi label="Aktiv ohne Bestand" value={counts.leer} tone={counts.leer ? "caution" : undefined} hint="ausverkaufte Produkte" onClick={() => navigate("/app/produkte?status=active")} />
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Preis-Kette heute</Text>
              {status && <Badge tone={status.tone}>{`Repricer: ${status.label}`}</Badge>}
            </InlineStack>
            <TodayChain times={times} todayRuns={todayRuns} />
          </BlockStack>
        </Card>

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Übernommene Preise · 14 Tage</Text>
                    <Button variant="plain" onClick={() => navigate("/app/repricer")}>Repricer öffnen</Button>
                  </InlineStack>
                  <Chart days={days} />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">Zu erledigen</Text>
                    {last && <Button variant="plain" onClick={() => navigate(`/app/repricer?run=${last.id}`)}>Alle im Protokoll</Button>}
                  </InlineStack>
                  {last ? (
                    <InlineGrid columns={{ xs: 2, md: 4 }} gap="200">
                      {[
                        ["ek_block", "EK-Sperren", "critical"],
                        ["data", "Min/Max-Fehler", "warning"],
                        ["not_in_omnia", "Fehlen in Omnia", "warning"],
                        ["clamped", "Auf Min/Max begrenzt", "attention"],
                      ].map(([type, label, tone]) => (
                        <div key={type} onClick={() => navigate(`/app/repricer?run=${last.id}&type=${type}`)} style={{ cursor: "pointer" }}>
                          <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                            <BlockStack gap="100">
                              <Text as="span" variant="headingLg">{problemCounts[type] || 0}</Text>
                              <Badge tone={problemCounts[type] ? tone : undefined}>{label}</Badge>
                            </BlockStack>
                          </Box>
                        </div>
                      ))}
                    </InlineGrid>
                  ) : (
                    <Text tone="subdued" as="p">Noch kein Repricer-Lauf protokolliert.</Text>
                  )}
                  {problems.length > 0 && <Divider />}
                  {problems.map((e) => (
                    <InlineStack key={e.id} align="space-between" blockAlign="center" wrap={false} gap="300">
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">{e.title}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">{e.message}</Text>
                      </BlockStack>
                      {e.productId && <Button size="slim" onClick={() => navigate(`/app/produkte/${e.productId.split("/").pop()}`)}>Öffnen</Button>}
                    </InlineStack>
                  ))}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">Schnellstart</Text>
                  <Button fullWidth icon={PlusIcon} variant="primary" onClick={() => navigate("/app/produkte/neu")}>Neues Produkt</Button>
                  <Button fullWidth icon={DuplicateIcon} onClick={() => navigate("/app/produkte/neu")}>Produkt duplizieren</Button>
                  <Button fullWidth onClick={() => navigate("/app/aussenlager")}>Außenlager prüfen</Button>
                  <Button fullWidth onClick={() => navigate("/app/repricer")}>Repricer-Protokoll</Button>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Zuletzt bearbeitet</Text>
                  {recent.map((p) => (
                    <div key={p.id} onClick={() => navigate(`/app/produkte/${p.id.split("/").pop()}`)} style={{ cursor: "pointer" }}>
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        <Thumbnail size="small" source={p.featuredMedia?.preview?.image?.url || ImageIcon} alt="" />
                        <BlockStack gap="050">
                          <Text as="span" variant="bodySm" fontWeight="semibold">{p.title}</Text>
                          <Text as="span" variant="bodySm" tone="subdued">{fmt(p.updatedAt)}{p.status === "DRAFT" ? " · Entwurf" : ""}</Text>
                        </BlockStack>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
