import { useEffect, useRef } from "react";
import { useFetcher } from "@remix-run/react";
import { DropZone, BlockStack, InlineStack, Text, Button, Spinner, Badge, Tooltip } from "@shopify/polaris";
import { DeleteIcon, StarIcon } from "@shopify/polaris-icons";

/*
  media: [{ key, url, kind: "existing" | "new", id?, resourceUrl?, uploading?, error? }]
  Das erste Bild ist das Hauptbild.
*/
export default function ImageManager({ media, onChange }) {
  const fetcher = useFetcher();
  const pending = useRef([]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.results) return;
    const results = fetcher.data.results;
    const keys = pending.current;
    pending.current = [];
    onChange((cur) =>
      cur.map((m) => {
        const i = keys.indexOf(m.key);
        if (i === -1) return m;
        const r = results[i];
        return r?.resourceUrl ? { ...m, uploading: false, resourceUrl: r.resourceUrl } : { ...m, uploading: false, error: r?.error || "Fehler" };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const onDrop = (_all, accepted) => {
    if (!accepted.length) return;
    const items = accepted.map((f) => ({ key: `n-${Date.now()}-${Math.random().toString(36).slice(2)}`, url: URL.createObjectURL(f), kind: "new", uploading: true, name: f.name }));
    pending.current = items.map((i) => i.key);
    onChange((cur) => [...cur, ...items]);
    const fd = new FormData();
    accepted.forEach((f) => fd.append("file", f));
    fetcher.submit(fd, { method: "post", action: "/app/bild-upload", encType: "multipart/form-data" });
  };

  const remove = (key) => onChange((cur) => cur.filter((m) => m.key !== key));
  const makeMain = (key) => onChange((cur) => [cur.find((m) => m.key === key), ...cur.filter((m) => m.key !== key)]);

  return (
    <BlockStack gap="300">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 12 }}>
        {media.map((m, i) => (
          <div
            key={m.key}
            style={{
              position: "relative",
              aspectRatio: "1 / 1",
              border: i === 0 ? "2px solid var(--p-color-border-emphasis)" : "1px solid var(--p-color-border)",
              borderRadius: 12,
              overflow: "hidden",
              background: "var(--p-color-bg-surface-secondary)",
              gridColumn: i === 0 ? "span 2" : undefined,
              gridRow: i === 0 ? "span 2" : undefined,
            }}
          >
            <img src={m.url} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", opacity: m.uploading ? 0.4 : 1 }} />
            {m.uploading && (
              <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}><Spinner size="small" /></div>
            )}
            <div style={{ position: "absolute", top: 6, left: 6 }}>
              {i === 0 && <Badge tone="info">Hauptbild</Badge>}
              {m.kind === "new" && !m.uploading && !m.error && i !== 0 && <Badge tone="success">Neu</Badge>}
              {m.error && <Badge tone="critical">Fehler</Badge>}
            </div>
            <div style={{ position: "absolute", bottom: 6, right: 6, display: "flex", gap: 4, background: "rgba(255,255,255,.9)", borderRadius: 8 }}>
              {i !== 0 && (
                <Tooltip content="Als Hauptbild">
                  <Button size="micro" variant="tertiary" icon={StarIcon} onClick={() => makeMain(m.key)} accessibilityLabel="Als Hauptbild" />
                </Tooltip>
              )}
              <Tooltip content="Entfernen">
                <Button size="micro" variant="tertiary" tone="critical" icon={DeleteIcon} onClick={() => remove(m.key)} accessibilityLabel="Entfernen" />
              </Tooltip>
            </div>
          </div>
        ))}
        <div style={{ aspectRatio: media.length ? "1 / 1" : undefined, gridColumn: media.length ? undefined : "1 / -1" }}>
          <DropZone accept="image/*" type="image" onDrop={onDrop} allowMultiple>
            <DropZone.FileUpload actionTitle="Bilder hinzufügen" actionHint={media.length ? "" : "oder hierher ziehen (JPG, PNG, WebP)"} />
          </DropZone>
        </div>
      </div>
      {media.some((m) => m.error) && <Text tone="critical" as="p" variant="bodySm">Einige Bilder konnten nicht hochgeladen werden.</Text>}
      <Text as="p" variant="bodySm" tone="subdued">Bilder werden beim Speichern übernommen. Der Stern macht ein Bild zum Hauptbild.</Text>
    </BlockStack>
  );
}
