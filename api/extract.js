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

// 업로드 파일 안전 추출
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

// --- JSON 파서 유틸 (코드펜스/잡텍스트 제거, 후행쉼표/싱글쿼트 등 가벼운 복구) ---
function parseAIJSONLoose(text) {
  if (!text) return null;
  // 코드펜스 제거
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```(json)?/g, "").trim());
  // JSON 블록만 추출
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  let chunk = text.slice(s, e + 1);

  // 흔한 실수 보정: 싱글쿼트 → 더블, 후행쉼표 제거
  if (chunk.includes("'") && !chunk.includes('"')) {
    chunk = chunk.replace(/'/g, '"');
  }
  // 후행 쉼표 제거
  chunk = chunk.replace(/,\s*([}\]])/g, "$1");

  try { return JSON.parse(chunk); } catch { return null; }
}

// 불필요 텍스트 제거 + 정규화 + 중복 제거
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
          "You are an OCR assistant. Read printed/handwritten images and extract DISTINCT ENGLISH WORDS only. Ignore table headers and numbering.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Return ONLY minified JSON (no code fences, no commentary):
{"words":["word1","word2","..."]}

Rules:
- Table headers like "순위, 명사, 동사, 형용사" and row numbers (1,2,3...) must NOT be returned.
- Extract up to 60 distinct English words readable by a human (including handwritten).
- Lowercase; allow apostrophes/hyphens; no Korean; no numeric-only tokens.
- Output MUST be valid JSON with exactly one top-level key "words".`,
          },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ];

    // 1차: JSON 강제 모드
    const r1 = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o", // 필요시 gpt-4o-mini
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
        max_tokens: 800,
      }),
    });

    const raw1 = await r1.text();
    if (!r1.ok) throw new Error(`OpenAI ${r1.status}: ${raw1.slice(0, 800)}`);

    // 평소엔 여기서 바로 파싱됨
    let json = null;
    try {
      const data = JSON.parse(raw1);
      const content = data?.choices?.[0]?.message?.content;
      json = typeof content === "string" ? JSON.parse(content) : null;
    } catch {
      // content가 코드펜스/잡텍스트 섞였거나 null일 수 있음 → 느슨 파서
      json = parseAIJSONLoose(raw1);
    }

    // 페일오버: 여전히 실패하면 response_format 없이 한 번 더 요청
    if (!json || !Array.isArray(json.words)) {
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
          max_tokens: 800,
        }),
      });
      const raw2 = await r2.text();
      if (!r2.ok) throw new Error(`OpenAI(fo) ${r2.status}: ${raw2.slice(0, 800)}`);
      json = parseAIJSONLoose(raw2);
    }

    if (!json || !Array.isArray(json.words)) {
      console.error("AI raw failed to JSON. sample:", (json ?? raw1)?.slice?.(0, 200) || "[no sample]");
      throw new Error("Invalid JSON from AI");
    }

    const words = sanitizeWords(json.words);
    return res.status(200).json({ words });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
