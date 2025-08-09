// /api/ko_meanings.js
export const config = { api: { bodyParser: true } };

function strictJSON(text) {
  if (!text) return null;
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const words = Array.isArray(req.body?.words) ? req.body.words.filter(Boolean) : [];
    if (!words.length) return res.status(400).json({ error: "No words" });

    const prompt = `Return ONLY compact JSON with Korean meanings:
{"items":[{"word":"string","meaning_ko":"string"}]}
Rules:
- Input is English vocabulary words (no sentences).
- Provide the most common Korean dictionary meaning for each word (짧고 일반적인 의미).
- Do NOT add romanization or pronunciation. Do NOT add examples. Do NOT add POS.`;

    const messages = [
      { role: "system", content: "You translate English vocabulary into short Korean dictionary meanings. Return only JSON." },
      { role: "user", content: [{ type: "text", text: prompt + "\nWords:\n" + words.join(", ") }] }
    ];

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
        max_tokens: 1200,
      }),
    });

    const raw = await r.text();
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${raw.slice(0, 600)}`);

    let data = null;
    try {
      const j = JSON.parse(raw);
      const content = j?.choices?.[0]?.message?.content;
      data = typeof content === "string" ? JSON.parse(content) : null;
    } catch {
      data = strictJSON(raw);
    }
    if (!data || !Array.isArray(data.items)) throw new Error("Invalid JSON from AI");

    const map = new Map((data.items || []).map(it => [String(it.word || "").toLowerCase(), String(it.meaning_ko || "").trim()]));
    const out = words.map(w => ({ word: w, meaning_ko: map.get(String(w).toLowerCase()) || "" }));

    res.status(200).json({ items: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
