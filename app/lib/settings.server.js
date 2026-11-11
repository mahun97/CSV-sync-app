import prisma from "../db.server";

export const DEFAULT_SETTINGS = {
  repricerEnabled: "true",
  // Uhrzeiten (Europe/Berlin), an denen die Omnia-Preise abgeholt werden
  repricerTimes: "10:00,10:30",
  // EK-Grenze = Kosten pro Artikel × Faktor (Kosten sind brutto → 1)
  ekFactor: process.env.EK_FAKTOR || "1",
  // Omnia-Empfehlung außerhalb Min/Max auf die Grenze setzen
  clampToMinMax: "true",
  // Setzt Achim den Min-Preis bewusst unter EK, ist der Verkauf unter EK erlaubt
  allowBelowEkIfMinBelowEk: "true",
  // Sammelmeldung nach jedem geplanten Lauf (Slack über n8n), nur bei Sperren oder Fehlern
  alertEnabled: "true",
  omniaFeedUrl:
    "https://api.patagona.de/api/2/v/contracts/hlsoer/feeds/0210b28a-d30d-44ed-b6b1-baff07ff0434/export/feed.csv",
};

export async function getSettings() {
  let rows = [];
  try {
    rows = await prisma.appSetting.findMany();
  } catch (err) {
    console.log("⚠️ Einstellungen nicht lesbar, nutze Standard:", err.message);
  }
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

export async function saveSettings(values) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: String(value) },
      update: { value: String(value) },
    });
  }
}

export function parseTimes(str) {
  return String(str || "")
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .map((t) => t.padStart(5, "0"))
    .sort();
}
