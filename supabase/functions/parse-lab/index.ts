// Kompass — parse-lab edge function
// Reads a lab-report PDF or photo with Claude and returns structured marker
// data (test name, value, unit, reference range) for the Labs & Bloodwork form.
//
// Deploy: Supabase Dashboard -> Edge Functions -> create "parse-lab", paste this
// file, Deploy. Then add the secret ANTHROPIC_API_KEY (Dashboard -> Edge
// Functions -> Secrets, or `supabase secrets set ANTHROPIC_API_KEY=...`).
//
// Calls the Anthropic Messages REST API directly (no bundled dependency) so the
// function deploys cleanly from a single paste. Default model: claude-opus-4-8.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-opus-4-8";
const MAX_BYTES = 12 * 1024 * 1024; // ~9MB of file once base64-decoded; guards cost/abuse

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The exact JSON shape we ask Claude to return. Everything is a string so the
// model can echo values verbatim (e.g. "<0.1", "Negative"); the app parses
// numbers client-side.
const SHAPE = `{
  "draw_date": "YYYY-MM-DD or empty string",
  "markers": [
    { "name": "short test name", "value": "as printed", "unit": "e.g. mIU/L or empty", "low": "low end of normal range or empty", "high": "high end of normal range or empty" }
  ]
}`;

const PROMPT = `You are reading a medical laboratory report. Extract EVERY lab test result you can find.

For each result return:
- name: the standard short test name. Prefer these exact names when they appear: TSH, Free T4, Free T3, Reverse T3, TPO antibodies, Thyroglobulin antibodies, Vitamin D, Vitamin B12, Ferritin. Otherwise use the common short name shown on the report.
- value: the measured result exactly as printed (e.g. "2.1", "<0.1", "Negative").
- unit: the unit of measure (e.g. "mIU/L", "ng/dL"), or an empty string if none.
- low / high: the printed reference (normal) range, split into its low and high ends. If the range is one-sided (e.g. "< 34" or "> 30"), fill only the relevant bound and leave the other an empty string. Empty strings if no range is printed.

For draw_date use the specimen COLLECTION date in YYYY-MM-DD format, or an empty string if you cannot find it.

Only include real test results. Skip patient demographics, headers, footnotes, page numbers, and narrative commentary.

Respond with ONLY a single JSON object in exactly this shape — no markdown, no code fences, no commentary:
${SHAPE}`;

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "Server not configured: ANTHROPIC_API_KEY secret is missing." }, 500);
  }

  let payload: { data?: string; media_type?: string };
  try {
    payload = await req.json();
  } catch (_) {
    return json({ error: "Invalid request body." }, 400);
  }

  const data = payload.data || "";
  const mediaType = payload.media_type || "application/pdf";
  if (!data) return json({ error: "Missing file data." }, 400);
  if (data.length > MAX_BYTES) return json({ error: "File too large (max ~9MB)." }, 413);

  // PDFs go in a document block; images (phone photos / screenshots) in an image block.
  const isPdf = mediaType === "application/pdf";
  const fileBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: "Lab report" }
    : { type: "image", source: { type: "base64", media_type: mediaType, data } };

  const body = {
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: [fileBlock, { type: "text", text: PROMPT }] }],
  };

  let resp: Response;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return json({ error: "Could not reach the AI service.", detail: String(e) }, 502);
  }

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 600);
    return json({ error: "AI request failed.", status: resp.status, detail }, 502);
  }

  const out = await resp.json();
  const textBlock = (out.content || []).find((b: { type: string }) => b.type === "text");
  let raw = textBlock?.text || "";
  // Defensively strip ```json ... ``` fences if the model added them.
  raw = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed: { draw_date: string; markers: unknown[] };
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return json({ error: "Could not parse the AI response.", raw: raw.slice(0, 600) }, 502);
  }
  if (!parsed || !Array.isArray(parsed.markers)) {
    return json({ error: "No lab values found in that file.", draw_date: "", markers: [] }, 200);
  }
  return json({ draw_date: parsed.draw_date || "", markers: parsed.markers }, 200);
});
