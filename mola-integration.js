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
    '  <span class="estatus" id="editorStatus"></span>' +
    "</div>" +
    '<div class="frame-slot" id="editorFrameSlot">' +
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
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(async () => {
          try { await idbSet(await k.getKet()); } catch { /* 조용히 */ }
        }, 1500);
      });
    } catch { /* 구독 실패 — 임시저장 없이 진행 */ }
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
