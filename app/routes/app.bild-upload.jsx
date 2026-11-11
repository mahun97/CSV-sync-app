import { json, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// Nimmt Bilder per Drag & Drop entgegen und lädt sie in Shopifys Upload-Speicher.
// Zurück kommt die resourceUrl, die beim Speichern als Produktbild angehängt wird.
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await unstable_parseMultipartFormData(
    request,
    unstable_createMemoryUploadHandler({ maxPartSize: 20 * 1024 * 1024 }),
  );
  const files = form.getAll("file").filter((f) => f && typeof f === "object" && f.size > 0);
  const results = [];

  for (const file of files) {
    try {
      const res = await admin.graphql(
        `mutation ($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { message }
          }
        }`,
        {
          variables: {
            input: [{ resource: "PRODUCT_IMAGE", filename: file.name, mimeType: file.type || "image/jpeg", httpMethod: "POST", fileSize: String(file.size) }],
          },
        },
      );
      const data = (await res.json()).data.stagedUploadsCreate;
      if (data.userErrors.length) throw new Error(data.userErrors.map((e) => e.message).join(", "));
      const target = data.stagedTargets[0];
      const fd = new FormData();
      for (const p of target.parameters) fd.append(p.name, p.value);
      fd.append("file", new Blob([await file.arrayBuffer()], { type: file.type }), file.name);
      const up = await fetch(target.url, { method: "POST", body: fd });
      if (!up.ok) throw new Error(`Upload fehlgeschlagen (${up.status})`);
      results.push({ name: file.name, resourceUrl: target.resourceUrl });
    } catch (err) {
      results.push({ name: file.name, error: err.message });
    }
  }
  return json({ results });
};
