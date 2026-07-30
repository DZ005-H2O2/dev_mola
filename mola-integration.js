// MOLA 뷰어-에디터 통합 — 손편집 파일.
// index.html(생성 파일)의 전역(state, loadMolecule, parseSDF, setStatus 등)을 직접 쓴다.
// 에디터와는 같은 출처 iframe 이므로 contentWindow.ketcher 를 직접 호출한다
// (설계 문서의 postMessage 표기와 다른 결정 — 계획서 "설계 편차" 참조).
(function () {
  "use strict";

  // Ketcher hiddenControls 로 숨기는 툴바 항목 — 늘어날 수 있어 배열로 관리한다.
  const HIDDEN_CONTROLS = [
    "recognize",      // 이미지→구조 인식 — standalone 환경엔 오프라인 대안이 없어 영구 비활성
    "create-monomer", // 매크로분자(펩타이드/RNA) 전용 — 이 배포판 범위 밖
    // 이미지 첨부 도구 — 사용자 요청으로 제외. 내부 툴바 키는 "image"가 아니라
    // 복수형 "images"다(번들 상수 p.u11 → "images", DOM data-testid도 동일하게
    // "images" — main.4a641a67.js 로 실측 확인). "image" 로는 안 숨겨진다.
    "images",
    // 입체화학 라벨(Enhanced Stereo, R/S·업/다운 플래그) 지정 도구 — 사용자가
    // 이 도메인(반도체 식각·세정 도면)에는 필요 없다고 확인했다. 쐐기(wedge)
    // 결합 자체는 이 키와 무관하게 "결합" 그룹 도구에 그대로 남아 계속 쓸 수
    // 있다 — 숨기는 건 별도의 입체화학 "라벨" 지정 UI뿐이다.
    "enhanced-stereo",
  ];
  const EDITOR_SRC =
    "assets/editor/index.html?hiddenControls=" + HIDDEN_CONTROLS.join(",");
  const READY_TIMEOUT_MS = 60000;

  const ui = {
    mode: "viewer",
    frame: null,          // iframe (첫 에디터 진입 때 생성)
    ketcher: null,        // 준비 완료된 ketcher 인스턴스
    readyPromise: null,
  };

  // ── DOM 구성 ──────────────────────────────────────────────────────
  const appEl = document.querySelector("main.app");
  const heroEl = document.querySelector("header.hero");

  const modebar = document.createElement("nav");
  modebar.className = "modebar";
  modebar.setAttribute("aria-label", "모드 전환");
  // role="tab"/aria-selected 는 실제 tablist/tabpanel 관계 없이는 깨진 ARIA 패턴이라
  // (M7) aria-pressed 토글 버튼으로 바꾼다. 시각 스타일은 CSS 쪽에서 이 속성을 그대로 쓴다.
  modebar.innerHTML =
    '<button type="button" aria-pressed="true" data-mode="viewer">뷰어</button>' +
    '<button type="button" aria-pressed="false" data-mode="editor">에디터</button>';
  // 히어로 *안*에 넣어 별도 줄을 없앤다 — header.hero 는 flex row(align-items:center,
  // flex-wrap:wrap)이고 지금까지 유일한 자식이던 .hero-brand 옆에 두 번째 flex
  // 아이템으로 얹히므로, 히어로 높이는 늘지 않고(.hero-brand 가 이미 더 크다)
  // 그만큼 .work(캔버스 영역)가 세로 공간을 되찾는다. (좁은 화면에서는
  // flex-wrap 덕에 자연스럽게 다음 줄로 내려간다.)
  heroEl.appendChild(modebar);

  const editorWrap = document.createElement("section");
  editorWrap.className = "panel editorwrap";
  editorWrap.id = "molaEditorWrap";
  editorWrap.innerHTML =
    '<div class="editbar">' +
    '  <button id="sendToViewerBtn" class="ghost" type="button">← 뷰어로 보내기</button>' +
    '  <div class="editbar-actions">' +
    '    <button id="periodicToggleBtn" class="ghost" type="button" aria-pressed="false">주기율표</button>' +
    '    <button id="copyImageBtn" class="ghost" type="button" disabled>📋 그림 복사</button>' +
    '    <button id="savePngBtn" class="ghost" type="button" disabled>PNG 저장</button>' +
    '    <button id="saveSvgBtn" class="ghost" type="button" disabled>SVG 저장</button>' +
    '    <button id="saveKetBtn" class="ghost" type="button" disabled>작업본 저장</button>' +
    "  </div>" +
    '  <span class="estatus" id="editorStatus"></span>' +
    "</div>" +
    '<div class="frame-slot" id="editorFrameSlot">' +
    '  <div class="periodic-panel" id="periodicPanel" hidden></div>' +
    '  <div class="frame-msg" id="editorFrameMsg">에디터를 불러오는 중입니다…</div>' +
    "</div>";
  appEl.appendChild(editorWrap);

  modebar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (btn) setMode(btn.dataset.mode);
  });

  // ── 모드 전환 ─────────────────────────────────────────────────────
  function setMode(mode) {
    if (mode !== "viewer" && mode !== "editor") return;
    ui.mode = mode;
    appEl.classList.toggle("mode-editor", mode === "editor");
    modebar.querySelectorAll("button[data-mode]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    });
    // UI(msg/재시도 버튼)가 실패를 이미 표시하므로, 여기서는 중복 unhandled rejection만 막는다.
    // sendToEditor 경유가 아닌 진입(모드 탭 직접 클릭 등)에서만 복구를 묻는다.
    if (mode === "editor") ensureEditor().then((k) => offerRecovery(k)).catch(() => {});
  }

  // ── 자동 임시저장 ─────────────────────────────────────────────────
  // KET(무손실) 마지막 1건만 — 공용 PC 고려(스펙 §1). 실패는 조용히 넘어간다.
  const IDB = { db: "mola-editor", store: "autosave", key: "last" };

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB.db, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB.store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB.store, "readwrite");
      tx.objectStore(IDB.store).put(value, IDB.key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  async function idbGet() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB.store, "readonly");
      const req = tx.objectStore(IDB.store).get(IDB.key);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }
  async function idbDelete() {
    const db = await idbOpen();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB.store, "readwrite");
      tx.objectStore(IDB.store).delete(IDB.key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };   // 저장 실패는 사용자를 막지 않는다
    });
  }

  let autosaveTimer = 0;
  function armAutosave(k) {
    // change 이벤트는 업스트림이 '취약'하다고 표시한 레거시 경로다 — 실패해도 조용히 넘어간다
    try {
      k.editor.subscribe("change", () => {
        // 저장 버튼 활성 상태는 디바운스 없이 즉시 반영 — 자동 임시저장(1.5초 뒤)과는
        // 별개 관심사라 같은 타이머를 공유하지 않는다.
        updateSaveButtonsState();
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(async () => {
          try { await idbSet(await k.getKet()); } catch { /* 조용히 */ }
        }, 1500);
      });
    } catch { /* 구독 실패 — 임시저장 없이 진행 */ }
  }

  // ── 저장 버튼 바 (그림 복사·PNG·SVG·작업본) ──────────────────────
  // 캔버스가 비면 generateImage()가 던지므로(Task 1) 버튼을 선제적으로 비활성화한다.
  // isBlank() 판정 자체가 실패하면 "비어있지 않다"로 간주한다 — sendToEditor의
  // 덮어쓰기 확인(I2)과 같은 안전 쪽 기본값이다: 버튼이 눌려도 되는 상태로 두고,
  // 실제로 비어 있었다면 generateImage가 던지는 에러를 그대로 보여주면 된다.
  const copyImageBtn = document.getElementById("copyImageBtn");
  const savePngBtn = document.getElementById("savePngBtn");
  const saveSvgBtn = document.getElementById("saveSvgBtn");
  const saveKetBtn = document.getElementById("saveKetBtn");

  function updateSaveButtonsState() {
    const k = ui.ketcher;
    let blank = true;
    if (k) {
      try { blank = k.editor.struct().isBlank(); } catch { blank = false; }
    }
    [copyImageBtn, savePngBtn, saveSvgBtn, saveKetBtn].forEach((b) => {
      if (b) b.disabled = blank;
    });
  }

  function pad2(n) { return String(n).padStart(2, "0"); }
  function saveTimestamp() {
    const d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      "-" + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  // 성공 피드백은 몇 초 뒤 스스로 지운다 — 에러 메시지(else 분기들)는 사용자가
  // 다음 조작을 할 때까지 그대로 남겨 원인을 놓치지 않게 한다.
  let saveStatusClearTimer = 0;
  function flashSaveStatus(st, msg) {
    st.textContent = msg;
    clearTimeout(saveStatusClearTimer);
    saveStatusClearTimer = setTimeout(() => {
      if (st.textContent === msg) st.textContent = "";
    }, 2500);
  }

  // ── 주기율표 패널 · 우클릭 팝업 ─────────────────────────────────────
  // Schrödinger Sketcher 의 "우클릭 주기율표"·"패널 주기율표" UX를 이 포크
  // 수정 없이 부모 페이지만으로 재현한다(조사 문서:
  // .superpowers/sdd/periodic-table-ux-options.md). 핵심 호출은 단 한 줄 —
  // k.editor.tool('atom', { label }) — 로, 우측 툴바의 원자 버튼과 Ketcher
  // 자체 주기율표 모달의 "Add"가 내부적으로 수렴하는 지점과 같다(Editor.ts:333).
  // Redux 스토어를 거치지 않아 우측 툴바 자체의 "선택됨" 하이라이트는 갱신되지
  // 않지만(화장품 수준 차이), 실제 동작(다음 클릭에 그 원소가 찍힘)은 정상이다.

  // 자주 쓰는 원소 — 반도체 식각·세정 도면 기준 순서(표준 원자번호 순이 아니다):
  // Si·Ge(식각/세정 대상 반도체), Ti·Al(박막·배선 금속),
  // N·O·F·Cl·S·P(플라즈마 식각·세정 가스 계열의 헤테로 원자), C·H(유기 골격).
  const FREQUENT_ELEMENTS = ["Si", "Ge", "Ti", "Al", "N", "O", "F", "Cl", "S", "P", "C", "H"];

  // 전체 주기율표(18족 표준 배치) — 원자번호 1~118. 란타넘(57~71)·악티넘(89~103)은
  // IUPAC 관용대로 아래 두 줄로 분리해 표를 컴팩트하게 유지한다. 외부 의존
  // 없이 이 파일 안에 하드코딩한다. (무결성: 1~118 정확히 한 번씩 등장 — 스크래치
  // 스크립트로 검증함.)
  const PT_MAIN = [
    [["H", 1], null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, ["He", 2]],
    [["Li", 3], ["Be", 4], null, null, null, null, null, null, null, null, null, null, ["B", 5], ["C", 6], ["N", 7], ["O", 8], ["F", 9], ["Ne", 10]],
    [["Na", 11], ["Mg", 12], null, null, null, null, null, null, null, null, null, null, ["Al", 13], ["Si", 14], ["P", 15], ["S", 16], ["Cl", 17], ["Ar", 18]],
    [["K", 19], ["Ca", 20], ["Sc", 21], ["Ti", 22], ["V", 23], ["Cr", 24], ["Mn", 25], ["Fe", 26], ["Co", 27], ["Ni", 28], ["Cu", 29], ["Zn", 30], ["Ga", 31], ["Ge", 32], ["As", 33], ["Se", 34], ["Br", 35], ["Kr", 36]],
    [["Rb", 37], ["Sr", 38], ["Y", 39], ["Zr", 40], ["Nb", 41], ["Mo", 42], ["Tc", 43], ["Ru", 44], ["Rh", 45], ["Pd", 46], ["Ag", 47], ["Cd", 48], ["In", 49], ["Sn", 50], ["Sb", 51], ["Te", 52], ["I", 53], ["Xe", 54]],
    [["Cs", 55], ["Ba", 56], { ph: "57–71" }, ["Hf", 72], ["Ta", 73], ["W", 74], ["Re", 75], ["Os", 76], ["Ir", 77], ["Pt", 78], ["Au", 79], ["Hg", 80], ["Tl", 81], ["Pb", 82], ["Bi", 83], ["Po", 84], ["At", 85], ["Rn", 86]],
    [["Fr", 87], ["Ra", 88], { ph: "89–103" }, ["Rf", 104], ["Db", 105], ["Sg", 106], ["Bh", 107], ["Hs", 108], ["Mt", 109], ["Ds", 110], ["Rg", 111], ["Cn", 112], ["Nh", 113], ["Fl", 114], ["Mc", 115], ["Lv", 116], ["Ts", 117], ["Og", 118]],
  ];
  const PT_LANTHANIDES = [["La", 57], ["Ce", 58], ["Pr", 59], ["Nd", 60], ["Pm", 61], ["Sm", 62], ["Eu", 63], ["Gd", 64], ["Tb", 65], ["Dy", 66], ["Ho", 67], ["Er", 68], ["Tm", 69], ["Yb", 70], ["Lu", 71]];
  const PT_ACTINIDES = [["Ac", 89], ["Th", 90], ["Pa", 91], ["U", 92], ["Np", 93], ["Pu", 94], ["Am", 95], ["Cm", 96], ["Bk", 97], ["Cf", 98], ["Es", 99], ["Fm", 100], ["Md", 101], ["No", 102], ["Lr", 103]];

  // 원소 기호 → 잉크 색. index.html 의 2D/3D 렌더 팔레트(elementColors, 20종)와
  // 맞춰 패널 색과 실제로 캔버스에 찍힐 원자 색이 일치하게 한다 — 목록에 없는
  // 원소는 기본 잉크색(--ink)을 쓴다. elementColors 는 index.html 인라인
  // <script> 의 top-level const라 이 파일(별도 <script src>, 뒤에 로드)에서도
  // 같은 전역 스크립트 스코프로 그대로 보인다 — state/loadMolecule 등 기존
  // 참조(파일 상단 주석)와 같은 패턴이라 새로 만든 규칙이 아니다.
  function elementInkColor(sym) {
    return elementColors[sym] || "var(--ink)";
  }

  let currentAtomLabel = null;   // 마지막으로 고른 원소 — 패널·팝업 선택 표시 동기화용

  function ptCellButton(sym, z, big) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = big ? "pt-cell pt-cell-big" : "pt-cell";
    b.dataset.ptEl = sym;
    b.style.color = elementInkColor(sym);
    b.title = z ? `${sym} (원자번호 ${z})` : sym;
    const symEl = document.createElement("span");
    symEl.className = "pt-sym";
    symEl.textContent = sym;
    b.appendChild(symEl);
    if (!big && z) {
      const zEl = document.createElement("sup");
      zEl.className = "pt-z";
      zEl.textContent = String(z);
      b.appendChild(zEl);
    }
    b.addEventListener("click", () => selectElement(sym));
    return b;
  }

  function ptPlaceholder(label) {
    const d = document.createElement("div");
    d.className = "pt-cell pt-ph";
    d.textContent = label;
    return d;
  }

  function frequentElementZ(sym) {
    for (const row of PT_MAIN) {
      for (const cell of row) {
        if (Array.isArray(cell) && cell[0] === sym) return cell[1];
      }
    }
    return null;
  }

  // 패널·팝업 둘 다 이 함수로 만든다 — 마크업을 한 곳에서만 관리한다.
  function buildPeriodicTable() {
    const root = document.createElement("div");
    root.className = "periodic-table";

    const freq = document.createElement("div");
    freq.className = "pt-frequent";
    FREQUENT_ELEMENTS.forEach((sym) => {
      freq.appendChild(ptCellButton(sym, frequentElementZ(sym), true));
    });
    root.appendChild(freq);

    const grid = document.createElement("div");
    grid.className = "pt-grid";
    PT_MAIN.forEach((row, r) => {
      row.forEach((cell, c) => {
        let el;
        if (!cell) {
          el = document.createElement("div");
          el.className = "pt-cell pt-empty";
        } else if (cell.ph) {
          el = ptPlaceholder(cell.ph);
        } else {
          el = ptCellButton(cell[0], cell[1], false);
        }
        el.style.gridRow = String(r + 1);
        el.style.gridColumn = String(c + 1);
        grid.appendChild(el);
      });
    });
    // 란타넘·악티넘 — 8행은 빈 여백, 9·10행에 3열부터 배치(위 표의 자리 표시와 정렬)
    [PT_LANTHANIDES, PT_ACTINIDES].forEach((series, i) => {
      series.forEach(([sym, z], c) => {
        const el = ptCellButton(sym, z, false);
        el.style.gridRow = String(9 + i);
        el.style.gridColumn = String(3 + c);
        grid.appendChild(el);
      });
    });
    root.appendChild(grid);
    return root;
  }

  function syncPeriodicSelection() {
    document.querySelectorAll("[data-pt-el]").forEach((el) => {
      el.classList.toggle("selected", el.dataset.ptEl === currentAtomLabel);
    });
  }

  function selectElement(sym) {
    const st = document.getElementById("editorStatus");
    const k = ui.ketcher;
    if (!k) { st.textContent = "에디터가 아직 준비되지 않았습니다."; return; }
    try {
      k.editor.tool("atom", { label: sym });
    } catch (e) {
      st.textContent = "원소를 선택하지 못했습니다: " + (e && e.message ? e.message : e);
      return;
    }
    currentAtomLabel = sym;
    syncPeriodicSelection();
    flashSaveStatus(st, `이제 클릭하면 ${sym} 원자가 찍힙니다.`);
    closePeriodicPopup();
  }

  // ── 패널(상시 오버레이) ───────────────────────────────────────────
  const periodicPanel = document.getElementById("periodicPanel");
  const periodicToggleBtn = document.getElementById("periodicToggleBtn");
  let periodicOpen = false;   // 세션(이 페이지가 떠 있는 동안) 유지 — 새로고침 시 초기화된다

  function setPeriodicOpen(open) {
    periodicOpen = open;
    periodicPanel.hidden = !open;
    periodicToggleBtn.setAttribute("aria-pressed", String(open));
  }

  periodicToggleBtn.addEventListener("click", () => setPeriodicOpen(!periodicOpen));
  periodicPanel.appendChild(buildPeriodicTable());

  // ── 우클릭 팝업 ───────────────────────────────────────────────────
  let popupEl = null;

  function closePeriodicPopup() {
    if (!popupEl) return;
    popupEl.remove();
    popupEl = null;
  }

  function isInsidePopup(target) {
    return !!(popupEl && target && popupEl.contains(target));
  }

  function openPeriodicPopupAt(parentX, parentY) {
    closePeriodicPopup();
    const popup = document.createElement("div");
    popup.className = "periodic-table periodic-popup";
    popup.appendChild(buildPeriodicTable());
    document.body.appendChild(popup);
    // 화면 밖으로 안 나가게 보정 — 먼저 붙여서 실제 크기를 잰다.
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    const maxX = window.innerWidth - pw - 6;
    const maxY = window.innerHeight - ph - 6;
    popup.style.left = Math.max(6, Math.min(parentX, maxX)) + "px";
    popup.style.top = Math.max(6, Math.min(parentY, maxY)) + "px";
    popupEl = popup;
    syncPeriodicSelection();
  }

  // Esc·바깥 클릭으로 닫기 — 팝업은 부모 문서에 살지만 우클릭은 iframe(에디터)
  // 안에서 일어나므로, 부모 document 리스너는 여기(패널·에디바 등 부모 쪽
  // 바깥 클릭)만 담당하고 iframe 쪽은 setupCanvasContextMenu 안에서 별도로 잡는다
  // (iframe 안 클릭은 부모 document 로 버블링되지 않는다 — 별도 document다).
  document.addEventListener("mousedown", (e) => {
    if (popupEl && !isInsidePopup(e.target)) closePeriodicPopup();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePeriodicPopup();
  });

  // ── 에디터 iframe 안 빈 캔버스 우클릭 ────────────────────────────
  // editor.findItem(event, null) 로 "커서 아래 가장 가까운 항목"을 판정한다
  // (ContextMenuTrigger.tsx:122 와 동일한 호출). null(빈 캔버스)일 때만 우리
  // 팝업을 띄우고, 원자·결합 등 항목이 있으면 아무 것도 하지 않아 Ketcher
  // 자체 컨텍스트 메뉴가 그대로 뜨게 둔다 — 절대 가로채지 않는다.
  //
  // MOLA 의 우클릭 드래그 팬(rightButtonPan.ts)은 3px 이상 이동한 뒤의 다음
  // contextmenu 를 clientArea 캡처 단계에서 preventDefault + stopPropagation 으로
  // 삼킨다. **실측 확인(중요, 브리프의 "실제로 테스트" 요구사항)**: stopPropagation
  // 은 캡처 단계에서 호출돼도 이후 target/버블 단계 전체를 끊는다 — Playwright로
  // "우드래그 팬 → 바로 우클릭"을 재현하고, 이 리스너 등록 직후에 같은
  // document 노드에 진단용 리스너를 하나 더 붙여봤더니 팬 케이스에서는 그
  // 진단 리스너조차 단 한 번도 호출되지 않았다(구현 보고서 항목 5 참고) —
  // 즉 이 리스너가 실제로 불리는 시점에는 이미 "팬 직후가 아님"이 보장된다.
  //
  // event.defaultPrevented 를 팬 판별에 그대로 못 쓰는 이유도 같은 실측에서
  // 나왔다: Ketcher 자신의 ContextMenuTrigger(:86)가 빈 캔버스를 포함한 "모든"
  // 정상 우클릭에서 무조건 preventDefault 를 먼저 부르므로, 이 리스너가 정상
  // 도달한 경우(=팬 아님)에도 defaultPrevented 는 이미 true 다 — 이 값을
  // 그대로 게이트로 쓰면 빈 캔버스 우클릭 자체가 항상 막혀 버린다. 그래서
  // "빈 캔버스인가"는 오직 findItem() 으로만 판정한다.
  function setupCanvasContextMenu(frame, k) {
    let doc;
    try {
      doc = frame.contentWindow.document;
    } catch {
      return;   // 접근 불가 — 우클릭 팝업 없이 진행(패널·모달 주기율표는 여전히 동작)
    }
    doc.addEventListener("contextmenu", (e) => {
      let item;
      try {
        item = k.editor.findItem(e, null);
      } catch {
        return;
      }
      if (item) return;   // 원자/결합 등 위 — Ketcher 자체 메뉴에 맡긴다(가로채지 않음)
      e.preventDefault();
      const rect = frame.getBoundingClientRect();
      openPeriodicPopupAt(rect.left + e.clientX, rect.top + e.clientY);
    });
    // iframe 안에서도 클릭/Esc 로 팝업이 닫히게 — 부모 document 리스너는
    // iframe 내부 이벤트를 보지 못한다(별도 document).
    doc.addEventListener("mousedown", (e) => {
      if (popupEl && !isInsidePopup(e.target)) closePeriodicPopup();
    });
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePeriodicPopup();
    });
  }

  // 네 버튼 공통 골격: 준비 확인 → 빈 캔버스 가드 → 개별 동작(fn) → 에러 표면화.
  // fn 안에서 던지는 에러(예: Task 1의 "내보낼 구조가 없습니다")도 여기서 잡는다 —
  // updateSaveButtonsState()의 isBlank() 판정과 실제 클릭 시점 사이에 경합이
  // 있을 수 있어(버튼이 비활성화되기 직전 클릭 등) 이중 방어다.
  async function withSaveGuard(fn) {
    const st = document.getElementById("editorStatus");
    const k = ui.ketcher;
    if (!k) { st.textContent = "에디터가 아직 준비되지 않았습니다."; return; }
    let blank;
    try { blank = k.editor.struct().isBlank(); } catch { blank = false; }
    if (blank) { st.textContent = "캔버스가 비어 있어 저장할 내용이 없습니다."; return; }
    try {
      await fn(k, st);
    } catch (e) {
      st.textContent = e && e.message ? e.message : String(e);
    }
  }

  copyImageBtn.addEventListener("click", () => withSaveGuard(async (k, st) => {
    // 사용자 제스처 체인 보존: clipboard.write를 generateImage 완료 "전"에 호출해야
    // 한다(await 뒤에 호출하면 Safari/Firefox가 제스처 위임이 끊겼다고 보고 거부한다).
    // ClipboardItem 생성자는 Promise 값을 받을 수 있으므로(MDN) generateImage()의
    // Promise를 기다리지 않고 그대로 넘긴다. 일부 브라우저는 이 Promise 형태를
    // 지원하지 않으므로(TypeError 등) 그 경우 기존 await 방식으로 폴백한다.
    const imagePromise = k.generateImage("", { outputFormat: "png" });
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": imagePromise }),
      ]);
      flashSaveStatus(st, "복사했습니다.");
      return;
    } catch (e) {
      // imagePromise 자체가 실패한 거라면(캔버스 문제 등 진짜 에러) 클립보드 미지원이
      // 아니므로 그대로 전파해 withSaveGuard가 원인 메시지를 보여주게 한다.
      const settled = await Promise.allSettled([imagePromise]);
      if (settled[0].status === "rejected") throw settled[0].reason;
    }
    // 여기 도달 = Promise 값을 받는 ClipboardItem을 브라우저가 지원하지 않는 경우
    // (예: 구버전 Firefox) — 완성된 Blob으로 다시 시도한다.
    try {
      const blob = await imagePromise;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flashSaveStatus(st, "복사했습니다.");
    } catch {
      // 클립보드 API는 보안 컨텍스트/권한이 없으면 실패한다 — PNG 저장으로 안내
      st.textContent = "클립보드를 쓸 수 없습니다 — PNG 저장을 이용하세요.";
    }
  }));

  savePngBtn.addEventListener("click", () => withSaveGuard(async (k, st) => {
    const blob = await k.generateImage("", { outputFormat: "png" });
    downloadBlob(blob, `그린_구조_${saveTimestamp()}.png`);
    flashSaveStatus(st, "저장했습니다.");
  }));

  saveSvgBtn.addEventListener("click", () => withSaveGuard(async (k, st) => {
    const blob = await k.generateImage("", { outputFormat: "svg" });
    downloadBlob(blob, `그린_구조_${saveTimestamp()}.svg`);
    flashSaveStatus(st, "저장했습니다.");
  }));

  saveKetBtn.addEventListener("click", () => withSaveGuard(async (k, st) => {
    const ket = await k.getKet();
    downloadBlob(new Blob([ket], { type: "application/json" }), `그린_구조_${saveTimestamp()}.ket`);
    flashSaveStatus(st, "저장했습니다.");
  }));

  let recoveryDone = false;
  async function offerRecovery(k) {
    // 복구는 '명시적 보내기 없이' 에디터에 처음 들어왔을 때만 묻는다.
    // 편집으로 보내기로 들어온 경우 사용자의 명시적 의도가 우선이다.
    if (recoveryDone) return;
    recoveryDone = true;
    let saved = null;
    try { saved = await idbGet(); } catch { return; }
    if (!saved) return;
    if (window.confirm("이전에 그리던 구조가 있습니다. 복구할까요?\n(취소하면 저장본은 삭제됩니다)")) {
      try { await k.setMolecule(saved); } catch { /* 복구 실패 — 빈 캔버스, 사용자를 막지 않는다 */ }
      updateSaveButtonsState();   // setMolecule이 change 이벤트를 안 낼 수도 있어 직접 반영
    } else {
      await idbDelete();
    }
  }

  // ── 에디터 iframe 생성·준비 감지 ──────────────────────────────────
  function ensureEditor() {
    if (ui.readyPromise) return ui.readyPromise;
    ui.readyPromise = createEditor();
    return ui.readyPromise;
  }

  function createEditor() {
    return new Promise((resolve, reject) => {
      const slot = document.getElementById("editorFrameSlot");
      const msg = document.getElementById("editorFrameMsg");
      msg.hidden = false;
      msg.textContent = "에디터를 불러오는 중입니다…";

      const frame = document.createElement("iframe");
      frame.id = "molaEditorFrame";
      frame.title = "구조 편집기";
      frame.src = EDITOR_SRC;
      slot.appendChild(frame);
      ui.frame = frame;

      let settled = false;
      const finish = (k) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(watchdog);
        window.removeEventListener("message", onMsg);
        ui.ketcher = k;
        msg.hidden = true;
        armAutosave(k);
        updateSaveButtonsState();   // 새 에디터는 보통 빈 캔버스로 시작 — 버튼 비활성화 반영
        setupCanvasContextMenu(frame, k);   // 빈 캔버스 우클릭 → 주기율표 팝업
        resolve(k);
      };
      const fail = (why) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(watchdog);
        window.removeEventListener("message", onMsg);
        ui.readyPromise = null;          // 재시도 가능하게 초기화
        frame.remove();
        ui.frame = null;
        msg.hidden = false;
        msg.innerHTML = "";
        const p = document.createElement("div");
        p.textContent = "에디터를 불러오지 못했습니다: " + why;
        const retry = document.createElement("button");
        retry.className = "ghost";
        retry.type = "button";
        retry.textContent = "다시 시도";
        // UI(msg/재시도 버튼)가 실패를 이미 표시하므로, 여기서는 중복 unhandled rejection만 막는다.
        // (I1) 재시도도 "명시적 보내기 없이" 들어오는 진입이므로 setMode("editor")와
        // 동일하게 복구를 물어야 한다 — 안 그러면 재시도 후 첫 편집의 자동 임시저장이
        // 이전 세션의 백업을 조용히 덮어쓴다. offerRecovery 는 아래에서 function 선언으로
        // 정의돼 호이스팅되므로 여기서 참조해도 안전하다.
        retry.addEventListener("click", () => {
          msg.textContent = "";
          ensureEditor().then((k) => offerRecovery(k)).catch(() => {});
        });
        msg.append(p, retry);
        reject(new Error(why));
      };

      // 준비 신호 1: 에디터가 onInit 에서 보내는 postMessage({eventType:'init'})
      const onMsg = (e) => {
        if (e.source === frame.contentWindow && e.data && e.data.eventType === "init") {
          tryGrab();
        }
      };
      window.addEventListener("message", onMsg);
      // 준비 신호 2: contentWindow.ketcher 폴링 (verify-app.mjs 와 같은 패턴)
      const tryGrab = () => {
        try {
          const k = frame.contentWindow && frame.contentWindow.ketcher;
          if (k) finish(k);
        } catch { /* 접근 불가 시 다음 폴링 */ }
      };
      const poll = setInterval(tryGrab, 200);
      const watchdog = setTimeout(() => fail("시간 초과(60초)"), READY_TIMEOUT_MS);
    });
  }

  function whenEditorReady() { return ensureEditor(); }

  // ── 뷰어 → 에디터 ─────────────────────────────────────────────────
  // loadMolecule 래핑: 새 분자가 로드될 때마다
  //  (1) 이전 분자의 표시-좌표 캡처를 무효화하고 (렌더 성공 시 다시 채워진다)
  //  (2) 에디터발 구조가 아니면 3D/2D 분할을 원상 복구하고
  //  (3) 보내기 버튼 활성 상태를 맞춘다
  const origLoadMolecule = window.loadMolecule;
  window.loadMolecule = function (molecule, message, dailyKey) {
    state.rdkitMolblock = null;
    origLoadMolecule(molecule, message, dailyKey);
    if (!molecule.__fromEditor) {
      document.getElementById("stageWrap").dataset.mode = "split";
    }
    sendBtn.disabled = !state.molecule;
  };

  const sendBtn = document.createElement("button");
  sendBtn.id = "sendToEditorBtn";
  sendBtn.className = "ghost";
  sendBtn.type = "button";
  sendBtn.textContent = "편집으로 보내기 →";
  sendBtn.disabled = !state.molecule;
  document.querySelector(".workbar .search").appendChild(sendBtn);
  sendBtn.addEventListener("click", () => { sendToEditor(); });

  async function sendToEditor() {
    const mol = state.molecule;
    if (!mol) return;
    // 화면에 그린 좌표(rdkitMolblock)를 우선, 없으면(폴백 렌더) 원본 2D molblock
    const molblock = state.rdkitMolblock || mol.molblock2d;
    if (!molblock) { setStatus("보낼 2D 구조가 없습니다.", false); return; }
    // (M6) 위 가드를 통과한 뒤에만 세운다 — 가드에 걸려 아무 일도 안 한 호출이
    // 세션의 복구 프롬프트를 영구히 꺼버리면 안 된다.
    recoveryDone = true;   // 명시적 보내기 — 복구 프롬프트를 건너뛴다
    setMode("editor");
    const st = document.getElementById("editorStatus");
    st.textContent = "구조를 싣는 중…";
    try {
      const k = await whenEditorReady();
      // (I2) 에디터에 이미 그리던 구조가 있으면 덮어쓰기 전에 확인한다 — 그렇지 않으면
      // 편집 중이던 유일한 사본(자동 임시저장 포함)이 setMolecule 한 줄로 조용히
      // 사라진다. isBlank()는 ketcher-core Struct의 공개 API이고(구조 자체가
      // 마이크로몰레큘 에디터 안에서도 같은 패턴으로 이미 쓰인다), 판정 자체가
      // 실패하면 데이터 손실 쪽보다 안전하게 "비어있지 않다"로 간주해 사용자에게 묻는다.
      let isBlank;
      try {
        isBlank = k.editor.struct().isBlank();
      } catch {
        isBlank = false;
      }
      if (!isBlank && !window.confirm("에디터에 그리던 구조가 있습니다. 덮어쓸까요?")) {
        st.textContent = "";
        return;
      }
      await k.setMolecule(molblock);
      updateSaveButtonsState();   // setMolecule이 change 이벤트를 안 낼 수도 있어 직접 반영
      // setMolecule 은 실패해도 undefined 로 resolve 한다 — 원자 수로 성공을 판정
      const back = await k.getMolfile("v2000").catch(() => "");
      const ok = /V2000/.test(back) && parseSDF(back, "", "").atoms.length > 0;
      st.textContent = ok ? "" : "구조를 싣지 못했습니다 — 빈 캔버스로 시작합니다.";
    } catch (e) {
      st.textContent = "전달 실패: " + (e && e.message ? e.message : e);
    }
  }

  // ── 에디터 → 뷰어 ─────────────────────────────────────────────────
  async function sendToViewer() {
    const k = ui.ketcher;
    const st = document.getElementById("editorStatus");
    if (!k) {
      // (M1) 조용히 무시하면 사용자는 클릭이 씹혔는지 알 수 없다
      st.textContent = "에디터가 아직 준비되지 않았습니다.";
      return;
    }
    // 반응식은 molfile 로 표현되지 않는다 — throw 전에 미리 검사해 이유를 설명
    if (k.containsReaction()) {
      st.textContent = "반응식은 뷰어로 보낼 수 없습니다 — molfile 로 표현되지 않습니다. 저장 탭의 이미지 저장을 이용하세요.";
      return;
    }
    let molblock;
    try {
      molblock = await k.getMolfile("v2000");
    } catch (e) {
      // R-라벨 등 molfile 저장 불가 케이스 — Ketcher 의 사유를 그대로 보여준다
      st.textContent = "뷰어로 보낼 수 없습니다: " + (e && e.message ? e.message : e);
      return;
    }
    let parsed;
    try {
      parsed = parseSDF(molblock, "그린 구조", "에디터");
    } catch (e) {
      st.textContent = "구조를 해석하지 못했습니다: " + (e && e.message ? e.message : e);
      return;
    }
    if (!parsed.atoms.length) {
      st.textContent = "캔버스가 비어 있습니다.";
      return;
    }
    st.textContent = "";
    parsed.molblock2d = molblock;
    parsed.__fromEditor = true;
    const editorStatusMessage = "에디터에서 가져온 구조 — 3D 좌표가 없어 2D만 표시합니다.";
    loadMolecule(parsed, editorStatusMessage);
    // 설계: 3D 창은 비운다. only2d 는 기존 CSS 에 이미 있는(지금까지 죽은) 분기다
    document.getElementById("stageWrap").dataset.mode = "only2d";
    // (M2) loadMolecule 내부에서 flat && cannotBePlanar 분기가 이 메시지보다 먼저
    // setStatus를 부를 수 있다 — 그린 구조는 z좌표가 없어 거의 항상 flat이고, sp3
    // 중심이 있으면 "평면 좌표로 표시 중…" 경고가 이 메시지를 덮어써 버린다.
    // statusPinned는 loadMolecule이 이미 true로 세워뒀지만(message가 있어서), 명시적으로
    // 다시 고정한 뒤 우리 메시지로 마지막에 덮어써 최종 표시를 확정한다.
    state.statusPinned = true;
    setStatus(editorStatusMessage);
    setMode("viewer");
  }
  document.getElementById("sendToViewerBtn").addEventListener("click", () => { sendToViewer(); });

  // ── 공개 표면 ─────────────────────────────────────────────────────
  window.molaIntegration = {
    setMode,
    getMode: () => ui.mode,
    whenEditorReady,
    sendToEditor,
    sendToViewer,
  };
})();
