import cron from "node-cron";
import { runRepricer } from "./lib/repricer.server";
import { getSettings, parseTimes } from "./lib/settings.server";

// Repricer-Zeitplan: jede Minute prüfen, ob eine eingestellte Uhrzeit (Europe/Berlin) erreicht ist.
// Kein Lauf beim Serverstart mehr. Der slotKey (Datum + Uhrzeit) ist in der Datenbank eindeutig,
// so startet bei mehreren Instanzen nur eine den Lauf.

const berlinNow = () => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};

if (!global.__repricerCron) {
  global.__repricerCron = cron.schedule("* * * * *", async () => {
    try {
      const settings = await getSettings();
      if (settings.repricerEnabled !== "true") return;
      const { date, time } = berlinNow();
      if (!parseTimes(settings.repricerTimes).includes(time)) return;
      await runRepricer({ trigger: "schedule", slotKey: `${date} ${time}` });
    } catch (err) {
      console.error("❌ Repricer-Zeitplan:", err);
    }
  });
}
