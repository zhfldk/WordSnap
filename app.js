// 표 60칸 생성 (1~30, 31~60)
const tbody = document.getElementById("vocab-body");
for (let i = 1; i <= 30; i++) {
  const r = i + 30;
  tbody.insertAdjacentHTML("beforeend", `
    <tr>
      <td>${i}</td><td contenteditable></td><td contenteditable></td>
      <td>${r}</td><td contenteditable></td><td contenteditable></td>
    </tr>
  `);
}

const imageInput = document.getElementById("imageInput");
const btnAnalyze = document.getElementById("btnAnalyze");
const btnPdf = document.getElementById("btnPdf");
const statusEl = document.getElementById("status");

// 발음 보관(표시X)
let pronunciations = new Map();

// 클라 리사이즈(413 방지 & 가독성↑)
async function compressImage(file, { maxW = 2000, maxH = 2000, quality = 0.9, mime = "image/jpeg" } = {}) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = Math.round(img.width * ratio), h = Math.round(img.height * ratio);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  const blob = await new Promise(r => c.toBlob(r, mime, quality));
  return new File([blob], (file.name || "image") + ".jpg", { type: mime, lastModified: Date.now() });
}

// 무료 사전 뜻/발음
async function fetchDict(word) {
  try {
    const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!r.ok) return { meaning: "", ipa: "" };
    const j = await r.json();
    const entry = j?.[0];
    const meaning = entry?.meanings?.[0]?.definitions?.[0]?.definition || "";
    const ipa = (entry?.phonetics || []).map(p => p?.text).filter(Boolean)[0] || "";
    return { meaning, ipa };
  } catch { return { meaning: "", ipa: "" }; }
}

// 서버 호출: 이미지 → 단어 60개
async function extractWordsViaServer(file) {
  const fd = new FormData();
  fd.append("image", file, file.name || "upload.jpg"); // ← 이름까지 명시
  const res = await fetch("/api/extract", { method: "POST", body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  const data = JSON.parse(text);
  return Array.isArray(data.words) ? data.words : [];
}

// 표 채우기
async function fillTable(words, doTranslate) {
  pronunciations.clear();
  const wordCells = tbody.querySelectorAll("td:nth-child(2), td:nth-child(5)");
  const meaningCells = tbody.querySelectorAll("td:nth-child(3), td:nth-child(6)");

  for (let i = 0; i < wordCells.length; i++) {
    wordCells[i].textContent = "";
    meaningCells[i].textContent = "";
  }
  for (let i = 0; i < Math.min(words.length, wordCells.length); i++) {
    const w = (words[i] || "").trim();
    if (!w) continue;
    wordCells[i].textContent = w;
    const { meaning, ipa } = await fetchDict(w);
    pronunciations.set(w, ipa);
    if (doTranslate) meaningCells[i].textContent = meaning || "";
  }
}

// 버튼 동작
btnAnalyze.addEventListener("click", async () => {
  const f = imageInput.files?.[0];
  if (!f) return alert("이미지를 업로드하세요.");
  btnAnalyze.disabled = true; btnPdf.disabled = true;
  statusEl.textContent = "이미지 전처리 중…";
  try {
    const small = await compressImage(f, { maxW: 2000, maxH: 2000, quality: 0.9 });
    statusEl.textContent = "AI 분석 중…";
    const words = await extractWordsViaServer(small);
    statusEl.textContent = `단어 ${words.length}개 발견. 사전 조회 중…`;
    await fillTable(words, document.getElementById("doTranslate").checked);
    statusEl.textContent = "완료";
  } catch (e) {
    console.error(e);
    statusEl.textContent = "실패: " + (e.message || e);
    alert("실패: " + (e.message || e));
  } finally {
    btnAnalyze.disabled = false; btnPdf.disabled = false;
  }
});

// PDF (발음 제외)
btnPdf.addEventListener("click", () => {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setFontSize(14);
  doc.text("단어장", 40, 40);

  const rows = [];
  tbody.querySelectorAll("tr").forEach(tr => {
    const t = tr.querySelectorAll("td");
    rows.push([t[0].innerText, t[1].innerText, t[2].innerText, t[3].innerText, t[4].innerText, t[5].innerText]);
  });

  doc.autoTable({
    head: [['#','단어','뜻','#','단어','뜻']],
    body: rows,
    startY: 60,
    styles: { fontSize: 10, cellPadding: 4 },
    headStyles: { fillColor: [240,240,240], textColor: 20 }
  });
  doc.save("WordSnap_단어장_60.pdf");
});
