import type { DocStore } from "../engine/document";
import { orderedDrawList } from "../engine/document";
import { renderEntity } from "../engine/renderer";
import { shapeVerts, arrowHeadGeom, arrowRenderPoints, entityBbox, dimensionGeom, dimensionLabelPos, dimensionArrows } from "../engine/geometry";
import type { BBox } from "../engine/geometry";
import type { PlanDoc, VecEntity, Viewport } from "../types";
import { fontStack, measureTextBlock, measureTextWidth, toVerticalForms, TEXT_LINE_HEIGHT, dimensionLabelText } from "../types";
import { PDFDocument } from "pdf-lib";

/** 內容包圍盒：所有「可見實體」的聯集外框（含描邊外擴＋邊距）。無內容時退回整頁 */
export function contentBbox(doc: PlanDoc): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let maxHalfW = 0;
  for (const e of orderedDrawList(doc)) {
    const b = e.bbox || entityBbox(e);
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2];
    if (b[3] > maxY) maxY = b[3];
    // 線/箭頭等描邊會外擴線寬的一半，需納入邊距
    if (e.kind !== "text" && e.kind !== "image") maxHalfW = Math.max(maxHalfW, (e.width ?? 1) / 2);
  }
  if (minX === Infinity) return [0, 0, doc.pageW, doc.pageH];
  const pad = maxHalfW + 6;
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

/** 依目標 DPI 選渲染倍率：1pt = 1/72in，目標 300 DPI ≈ 4.17×，以長邊像素上限夾住避免 canvas 過大 */
function pickScale(w: number, h: number): number {
  const TARGET_DPI = 300;
  const MAX_DIM = 12000;
  const targetScale = TARGET_DPI / 72;
  const longSide = Math.max(w, h);
  const maxScale = longSide > 0 ? MAX_DIM / longSide : 1;
  return Math.max(1, Math.min(targetScale, maxScale));
}

// ---------- SVG ----------
export function exportSVG(store: DocStore): string {
  const doc = store.doc;
  if (!doc) return "";
  const parts: string[] = [];
  const bb = contentBbox(doc);
  const bx = bb[0], by = bb[1], bw = bb[2] - bb[0], bh = bb[3] - bb[1];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(bw)}" height="${fmt(bh)}" viewBox="${fmt(bx)} ${fmt(by)} ${fmt(bw)} ${fmt(bh)}">`
  );
  parts.push(`<rect x="${fmt(bx)}" y="${fmt(by)}" width="${fmt(bw)}" height="${fmt(bh)}" fill="#ffffff"/>`);

  const hasHatch = doc.entities.some((e) => e.fill === "hatch");
  const hasGrid = doc.entities.some((e) => e.fill === "grid");
  const hasXGrid = doc.entities.some((e) => e.fill === "xgrid");
  if (hasHatch || hasGrid || hasXGrid) {
    const defs: string[] = [];
    if (hasHatch) {
      defs.push(`<pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#666666" stroke-width="1"/></pattern>`);
    }
    if (hasGrid) {
      defs.push(`<pattern id="grid" patternUnits="userSpaceOnUse" width="8" height="8"><path d="M8 0H0V8" fill="none" stroke="#666666" stroke-width="1"/></pattern>`);
    }
    if (hasXGrid) {
      defs.push(`<pattern id="xgrid" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><path d="M8 0H0V8" fill="none" stroke="#666666" stroke-width="1"/></pattern>`);
    }
    parts.push(`<defs>${defs.join("")}</defs>`);
  }

  // 依圖層堆疊順序匯出（與畫布一致：由最下層畫到最上層）；套用圖層不透明度
  const layerOp = new Map<string, number>();
  for (const l of doc.layers) layerOp.set(l.id, l.opacity ?? 1);
  for (const e of orderedDrawList(doc)) {
    const op = layerOp.get(e.layerId) ?? 1;
    const svg = entityToSVG(e, doc.metersPerPt);
    if (op < 1) {
      // 文字/圖片若已自帶 <g transform>，將 opacity 加到外層 <g>（SVG 允許 transform+opacity 並存）
      parts.push(`<g opacity="${fmt(op)}">${svg}</g>`);
    } else {
      parts.push(svg);
    }
  }
  parts.push(`</svg>`);
  return parts.join("\n");
}

function fmt(n: number): string {
  return Math.round(n * 100) / 100 + "";
}

function fillAttr(e: VecEntity): string {
  if (e.fill === "hatch") return ` fill="url(#hatch)"`;
  if (e.fill === "grid") return ` fill="url(#grid)"`;
  if (e.fill === "xgrid") return ` fill="url(#xgrid)"`;
  if (e.fill) return ` fill="${e.fill}"`;
  return ` fill="none"`;
}

/** 描邊屬性：無外邊框時省略 stroke（填充圖案仍由 fill 呈現） */
function strokeAttr(e: VecEntity): string {
  if (e.noStroke) return "";
  return ` stroke="${e.stroke}" stroke-width="${fmt(e.width)}"`;
}

function entityToSVG(e: VecEntity, metersPerPt?: number): string {
  if (e.kind === "dimension") {
    const g = dimensionGeom(e);
    if (!g) return "";
    const fs = e.fontSize ?? 12;
    const lp = dimensionLabelPos(e);
    const lx = lp?.x ?? g.mx;
    const ly = lp?.y ?? g.my;
    const label = dimensionLabelText(g.len, metersPerPt, e.labelPrefix);
    const labelFill = e.labelColor ?? e.stroke;
    const tw = measureTextWidth(label, fs, e.fontFamily);
    const padX = fs * 0.15;
    const padY = fs * 0.15;
    const bx = fmt(lx - tw / 2 - padX);
    const by = fmt(ly - fs / 2 - padY);
    const bw = fmt(tw + padX * 2);
    const bh = fmt(fs + padY * 2);
    // 底色可調（與文字一致：bgColor 空 = 無底色、bgOpacity 控制不透明度）
    const bgOp = e.bgOpacity ?? 1;
    const bgOpAttr = bgOp < 1 ? ` fill-opacity="${fmt(bgOp)}"` : "";
    const bgRect = e.bgColor
      ? `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${e.bgColor}"${bgOpAttr}/>`
      : "";
    // 文字塊邊框（與文字一致：borderColor + borderWidth）
    const borderRect =
      e.borderColor && e.borderWidth
        ? `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="${e.borderColor}" stroke-width="${fmt(e.borderWidth)}"/>`
        : "";
    // 雙向箭頭：主線（兩端內縮）＋兩端實心箭頭（朝線內）
    const ar = dimensionArrows(e);
    let line = "";
    let arrowPolys = "";
    if (ar) {
      line = `<path d="M${fmt(ar.mainFrom[0])} ${fmt(ar.mainFrom[1])} L${fmt(ar.mainTo[0])} ${fmt(ar.mainTo[1])}" stroke="${e.stroke}" stroke-width="${fmt(e.width)}" stroke-linecap="round"/>`;
      arrowPolys = ar.arrows
        .map((a) => `<polygon points="${fmt(a.tip[0])},${fmt(a.tip[1])} ${fmt(a.w1[0])},${fmt(a.w1[1])} ${fmt(a.w2[0])},${fmt(a.w2[1])}" fill="${e.stroke}"/>`)
        .join("");
    }
    const labelG = `<g>${bgRect}${borderRect}<text x="${fmt(lx)}" y="${fmt(ly)}" text-anchor="middle" dominant-baseline="central" font-size="${fmt(fs)}" fill="${labelFill}" font-family="${fontStack(e.fontFamily).replace(/"/g, "'")}">${escapeXml(label)}</text></g>`;
    return line + arrowPolys + labelG;
  }

  if (e.kind === "text") {
    const fs = e.fontSize ?? 12;
    const rot = e.rot ? (e.rot * 180) / Math.PI : 0;
    const vertical = !!e.vertical;
    // 直書時標點換為直式字形（︵︶等），與 Canvas 渲染一致
    const chars = [...(vertical ? toVerticalForms(e.text ?? "") : (e.text ?? ""))];
    const ff = fontStack(e.fontFamily).replace(/"/g, "'");
    const blk = measureTextBlock(e.text ?? "", fs, e.fontFamily, vertical);
    const padX = fs * 0.15;
    const padY = fs * 0.25;
    // 底色不透明度（0–1，預設完全不透明）
    const bgOp = e.bgOpacity ?? 1;
    const bgOpAttr = bgOp < 1 ? ` fill-opacity="${fmt(bgOp)}"` : "";
    // userRot 繞中心（與 renderer 一致）：橫書文字塊頂端在 baseline 上方 fs、多行總高 blk.h，直書在字塊中心
    const userRotDeg = e.userRot ? (e.userRot * 180) / Math.PI : 0;
    const cx = e.pts[0] + blk.w / 2;
    const cy = vertical ? e.pts[1] + blk.h / 2 : e.pts[1] - fs + blk.h / 2;
    let g = userRotDeg ? `<g transform="rotate(${fmt(userRotDeg)} ${fmt(cx)} ${fmt(cy)})">` : "<g>";
    if (vertical) {
      // 直書：基準點為字塊左上角（x=pts[0], y=pts[1]）
      const tw = blk.w;
      const bh = blk.h;
      if (e.bgColor) {
        g += `<rect x="${fmt(e.pts[0] - padX)}" y="${fmt(e.pts[1] - padY)}" width="${fmt(tw + padX * 2)}" height="${fmt(bh + padY * 2)}" fill="${e.bgColor}"${bgOpAttr}/>`;
      }
      if (e.borderColor && e.borderWidth) {
        g += `<rect x="${fmt(e.pts[0] - padX)}" y="${fmt(e.pts[1] - padY)}" width="${fmt(tw + padX * 2)}" height="${fmt(bh + padY * 2)}" fill="none" stroke="${e.borderColor}" stroke-width="${fmt(e.borderWidth)}"/>`;
      }
      // 字元由上而下堆疊（以 tspan 逐字定位），水平置中
      const cx = fmt(e.pts[0] + tw / 2);
      let tspans = "";
      for (let i = 0; i < chars.length; i++) {
        const cy = fmt(e.pts[1] + i * fs + fs * 0.8);
        tspans += `<tspan x="${cx}" y="${cy}">${escapeXml(chars[i])}</tspan>`;
      }
      g += `<text text-anchor="middle" font-size="${fmt(fs)}" fill="${e.stroke}" font-family="${ff}"${
        rot ? ` transform="rotate(${fmt(rot)} ${fmt(e.pts[0])} ${fmt(e.pts[1])})"` : ""
      }>${tspans}</text></g>`;
      return g;
    }
    const x = fmt(e.pts[0]);
    // 橫書基準點 = 第一行 baseline（與 Canvas 渲染一致：文字由錨點向下延伸多行）
    const firstY = e.pts[1];
    const tw = blk.w;
    const lines = (e.text ?? "").split("\n");
    // 背景塊：頂 = baseline - fs - padY，高 = blk.h（多行）＋padding
    const bgY = e.pts[1] - fs - padY;
    const bgH = blk.h + padY * 2;
    if (e.bgColor) {
      g += `<rect x="${fmt(e.pts[0] - padX)}" y="${fmt(bgY)}" width="${fmt(tw + padX * 2)}" height="${fmt(bgH)}" fill="${e.bgColor}"${bgOpAttr}/>`;
    }
    if (e.borderColor && e.borderWidth) {
      g += `<rect x="${fmt(e.pts[0] - padX)}" y="${fmt(bgY)}" width="${fmt(tw + padX * 2)}" height="${fmt(bgH)}" fill="none" stroke="${e.borderColor}" stroke-width="${fmt(e.borderWidth)}"/>`;
    }
    // 橫書多行：逐行 tspan（行距 = 字號×行高）
    const lineH = fs * TEXT_LINE_HEIGHT;
    const tspans = lines
      .map((ln, i) => `<tspan x="${x}" y="${fmt(firstY + i * lineH)}">${escapeXml(ln)}</tspan>`)
      .join("");
    g += `<text font-size="${fmt(fs)}" fill="${e.stroke}" font-family="${ff}"${
      rot ? ` transform="rotate(${fmt(rot)} ${x} ${fmt(firstY)})"` : ""
    }>${tspans}</text></g>`;
    return g;
  }

  if (e.kind === "image") {
    const w = e.w ?? 100;
    const h = e.h ?? 100;
    const cx = e.pts[0] + w / 2;
    const cy = e.pts[1] + h / 2;
    const userRotDeg = e.userRot ? (e.userRot * 180) / Math.PI : 0;
    const transform = userRotDeg ? ` transform="rotate(${fmt(userRotDeg)} ${fmt(cx)} ${fmt(cy)})"` : "";
    const href = escapeXml(e.imageData ?? "");
    return `<image href="${href}" x="${fmt(e.pts[0])}" y="${fmt(e.pts[1])}" width="${fmt(w)}" height="${fmt(h)}"${transform} preserveAspectRatio="none"/>`;
  }

  let d = "";
  const n = e.pts.length / 2;
  if (e.kind === "arc") {
    d = `M${fmt(e.pts[0])} ${fmt(e.pts[1])} Q${fmt(e.pts[2])} ${fmt(e.pts[3])} ${fmt(e.pts[4])} ${fmt(e.pts[5])}`;
  } else if (e.kind === "ellipse") {
    const fill = fillAttr(e);
    const dash = e.dash ? ` stroke-dasharray="${e.dash}"` : "";
    const cx = (e.pts[0] + e.pts[2]) / 2;
    const cy = (e.pts[1] + e.pts[3]) / 2;
    const rx = Math.abs(e.pts[2] - e.pts[0]) / 2;
    const ry = Math.abs(e.pts[3] - e.pts[1]) / 2;
    return `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(rx)}" ry="${fmt(ry)}"${strokeAttr(e)} stroke-linecap="round" stroke-linejoin="round"${fill}${dash}/>`;
  } else if (e.kind === "star" || e.kind === "trapezoid") {
    const verts = shapeVerts(e);
    const fill = fillAttr(e);
    const dash = e.dash ? ` stroke-dasharray="${e.dash}"` : "";
    let points = "";
    for (let i = 0; i < verts.length / 2; i++) {
      points += `${fmt(verts[i * 2])},${fmt(verts[i * 2 + 1])} `;
    }
    return `<polygon points="${points.trim()}"${strokeAttr(e)} stroke-linejoin="round"${fill}${dash}/>`;
  } else if (e.kind === "rect" && e.radius) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const px = e.pts[i * 2], py = e.pts[i * 2 + 1];
      if (px < x0) x0 = px;
      if (py < y0) y0 = py;
      if (px > x1) x1 = px;
      if (py > y1) y1 = py;
    }
    const w = x1 - x0, h = y1 - y0;
    const r = Math.min(e.radius, w / 2, h / 2);
    const fill = fillAttr(e);
    const dash = e.dash ? ` stroke-dasharray="${e.dash}"` : "";
    return `<rect x="${fmt(x0)}" y="${fmt(y0)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(r)}"${strokeAttr(e)} stroke-linejoin="round"${fill}${dash}/>`;
  } else if (e.kind === "arrow" && n >= 2) {
    // 箭頭：依樣式取樣（直線/彎曲/直角/雙向），路徑已在頭部內縮短（與 renderer 一致）
    const rp = arrowRenderPoints(e);
    d = `M${fmt(rp[0])} ${fmt(rp[1])}`;
    for (let i = 1; i < rp.length / 2; i++) d += ` L${fmt(rp[i * 2])} ${fmt(rp[i * 2 + 1])}`;
  } else {
    d = `M${fmt(e.pts[0])} ${fmt(e.pts[1])}`;
    for (let i = 1; i < n; i++) d += ` L${fmt(e.pts[i * 2])} ${fmt(e.pts[i * 2 + 1])}`;
    if (e.closed) d += " Z";
  }

  const fill = fillAttr(e);
  const dash = e.dash ? ` stroke-dasharray="${e.dash}"` : "";
  let s = `<path d="${d}"${strokeAttr(e)} stroke-linecap="round" stroke-linejoin="round"${fill}${dash}/>`;

  if (e.kind === "arrow") {
    const drawHeadPoly = (h: { tip: [number, number]; w1: [number, number]; w2: [number, number] }) =>
      `<polygon points="${fmt(h.tip[0])},${fmt(h.tip[1])} ${fmt(h.w1[0])},${fmt(h.w1[1])} ${fmt(h.w2[0])},${fmt(h.w2[1])}" fill="${e.stroke}"/>`;
    const hEnd = arrowHeadGeom(e, "end");
    if (hEnd) s += drawHeadPoly(hEnd);
    if ((e.arrowStyle ?? "straight") === "both") {
      const hStart = arrowHeadGeom(e, "start");
      if (hStart) s += drawHeadPoly(hStart);
    }
  }
  return s;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- 渲染共用：把文件畫到離屏 canvas（供 PNG/PDF 匯出） ----------
export function renderDocToCanvas(doc: PlanDoc, scale: number, crop?: BBox): HTMLCanvasElement {
  const srcW = crop ? crop[2] - crop[0] : doc.pageW;
  const srcH = crop ? crop[3] - crop[1] : doc.pageH;
  const w = Math.max(1, Math.ceil(srcW * scale));
  const h = Math.max(1, Math.ceil(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  const view: Viewport = {
    scale,
    ox: -(crop ? crop[0] : 0) * scale,
    oy: -(crop ? crop[1] : 0) * scale,
  };
  const layerOpacity = new Map<string, number>();
  for (const l of doc.layers) layerOpacity.set(l.id, l.opacity ?? 1);
  const opts = {
    deviceRatio: 1,
    cssW: w,
    cssH: h,
    view,
    selection: new Set<string>(),
    minStrokeW: 0.3,
    layerOpacity,
    metersPerPt: doc.metersPerPt,
  };
  // 依圖層堆疊順序繪製（與畫布一致：由最下層畫到最上層）
  for (const e of orderedDrawList(doc)) renderEntity(ctx, e, opts as any);
  return canvas;
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("轉檔失敗"));
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)));
    }, "image/png");
  });
}

// ---------- PNG ----------
export function exportPNG(store: DocStore, scale?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const doc = store.doc;
    if (!doc) return reject(new Error("無文件"));
    const bb = contentBbox(doc);
    const s = scale ?? pickScale(bb[2] - bb[0], bb[3] - bb[1]);
    const canvas = renderDocToCanvas(doc, s, bb);
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG 匯出失敗"));
    }, "image/png");
  });
}

// ---------- PDF ----------
export async function exportPDF(store: DocStore): Promise<Blob> {
  const doc = store.doc;
  if (!doc) throw new Error("無文件");
  // 只輸出有內容的範圍（內容包圍盒），並以高 DPI 渲染提高清晰度
  const bb = contentBbox(doc);
  const w = bb[2] - bb[0];
  const h = bb[3] - bb[1];
  const scale = pickScale(w, h);
  const canvas = renderDocToCanvas(doc, scale, bb);
  const pngBytes = await canvasToPngBytes(canvas);

  const pdf = await PDFDocument.create();
  const png = await pdf.embedPng(pngBytes);
  // PDF 頁面尺寸 = 內容範圍（world pt），圖檔等比填滿，物理尺寸與原圖一致
  const page = pdf.addPage([w, h]);
  page.drawImage(png, { x: 0, y: 0, width: w, height: h });
  const bytes = await pdf.save();
  return new Blob([bytes], { type: "application/pdf" });
}

// ---------- 列印 ----------
export async function printDoc(store: DocStore): Promise<void> {
  const doc = store.doc;
  if (!doc) throw new Error("無文件");
  // 自動選取內容範圍（只印有物件的地方），並以高 DPI 渲染
  const bb = contentBbox(doc);
  const w = bb[2] - bb[0];
  const h = bb[3] - bb[1];
  const scale = pickScale(w, h);
  const canvas = renderDocToCanvas(doc, scale, bb);
  const dataUrl = canvas.toDataURL("image/png");
  const landscape = w > h;
  const pageCss = landscape ? "@page{size:landscape;margin:0.5cm}" : "@page{size:auto;margin:0.5cm}";
  const styleCss = `<style>${pageCss}html,body{margin:0;padding:0}img{width:100%;height:auto;display:block}</style>`;

  const wnd = window.open("", "_blank", "width=900,height=700");
  if (!wnd) {
    // 彈窗被擋時，退路：用隱藏 iframe 列印
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.write(
      `<!doctype html><html><head><title>北農平面圖編輯器 列印</title>${styleCss}</head><body><img src="${dataUrl}" onload="setTimeout(()=>{window.focus();window.print()},200)"></body></html>`
    );
    idoc.close();
    return;
  }
  wnd.document.write(
    `<!doctype html><html><head><title>北農平面圖編輯器 列印</title>${styleCss}</head><body><img src="${dataUrl}" onload="setTimeout(()=>{window.focus();window.print()},200)"></body></html>`
  );
  wnd.document.close();
}

// ---------- JSON 專案檔 ----------
export function exportJSON(store: DocStore): string {
  return JSON.stringify(store.doc, null, 2);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadText(text: string, filename: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  downloadBlob(blob, filename);
}
