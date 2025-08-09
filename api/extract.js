// /api/extract.js
export const config = { api: { bodyParser: false } };

import formidable from "formidable";
import fs from "fs";

const parseForm = (req) =>
  new Promise((resolve, reject) => {
    const form = formidable({
      multiples: true,
      maxFileSize: 10 * 1024 * 1024,
      keepExtensions: true,
    });
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });

// 업로드 파일 안전 추출 (image/images/file/upload 키 모두 지원)
function getFirstFile(files) {
  const keys = ["image", "images", "file", "upload"];
  const pool = [];
  for (const k of keys) {
    const v = files?.[k];
    if (Array.isArray(v)) pool.push(...v);
    else if (v) pool.push(v);
  }
  const f = pool.find(x => x && typeof x.filepath === "string" && x.filepath.length > 0);
  if (!f) {
    const got = Object.keys(files || {});
    throw new Error(`No file received. Send "image" as multipart/form-data. Got keys: [${got.join(", ")}]`);
  }
  return f;
}

const strictJSON = (txt) => {
  if (!txt) return null;
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(txt.slice(s, e + 1)); } catch { return null; }
};

// 불필요 텍스트 제거(한글 머리글/숫자 등) + 정규화 + 중복 제거
function sanitizeWords(words) {
  const STOP_KO = /^(순위|명사|동사|형용사|형용사들?|단어|뜻|예문|품사)$/;
  const hasHangul = /[가-힣]/;
  const onlyDigits = /^[\d.,\-–—]+$/;
  const out = [];
  for (let w of words || []) {
    if (!w) continue;
    const normalized = String(w).trim().toLowerCase();
    if (normalized.length < 2) continue;
    if (hasHangul.test(normalized)) continue;
    if (onlyDigits.test(normalized)) continue;
    if (STOP_KO.test(normalized)) continue;
    const cleaned = normalized.replace(/^[^a-z']+|[^a-z']+$/g, "");
    if (!/^[a-z][a-z' -]*[a-z]$/.test(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= 60) break;
  }
  return Array.from(new Set(out)).slice(0, 60);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { files } = await parseForm(req);
    const f = getFirstFile(files);

    const b64 = await fs.promises.readFile(f.filepath, { encoding: "base64" });
    const mime = f.mimetype || "image/jpeg";

    const messages = [
      {
        role: "system",
        content:
          "You are an OCR assistant. Read printed/handwritten images and extract DISTINCT ENGLISH WORDS only. Ignore table headers and numbering."
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
- Table headers like "순위, 명사, 동사, 형용사" and row numbers (1,2,3...) must NOT be returned.
- Extract up to 60 distinct English words readable by a human (including handwritten).
- Lowercase; allow apostrophes/hyphens; no Korean; no numeric-only tokens.
- Words only; no translations.`
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
        model: "gpt-4o", // 필요하면 gpt-4o-mini 로 교체 가능
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
