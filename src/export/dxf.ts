// ============ DXF 匯出（純 TS，不引入依賴） ============
// 座標依 metersPerPt 換算成公釐(mm)、Y 軸翻轉（PlanPad 世界座標 Y 向下 → CAD Y 向上），
// 內容包圍盒平移至原點。圖層→LAYER、顏色→true color(420)、文字高度依比例縮放。
import type { DocStore } from "../engine/document";
import { orderedDrawList } from "../engine/document";
import { shapeVerts, arrowRenderPoints, arrowHeadGeom, dimensionGeom, dimensionLabelPos, dimensionEnds, entityBbox } from "../engine/geometry";
import { dimensionLabelText, hexToRgb, toVerticalForms } from "../types";
import type { PlanDoc, VecEntity } from "../types";

function g(code: number, value: string | number): string {
  return `${code}\n${value}\n`;
}

/** 內容包圍盒（所有可見實體聯集，無邊距） */
function contentMinMax(doc: PlanDoc): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of orderedDrawList(doc)) {
    const layer = doc.layers.find((l) => l.id === e.layerId);
    if (layer && !layer.visible) continue;
    const b = e.bbox || entityBbox(e);
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2];
    if (b[3] > maxY) maxY = b[3];
  }
  if (minX === Infinity) return [0, 0, doc.pageW, doc.pageH];
  return [minX, minY, maxX, maxY];
}

/** true color 24 位整數（DXF 組碼 420） */
function trueColor(hex: string): number {
  const [r, gg, b] = hexToRgb(hex);
  return (r << 16) | (gg << 8) | b;
}

interface Ctx {
  X: (x: number) => number;
  Y: (y: number) => number;
  k: number;
  layer: string;
  handle: () => string;
}

function layerName(e: VecEntity, doc: PlanDoc): string {
  const l = doc.layers.find((x) => x.id === e.layerId);
  const name = l?.name ?? "未命名";
  // DXF layer 名不可含特殊字元，簡化為安全字元
  return name.replace(/[<>/\\":;?*|,=`]/g, "_").slice(0, 60) || "Layer";
}

/** 弧線（3 點二次貝茲）採樣為開放折線頂點 */
function arcSamples(e: VecEntity): number[] {
  const p0 = [e.pts[0], e.pts[1]];
  const p1 = [e.pts[2], e.pts[3]];
  const p2 = [e.pts[4], e.pts[5]];
  const N = 24;
  const out: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, mt = 1 - t;
    out.push(
      mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
      mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]
    );
  }
  return out;
}

function polyline(e: VecEntity, pts: number[], closed: boolean, ctx: Ctx): string {
  let s = g(0, "LWPOLYLINE") + g(5, ctx.handle()) + g(100, "AcDbEntity") + g(8, ctx.layer) + g(100, "AcDbPolyline") + g(90, pts.length / 2) + g(70, closed ? 1 : 0);
  for (let i = 0; i < pts.length; i += 2) s += g(10, ctx.X(pts[i])) + g(20, ctx.Y(pts[i + 1]));
  return s;
}

function line(a: [number, number], b: [number, number], ctx: Ctx): string {
  return g(0, "LINE") + g(5, ctx.handle()) + g(100, "AcDbEntity") + g(8, ctx.layer) + g(100, "AcDbLine") +
    g(10, ctx.X(a[0])) + g(20, ctx.Y(a[1])) + g(11, ctx.X(b[0])) + g(21, ctx.Y(b[1]));
}

function circle(cx: number, cy: number, r: number, ctx: Ctx): string {
  return g(0, "CIRCLE") + g(5, ctx.handle()) + g(100, "AcDbEntity") + g(8, ctx.layer) + g(100, "AcDbCircle") +
    g(10, ctx.X(cx)) + g(20, ctx.Y(cy)) + g(40, r * ctx.k);
}

function solid(pts: [number, number][], ctx: Ctx): string {
  // SOLID 需 4 點（三角形時重複第 3 點）
  const p = [...pts];
  while (p.length < 4) p.push(p[p.length - 1]);
  let s = g(0, "SOLID") + g(5, ctx.handle()) + g(100, "AcDbEntity") + g(8, ctx.layer) + g(100, "AcDbTrace");
  s += g(10, ctx.X(p[0][0])) + g(20, ctx.Y(p[0][1]));
  s += g(11, ctx.X(p[1][0])) + g(21, ctx.Y(p[1][1]));
  s += g(12, ctx.X(p[2][0])) + g(22, ctx.Y(p[2][1]));
  s += g(13, ctx.X(p[3][0])) + g(23, ctx.Y(p[3][1]));
  return s;
}

/** 實心矩形（SOLID 四點順序：左下→右下→右上→左上，確保不自我交叉） */
function rectSolid(x0: number, y0: number, x1: number, y1: number, ctx: Ctx): string {
  return solid([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], ctx);
}

function textEntity(e: VecEntity, x: number, y: number, str: string, ctx: Ctx): string {
  const fs = (e.fontSize ?? 12) * ctx.k;
  const rot = e.userRot ? (e.userRot * 180) / Math.PI : 0;
  return g(0, "TEXT") + g(5, ctx.handle()) + g(100, "AcDbEntity") + g(8, ctx.layer) + g(100, "AcDbText") +
    g(10, ctx.X(x)) + g(20, ctx.Y(y)) + g(40, fs) + g(1, str) + g(50, rot) + g(7, "Standard") + g(41, 1);
}

function entityToDXF(e: VecEntity, doc: PlanDoc, ctx: Ctx): string {
  ctx.layer = layerName(e, doc);
  const color = g(420, trueColor(e.stroke));

  if (e.kind === "dimension") {
    const gm = dimensionGeom(e);
    if (!gm) return "";
    let s = line([gm.x0, gm.y0], [gm.x1, gm.y1], ctx);
    // 端點裝飾：實心箭頭→SOLID、圓點→CIRCLE、方塊→實心(簡化為圓點)
    const ends = dimensionEnds(e);
    if (ends) {
      for (const en of ends.ends) {
        if (en.kind === "arrow" && en.tip) s += solid([en.tip, en.w1!, en.w2!], ctx);
        else if (en.kind === "dot" && en.c) s += circle(en.c[0], en.c[1], en.r!, ctx);
        else if (en.kind === "box" && en.c) s += circle(en.c[0], en.c[1], en.hs!, ctx);
        else if (en.kind === "tick" && en.a && en.b) s += line(en.a, en.b, ctx);
      }
    }
    // 標籤文字（含前綴）
    const lp = dimensionLabelPos(e);
    const label = dimensionLabelText(gm.len, doc.metersPerPt, e.labelPrefix, e.labelOverride);
    if (lp) s += textEntity(e, lp.x, lp.y, label, ctx);
    return s;
  }

  if (e.kind === "text") {
    const fs = e.fontSize ?? 12;
    const vertical = !!e.vertical;
    let s = "";
    if (vertical) {
      const chars = [...toVerticalForms(e.text ?? "")];
      chars.forEach((ch, i) => {
        s += textEntity(e, e.pts[0], e.pts[1] + i * fs, ch, ctx);
      });
      return s;
    }
    const lines = (e.text ?? "").split("\n");
    const lineH = fs * 1.2;
    lines.forEach((ln, i) => {
      // 首行 baseline = pts[1]，往下遞增行距；CAD TEXT 錨點為左下，與 Canvas baseline 對齊
      s += textEntity(e, e.pts[0], e.pts[1] + i * lineH, ln, ctx);
    });
    return s;
  }

  if (e.kind === "image") {
    // DXF 無內嵌點陣圖（需 IMAGE + 外部路徑），略過
    return "";
  }

  if (e.kind === "arc") {
    return polyline(e, arcSamples(e), false, ctx) + color;
  }

  if (e.kind === "ellipse") {
    const cx = (e.pts[0] + e.pts[2]) / 2;
    const cy = (e.pts[1] + e.pts[3]) / 2;
    const rx = Math.abs(e.pts[2] - e.pts[0]) / 2;
    const ry = Math.abs(e.pts[3] - e.pts[1]) / 2;
    if (Math.abs(rx - ry) < 0.5) return circle(cx, cy, rx, ctx) + color;
    // 橢圓：採樣為封閉折線（簡單可靠）
    const N = 64;
    const pts: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    }
    return polyline(e, pts, true, ctx) + color;
  }

  if (e.kind === "star" || e.kind === "trapezoid") {
    return polyline(e, shapeVerts(e), true, ctx) + color;
  }

  if (e.kind === "arrow") {
    const rp = arrowRenderPoints(e);
    let s = polyline(e, rp, false, ctx);
    const hEnd = arrowHeadGeom(e, "end");
    if (hEnd) s += solid([hEnd.tip, hEnd.w1, hEnd.w2], ctx);
    if ((e.arrowStyle ?? "straight") === "both") {
      const hStart = arrowHeadGeom(e, "start");
      if (hStart) s += solid([hStart.tip, hStart.w1, hStart.w2], ctx);
    }
    return s + color;
  }

  // line / polyline / rect（含圓角→仍用折線，圓角以採樣逼近）
  if (e.kind === "rect" && e.radius) {
    // 圓角矩形：依 radius 在四角採樣弧
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < e.pts.length; i += 2) {
      x0 = Math.min(x0, e.pts[i]); y0 = Math.min(y0, e.pts[i + 1]);
      x1 = Math.max(x1, e.pts[i]); y1 = Math.max(y1, e.pts[i + 1]);
    }
    const r = Math.min(e.radius, (x1 - x0) / 2, (y1 - y0) / 2);
    const pts: number[] = [];
    const corner = (cx: number, cy: number, a0: number, a1: number) => {
      const N = 6;
      for (let i = 0; i <= N; i++) {
        const a = a0 + ((a1 - a0) * i) / N;
        pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
    };
    corner(x1 - r, y0 + r, -Math.PI / 2, 0); // 右上
    corner(x1 - r, y1 - r, 0, Math.PI / 2); // 右下
    corner(x0 + r, y1 - r, Math.PI / 2, Math.PI); // 左下
    corner(x0 + r, y0 + r, Math.PI, (3 * Math.PI) / 2); // 左上
    return polyline(e, pts, true, ctx) + color;
  }

  // 斑馬線 / 人行道：外框折線 + 圖樣（斑馬線=實心條紋、人行道=磚縫線）
  if (e.fill === "crosswalk" || e.fill === "sidewalk") {
    const bb = e.bbox || entityBbox(e);
    const x0 = bb[0], y0 = bb[1], w = bb[2] - bb[0], h = bb[3] - bb[1];
    let s = polyline(e, e.pts, !!e.closed, ctx);
    if (e.fill === "crosswalk") {
      const horizontal = w >= h;
      const longSide = horizontal ? w : h;
      const shortSide = horizontal ? h : w;
      const n = Math.max(1, Math.round(longSide / (shortSide * 0.3)));
      const pitch = longSide / n;
      const barW = pitch * 0.5;
      if (horizontal) {
        for (let i = 0; i < n; i++) {
          const bx = x0 + i * pitch + (pitch - barW) / 2;
          s += rectSolid(bx, y0, bx + barW, y0 + h, ctx);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const by = y0 + i * pitch + (pitch - barW) / 2;
          s += rectSolid(x0, by, x0 + w, by + barW, ctx);
        }
      }
    } else {
      const shortSide = Math.min(w, h);
      const brickH = Math.max(2, shortSide * 0.16);
      const brickW = brickH * 2.2;
      for (let y = y0; y <= y0 + h + brickH; y += brickH) {
        const sy = Math.min(y, y0 + h);
        s += line([x0, sy], [x0 + w, sy], ctx);
      }
      let row = 0;
      for (let y = y0; y < y0 + h; y += brickH, row++) {
        const offset = (row % 2) * (brickW / 2);
        const yTop = y;
        const yBot = Math.min(y + brickH, y0 + h);
        for (let x = x0 - offset; x <= x0 + w + brickW; x += brickW) {
          s += line([x, yTop], [x, yBot], ctx);
        }
      }
    }
    return s + color;
  }

  return polyline(e, e.pts, !!e.closed, ctx) + color;
}

export function exportDXF(store: DocStore): string {
  const doc = store.doc;
  if (!doc) return "";
  const [minX, minY, maxX, maxY] = contentMinMax(doc);
  const k = doc.metersPerPt && doc.metersPerPt > 0 ? doc.metersPerPt * 1000 : 1;
  let hid = 1;
  const ctx: Ctx = {
    X: (x) => (x - minX) * k,
    Y: (y) => (maxY - y) * k,
    k,
    layer: "Layer",
    handle: () => (hid++).toString(16).toUpperCase(),
  };

  const out: string[] = [];
  // HEADER
  out.push(g(0, "SECTION"), g(2, "HEADER"), g(9, "$ACADVER"), g(1, "AC1024"), g(9, "$INSUNITS"), g(70, 4), g(0, "ENDSEC"));
  // TABLES → LAYER
  out.push(g(0, "SECTION"), g(2, "TABLES"), g(0, "TABLE"), g(2, "LAYER"), g(70, doc.layers.length));
  for (const l of doc.layers) {
    const name = (l.name || "Layer").replace(/[<>/\\":;?*|,=`]/g, "_").slice(0, 60) || "Layer";
    out.push(g(0, "LAYER"), g(2, name), g(70, 0), g(62, 7), g(6, "CONTINUOUS"));
  }
  out.push(g(0, "ENDTAB"), g(0, "ENDSEC"));
  // ENTITIES
  out.push(g(0, "SECTION"), g(2, "ENTITIES"));
  for (const e of orderedDrawList(doc)) {
    const layer = doc.layers.find((l) => l.id === e.layerId);
    if (layer && !layer.visible) continue;
    const s = entityToDXF(e, doc, ctx);
    if (s) out.push(s);
  }
  out.push(g(0, "ENDSEC"), g(0, "EOF"));
  return out.join("");
}
