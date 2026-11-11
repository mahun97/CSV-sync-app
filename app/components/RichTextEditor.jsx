import { useEffect, useRef, useState } from "react";
import { Box, Button, ButtonGroup, InlineStack, Text, BlockStack } from "@shopify/polaris";

// Kleiner Editor: Formatieren wie in Word, oder direkt HTML bearbeiten.
const TOOLS = [
  { cmd: "bold", label: "F", title: "Fett", style: { fontWeight: 700 } },
  { cmd: "italic", label: "K", title: "Kursiv", style: { fontStyle: "italic" } },
  { cmd: "underline", label: "U", title: "Unterstrichen", style: { textDecoration: "underline" } },
  { cmd: "insertUnorderedList", label: "• Liste", title: "Aufzählung" },
  { cmd: "insertOrderedList", label: "1. Liste", title: "Nummerierte Liste" },
  { cmd: "formatBlock", arg: "<h3>", label: "Überschrift", title: "Zwischenüberschrift" },
  { cmd: "formatBlock", arg: "<p>", label: "Absatz", title: "Normaler Absatz" },
  { cmd: "removeFormat", label: "Format löschen", title: "Formatierung entfernen" },
];

export default function RichTextEditor({ label, value, onChange, minHeight = 120, helpText }) {
  const ref = useRef(null);
  const [mode, setMode] = useState("visual");
  const lastHtml = useRef(value || "");

  useEffect(() => {
    if (mode === "visual" && ref.current && value !== lastHtml.current) {
      ref.current.innerHTML = value || "";
      lastHtml.current = value || "";
    }
  }, [value, mode]);

  useEffect(() => {
    if (mode === "visual" && ref.current) ref.current.innerHTML = value || "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const emit = () => {
    const html = ref.current?.innerHTML || "";
    lastHtml.current = html;
    onChange(html === "<br>" ? "" : html);
  };

  const exec = (t) => {
    ref.current?.focus();
    document.execCommand(t.cmd, false, t.arg);
    emit();
  };

  const addLink = () => {
    const url = window.prompt("Link-Adresse (https://…)");
    if (!url) return;
    ref.current?.focus();
    document.execCommand("createLink", false, url);
    emit();
  };

  return (
    <BlockStack gap="150">
      <InlineStack align="space-between" blockAlign="center">
        {label ? <Text as="span" variant="bodyMd">{label}</Text> : <span />}
        <ButtonGroup variant="segmented">
          <Button size="micro" pressed={mode === "visual"} onClick={() => setMode("visual")}>Text</Button>
          <Button size="micro" pressed={mode === "html"} onClick={() => setMode("html")}>HTML</Button>
        </ButtonGroup>
      </InlineStack>
      <div
        style={{
          border: "1px solid var(--p-color-border)",
          borderRadius: "var(--p-border-radius-200)",
          background: "var(--p-color-bg-surface)",
          overflow: "hidden",
        }}
      >
        {mode === "visual" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 6, borderBottom: "1px solid var(--p-color-border-secondary)", background: "var(--p-color-bg-surface-secondary)" }}>
            {TOOLS.map((t) => (
              <button
                key={t.title}
                type="button"
                title={t.title}
                onMouseDown={(e) => { e.preventDefault(); exec(t); }}
                style={{ border: "1px solid transparent", background: "transparent", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 13, ...t.style }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--p-color-bg-surface-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {t.label}
              </button>
            ))}
            <button type="button" title="Link" onMouseDown={(e) => { e.preventDefault(); addLink(); }} style={{ border: 0, background: "transparent", padding: "2px 8px", cursor: "pointer", fontSize: 13 }}>
              Link
            </button>
          </div>
        )}
        {mode === "visual" ? (
          <div
            ref={ref}
            contentEditable
            suppressContentEditableWarning
            onInput={emit}
            onBlur={emit}
            className="kwax-rte"
            style={{ minHeight, padding: "10px 12px", outline: "none", fontSize: 14, lineHeight: 1.5 }}
          />
        ) : (
          <textarea
            value={value || ""}
            onChange={(e) => { lastHtml.current = e.target.value; onChange(e.target.value); }}
            spellCheck={false}
            style={{ width: "100%", minHeight: minHeight + 40, border: 0, padding: "10px 12px", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, lineHeight: 1.5, resize: "vertical", outline: "none", boxSizing: "border-box" }}
          />
        )}
      </div>
      {helpText && <Text as="p" variant="bodySm" tone="subdued">{helpText}</Text>}
      <style>{`.kwax-rte p{margin:0 0 .5em} .kwax-rte ul,.kwax-rte ol{margin:.25em 0 .5em 1.25em} .kwax-rte h3{font-size:15px;margin:.4em 0}`}</style>
    </BlockStack>
  );
}

export function HtmlPreview({ html }) {
  return (
    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
      <div className="kwax-rte" style={{ fontSize: 13, lineHeight: 1.5 }} dangerouslySetInnerHTML={{ __html: html || "<em>leer</em>" }} />
    </Box>
  );
}
