// /api/extract.js
export const config = { api: { bodyParser: false } };

import formidable from "formidable";
import fs from "fs";

const parseForm = (req) =>
  new Promise((resolve, reject) => {
    const form = formidable({ multiples: false, maxFileSize: 10 * 1024 * 1024, keepExtensions: true });
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });

const strictJSON = (txt) => {
  if (!txt) return null;
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(txt.slice(s, e + 1)); } catch { return null; }
};

function sanitizeWords(words) {
  const STOP_KO = /^(순위|명사|동사|형용사|형용사들?|단어|뜻|예문|품사)$/;
  const hasHangul = /[가-힣]/;
  const onlyDigits = /^[\d.,\-–—]+$/;
  const valid = [];

  for (let w of words) {
    if (!w) continue;
    w = String(w).trim();
    const normalized = w.toLowerCase();
    if (normalized.length < 2) continue;
    if (hasHangul.test(normalized)) continue;
    if (onlyDigits.test(normalized)) continue;
    if (STOP_KO.test(normalized)) continue;
    const cleaned = normalized.replace(/^[^a-z']+|[^a-z']+$/g, "");
    if (!/^[a-z][a-z' -]*[a-z]$/.test(cleaned)) continue;
    valid.push(cleaned);
    if (valid.length >= 60) break;
  }
  return Array.from(new Set(valid)).slice(0, 60);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { files } = await parseForm(req);
    const f = files?.image || files?.file || files?.upload;
    if (!f) return res.status(400).json({ error: "No image file (use field name 'image')" });

    const b64 = await fs.promises.readFile(f.filepath, { encoding: "base64" });
    const mime = f.mimetype || "image/jpeg";

    const messages = [
      {
        role: "system",
        content:
          "You are an OCR assistant. Read printed or handwritten images and extract DISTINCT ENGLISH WORDS only. Ignore table headers and numbering."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
`Return ONLY JSON (no code fences):
{ "words": ["word1","word2","..."] }

Rules:
- The image may be a TABLE with Korean headers like "순위, 명사, 동사, 형용사" and row numbers (1,2,3...). DO NOT return those headers or numbers.
- Extract up to 60 distinct ENGLISH lexical items that a human can reasonably read from the image (including handwritten).
- Keep words lowercase. Allow apostrophes/hyphens in words, but no Korean, no numeric-only tokens.
- Words only; no translations, no examples.`
          },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }
        ]
      }
    ];

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages,
        temperature: 0,
        response_format: { type: "json_object" }
      })
    });

    const raw = await r.text();
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${raw.slice(0, 800)}`);

    const data = strictJSON(raw);
    if (!data || !Array.isArray(data.words)) throw new Error("Invalid JSON from AI");

    const words = sanitizeWords(data.words);
    return res.status(200).json({ words });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
