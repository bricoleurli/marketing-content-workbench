const OVERLAY_CANVAS = { width: 1080, height: 1920 };

/* 画幅：竖版 9:16（1080×1920）或横版 16:9（1920×1080），跟随当前实例的 landscape 参数 */
function overlayCanvasSize(params) {
  return params && Number(params.landscape)
    ? { width: 1920, height: 1080 }
    : { width: 1080, height: 1920 };
}

function syncOverlayCanvas(params) {
  const size = overlayCanvasSize(params);
  OVERLAY_CANVAS.width = size.width;
  OVERLAY_CANVAS.height = size.height;
  return OVERLAY_CANVAS;
}

const TILE_GAP = 22;

function overlayEaseOutCubic(t) {
  const x = Math.max(0, Math.min(1, t));
  return 1 - (1 - x) ** 3;
}

function overlayCardProgress(t, start, anim) {
  if (t <= start) return 0;
  return overlayEaseOutCubic((t - start) / anim);
}

function cascadeCardSize(params, image) {
  const cardW = params.cardWidth;
  if (image?.width && image?.height) {
    return { w: cardW, h: Math.round((cardW * image.height) / image.width) };
  }
  if (params.aspect > 0) {
    return { w: cardW, h: Math.round(cardW / params.aspect) };
  }
  return { w: cardW, h: Math.round(cardW * (16 / 9)) };
}

function tileCount(params, images = []) {
  const count = Number(params.cardCount);
  if (count === 4 || count === 6 || count === 8) return count;
  return images.length || 4;
}

function montageCount(params, images = []) {
  const requested = Number(params.cardCount);
  if (requested >= 1 && requested <= 14) return requested;
  return Math.max(1, Math.min(14, images.length || 13));
}

function montageLandSlot(params, images = []) {
  const count = montageCount(params, images);
  const requested = Number(params.landSlot) || 0;
  if (requested <= 0 || requested > count) return count;
  return requested;
}

function holdForCut(cutIndex, hold, rush) {
  if (cutIndex <= 2) return hold;
  return Math.min(hold, rush);
}

function montageEvents(params, images = []) {
  const count = montageCount(params, images);
  const hold = Math.max(0.06, Number(params.hold) || 0.2);
  const rush = Math.max(0.06, Math.min(hold, Number(params.rush) || 0.13));
  const landHold = Math.max(0.2, Number(params.landHold) || 1.2);
  const land = montageLandSlot(params, images);
  const events = [];
  let time = 0;
  let cutIndex = 0;
  for (let slot = 1; slot <= count; slot += 1) {
    if (slot === land) continue;
    cutIndex += 1;
    const duration = holdForCut(cutIndex, hold, rush);
    events.push({
      index: slot,
      start: time,
      end: time + duration,
      kind: "cut",
      cutIndex,
    });
    time += duration;
  }
  events.push({ index: land, start: time, end: time + landHold, kind: "land", cutIndex: 0 });
  return events;
}

function montageHitTimes(params, images = []) {
  return montageEvents(params, images).map((event) => ({
    time: event.start,
    thump: event.kind === "land",
  }));
}

function montageVisible(card, playhead) {
  if (card.kind === "land") return playhead >= card.start;
  return playhead >= card.start && playhead < card.end;
}

function montageFocusAt(params, index) {
  const stored = Array.isArray(params.focuses) ? params.focuses[index] : null;
  const x = Number(stored?.x);
  const y = Number(stored?.y);
  return {
    x: Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : 50,
    y: Number.isFinite(y) ? Math.max(0, Math.min(100, y)) : 50,
  };
}

function montageCoverStyle(params, images, index) {
  const image = images[index];
  const canvas = OVERLAY_CANVAS;
  const naturalW = Number(image?.width) || canvas.width;
  const naturalH = Number(image?.height) || canvas.height;
  const scale = Math.max(canvas.width / naturalW, canvas.height / naturalH);
  const width = naturalW * scale;
  const height = naturalH * scale;
  const overflowX = Math.max(0, width - canvas.width);
  const overflowY = Math.max(0, height - canvas.height);
  const focus = montageFocusAt(params, index);
  return {
    left: `${(-(overflowX * focus.x) / 100 / canvas.width) * 100}%`,
    top: `${(-(overflowY * focus.y) / 100 / canvas.height) * 100}%`,
    width: `${(width / canvas.width) * 100}%`,
    height: `${(height / canvas.height) * 100}%`,
  };
}

function tileGridShape(count) {
  if (count === 6) return { cols: 3, rows: 2 };
  if (count === 8) return { cols: 4, rows: 2 };
  return { cols: 2, rows: 2 };
}

function tileDefaultPositions(params, images = []) {
  const count = tileCount(params, images);
  const { cols } = tileGridShape(count);
  const cardW = params.cardWidth;
  const sizes = Array.from({ length: count }, (_, index) => cascadeCardSize(params, images[index]));
  const cellH = Math.max(...sizes.map((size) => size.h), 1);
  const gridW = cols * cardW + (cols - 1) * TILE_GAP;
  const originX = Math.max(24, Math.floor((OVERLAY_CANVAS.width - gridW) / 2));
  const originY = params.originY || 220;
  return Array.from({ length: count }, (_, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      x: originX + col * (cardW + TILE_GAP),
      y: originY + row * (cellH + TILE_GAP),
    };
  });
}

/* ---- 3D/动效类组件共用工具（与叠卡叠加件/overlay_fx.py 保持同一套投影参数） ---- */
const FX_PERSPECTIVE = 2600;

function fxCount(params, images, min, max) {
  const requested = Number(params.cardCount);
  if (requested >= min && requested <= max) return Math.round(requested);
  return Math.max(min, Math.min(max, images.length || min));
}

function fxPct(value, total) {
  return `${(value / total) * 100}%`;
}

function fxEaseInOutCubic(t) {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function fxFrontPosition(t, n, step, anim) {
  const slot = Math.min(Math.floor(t / step), n - 1);
  const into = t - slot * step;
  if (into >= anim || slot >= n - 1) return slot;
  return slot + overlayEaseOutCubic(into / anim);
}

function fxThrownCount(t, n, lead, interval, anim) {
  let thrown = 0;
  for (let k = 0; k < n - 1; k += 1) {
    thrown += Math.max(0, Math.min(1, (t - lead - k * interval) / anim));
  }
  return thrown;
}

function fxRadiusStyle(params) {
  return `${Math.max(0, Number(params.radius) || 0)}px`;
}

function ringCardStyle(card, params, progress, theta) {
  const radius = params.ringRadius * (0.55 + 0.45 * Math.min(1, progress));
  const depth = radius * Math.cos(theta);
  const k = FX_PERSPECTIVE / (FX_PERSPECTIVE - depth);
  const w = card.w * k;
  const h = card.h * k;
  const cx = OVERLAY_CANVAS.width / 2 + radius * Math.sin(theta) * k;
  const deg = (theta * 180) / Math.PI;
  const norm = ((deg % 360) + 360) % 360;
  const facing = norm > 180 ? norm - 360 : norm;
  const back = Math.max(0, Math.min(1, (Math.abs(facing) - 65) / 85));
  const brightness = 1 - 0.75 * ((Number(params.backDim) || 0) / 100) * back;
  return {
    left: fxPct(cx - w / 2, OVERLAY_CANVAS.width),
    top: fxPct(params.centerY - h / 2, OVERLAY_CANVAS.height),
    width: fxPct(w, OVERLAY_CANVAS.width),
    height: fxPct(h, OVERLAY_CANVAS.height),
    opacity: Math.min(1, progress / 0.8),
    transform: `perspective(${FX_PERSPECTIVE}px) rotateY(${deg}deg)`,
    filter: brightness < 0.99 ? `brightness(${brightness.toFixed(3)})` : "none",
    zIndex: String(100 + Math.round(depth)),
    borderRadius: fxRadiusStyle(params),
  };
}

function coverflowState(index, u, params) {
  const d = index - u;
  const a = Math.abs(d);
  const s = d > 0 ? 1 : d < 0 ? -1 : 0;
  return {
    off: s * params.gap * a ** 0.85,
    rot: s * params.tilt * Math.min(1, a),
    scale: 1 - 0.24 * Math.min(a, 2.4),
    bright: 1 - 0.38 * Math.min(a, 2),
    alpha: Math.max(0, Math.min(1, 2.6 - a)),
  };
}

function coverflowCardStyle(card, params, u, entranceAlpha) {
  const state = coverflowState(card.index, u, params);
  return {
    left: fxPct(OVERLAY_CANVAS.width / 2 + state.off - card.w / 2, OVERLAY_CANVAS.width),
    top: fxPct(params.centerY - card.h / 2, OVERLAY_CANVAS.height),
    width: fxPct(card.w, OVERLAY_CANVAS.width),
    height: fxPct(card.h, OVERLAY_CANVAS.height),
    opacity: state.alpha * entranceAlpha,
    transform: `perspective(${FX_PERSPECTIVE}px) rotateY(${state.rot}deg) scale(${state.scale})`,
    filter: state.bright < 0.99 ? `brightness(${state.bright.toFixed(3)})` : "none",
    zIndex: String(100 - Math.round(Math.abs(card.index - u) * 10)),
    borderRadius: fxRadiusStyle(params),
  };
}

function stackCardStyle(card, params, thrown) {
  const slot = card.index - thrown;
  const scale = 1 - 0.045 * Math.max(0, slot);
  let x = OVERLAY_CANVAS.width / 2 - card.w / 2;
  let y = params.centerY - card.h / 2 + Math.max(0, slot) * params.spread;
  let rot = card.baseRot;
  let opacity = 1;
  if (slot < 0) {
    const f = -slot;
    const ease = f * f;
    x += ease * 190;
    y -= ease * 430;
    rot += (Number(params.throwRot) || 0) * ease;
    opacity = 1 - f * f;
  }
  return {
    left: fxPct(x, OVERLAY_CANVAS.width),
    top: fxPct(y, OVERLAY_CANVAS.height),
    width: fxPct(card.w, OVERLAY_CANVAS.width),
    height: fxPct(card.h, OVERLAY_CANVAS.height),
    opacity: slot <= -0.999 ? 0 : opacity,
    transform: `scale(${scale}) rotate(${rot}deg)`,
    zIndex: String(100 - Math.round(slot * 10)),
    borderRadius: fxRadiusStyle(params),
  };
}

function fanOpenAmount(t, params) {
  if (t <= 0) return 0;
  if (t < params.anim) return 1 - (1 - t / params.anim) ** 3;
  if (t < params.anim + params.hold) return 1;
  return 1 - fxEaseInOutCubic((t - params.anim - params.hold) / Math.max(0.05, params.fold));
}

function fanCardPosition(card, params, amount) {
  const angle = (card.spread * amount * Math.PI) / 180;
  return {
    x: OVERLAY_CANVAS.width / 2 + params.arm * Math.sin(angle),
    y: params.centerY + params.arm * (1 - Math.cos(angle)),
  };
}

const OVERLAY_COMPONENTS = {
  cascade_stack: {
    id: "cascade_stack",
    title: "斜向叠卡",
    layout(params, images = []) {
      const n = images.length || 4;
      const first = cascadeCardSize(params, images[0]);
      const stackW = first.w + params.dx * (n - 1);
      const originX = params.originX || Math.max(24, Math.floor((OVERLAY_CANVAS.width - stackW) / 2));
      const originY = params.originY;
      return Array.from({ length: n }, (_, i) => {
        const size = cascadeCardSize(params, images[i]);
        return {
          x: originX + i * params.dx,
          y: originY + i * params.dy,
          w: size.w,
          h: size.h,
          start: i * params.stagger,
        };
      });
    },
    duration(params, images = []) {
      const n = Math.max(1, images.length || 4);
      return (n - 1) * params.stagger + params.anim + params.hold;
    },
    playTarget(index, params) {
      return index * params.stagger + params.anim;
    },
    applyDrag(params, drag, x, y, images) {
      const next = { ...params };
      if (drag.index === 0) {
        next.originX = Math.round(Math.max(8, Math.min(600, x)));
        next.originY = Math.round(Math.max(24, Math.min(700, y)));
        return next;
      }
      const first = this.layout(params, images)[0];
      next.dx = Math.round(Math.max(0, Math.min(180, (x - first.x) / drag.index)));
      next.dy = Math.round(Math.max(0, Math.min(220, (y - first.y) / drag.index)));
      return next;
    },
    cardStyle(card, params, playhead) {
      const progress = overlayCardProgress(playhead, card.start, params.anim);
      const opacity = progress <= 0 ? 0.18 : 0.35 + 0.65 * Math.min(1, progress / 0.85);
      const scale = 0.9 + 0.1 * Math.max(progress, 0.15);
      const dy = (1 - Math.max(progress, 0.2)) * 36;
      const radius = Math.max(0, Number(params.radius) || 0);
      return {
        left: `${(card.x / OVERLAY_CANVAS.width) * 100}%`,
        top: `${((card.y + dy) / OVERLAY_CANVAS.height) * 100}%`,
        width: `${(card.w / OVERLAY_CANVAS.width) * 100}%`,
        height: `${(card.h / OVERLAY_CANVAS.height) * 100}%`,
        opacity,
        transform: `scale(${scale})`,
        zIndex: String(card.index + 1),
        borderRadius: `${radius}px`,
      };
    },
  },
  tile_spread: {
    id: "tile_spread",
    title: "平铺展开",
    layout(params, images = []) {
      const count = tileCount(params, images);
      const defaults = tileDefaultPositions(params, images);
      const custom = Array.isArray(params.positions) ? params.positions : [];
      return Array.from({ length: count }, (_, index) => {
        const size = cascadeCardSize(params, images[index]);
        const pos = custom[index] || defaults[index];
        return {
          x: pos.x,
          y: pos.y,
          w: size.w,
          h: size.h,
          start: index * params.stagger,
        };
      });
    },
    duration(params, images = []) {
      const n = Math.max(1, tileCount(params, images));
      return (n - 1) * params.stagger + params.anim + params.hold;
    },
    playTarget(index, params) {
      return index * params.stagger + params.anim;
    },
    applyDrag(params, drag, x, y, images) {
      const layout = this.layout(params, images);
      const card = layout[drag.index];
      if (!card) return params;
      const positions = layout.map((item) => ({ x: item.x, y: item.y }));
      positions[drag.index] = {
        x: Math.round(Math.max(8, Math.min(OVERLAY_CANVAS.width - card.w - 8, x))),
        y: Math.round(Math.max(8, Math.min(OVERLAY_CANVAS.height - card.h - 8, y))),
      };
      return { ...params, positions };
    },
    applyBackgroundDrag(params, drag, x, y) {
      return {
        ...params,
        bgX: Math.round(Math.max(-1200, Math.min(1200, x - drag.offsetX))),
        bgY: Math.round(Math.max(-1600, Math.min(1600, y - drag.offsetY))),
      };
    },
    backgroundStyle(params, background) {
      if (!background?.url) return null;
      const naturalW = background.width || OVERLAY_CANVAS.width;
      const naturalH = background.height || OVERLAY_CANVAS.height;
      const cover = Math.max(OVERLAY_CANVAS.width / naturalW, OVERLAY_CANVAS.height / naturalH);
      const scale = cover * Math.max(0.5, Math.min(2.5, Number(params.bgScale || 100) / 100));
      const width = naturalW * scale;
      const height = naturalH * scale;
      const x = (OVERLAY_CANVAS.width - width) / 2 + Number(params.bgX || 0);
      const y = (OVERLAY_CANVAS.height - height) / 2 + Number(params.bgY || 0);
      return {
        left: `${(x / OVERLAY_CANVAS.width) * 100}%`,
        top: `${(y / OVERLAY_CANVAS.height) * 100}%`,
        width: `${(width / OVERLAY_CANVAS.width) * 100}%`,
        height: `${(height / OVERLAY_CANVAS.height) * 100}%`,
      };
    },
    cardStyle(card, params, playhead) {
      const progress = overlayCardProgress(playhead, card.start, params.anim);
      const opacity = progress <= 0 ? 0.14 : 0.4 + 0.6 * Math.min(1, progress / 0.85);
      const scale = 0.92 + 0.08 * Math.max(progress, 0.2);
      const dy = (1 - Math.max(progress, 0.2)) * 18;
      const radius = Math.max(0, Number(params.radius) || 0);
      return {
        left: `${(card.x / OVERLAY_CANVAS.width) * 100}%`,
        top: `${((card.y + dy) / OVERLAY_CANVAS.height) * 100}%`,
        width: `${(card.w / OVERLAY_CANVAS.width) * 100}%`,
        height: `${(card.h / OVERLAY_CANVAS.height) * 100}%`,
        opacity,
        transform: `scale(${scale})`,
        zIndex: String(card.index + 2),
        borderRadius: `${radius}px`,
      };
    },
  },
  rapid_montage: {
    id: "rapid_montage",
    title: "快切蒙太奇",
    layout(params, images = []) {
      const events = montageEvents(params, images);
      const bySlot = Object.fromEntries(events.map((event) => [event.index, event]));
      const count = montageCount(params, images);
      return Array.from({ length: count }, (_, index) => {
        const event = bySlot[index + 1];
        return {
          x: 0,
          y: 0,
          w: OVERLAY_CANVAS.width,
          h: OVERLAY_CANVAS.height,
          start: event?.start ?? index * Number(params.hold || 0.2),
          end: event?.end,
          kind: event?.kind || "cut",
          slot: index + 1,
        };
      });
    },
    editLayout(params, images = []) {
      return this.layout(params, images);
    },
    duration(params, images = []) {
      const events = montageEvents(params, images);
      return events[events.length - 1]?.end || Number(params.landHold || 1.2);
    },
    playTarget(index, params, images = []) {
      const cards = this.layout(params, images);
      const card = cards[index];
      return card ? card.start + 0.04 : 0;
    },
    applyDrag(params, drag, x, y, images = []) {
      const count = montageCount(params, images);
      const index = Math.max(0, Math.min(count - 1, drag.index));
      const image = images[index];
      const canvas = OVERLAY_CANVAS;
      const naturalW = Number(image?.width) || canvas.width;
      const naturalH = Number(image?.height) || canvas.height;
      const scale = Math.max(canvas.width / naturalW, canvas.height / naturalH);
      const overflowX = Math.max(0, naturalW * scale - canvas.width);
      const overflowY = Math.max(0, naturalH * scale - canvas.height);
      const origin = drag.originFocus || montageFocusAt(params, index);
      const dx = x - (drag.startX || 0);
      const dy = y - (drag.startY || 0);
      const focuses = Array.from({ length: count }, (_, slot) => montageFocusAt(params, slot));
      focuses[index] = {
        x: overflowX ? Math.max(0, Math.min(100, origin.x - (dx / overflowX) * 100)) : 50,
        y: overflowY ? Math.max(0, Math.min(100, origin.y - (dy / overflowY) * 100)) : 50,
      };
      return { ...params, focuses };
    },
    cardStyle(card, params, playhead, images = []) {
      const visible = montageVisible(card, playhead);
      const cover = montageCoverStyle(params, images, card.index ?? card.slot - 1);
      let filter = "none";
      if (card.kind === "land") {
        const anim = Math.max(0, Number(params.landAnim) || 0);
        if (anim > 0 && playhead >= card.start && playhead < card.start + anim) {
          filter = "url(#montageRipple)";
        }
      }
      return {
        left: cover.left,
        top: cover.top,
        width: cover.width,
        height: cover.height,
        opacity: visible ? 1 : 0,
        transform: "none",
        filter,
        zIndex: String(visible ? 5 : 1),
        borderRadius: "0px",
        boxShadow: "none",
        cursor: "grab",
      };
    },
  },
  ring_carousel: {
    id: "ring_carousel",
    title: "3D 旋转木马",
    layout(params, images = []) {
      const n = fxCount(params, images, 3, 8);
      return Array.from({ length: n }, (_, i) => {
        const size = cascadeCardSize(params, images[i]);
        return {
          x: OVERLAY_CANVAS.width / 2 - size.w / 2,
          y: params.centerY - size.h / 2,
          w: size.w,
          h: size.h,
          start: i * params.stagger,
          angle: (i * 360) / n,
        };
      });
    },
    duration(params, images = []) {
      const n = fxCount(params, images, 3, 8);
      return (n - 1) * params.stagger + params.anim + params.hold;
    },
    playTarget(index, params) {
      return index * params.stagger + params.anim * 0.7;
    },
    applyDrag(params, drag, x, y) {
      if (!drag._base) drag._base = { centerY: Number(params.centerY) || 660, ringRadius: Number(params.ringRadius) || 440 };
      const dx = x + (drag.offsetX || 0) - drag.startX;
      const dy = y + (drag.offsetY || 0) - drag.startY;
      return {
        ...params,
        centerY: Math.round(Math.max(360, Math.min(1200, drag._base.centerY + dy))),
        ringRadius: Math.round(Math.max(280, Math.min(680, drag._base.ringRadius + dx))),
      };
    },
    cardStyle(card, params, playhead) {
      const progress = overlayCardProgress(playhead, card.start, params.anim);
      const theta = (card.angle * Math.PI) / 180 - ((Number(params.spinSpeed) || 30) * playhead * Math.PI) / 180;
      return ringCardStyle(card, params, progress, theta);
    },
    editCardStyle(card, params) {
      return ringCardStyle(card, params, 1, (card.angle * Math.PI) / 180);
    },
  },
  coverflow: {
    id: "coverflow",
    title: "Coverflow 涌流",
    layout(params, images = []) {
      const n = fxCount(params, images, 3, 8);
      return Array.from({ length: n }, (_, i) => {
        const size = cascadeCardSize(params, images[i]);
        const state = coverflowState(i, 0, params);
        return {
          x: OVERLAY_CANVAS.width / 2 + state.off - size.w / 2,
          y: params.centerY - size.h / 2,
          w: size.w,
          h: size.h,
          start: i * 0.06,
          count: n,
        };
      });
    },
    editLayout(params, images = []) {
      return this.layout(params, images);
    },
    duration(params, images = []) {
      const n = fxCount(params, images, 3, 8);
      return (n - 1) * params.step + params.anim + params.hold;
    },
    playTarget(index, params) {
      return index * params.step + params.anim;
    },
    applyDrag(params, drag, x, y) {
      if (!drag._base) drag._base = { centerY: Number(params.centerY) || 660, gap: Number(params.gap) || 250 };
      const dx = x + (drag.offsetX || 0) - drag.startX;
      const dy = y + (drag.offsetY || 0) - drag.startY;
      return {
        ...params,
        centerY: Math.round(Math.max(360, Math.min(1200, drag._base.centerY + dy))),
        gap: Math.round(Math.max(140, Math.min(420, drag._base.gap + dx))),
      };
    },
    cardStyle(card, params, playhead) {
      const n = card.count || 6;
      const u = fxFrontPosition(playhead, n, params.step, params.anim);
      const enter = overlayCardProgress(playhead, card.start, 0.3);
      return coverflowCardStyle(card, params, u, Math.min(1, enter / 0.8));
    },
    editCardStyle(card, params) {
      return coverflowCardStyle(card, params, 0, Math.max(0.25, coverflowState(card.index, 0, params).alpha));
    },
  },
  card_stack: {
    id: "card_stack",
    title: "牌堆滑走",
    layout(params, images = []) {
      const n = fxCount(params, images, 3, 8);
      return Array.from({ length: n }, (_, i) => {
        const size = cascadeCardSize(params, images[i]);
        return {
          x: OVERLAY_CANVAS.width / 2 - size.w / 2,
          y: params.centerY - size.h / 2,
          w: size.w,
          h: size.h,
          start: 0,
          count: n,
          baseRot: (((i * 37) % 9) - 4) * 1.6,
        };
      });
    },
    editLayout(params, images = []) {
      return this.layout(params, images);
    },
    duration(params, images = []) {
      const n = fxCount(params, images, 3, 8);
      return 0.35 + (n - 1) * params.interval + params.anim + params.hold;
    },
    playTarget(index, params) {
      if (index <= 0) return 0.05;
      return 0.35 + (index - 1) * params.interval + params.anim * 0.6;
    },
    applyDrag(params, drag, x, y) {
      if (!drag._base) drag._base = { centerY: Number(params.centerY) || 720 };
      const dy = y + (drag.offsetY || 0) - drag.startY;
      return { ...params, centerY: Math.round(Math.max(480, Math.min(1200, drag._base.centerY + dy))) };
    },
    cardStyle(card, params, playhead) {
      const n = card.count || 5;
      const thrown = fxThrownCount(playhead, n, 0.35, params.interval, params.anim);
      return stackCardStyle(card, params, thrown);
    },
    editCardStyle(card, params) {
      return stackCardStyle(card, params, 0);
    },
  },
  filmstrip: {
    id: "filmstrip",
    title: "胶片横滚",
    layout(params, images = []) {
      const n = fxCount(params, images, 4, 12);
      const slotW = params.cardWidth + params.gap;
      return Array.from({ length: n }, (_, i) => {
        const size = cascadeCardSize(params, images[i]);
        const x = i * slotW - params.cardWidth;
        return {
          x: Math.max(8, Math.min(OVERLAY_CANVAS.width - size.w - 8, x)),
          y: params.stripY - size.h / 2,
          w: size.w,
          h: size.h,
          start: 0,
          count: n,
        };
      });
    },
    editLayout(params, images = []) {
      const n = fxCount(params, images, 4, 12);
      const cols = Math.min(6, n);
      return Array.from({ length: n }, (_, i) => {
        const size = cascadeCardSize(params, images[i]);
        return {
          x: 24 + (i % cols) * (size.w * 0.6 + 28),
          y: params.stripY - size.h / 2 + Math.floor(i / cols) * (size.h * 0.55 + 28),
          w: size.w,
          h: size.h,
          start: 0,
          count: n,
        };
      });
    },
    duration(params) {
      return Math.max(0.8, Number(params.hold) || 3);
    },
    playTarget(index, params) {
      const slotW = params.cardWidth + params.gap;
      return ((index * slotW) / Math.max(1, params.speed)) % this.duration(params);
    },
    applyDrag(params, drag, x, y) {
      if (!drag._base) drag._base = { stripY: Number(params.stripY) || 640 };
      const dy = y + (drag.offsetY || 0) - drag.startY;
      return { ...params, stripY: Math.round(Math.max(300, Math.min(1300, drag._base.stripY + dy))) };
    },
    cardStyle(card, params, playhead) {
      const slotW = params.cardWidth + params.gap;
      const loopW = (card.count || 8) * slotW;
      const raw = card.index * slotW + (Number(params.direction) || -1) * params.speed * playhead;
      const x = ((raw % loopW) + loopW) % loopW - params.cardWidth;
      const fadeZone = 140;
      const edge = Math.min((x + card.w) / fadeZone, (OVERLAY_CANVAS.width - x) / fadeZone, 1);
      const alpha = Math.max(0, Math.min(1, edge)) * Math.min(1, playhead / Math.max(0.05, params.fadeIn));
      return {
        left: fxPct(x, OVERLAY_CANVAS.width),
        top: fxPct(params.stripY - card.h / 2, OVERLAY_CANVAS.height),
        width: fxPct(card.w, OVERLAY_CANVAS.width),
        height: fxPct(card.h, OVERLAY_CANVAS.height),
        opacity: alpha,
        transform: "none",
        zIndex: String(1 + card.index),
        borderRadius: fxRadiusStyle(params),
      };
    },
    editCardStyle(card, params, playhead, images = []) {
      const box = this.editLayout(params, images)[card.index] || card;
      return {
        left: fxPct(box.x, OVERLAY_CANVAS.width),
        top: fxPct(box.y, OVERLAY_CANVAS.height),
        width: fxPct(box.w, OVERLAY_CANVAS.width),
        height: fxPct(box.h, OVERLAY_CANVAS.height),
        opacity: 1,
        transform: "none",
        zIndex: String(1 + card.index),
        borderRadius: fxRadiusStyle(params),
      };
    },
  },
  fan_spread: {
    id: "fan_spread",
    title: "扇形展开",
    layout(params, images = []) {
      const n = fxCount(params, images, 3, 7);
      return Array.from({ length: n }, (_, i) => {
        const size = cascadeCardSize(params, images[i]);
        const spread = (i - (n - 1) / 2) * (params.fanAngle / Math.max(1, n - 1));
        const pos = fanCardPosition({ spread }, params, 1);
        return {
          x: pos.x - size.w / 2,
          y: pos.y - size.h / 2,
          w: size.w,
          h: size.h,
          start: i * 0.04,
          spread,
          count: n,
        };
      });
    },
    editLayout(params, images = []) {
      return this.layout(params, images);
    },
    duration(params) {
      return params.anim + params.hold + params.fold;
    },
    playTarget(index, params) {
      return params.anim * 0.9;
    },
    applyDrag(params, drag, x, y) {
      if (!drag._base) drag._base = { centerY: Number(params.centerY) || 780 };
      const dy = y + (drag.offsetY || 0) - drag.startY;
      return { ...params, centerY: Math.round(Math.max(480, Math.min(1200, drag._base.centerY + dy))) };
    },
    cardStyle(card, params, playhead) {
      const amount = fanOpenAmount(playhead, params);
      const pos = fanCardPosition(card, params, amount);
      const depth = Math.abs(card.index - ((card.count || 5) - 1) / 2);
      return {
        left: fxPct(pos.x - card.w / 2, OVERLAY_CANVAS.width),
        top: fxPct(pos.y - card.h / 2, OVERLAY_CANVAS.height),
        width: fxPct(card.w, OVERLAY_CANVAS.width),
        height: fxPct(card.h, OVERLAY_CANVAS.height),
        opacity: amount <= 0.001 ? 0 : 1,
        transform: `rotate(${card.spread * amount}deg)`,
        zIndex: String(100 - Math.round(depth * 10)),
        borderRadius: fxRadiusStyle(params),
      };
    },
    editCardStyle(card, params) {
      const pos = fanCardPosition(card, params, 1);
      return {
        left: fxPct(pos.x - card.w / 2, OVERLAY_CANVAS.width),
        top: fxPct(pos.y - card.h / 2, OVERLAY_CANVAS.height),
        width: fxPct(card.w, OVERLAY_CANVAS.width),
        height: fxPct(card.h, OVERLAY_CANVAS.height),
        opacity: 1,
        transform: `rotate(${card.spread}deg)`,
        zIndex: String(100 - Math.round(Math.abs(card.index - ((card.count || 5) - 1) / 2) * 10)),
        borderRadius: fxRadiusStyle(params),
      };
    },
  },
};

function getOverlayComponent(id) {
  return OVERLAY_COMPONENTS[id] || OVERLAY_COMPONENTS.cascade_stack;
}

window.OVERLAY_CANVAS = OVERLAY_CANVAS;
window.getOverlayComponent = getOverlayComponent;
window.OVERLAY_COMPONENTS = OVERLAY_COMPONENTS;
window.montageEvents = montageEvents;
window.montageHitTimes = montageHitTimes;
window.montageFocusAt = montageFocusAt;
window.syncOverlayCanvas = syncOverlayCanvas;
