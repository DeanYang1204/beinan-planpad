// ============ 幾何工具 + 空間索引 ============
import type { VecEntity } from "../types";
import { measureTextBlock } from "../types";

export type BBox = [number, number, number, number]; // [minX, minY, maxX, maxY]

interface BboxEntity {
  kind?: string;
  pts: number[];
  fontSize?: number;
  text?: string;
  fontFamily?: string;
  vertical?: boolean;
  w?: number;
  h?: number;
  userRot?: number;
  labelPrefix?: string;
}

/** 距離標註幾何：起訖點、垂直單位向量、長度、中點 */
export function dimensionGeom(e: { pts: number[] }): {
  x0: number; y0: number; x1: number; y1: number;
  nx: number; ny: number; len: number; mx: number; my: number;
} | null {
  if (e.pts.length < 4) return null;
  const x0 = e.pts[0], y0 = e.pts[1], x1 = e.pts[2], y1 = e.pts[3];
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const nx = -dy / len, ny = dx / len;
  return { x0, y0, x1, y1, nx, ny, len, mx: (x0 + x1) / 2, my: (y0 + y1) / 2 };
}

/** 距離標註標籤中心點（world）：沿法線外浮，labelSide 決定在線的哪一側（above = 反法線、below = 法線方向） */
export function dimensionLabelPos(e: {
  pts: number[];
  fontSize?: number;
  labelSide?: "above" | "below";
}): { x: number; y: number; nx: number; ny: number } | null {
  const g = dimensionGeom(e);
  if (!g) return null;
  const fs = e.fontSize ?? 12;
  const off = fs * 0.7;
  const dir = e.labelSide === "above" ? -1 : 1;
  return { x: g.mx + g.nx * off * dir, y: g.my + g.ny * off * dir, nx: g.nx, ny: g.ny };
}

/** 距離標註的雙向箭頭（world 座標）：兩端實心箭頭（tip 在端點、張開朝線內），並回傳內縮後的主線起訖點。 */
export function dimensionArrows(e: { pts: number[]; fontSize?: number }): {
  arrows: { tip: [number, number]; w1: [number, number]; w2: [number, number] }[];
  mainFrom: [number, number];
  mainTo: [number, number];
} | null {
  const g = dimensionGeom(e);
  if (!g) return null;
  const fs = e.fontSize ?? 12;
  const headLen = Math.max(8, fs * 0.7);
  const halfW = Math.max(4, fs * 0.35);
  const dx = (g.x1 - g.x0) / g.len, dy = (g.y1 - g.y0) / g.len;
  const px = -dy, py = dx; // 垂直方向
  const make = (tip: [number, number], toward: number) => {
    const bx = tip[0] + dx * headLen * toward;
    const by = tip[1] + dy * headLen * toward;
    return {
      tip,
      w1: [bx + px * halfW, by + py * halfW] as [number, number],
      w2: [bx - px * halfW, by - py * halfW] as [number, number],
    };
  };
  return {
    arrows: [make([g.x0, g.y0], 1), make([g.x1, g.y1], -1)],
    mainFrom: [g.x0 + dx * headLen, g.y0 + dy * headLen],
    mainTo: [g.x1 - dx * headLen, g.y1 - dy * headLen],
  };
}

/** 未旋轉的 entity 包圍盒（不含 userRot） */
export function entityBboxRaw(e: BboxEntity): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  if (e.kind === "dimension") {
    // 距離標註：兩端點 bbox + 標籤（垂直外浮，前綴會加寬文字）與箭頭外擴
    const fs = e.fontSize ?? 12;
    const pad = fs * 1.5 + (e.labelPrefix?.length ?? 0) * fs;
    return [
      Math.min(e.pts[0], e.pts[2]) - pad,
      Math.min(e.pts[1], e.pts[3]) - pad,
      Math.max(e.pts[0], e.pts[2]) + pad,
      Math.max(e.pts[1], e.pts[3]) + pad,
    ];
  }
  if (e.kind === "image") {
    const x = e.pts[0], y = e.pts[1];
    const w = e.w ?? 100, h = e.h ?? 100;
    return [x, y, x + w, y + h];
  }
  if (e.pts.length === 2 && e.fontSize) {
    // 文字：橫書基準點 = 第一行 baseline（文字向下延伸多行）、直書基準點 = 頂端
    const x = e.pts[0], y = e.pts[1];
    const fs = e.fontSize;
    const blk = measureTextBlock(e.text ?? "", fs, e.fontFamily, e.vertical);
    const w = blk.w;
    const h = blk.h;
    // 橫書：首行 baseline 在 y，向上延伸 fs（ascent）、向下延伸 (n-1)×行距 = blk.h - fs
    // 直書：字元由 y 向下堆疊 blk.h
    minX = x - 2;
    minY = e.vertical ? y - 2 : y - fs - 2;
    maxX = x + w + 2;
    maxY = e.vertical ? y + h + 2 : y + h - fs + 2;
    return [minX, minY, maxX, maxY];
  }
  if (e.kind === "arrow" && e.pts.length >= 4) {
    // 箭頭：包圍盒涵蓋實際路徑（彎曲/直角會超出起訖連線）＋頭部翼點
    const a = e as typeof e & { width?: number; headScale?: number; arrowStyle?: string };
    const rp = arrowRenderPoints(a);
    const heads = [arrowHeadGeom(a, "end")];
    if (a.arrowStyle === "both") heads.push(arrowHeadGeom(a, "start"));
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < rp.length; i += 2) {
      xs.push(rp[i]);
      ys.push(rp[i + 1]);
    }
    for (const h of heads) {
      if (!h) continue;
      for (const p of [h.tip, h.w1, h.w2]) {
        xs.push(p[0]);
        ys.push(p[1]);
      }
    }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  for (let i = 0; i < e.pts.length; i += 2) {
    const x = e.pts[i], y = e.pts[i + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}

/** 對包圍盒四角繞中心旋轉後，求軸對齊包圍盒 */
export function rotateBbox(b: BBox, rot: number): BBox {
  if (!rot) return b;
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const corners: [number, number][] = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
  for (const [x, y] of corners) {
    const dx = x - cx, dy = y - cy;
    const rx = cx + dx * cos - dy * sin;
    const ry = cy + dx * sin + dy * cos;
    if (rx < minX) minX = rx;
    if (ry < minY) minY = ry;
    if (rx > maxX) maxX = rx;
    if (ry > maxY) maxY = ry;
  }
  return [minX, minY, maxX, maxY];
}

/** entity 包圍盒（含 userRot 旋轉後包圍盒） */
export function entityBbox(e: BboxEntity): BBox {
  const raw = entityBboxRaw(e);
  return rotateBbox(raw, e.userRot ?? 0);
}

export function bboxExpand(b: BBox, pad: number): BBox {
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

export function bboxIntersect(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function pointInBbox(p: [number, number], b: BBox): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

/** 點到線段距離 */
export function pointSegDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 二次貝塞爾曲線採樣點 */
export function quadBezier(p0: [number, number], p1: [number, number], p2: [number, number], n = 24): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    out.push([
      mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
      mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1],
    ]);
  }
  return out;
}

/** 把橢圓/星型/梯形展開為閉合多邊形頂點（扁平座標），供 hit-test / 填色 / SVG 匯出使用 */
export function shapeVerts(e: VecEntity): number[] {
  const x0 = Math.min(e.pts[0], e.pts[2]);
  const x1 = Math.max(e.pts[0], e.pts[2]);
  const y0 = Math.min(e.pts[1], e.pts[3]);
  const y1 = Math.max(e.pts[1], e.pts[3]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  if (e.kind === "ellipse") {
    const rx = (x1 - x0) / 2;
    const ry = (y1 - y0) / 2;
    const out: number[] = [];
    const N = 64;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    }
    return out;
  }

  if (e.kind === "star") {
    const rx = (x1 - x0) / 2;
    const ry = (y1 - y0) / 2;
    const R = Math.min(rx, ry);
    const r = R * 0.5;
    const spikes = 5;
    const out: number[] = [];
    for (let i = 0; i < spikes * 2; i++) {
      const rad = i % 2 === 0 ? R : r;
      const a = -Math.PI / 2 + (i * Math.PI) / spikes;
      out.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
    }
    return out;
  }

  if (e.kind === "trapezoid") {
    const inset = (x1 - x0) * 0.25;
    return [x0 + inset, y0, x1 - inset, y0, x1, y1, x0, y1];
  }

  return e.pts;
}

/** 箭頭路徑取樣點（world，扁平座標，依樣式展開）：
 *  straight/both = 起訖兩點；elbow = Z 形四點（水平半程→垂直→水平半程）；curved = 二次貝茲取樣（中點沿法線外推 線長×bend） */
export function arrowSamplePoints(e: { pts: number[]; arrowStyle?: string; bend?: number }): number[] {
  const n = e.pts.length / 2;
  if (n < 2) return e.pts.slice();
  const x0 = e.pts[0], y0 = e.pts[1];
  const x1 = e.pts[(n - 1) * 2], y1 = e.pts[(n - 1) * 2 + 1];
  const style = e.arrowStyle ?? "straight";
  if (style === "elbow") {
    const mx = (x0 + x1) / 2;
    return [x0, y0, mx, y0, mx, y1, x1, y1];
  }
  if (style === "curved") {
    const L = Math.hypot(x1 - x0, y1 - y0);
    if (L < 1e-6) return [x0, y0, x1, y1];
    const px = -(y1 - y0) / L, py = (x1 - x0) / L;
    const off = L * (e.bend ?? 0.25);
    const cx = (x0 + x1) / 2 + px * off;
    const cy = (y0 + y1) / 2 + py * off;
    const samples = quadBezier([x0, y0], [cx, cy], [x1, y1], 16);
    const out: number[] = [];
    for (const [x, y] of samples) out.push(x, y);
    return out;
  }
  return [x0, y0, x1, y1];
}

/** 箭頭頭部幾何（world 座標）：tip 頂點、兩翼、箭身應停止的位置。end="start" 供雙向箭頭的起點頭。
 *  頭長 = max(8, 線寬×3)×headScale、半翼寬 = max(4, 線寬×1.6)×headScale；
 *  頭長上限以「路徑總長」夾限（不可用末取樣段長度，彎曲取樣段很短會把頭壓扁）。
 *  箭身縮短到 shaftEnd 可避免圓線帽凸出箭尖。 */
export function arrowHeadGeom(
  e: { pts: number[]; width?: number; headScale?: number; arrowStyle?: string; bend?: number },
  end: "end" | "start" = "end"
): {
  tip: [number, number];
  w1: [number, number];
  w2: [number, number];
  shaftEnd: [number, number];
} | null {
  const s = arrowSamplePoints(e);
  const n = s.length / 2;
  if (n < 2) return null;
  // 路徑總長（沿取樣點累加）
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    total += Math.hypot(s[(i + 1) * 2] - s[i * 2], s[(i + 1) * 2 + 1] - s[i * 2 + 1]);
  }
  const ti = end === "end" ? n - 1 : 0;
  const pi = end === "end" ? n - 2 : 1;
  const tx = s[ti * 2], ty = s[ti * 2 + 1];
  const qx = s[pi * 2], qy = s[pi * 2 + 1];
  const L = Math.hypot(tx - qx, ty - qy);
  if (L < 1e-6) return null;
  const dx = (tx - qx) / L, dy = (ty - qy) / L;
  const w = e.width || 1;
  const sc = e.headScale ?? 1;
  const len = Math.min(Math.max(8, w * 3) * sc, total * 0.45);
  const halfW = Math.max(4, w * 1.6) * sc;
  const bx = tx - dx * len, by = ty - dy * len; // 頭部底邊中點
  const px = -dy, py = dx; // 垂直方向
  return {
    tip: [tx, ty],
    w1: [bx + px * halfW, by + py * halfW],
    w2: [bx - px * halfW, by - py * halfW],
    shaftEnd: [tx - dx * len * 0.55, ty - dy * len * 0.55],
  };
}

/** 箭頭實際描線路徑（world，扁平座標）：依樣式取樣，並在頭部內縮短箭身（雙向時兩端都縮） */
export function arrowRenderPoints(e: { pts: number[]; width?: number; headScale?: number; arrowStyle?: string; bend?: number }): number[] {
  const s = arrowSamplePoints(e);
  const hEnd = arrowHeadGeom(e, "end");
  if (hEnd) {
    s[s.length - 2] = hEnd.shaftEnd[0];
    s[s.length - 1] = hEnd.shaftEnd[1];
  }
  if ((e.arrowStyle ?? "straight") === "both") {
    const hStart = arrowHeadGeom(e, "start");
    if (hStart) {
      s[0] = hStart.shaftEnd[0];
      s[1] = hStart.shaftEnd[1];
    }
  }
  return s;
}

/** 計算 entity 到點的最小距離（用於 hit-test） */
export function distToEntity(e: VecEntity, px: number, py: number, tolerance: number): number {
  const tol = tolerance + Math.max(e.width, 1);
  if (e.kind === "dimension") {
    const g = dimensionGeom(e);
    if (!g) return Infinity;
    // 標籤命中（外浮於中點法線方向，半徑約字號；labelSide 決定上下方）
    const fs = e.fontSize ?? 12;
    const lp = dimensionLabelPos(e);
    if (lp && Math.hypot(px - lp.x, py - lp.y) <= fs + 2) return 0;
    return pointSegDist(px, py, g.x0, g.y0, g.x1, g.y1) <= tol ? 0 : Infinity;
  }
  if (e.kind === "text" || e.kind === "image") {
    const b = entityBbox(e);
    if (!pointInBbox([px, py], bboxExpand(b, 2))) return Infinity;
    return 0;
  }
  if (e.kind === "arc") {
    const p0: [number, number] = [e.pts[0], e.pts[1]];
    const p1: [number, number] = [e.pts[2], e.pts[3]];
    const p2: [number, number] = [e.pts[4], e.pts[5]];
    const samples = quadBezier(p0, p1, p2, 24);
    let min = Infinity;
    for (let i = 0; i < samples.length - 1; i++) {
      min = Math.min(min, pointSegDist(px, py, samples[i][0], samples[i][1], samples[i + 1][0], samples[i + 1][1]));
    }
    return min <= tol ? min : Infinity;
  }
  if (e.kind === "arrow") {
    // 箭頭：沿實際路徑（彎曲/直角樣式）做線段距離
    const rp = arrowRenderPoints(e);
    let min = Infinity;
    for (let i = 0; i < rp.length / 2 - 1; i++) {
      min = Math.min(min, pointSegDist(px, py, rp[i * 2], rp[i * 2 + 1], rp[i * 2 + 2], rp[i * 2 + 3]));
    }
    return min <= tol ? min : Infinity;
  }
  if (e.kind === "ellipse") {
    // 徑向投影近似距離（扁橢圓仍夠準確，供點擊命中）
    const cx = (e.pts[0] + e.pts[2]) / 2;
    const cy = (e.pts[1] + e.pts[3]) / 2;
    const rx = Math.abs(e.pts[2] - e.pts[0]) / 2;
    const ry = Math.abs(e.pts[3] - e.pts[1]) / 2;
    if (rx <= 0 || ry <= 0) return Infinity;
    const nx = (px - cx) / rx;
    const ny = (py - cy) / ry;
    const r = Math.hypot(nx, ny);
    if (r === 0) return Infinity;
    const ex = cx + (nx / r) * rx;
    const ey = cy + (ny / r) * ry;
    const d = Math.hypot(px - ex, py - ey);
    return d <= tol ? d : Infinity;
  }

  const isShaped = e.kind === "star" || e.kind === "trapezoid";
  const verts = isShaped ? shapeVerts(e) : e.pts;
  const closed = isShaped ? true : !!e.closed;
  let min = Infinity;
  const n = verts.length / 2;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const d = pointSegDist(px, py, verts[i * 2], verts[i * 2 + 1], verts[j * 2], verts[j * 2 + 1]);
    if (d < min) min = d;
  }
  return min <= tol ? min : Infinity;
}

/** 判斷點是否落在可填色形狀內部（供 fill 工具使用） */
export function pointInShape(e: VecEntity, px: number, py: number): boolean {
  if (e.kind === "ellipse") {
    const cx = (e.pts[0] + e.pts[2]) / 2;
    const cy = (e.pts[1] + e.pts[3]) / 2;
    const rx = Math.abs(e.pts[2] - e.pts[0]) / 2;
    const ry = Math.abs(e.pts[3] - e.pts[1]) / 2;
    if (rx <= 0 || ry <= 0) return false;
    const nx = (px - cx) / rx;
    const ny = (py - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  if (e.kind === "star" || e.kind === "trapezoid" || e.kind === "rect" || e.kind === "polyline") {
    return pointInPolygon(px, py, shapeVerts(e));
  }
  return false;
}

/** 求多邊形（閉環）是否包含點，用於 fill 命中 */
export function pointInPolygon(px: number, py: number, pts: number[]): boolean {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1];
    const xj = pts[j * 2], yj = pts[j * 2 + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 試著把一條 2 點直線與既有直線/折線在端點處合併，回傳合併後的扁平 pts（未命中回 null） */
export function mergeLinePts(newLine: { pts: number[] }, other: { pts: number[] }): number[] | null {
  const A: [number, number] = [newLine.pts[0], newLine.pts[1]];
  const B: [number, number] = [newLine.pts[2], newLine.pts[3]];
  const o = other.pts;
  const n = o.length / 2;
  const P0: [number, number] = [o[0], o[1]];
  const Pn: [number, number] = [o[(n - 1) * 2], o[(n - 1) * 2 + 1]];
  const tol = 0.5;
  const near = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
  if (near(A, P0)) return [B[0], B[1], ...o];
  if (near(A, Pn)) return [...o, B[0], B[1]];
  if (near(B, P0)) return [A[0], A[1], ...o];
  if (near(B, Pn)) return [...o, A[0], A[1]];
  return null;
}

/** 弧度把手位置：直線中點沿法線外推 offsetPx（螢幕像素）距離，供「調整弧度」拖動 */
export function bendHandlePos(e: VecEntity, scale: number): [number, number] | null {
  if (e.kind !== "line" || e.pts.length !== 4) return null;
  const x0 = e.pts[0], y0 = e.pts[1];
  const x1 = e.pts[2], y1 = e.pts[3];
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const off = 26 / scale; // 螢幕 26px 轉世界距離
  const nx = -dy / len, ny = dx / len;
  return [(x0 + x1) / 2 + nx * off, (y0 + y1) / 2 + ny * off];
}

/** 直線轉弧線的預設控制點：中點沿法線外推線長 25%（undoable 轉換用） */
export function defaultArcCtrl(p0: [number, number], p1: [number, number]): [number, number] {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const off = len * 0.25;
  return [(p0[0] + p1[0]) / 2 + nx * off, (p0[1] + p1[1]) / 2 + ny * off];
}

/** 彎曲箭頭的弧度把手位置：貝茲曲線頂點（t=0.5 = 弦中點 + 法線×bend×線長/2）再沿法線外浮 offset（螢幕像素）。
 *  拖動此把手可調整 bend（弧度倍率）。 */
export function arrowBendHandlePos(e: VecEntity, scale: number): [number, number] | null {
  if (e.kind !== "arrow" || (e.arrowStyle ?? "straight") !== "curved") return null;
  if (e.pts.length !== 4) return null;
  const x0 = e.pts[0], y0 = e.pts[1];
  const x1 = e.pts[2], y1 = e.pts[3];
  const L = Math.hypot(x1 - x0, y1 - y0);
  if (L < 1e-6) return null;
  const bend = e.bend ?? 0.25;
  const nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
  const apexOff = (L * bend) / 2;
  const sgn = bend >= 0 ? 1 : -1;
  const off = 14 / scale; // 螢幕 14px 外浮，避免把手貼在曲線上
  return [(x0 + x1) / 2 + nx * (apexOff + sgn * off), (y0 + y1) / 2 + ny * (apexOff + sgn * off)];
}

/** 旋轉把手位置：文字/圖片未旋轉 bbox 中心正上方外推 offset（螢幕像素），隨 userRot 旋轉 */
export function rotateHandlePos(e: VecEntity, scale: number): [number, number] | null {
  if (e.kind !== "text" && e.kind !== "image") return null;
  const b = entityBboxRaw(e);
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const h = b[3] - b[1];
  const rot = e.userRot ?? 0;
  const off = 24 / scale; // 螢幕 24px 轉世界距離
  const d = h / 2 + off;
  const sin = Math.sin(rot), cos = Math.cos(rot);
  return [cx + d * sin, cy - d * cos];
}

// ============ 空間索引（均勻網格） ============
export class SpatialIndex {
  private cellSize: number;
  private map = new Map<string, VecEntity[]>();

  constructor(cellSize = 40) {
    this.cellSize = cellSize;
  }

  private key(cx: number, cy: number): string {
    return cx + "," + cy;
  }

  clear() {
    this.map.clear();
  }

  insert(e: VecEntity) {
    if (!e.bbox) e.bbox = entityBbox(e);
    const b = e.bbox;
    const cs = this.cellSize;
    const x0 = Math.floor(b[0] / cs), x1 = Math.floor(b[2] / cs);
    const y0 = Math.floor(b[1] / cs), y1 = Math.floor(b[3] / cs);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        let arr = this.map.get(k);
        if (!arr) {
          arr = [];
          this.map.set(k, arr);
        }
        arr.push(e);
      }
    }
  }

  build(entities: VecEntity[]) {
    this.clear();
    for (const e of entities) this.insert(e);
  }

  /** 查詢與點相交的 entity（已按距離排序） */
  queryPoint(px: number, py: number, tolerance: number): VecEntity[] {
    const cs = this.cellSize;
    const cx = Math.floor(px / cs), cy = Math.floor(py / cs);
    const seen = new Set<VecEntity>();
    const result: { e: VecEntity; d: number }[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = this.map.get(this.key(cx + dx, cy + dy));
        if (!arr) continue;
        for (const e of arr) {
          if (seen.has(e)) continue;
          seen.add(e);
          const d = distToEntity(e, px, py, tolerance);
          if (d !== Infinity) result.push({ e, d });
        }
      }
    }
    result.sort((a, b) => a.d - b.d);
    return result.map((r) => r.e);
  }

  /** 查詢與 bbox 相交的 entity（用於框選、視口裁剪） */
  queryBBox(b: BBox): VecEntity[] {
    const cs = this.cellSize;
    const x0 = Math.floor(b[0] / cs), x1 = Math.floor(b[2] / cs);
    const y0 = Math.floor(b[1] / cs), y1 = Math.floor(b[3] / cs);
    const seen = new Set<VecEntity>();
    const result: VecEntity[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const arr = this.map.get(this.key(cx, cy));
        if (!arr) continue;
        for (const e of arr) {
          if (seen.has(e)) continue;
          seen.add(e);
          if (!e.bbox) e.bbox = entityBbox(e);
          if (bboxIntersect(e.bbox, b)) result.push(e);
        }
      }
    }
    return result;
  }
}

/** 吸附：找最近的端點/中點 */
export function snapPoint(entities: VecEntity[], px: number, py: number, tol: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = tol;
  for (const e of entities) {
    if (e.kind === "text") continue;
    const n = e.pts.length / 2;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(e.pts[i * 2] - px, e.pts[i * 2 + 1] - py);
      if (d < bestD) {
        bestD = d;
        best = [e.pts[i * 2], e.pts[i * 2 + 1]];
      }
    }
    // 中點
    for (let i = 0; i < (e.closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      const mx = (e.pts[i * 2] + e.pts[j * 2]) / 2;
      const my = (e.pts[i * 2 + 1] + e.pts[j * 2 + 1]) / 2;
      const d = Math.hypot(mx - px, my - py);
      if (d < bestD) {
        bestD = d;
        best = [mx, my];
      }
    }
  }
  return best;
}
