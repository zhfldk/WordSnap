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

// 업로드 파일 안정 추출
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

// 느슨 파서(코드펜스/후행쉼표/싱글쿼트 보정)
function parseAIJSONLoose(text) {
  if (!text) return null;
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```(json)?/g, "").trim());
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  let chunk = text.slice(s, e + 1);
  if (chunk.includes("'") && !chunk.includes('"')) chunk = chunk.replace(/'/g, '"');
  chunk = chunk.replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(chunk); } catch { return null; }
}

// 필터/정규화
const STOP_KO = /^(순위|명사|동사|형용사|형용사들?|단어|뜻|예문|품사)$/;
const hasHangul = /[가-힣]/;
const onlyDigits = /^[\d.,\-–—]+$/;

function cleanWord(w) {
  if (!w) return "";
  const normalized = String(w).trim().toLowerCase();
  if (normalized.length < 2) return "";
  if (hasHangul.test(normalized)) return "";        // 영어 단어에 한글 섞이면 제외
  if (onlyDigits.test(normalized)) return "";       // 숫자 토큰 제외
  if (STOP_KO.test(normalized)) return "";          // 표 머리글 제외
  const cleaned = normalized.replace(/^[^a-z']+|[^a-z']+$/g, "");
  if (!/^[a-z][a-z' -]*[a-z]$/.test(cleaned)) return "";
  return cleaned;
}
function cleanMeaning(m) {
  if (!m) return null;
  const txt = String(m).trim();
  if (!txt) return null;
  // 뜻에는 한글 허용, 영어만 덩그러니면 무시
  if (!/[가-힣]/.test(txt)) return null;
  if (STOP_KO.test(txt)) return null;
  return txt;
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
          "You read printed or handwritten images and extract vocabulary. Return ONLY JSON.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Return ONLY minified JSON (no code fences, no commentary):
{"items":[{"word":"string","meaning_ko":"string|null"}]}

Rules:
- Extract up to 60 distinct ENGLISH words readable by a human.
- If a Korean meaning is VISIBLE near the word in the image, copy it VERBATIM into meaning_ko.
- If no Korean meaning is visible, set meaning_ko:null (do NOT invent).
- STRICTLY IGNORE table headers like "순위, 명사, 동사, 형용사" and row numbers (1,2,3...).
- Words must be lowercase ASCII, allow apostrophes/hyphens. Korean only allowed in meaning_ko.`,
          },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ];

    // 1차: JSON 강제
    const r1 = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o", // 필요 시 gpt-4o-mini
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
        max_tokens: 1200,
      }),
    });
    const raw1 = await r1.text();
    if (!r1.ok) throw new Error(`OpenAI ${r1.status}: ${raw1.slice(0, 800)}`);

    let json = null;
    try {
      const data = JSON.parse(raw1);
      const content = data?.choices?.[0]?.message?.content;
      json = typeof content === "string" ? JSON.parse(content) : null;
    } catch {
      json = parseAIJSONLoose(raw1);
    }

    // 2차: 페일오버
    if (!json || !Array.isArray(json.items)) {
      const r2 = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages,
          temperature: 0,
          max_tokens: 1200,
        }),
      });
      const raw2 = await r2.text();
      if (!r2.ok) throw new Error(`OpenAI(fo) ${r2.status}: ${raw2.slice(0, 800)}`);
      json = parseAIJSONLoose(raw2);
    }

    if (!json || !Array.isArray(json.items)) {
      console.error("AI raw failed to JSON.");
      throw new Error("Invalid JSON from AI");
    }

    // 정제 + 중복 제거 + 60개 제한
    const out = [];
    const seen = new Set();
    for (const it of json.items) {
      const w = cleanWord(it?.word);
      if (!w) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      const meaning = cleanMeaning(it?.meaning_ko);
      out.push({ word: w, meaning_ko: meaning ?? null });
      if (out.length >= 60) break;
    }

    return res.status(200).json({ items: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
