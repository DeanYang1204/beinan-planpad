// PDF 向量提取 + 智能簡化（在獨立 Web Worker 執行，不阻塞主執行緒）
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import type { PlanDoc, Layer, VecEntity } from "../types";
import { genId, rgbToHex } from "../types";
import gidTableJson from "./pmingliu-gid2uni.json";

// pdf.js 需要一個 worker 檔；在 Web Worker 內會建立巢狀 worker（Chrome 支援）
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const OPS = pdfjsLib.OPS;

interface RawEntity {
  pts: number[]; // 扁平
  npt: number; // 點數
  stroke: [number, number, number]; // 0-255
  fill: [number, number, number] | null;
  width: number;
  dash: string;
  filled: boolean;
  stroked: boolean;
  rect: boolean;
}

export interface ExtractResult {
  doc: PlanDoc;
  stats: { rawEntities: number; kept: number; fillLayers: number };
}

function rgb8(c: number[] | number): [number, number, number] {
  if (typeof c === "number") return [c, c, c];
  // 防禦：若為 0-1 float 則 *255
  const v = c.map((n) => (n <= 1.5 ? Math.round(n * 255) : Math.round(n)));
  return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
}

function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  const r = 255 * (1 - Math.min(1, c + k));
  const g = 255 * (1 - Math.min(1, m + k));
  const b = 255 * (1 - Math.min(1, y + k));
  return [Math.round(r), Math.round(g), Math.round(b)];
}

self.onmessage = async (e: MessageEvent) => {
  const { data, fillThreshold = 3 } = e.data as { data: ArrayBuffer; fillThreshold?: number };
  try {
    const result = await extract(data, fillThreshold);
    (self as any).postMessage({ type: "done", result });
  } catch (err) {
    (self as any).postMessage({ type: "error", message: String(err) });
  }
};

/** 兩向量夾角 cos */
function cosAngle(a: number[], b: number[]): number {
  const la = Math.hypot(a[0], a[1]);
  const lb = Math.hypot(b[0], b[1]);
  if (la < 1e-6 || lb < 1e-6) return 0;
  return (a[0] * b[0] + a[1] * b[1]) / (la * lb);
}
const COS_LIMIT = 0.985; // cos(10°)，共線容許偏差

/** 合併端點相接且共線的碎段（2 點直線段），回傳合併後的 RawEntity 列表 */
function mergeCollinear(raws: RawEntity[], tol = 0.6): RawEntity[] {
  const keep: RawEntity[] = [];
  const lineIdx: number[] = [];
  for (let i = 0; i < raws.length; i++) {
    const r = raws[i];
    // 只合併「2 點、非矩形、非填充」的直線段
    if (r.npt === 2 && !r.rect && !r.filled) lineIdx.push(i);
    else keep.push(r);
  }
  if (lineIdx.length < 2) return raws;

  const q = (x: number) => Math.round(x / tol);
  const endMap = new Map<string, number[]>();
  for (const i of lineIdx) {
    const p = raws[i].pts;
    for (const [x, y] of [[p[0], p[1]], [p[2], p[3]]] as const) {
      const k = q(x) + ":" + q(y);
      const arr = endMap.get(k);
      if (arr) arr.push(i);
      else endMap.set(k, [i]);
    }
  }

  const used = new Set<number>();
  for (const i of lineIdx) {
    if (used.has(i)) continue;
    used.add(i);
    const pts = raws[i].pts.slice();
    let start = [pts[0], pts[1]];
    let end = [pts[2], pts[3]];

    // 向後延伸（end 端，同向共線）
    for (;;) {
      const k = q(end[0]) + ":" + q(end[1]);
      const nbrs = (endMap.get(k) || []).filter((j) => !used.has(j));
      let found = false;
      for (const j of nbrs) {
        const p = raws[j].pts;
        const mh = q(p[0]) === q(end[0]) && q(p[1]) === q(end[1]);
        const mt = q(p[2]) === q(end[0]) && q(p[3]) === q(end[1]);
        if (!mh && !mt) continue;
        const nx = mh ? p[2] : p[0];
        const ny = mh ? p[3] : p[1];
        if (cosAngle([end[0] - start[0], end[1] - start[1]], [nx - end[0], ny - end[1]]) < COS_LIMIT) continue;
        pts.push(nx, ny);
        start = end;
        end = [nx, ny];
        used.add(j);
        found = true;
        break;
      }
      if (!found) break;
    }

    // 向前延伸（start 端，反向共線）
    for (;;) {
      const k = q(start[0]) + ":" + q(start[1]);
      const nbrs = (endMap.get(k) || []).filter((j) => !used.has(j));
      let found = false;
      for (const j of nbrs) {
        const p = raws[j].pts;
        const mh = q(p[0]) === q(start[0]) && q(p[1]) === q(start[1]);
        const mt = q(p[2]) === q(start[0]) && q(p[3]) === q(start[1]);
        if (!mh && !mt) continue;
        const nx = mh ? p[2] : p[0];
        const ny = mh ? p[3] : p[1];
        if (cosAngle([end[0] - start[0], end[1] - start[1]], [nx - start[0], ny - start[1]]) > -COS_LIMIT) continue;
        pts.unshift(nx, ny);
        end = start;
        start = [nx, ny];
        used.add(j);
        found = true;
        break;
      }
      if (!found) break;
    }

    keep.push({ ...raws[i], pts, npt: pts.length / 2 });
  }

  return keep;
}

async function extract(data: ArrayBuffer, fillThreshold: number): Promise<ExtractResult> {
  const loadingTask = pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const pageW = viewport.width;
  const pageH = viewport.height;

  // ---- 遍歷 operator list 提取 path ----
  const opList = await page.getOperatorList();
  const raws: RawEntity[] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: any[] = [];
  let stroke: [number, number, number] = [0, 0, 0];
  let fill: [number, number, number] | null = null;
  let lineWidth = 1;
  let dash = "";
  const pending: { pts: number[]; rect: boolean }[] = [];
  let current: number[] = [];

  const flipY = (y: number) => pageH - y;
  // CTM 縮放因子：線寬需隨之等比縮放（PDF 座標已縮到頁面，lineWidth 仍在原空間）
  const ctmScale = () => Math.max(Math.hypot(ctm[0], ctm[1]), Math.hypot(ctm[2], ctm[3]));

  function applyCTM(x: number, y: number): [number, number] {
    return [
      ctm[0] * x + ctm[2] * y + ctm[4],
      flipY(ctm[1] * x + ctm[3] * y + ctm[5]),
    ];
  }

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push({ ctm: ctm.slice(), stroke, fill, lineWidth, dash });
        break;
      case OPS.restore: {
        const s = stack.pop();
        if (s) {
          ctm = s.ctm;
          stroke = s.stroke;
          fill = s.fill;
          lineWidth = s.lineWidth;
          dash = s.dash;
        }
        break;
      }
      case OPS.transform: {
        const [a, b, c, d, e, f] = args;
        ctm = [
          a * ctm[0] + b * ctm[2],
          a * ctm[1] + b * ctm[3],
          c * ctm[0] + d * ctm[2],
          c * ctm[1] + d * ctm[3],
          e * ctm[0] + f * ctm[2] + ctm[4],
          e * ctm[1] + f * ctm[3] + ctm[5],
        ];
        break;
      }
      case OPS.setStrokeRGBColor:
        stroke = rgb8(args as number[]);
        break;
      case OPS.setStrokeGray:
        stroke = rgb8(args[0] as number);
        break;
      case OPS.setStrokeCMYKColor:
        stroke = cmykToRgb(args[0], args[1], args[2], args[3]);
        break;
      case OPS.setFillRGBColor:
        fill = rgb8(args as number[]);
        break;
      case OPS.setFillGray:
        fill = rgb8(args[0] as number);
        break;
      case OPS.setFillCMYKColor:
        fill = cmykToRgb(args[0], args[1], args[2], args[3]);
        break;
      case OPS.setLineWidth:
        lineWidth = args[0];
        break;
      case OPS.setDash:
        dash = (args[0] as number[]).join(",");
        break;
      case OPS.constructPath: {
        const [pathOps, coords] = args as [number[], number[]];
        let ci = 0;
        current = [];
        for (let k = 0; k < pathOps.length; k++) {
          const op = pathOps[k];
          if (op === OPS.moveTo) {
            if (current.length > 1) pending.push({ pts: current, rect: false });
            current = applyCTM(coords[ci], coords[ci + 1]);
            ci += 2;
          } else if (op === OPS.lineTo) {
            current.push(...applyCTM(coords[ci], coords[ci + 1]));
            ci += 2;
          } else if (op === OPS.curveTo) {
            current.push(
              ...applyCTM(coords[ci + 2], coords[ci + 3]),
              ...applyCTM(coords[ci + 4], coords[ci + 5])
            );
            ci += 6;
          } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
            current.push(...applyCTM(coords[ci + 2], coords[ci + 3]));
            ci += 4;
          } else if (op === OPS.closePath) {
            if (current.length > 1) pending.push({ pts: current, rect: false });
            current = [];
          } else if (op === OPS.rectangle) {
            const x = coords[ci], y = coords[ci + 1], w = coords[ci + 2], h = coords[ci + 3];
            ci += 4;
            if (current.length > 1) pending.push({ pts: current, rect: false });
            const p1 = applyCTM(x, y);
            const p2 = applyCTM(x + w, y);
            const p3 = applyCTM(x + w, y + h);
            const p4 = applyCTM(x, y + h);
            pending.push({ pts: [...p1, ...p2, ...p3, ...p4, ...p1], rect: true });
          }
        }
        if (current.length > 1) pending.push({ pts: current, rect: false });
        current = [];
        break;
      }
      case OPS.stroke:
      case OPS.closeStroke:
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.closeFillStroke:
      case OPS.eoFillStroke:
      case OPS.closeEOFillStroke:
      case OPS.endPath: {
        const isFill = fn === OPS.fill || fn === OPS.eoFill;
        const isStroke = fn !== OPS.fill && fn !== OPS.eoFill && fn !== OPS.endPath;
        if (pending.length && fn !== OPS.endPath) {
          for (const p of pending) {
            if (p.pts.length < 4) continue; // 至少 2 點
            raws.push({
              pts: p.pts,
              npt: p.pts.length / 2,
              stroke: stroke.slice() as [number, number, number],
              fill: fill ? (fill.slice() as [number, number, number]) : null,
              width: Math.round(lineWidth * ctmScale() * 1000) / 1000,
              dash,
              filled: isFill,
              stroked: isStroke,
              rect: p.rect,
            });
          }
        }
        pending.length = 0;
        break;
      }
    }
  }

  const rawCount = raws.length;

  // ---- 按 (顏色, 線寬, 虛線) 分組為圖層 ----
  const layerMap = new Map<string, { idx: number; entities: RawEntity[]; totalLen: number }>();
  for (const r of raws) {
    const key = r.stroke.join(",") + "|w=" + r.width + "|d=" + r.dash;
    let g = layerMap.get(key);
    if (!g) {
      g = { idx: layerMap.size, entities: [], totalLen: 0 };
      layerMap.set(key, g);
    }
    // 計算總長度
    let len = 0;
    for (let i = 2; i < r.pts.length; i += 2) {
      len += Math.hypot(r.pts[i] - r.pts[i - 2], r.pts[i + 1] - r.pts[i - 1]);
    }
    g.totalLen += len;
    g.entities.push(r);
  }

  // ---- 建構 layers + entities ----
  const layers: Layer[] = [];
  const entities: VecEntity[] = [];
  let fillLayerCount = 0;

  const colorNames = new Map<string, string>();
  const nameColors: [string, [number, number, number]][] = [
    ["黑", [0, 0, 0]],
    ["紅", [255, 0, 0]],
    ["綠", [0, 221, 0]],
    ["藍", [0, 0, 255]],
    ["青", [0, 255, 255]],
    ["洋紅", [255, 0, 255]],
    ["黃", [255, 255, 0]],
    ["橙", [255, 165, 0]],
    ["灰", [128, 128, 128]],
  ];

  function colorName(c: [number, number, number]): string {
    const key = c.join(",");
    if (colorNames.has(key)) return colorNames.get(key)!;
    let best = "顏色";
    let bestDist = Infinity;
    for (const [nm, cc] of nameColors) {
      const d = (c[0] - cc[0]) ** 2 + (c[1] - cc[1]) ** 2 + (c[2] - cc[2]) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = nm;
      }
    }
    colorNames.set(key, best);
    return best;
  }

  for (const [key, g] of layerMap) {
    const hex = rgbToHex(g.entities[0].stroke[0], g.entities[0].stroke[1], g.entities[0].stroke[2]);
    const avgLen = g.totalLen / g.entities.length;
    const isFill = avgLen < fillThreshold;
    if (isFill) fillLayerCount++;

    // 合併端點相接且共線的碎段
    const merged = mergeCollinear(g.entities);

    const layerId = "L" + g.idx;
    layers.push({
      id: layerId,
      name: colorName(g.entities[0].stroke) + (g.entities[0].width > 0.01 ? " ·" + g.entities[0].width.toFixed(2) : ""),
      color: hex,
      width: g.entities[0].width,
      visible: !isFill, // 填充層預設隱藏
      locked: false,
      isFill,
      count: merged.length,
    });

    for (const r of merged) {
      const closed = r.rect || (r.pts.length > 4 && Math.hypot(r.pts[0] - r.pts[r.pts.length - 2], r.pts[1] - r.pts[r.pts.length - 1]) < 0.5);
      entities.push({
        id: genId(),
        kind: r.rect ? "rect" : r.npt > 2 ? "polyline" : "line",
        pts: r.pts,
        closed,
        stroke: hex,
        width: r.width,
        fill: r.filled ? (r.fill ? rgbToHex(r.fill[0], r.fill[1], r.fill[2]) : hex) : undefined,
        dash: r.dash || undefined,
        origin: "pdf",
        layerId,
      });
    }
  }

  // ---- 文字 ----
  const tc = await page.getTextContent();

  // ---- ToUnicode 壞字修復 ----
  // AutoCAD PDF 常把 glyph ID 當 Unicode 寫入 ToUnicode（如「蔬菜」變「哔厄ḁ」）。
  // 特徵：glyph.unicode 碼位 === originalCharCode（charcode/gid）。先從 operator list
  // 收集所有壞碼位，再用字型輪廓比對生成的 gid→unicode 表修復。
  const badCodepoints = new Set<number>();
  try {
    const opl = await page.getOperatorList();
    for (let i = 0; i < opl.fnArray.length; i++) {
      const fn = opl.fnArray[i];
      if (fn !== OPS.showText && fn !== OPS.showSpacedText) continue;
      for (const g of opl.argsArray[i][0]) {
        if (!g || typeof g !== "object") continue;
        const u = typeof g.unicode === "string" ? g.unicode.codePointAt(0) : (g.unicode as number);
        const oc = g.originalCharCode as number | undefined;
        if (typeof u === "number" && typeof oc === "number" && u === oc) badCodepoints.add(u);
      }
    }
  } catch {
    // operator list 解析失敗不影響文字主流程
  }

  let gid2uni: Map<number, number> | null = null;
  try {
    const j: any = gidTableJson;
    gid2uni = new Map();
    for (let i = 0; i < j.gids.length; i++) gid2uni.set(j.gids[i], j.unis[i]);
  } catch {
    gid2uni = null;
  }

  const fixStr = (s: string): string => {
    if (!gid2uni || badCodepoints.size === 0 || !s) return s;
    let changed = false;
    let out = "";
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (badCodepoints.has(cp)) {
        const fix = gid2uni.get(cp);
        if (fix) {
          out += String.fromCodePoint(fix);
          changed = true;
          continue;
        }
      }
      out += ch;
    }
    return changed ? out : s;
  };

  const textEntities: VecEntity[] = [];
  for (const it of tc.items as any[]) {
    const str = fixStr((it.str || "").trim());
    if (!str) continue;
    const t = it.transform as number[];
    const x = t[4];
    const y = flipY(t[5]);
    const fontSize = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
    const rot = Math.atan2(t[1], t[0]);
    const c: [number, number, number] = it.color
      ? [it.color[0], it.color[1], it.color[2]]
      : [0, 0, 0];
    textEntities.push({
      id: genId(),
      kind: "text",
      pts: [x, y],
      stroke: rgbToHex(c[0], c[1], c[2]),
      width: 1,
      origin: "pdf",
      layerId: "text",
      text: str,
      fontSize,
      rot,
    });
  }
  if (textEntities.length) {
    layers.push({
      id: "text",
      name: "文字",
      color: "#333333",
      width: 1,
      visible: true,
      locked: false,
      isFill: false,
      count: textEntities.length,
    });
    entities.push(...textEntities);
  }

  const planDoc: PlanDoc = { pageW, pageH, layers, entities };

  return { doc: planDoc, stats: { rawEntities: rawCount, kept: entities.length, fillLayers: fillLayerCount } };
}
