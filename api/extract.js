// /api/extract.js
export const config = { api: { bodyParser: false } };

import formidable from "formidable";
import fs from "fs";

// --------- helpers ---------
const parseForm = (req) =>
  new Promise((resolve, reject) => {
    const form = formidable({
      multiples: true,
      maxFileSize: 10 * 1024 * 1024,
      keepExtensions: true,
    });
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });

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

function looseJSON(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```(json)?/g, "").trim())
    .replace(/,\s*([}\]])/g, "$1");
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(cleaned.slice(s, e + 1)); } catch { return null; }
}

const STOP_KO = /^(순위|명사|동사|형용사|형용사들?|단어|뜻|예문|품사)$/;
const hasHangul = /[가-힣]/;
const onlyDigits = /^[\d.,\-–—]+$/;

function cleanWord(w) {
  if (!w) return "";
  const n = String(w).trim().toLowerCase();
  if (n.length < 2) return "";
  if (hasHangul.test(n)) return "";      
  if (onlyDigits.test(n)) return "";    
  if (STOP_KO.test(n)) return "";       
  const cleaned = n.replace(/^[^a-z']+|[^a-z']+$/g, "");
  if (!/^[a-z][a-z' -]*[a-z]$/.test(cleaned)) return "";
  return cleaned;
}

function tidyMeaning(m) {
  if (m == null) return null;
  const t = String(m).trim();
  if (!t) return null;
  // 한국어가 1자 이상 포함된 경우만 의미로 인정
  if (!/[가-힣]/.test(t)) return null;
  if (STOP_KO.test(t)) return null;
  return t;
}

// --------- main handler ---------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { files } = await parseForm(req);
    const f = getFirstFile(files);

    const b64 = await fs.promises.readFile(f.filepath, { encoding: "base64" });
    const mime = f.mimetype || "image/jpeg";

    // ✅ 한 번의 호출로: 이미지에 한국어 뜻이 보이면 그대로, 없으면 "짧은 한국어 뜻"으로 채워라
    const messages = [
      {
        role: "system",
        content:
          "You perform OCR on printed or handwritten vocabulary sheets. Return compact JSON only."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
`Return ONLY minified JSON (no code fences, no commentary):
{"items":[{"word":"string","meaning_ko":"string"}]}

Extraction rules:
- Extract up to 60 DISTINCT ENGLISH WORDS a human can read from the image.
- If a KOREAN meaning is VISIBLE near a word, COPY it VERBATIM into meaning_ko.
- If no Korean meaning is visible, provide a SHORT Korean dictionary meaning for the word (do not translate sentences, just the common sense).
- STRICTLY IGNORE table headers like "순위, 명사, 동사, 형용사" and row numbers (1,2,3...).
- Words must be lowercase ASCII; allow apostrophes/hyphens; no numeric-only tokens.
- Korean is only allowed in meaning_ko.`
          },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }
        ]
      }
    ];

    // 1차: JSON 강제
    const r1 = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // gpt-4o 사용해도 됨
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
        max_tokens: 1400
      })
    });

    const raw1 = await r1.text();
    if (!r1.ok) throw new Error(`OpenAI ${r1.status}: ${raw1.slice(0, 800)}`);

    let json = null;
    try {
      const j = JSON.parse(raw1);
      const content = j?.choices?.[0]?.message?.content;
      json = typeof content === "string" ? JSON.parse(content) : null;
    } catch {
      json = looseJSON(raw1);
    }

    // 2차: 페일오버(포맷 강제 해제)
    if (!json || !Array.isArray(json.items)) {
      const r2 = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          temperature: 0,
          max_tokens: 1400
        })
      });
      const raw2 = await r2.text();
      if (!r2.ok) throw new Error(`OpenAI(fo) ${r2.status}: ${raw2.slice(0, 800)}`);
      json = looseJSON(raw2);
    }

    if (!json || !Array.isArray(json.items)) {
      console.error("AI raw failed to JSON.");
      throw new Error("Invalid JSON from AI");
    }

    // 정제 + 중복 제거 + 최대 60개
    const out = [];
    const seen = new Set();
    for (const it of json.items) {
      const w = cleanWord(it?.word);
      if (!w) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      // 이미지에 없었으면 모델이 짧은 한국어 뜻을 생성하도록 했으므로, 한국어 확인만
      const m = tidyMeaning(it?.meaning_ko) ?? ""; // 한국어가 아니면 빈칸 처리(안전)
      out.push({ word: w, meaning_ko: m });
      if (out.length >= 60) break;
    }

    return res.status(200).json({ items: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
