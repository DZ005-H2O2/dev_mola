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
    // ET 트리(아래 extended-table) 첫 항목 "A"(임의의 원자) 하나만을 위한
    // 전용 지름길 버튼 — 아래 새로 추가한 "일반 원자" 패널 줄의 A 버튼이
    // 완전히 같은 결과(editor.tool('atom',{label:'A',pseudo:'A',type:'gen'}))를
    // 내므로 중복이다. 숨겨도 기능 손실이 없다(조사: .superpowers/sdd/
    // sketcher-ui-parity.md §2).
    "any-atom",
    // Extended Table 모달 — 7그룹 34개 QSAR/약물화학 계열 쿼리원자(ALK, ARY,
    // HAR 등)가 중첩 트리로 잔뜩 나열되는 팝업. 사용자가 "잡다하다"고 느낀
    // 대상 그 자체이며, 실제로 자주 쓸 A/Q/M/X/R 은 새 "일반 원자" 패널
    // 줄로 대체했다(주기율표 패널 참고). period-table(진짜 118원소 주기율표)
    // 과는 별개 팝업이라 이건 숨겨도 주기율표 기능에는 영향이 없다.
    "extended-table",
    // R-group 도구 3종 + 부모 드롭다운 — 사용자가 "안 쓸 것 같다"고 제거 결정
    // (2026-08-10). 하위 3개가 전부 숨겨지면 부모 버튼(rgroup)도 자동으로
    // 사라지지만(ToolbarMultiToolItem 의 allInnerItemsHidden) 명시적으로 넷 다
    // 나열한다. 숨기면 Mod+R 계열 단축키도 함께 비활성화된다(hotkeys.ts 의
    // isActionDisabledOrHidden). 되돌리려면 이 4줄만 지우면 된다.
    "rgroup",
    "rgroup-label",
    "rgroup-fragment",
    "rgroup-attpoints",
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
    // 빠른 토글 묶음 — "설정"이지 "액션"이 아니므로 큰 버튼들과 시각적으로 분리
    // (테두리 상자 + 정사각 아이콘 버튼). 자주 쓰는 토글이 늘면 여기에 추가.
    '  <div class="editbar-quick" role="group" aria-label="빠른 설정 토글">' +
    '    <button id="snapAngleBtn" class="quick-toggle" type="button" aria-pressed="true"' +
    '            title="각도 스냅 — 그리기·드래그 회전을 15° 단위로 딸깍 (드래그 중 Alt = 임시 해제)">∠</button>' +
    '    <button id="snapLengthBtn" class="quick-toggle" type="button" aria-pressed="true"' +
    '            title="길이 고정 — 그릴 땐 표준 결합 길이, 드래그 회전 땐 원래 길이 유지 (드래그 중 Alt = 임시 해제)">↔</button>' +
    "  </div>" +
    '  <div class="editbar-actions">' +
    '    <button id="periodicToggleBtn" class="ghost" type="button" aria-pressed="false">주기율표</button>' +
    '    <span class="split-btn">' +
    '      <button id="copyImageBtn" class="ghost" type="button" disabled>📋 그림 복사</button>' +
    '      <button id="copyImageMenuBtn" class="ghost split-caret" type="button" disabled' +
    '              aria-label="복사 형식 선택">▾</button>' +
    "    </span>" +
    '    <span class="split-btn">' +
    '      <button id="saveImageBtn" class="ghost" type="button" disabled>💾 그림 저장</button>' +
    '      <button id="saveImageMenuBtn" class="ghost split-caret" type="button" disabled' +
    '              aria-label="저장 형식 선택">▾</button>' +
    "    </span>" +
    "  </div>" +
    '  <span class="estatus" id="editorStatus"></span>' +
    "</div>" +
    '<div class="frame-slot" id="editorFrameSlot">' +
    '  <div class="periodic-panel" id="periodicPanel" hidden></div>' +
    '  <div class="editor-tips" id="editorTips" hidden></div>' +
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
      k.editor.subscribe("change", (changeData) => {
        // 저장 버튼 활성 상태는 디바운스 없이 즉시 반영 — 자동 임시저장(1.5초 뒤)과는
        // 별개 관심사라 같은 타이머를 공유하지 않는다.
        updateSaveButtonsState();
        // 스페이스바 "마지막 분자 선택" 기능(아래 주기율표 섹션)이 쓸 최근 조작
        // 원자 추적 — 같은 change 구독을 재사용한다(새 구독을 늘리지 않음).
        trackLastTouchedAtom(k, changeData);
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(async () => {
          try { await idbSet(await k.getKet()); } catch { /* 조용히 */ }
        }, 1500);
      });
    } catch { /* 구독 실패 — 임시저장 없이 진행 */ }
  }

  // ── 드래그 스냅 토글 (∠ 딸깍 / ↔ 길이고정) ──────────────────────
  // 에디터 옵션(render.options.molaSnapAngle/molaSnapLength)을 같은 출처
  // contentWindow 직접 접근으로 뒤집는다(이 프로젝트의 확립된 관례 — postMessage
  // 아님). 렌더 재실행은 불필요하다: select 도구가 드래그하는 순간에 옵션을
  // 읽는다. 같은 옵션이 에디터 Settings(General 탭)에도 있다 — 거기서 바꾸면
  // 버튼 상태는 다음 동기화 시점(에디터 재진입·버튼 클릭)에 따라온다.
  // 기본값은 포크 options-schema 의 default(true) — 버튼 aria-pressed 초기값과
  // 맞춰져 있고, 에디터가 뜨기 전에는 비활성이다.
  const SNAP_TOGGLES = [
    { btnId: "snapAngleBtn", opt: "molaSnapAngle" },
    { btnId: "snapLengthBtn", opt: "molaSnapLength" },
  ];
  function snapOptions() {
    try { return ui.ketcher ? ui.ketcher.editor.render.options : null; } catch { return null; }
  }
  function syncSnapToggles() {
    const opts = snapOptions();
    SNAP_TOGGLES.forEach(({ btnId, opt }) => {
      const b = document.getElementById(btnId);
      if (!b) return;
      b.disabled = !opts;
      if (opts) b.setAttribute("aria-pressed", String(opts[opt] !== false));
    });
  }
  SNAP_TOGGLES.forEach(({ btnId, opt }) => {
    const b = document.getElementById(btnId);
    b.disabled = true;   // 에디터 준비 전
    b.addEventListener("click", () => {
      const opts = snapOptions();
      if (!opts) return;
      opts[opt] = opts[opt] === false;   // undefined(기본 켬)/true → false, false → true
      syncSnapToggles();
    });
  });

  // ── 저장 버튼 바 (그림 복사 ▾ · 그림 저장 ▾) ─────────────────────
  // 사용자 결정(2026-08-10): 버튼은 두 개만 — 복사(기본 SVG)·저장(기본 PNG).
  // ▾ 메뉴로 형식을 고르면 즉시 실행되면서 그 형식이 기본값으로 기억된다
  // (localStorage). 작업본(KET)은 저장 메뉴 안의 형식 하나로 흡수.
  // 캔버스가 비면 generateImage()가 던지므로 버튼을 선제적으로 비활성화한다.
  // isBlank() 판정 자체가 실패하면 "비어있지 않다"로 간주한다(안전 쪽 기본값).
  const copyImageBtn = document.getElementById("copyImageBtn");
  const copyImageMenuBtn = document.getElementById("copyImageMenuBtn");
  const saveImageBtn = document.getElementById("saveImageBtn");
  const saveImageMenuBtn = document.getElementById("saveImageMenuBtn");

  const FORMAT_LABELS = { svg: "SVG", png: "PNG", ket: "KET" };
  const COPY_FORMATS = ["svg", "png"];
  const SAVE_FORMATS = ["png", "svg", "ket"];
  function getFormatPref(key, allowed, fallback) {
    try {
      const v = localStorage.getItem(key);
      return allowed.includes(v) ? v : fallback;
    } catch { return fallback; }
  }
  function setFormatPref(key, v) {
    try { localStorage.setItem(key, v); } catch { /* 프라이빗 모드 등 — 무시 */ }
  }
  function refreshSaveButtonLabels() {
    const cf = getFormatPref("molaCopyFormat", COPY_FORMATS, "svg");
    const sf = getFormatPref("molaSaveFormat", SAVE_FORMATS, "png");
    copyImageBtn.textContent = `📋 그림 복사 (${FORMAT_LABELS[cf]})`;
    saveImageBtn.textContent = `💾 그림 저장 (${FORMAT_LABELS[sf]})`;
  }
  refreshSaveButtonLabels();

  function updateSaveButtonsState() {
    const k = ui.ketcher;
    let blank = true;
    if (k) {
      try { blank = k.editor.struct().isBlank(); } catch { blank = false; }
    }
    [copyImageBtn, copyImageMenuBtn, saveImageBtn, saveImageMenuBtn].forEach((b) => {
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

  // ── Telex 폰트 런타임 주입 ────────────────────────────────────────
  // 패널의 원소 기호를 캔버스에 실제로 찍히는 서체(Telex)로 그리기 위함이다.
  // 문제: 에디터 번들 안 폰트 파일명에 콘텐츠 해시가 붙어 있어(예:
  // static/media/Telex-Regular.5a3d2f1142eb13f7703d.woff2) 빌드마다 이름이
  // 바뀐다 — 하드코딩하면 다음 build-editor 실행 때 깨진다. asset-manifest.json
  // 을 fetch 해 "static/media/Telex-Regular.woff2" 키의 실제(해시 포함) 경로를
  // 읽어온 뒤 그 URL로 @font-face 를 FontFace API로 런타임에 등록한다(실제로
  // manifest 에 이 키가 있고 폰트가 들어있음을 사전에 확인함 — asset-manifest.json,
  // main.909252be.css 의 `@font-face{font-family:Telex;...}` 선언과 교차 확인).
  // 실패(오프라인, 매니페스트 구조 변경, FontFace 로드 실패 등)는 전부 조용히
  // 삼킨다 — 이 경우 CSS의 html.pt-telex-loaded 셀렉터가 안 붙어 기존 --mono
  // 서체로 폴백할 뿐, 패널 자체는 절대 깨지지 않는다.
  const TELEX_MANIFEST_KEY = "static/media/Telex-Regular.woff2";
  let telexInjectPromise = null;
  function injectTelexFont() {
    if (telexInjectPromise) return telexInjectPromise;
    telexInjectPromise = (async () => {
      try {
        const res = await fetch("assets/editor/asset-manifest.json");
        if (!res.ok) throw new Error("asset-manifest.json fetch 실패: " + res.status);
        const manifest = await res.json();
        const rel = manifest && manifest.files && manifest.files[TELEX_MANIFEST_KEY];
        if (!rel) throw new Error("manifest 에 Telex 항목 없음");
        // rel 은 "./static/media/Telex-<hash>.woff2" 형태 — assets/editor/ 기준 상대경로.
        const url = new URL(
          rel.replace(/^\.\//, ""),
          new URL("assets/editor/", document.baseURI),
        ).href;
        const face = new FontFace("Telex", `url("${url}") format("woff2")`, {
          weight: "400",
          style: "normal",
        });
        await face.load();
        document.fonts.add(face);
        document.documentElement.classList.add("pt-telex-loaded");
      } catch {
        // 조용히 폴백 — 위 주석 참고.
      }
    })();
    return telexInjectPromise;
  }
  injectTelexFont();

  // 자주 쓰는 원소 — 반도체 식각·세정 도면 기준 순서(표준 원자번호 순이 아니다).
  // 두 줄로 감기는 flex 줄(.pt-frequent)이라 개수는 자유:
  // 1줄째 금속·반도체 — Si·Ge(반도체), Ti·Al(배선·박막), W·Cu·Co·Ta(배선·배리어),
  //   Hf·Zr(high-k), Mo·Ru(차세대 배선)
  // 2줄째 비금속 — B(도핑), N·O·F·Cl·Br·S·P(식각·세정 가스 헤테로 원자), C·H(유기 골격)
  const FREQUENT_ELEMENTS = [
    "Si", "Ge", "Ti", "Al", "W", "Cu", "Co", "Ta", "Hf", "Zr", "Mo", "Ru",
    "B", "N", "O", "F", "Cl", "Br", "S", "P", "C", "H",
  ];

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
  // 맞춰 패널 색과 실제로 캔버스에 찍힐 원자 색이 일치하게 한다 — elementColors
  // 는 index.html 인라인 <script> 의 top-level const라 이 파일(별도 <script src>,
  // 뒤에 로드)에서도 같은 전역 스크립트 스코프로 그대로 보인다 — state/loadMolecule
  // 등 기존 참조(파일 상단 주석)와 같은 패턴이라 새로 만든 규칙이 아니다.
  //
  // 목록에 없는(20종 밖) 원소의 기본색은 예전엔 var(--ink) 였다 — 패널이
  // var(--panel) 등 테마 토큰을 쓰던 시절엔 배경도 같이 어두워져 괜찮았지만,
  // 지금은 패널 배경을 항상 흰색으로 고정했으므로(위 CSS 주석 참고)
  // var(--ink) 를 그대로 쓰면 다크모드에서 --ink 가 밝은 색(#eef3f9)이 되어
  // 흰 배경 위에 거의 안 보이는 대비 사고가 난다(실제로 다크모드 스크린샷에서
  // 발견함). 그래서 기본색도 라이트 테마 --ink 값을 그대로 리터럴로 고정한다.
  const PT_DEFAULT_INK = "#14202e";
  function elementInkColor(sym) {
    return elementColors[sym] || PT_DEFAULT_INK;
  }

  // Sketcher 좌측 패널의 "A" 드롭다운에 해당하는 자리 — ET(extended-table,
  // 위에서 숨김) 34개 항목 중 실제로 자주 쓸 만한 5개만 골랐다. 클릭 시
  // editor.tool('atom', {label, pseudo, type:'gen'}) 로 넘긴다 — 이 shape은
  // "any-atom" 액션(action/index.ts:273-285, 위에서 숨긴 그 버튼)이 실제
  // 프로덕션에서 이미 쓰는 것과 완전히 동일하다(pseudo는 항상 label과
  // 같은 값 — ExtendedTable.tsx의 result() 도 동일하게 만든다). A 하나로
  // 먼저 캔버스+molfile 실측 검증한 뒤 나머지 4개도 같은 형태로 구성했다
  // (검증 결과는 .superpowers/sdd/sketcher-step1-report.md 참고).
  const GENERIC_ATOMS = [
    { sym: "A", title: "임의의 원자" },
    { sym: "Q", title: "탄소·수소를 제외한 임의 원자" },
    { sym: "M", title: "임의의 금속" },
    { sym: "X", title: "할로젠(F/Cl/Br/I/At)" },
    { sym: "R", title: "R-그룹 표시용 자리표시 원자(pseudoatom)" },
  ];

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

  // "일반 원자" 줄 버튼 — 진짜 원소 버튼(ptCellButton)과 클릭 동작이 다르므로
  // (label만이 아니라 {label,pseudo,type:'gen'} 전체를 넘겨야 한다) 별도
  // 함수로 만든다. data-pt-el 은 그대로 붙여 syncPeriodicSelection() 의
  // 선택 하이라이트 로직을 원소 버튼과 공유한다(심볼 충돌 없음 — A/Q/M/X/R
  // 는 실제 원소 기호가 아니다).
  function ptGenericButton(sym, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pt-cell pt-cell-generic";
    b.dataset.ptEl = sym;
    b.title = title;
    const symEl = document.createElement("span");
    symEl.className = "pt-sym";
    symEl.textContent = sym;
    b.appendChild(symEl);
    b.addEventListener("click", () => selectGenericAtom(sym));
    return b;
  }

  function buildGenericAtomRow() {
    const wrap = document.createElement("div");
    wrap.className = "pt-generic";
    const label = document.createElement("div");
    label.className = "pt-generic-label";
    label.textContent = "일반 원자";
    wrap.appendChild(label);
    const row = document.createElement("div");
    row.className = "pt-generic-row";
    GENERIC_ATOMS.forEach(({ sym, title }) => row.appendChild(ptGenericButton(sym, title)));
    wrap.appendChild(row);
    return wrap;
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
  // opts.withHeader: true면 드래그 손잡이 + 제목 + 접기 버튼을 가진 헤더를
  // 붙인다(상시 패널 전용 — 팝업은 임시로 뜨는 것이라 드래그 대상이 아니다).
  // opts.compact: 헤더의 접기 버튼 초기 라벨/상태.
  function buildPeriodicTable(opts) {
    opts = opts || {};
    const root = document.createElement("div");
    root.className = "periodic-table" + (opts.compact ? " pt-compact" : "");

    if (opts.withHeader) {
      const header = document.createElement("div");
      header.className = "pt-header";
      const grip = document.createElement("span");
      grip.className = "pt-grip";
      grip.setAttribute("aria-hidden", "true");
      grip.textContent = "⠿⠿";
      const title = document.createElement("span");
      title.className = "pt-title";
      title.textContent = "주기율표 (드래그해서 옮기기)";
      const collapseBtn = document.createElement("button");
      collapseBtn.type = "button";
      collapseBtn.className = "pt-collapse-btn";
      collapseBtn.dataset.ptCollapse = "1";
      collapseBtn.textContent = opts.compact ? "펼치기" : "접기";
      header.append(grip, title, collapseBtn);
      root.appendChild(header);
      root.dataset.ptHeader = "1";
    }

    const freq = document.createElement("div");
    freq.className = "pt-frequent";
    FREQUENT_ELEMENTS.forEach((sym) => {
      freq.appendChild(ptCellButton(sym, frequentElementZ(sym), true));
    });
    root.appendChild(freq);

    // 자주 쓰는 원소 줄과 전체 표 사이 — Sketcher의 "A" 드롭다운 자리.
    // 컴팩트 모드에서도 접히지 않는다(자주 쓰는 원소 줄과 같은 급의
    // "항상 보이는 짧은 줄"로 취급).
    root.appendChild(buildGenericAtomRow());

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

  // 실제 원소·일반 원자(generic atom) 클릭이 공유하는 공통 골격 — opts가
  // 다를 뿐 나머지(에디터 준비 확인, 상태 메시지, 선택 하이라이트 동기화,
  // 팝업 닫기)는 완전히 같다.
  function selectAtom(sym, opts) {
    const st = document.getElementById("editorStatus");
    const k = ui.ketcher;
    if (!k) { st.textContent = "에디터가 아직 준비되지 않았습니다."; return; }
    try {
      k.editor.tool("atom", opts);
    } catch (e) {
      st.textContent = "원소를 선택하지 못했습니다: " + (e && e.message ? e.message : e);
      return;
    }
    currentAtomLabel = sym;
    syncPeriodicSelection();
    flashSaveStatus(st, `이제 클릭하면 ${sym} 원자가 찍힙니다.`);
    closePeriodicPopup();
  }

  function selectElement(sym) {
    selectAtom(sym, { label: sym });
  }

  // "일반 원자" 줄 전용 — any-atom 액션(action/index.ts:273-285)과 완전히
  // 같은 opts shape. label과 pseudo는 항상 같은 값이다(ExtendedTable.tsx의
  // result()도 동일 규칙).
  function selectGenericAtom(sym) {
    selectAtom(sym, { label: sym, pseudo: sym, type: "gen" });
  }

  // ── 패널(상시 오버레이) ───────────────────────────────────────────
  const periodicPanel = document.getElementById("periodicPanel");
  const periodicToggleBtn = document.getElementById("periodicToggleBtn");
  let periodicOpen = false;      // 세션(이 페이지가 떠 있는 동안) 유지 — 새로고침 시 초기화된다
  let periodicCompact = false;   // 접기 모드 — 전체 18족 표를 숨기고 자주 쓰는 줄만 남김
  let periodicPos = null;        // {top,left}(px, #editorFrameSlot 기준) — 드래그로 옮긴 뒤에만 값이 생김

  // 위치·접기 상태를 sessionStorage 에 남긴다 — "세션 동안 기억(다시 열면 그
  // 자리)" 요청 그대로: 탭을 닫으면 사라지고(sessionStorage 의 기본 동작),
  // 같은 탭에서는 새로고침해도 유지된다. 실패(프라이빗 모드 등)는 조용히 무시 —
  // 이 상태는 UX 편의일 뿐 기능 정합성에 영향이 없다.
  const PT_STATE_KEY = "molaPeriodicPanelState";
  function loadPeriodicState() {
    try {
      const raw = sessionStorage.getItem(PT_STATE_KEY);
      if (!raw) return;
      const st = JSON.parse(raw);
      if (typeof st.compact === "boolean") periodicCompact = st.compact;
      if (st.pos && typeof st.pos.top === "number" && typeof st.pos.left === "number") {
        periodicPos = st.pos;
      }
    } catch { /* 손상된 값 — 기본값으로 진행 */ }
  }
  function savePeriodicState() {
    try {
      sessionStorage.setItem(PT_STATE_KEY, JSON.stringify({ compact: periodicCompact, pos: periodicPos }));
    } catch { /* 조용히 무시 */ }
  }
  loadPeriodicState();

  function setPeriodicOpen(open) {
    periodicOpen = open;
    periodicPanel.hidden = !open;
    periodicToggleBtn.setAttribute("aria-pressed", String(open));
    // 저장된 위치는 패널이 실제로 보이게 된 "지금" 다시 적용한다 — 숨겨진 동안
    // (또는 애초에 뷰어 모드라 editorwrap 전체가 display:none인 동안)에는
    // #editorFrameSlot/패널의 offsetWidth·clientHeight 가 0이라 클램프 계산이
    // 부정확해진다(아래 clampPeriodicPosition 참고).
    if (open && periodicPos) positionPeriodicPanel(periodicPos.top, periodicPos.left);
  }

  periodicToggleBtn.addEventListener("click", () => setPeriodicOpen(!periodicOpen));

  const periodicPanelRoot = buildPeriodicTable({ withHeader: true, compact: periodicCompact });
  periodicPanel.appendChild(periodicPanelRoot);
  const periodicCollapseBtn = periodicPanelRoot.querySelector("[data-pt-collapse]");
  const periodicHeaderEl = periodicPanelRoot.querySelector(".pt-header");

  function setPeriodicCompact(compact) {
    periodicCompact = compact;
    periodicPanelRoot.classList.toggle("pt-compact", compact);
    if (periodicCollapseBtn) periodicCollapseBtn.textContent = compact ? "펼치기" : "접기";
    savePeriodicState();
  }
  if (periodicCollapseBtn) {
    periodicCollapseBtn.addEventListener("click", (e) => {
      e.stopPropagation();   // 헤더의 드래그 시작(pointerdown)까지 번지지 않게
      setPeriodicCompact(!periodicCompact);
    });
  }

  // ── 패널 드래그 이동 ──────────────────────────────────────────────
  // 위치 기준은 #editorFrameSlot(패널의 position:absolute 컨테이닝 블록) —
  // "화면 밖으로 못 나가게"를 프레임 슬롯(에디터가 실제로 보이는 영역) 기준으로
  // 해석한다. 기본값(top:52px/left:152px, CSS)은 왼쪽 툴바를 가리지 않도록
  // 실측(Playwright 측정, 아래 CSS 주석 참고)해 고른 값이고,
  // 드래그로 옮기면 이 함수들이 top/left 인라인 px 로 완전히 대체한다.
  function clampPeriodicPosition(top, left) {
    const slot = document.getElementById("editorFrameSlot");
    const w = periodicPanel.offsetWidth || 260;
    const h = periodicPanel.offsetHeight || 160;
    const maxLeft = Math.max(0, slot.clientWidth - w);
    const maxTop = Math.max(0, slot.clientHeight - h);
    return { top: Math.min(Math.max(0, top), maxTop), left: Math.min(Math.max(0, left), maxLeft) };
  }
  function positionPeriodicPanel(top, left) {
    const clamped = clampPeriodicPosition(top, left);
    periodicPos = clamped;
    periodicPanel.style.left = clamped.left + "px";
    periodicPanel.style.top = clamped.top + "px";
    periodicPanel.style.right = "auto";
    const slot = document.getElementById("editorFrameSlot");
    // max-height 도 새 top 기준으로 다시 계산 — 안 그러면 아래로 드래그했을 때
    // CSS 기본값(top 52px 기준 calc)이 그대로 남아 패널이 슬롯 아래로 넘칠 수 있다.
    periodicPanel.style.maxHeight = Math.max(120, slot.clientHeight - clamped.top - 8) + "px";
  }
  // 저장된 위치의 실제 적용은 setPeriodicOpen(true) 시점으로 미룬다(위 함수
  // 참고) — 지금(모듈 초기화 시점)은 대개 뷰어 모드라 editorwrap 전체가
  // display:none 이어서 여기서 클램프하면 크기를 0으로 잘못 재게 된다.

  let dragState = null;
  function onPanelDragMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    positionPeriodicPanel(dragState.startTop + dy, dragState.startLeft + dx);
  }
  function onPanelDragEnd() {
    window.removeEventListener("pointermove", onPanelDragMove);
    dragState = null;
    savePeriodicState();
  }
  if (periodicHeaderEl) {
    periodicHeaderEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[data-pt-collapse]")) return;   // 접기 버튼 클릭은 드래그 아님
      const slot = document.getElementById("editorFrameSlot");
      const slotRect = slot.getBoundingClientRect();
      const panelRect = periodicPanel.getBoundingClientRect();
      dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startTop: panelRect.top - slotRect.top,
        startLeft: panelRect.left - slotRect.left,
      };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 구형 브라우저 폴백 없이 진행 */ }
      window.addEventListener("pointermove", onPanelDragMove);
      window.addEventListener("pointerup", onPanelDragEnd, { once: true });
      e.preventDefault();
    });
  }
  // 창 크기가 바뀌어도(예: 브라우저 리사이즈) 저장된 위치를 다시 클램프해
  // 슬롯 밖으로 나가지 않게 한다.
  window.addEventListener("resize", () => {
    if (periodicOpen && periodicPos) positionPeriodicPanel(periodicPos.top, periodicPos.left);
  });

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
    popup.appendChild(buildPeriodicTable({ withHeader: false }));
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

  // ── Esc — 팝업·패널 둘 다 닫는다 ─────────────────────────────────
  // 팝업은 부모 문서에 살지만 우클릭은 iframe(에디터) 안에서 일어나므로, 이
  // 핸들러를 부모 document 와 iframe document 양쪽에 모두 건다(setupCanvasContextMenu
  // 안에서 재사용). 절대 preventDefault/stopPropagation 을 부르지 않는다 — 우리
  // 것(팝업·패널)이 열려 있지 않으면 그냥 아무 것도 안 하고 리턴해 이벤트가
  // 그대로 흘러가게 둔다. 이렇게 하면 Ketcher 자신의 Esc 사용(모달 닫기 —
  // Dialog.tsx:156, 도구 취소 — hotkeys.ts:195/288, ContextMenu.tsx:45 등)을
  // 전혀 방해하지 않는다 — 같은 document 에 여러 keydown 리스너가 있어도
  // stopPropagation/stopImmediatePropagation 을 안 부르면 전부 그대로 호출된다.
  function handleGlobalEscape(e) {
    if (e.key !== "Escape") return;
    if (popupEl) { closePeriodicPopup(); return; }
    if (periodicOpen) { setPeriodicOpen(false); }
  }
  document.addEventListener("mousedown", (e) => {
    if (popupEl && !isInsidePopup(e.target)) closePeriodicPopup();
  });
  document.addEventListener("keydown", handleGlobalEscape);

  // ── 스페이스바 — 마지막에 만진 분자(fragment) 선택 ──────────────
  // ChemDraw 식 "스페이스로 마지막 대상 선택". 충돌 확인 결과(ketcher/packages/
  // ketcher-core/src/application/editor/modes/SequenceMode.ts:1336): Ketcher는
  // 매크로분자 에디터의 "시퀀스" 보기에서만 Space를 이미 쓴다
  // ('break-editting-chain' — 현재 편집 중인 사슬의 다음 노드로의 결합을 끊음).
  // 소분자(micromolecule) 캔버스 쪽 hotkeys(ketcher-react/src/script/ui/state/
  // hotkeys.ts, action/*.ts 전체)에는 Space 바인딩이 전혀 없다 — 이 앱은
  // 반도체 도면용 소분자 편집이 기본이라 실사용 경로에서는 충돌이 없다. 다만
  // 사용자가 상단 툴바의 매크로분자/폴리머 모드로 전환해 시퀀스를 편집 중이면
  // 이론상 겹칠 수 있어, isPolymerEditorActive()로 그 상태를 감지해 그 경우엔
  // 아예 우리 쪽에서 손대지 않는다(Ketcher 자체 동작을 그대로 둔다).
  function isPolymerEditorActive() {
    try {
      return !!(ui.frame && ui.frame.contentWindow && ui.frame.contentWindow.isPolymerEditorTurnedOn);
    } catch {
      return false;
    }
  }
  // 텍스트 입력(원자 라벨 편집, 검색창, contenteditable) 은 물론, 포커스된
  // 버튼/링크 등 "스페이스 = 활성화"가 브라우저 기본 동작인 요소도 반드시
  // 통과시켜야 한다 — 안 그러면 예를 들어 우리 패널 접기 버튼에 Tab 으로
  // 포커스를 옮긴 뒤 Space 를 누르는 정상적인 키보드 조작까지 우리가 먼저
  // preventDefault 해버려 버튼이 눌리지 않는 회귀가 생긴다.
  //
  // 중요한 함정 하나(실측으로 발견): Ketcher 에디터 캔버스는 복사/붙여넣기를
  // 가로채기 위해 숨겨진 <textarea data-cliparea> 를 캔버스 위에 상시
  // autoFocus 시켜 둔다(cliparea.tsx) — 즉 사용자가 캔버스에서 그림을 그리는
  // "정상적인" 상태에서도 document.activeElement/event.target 은 거의 항상
  // 이 TEXTAREA다. 이걸 "텍스트 입력 중"으로 오판하면 스페이스바가 캔버스
  // 위에서 사실상 영원히 동작하지 않는 회귀가 생긴다(실제로 겪음). Ketcher
  // 자신도 정확히 같은 이유로 이 요소를 예외 처리한다 — ketcher-core의
  // isEditableInputTarget()(utilities/dom.ts:7-17, hotkeys.ts의 shouldIgnoreKeyEvent
  // 가 그대로 씀)가 data-cliparea 속성을 먼저 걸러낸다. 여기서도 같은 패턴을
  // 그대로 따른다.
  function isKeyboardActivatableTarget(target) {
    if (!target) return false;
    if (target.hasAttribute && target.hasAttribute("data-cliparea")) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || tag === "A") {
      return true;
    }
    if (target.isContentEditable) return true;
    if (target.closest && target.closest("button, a, [role='button'], [contenteditable='true']")) {
      return true;
    }
    return false;
  }

  let lastTouchedAtomId = null;   // editor.subscribe('change', ...) 가 갱신 — armAutosave 참고

  // change 이벤트의 ChangeEventData[] 에서 "지금 struct 에 실제로 존재하는"
  // 원자/결합 id 를 하나 골라 원자 id 로 환원한다. OperationType enum 문자열에
  // 의존하지 않는 이유: 부모(순수 JS)에서 ketcher-core 의 enum을 import할 방법이
  // 없다 — 대신 "struct.atoms/bonds 에 그 id 가 실제로 있는가"로 판별한다.
  // 이 방식은 *_DELETE 계열 operation을 자연히 걸러낸다(지워진 id는 이미 struct
  // 에 없으므로 has() 가 false). data 배열은 customOnChangeHandler.ts 가 원본
  // operations를 reverse() 해 순회하며 push 하므로 data[0]이 가장 최근 operation —
  // 그래서 배열을 앞에서부터 훑어 처음 걸리는 것을 쓴다.
  function trackLastTouchedAtom(k, changeData) {
    if (!Array.isArray(changeData) || !changeData.length) return;
    let struct;
    try { struct = k.editor.struct(); } catch { return; }
    if (!struct || !struct.atoms || !struct.bonds) return;
    for (const d of changeData) {
      if (!d || d.id == null) continue;
      if (struct.atoms.has(d.id)) { lastTouchedAtomId = d.id; return; }
      if (struct.bonds.has(d.id)) {
        const bond = struct.bonds.get(d.id);
        if (bond && bond.begin != null && struct.atoms.has(bond.begin)) {
          lastTouchedAtomId = bond.begin;
          return;
        }
      }
    }
  }

  function selectLastTouchedFragment() {
    const k = ui.ketcher;
    if (!k || lastTouchedAtomId == null) return;   // 만진 것 없음(막 로드/빈 캔버스) — 조용히 넘어간다
    let struct;
    try { struct = k.editor.struct(); } catch { return; }
    const atom = struct.atoms.get(lastTouchedAtomId);
    if (!atom) { lastTouchedAtomId = null; return; }   // 그 사이 지워짐 — 조용히 포기
    let atomSet;
    try { atomSet = struct.getFragmentIds(atom.fragment); } catch { return; }
    if (!atomSet || !atomSet.size) return;
    const atoms = Array.from(atomSet);
    const bonds = [];
    struct.bonds.forEach((bond, bid) => {
      if (atomSet.has(bond.begin) && atomSet.has(bond.end)) bonds.push(bid);
    });
    try {
      // 정식 선택 UI(점선 사각형 + 회전 핸들 + 반전/휴지통)까지 띄운다 —
      // selection() 만으로는 파란 하이라이트만 그려진다. rotateController 는
      // (a) 활성 도구가 SelectTool 이고 (b) rerender() 가 불려야 나타나는데,
      // 명시적 {atoms,bonds} 선택은 (b)를 자동으로 해 주지 않는다
      // (Editor.selection 은 ci==='all' 일 때만 rerender — 실측 조사 확인).
      // tool('select') 는 SelectTool 에 cancel() 이 없어 선택을 지우지 않는다.
      // 좌측 툴바의 도구 하이라이트는 redux 를 안 거쳐 갱신되지 않는 화장품
      // 수준 차이만 있다(주기율표 패널의 tool('atom') 호출과 같은 관례).
      k.editor.tool("select", "lasso");
      k.editor.selection({ atoms, bonds });
      k.editor.rotateController.rerender();
    } catch {
      return;
    }
    const st = document.getElementById("editorStatus");
    if (st) flashSaveStatus(st, "마지막 분자를 선택했습니다.");
  }

  function handleGlobalSpacebar(e) {
    if (e.code !== "Space" && e.key !== " ") return;
    if (isKeyboardActivatableTarget(e.target)) return;
    if (ui.mode !== "editor") return;
    if (isPolymerEditorActive()) return;   // 위 주석 — 매크로분자 시퀀스 모드의 자체 Space 와 충돌 회피
    e.preventDefault();   // 처리하는 경우에만 막는다 — 부모 문서에서 Space 의 기본 동작(스크롤)을 억제
    selectLastTouchedFragment();
  }
  document.addEventListener("keydown", handleGlobalSpacebar);

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
    // iframe 안에서도 클릭/Esc/Space 로 반응하게 — 부모 document 리스너는
    // iframe 내부 이벤트를 보지 못한다(별도 document). 실제 캔버스 조작(우클릭,
    // 원자 클릭, 스페이스바)은 거의 항상 iframe 안에서 일어나므로 이 등록이
    // 핵심 경로다 — 부모 document 쪽 리스너는 우리 자신의 패널·버튼 등
    // 부모 쪽 UI 위에서 일어나는 경우를 위한 보조 경로.
    doc.addEventListener("mousedown", (e) => {
      if (popupEl && !isInsidePopup(e.target)) closePeriodicPopup();
    });
    doc.addEventListener("keydown", handleGlobalEscape);
    doc.addEventListener("keydown", handleGlobalSpacebar);
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

  // 그림 복사 — PNG 모드는 기존 검증된 경로(제스처 체인 보존: clipboard.write 를
  // generateImage 완료 "전"에 호출, ClipboardItem 은 Promise 값을 받는다 — MDN).
  // SVG 모드는 크로미움이 클립보드에 image/svg+xml 을 거부하므로(허용 목록:
  // png/text/html) ① 일단 svg mime 을 시도하고(미래 브라우저 대비, 실패는 즉시
  // TypeError) ② text/html(인라인 <svg>) + image/png 동시 탑재로 폴백한다 —
  // PowerPoint 등은 HTML 조각이나 PNG 중 지원하는 쪽을 집는다.
  async function copyImage(k, st, format) {
    if (format === "png") {
      const imagePromise = k.generateImage("", { outputFormat: "png" });
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": imagePromise }),
        ]);
        flashSaveStatus(st, "PNG 복사했습니다.");
        return;
      } catch (e) {
        const settled = await Promise.allSettled([imagePromise]);
        if (settled[0].status === "rejected") throw settled[0].reason;
      }
      // Promise 형태 ClipboardItem 미지원 브라우저 — 완성 Blob 으로 재시도
      try {
        const blob = await imagePromise;
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        flashSaveStatus(st, "PNG 복사했습니다.");
      } catch {
        st.textContent = "클립보드를 쓸 수 없습니다 — 그림 저장을 이용하세요.";
      }
      return;
    }
    // SVG 모드
    const svgPromise = k.generateImage("", { outputFormat: "svg" });
    const pngPromise = k.generateImage("", { outputFormat: "png" });
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/svg+xml": svgPromise }),
      ]);
      flashSaveStatus(st, "SVG 복사했습니다.");
      return;
    } catch (e) {
      const settled = await Promise.allSettled([svgPromise]);
      if (settled[0].status === "rejected") throw settled[0].reason;
    }
    try {
      const svgText = await (await svgPromise).text();
      const htmlBlob = new Blob([svgText], { type: "text/html" });
      const pngBlob = await pngPromise;
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": htmlBlob, "image/png": pngBlob }),
      ]);
      flashSaveStatus(st, "SVG(HTML)+PNG 복사했습니다.");
    } catch {
      st.textContent = "클립보드를 쓸 수 없습니다 — 그림 저장을 이용하세요.";
    }
  }

  async function saveImage(k, st, format) {
    if (format === "ket") {
      const ket = await k.getKet();
      downloadBlob(new Blob([ket], { type: "application/json" }), `그린_구조_${saveTimestamp()}.ket`);
    } else {
      const blob = await k.generateImage("", { outputFormat: format });
      downloadBlob(blob, `그린_구조_${saveTimestamp()}.${format}`);
    }
    flashSaveStatus(st, `${FORMAT_LABELS[format]} 저장했습니다.`);
  }

  copyImageBtn.addEventListener("click", () => withSaveGuard((k, st) =>
    copyImage(k, st, getFormatPref("molaCopyFormat", COPY_FORMATS, "svg"))));
  saveImageBtn.addEventListener("click", () => withSaveGuard((k, st) =>
    saveImage(k, st, getFormatPref("molaSaveFormat", SAVE_FORMATS, "png"))));

  // ▾ 형식 메뉴 — 항목 클릭 = 즉시 실행 + 그 형식을 기본값으로 기억
  let formatMenuEl = null;
  function closeFormatMenu() {
    if (formatMenuEl) { formatMenuEl.remove(); formatMenuEl = null; }
  }
  function openFormatMenu(anchorBtn, formats, prefKey, run) {
    closeFormatMenu();
    const menu = document.createElement("div");
    menu.className = "format-menu";
    const current = getFormatPref(prefKey, formats, formats[0]);
    formats.forEach((f) => {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = (f === current ? "✓ " : "") +
        (f === "ket" ? "KET (작업본, 무손실)" : FORMAT_LABELS[f]);
      item.addEventListener("click", () => {
        closeFormatMenu();
        setFormatPref(prefKey, f);
        refreshSaveButtonLabels();
        withSaveGuard((k, st) => run(k, st, f));
      });
      menu.appendChild(item);
    });
    const rect = anchorBtn.getBoundingClientRect();
    menu.style.left = `${rect.left + window.scrollX}px`;
    menu.style.top = `${rect.bottom + window.scrollY + 2}px`;
    document.body.appendChild(menu);
    formatMenuEl = menu;
  }
  document.addEventListener("mousedown", (e) => {
    if (formatMenuEl && !formatMenuEl.contains(e.target) &&
        e.target !== copyImageMenuBtn && e.target !== saveImageMenuBtn) {
      closeFormatMenu();
    }
  });
  // 모든 팝업은 ESC 로 닫힌다(사용자 지시) — 주기율표 패널/팝업은 기존
  // handleGlobalEscape 가 담당하고, 형식 메뉴는 여기서.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && formatMenuEl) closeFormatMenu();
  });
  copyImageMenuBtn.addEventListener("click", () => {
    if (formatMenuEl) { closeFormatMenu(); return; }
    openFormatMenu(copyImageMenuBtn, COPY_FORMATS, "molaCopyFormat", copyImage);
  });
  saveImageMenuBtn.addEventListener("click", () => {
    if (formatMenuEl) { closeFormatMenu(); return; }
    openFormatMenu(saveImageMenuBtn, SAVE_FORMATS, "molaSaveFormat", saveImage);
  });

  // ── 실시간 팁(우하단) ────────────────────────────────────────────
  // 호버 대상(원자/결합)과 활성 도구에 따라 단축키 힌트를 보여준다.
  // iframe 내부 mousemove 를 같은 출처로 직접 듣고, 판정은 에디터 자신의
  // findItem(모델 좌표 거리 기반)을 그대로 빌린다 — 별도 히트테스트 구현 없음.
  // 120ms 스로틀: findItem 은 가볍지만 mousemove 빈도 그대로 부를 이유가 없다.
  function armEditorTips(frame, k) {
    const tips = document.getElementById("editorTips");
    const doc = frame.contentDocument;
    if (!tips || !doc) return;
    let lastAt = 0;
    let lastText = "";
    function setTip(text) {
      if (text === lastText) return;
      lastText = text;
      tips.hidden = !text;
      if (text) tips.textContent = text;
    }
    function toolName() {
      try { return (k.editor._tool && k.editor._tool.constructor.name) || ""; } catch { return ""; }
    }
    function defaultTip() {
      const t = toolName();
      if (/^BondTool/.test(t)) return "드래그 = 결합 그리기 · Alt = 자유 각도/길이 · 이중결합 재클릭 = 선 위치 순환";
      if (/^AtomTool/.test(t)) return "클릭 = 원자 · 원자에서 드래그 = 결합 뻗기 (Alt = 자유)";
      if (/^SelectTool/.test(t)) return "스페이스 = 마지막 분자 선택 · 말단 원자 드래그 = 결합 회전 (∠/↔ 토글, Alt = 자유)";
      if (/^SGroupTool/.test(t)) return "선택하면 바로 괄호+n 이 붙습니다 · n 수정은 괄호 더블클릭";
      return "";
    }
    doc.addEventListener("mousemove", (e) => {
      const now = Date.now();
      if (now - lastAt < 120) return;
      lastAt = now;
      let ci = null;
      try { ci = k.editor.findItem(e, ["atoms", "bonds"], null); } catch { /* 무시 */ }
      if (ci && ci.map === "bonds") {
        setTip("1/2/3 = 단일/이중/삼중 · W = 쐐기 · B = 굵게 · / = 속성 · 더블클릭 = 상세");
      } else if (ci && ci.map === "atoms") {
        setTip("원소키(C/N/O/Si…) = 치환 · 더블클릭 = 라벨 입력 · 말단 드래그 = 회전 (Alt = 자유)");
      } else {
        setTip(defaultTip());
      }
    });
    doc.addEventListener("mouseleave", () => setTip(""));
    setTip(defaultTip());
  }

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
  // 결합 도구가 낸 표기 알림을 에디터 상태줄에 띄운다.
  //
  // 왜 필요한가 — 이중결합 도구로 **같은 결합을 반복 클릭하면 선 위치가 순환**한다
  // (ChemDraw 식: 자동 → 한쪽 → 반대쪽 → 가운데 → 자동). 결과가 "선이 한 칸 움직인다"
  // 뿐이라 글자로 짚어주지 않으면 방금 무엇을 골랐는지 알기 어렵다. 굵은 결합
  // 도구의 켜기/끄기도 같다.
  //
  // 포크의 `editor.event.message` 채널에는 드래그 각도 등 다른 정보도 흐르므로
  // 접두사(`MOLA:`)로 갈라낸다 — 접두사가 없는 메시지는 무시한다.
  const MOLA_NOTICE_PREFIX = "MOLA:";
  function armMolaNotationStatus(k) {
    try {
      k.editor.event.message.add((msg) => {
        const info = msg && msg.info;
        if (typeof info !== "string") return;
        if (info.indexOf(MOLA_NOTICE_PREFIX) !== 0) return;
        const st = document.getElementById("editorStatus");
        if (st) flashSaveStatus(st, info.slice(MOLA_NOTICE_PREFIX.length));
      });
    } catch (e) {
      // 알림은 "있으면 좋은 것"이다 — 실패해도 편집 자체를 막지 않는다
    }
  }

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
        armMolaNotationStatus(k);   // 결합 도구의 표기 순환/토글 알림 → 상태줄
        syncSnapToggles();          // 드래그 스냅 토글 버튼 활성화 + 현재 옵션 반영
        armEditorTips(frame, k);    // 우하단 실시간 팁(호버 대상별 단축키 힌트)
        // Ctrl+C/X 완료 알림 — 포크 cliparea 가 성공 시 iframe window 에
        // 'copyOrCutComplete' 를 쏜다(상류 e2e 훅 — 리스너가 없어 지금까지
        // 무음이었다). 휘발성 상태줄(2.5초)로 "복사됨"을 보여준다.
        try {
          frame.contentWindow.addEventListener("copyOrCutComplete", () => {
            const st = document.getElementById("editorStatus");
            if (st) flashSaveStatus(st, "클립보드에 복사했습니다 (그림 포함).");
          });
        } catch { /* 접근 불가 — 알림 없이 진행 */ }
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

  // ── 손실 안내: 뷰어/molfile 로 안 넘어가는 그리기 표기 ───────────────
  // 포크가 추가한 표기 2종은 KET(작업본)·SVG·PNG 에는 그대로 남지만, MOL V2000
  // 에는 담을 표준 필드가 아예 없다. 뷰어로 보내는 경로가 getMolfile("v2000")
  // 이므로 여기서 반드시 사라진다. 게다가 뷰어 엔진(RDKit)에는 "굵은 결합"
  // 개념 자체가 없다 — 조사 근거는 .superpowers/sdd/bold-and-offset-bonds.md §2-4.
  // 막지는 않는다. 그림이 목적이면 SVG/PNG 로 저장하면 완전히 보존된다는 것까지
  // 같이 알려 준다.
  //
  // 재빌드와 무관한 부모 페이지 코드다 — 캔버스의 결합을 읽기만 한다.
  function molaNotationLossNotice(k) {
    let bold = 0;
    let side = 0;
    let bracketCharge = 0;
    try {
      const molecule = k.editor.render.ctab.molecule;
      molecule.bonds.forEach((bond) => {
        if (bond.molaBoldBond) bold += 1;
        // 0(대칭)이 유효값이라 truthy 검사를 쓰면 안 된다
        if (bond.molaDoubleBondSide !== null && bond.molaDoubleBondSide !== undefined) side += 1;
      });
      // 괄호 전하(SRU S-group 의 molaBracketCharge)도 에디터 전용 장식 —
      // MOL V2000 에 자리가 없어 뷰어로는 안 넘어간다.
      molecule.sgroups.forEach((sg) => {
        if (sg && sg.data && Number(sg.data.molaBracketCharge)) bracketCharge += 1;
      });
    } catch {
      return "";   // 내부 구조가 바뀌어도 보내기 자체는 막지 않는다
    }
    if (!bold && !side && !bracketCharge) return "";
    const what = [];
    if (bold) what.push("굵은 결합");
    if (side) what.push("이중결합 선 위치");
    if (bracketCharge) what.push("괄호 전하");
    // "표기는" 으로 받아 조사 문제를 피한다("결합은" / "위치는" 이 갈린다)
    return what.join("·") + " 표기는 뷰어와 molfile 에 담기지 않아 사라집니다 — 그림 그대로 남기려면 SVG/PNG 로 저장하세요.";
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
    // 손실 안내는 에디터 상태줄에 남겨 둔다(에디터로 돌아왔을 때 보이도록).
    const lossNotice = molaNotationLossNotice(k);
    st.textContent = lossNotice;
    parsed.molblock2d = molblock;
    parsed.__fromEditor = true;
    // 뷰어 쪽 상태줄에도 같이 붙인다 — 손실이 일어나는 바로 그 순간에 보여야
    // 안내로서 의미가 있다(에디터 상태줄은 뷰어 모드에서 안 보인다).
    const editorStatusMessage =
      "에디터에서 가져온 구조 — 3D 좌표가 없어 2D만 표시합니다." +
      (lossNotice ? " " + lossNotice : "");
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
