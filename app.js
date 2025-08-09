/* =========================
   WordSnap app.js (index.html 맞춤)
   - IPA/영어사전 없음
   - "뜻 자동 채우기" 체크박스만 사용
   - OCR에 한국어 뜻 있으면 복사, 없으면 (있다면) /api/ko_meanings로 한국어 채움
   - 세로 우선(1~30, 31~60)
   - jsPDF + 한글 폰트 임베드 (NotoSansKR-Regular.ttf)
   ========================= */

// ----- 표 60칸 생성 (1~30, 31~60) -----
const tbody = document.getElementById("vocab-body");
for (let i = 1; i <= 30; i++) {
  const r = i + 30;
  tbody.insertAdjacentHTML("beforeend", `
    <tr>
      <td>${i}</td><td></td><td contenteditable></td>
      <td>${r}</td><td></td><td contenteditable></td>
    </tr>
  `);
}

// ----- 요소 -----
const imageInput = document.getElementById("imageInput");
const btnAnalyze = document.getElementById("btnAnalyze");
const btnPdf = document.getElementById("btnPdf");
const statusEl = document.getElementById("status");
const doTranslateEl = document.getElementById("doTranslate");

// ----- 유틸: 이미지 리사이즈(413 방지) -----
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

// ----- 서버: 이미지 → [{word, meaning_ko?}] -----
async function extractItemsViaServer(file) {
  const fd = new FormData();
  fd.append("image", file, file.name || "upload.jpg");
  const res = await fetch("/api/extract", { method: "POST", body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  const data = JSON.parse(text);
  return Array.isArray(data.items) ? data.items : [];
}

// ----- (있으면 사용) GPT 배치 한국어 뜻 -----
async function fetchKoMeaningsBatch(words) {
  try {
    const r = await fetch("/api/ko_meanings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || "ko_meanings error");
    const map = new Map((j.items || []).map(it => [String(it.word || "").toLowerCase(), it.meaning_ko || ""]));
    return (w) => map.get(String(w).toLowerCase()) || "";
  } catch {
    // 라우트가 없거나 실패 → 빈 함수 반환
    return () => "";
  }
}

// ----- 표 채우기 (세로 우선) -----
async function fillVertical(items, doTranslate) {
  const Lw = Array.from(tbody.querySelectorAll("tr td:nth-child(2)"));
  const Lm = Array.from(tbody.querySelectorAll("tr td:nth-child(3)"));
  const Rw = Array.from(tbody.querySelectorAll("tr td:nth-child(5)"));
  const Rm = Array.from(tbody.querySelectorAll("tr td:nth-child(6)"));
  [...Lw, ...Lm, ...Rw, ...Rm].forEach(td => td.textContent = "");

  const words = items.map(it => it.word).slice(0, 60);
  const meaningsFromOCR = items.map(it => it.meaning_ko || "").slice(0, 60);
  const rows = 30;

  // 번역이 켜져 있고, OCR에 한국어가 없는 단어들만 모아 배치 요청
  let getKo = null;
  if (doTranslate) {
    const need = [];
    for (let i = 0; i < words.length; i++) {
      const m = meaningsFromOCR[i];
      if (!(m && /[가-힣]/.test(m))) need.push(words[i]);
    }
    if (need.length) getKo = await fetchKoMeaningsBatch(words);
  }

  async function fillOne(tdWord, tdMean, idx) {
    const w = (words[idx] || "").trim();
    if (!w) return;

    tdWord.textContent = w;

    if (!doTranslate) { tdMean.textContent = ""; return; }

    // 1) OCR에서 이미 한국어 뜻이 있으면 그대로 사용
    const fromOCR = meaningsFromOCR[idx];
    if (fromOCR && /[가-힣]/.test(fromOCR)) {
      tdMean.textContent = fromOCR;
      return;
    }
    // 2) 없으면 배치 결과에서 가져오기(라우트 없으면 빈값)
    const ko = getKo ? getKo(w) : "";
    tdMean.textContent = ko || "";
  }

  for (let i = 0; i < rows && i < words.length; i++) await fillOne(Lw[i], Lm[i], i);
  for (let j = 0; j < rows; j++) {
    const idx = rows + j;
    if (idx >= words.length) break;
    await fillOne(Rw[j], Rm[j], idx);
  }
}

// ----- 버튼: 분석 -----
btnAnalyze.addEventListener("click", async () => {
  const f = imageInput.files?.[0];
  if (!f) return alert("이미지를 업로드하세요.");

  const doTranslate = !!doTranslateEl?.checked;

  btnAnalyze.disabled = true; btnPdf.disabled = true;
  statusEl.textContent = "이미지 전처리 중…";
  try {
    const small = await compressImage(f, { maxW: 2000, maxH: 2000, quality: 0.9 });
    statusEl.textContent = "AI 분석 중…";
    const items = await extractItemsViaServer(small); // [{word, meaning_ko?}]
    statusEl.textContent = `단어 ${items.length}개 발견. 표 채우는 중…`;
    await fillVertical(items, doTranslate);
    statusEl.textContent = "완료";
  } catch (e) {
    console.error(e);
    statusEl.textContent = "실패: " + (e.message || e);
    alert("실패: " + (e.message || e));
  } finally {
    btnAnalyze.disabled = false; btnPdf.disabled = false;
  }
});

btnPdf?.addEventListener("click", () => { // async 필요 없음
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  doc.setFont("NotoSansKR", "normal");
  doc.setFontSize(14);
  doc.text("WordSnap", 40, 40);

  const rows = [];
  tbody.querySelectorAll("tr").forEach(tr => {
    const t = tr.querySelectorAll("td");
    rows.push([
      t[0].innerText,
      t[1].textContent || "",
      t[2].innerText,
      t[3].innerText,
      t[4].textContent || "",
      t[5].innerText
    ]);
  });

  // 표 내부까지 한글 폰트 강제 적용
  doc.autoTable({
    head: [['#', '단어', '뜻', '#', '단어', '뜻']],
    body: rows,
    startY: 60,
    styles: { font: 'NotoSansKR', fontSize: 10, cellPadding: 4 },
    headStyles: { font: 'NotoSansKR', fillColor: [240, 240, 240], textColor: 20 },
    // styles에 font가 지정되어 있으므로 bodyStyles는 생략 가능
  });

  doc.save("WordSnap_단어장.pdf");
});
