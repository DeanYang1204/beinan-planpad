// ============ 渲染器（時間切片 + 視口裁剪） ============
import type { PlanDoc, VecEntity, Viewport } from "../types";
import { fontStack, measureTextBlock, toVerticalForms, TEXT_LINE_HEIGHT } from "../types";
import type { DocStore } from "./document";
import type { BBox } from "./geometry";
import { entityBbox, entityBboxRaw, shapeVerts, bendHandlePos, rotateHandlePos, arrowBendHandlePos, arrowHeadGeom, arrowRenderPoints } from "./geometry";

export interface RenderOpts {
  deviceRatio: number;
  cssW: number;
  cssH: number;
  view: Viewport;
  selection: Set<string>;
  hoverId?: string | null;
  ghost?: VecEntity | null;
  marquee?: BBox | null;
  snapPt?: [number, number] | null;
  minStrokeW?: number;
  /** 是否顯示網格背景 */
  showGrid?: boolean;
  /** 十字準星位置（螢幕座標 px），隨滑鼠移動 */
  crosshair?: [number, number] | null;
  /** select 工具下矩形邊中點為「拉伸」把手（綠色），否則為「插入錨點」把手（藍色） */
  midHandleStretch?: boolean;
  /** 圖層不透明度映射（layerId → 0–1）；缺漏視為 1 */
  layerOpacity?: Map<string, number>;
}

export interface RenderState {
  /** 本次渲染要畫的 entity 列表 */
  list: VecEntity[] | null;
  /** 已畫到第幾個 */
  i: number;
  /** 本次渲染的 viewport（判斷是否失效） */
  viewKey: string;
}

export function worldToScreen(v: Viewport, wx: number, wy: number): [number, number] {
  return [v.ox + wx * v.scale, v.oy + wy * v.scale];
}

export function screenToWorld(v: Viewport, sx: number, sy: number): [number, number] {
  return [(sx - v.ox) / v.scale, (sy - v.oy) / v.scale];
}

export function viewBBox(opts: RenderOpts): BBox {
  const v = opts.view;
  const x0 = (0 - v.ox) / v.scale;
  const y0 = (0 - v.oy) / v.scale;
  const x1 = (opts.cssW - v.ox) / v.scale;
  const y1 = (opts.cssH - v.oy) / v.scale;
  return [x0, y0, x1, y1];
}

function setupTransform(ctx: CanvasRenderingContext2D, opts: RenderOpts) {
  ctx.setTransform(opts.deviceRatio, 0, 0, opts.deviceRatio, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/** 計算「漂亮」的網格間距（1/2/5 × 10^n），使螢幕間距維持在約 60px */
function niceGridStep(scale: number): number {
  const targetPx = 60;
  const raw = targetPx / scale;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  let step: number;
  if (norm < 1.5) step = 1;
  else if (norm < 3.5) step = 2;
  else if (norm < 7.5) step = 5;
  else step = 10;
  return step * pow;
}

/** 畫網格背景（在白色底圖之上、實體之下） */
export function renderGrid(ctx: CanvasRenderingContext2D, opts: RenderOpts) {
  const v = opts.view;
  const s = v.scale;
  const step = niceGridStep(s);
  const vb = viewBBox(opts);
  const x0 = Math.floor(vb[0] / step) * step;
  const y0 = Math.floor(vb[1] / step) * step;
  ctx.strokeStyle = "rgba(148, 163, 184, 0.25)"; // 淺灰藍，不搶實體
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= vb[2]; x += step) {
    const sx = x * s + v.ox;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, opts.cssH);
  }
  for (let y = y0; y <= vb[3]; y += step) {
    const sy = y * s + v.oy;
    ctx.moveTo(0, sy);
    ctx.lineTo(opts.cssW, sy);
  }
  ctx.stroke();
}

/** 圖片物件快取（避免每幀重複建立 Image） */
const imageCache = new Map<string, HTMLImageElement>();
function getImage(dataUrl: string): HTMLImageElement | null {
  if (typeof document === "undefined") return null;
  let img = imageCache.get(dataUrl);
  if (!img) {
    img = document.createElement("img");
    img.src = dataUrl;
    imageCache.set(dataUrl, img);
  }
  return img;
}

/** 畫單一 entity（座標為 world，透過 view 轉換）；外層套用所屬圖層不透明度 */
export function renderEntity(ctx: CanvasRenderingContext2D, e: VecEntity, opts: RenderOpts) {
  const layerOp = opts.layerOpacity?.get(e.layerId) ?? 1;
  ctx.save();
  if (layerOp < 1) ctx.globalAlpha = layerOp;
  renderEntityInner(ctx, e, opts);
  ctx.restore();
}

/** renderEntity 的實際繪製主體（圖層不透明度已在外層套用） */
function renderEntityInner(ctx: CanvasRenderingContext2D, e: VecEntity, opts: RenderOpts) {
  const v = opts.view;
  const s = v.scale;
  const minW = opts.minStrokeW ?? 0;

  if (e.kind === "image") {
    const img = getImage(e.imageData ?? "");
    if (!img || !img.complete) return; // 圖未載入完成先跳過（渲染循環下一幀會再畫）
    const w = e.w ?? 100;
    const h = e.h ?? 100;
    const cxw = e.pts[0] + w / 2;
    const cyw = e.pts[1] + h / 2;
    const [ccx, ccy] = worldToScreen(v, cxw, cyw);
    ctx.save();
    ctx.translate(ccx, ccy);
    if (e.userRot) ctx.rotate(e.userRot);
    ctx.drawImage(img, (-w * s) / 2, (-h * s) / 2, w * s, h * s);
    ctx.restore();
    return;
  }

  if (e.kind === "text") {
    const fspt = e.fontSize ?? 12;
    const fs = fspt * s;
    if (fs < 2) return; // 太小的文字不畫（zoom 時）
    const vertical = !!e.vertical;
    const blk = measureTextBlock(e.text ?? "", fspt, e.fontFamily, vertical);
    // 旋轉中心（未旋轉 bbox 中心，world）：橫書文字塊頂端在 baseline 上方 fspt，多行總高 blk.h；直書在字塊中心
    const cxw = e.pts[0] + blk.w / 2;
    const cyw = vertical ? e.pts[1] + blk.h / 2 : e.pts[1] - fspt + blk.h / 2;
    const [sx, sy] = worldToScreen(v, e.pts[0], e.pts[1]);
    const [ccx, ccy] = worldToScreen(v, cxw, cyw);
    ctx.save();
    // 先繞中心旋轉 userRot（PS 自由變換），再回到錨點做 PDF 傾斜 rot
    ctx.translate(ccx, ccy);
    if (e.userRot) ctx.rotate(e.userRot);
    ctx.translate(sx - ccx, sy - ccy);
    if (e.rot) ctx.rotate(e.rot);
    ctx.font = `${fs}px ${fontStack(e.fontFamily)}`;
    ctx.textBaseline = "alphabetic";
    const text = e.text ?? "";
    // 直書時標點換為直式字形（︵︶等），橫書維持原字
    const chars = [...(vertical ? toVerticalForms(text) : text)];
    const tw = blk.w;
    // 文字塊：底色與邊框（padding 隨字號等比，與 SVG 匯出同一公式；多行高度用 blk.h）
    if (e.bgColor || (e.borderColor && e.borderWidth)) {
      const padX = fspt * 0.15 * s;
      const padY = fspt * 0.25 * s;
      const bx = -padX;
      const by = vertical ? -padY : -fs - padY;
      const bw = tw * s + padX * 2;
      const bh = blk.h * s + padY * 2;
      if (e.bgColor) {
        const op = e.bgOpacity ?? 1;
        ctx.save();
        if (op < 1) ctx.globalAlpha = op;
        ctx.fillStyle = e.bgColor;
        ctx.fillRect(bx, by, bw, bh);
        ctx.restore();
      }
      if (e.borderColor && e.borderWidth) {
        ctx.strokeStyle = e.borderColor;
        ctx.lineWidth = Math.max(1, e.borderWidth * s);
        ctx.strokeRect(bx, by, bw, bh);
      }
    }
    ctx.fillStyle = e.stroke;
    if (vertical) {
      // 直書：字元由上而下，水平置中於字塊內
      ctx.textBaseline = "top";
      for (let i = 0; i < chars.length; i++) {
        const cw = ctx.measureText(chars[i]).width;
        ctx.fillText(chars[i], (tw * s - cw) / 2, i * fs);
      }
    } else {
      // 橫書：按換行拆行，逐行繪製（行距 = 字號×行高）
      const lines = text.split("\n");
      const lineH = fs * TEXT_LINE_HEIGHT;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], 0, i * lineH);
      }
    }
    ctx.restore();
    return;
  }

  // 以 Path2D 建構圖形路徑：clip / fill / stroke 共用同一份路徑。
  // （不用 ctx 目前路徑的原因：填充分支會 beginPath 畫填充線，save/restore 不會還原路徑，
  //   導致最後的 ctx.stroke() 把整組填充線未裁剪地再描一次而洩漏到圖形外）
  const path = new Path2D();
  const n = e.pts.length / 2;
  if (e.kind === "arc") {
    const [sx, sy] = worldToScreen(v, e.pts[0], e.pts[1]);
    const [cx, cy] = worldToScreen(v, e.pts[2], e.pts[3]);
    const [ex, ey] = worldToScreen(v, e.pts[4], e.pts[5]);
    path.moveTo(sx, sy);
    path.quadraticCurveTo(cx, cy, ex, ey);
  } else if (e.kind === "ellipse") {
    const cx = ((e.pts[0] + e.pts[2]) / 2) * s + v.ox;
    const cy = ((e.pts[1] + e.pts[3]) / 2) * s + v.oy;
    const rx = (Math.abs(e.pts[2] - e.pts[0]) / 2) * s;
    const ry = (Math.abs(e.pts[3] - e.pts[1]) / 2) * s;
    path.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  } else if (e.kind === "star" || e.kind === "trapezoid") {
    const verts = shapeVerts(e);
    path.moveTo(verts[0] * s + v.ox, verts[1] * s + v.oy);
    for (let i = 1; i < verts.length / 2; i++) {
      path.lineTo(verts[i * 2] * s + v.ox, verts[i * 2 + 1] * s + v.oy);
    }
    path.closePath();
  } else if (e.kind === "rect" && e.radius) {
    // 圓角矩形：以 bbox 左上角 + 寬高繪製
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const px = e.pts[i * 2], py = e.pts[i * 2 + 1];
      if (px < x0) x0 = px;
      if (py < y0) y0 = py;
      if (px > x1) x1 = px;
      if (py > y1) y1 = py;
    }
    const w = x1 - x0, h = y1 - y0;
    const r = Math.min(e.radius, w / 2, h / 2) * s;
    if (typeof path.roundRect === "function") {
      path.roundRect(x0 * s + v.ox, y0 * s + v.oy, w * s, h * s, r);
    } else {
      path.rect(x0 * s + v.ox, y0 * s + v.oy, w * s, h * s);
    }
  } else if (e.kind === "arrow" && n >= 2) {
    // 箭頭：依樣式取樣（直線/彎曲/直角/雙向），路徑已在頭部內縮短避免圓線帽凸出
    const rp = arrowRenderPoints(e);
    path.moveTo(rp[0] * s + v.ox, rp[1] * s + v.oy);
    for (let i = 1; i < rp.length / 2; i++) {
      path.lineTo(rp[i * 2] * s + v.ox, rp[i * 2 + 1] * s + v.oy);
    }
  } else {
    path.moveTo(e.pts[0] * s + v.ox, e.pts[1] * s + v.oy);
    for (let i = 1; i < n; i++) {
      path.lineTo(e.pts[i * 2] * s + v.ox, e.pts[i * 2 + 1] * s + v.oy);
    }
    if (e.closed) path.closePath();
  }

  if (e.fill === "hatch") {
    // 斜線填充（45° 剖面線）：以目前路徑為 clip 區域，畫等距斜線
    ctx.save();
    ctx.clip(path);
    const bb = e.bbox || entityBbox(e);
    const x0 = bb[0] * s + v.ox;
    const y0 = bb[1] * s + v.oy;
    const bw = (bb[2] - bb[0]) * s;
    const bh = (bb[3] - bb[1]) * s;
    ctx.strokeStyle = e.stroke;
    ctx.lineWidth = Math.max(0.5, e.width * s * 0.5);
    ctx.beginPath();
    const step = Math.max(1, 6 * s);
    for (let off = -bh; off < bw + bh; off += step) {
      ctx.moveTo(x0 + off, y0 + bh);
      ctx.lineTo(x0 + off + bh, y0);
    }
    ctx.stroke();
    ctx.restore();
  } else if (e.fill === "grid") {
    // 網格填充（水平＋垂直方格）：以目前路徑為 clip 區域，畫等距十字線
    ctx.save();
    ctx.clip(path);
    const bb = e.bbox || entityBbox(e);
    const gx0 = bb[0] * s + v.ox;
    const gy0 = bb[1] * s + v.oy;
    const gx1 = bb[2] * s + v.ox;
    const gy1 = bb[3] * s + v.oy;
    ctx.strokeStyle = e.stroke;
    ctx.lineWidth = Math.max(0.5, e.width * s * 0.4);
    const gstep = Math.max(1, 8 * s);
    ctx.beginPath();
    for (let x = gx0; x <= gx1; x += gstep) {
      ctx.moveTo(x, gy0);
      ctx.lineTo(x, gy1);
    }
    for (let y = gy0; y <= gy1; y += gstep) {
      ctx.moveTo(gx0, y);
      ctx.lineTo(gx1, y);
    }
    ctx.stroke();
    ctx.restore();
  } else if (e.fill === "xgrid") {
    // 斜網格填充（兩組對角線交叉成菱形格）：以目前路徑為 clip 區域
    ctx.save();
    ctx.clip(path);
    const bb = e.bbox || entityBbox(e);
    const x0 = bb[0] * s + v.ox;
    const y0 = bb[1] * s + v.oy;
    const bw = (bb[2] - bb[0]) * s;
    const bh = (bb[3] - bb[1]) * s;
    ctx.strokeStyle = e.stroke;
    ctx.lineWidth = Math.max(0.5, e.width * s * 0.4);
    const step = Math.max(1, 8 * s);
    ctx.beginPath();
    // +45°（右下）
    for (let off = -bh; off < bw + bh; off += step) {
      ctx.moveTo(x0 + off, y0);
      ctx.lineTo(x0 + off + bh, y0 + bh);
    }
    // -45°（右上）
    for (let off = -bh; off < bw + bh; off += step) {
      ctx.moveTo(x0 + off, y0 + bh);
      ctx.lineTo(x0 + off + bh, y0);
    }
    ctx.stroke();
    ctx.restore();
  } else if (e.fill) {
    ctx.fillStyle = e.fill;
    ctx.fill(path);
  }
  const lw = Math.max(e.width * s, minW);
  ctx.strokeStyle = e.stroke;
  ctx.lineWidth = lw;
  if (e.dash) {
    const parts = e.dash.split(",").map((x) => parseFloat(x) * s);
    ctx.setLineDash(parts);
  } else {
    ctx.setLineDash([]);
  }
  // 無外邊框：填充圖案不描外輪廓（圖案線已在 fill 分支內以 stroke 色繪製）
  if (!e.noStroke) {
    ctx.stroke(path);
  }
  ctx.setLineDash([]);

  // 箭頭（實心三角，頭部大小與線寬成比例；雙向樣式兩端都有頭）
  if (e.kind === "arrow") {
    const drawHead = (h: { tip: [number, number]; w1: [number, number]; w2: [number, number] }) => {
      const [tx, ty] = worldToScreen(v, h.tip[0], h.tip[1]);
      const [ax, ay] = worldToScreen(v, h.w1[0], h.w1[1]);
      const [bx, by] = worldToScreen(v, h.w2[0], h.w2[1]);
      ctx.fillStyle = e.stroke;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fill();
    };
    const hEnd = arrowHeadGeom(e, "end");
    if (hEnd) drawHead(hEnd);
    if ((e.arrowStyle ?? "straight") === "both") {
      const hStart = arrowHeadGeom(e, "start");
      if (hStart) drawHead(hStart);
    }
  }
}

/** 時間切片渲染：在 budgetMs 內盡量畫，回傳是否全部完成 */
export function renderChunk(
  ctx: CanvasRenderingContext2D,
  store: DocStore,
  opts: RenderOpts,
  state: RenderState,
  budgetMs: number
): boolean {
  const t0 = performance.now();
  setupTransform(ctx, opts);

  const viewKey = `${opts.view.scale.toFixed(3)}|${opts.view.ox.toFixed(1)}|${opts.view.oy.toFixed(1)}|${opts.cssW}|${opts.cssH}|${store.version}|${opts.showGrid ? 1 : 0}`;

  // 若 view 或資料變了，重新開始
  if (state.viewKey !== viewKey || !state.list) {
    state.viewKey = viewKey;
    state.i = 0;
    // 清空畫布
    ctx.clearRect(0, 0, opts.cssW, opts.cssH);
    // 底圖背景：白色
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, opts.cssW, opts.cssH);
    // 網格背景（在實體之下）
    if (opts.showGrid) renderGrid(ctx, opts);
    // 收集可見 entity
    const vb = viewBBox(opts);
    const vis = store.visibleEntities();
    state.list = [];
    for (const e of vis) {
      if (!e.bbox) e.bbox = entityBbox(e);
      if (e.bbox[2] < vb[0] || e.bbox[0] > vb[2] || e.bbox[3] < vb[1] || e.bbox[1] > vb[3]) continue;
      state.list.push(e);
    }
  }

  // 逐條畫（list 已按圖層堆疊由下而上排序；同層內文字排最後）
  while (state.i < state.list.length) {
    const e = state.list[state.i++];
    renderEntity(ctx, e, opts);
    if (performance.now() - t0 > budgetMs) return false;
  }

  return true;
}

/** Overlay：選取高亮、頂點、吸附、框選、預覽 */
export function renderOverlay(
  ctx: CanvasRenderingContext2D,
  store: DocStore,
  opts: RenderOpts
) {
  setupTransform(ctx, opts);
  const v = opts.view;
  const s = v.scale;

  // 框選矩形
  if (opts.marquee) {
    const [x0, y0, x1, y1] = opts.marquee;
    const sx = x0 * s + v.ox, sy = y0 * s + v.oy;
    ctx.fillStyle = "rgba(98, 59, 252, 0.12)";
    ctx.strokeStyle = "#623bfc";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.fillRect(sx, sy, (x1 - x0) * s, (y1 - y0) * s);
    ctx.strokeRect(sx, sy, (x1 - x0) * s, (y1 - y0) * s);
    ctx.setLineDash([]);
  }

  // 選取高亮 + 頂點把手
  const selected = store.getSelected();
  for (const e of selected) {
    const bb = e.bbox || entityBbox(e);
    // 高亮外框
    const sx = bb[0] * s + v.ox, sy = bb[1] * s + v.oy;
    const w = (bb[2] - bb[0]) * s, h = (bb[3] - bb[1]) * s;
    ctx.strokeStyle = "#623bfc";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(sx - 3, sy - 3, w + 6, h + 6);
    ctx.setLineDash([]);

    // 旋轉把手（單選文字/圖片）：頂邊中點上方圓點 + 連接線（PS 自由變換）
    if (selected.length === 1 && (e.kind === "text" || e.kind === "image")) {
      const hp = rotateHandlePos(e, s);
      if (hp) {
        const raw = entityBboxRaw(e);
        const cx = (raw[0] + raw[2]) / 2;
        const cy = (raw[1] + raw[3]) / 2;
        const hh = raw[3] - raw[1];
        const rot = e.userRot ?? 0;
        const sin = Math.sin(rot), cos = Math.cos(rot);
        const tmx = (cx + (hh / 2) * sin) * s + v.ox;
        const tmy = (cy - (hh / 2) * cos) * s + v.oy;
        const hx = hp[0] * s + v.ox;
        const hy = hp[1] * s + v.oy;
        ctx.strokeStyle = "#623bfc";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(tmx, tmy);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#623bfc";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // 頂點把手（線/折線/弧線；文字只給中心點）
    if (e.kind === "text") {
      drawHandle(ctx, e.pts[0] * s + v.ox, e.pts[1] * s + v.oy, "#623bfc");
    } else {
      const n = e.pts.length / 2;
      for (let i = 0; i < n; i++) {
        drawHandle(ctx, e.pts[i * 2] * s + v.ox, e.pts[i * 2 + 1] * s + v.oy, "#623bfc");
      }
      // 中點把手：select 工具下矩形＝拉伸（綠色）；anchor 工具下＝插入錨點（藍色空心）
      if (selected.length === 1 && e.kind !== "arc" && e.kind !== "ellipse" && e.kind !== "star" && e.kind !== "trapezoid") {
        const isRect = e.kind === "rect";
        if (!opts.midHandleStretch || isRect) {
          const stretch = !!opts.midHandleStretch;
          const segs = e.closed ? n : n - 1;
          for (let i = 0; i < segs; i++) {
            const j = (i + 1) % n;
            const mx = (e.pts[i * 2] + e.pts[j * 2]) / 2;
            const my = (e.pts[i * 2 + 1] + e.pts[j * 2 + 1]) / 2;
            if (stretch) {
              // 拉伸把手：綠色小方塊
              ctx.fillStyle = "#10b981";
              ctx.fillRect(mx * s + v.ox - 3, my * s + v.oy - 3, 6, 6);
            } else {
              ctx.strokeStyle = "#623bfc";
              ctx.fillStyle = "#ffffff";
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.arc(mx * s + v.ox, my * s + v.oy, 3.5, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }
          }
        }
      }
      // 弧度把手（僅單選 2 點直線：拖動可把直線彎成弧線）
      if (selected.length === 1 && e.kind === "line" && e.pts.length === 4) {
        const hp = bendHandlePos(e, s);
        if (hp) {
          const hx = hp[0] * s + v.ox, hy = hp[1] * s + v.oy;
          const mx = ((e.pts[0] + e.pts[2]) / 2) * s + v.ox;
          const my = ((e.pts[1] + e.pts[3]) / 2) * s + v.oy;
          // 導線（虛線）＋ 弧形小圖示把手
          ctx.strokeStyle = "#8b5cf6";
          ctx.lineWidth = 1.2;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(hx, hy, 5, Math.PI * 0.15, Math.PI * 0.85);
          ctx.stroke();
          ctx.fillStyle = "#8b5cf6";
          ctx.beginPath();
          ctx.arc(hx, hy, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // 彎曲箭頭弧度把手（單選 curved 箭頭：拖動調整弧度大小與方向）
      if (selected.length === 1 && e.kind === "arrow" && (e.arrowStyle ?? "straight") === "curved") {
        const hp = arrowBendHandlePos(e, s);
        if (hp) {
          const hx = hp[0] * s + v.ox, hy = hp[1] * s + v.oy;
          const mx = ((e.pts[0] + e.pts[2]) / 2) * s + v.ox;
          const my = ((e.pts[1] + e.pts[3]) / 2) * s + v.oy;
          ctx.strokeStyle = "#8b5cf6";
          ctx.lineWidth = 1.2;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(hx, hy, 5, Math.PI * 0.15, Math.PI * 0.85);
          ctx.stroke();
          ctx.fillStyle = "#8b5cf6";
          ctx.beginPath();
          ctx.arc(hx, hy, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // hover 高亮
  if (opts.hoverId) {
    const e = store.doc?.entities.find((x) => x.id === opts.hoverId);
    if (e && !store.selection.has(e.id)) {
      const bb = e.bbox || entityBbox(e);
      ctx.strokeStyle = "rgba(37, 99, 235, 0.6)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(bb[0] * s + v.ox, bb[1] * s + v.oy, (bb[2] - bb[0]) * s, (bb[3] - bb[1]) * s);
      ctx.setLineDash([]);
    }
  }

  // 預覽圖元（繪製中）
  if (opts.ghost) {
    renderEntity(ctx, opts.ghost, opts);
  }

  // 吸附點
  if (opts.snapPt) {
    const [sx, sy] = worldToScreen(v, opts.snapPt[0], opts.snapPt[1]);
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 十字準星（XY 軸虛線）：隨滑鼠移動，貫穿整個畫布方便定位
  if (opts.crosshair) {
    const [cx, cy] = opts.crosshair;
    ctx.strokeStyle = "rgba(37, 99, 235, 0.45)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, opts.cssH);
    ctx.moveTo(0, cy);
    ctx.lineTo(opts.cssW, cy);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawHandle(ctx: CanvasRenderingContext2D, sx: number, sy: number, color: string) {
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.rect(sx - 4, sy - 4, 8, 8);
  ctx.fill();
  ctx.stroke();
}
