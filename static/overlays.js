if (!window.__workbenchHostPending) {
const state = {
  instances: [],
  components: [],
  defaultComponent: "cascade_stack",
  defaults: {},
  events: [],
  currentId: "",
  current: null,
  dirty: false,
  saveTimer: 0,
  drag: null,
  playhead: 0,
  editPlayhead: 0,
  playing: false,
  lastFrame: 0,
};

const previewAudio = {
  context: null,
  musicBuffer: null,
  musicUrl: "",
  musicSource: null,
  hits: [],
};

const elements = {
  overlayList: document.querySelector("#overlayList"),
  overlayStatus: document.querySelector("#overlayStatus"),
  overlayTitle: document.querySelector("#overlayTitle"),
  overlayType: document.querySelector("#overlayType"),
  overlayHint: document.querySelector("#overlayHint"),
  overlayPreview: document.querySelector("#overlayPreview"),
  overlayTimeline: document.querySelector("#overlayTimeline"),
  overlaySlots: document.querySelector("#overlaySlots"),
  overlayKnobs: document.querySelector("#overlayKnobs"),
  overlayOutputs: document.querySelector("#overlayOutputs"),
  filledCount: document.querySelector("#filledCount"),
  previewTime: document.querySelector("#previewTime"),
  previewPlayButton: document.querySelector("#previewPlayButton"),
  previewRestartButton: document.querySelector("#previewRestartButton"),
  addOverlayButton: document.querySelector("#addOverlayButton"),
  batchUploadButton: document.querySelector("#batchUploadButton"),
  componentMenu: document.querySelector("#componentMenu"),
  renderButton: document.querySelector("#renderButton"),
  duplicateButton: document.querySelector("#duplicateButton"),
  deleteButton: document.querySelector("#deleteButton"),
  eventSelect: document.querySelector("#eventSelect"),
  newEventField: document.querySelector("#newEventField"),
  newEventTitle: document.querySelector("#newEventTitle"),
  publishButton: document.querySelector("#publishButton"),
  publishHint: document.querySelector("#publishHint"),
  toolbarRenderButton: document.querySelector("#toolbarRenderButton"),
  toolbarPublishButton: document.querySelector("#toolbarPublishButton"),
  exportDialog: document.querySelector("#exportDialog"),
  exportChoiceList: document.querySelector("#exportChoiceList"),
  slotFileInput: document.querySelector("#slotFileInput"),
  batchFileInput: document.querySelector("#batchFileInput"),
  musicFileInput: document.querySelector("#musicFileInput"),
  previewFocusHint: document.querySelector("#previewFocusHint"),
  toast: document.querySelector("#toast"),
};

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showToast(message, type = "info") {
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${type === "error" ? "error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 3400);
}

async function requestJson(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") {
    const prefetched = window.workbenchReadPrefetch?.(path);
    if (prefetched) return prefetched;
  } else {
    window.workbenchClearPrefetch?.();
  }
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function setStatus(text, ready) {
  elements.overlayStatus.className = `connection-status ${ready ? "ready" : "missing"}`;
  elements.overlayStatus.querySelector("span").textContent = text;
}

function localComponents() {
  return Object.values(window.OVERLAY_COMPONENTS || {}).map((item) => ({
    id: item.id,
    title: item.title,
  }));
}

function catalogOf(id) {
  return state.components.find((item) => item.id === id) || state.components[0] || null;
}

function menuComponents() {
  if (state.components.length >= 2) return state.components;
  const local = localComponents();
  return local.length >= 2 ? local : state.components;
}

function engineOf(instance = state.current) {
  return window.getOverlayComponent(instance?.component || state.defaultComponent);
}

function paramsOf() {
  return state.current?.params || catalogOf(state.defaultComponent)?.defaults || state.defaults;
}

function currentImages() {
  return state.current?.images || [];
}

function layoutCards() {
  return engineOf().layout(paramsOf(), currentImages());
}

function editCards() {
  const engine = engineOf();
  if (engine.editLayout) return engine.editLayout(paramsOf(), currentImages());
  return engine.layout(paramsOf(), currentImages());
}

function totalDuration() {
  return engineOf().duration(paramsOf(), currentImages());
}

function currentInstance() {
  return state.instances.find((item) => item.id === state.currentId) || null;
}

function markDirty() {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveCurrent().catch(() => {}), 450);
}

async function saveCurrent(force = false) {
  if (!state.currentId || (!state.dirty && !force)) return;
  const payload = {
    title: elements.overlayTitle.value.trim() || state.current.title,
    params: paramsOf(),
  };
  const data = await requestJson(`/api/overlays/${state.currentId}/save`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  replaceInstance(data.instance);
  state.dirty = false;
}

function replaceInstance(instance) {
  const index = state.instances.findIndex((item) => item.id === instance.id);
  if (index >= 0) state.instances[index] = instance;
  else state.instances.unshift(instance);
  if (state.currentId === instance.id) state.current = instance;
}

function renderList() {
  if (!state.instances.length) {
    elements.overlayList.innerHTML = `<div class="clip-empty">还没有叠加模板，点右上角新建。</div>`;
    return;
  }
  elements.overlayList.innerHTML = state.instances
    .map((item) => {
      const active = item.id === state.currentId ? " active" : "";
      const thumb = item.images.find((image) => image.url)?.url;
      const type = item.componentTitle || catalogOf(item.component)?.title || "叠加模板";
      return `<button class="voice-item${active}" type="button" data-overlay="${escapeHtml(item.id)}">
        ${
          thumb
            ? `<img class="voice-avatar" src="${escapeHtml(thumb)}" alt="" />`
            : `<span class="voice-avatar clip-event-mark">${item.filled}</span>`
        }
        <span class="voice-copy">
          <strong>${escapeHtml(item.title)}</strong>
          <small>${item.filled} 张图 · ${escapeHtml(type)}</small>
        </span>
      </button>`;
    })
    .join("");
}

function renderSlots() {
  const instance = state.current;
  if (!instance) {
    elements.overlaySlots.innerHTML = "";
    return;
  }
  const slots = instance.slotCount || instance.images.length;
  elements.filledCount.textContent = `${instance.filled}/${slots}`;
  const params = paramsOf();
  const landSlot = instance.component === "rapid_montage" ? Number(params.landSlot || 0) : 0;
  const currentActiveIndex = Math.max(0, instance.images.findIndex((img, idx) => {
    const target = engineOf().playTarget(idx, params, instance.images);
    return Math.abs(target - state.editPlayhead) < 0.08;
  }));

  const background = instance.hasBackground
    ? `<div class="overlay-slot-card overlay-aux-card" data-slot="0">
        <div class="overlay-card-header">
          <span>底图背景</span>
          <span class="slot-drag-handle"><i data-lucide="image"></i></span>
        </div>
        <div class="overlay-slot-card-preview" data-slot="0" title="点击更换背景图">
          ${
            instance.background?.url
              ? `<img src="${escapeHtml(instance.background.url)}" alt="" />`
              : `<div class="overlay-empty-placeholder"><i data-lucide="image-plus"></i><span>点击放背景</span></div>`
          }
        </div>
        <div class="overlay-card-footer">
          <button class="slot-action-btn" type="button" data-slot="0">更换背景</button>
        </div>
      </div>`
    : "";

  const music = instance.hasMusic
    ? `<div class="overlay-slot-card overlay-aux-card" data-music="1">
        <div class="overlay-card-header">
          <span>切镜配乐</span>
          <span class="slot-drag-handle"><i data-lucide="music"></i></span>
        </div>
        <div class="overlay-slot-card-preview" data-music="1" title="点击更换配乐">
          ${
            instance.music?.file
              ? `<div class="overlay-empty-placeholder"><i data-lucide="disc"></i><span>${escapeHtml(instance.music.file)}</span></div>`
              : `<div class="overlay-empty-placeholder"><i data-lucide="music"></i><span>点击放配乐</span></div>`
          }
        </div>
        <div class="overlay-card-footer">
          <button class="slot-action-btn" type="button" data-music="1">${instance.music?.file ? "更换配乐" : "上传配乐"}</button>
        </div>
      </div>`
    : "";

  const cardItems = instance.images
    .map((image, idx) => {
      const slot = image.slot;
      const isLand = instance.component === "rapid_montage" && (landSlot === slot || (landSlot <= 0 && slot === instance.images.length));
      const isActive = idx === currentActiveIndex;
      const preview = image.url
        ? `<img src="${escapeHtml(image.url)}" alt="" />`
        : `<div class="overlay-empty-placeholder"><i data-lucide="plus"></i><span>点击上传</span></div>`;
      const landButton = instance.component === "rapid_montage"
        ? `<button class="slot-action-btn${isLand ? " is-land-badge" : ""}" type="button" data-set-land="${slot}" title="${isLand ? '当前为刹车定格画面' : '点击设为最终刹车定格'}">
            ${isLand ? "★ 定格帧" : "设为定格"}
          </button>`
        : "";
      return `<div class="overlay-slot-card${isActive ? " is-active-item" : ""}${isLand ? " is-land-slot" : ""}" data-slot="${slot}" data-index="${idx}">
        <div class="overlay-card-header">
          <span>第 ${slot} 帧</span>
          <span class="slot-drag-handle" title="拖动此卡片可排序"><i data-lucide="grip-vertical"></i></span>
        </div>
        <div class="overlay-slot-card-preview" data-select-frame="${idx}" title="点击在右侧取景并定位">
          ${preview}
        </div>
        <div class="overlay-card-footer">
          ${landButton}
          <div class="slot-move-group">
            <button class="slot-move-btn" type="button" data-move-slot="${slot}" data-dir="-1" title="左移" ${slot === 1 ? "disabled" : ""}><i data-lucide="chevron-left"></i></button>
            <button class="slot-move-btn" type="button" data-move-slot="${slot}" data-dir="1" title="右移" ${slot === instance.images.length ? "disabled" : ""}><i data-lucide="chevron-right"></i></button>
          </div>
          <button class="slot-action-btn" type="button" data-slot="${slot}" title="单独替换这张图">换图</button>
        </div>
      </div>`;
    })
    .join("");

  elements.overlaySlots.innerHTML = background + music + cardItems;
  refreshIcons();
}

function formatKnobValue(knob, value) {
  const number = Number(value);
  if (knob.key === "landSlot" && number <= 0) return "最后一张";
  if (knob.labels?.length) {
    const index = (knob.choices || []).findIndex((choice) => Number(choice) === number);
    if (index >= 0 && knob.labels[index]) return knob.labels[index];
  }
  const text = String(knob.step).includes(".") ? number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") : String(Math.round(number));
  return `${text}${knob.unit || ""}`;
}

function renderKnobs() {
  const params = paramsOf();
  const catalog = catalogOf(state.current?.component || state.defaultComponent);
  const knobs = catalog?.knobs || [];
  const focused = document.activeElement;
  const activeKey = focused?.closest?.("#overlayKnobs") && focused.dataset?.key;
  elements.overlayKnobs.innerHTML = knobs
    .map((knob) => {
      const value = params[knob.key];
      if (knob.kind === "bool") {
        const on = !!Number(value);
        return `<div class="overlay-knob">
          <span>${escapeHtml(knob.label)}<strong data-knob-value="${escapeHtml(knob.key)}">${on ? "开" : "关"}</strong></span>
          <div class="overlay-choices">
            <button type="button" class="overlay-choice${on ? "" : " is-active"}" data-key="${escapeHtml(knob.key)}" data-bool-value="0">关</button>
            <button type="button" class="overlay-choice${on ? " is-active" : ""}" data-key="${escapeHtml(knob.key)}" data-bool-value="1">开</button>
          </div>
        </div>`;
      }
      if (knob.kind === "choice") {
        const buttons = (knob.choices || [])
          .map((choice, choiceIndex) => {
            const active = Number(value) === Number(choice) ? " is-active" : "";
            const label = (knob.labels || [])[choiceIndex] ?? `${choice}${knob.unit || ""}`;
            return `<button type="button" class="overlay-choice${active}" data-key="${escapeHtml(knob.key)}" data-value="${choice}">${escapeHtml(String(label))}</button>`;
          })
          .join("");
        return `<div class="overlay-knob">
          <span>${escapeHtml(knob.label)}<strong data-knob-value="${escapeHtml(knob.key)}">${escapeHtml(formatKnobValue(knob, value))}</strong></span>
          <div class="overlay-choices">${buttons}</div>
        </div>`;
      }
      return `<label class="overlay-knob">
        <span>${escapeHtml(knob.label)}<strong data-knob-value="${escapeHtml(knob.key)}">${escapeHtml(formatKnobValue(knob, value))}</strong></span>
        <input type="range" data-key="${escapeHtml(knob.key)}" min="${knob.min}" max="${knob.max}" step="${knob.step}" value="${value}" />
      </label>`;
    })
    .join("");
  if (activeKey) {
    const input = elements.overlayKnobs.querySelector(`input[data-key="${activeKey}"]`);
    input?.focus();
  }
}

function syncKnobValue(key, value) {
  const input = elements.overlayKnobs.querySelector(`input[data-key="${key}"]`);
  const label = elements.overlayKnobs.querySelector(`[data-knob-value="${key}"]`);
  const catalog = catalogOf(state.current?.component || state.defaultComponent);
  const knob = catalog?.knobs?.find((item) => item.key === key);
  if (input && String(input.value) !== String(value)) input.value = value;
  if (label && knob) label.textContent = formatKnobValue(knob, value);
}

function renderEventSelect() {
  if (!elements.eventSelect) return;
  const options = [
    `<option value="__new__">新建事件…</option>`,
    ...state.events.map(
      (event) =>
        `<option value="${escapeHtml(event.id)}">${escapeHtml(event.title)}（${event.clipCount}）</option>`
    ),
  ];
  const previous = elements.eventSelect.value;
  elements.eventSelect.innerHTML = options.join("");
  const stacked = state.events.find((event) => event.id === "stacked-accounts");
  const preferred = [previous, stacked?.id, state.events[0]?.id, "__new__"].find(
    (value) => value && (value === "__new__" || state.events.some((event) => event.id === value))
  );
  elements.eventSelect.value = preferred || "__new__";
  syncNewEventField();
}

function syncNewEventField() {
  if (!elements.newEventField) return;
  const isNew = elements.eventSelect?.value === "__new__";
  elements.newEventField.classList.toggle("hidden", !isNew);
  if (isNew && elements.newEventTitle && !elements.newEventTitle.value) {
    elements.newEventTitle.value = state.current?.title || "";
  }
}

function renderOutputs() {
  const outputs = state.current?.outputs || {};
  const hasBackground = Boolean(state.current?.hasBackground && state.current?.background?.url);
  const keys = [
    ["preview", "预览 mp4"],
    ["webm", hasBackground ? "视频 webm" : "透明 webm"],
    ["mov", hasBackground ? "视频 mov" : "透明 mov"],
  ];
  const items = keys.filter(([key]) => outputs[key]);
  if (!items.length) {
    elements.overlayOutputs.innerHTML = `<p class="field-help">导出后这里会出现预览和下载。</p>`;
    if (elements.exportChoiceList) elements.exportChoiceList.innerHTML = "";
    return;
  }
  const markup = items
    .map(([key, label]) => {
      const file = outputs[key];
      return `<a class="overlay-output" href="${escapeHtml(file.url)}" download>
        <span><strong>${escapeHtml(label)}</strong><small>点击下载</small></span>
        <i data-lucide="download"></i>
      </a>`;
    })
    .join("");
  elements.overlayOutputs.innerHTML = markup;
  if (elements.exportChoiceList) elements.exportChoiceList.innerHTML = markup;
  refreshIcons();
}

function renderTimeline() {
  const cards = layoutCards();
  const duration = totalDuration();
  const needle = state.current?.component === "rapid_montage" ? state.editPlayhead : state.playhead;
  const segments = cards
    .map((card, index) => {
      const left = duration ? (card.start / duration) * 100 : 0;
      const nextStart = cards[index + 1]?.start ?? duration;
      const width = duration ? Math.max(4, ((nextStart - card.start) / duration) * 100) : 100;
      const active = needle >= card.start && (index === cards.length - 1 || needle < nextStart);
      return `<button class="timeline-segment${active ? " is-active" : ""}" type="button" data-beat="${index}" style="left:${left}%;width:${width}%" title="第 ${index + 1} 张：${card.start.toFixed(2)}s–${nextStart.toFixed(2)}s">
        <strong>图 ${index + 1}</strong><small>${card.start.toFixed(1)}s</small>
      </button>`;
    })
    .join("");
  elements.overlayTimeline.innerHTML = `<div class="timeline-label">画面节奏 <span>${formatTimelineTime(duration)}</span></div><div class="timeline-track">${segments}</div>
    <div class="timeline-axis"><span>0:00</span><span>${formatTimelineTime(duration)}</span></div>`;
}

function formatTimelineTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = Math.floor(value % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function styleToCss(style) {
  return Object.entries(style)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`)
    .join(";");
}

function updateRippleFilter(playhead) {
  const map = document.querySelector("#montageRippleMap");
  const noise = document.querySelector("#montageRippleNoise");
  if (!map || !noise) return;
  const instance = state.current;
  if (!instance || instance.component !== "rapid_montage") {
    map.setAttribute("scale", "0");
    return;
  }
  const params = paramsOf();
  const events =
    typeof window.montageEvents === "function" ? window.montageEvents(params, currentImages()) : [];
  const land = events.find((event) => event.kind === "land");
  const anim = Math.max(0, Number(params.landAnim) || 0);
  if (!land || anim <= 0 || playhead < land.start || playhead >= land.start + anim) {
    map.setAttribute("scale", "0");
    return;
  }
  const progress = Math.max(0, Math.min(1, (playhead - land.start) / anim));
  const eased = 1 - (1 - progress) ** 2;
  const amplitude = Math.max(0, Number(params.ripple) || 18) * (1 - eased);
  map.setAttribute("scale", String(amplitude.toFixed(1)));
  noise.setAttribute("baseFrequency", `0.002 ${0.03 + 0.04 * (1 - eased)}`);
  noise.setAttribute("seed", String(2 + Math.floor(progress * 8)));
}

function paintStage(target, playhead, editable) {
  if (!target) return;
  const instance = state.current;
  if (!instance) {
    target.innerHTML = "";
    return;
  }
  const engine = engineOf(instance);
  const params = paramsOf();
  window.syncOverlayCanvas?.(params);
  const viewport = target.closest?.(".overlay-preview-viewport, .overlay-preview-phone");
  const landscape = !!Number(params.landscape);
  if (viewport) viewport.classList.toggle("is-landscape", landscape);
  const badge = document.querySelector(".preview-badge");
  if (badge && badge.dataset.landscape !== String(landscape)) {
    badge.textContent = landscape ? "1920×1080 (16:9)" : "1080×1920 (9:16)";
    badge.dataset.landscape = String(landscape);
  }
  let cards =
    editable && engine.editLayout
      ? engine.editLayout(params, instance.images)
      : engine.layout(params, instance.images);
  if (engine.id === "rapid_montage" && editable) {
    const shown = cards.filter((card) => {
      if (card.kind === "land") return playhead >= card.start;
      return playhead >= card.start && playhead < card.end;
    });
    cards = shown.length ? shown : cards.slice(-1);
  }
  const bgStyle = engine.backgroundStyle?.(params, instance.background);
  const bgUrl = instance.background?.url || "";
  const cardDefs = cards.map((card, mapIndex) => {
    const index = Number.isInteger(card.index)
      ? card.index
      : Number.isInteger(card.slot)
        ? card.slot - 1
        : mapIndex;
    const image = instance.images[index];
    const style =
      editable && engine.editCardStyle
        ? engine.editCardStyle({ ...card, index }, params, playhead, instance.images)
        : engine.cardStyle({ ...card, index }, params, playhead, instance.images);
    const cls = [
      editable ? "overlay-card" : "overlay-card is-preview",
      engine.id === "rapid_montage" ? "is-stage-fill" : engine.fillCards ? "is-fill-cover" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return { index, url: image?.url || null, style, cls };
  });

  // 结构一致时只更新样式和图片，避免拖动过程中整块重建导致闪烁。
  const existing = [...target.querySelectorAll(":scope > .overlay-card")];
  const bgEl = target.querySelector(":scope > .overlay-canvas-bg");
  const sameStructure =
    existing.length === cardDefs.length &&
    cardDefs.every((def, i) => existing[i]?.dataset.index === String(def.index)) &&
    cardDefs.every((def, i) => existing[i]?.classList.contains("is-stage-fill") === def.cls.includes("is-stage-fill")) &&
    Boolean(bgEl) === Boolean(bgUrl);
  updateRippleFilter(playhead);
  if (sameStructure) {
    cardDefs.forEach((def, i) => {
      const node = existing[i];
      let cls = def.cls;
      if (node.classList.contains("is-dragging")) cls += " is-dragging";
      node.className = cls;
      node.setAttribute("style", styleToCss(def.style));
      const img = node.querySelector("img");
      if (def.url) {
        if (img) {
          if (img.getAttribute("src") !== def.url) img.setAttribute("src", def.url);
        } else {
          // 先建实例后传图：节点里还是占位符，这里把真图补进去
          node.innerHTML = `<img src="${escapeHtml(def.url)}" alt="" draggable="false" />`;
        }
      } else if (img || !node.querySelector(".overlay-card-empty")) {
        node.innerHTML = `<span class="overlay-card-empty">${def.index + 1}</span>`;
      }
    });
    if (bgEl && bgStyle) bgEl.setAttribute("style", styleToCss(bgStyle));
    return;
  }
  const background = bgUrl
    ? bgStyle
      ? `<img class="overlay-canvas-bg" src="${escapeHtml(bgUrl)}" alt="" draggable="false" style="${styleToCss(bgStyle)}" />`
      : `<img class="overlay-canvas-bg is-cover" src="${escapeHtml(bgUrl)}" alt="" draggable="false" />`
    : "";
  target.innerHTML =
    background +
    cardDefs
      .map((def) => {
        const image = instance.images[def.index];
        const src = def.url
          ? `<img src="${escapeHtml(def.url)}" alt="" draggable="false" />`
          : `<span class="overlay-card-empty">${def.index + 1}</span>`;
        return `<div class="${def.cls}" data-index="${def.index}" style="${styleToCss(def.style)}">${src}</div>`;
      })
      .join("");
}

function updatePreviewTime() {
  if (!elements.previewTime) return;
  elements.previewTime.textContent = `${state.playhead.toFixed(1)}s`;
  if (elements.previewPlayButton) {
    elements.previewPlayButton.textContent = state.playing ? "暂停" : "播放";
  }
}

function renderCanvas() {
  if (elements.overlayPreview) {
    paintStage(elements.overlayPreview, state.playing ? state.playhead : state.editPlayhead, true);
  }
  updatePreviewTime();
}

function stopPreviewAudio() {
  previewAudio.hits.forEach((source) => {
    try {
      source.stop();
    } catch (_error) {
      /* already stopped */
    }
  });
  previewAudio.hits = [];
  if (previewAudio.musicSource) {
    try {
      previewAudio.musicSource.stop();
    } catch (_error) {
      /* already stopped */
    }
    previewAudio.musicSource = null;
  }
}

function stopPreview() {
  state.playing = false;
  state.lastFrame = 0;
  stopPreviewAudio();
  updatePreviewTime();
}

function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!previewAudio.context) previewAudio.context = new AudioContextClass();
  return previewAudio.context;
}

function makeHitBuffer(context, thump) {
  const duration = thump ? 0.12 : 0.046;
  const length = Math.max(1, Math.floor(context.sampleRate * duration));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    const fade = Math.exp((-5.5 * index) / length);
    const noise = (Math.random() * 2 - 1) * 0.55;
    if (thump) {
      const tone = Math.sin((2 * Math.PI * 68 * index) / context.sampleRate) * 0.7;
      data[index] = (noise * 0.35 + tone) * fade;
    } else {
      data[index] = noise * fade;
    }
  }
  return buffer;
}

async function loadPreviewMusic(url) {
  const context = ensureAudioContext();
  if (!context || !url) {
    previewAudio.musicBuffer = null;
    previewAudio.musicUrl = "";
    return;
  }
  if (previewAudio.musicUrl === url && previewAudio.musicBuffer) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error("配乐读不出来");
  const payload = await response.arrayBuffer();
  previewAudio.musicBuffer = await context.decodeAudioData(payload.slice(0));
  previewAudio.musicUrl = url;
}

function startPreviewAudio(from) {
  const context = ensureAudioContext();
  const instance = state.current;
  if (!context || !instance || instance.component !== "rapid_montage") return;
  const params = paramsOf();
  const events =
    typeof window.montageEvents === "function"
      ? window.montageEvents(params, currentImages())
      : [];
  const now = context.currentTime;
  const hitVolume = Math.max(0, Math.min(1, Number(params.hitVolume || 0) / 100));
  const musicVolume = Math.max(0, Math.min(1, Number(params.musicVolume || 0) / 100));

  if (previewAudio.musicBuffer && musicVolume > 0) {
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = previewAudio.musicBuffer;
    gain.gain.value = musicVolume * 0.55;
    source.connect(gain).connect(context.destination);
    const offset = Math.min(Math.max(0, from), previewAudio.musicBuffer.duration);
    source.start(now, offset);
    previewAudio.musicSource = source;
  }

  if (hitVolume > 0) {
    const hits =
      typeof window.montageHitTimes === "function"
        ? window.montageHitTimes(params, currentImages())
        : events.flatMap((event) =>
            event.kind === "land"
              ? [
                  { time: event.start, thump: true },
                  { time: event.start + 0.18, thump: true },
                ]
              : [{ time: event.start, thump: false }]
          );
    hits.forEach((hit) => {
      if (hit.time < from - 0.02) return;
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = makeHitBuffer(context, Boolean(hit.thump));
      gain.gain.value = hit.thump ? hitVolume * 0.42 : hitVolume * 0.29;
      source.connect(gain).connect(context.destination);
      source.start(now + Math.max(0, hit.time - from));
      previewAudio.hits.push(source);
    });
  }
}

async function playPreview(from = 0, until = totalDuration()) {
  const target = Math.max(from, until);
  stopPreviewAudio();
  state.playing = true;
  state.playhead = from;
  state.lastFrame = performance.now();
  updatePreviewTime();
  const context = ensureAudioContext();
  if (context?.state === "suspended") {
    try {
      await context.resume();
    } catch (_error) {
      /* autoplay blocked */
    }
  }
  if (state.current?.component === "rapid_montage") {
    try {
      await loadPreviewMusic(state.current.music?.url || "");
      if (state.playing) startPreviewAudio(from);
    } catch (error) {
      showToast(error.message, "error");
    }
  }
  const tick = (now) => {
    if (!state.playing) return;
    const elapsed = (now - state.lastFrame) / 1000;
    state.lastFrame = now;
    state.playhead = Math.min(target, state.playhead + elapsed);
    paintStage(elements.overlayPreview, state.playhead, false);
    renderTimeline();
    updatePreviewTime();
    if (state.playhead < target) requestAnimationFrame(tick);
    else stopPreview();
  };
  requestAnimationFrame(tick);
}

function renderComponentMenu() {
  if (!elements.componentMenu) return;
  const items = menuComponents();
  if (items.length < 2) {
    elements.componentMenu.hidden = true;
    elements.componentMenu.innerHTML = "";
    stopComponentDemos();
    return;
  }
  elements.componentMenu.innerHTML = items
    .map(
      (item) =>
        `<button type="button" class="component-menu-item" data-component="${escapeHtml(item.id)}" title="${escapeHtml(item.hint || "")}">` +
        `<span class="component-demo" data-demo="${escapeHtml(item.id)}"></span>` +
        `<span class="component-menu-text">` +
        `<span class="component-menu-title">${escapeHtml(item.title)}</span>` +
        `<span class="component-menu-hint">${escapeHtml(item.hint || "")}</span>` +
        `</span></button>`
    )
    .join("");
}

/* ---- 新建菜单里的动画小样：用真实预览引擎 + 假卡驱动，不用上传图片 ---- */

const DEMO_IMAGES = Array.from({ length: 12 }, (_, i) => ({ width: 620, height: 1400, slot: i + 1 }));
const DEMO_HUES = [
  "linear-gradient(135deg,#a78bfa,#f0abfc)",
  "linear-gradient(135deg,#60a5fa,#a5f3fc)",
  "linear-gradient(135deg,#fbbf24,#fde68a)",
  "linear-gradient(135deg,#34d399,#a7f3d0)",
  "linear-gradient(135deg,#fb7185,#fecdd3)",
];
const DEMO_PERSPECTIVE = 110; // 画布透视 2600px 按小样宽度等比缩小
let demoAnimation = null;

function mountComponentDemos() {
  if (!elements.componentMenu) return;
  elements.componentMenu.querySelectorAll(".component-demo").forEach((stage) => {
    const id = stage.dataset.demo;
    const catalog = (state.components || []).find((item) => item.id === id);
    const engine = getOverlayComponent(id);
    if (!catalog || !engine) return;
    const params = { ...catalog.defaults };
    const images = DEMO_IMAGES.slice(0, Math.max(1, Number(catalog.slotCount) || 4));
    const cards = engine.layout(params, images).map((card, index) => ({ ...card, index }));
    stage.classList.toggle("is-landscape", !!Number(params.landscape));
    stage.innerHTML = cards
      .map(
        (card) => {
          const hue = DEMO_HUES[card.index % DEMO_HUES.length];
          return `<span class="component-demo-card" data-slot="${card.index}" data-hue="${hue}" style="--demo-hue:${hue}"><i></i><i></i></span>`;
        }
      )
      .join("");
    stage._demo = {
      engine,
      params,
      images,
      cards,
      duration: Math.max(1, engine.duration(params, images)),
    };
  });
}

function startComponentDemos() {
  stopComponentDemos();
  if (!elements.componentMenu || elements.componentMenu.hidden) return;
  const stages = [...elements.componentMenu.querySelectorAll(".component-demo")].filter(
    (stage) => stage._demo
  );
  if (!stages.length) return;
  const started = performance.now();
  const tick = (now) => {
    const elapsed = (now - started) / 1000;
    for (const stage of stages) {
      const demo = stage._demo;
      if (!demo) continue;
      window.syncOverlayCanvas?.(demo.params);
      const playhead = elapsed % demo.duration;
      stage.querySelectorAll(".component-demo-card").forEach((node) => {
        const card = demo.cards[Number(node.dataset.slot)];
        if (!card) return;
        const style = demo.engine.cardStyle(
          { ...card, index: card.index },
          demo.params,
          playhead,
          demo.images
        );
        if (!style) return;
        const css = {
          ...style,
          transform: String(style.transform || "").replace(
            /perspective\([^)]+\)/,
            `perspective(${DEMO_PERSPECTIVE}px)`
          ),
        };
        if (node.dataset.hue) css["--demo-hue"] = node.dataset.hue;
        node.setAttribute("style", styleToCss(css));
      });
    }
    demoAnimation = requestAnimationFrame(tick);
  };
  demoAnimation = requestAnimationFrame(tick);
}

function stopComponentDemos() {
  if (demoAnimation) cancelAnimationFrame(demoAnimation);
  demoAnimation = null;
}

function renderAll() {
  renderList();
  renderComponentMenu();
  if (!state.current) {
    elements.overlayTitle.value = "";
    if (elements.overlayType) elements.overlayType.textContent = "叠加模板";
    elements.overlayHint.textContent = "先新建一条，再放图";
    if (elements.overlayPreview) elements.overlayPreview.innerHTML = "";
    elements.overlaySlots.innerHTML = "";
    elements.overlayKnobs.innerHTML = "";
    elements.overlayOutputs.innerHTML = "";
    elements.overlayTimeline.innerHTML = "";
    stopPreview();
    refreshIcons();
    return;
  }
  const catalog = catalogOf(state.current.component);
  elements.overlayTitle.value = state.current.title;
  if (elements.renderButton) {
    const hasBackground = Boolean(state.current.hasBackground && state.current.background?.url);
    const label = document.querySelector("#exportFormat").value === "webm" ? "导出 WebM" : "导出 MP4";
    const text = elements.renderButton.querySelector("span");
    if (text) text.textContent = label;
    elements.renderButton.title = "只生成所选格式；内容未变时复用已有文件";
  }
  if (elements.overlayType) {
    elements.overlayType.textContent = state.current.componentTitle || catalog?.title || "叠加模板";
  }
  elements.overlayHint.textContent = state.current.hint || catalog?.hint || "";
  renderSlots();
  renderKnobs();
  renderEventSelect();
  renderOutputs();
  renderTimeline();
  renderCanvas();
  refreshIcons();
}

function selectInstance(id) {
  stopPreview();
  previewAudio.musicBuffer = null;
  previewAudio.musicUrl = "";
  state.currentId = id;
  state.current = currentInstance();
  state.playhead = totalDuration();
  state.editPlayhead = state.playhead;
  renderAll();
}

async function loadOverlays(preferId) {
  const data = await requestJson("/api/overlays");
  state.instances = data.instances || [];
  state.components = data.components || [];
  state.defaultComponent = data.defaultComponent || "cascade_stack";
  state.defaults = data.defaults || {};
  state.events = data.events || [];
  setStatus(`${state.instances.length} 条叠加模板`, Boolean(state.instances.length));
  const nextId = preferId || state.currentId || state.instances[0]?.id || "";
  if (nextId) selectInstance(nextId);
  else renderAll();
}

async function createOverlay(fromId, componentId) {
  const catalog = catalogOf(componentId || state.defaultComponent);
  const payload = fromId
    ? {
        title: `${currentInstance()?.title || catalog?.defaultTitle || "叠加模板"} 副本`,
        from: fromId,
      }
    : {
        title: catalog?.defaultTitle || "未命名叠加模板",
        component: catalog?.id || state.defaultComponent,
      };
  const data = await requestJson("/api/overlays", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  await loadOverlays(data.instance.id);
  showToast(fromId ? "已复制一条" : `已新建${catalog?.title || "叠加模板"}`);
}

function canvasScale() {
  const rect = elements.overlayPreview.getBoundingClientRect();
  return {
    x: window.OVERLAY_CANVAS.width / rect.width,
    y: window.OVERLAY_CANVAS.height / rect.height,
    rect,
  };
}

function applyDrag(clientX, clientY) {
  if (!state.drag || !state.current) return;
  const scale = canvasScale();
  const x = (clientX - scale.rect.left) * scale.x;
  const y = (clientY - scale.rect.top) * scale.y;
  const engine = engineOf();
  if (state.drag.kind === "background" && engine.applyBackgroundDrag) {
    state.current.params = engine.applyBackgroundDrag(paramsOf(), state.drag, x, y);
  } else if (engine.id === "rapid_montage") {
    state.current.params = engine.applyDrag(paramsOf(), state.drag, x, y, currentImages());
    state.playhead = state.editPlayhead;
  } else {
    state.current.params = engine.applyDrag(
      paramsOf(),
      state.drag,
      x - state.drag.offsetX,
      y - state.drag.offsetY,
      currentImages()
    );
  }
  renderCanvas();
  // 拖拽中不重建时间线（拖拽不改变时长），松手时再刷，避免每帧 DOM 重建造成卡顿
  Object.entries(state.current.params).forEach(([key, value]) => syncKnobValue(key, value));
}

function hideComponentMenu() {
  if (!elements.componentMenu) return;
  elements.componentMenu.hidden = true;
  stopComponentDemos();
}

function endDrag() {
  if (!state.drag) return;
  state.drag = null;
  document.querySelectorAll(".overlay-card.is-dragging").forEach((node) => node.classList.remove("is-dragging"));
  elements.overlayPreview?.classList.remove("is-dragging-bg");
  renderTimeline();
  markDirty();
}

function bindPointerDrag(targetElement) {
  if (!targetElement) return;
  targetElement.addEventListener("pointerdown", (event) => {
    if (!state.current) return;
    const card = event.target.closest(".overlay-card");
    const scale = canvasScale();
    const x = (event.clientX - scale.rect.left) * scale.x;
    const y = (event.clientY - scale.rect.top) * scale.y;
    const engine = engineOf();
    if (card && engine.applyClick) {
      const index = Number(card.dataset.index);
      state.current.params = engine.applyClick(paramsOf(), index, currentImages());
      renderCanvas();
      renderTimeline();
      Object.entries(state.current.params).forEach(([key, value]) => syncKnobValue(key, value));
      markDirty();
      event.preventDefault();
      return;
    }
    if (card) {
      const index = Number(card.dataset.index);
      const layout = engine.editLayout
        ? engine.editLayout(paramsOf(), currentImages())
        : layoutCards();
      const origin = layout[index] || { x: 0, y: 0 };
      state.drag = {
        kind: "card",
        index,
        offsetX: x - origin.x,
        offsetY: y - origin.y,
        startX: x,
        startY: y,
        originFocus: window.montageFocusAt ? window.montageFocusAt(paramsOf(), index) : { x: 50, y: 50 },
      };
      card.classList.add("is-dragging");
    } else if (engine.id === "rapid_montage") {
      // Allow dragging anywhere on the preview canvas for rapid montage
      const layout = engine.layout(paramsOf(), currentImages());
      const shownIndex = layout.findIndex((card) => {
        if (card.kind === "land") return state.editPlayhead >= card.start;
        return state.editPlayhead >= card.start && state.editPlayhead < card.end;
      });
      const index = shownIndex >= 0 ? shownIndex : layout.length - 1;
      state.drag = {
        kind: "card",
        index,
        offsetX: 0,
        offsetY: 0,
        startX: x,
        startY: y,
        originFocus: window.montageFocusAt ? window.montageFocusAt(paramsOf(), index) : { x: 50, y: 50 },
      };
      const stageCard = targetElement.querySelector(".overlay-card");
      if (stageCard) stageCard.classList.add("is-dragging");
    } else if (state.current.background?.url && engineOf().applyBackgroundDrag) {
      const params = paramsOf();
      state.drag = {
        kind: "background",
        offsetX: x - Number(params.bgX || 0),
        offsetY: y - Number(params.bgY || 0),
      };
      targetElement.classList.add("is-dragging-bg");
    } else {
      return;
    }
    try {
      targetElement.setPointerCapture(event.pointerId);
    } catch (_error) {
      /* pointer capture unavailable */
    }
    event.preventDefault();
  });

  targetElement.addEventListener("pointermove", (event) => {
    if (!state.drag) return;
    applyDrag(event.clientX, event.clientY);
  });

  targetElement.addEventListener("pointerup", endDrag);
  targetElement.addEventListener("pointercancel", endDrag);
}

if (elements.overlayPreview) bindPointerDrag(elements.overlayPreview);

elements.overlayKnobs.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
});

function applyParam(key, value, rebuild = false) {
  if (!state.current) return;
  state.current.params = { ...paramsOf(), [key]: value };
  if (key === "cardCount") {
    state.current.slotCount = Number(value);
    state.current.images = (state.current.images || []).slice(0, Number(value));
    while (state.current.images.length < Number(value)) {
      const slot = state.current.images.length + 1;
      state.current.images.push({ slot, file: null, url: null });
    }
    rebuild = true;
  }
  state.playhead = totalDuration();
  state.editPlayhead = state.playhead;
  if (rebuild) {
    renderSlots();
    renderKnobs();
  } else {
    syncKnobValue(key, value);
  }
  renderCanvas();
  renderTimeline();
  markDirty();
}

elements.overlayKnobs.addEventListener("click", (event) => {
  const boolButton = event.target.closest("[data-bool-value]");
  if (boolButton) {
    if (state.current) applyParam(boolButton.dataset.key, boolButton.dataset.boolValue === "1", true);
    return;
  }
  const button = event.target.closest(".overlay-choice");
  if (!button || !state.current) return;
  applyParam(button.dataset.key, Number(button.dataset.value), true);
});

elements.overlayKnobs.addEventListener("input", (event) => {
  const input = event.target.closest("input[data-key]");
  if (!input || !state.current) return;
  const key = input.dataset.key;
  const value = String(input.step).includes(".") ? Number(input.value) : Number.parseInt(input.value, 10);
  applyParam(key, value);
});

elements.overlayTitle.addEventListener("input", () => {
  if (!state.current) return;
  state.current.title = elements.overlayTitle.value;
  renderList();
  markDirty();
});

elements.overlayList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-overlay]");
  if (!button) return;
  await saveCurrent();
  selectInstance(button.dataset.overlay);
});

let slotDrag = null;
let suppressSlotClick = false;

function slotCardsInDom() {
  return [...elements.overlaySlots.querySelectorAll(".overlay-slot-card[data-slot]")].filter(
    (node) => Number(node.dataset.slot) > 0
  );
}

function commitSlotReorder(order) {
  return requestJson(`/api/overlays/${state.currentId}/reorder`, {
    method: "POST",
    body: JSON.stringify({ order }),
  });
}

elements.overlaySlots.addEventListener("pointerdown", (event) => {
  if (!state.current || event.button !== 0) return;
  if (event.target.closest("button")) return;
  const card = event.target.closest(".overlay-slot-card[data-slot]");
  if (!card) return;
  const slot = Number(card.dataset.slot);
  if (!slot) return;
  slotDrag = {
    card,
    slot,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  suppressSlotClick = false;
  try {
    card.setPointerCapture(event.pointerId);
  } catch (_error) {
    /* pointer capture unavailable */
  }
});

elements.overlaySlots.addEventListener("pointermove", (event) => {
  if (!slotDrag || event.pointerId !== slotDrag.pointerId) return;
  const dx = event.clientX - slotDrag.startX;
  const dy = event.clientY - slotDrag.startY;
  if (!slotDrag.moved && Math.hypot(dx, dy) < 6) return;
  if (!slotDrag.moved) {
    slotDrag.moved = true;
    slotDrag.card.classList.add("is-dragging-item");
    suppressSlotClick = true;
  }
  // 找到指针下的目标卡（含间隙：按最近卡片中心计算）
  const cards = slotCardsInDom();
  let target = null;
  let best = Infinity;
  cards.forEach((node) => {
    if (node === slotDrag.card) return;
    const rect = node.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const distance = Math.hypot(event.clientX - cx, event.clientY - cy);
    if (distance < best) {
      best = distance;
      target = node;
    }
  });
  if (!target) return;
  const targetRect = target.getBoundingClientRect();
  const midX = targetRect.left + targetRect.width / 2;
  const midY = targetRect.top + targetRect.height / 2;
  const insertAfter =
    event.clientY > midY || (Math.abs(event.clientY - midY) < targetRect.height / 2 && event.clientX > midX);
  if (insertAfter) {
    target.after(slotDrag.card);
  } else {
    target.before(slotDrag.card);
  }
});

async function finishSlotDrag() {
  if (!slotDrag) return;
  const drag = slotDrag;
  slotDrag = null;
  drag.card.classList.remove("is-dragging-item");
  if (!drag.moved || !state.currentId) return;
  const visualSlots = slotCardsInDom().map((node) => Number(node.dataset.slot));
  const originalSlots = state.current.images.map((img) => img.slot);
  if (visualSlots.join(",") === originalSlots.join(",")) return;
  try {
    const data = await commitSlotReorder(visualSlots);
    replaceInstance(data.instance);
    renderAll();
    showToast("已调整播放顺序");
  } catch (error) {
    renderSlots();
    showToast(error.message, "error");
  }
}

elements.overlaySlots.addEventListener("pointerup", finishSlotDrag);
elements.overlaySlots.addEventListener("pointercancel", finishSlotDrag);

elements.overlaySlots.addEventListener("click", async (event) => {
  if (suppressSlotClick) {
    suppressSlotClick = false;
    return;
  }
  const moveBtn = event.target.closest("[data-move-slot]");
  if (moveBtn && state.currentId) {
    const slot = Number(moveBtn.dataset.moveSlot);
    const dir = Number(moveBtn.dataset.dir);
    const currentOrder = state.current.images.map((img) => img.slot);
    const idx = currentOrder.indexOf(slot);
    const targetIdx = idx + dir;
    if (idx >= 0 && targetIdx >= 0 && targetIdx < currentOrder.length) {
      const temp = currentOrder[idx];
      currentOrder[idx] = currentOrder[targetIdx];
      currentOrder[targetIdx] = temp;
      try {
        const data = await requestJson(`/api/overlays/${state.currentId}/reorder`, {
          method: "POST",
          body: JSON.stringify({ order: currentOrder }),
        });
        replaceInstance(data.instance);
        renderAll();
        showToast("已更新顺序");
      } catch (error) {
        showToast(error.message, "error");
      }
    }
    return;
  }

  const setLandBtn = event.target.closest("[data-set-land]");
  if (setLandBtn && state.currentId) {
    const slot = Number(setLandBtn.dataset.setLand);
    applyParam("landSlot", slot);
    renderSlots();
    showToast(`已设为定格在第 ${slot} 帧`);
    return;
  }

  const selectFrame = event.target.closest("[data-select-frame]");
  if (selectFrame) {
    const idx = Number(selectFrame.dataset.selectFrame);
    const image = state.current?.images?.[idx];
    if (image && !image.url) {
      elements.slotFileInput.dataset.slot = String(image.slot);
      elements.slotFileInput.click();
      return;
    }
    stopPreview();
    const target = engineOf().playTarget(idx, paramsOf(), currentImages());
    state.playhead = target;
    state.editPlayhead = target;
    renderTimeline();
    renderCanvas();
    renderSlots();
    updatePreviewTime();
    return;
  }

  const musicButton = event.target.closest("[data-music]");
  if (musicButton) {
    elements.musicFileInput?.click();
    return;
  }
  const button = event.target.closest("[data-slot]");
  if (!button) return;
  elements.slotFileInput.dataset.slot = button.dataset.slot;
  elements.slotFileInput.click();
});

elements.batchUploadButton?.addEventListener("click", () => {
  if (!state.currentId) return;
  elements.batchFileInput?.click();
});

elements.batchFileInput?.addEventListener("change", async () => {
  const files = Array.from(elements.batchFileInput.files || []);
  elements.batchFileInput.value = "";
  if (!files.length || !state.currentId) return;

  showToast(`正在批量读取 ${files.length} 张图片…`);
  try {
    const encodedList = await Promise.all(
      files.map(async (file) => {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
          reader.readAsDataURL(file);
        });
        return { filename: file.name, data: dataUrl };
      })
    );

    await saveCurrent(true);
    const data = await requestJson(`/api/overlays/${state.currentId}/batch-images`, {
      method: "POST",
      body: JSON.stringify({ files: encodedList, startSlot: 1 }),
    });
    replaceInstance(data.instance);
    renderAll();
    showToast(`成功批量导入 ${files.length} 张图片`);
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.musicFileInput?.addEventListener("change", async () => {
  const file = elements.musicFileInput.files?.[0];
  elements.musicFileInput.value = "";
  if (!file || !state.currentId) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读音频失败"));
    reader.readAsDataURL(file);
  });
  try {
    await saveCurrent(true);
    const data = await requestJson(`/api/overlays/${state.currentId}/music`, {
      method: "POST",
      body: JSON.stringify({ filename: file.name, data: dataUrl }),
    });
    replaceInstance(data.instance);
    renderAll();
    showToast("配乐已放上");
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.slotFileInput.addEventListener("change", async () => {
  const file = elements.slotFileInput.files?.[0];
  const slot = Number(elements.slotFileInput.dataset.slot);
  elements.slotFileInput.value = "";
  if (!file || !state.currentId) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读图失败"));
    reader.readAsDataURL(file);
  });
  try {
    await saveCurrent(true);
    const data = await requestJson(`/api/overlays/${state.currentId}/image`, {
      method: "POST",
      body: JSON.stringify({ slot, filename: file.name, data: dataUrl }),
    });
    replaceInstance(data.instance);
    renderAll();
    showToast(slot === 0 ? "背景已换上" : `第 ${slot} 张已换上`);
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.addOverlayButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const items = menuComponents();
  if (items.length > 1 && elements.componentMenu) {
    renderComponentMenu();
    elements.componentMenu.hidden = !elements.componentMenu.hidden;
    if (elements.componentMenu.hidden) {
      stopComponentDemos();
    } else {
      mountComponentDemos();
      startComponentDemos();
    }
    return;
  }
  createOverlay().catch((error) => showToast(error.message, "error"));
});

elements.componentMenu?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-component]");
  if (!button) return;
  hideComponentMenu();
  createOverlay("", button.dataset.component).catch((error) => showToast(error.message, "error"));
});

document.addEventListener("click", (event) => {
  if (!elements.componentMenu || elements.componentMenu.hidden) return;
  if (event.target.closest("#addOverlayButton") || event.target.closest("#componentMenu")) return;
  hideComponentMenu();
});

elements.duplicateButton.addEventListener("click", () => {
  if (!state.currentId) return;
  createOverlay(state.currentId).catch((error) => showToast(error.message, "error"));
});

elements.deleteButton.addEventListener("click", async () => {
  if (!state.currentId) return;
  if (!window.confirm("删除这条叠加模板？图片也会一起删。")) return;
  await requestJson(`/api/overlays/${state.currentId}/delete`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  state.currentId = "";
  state.current = null;
  await loadOverlays();
  showToast("已删除");
});

elements.eventSelect?.addEventListener("change", syncNewEventField);

elements.publishButton?.addEventListener("click", async () => {
  if (!state.currentId) return;
  if (!state.current?.outputs?.preview) {
    showToast("请先导出 MP4，再加入事件镜头", "error");
    return;
  }
  const selected = elements.eventSelect?.value || "__new__";
  const title = elements.newEventTitle?.value.trim() || state.current.title;
  const payload = selected === "__new__" ? { title } : { eventId: selected };
  try {
    const data = await requestJson(`/api/overlays/${state.currentId}/publish`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.events = data.events || state.events;
    renderEventSelect();
    const published = data.published || {};
    showToast(
      published.created
        ? `已新建事件「${published.eventTitle}」，可去事件镜头查看`
        : `已加入「${published.eventTitle}」`
    );
  } catch (error) {
    showToast(error.message, "error");
  }
});

document.querySelector("#exportFormat").addEventListener("change", () => {
  if (!elements.renderButton.disabled) elements.renderButton.querySelector("span").textContent = document.querySelector("#exportFormat").value === "webm" ? "导出 WebM" : "导出 MP4";
});

elements.renderButton.addEventListener("click", async () => {
  if (!state.currentId) return;
  elements.renderButton.disabled = true;
  document.querySelector("#exportFormat").disabled = true;
  elements.renderButton.querySelector("span").textContent = "导出中…";
  try {
    await saveCurrent(true);
    const data = await requestJson(`/api/overlays/${state.currentId}/render`, {
      method: "POST",
      body: JSON.stringify({
        title: elements.overlayTitle.value,
        params: paramsOf(),
        formats: [document.querySelector("#exportFormat").value],
      }),
    });
    replaceInstance(data.instance);
    renderAll();
    showToast(data.instance.cacheHit ? "文件未改变，直接下载已有成品" : "模板已导出，可在结果区下载");
    if (data.instance.cacheHit) {
      const output = data.instance.outputs[document.querySelector("#exportFormat").value];
      const download = document.createElement("a");
      download.href = output.url;
      download.download = output.file;
      document.body.appendChild(download);
      download.click();
      download.remove();
    } else openExportDialog();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.renderButton.disabled = false;
    document.querySelector("#exportFormat").disabled = false;
    const hasBackground = Boolean(state.current?.hasBackground && state.current?.background?.url);
    elements.renderButton.querySelector("span").textContent = document.querySelector("#exportFormat").value === "webm" ? "导出 WebM" : "导出 MP4";
    refreshIcons();
  }
});

elements.overlayTimeline.addEventListener("click", (event) => {
  const beat = event.target.closest("[data-beat]");
  if (!beat) return;
  const index = Number(beat.dataset.beat);
  stopPreview();
  const target = engineOf().playTarget(index, paramsOf(), currentImages());
  state.playhead = target;
  state.editPlayhead = target;
  renderTimeline();
  renderCanvas();
  updatePreviewTime();
});

elements.previewPlayButton?.addEventListener("click", () => {
  if (!state.current) return;
  if (state.playing) {
    stopPreview();
    return;
  }
  const duration = totalDuration();
  const from = state.playhead >= duration - 0.05 ? 0 : state.playhead;
  playPreview(from, duration);
});

elements.previewRestartButton?.addEventListener("click", () => {
  if (!state.current) return;
  playPreview(0, totalDuration());
});

elements.toolbarRenderButton?.addEventListener("click", () => elements.renderButton?.click());
elements.toolbarPublishButton?.addEventListener("click", () => {
  if (elements.exportDialog && typeof elements.exportDialog.showModal === "function") {
    elements.exportDialog.showModal();
  }
});

function openExportDialog() {
  if (!elements.exportDialog || !state.current?.outputs) return;
  if (typeof elements.exportDialog.showModal === "function") elements.exportDialog.showModal();
}

loadOverlays().catch((error) => {
  setStatus("读取失败", false);
  showToast(error.message, "error");
});
refreshIcons();
}
