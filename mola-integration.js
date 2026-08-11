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
    // Aromatize 버튼이 단일 토글(방향족이면 케쿨레로, 아니면 방향족으로)이 되면서
    // 별도 Dearomatize 버튼은 중복 — 포크 server.ts 의 arom thunk 참조(2026-08-11).
    "dearom",
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

  // ── 주기율표 팝업 데이터(반도체 강조판) ────────────────────────────
  // 사용자 업로드 semiconductor_periodic_table_desktop_v5.html(팝업 시안 v1
  // 승인, 2026-08-11)에서 이식 — 원소 118종의 18족 표 좌표(row/col)·분류·
  // 대표 반도체 역할·헤드라인. details(용도 상세 목록)는 팝업 정보줄에서
  // 쓰지 않아 뺐다. f-블록은 원본 좌표(9·10행)를 그대로 두고 렌더 때
  // 8·9행으로 당겨 붙인다(팝업 높이 절약 — 시안 v1 그대로).
  const SEMI_ELEMENTS = [
    {"z":1,"symbol":"H","name":"Hydrogen","nameKo":"수소","mass":"1.008","row":1,"col":1,"category":"nonmetal","categoryKo":"비금속","roles":["CLEAN","GAS","PASS"],"headline":"환원·패시베이션"},
    {"z":2,"symbol":"He","name":"Helium","nameKo":"헬륨","mass":"4.0026","row":1,"col":18,"category":"noble","categoryKo":"비활성 기체","roles":["GAS"],"headline":"캐리어·퍼지·냉각"},
    {"z":3,"symbol":"Li","name":"Lithium","nameKo":"리튬","mass":"6.94","row":2,"col":1,"category":"alkali","categoryKo":"알칼리 금속","roles":["CONTAM"],"headline":"알칼리 오염 주의"},
    {"z":4,"symbol":"Be","name":"Beryllium","nameKo":"베릴륨","mass":"9.0122","row":2,"col":2,"category":"alkaline","categoryKo":"알칼리 토금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":5,"symbol":"B","name":"Boron","nameKo":"붕소","mass":"10.81","row":2,"col":13,"category":"metalloid","categoryKo":"준금속","roles":["DOP","DEP"],"headline":"대표 p-type 도펀트"},
    {"z":6,"symbol":"C","name":"Carbon","nameKo":"탄소","mass":"12.011","row":2,"col":14,"category":"nonmetal","categoryKo":"비금속","roles":["MASK","FILM"],"headline":"하드마스크·SiC 계열"},
    {"z":7,"symbol":"N","name":"Nitrogen","nameKo":"질소","mass":"14.007","row":2,"col":15,"category":"nonmetal","categoryKo":"비금속","roles":["DEP","GAS","FILM"],"headline":"질화막·퍼지"},
    {"z":8,"symbol":"O","name":"Oxygen","nameKo":"산소","mass":"15.999","row":2,"col":16,"category":"nonmetal","categoryKo":"비금속","roles":["OX","CLEAN","FILM"],"headline":"산화·애싱"},
    {"z":9,"symbol":"F","name":"Fluorine","nameKo":"플루오린","mass":"18.998","row":2,"col":17,"category":"halogen","categoryKo":"할로젠","roles":["ETCH","CLEAN"],"headline":"Si계 식각의 핵심"},
    {"z":10,"symbol":"Ne","name":"Neon","nameKo":"네온","mass":"20.180","row":2,"col":18,"category":"noble","categoryKo":"비활성 기체","roles":["LITHO","GAS"],"headline":"레이저·불활성 가스"},
    {"z":11,"symbol":"Na","name":"Sodium","nameKo":"나트륨","mass":"22.990","row":3,"col":1,"category":"alkali","categoryKo":"알칼리 금속","roles":["CONTAM"],"headline":"대표 mobile-ion 오염"},
    {"z":12,"symbol":"Mg","name":"Magnesium","nameKo":"마그네슘","mass":"24.305","row":3,"col":2,"category":"alkaline","categoryKo":"알칼리 토금속","roles":["DOP","COMPOUND"],"headline":"GaN p-type 도핑"},
    {"z":13,"symbol":"Al","name":"Aluminium","nameKo":"알루미늄","mass":"26.982","row":3,"col":13,"category":"post","categoryKo":"전이후 금속","roles":["METAL","FILM","COMPOUND"],"headline":"배선·Al₂O₃·III–V"},
    {"z":14,"symbol":"Si","name":"Silicon","nameKo":"규소","mass":"28.085","row":3,"col":14,"category":"metalloid","categoryKo":"준금속","roles":["WAFER","FILM"],"headline":"반도체의 기준 재료"},
    {"z":15,"symbol":"P","name":"Phosphorus","nameKo":"인","mass":"30.974","row":3,"col":15,"category":"nonmetal","categoryKo":"비금속","roles":["DOP","FILM"],"headline":"대표 n-type 도펀트"},
    {"z":16,"symbol":"S","name":"Sulfur","nameKo":"황","mass":"32.06","row":3,"col":16,"category":"nonmetal","categoryKo":"비금속","roles":["WET","COMPOUND"],"headline":"황산·황화물"},
    {"z":17,"symbol":"Cl","name":"Chlorine","nameKo":"염소","mass":"35.45","row":3,"col":17,"category":"halogen","categoryKo":"할로젠","roles":["ETCH","CLEAN"],"headline":"금속·Si 계열 식각"},
    {"z":18,"symbol":"Ar","name":"Argon","nameKo":"아르곤","mass":"39.948","row":3,"col":18,"category":"noble","categoryKo":"비활성 기체","roles":["GAS","ETCH","DEP"],"headline":"스퍼터·플라즈마"},
    {"z":19,"symbol":"K","name":"Potassium","nameKo":"칼륨","mass":"39.098","row":4,"col":1,"category":"alkali","categoryKo":"알칼리 금속","roles":["CONTAM"],"headline":"알칼리 오염 주의"},
    {"z":20,"symbol":"Ca","name":"Calcium","nameKo":"칼슘","mass":"40.078","row":4,"col":2,"category":"alkaline","categoryKo":"알칼리 토금속","roles":["CONTAM"],"headline":"금속 오염 관리"},
    {"z":21,"symbol":"Sc","name":"Scandium","nameKo":"스칸듐","mass":"44.956","row":4,"col":3,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":22,"symbol":"Ti","name":"Titanium","nameKo":"티타늄","mass":"47.867","row":4,"col":4,"category":"transition","categoryKo":"전이 금속","roles":["BARR","METAL","DEP"],"headline":"Ti/TiN barrier·liner"},
    {"z":23,"symbol":"V","name":"Vanadium","nameKo":"바나듐","mass":"50.942","row":4,"col":5,"category":"transition","categoryKo":"전이 금속","roles":["METAL","COMPOUND"],"headline":"특수 금속·질화물"},
    {"z":24,"symbol":"Cr","name":"Chromium","nameKo":"크로뮴","mass":"51.996","row":4,"col":6,"category":"transition","categoryKo":"전이 금속","roles":["MASK","METAL","CONTAM"],"headline":"포토마스크·금속"},
    {"z":25,"symbol":"Mn","name":"Manganese","nameKo":"망가니즈","mass":"54.938","row":4,"col":7,"category":"transition","categoryKo":"전이 금속","roles":["CONTAM","METAL"],"headline":"금속 오염·특수 barrier"},
    {"z":26,"symbol":"Fe","name":"Iron","nameKo":"철","mass":"55.845","row":4,"col":8,"category":"transition","categoryKo":"전이 금속","roles":["CONTAM"],"headline":"중요 금속 오염"},
    {"z":27,"symbol":"Co","name":"Cobalt","nameKo":"코발트","mass":"58.933","row":4,"col":9,"category":"transition","categoryKo":"전이 금속","roles":["METAL","CONTACT"],"headline":"contact·silicide·배선"},
    {"z":28,"symbol":"Ni","name":"Nickel","nameKo":"니켈","mass":"58.693","row":4,"col":10,"category":"transition","categoryKo":"전이 금속","roles":["CONTACT","METAL","CONTAM"],"headline":"NiSi contact"},
    {"z":29,"symbol":"Cu","name":"Copper","nameKo":"구리","mass":"63.546","row":4,"col":11,"category":"transition","categoryKo":"전이 금속","roles":["WIRE","METAL","CONTAM"],"headline":"대표 BEOL 배선"},
    {"z":30,"symbol":"Zn","name":"Zinc","nameKo":"아연","mass":"65.38","row":4,"col":12,"category":"transition","categoryKo":"전이 금속","roles":["COMPOUND","CONTAM"],"headline":"ZnO·화합물"},
    {"z":31,"symbol":"Ga","name":"Gallium","nameKo":"갈륨","mass":"69.723","row":4,"col":13,"category":"post","categoryKo":"전이후 금속","roles":["COMPOUND","WAFER"],"headline":"GaAs·GaN 계열"},
    {"z":32,"symbol":"Ge","name":"Germanium","nameKo":"저마늄","mass":"72.630","row":4,"col":14,"category":"metalloid","categoryKo":"준금속","roles":["WAFER","COMPOUND","ETCH"],"headline":"SiGe·Ge channel"},
    {"z":33,"symbol":"As","name":"Arsenic","nameKo":"비소","mass":"74.922","row":4,"col":15,"category":"metalloid","categoryKo":"준금속","roles":["DOP","COMPOUND"],"headline":"n-type·GaAs"},
    {"z":34,"symbol":"Se","name":"Selenium","nameKo":"셀레늄","mass":"78.971","row":4,"col":16,"category":"nonmetal","categoryKo":"비금속","roles":["COMPOUND"],"headline":"chalcogenide 재료"},
    {"z":35,"symbol":"Br","name":"Bromine","nameKo":"브로민","mass":"79.904","row":4,"col":17,"category":"halogen","categoryKo":"할로젠","roles":["ETCH"],"headline":"HBr plasma 식각"},
    {"z":36,"symbol":"Kr","name":"Krypton","nameKo":"크립톤","mass":"83.798","row":4,"col":18,"category":"noble","categoryKo":"비활성 기체","roles":["LITHO","GAS"],"headline":"KrF 리소그래피"},
    {"z":37,"symbol":"Rb","name":"Rubidium","nameKo":"루비듐","mass":"85.468","row":5,"col":1,"category":"alkali","categoryKo":"알칼리 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":38,"symbol":"Sr","name":"Strontium","nameKo":"스트론튬","mass":"87.62","row":5,"col":2,"category":"alkaline","categoryKo":"알칼리 토금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":39,"symbol":"Y","name":"Yttrium","nameKo":"이트륨","mass":"88.906","row":5,"col":3,"category":"transition","categoryKo":"전이 금속","roles":["FILM"],"headline":"Y₂O₃계 고유전·보호막"},
    {"z":40,"symbol":"Zr","name":"Zirconium","nameKo":"지르코늄","mass":"91.224","row":5,"col":4,"category":"transition","categoryKo":"전이 금속","roles":["FILM"],"headline":"ZrO₂ high-k"},
    {"z":41,"symbol":"Nb","name":"Niobium","nameKo":"나이오븀","mass":"92.906","row":5,"col":5,"category":"transition","categoryKo":"전이 금속","roles":["METAL","COMPOUND"],"headline":"특수 전극·초전도"},
    {"z":42,"symbol":"Mo","name":"Molybdenum","nameKo":"몰리브데넘","mass":"95.95","row":5,"col":6,"category":"transition","categoryKo":"전이 금속","roles":["METAL","COMPOUND","LITHO"],"headline":"금속·MoS₂·EUV"},
    {"z":43,"symbol":"Tc","name":"Technetium","nameKo":"테크네튬","mass":"[98]","row":5,"col":7,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":44,"symbol":"Ru","name":"Ruthenium","nameKo":"루테늄","mass":"101.07","row":5,"col":8,"category":"transition","categoryKo":"전이 금속","roles":["WIRE","METAL"],"headline":"차세대 배선·contact"},
    {"z":45,"symbol":"Rh","name":"Rhodium","nameKo":"로듐","mass":"102.91","row":5,"col":9,"category":"transition","categoryKo":"전이 금속","roles":["METAL"],"headline":"특수 전극"},
    {"z":46,"symbol":"Pd","name":"Palladium","nameKo":"팔라듐","mass":"106.42","row":5,"col":10,"category":"transition","categoryKo":"전이 금속","roles":["METAL","SENSOR"],"headline":"전극·센서"},
    {"z":47,"symbol":"Ag","name":"Silver","nameKo":"은","mass":"107.87","row":5,"col":11,"category":"transition","categoryKo":"전이 금속","roles":["WIRE","PKG"],"headline":"도전재·패키징"},
    {"z":48,"symbol":"Cd","name":"Cadmium","nameKo":"카드뮴","mass":"112.41","row":5,"col":12,"category":"transition","categoryKo":"전이 금속","roles":["COMPOUND"],"headline":"II–VI 화합물"},
    {"z":49,"symbol":"In","name":"Indium","nameKo":"인듐","mass":"114.82","row":5,"col":13,"category":"post","categoryKo":"전이후 금속","roles":["COMPOUND","FILM"],"headline":"InGaAs·ITO"},
    {"z":50,"symbol":"Sn","name":"Tin","nameKo":"주석","mass":"118.71","row":5,"col":14,"category":"post","categoryKo":"전이후 금속","roles":["LITHO","PKG","FILM"],"headline":"EUV resist·패키징"},
    {"z":51,"symbol":"Sb","name":"Antimony","nameKo":"안티모니","mass":"121.76","row":5,"col":15,"category":"metalloid","categoryKo":"준금속","roles":["DOP","COMPOUND"],"headline":"n-type·III–V"},
    {"z":52,"symbol":"Te","name":"Tellurium","nameKo":"텔루륨","mass":"127.60","row":5,"col":16,"category":"metalloid","categoryKo":"준금속","roles":["MEM","COMPOUND"],"headline":"상변화·chalcogenide"},
    {"z":53,"symbol":"I","name":"Iodine","nameKo":"아이오딘","mass":"126.90","row":5,"col":17,"category":"halogen","categoryKo":"할로젠","roles":["ETCH","PRECURSOR"],"headline":"특수 halogen chemistry"},
    {"z":54,"symbol":"Xe","name":"Xenon","nameKo":"제논","mass":"131.29","row":5,"col":18,"category":"noble","categoryKo":"비활성 기체","roles":["ETCH","IMPLANT","GAS"],"headline":"XeF₂·ion"},
    {"z":55,"symbol":"Cs","name":"Cesium","nameKo":"세슘","mass":"132.91","row":6,"col":1,"category":"alkali","categoryKo":"알칼리 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":56,"symbol":"Ba","name":"Barium","nameKo":"바륨","mass":"137.33","row":6,"col":2,"category":"alkaline","categoryKo":"알칼리 토금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":57,"symbol":"La","name":"Lanthanum","nameKo":"란타넘","mass":"138.91","row":9,"col":4,"category":"lanthanide","categoryKo":"란타넘족","roles":["FILM"],"headline":"high-k stack 보조"},
    {"z":58,"symbol":"Ce","name":"Cerium","nameKo":"세륨","mass":"140.12","row":9,"col":5,"category":"lanthanide","categoryKo":"란타넘족","roles":["CMP","FILM"],"headline":"CMP·산화물"},
    {"z":59,"symbol":"Pr","name":"Praseodymium","nameKo":"프라세오디뮴","mass":"140.91","row":9,"col":6,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":60,"symbol":"Nd","name":"Neodymium","nameKo":"네오디뮴","mass":"144.24","row":9,"col":7,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":61,"symbol":"Pm","name":"Promethium","nameKo":"프로메튬","mass":"[145]","row":9,"col":8,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":62,"symbol":"Sm","name":"Samarium","nameKo":"사마륨","mass":"150.36","row":9,"col":9,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":63,"symbol":"Eu","name":"Europium","nameKo":"유로퓸","mass":"151.96","row":9,"col":10,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":64,"symbol":"Gd","name":"Gadolinium","nameKo":"가돌리늄","mass":"157.25","row":9,"col":11,"category":"lanthanide","categoryKo":"란타넘족","roles":["FILM","MAG"],"headline":"고유전·자성 재료"},
    {"z":65,"symbol":"Tb","name":"Terbium","nameKo":"터븀","mass":"158.93","row":9,"col":12,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":66,"symbol":"Dy","name":"Dysprosium","nameKo":"디스프로슘","mass":"162.50","row":9,"col":13,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":67,"symbol":"Ho","name":"Holmium","nameKo":"홀뮴","mass":"164.93","row":9,"col":14,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":68,"symbol":"Er","name":"Erbium","nameKo":"어븀","mass":"167.26","row":9,"col":15,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":69,"symbol":"Tm","name":"Thulium","nameKo":"툴륨","mass":"168.93","row":9,"col":16,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":70,"symbol":"Yb","name":"Ytterbium","nameKo":"이터븀","mass":"173.05","row":9,"col":17,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":71,"symbol":"Lu","name":"Lutetium","nameKo":"루테튬","mass":"174.97","row":9,"col":18,"category":"lanthanide","categoryKo":"란타넘족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":72,"symbol":"Hf","name":"Hafnium","nameKo":"하프늄","mass":"178.49","row":6,"col":4,"category":"transition","categoryKo":"전이 금속","roles":["FILM","GATE"],"headline":"HfO₂ high-k의 핵심"},
    {"z":73,"symbol":"Ta","name":"Tantalum","nameKo":"탄탈럼","mass":"180.95","row":6,"col":5,"category":"transition","categoryKo":"전이 금속","roles":["BARR","METAL"],"headline":"Ta/TaN diffusion barrier"},
    {"z":74,"symbol":"W","name":"Tungsten","nameKo":"텅스텐","mass":"183.84","row":6,"col":6,"category":"transition","categoryKo":"전이 금속","roles":["CONTACT","WIRE","METAL"],"headline":"contact·via·word line"},
    {"z":75,"symbol":"Re","name":"Rhenium","nameKo":"레늄","mass":"186.21","row":6,"col":7,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":76,"symbol":"Os","name":"Osmium","nameKo":"오스뮴","mass":"190.23","row":6,"col":8,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":77,"symbol":"Ir","name":"Iridium","nameKo":"이리듐","mass":"192.22","row":6,"col":9,"category":"transition","categoryKo":"전이 금속","roles":["METAL","MEM"],"headline":"전극·MRAM"},
    {"z":78,"symbol":"Pt","name":"Platinum","nameKo":"백금","mass":"195.08","row":6,"col":10,"category":"transition","categoryKo":"전이 금속","roles":["METAL","MEM"],"headline":"전극·실리사이드"},
    {"z":79,"symbol":"Au","name":"Gold","nameKo":"금","mass":"196.97","row":6,"col":11,"category":"transition","categoryKo":"전이 금속","roles":["PKG","CONTAM"],"headline":"bonding·패키징 / Si 오염주의"},
    {"z":80,"symbol":"Hg","name":"Mercury","nameKo":"수은","mass":"200.59","row":6,"col":12,"category":"transition","categoryKo":"전이 금속","roles":["CONTAM"],"headline":"유해 금속 오염"},
    {"z":81,"symbol":"Tl","name":"Thallium","nameKo":"탈륨","mass":"204.38","row":6,"col":13,"category":"post","categoryKo":"전이후 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":82,"symbol":"Pb","name":"Lead","nameKo":"납","mass":"207.2","row":6,"col":14,"category":"post","categoryKo":"전이후 금속","roles":["PKG","CONTAM"],"headline":"legacy solder"},
    {"z":83,"symbol":"Bi","name":"Bismuth","nameKo":"비스무트","mass":"208.98","row":6,"col":15,"category":"post","categoryKo":"전이후 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":84,"symbol":"Po","name":"Polonium","nameKo":"폴로늄","mass":"[209]","row":6,"col":16,"category":"post","categoryKo":"전이후 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":85,"symbol":"At","name":"Astatine","nameKo":"아스타틴","mass":"[210]","row":6,"col":17,"category":"halogen","categoryKo":"할로젠","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":86,"symbol":"Rn","name":"Radon","nameKo":"라돈","mass":"[222]","row":6,"col":18,"category":"noble","categoryKo":"비활성 기체","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":87,"symbol":"Fr","name":"Francium","nameKo":"프랑슘","mass":"[223]","row":7,"col":1,"category":"alkali","categoryKo":"알칼리 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":88,"symbol":"Ra","name":"Radium","nameKo":"라듐","mass":"[226]","row":7,"col":2,"category":"alkaline","categoryKo":"알칼리 토금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":89,"symbol":"Ac","name":"Actinium","nameKo":"악티늄","mass":"[227]","row":10,"col":4,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":90,"symbol":"Th","name":"Thorium","nameKo":"토륨","mass":"232.04","row":10,"col":5,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":91,"symbol":"Pa","name":"Protactinium","nameKo":"프로트악티늄","mass":"231.04","row":10,"col":6,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":92,"symbol":"U","name":"Uranium","nameKo":"우라늄","mass":"238.03","row":10,"col":7,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":93,"symbol":"Np","name":"Neptunium","nameKo":"넵투늄","mass":"[237]","row":10,"col":8,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":94,"symbol":"Pu","name":"Plutonium","nameKo":"플루토늄","mass":"[244]","row":10,"col":9,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":95,"symbol":"Am","name":"Americium","nameKo":"아메리슘","mass":"[243]","row":10,"col":10,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":96,"symbol":"Cm","name":"Curium","nameKo":"퀴륨","mass":"[247]","row":10,"col":11,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":97,"symbol":"Bk","name":"Berkelium","nameKo":"버클륨","mass":"[247]","row":10,"col":12,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":98,"symbol":"Cf","name":"Californium","nameKo":"캘리포늄","mass":"[251]","row":10,"col":13,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":99,"symbol":"Es","name":"Einsteinium","nameKo":"아인슈타이늄","mass":"[252]","row":10,"col":14,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":100,"symbol":"Fm","name":"Fermium","nameKo":"페르뮴","mass":"[257]","row":10,"col":15,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":101,"symbol":"Md","name":"Mendelevium","nameKo":"멘델레븀","mass":"[258]","row":10,"col":16,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":102,"symbol":"No","name":"Nobelium","nameKo":"노벨륨","mass":"[259]","row":10,"col":17,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":103,"symbol":"Lr","name":"Lawrencium","nameKo":"로렌슘","mass":"[266]","row":10,"col":18,"category":"actinide","categoryKo":"악티늄족","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":104,"symbol":"Rf","name":"Rutherfordium","nameKo":"러더포듐","mass":"[267]","row":7,"col":4,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":105,"symbol":"Db","name":"Dubnium","nameKo":"더브늄","mass":"[268]","row":7,"col":5,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":106,"symbol":"Sg","name":"Seaborgium","nameKo":"시보귬","mass":"[269]","row":7,"col":6,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":107,"symbol":"Bh","name":"Bohrium","nameKo":"보륨","mass":"[270]","row":7,"col":7,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":108,"symbol":"Hs","name":"Hassium","nameKo":"하슘","mass":"[277]","row":7,"col":8,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":109,"symbol":"Mt","name":"Meitnerium","nameKo":"마이트너륨","mass":"[278]","row":7,"col":9,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":110,"symbol":"Ds","name":"Darmstadtium","nameKo":"다름슈타튬","mass":"[281]","row":7,"col":10,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":111,"symbol":"Rg","name":"Roentgenium","nameKo":"뢴트게늄","mass":"[282]","row":7,"col":11,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":112,"symbol":"Cn","name":"Copernicium","nameKo":"코페르니슘","mass":"[285]","row":7,"col":12,"category":"transition","categoryKo":"전이 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":113,"symbol":"Nh","name":"Nihonium","nameKo":"니호늄","mass":"[286]","row":7,"col":13,"category":"post","categoryKo":"전이후 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":114,"symbol":"Fl","name":"Flerovium","nameKo":"플레로븀","mass":"[289]","row":7,"col":14,"category":"post","categoryKo":"전이후 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":115,"symbol":"Mc","name":"Moscovium","nameKo":"모스코븀","mass":"[290]","row":7,"col":15,"category":"post","categoryKo":"전이후 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":116,"symbol":"Lv","name":"Livermorium","nameKo":"리버모륨","mass":"[293]","row":7,"col":16,"category":"post","categoryKo":"전이후 금속","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":117,"symbol":"Ts","name":"Tennessine","nameKo":"테네신","mass":"[294]","row":7,"col":17,"category":"halogen","categoryKo":"할로젠","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
    {"z":118,"symbol":"Og","name":"Oganesson","nameKo":"오가네손","mass":"[294]","row":7,"col":18,"category":"noble","categoryKo":"비활성 기체","roles":[],"headline":"일반적 CMOS 양산 핵심도 낮음"},
  ];
  // 역할 코드 → 표시 라벨(업로드본 그대로 — CONTAM 만 배지 색이 다르다).
  const SEMI_ROLE_LABELS = {
    CLEAN: "CLEAN", GAS: "GAS", PASS: "PASS", DOP: "DOP", DEP: "DEP",
    MASK: "MASK", FILM: "FILM", OX: "OX", ETCH: "ETCH", LITHO: "LITHO",
    CONTAM: "CONTAM", METAL: "METAL", COMPOUND: "III–V/COMP", WAFER: "WAFER",
    WET: "WET", BARR: "BARRIER", CONTACT: "CONTACT", WIRE: "INTERCONNECT",
    SENSOR: "SENSOR", PKG: "PKG", MEM: "MEMORY", IMPLANT: "IMPLANT",
    PRECURSOR: "PRECURSOR", GATE: "GATE", CMP: "CMP", MAG: "MAG",
  };

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

  function sptFamilyVar(category) {
    return "var(--spt-" + category + ")";
  }

  // 타일 — 번호·기호·영문명만. 질량·역할칩은 정보줄·툴팁으로 뺐다(시안 검토
  // 결론: 48×56 타일에서 6px대 글자는 판독 불가).
  function sptTile(el) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "spt-el";
    b.dataset.ptEl = el.symbol;
    b.style.setProperty("--family", sptFamilyVar(el.category));
    b.style.gridColumn = String(el.col);
    b.style.gridRow = String(el.row > 7 ? el.row - 1 : el.row); // f-블록 9·10→8·9
    b.title = el.nameKo + " \u00b7 " + el.mass + " u \u2014 " + el.headline;
    const z = document.createElement("span");
    z.className = "spt-z";
    z.textContent = String(el.z);
    const sym = document.createElement("span");
    sym.className = "spt-sym";
    sym.textContent = el.symbol;
    const nm = document.createElement("span");
    nm.className = "spt-nm";
    nm.textContent = el.name;
    b.append(z, sym, nm);
    b.addEventListener("mouseenter", () => sptShowInfo(el));
    b.addEventListener("click", () => selectElement(el.symbol));
    return b;
  }

  // "일반 원자" 버튼 — 클릭 opts 가 원소와 다르므로 별도 함수(기존 결정 그대로).
  // data-pt-el 은 유지해 syncPeriodicSelection() 의 하이라이트를 공유한다.
  function sptGenericButton(sym, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "spt-gen";
    b.dataset.ptEl = sym;
    b.title = title;
    b.textContent = sym;
    b.addEventListener("click", () => selectGenericAtom(sym));
    return b;
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
    if (!sptPinned) closeSemiPtPopup(); // 📌 고정 중이면 열어둔 채 연속 선택
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

  // ── 주기율표 팝업(런타임) ──────────────────────────────────────────
  // 기존 상시 패널·우클릭 소형 팝업을 이 팝업 하나로 통일했다(사용자 결정
  // 2026-08-11: 시안 v1 그대로, 우클릭도 이 팝업, 반도체 모드 기본 ON).
  // 열리는 경로 2개: 에디터 우측 툴바 주기율표 아이콘(포크 period-table
  // 액션이 window.parent.molaOpenPeriodicPopup 호출 — 부모 없으면 기존
  // 대화창 폴백) · 빈 캔버스 우클릭(아래 setupCanvasContextMenu).
  // DOM 은 지연 생성 후 hidden 토글로 재사용 — 검색어·정보줄·선택 표시가
  // 열고 닫아도 유지된다. body 에 fixed 로 붙여 iframe 경계에 안 잘린다.
  let sptRoot = null;
  let sptOpen = false;
  let sptPinned = false;   // 📌 고정 — 켜면 원소를 골라도 닫히지 않음(연속 선택)
  let sptSemiOnly = true;  // 반도체 모드 기본 ON(사용자 확인)
  let sptPos = null;       // {top,left} 뷰포트 px — 드래그·세션 복원 뒤에만
  let sptSearchEl = null;
  let sptSemiBtn = null;
  let sptInfoEl = null;

  // 위치·모드는 sessionStorage — 기존 패널의 관례 그대로(탭 닫으면 초기화,
  // 새로고침엔 유지, 실패는 UX 편의일 뿐이므로 조용히 무시).
  const SPT_STATE_KEY = "molaSemiPtState";
  function loadSptState() {
    try {
      const st = JSON.parse(sessionStorage.getItem(SPT_STATE_KEY) || "null");
      if (!st) return;
      if (typeof st.semiOnly === "boolean") sptSemiOnly = st.semiOnly;
      if (st.pos && typeof st.pos.top === "number" && typeof st.pos.left === "number") {
        sptPos = st.pos;
      }
    } catch { /* 손상된 값 — 기본값으로 진행 */ }
  }
  function saveSptState() {
    try {
      sessionStorage.setItem(SPT_STATE_KEY, JSON.stringify({ semiOnly: sptSemiOnly, pos: sptPos }));
    } catch { /* 조용히 무시 */ }
  }
  loadSptState();

  function sptElementFor(sym) {
    return SEMI_ELEMENTS.find((e) => e.symbol === sym);
  }

  // 하단 정보줄 — 호버/선택 따라 갱신(원본의 우측 상세 패널 대체).
  function sptShowInfo(el) {
    if (!sptInfoEl || !el) return;
    const roles = (el.roles.length ? el.roles : ["GENERAL"])
      .map((r) =>
        '<span class="spt-badge' + (r === "CONTAM" ? " spt-contam" : "") + '">' +
        (SEMI_ROLE_LABELS[r] || r) + "</span>")
      .join("");
    sptInfoEl.innerHTML =
      '<div class="spt-info-sym" style="--family:' + sptFamilyVar(el.category) + '">' + el.symbol + "</div>" +
      '<div class="spt-info-main"><div class="spt-info-name">' + el.nameKo +
      ' <span class="spt-info-en">' + el.name + "</span></div>" +
      '<div class="spt-info-meta">Z ' + el.z + " \u00b7 " + el.mass + " u \u00b7 " + el.categoryKo + "</div></div>" +
      '<div class="spt-info-head">' + el.headline + "</div>" +
      '<div class="spt-roles">' + roles + "</div>";
  }

  // 검색어·반도체 모드에 따라 타일을 회색화(dim). 숨기지 않고 회색만 —
  // 표의 공간 기억 유지(업로드본의 설계 의도 그대로).
  function sptFilter() {
    if (!sptRoot) return;
    const q = (sptSearchEl.value || "").trim().toLowerCase();
    sptRoot.querySelectorAll(".spt-el").forEach((b) => {
      const el = sptElementFor(b.dataset.ptEl);
      const hay = [el.symbol, el.name, el.nameKo, el.categoryKo, el.headline]
        .concat(el.roles).join(" ").toLowerCase();
      b.classList.toggle("spt-dim", (q && !hay.includes(q)) || (sptSemiOnly && !el.roles.length));
    });
  }

  function sptSetSemiOnly(v) {
    sptSemiOnly = v;
    if (sptSemiBtn) {
      sptSemiBtn.classList.toggle("active", v);
      sptSemiBtn.textContent = v ? "반도체 모드" : "전체 원소";
    }
    sptFilter();
    saveSptState();
  }

  // Enter = 첫 검색 결과 선택(검색어가 있을 때만 — 빈칸 Enter 로 H 가
  // 찍히는 사고 방지). DOM 순서 = 원자번호 순이라 "가장 가벼운 일치 원소".
  function sptFirstVisibleSymbol() {
    if (!sptSearchEl.value.trim()) return null;
    const b = sptRoot.querySelector(".spt-el:not(.spt-dim)");
    return b ? b.dataset.ptEl : null;
  }

  function sptClamp(top, left) {
    const w = sptRoot.offsetWidth || 948;
    const h = sptRoot.offsetHeight || 700;
    return {
      top: Math.min(Math.max(4, top), Math.max(4, window.innerHeight - h - 4)),
      left: Math.min(Math.max(4, left), Math.max(4, window.innerWidth - w - 4)),
    };
  }
  function sptApplyPosition(top, left) {
    const c = sptClamp(top, left);
    sptRoot.style.top = c.top + "px";
    sptRoot.style.left = c.left + "px";
    return c;
  }

  function buildSptPopup() {
    if (sptRoot) return;
    const root = document.createElement("div");
    root.className = "semi-pt-popup";
    root.hidden = true;

    const bar = document.createElement("div");
    bar.className = "spt-topbar";
    const title = document.createElement("span");
    title.className = "spt-title";
    title.textContent = "주기율표";
    const dragHint = document.createElement("span");
    dragHint.className = "spt-draghint";
    dragHint.textContent = "⠿ 드래그로 이동";
    const search = document.createElement("input");
    search.className = "spt-search";
    search.placeholder = "원소·기호·용도 검색 — Enter = 첫 결과 선택";
    search.setAttribute("aria-label", "원소 검색");
    const semiBtn = document.createElement("button");
    semiBtn.type = "button";
    semiBtn.className = "spt-toggle";
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "spt-iconbtn";
    pinBtn.textContent = "📌";
    pinBtn.title = "고정 — 원소를 골라도 팝업을 닫지 않음(연속 선택)";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "spt-iconbtn";
    closeBtn.textContent = "✕";
    closeBtn.title = "닫기 (Esc)";
    bar.append(title, dragHint, search, semiBtn, pinBtn, closeBtn);
    root.appendChild(bar);

    const body = document.createElement("div");
    body.className = "spt-body";
    const grid = document.createElement("div");
    grid.className = "spt-grid";
    [["57\u201371", "Ln", 6], ["89\u2013103", "An", 7]].forEach(([range, series, row]) => {
      const ph = document.createElement("div");
      ph.className = "spt-ph";
      ph.style.gridColumn = "3";
      ph.style.gridRow = String(row);
      ph.innerHTML = range + "<br>" + series;
      grid.appendChild(ph);
    });
    SEMI_ELEMENTS.forEach((el) => grid.appendChild(sptTile(el)));
    body.appendChild(grid);

    const lower = document.createElement("div");
    lower.className = "spt-lower";
    const genLabel = document.createElement("span");
    genLabel.className = "spt-gen-label";
    genLabel.textContent = "일반 원자";
    lower.appendChild(genLabel);
    GENERIC_ATOMS.forEach(({ sym, title: t }) => lower.appendChild(sptGenericButton(sym, t)));
    body.appendChild(lower);

    sptInfoEl = document.createElement("div");
    sptInfoEl.className = "spt-info";
    body.appendChild(sptInfoEl);
    root.appendChild(body);

    document.body.appendChild(root);
    sptRoot = root;
    sptSearchEl = search;
    sptSemiBtn = semiBtn;
    sptSetSemiOnly(sptSemiOnly);
    sptShowInfo(sptElementFor(currentAtomLabel) || sptElementFor("Si"));

    search.addEventListener("input", sptFilter);
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const sym = sptFirstVisibleSymbol();
        if (sym) selectElement(sym);
      }
    });
    semiBtn.addEventListener("click", () => sptSetSemiOnly(!sptSemiOnly));
    pinBtn.addEventListener("click", () => {
      sptPinned = !sptPinned;
      pinBtn.classList.toggle("active", sptPinned);
    });
    closeBtn.addEventListener("click", () => closeSemiPtPopup());

    // 드래그 — 상단바의 빈 영역만(버튼·검색창 제외). 위치는 뷰포트 기준
    // fixed px, 클램프는 sptClamp.
    bar.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, input")) return;
      const r = root.getBoundingClientRect();
      const st = { id: e.pointerId, x: e.clientX, y: e.clientY, top: r.top, left: r.left };
      const move = (ev) => {
        if (ev.pointerId !== st.id) return;
        sptPos = sptApplyPosition(st.top + ev.clientY - st.y, st.left + ev.clientX - st.x);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", () => {
        window.removeEventListener("pointermove", move);
        saveSptState();
      }, { once: true });
      e.preventDefault();
    });
  }

  // x·y(뷰포트 px)를 주면 그 지점 근처(우클릭), 없으면 저장된 위치 또는
  // 화면 가운데 위쪽에 연다.
  function openSemiPtPopup(x, y) {
    buildSptPopup();
    sptRoot.hidden = false;
    sptOpen = true;
    if (typeof x === "number" && typeof y === "number") {
      sptApplyPosition(y, x);
    } else if (sptPos) {
      sptApplyPosition(sptPos.top, sptPos.left);
    } else {
      sptApplyPosition(56, (window.innerWidth - sptRoot.offsetWidth) / 2);
    }
    syncPeriodicSelection();
    sptFilter();
  }
  function closeSemiPtPopup() {
    if (!sptRoot || !sptOpen) return;
    sptRoot.hidden = true;
    sptOpen = false;
  }
  // 에디터(iframe) 쪽 period-table 액션이 부르는 훅 — 같은 출처라 직접 호출
  // (프로젝트 관례: 부모도 contentWindow.ketcher 를 직접 부른다).
  window.molaOpenPeriodicPopup = function () { openSemiPtPopup(); };

  window.addEventListener("resize", () => {
    if (sptOpen && sptPos) sptApplyPosition(sptPos.top, sptPos.left);
  });

  // ── Esc / 바깥 클릭 ──────────────────────────────────────────────
  // 부모 document 와 iframe document 양쪽에 건다(setupCanvasContextMenu 안에서
  // 재사용). preventDefault/stopPropagation 은 부르지 않는다 — Ketcher 자신의
  // Esc 사용을 방해하지 않기 위한 기존 결정 그대로(원장 참조).
  function handleGlobalEscape(e) {
    if (e.key !== "Escape") return;
    // 검색창에 글자가 있으면 그것부터 지운다 — 닫는 건 다음 Esc.
    if (sptOpen && sptSearchEl && e.target === sptSearchEl && sptSearchEl.value) {
      sptSearchEl.value = "";
      sptFilter();
      return;
    }
    if (sptOpen) closeSemiPtPopup();
  }
  document.addEventListener("mousedown", (e) => {
    // 바깥 클릭 닫기 — 고정(📌) 중에는 안 닫는다. iframe 안 클릭은 부모로
    // 버블되지 않으므로 여기 안 걸린다(기존 팝업과 같은 한계 — 캔버스를
    // 클릭해 원자를 찍는 순간은 selectAtom 쪽 닫기가 담당).
    if (sptOpen && !sptPinned && sptRoot && !sptRoot.contains(e.target)) closeSemiPtPopup();
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
      openSemiPtPopup(rect.left + e.clientX, rect.top + e.clientY);
    });
    // iframe 안에서도 클릭/Esc/Space 로 반응하게 — 부모 document 리스너는
    // iframe 내부 이벤트를 보지 못한다(별도 document). 실제 캔버스 조작(우클릭,
    // 원자 클릭, 스페이스바)은 거의 항상 iframe 안에서 일어나므로 이 등록이
    // 핵심 경로다 — 부모 document 쪽 리스너는 우리 자신의 패널·버튼 등
    // 부모 쪽 UI 위에서 일어나는 경우를 위한 보조 경로.
    doc.addEventListener("mousedown", (e) => {
      if (!sptPinned) closeSemiPtPopup();
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
