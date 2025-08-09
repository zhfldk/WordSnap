/* =========================
   WordSnap app.js (NO IPA/DICT)
   - 세로 우선 채우기
   - 1단계/2단계 옵션(뜻 자동/이미지에 뜻 여부)
   - PDF 한글 폰트 임베드 (NotoSansKR-VariableFont_wght.ttf)
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

// ----- 요소 참조 -----
const imageInput = document.getElementById("imageInput");
const btnAnalyze = document.getElementById("btnAnalyze");
const btnPdf = document.getElementById("btnPdf");
const statusEl = document.getElementById("status");

// 1단계/2단계 라디오 (없으면 안전 처리)
const step1Radios = document.querySelectorAll('input[name="step1"]');
const step2Box = document.getElementById("step2Box");

// ----- 2단계 on/off 동기화 -----
function syncStep2() {
  if (!step1Radios.length || !step2Box) return;
  const step1 = document.querySelector('input[name="step1"]:checked')?.value || "on";
  const on = step1 === "on";
  step2Box.style.opacity = on ? "1" : ".5";
  step2Box.style.pointerEvents = on ? "auto" : "none";
}
step1Radios.forEach(r => r.addEventListener("change", syncStep2));
syncStep2();

// ----- 이미지 리사이즈(413 방지 & 가독성↑) -----
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

// ----- 서버 호출: 이미지 → [{word, meaning_ko|null|""}] -----
async function extractItemsViaServer(file) {
  const fd = new FormData();
  fd.append("image", file, file.name || "upload.jpg");
  const res = await fetch("/api/extract", { method: "POST", body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  const data = JSON.parse(text);
  return Array.isArray(data.items) ? data.items : [];
}

// ----- (선택) GPT 배치 한국어 뜻 요청: /api/ko_meanings 있을 때만 사용 -----
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
    return () => ""; // 라우트가 없으면 빈 함수
  }
}

// ----- 세로 우선 채우기 (1단계/2단계 반영) -----
async function fillVerticalWithOptions(items, doTranslate, hasMeaningInImage) {
  const Lw = Array.from(tbody.querySelectorAll("tr td:nth-child(2)"));
  const Lm = Array.from(tbody.querySelectorAll("tr td:nth-child(3)"));
  const Rw = Array.from(tbody.querySelectorAll("tr td:nth-child(5)"));
  const Rm = Array.from(tbody.querySelectorAll("tr td:nth-child(6)"));
  [...Lw, ...Lm, ...Rw, ...Rm].forEach(td => td.textContent = "");

  const words = items.map(it => it.word).slice(0, 60);
  const meaningsFromItems = items.map(it => it.meaning_ko || "").slice(0, 60);
  const rows = 30;

  // “뜻 자동 ON && 이미지에 뜻 없음” → (있다면) /api/ko_meanings 배치 사용
  let getKo = null;
  if (doTranslate && !hasMeaningInImage) {
    getKo = await fetchKoMeaningsBatch(words);
  }

  async function fillOne(tdWord, tdMean, idx) {
    const w = (words[idx] || "").trim();
    if (!w) return;

    // 단어 채움 (IPA/사전 호출 없음)
    tdWord.textContent = w;

    if (!doTranslate) return; // 1단계 OFF → 뜻 비워둠

    if (hasMeaningInImage) {
      // 이미지에 한국어 뜻이 있는 경우 → OCR/extract 결과 사용
      tdMean.textContent = meaningsFromItems[idx] || "";
    } else {
      // 이미지에 뜻이 없는 경우
      const fromExtract = meaningsFromItems[idx];
      if (fromExtract && /[가-힣]/.test(fromExtract)) {
        tdMean.textContent = fromExtract;
      } else {
        const fromBatch = getKo ? getKo(w) : "";
        tdMean.textContent = fromBatch || "";
      }
    }
  }

  // 왼쪽 1~30
  for (let i = 0; i < rows && i < words.length; i++) {
    await fillOne(Lw[i], Lm[i], i);
  }
  // 오른쪽 31~60
  for (let j = 0; j < rows; j++) {
    const idx = rows + j;
    if (idx >= words.length) break;
    await fillOne(Rw[j], Rm[j], idx);
  }
}

// ----- 버튼 동작 -----
btnAnalyze.addEventListener("click", async () => {
  const f = imageInput.files?.[0];
  if (!f) return alert("이미지를 업로드하세요.");

  const step1 = document.querySelector('input[name="step1"]:checked')?.value || "on";     // 뜻 자동
  const step2 = document.querySelector('input[name="step2"]:checked')?.value || "exists"; // 이미지에 뜻 있음/없음
  const doTranslate = step1 === "on";
  const hasMeaningInImage = step2 === "exists";

  btnAnalyze.disabled = true; btnPdf.disabled = true;
  statusEl.textContent = "이미지 전처리 중…";
  try {
    const small = await compressImage(f, { maxW: 2000, maxH: 2000, quality: 0.9 });
    statusEl.textContent = "AI 분석 중…";
    const items = await extractItemsViaServer(small);
    statusEl.textContent = `단어 ${items.length}개 발견. 표 채우는 중…`;
    await fillVerticalWithOptions(items, doTranslate, hasMeaningInImage);
    statusEl.textContent = "완료";
  } catch (e) {
    console.error(e);
    statusEl.textContent = "실패: " + (e.message || e);
    alert("실패: " + (e.message || e));
  } finally {
    btnAnalyze.disabled = false; btnPdf.disabled = false;
  }
});

// ===== PDF (jsPDF + 한글 폰트 임베드) =====

// 브라우저에서 ttf를 읽어 base64로 변환
async function toBase64FromUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Font fetch failed: " + resp.status);
  const buf = await resp.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// 한글 폰트 등록(한 번만)
async function ensureKoreanFont(doc) {
  if (window.__ws_font_loaded) return;
  // 네가 업로드한 파일 경로 사용
  const fontPath = "/fonts/NotoSansKR-VariableFont_wght.ttf";
  const b64 = await toBase64FromUrl(fontPath);
  doc.addFileToVFS("NotoSansKR.ttf", b64);
  doc.addFont("NotoSansKR.ttf", "NotoSansKR", "normal");
  window.__ws_font_loaded = true;
}

btnPdf?.addEventListener("click", async () => {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  // 한글 폰트 임베드
  try {
    await ensureKoreanFont(doc);
    doc.setFont("NotoSansKR", "normal");
  } catch (e) {
    console.warn("Korean font load failed; PDF may show broken Hangul.", e);
  }

  doc.setFontSize(14);
  doc.text("WordSnap 단어장", 40, 40);

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

  doc.autoTable({
    head: [['#','단어','뜻','#','단어','뜻']],
    body: rows,
    startY: 60,
    styles: { fontSize: 10, cellPadding: 4 },
    headStyles: { fillColor: [240,240,240], textColor: 20 }
  });
  doc.save("WordSnap_단어장_60.pdf");
});
