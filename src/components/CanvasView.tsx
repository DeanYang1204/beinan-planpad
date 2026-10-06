import { useCallback, useEffect, useRef, useState } from "react";
import type { DocStore } from "../engine/document";
import {
  renderChunk,
  renderOverlay,
  screenToWorld,
  worldToScreen,
  viewBBox,
  type RenderOpts,
  type RenderState,
} from "../engine/renderer";
import { entityBbox, pointInShape, pointInPolygon, snapPoint, bendHandlePos, rotateHandlePos, arrowBendHandlePos, type BBox } from "../engine/geometry";
import type { ToolId, VecEntity, Viewport } from "../types";
import { genId, measureTextWidth, fontStack, TEXT_LINE_HEIGHT } from "../types";

/** 工具 → 圖層名稱（一圖一層，依工具命名） */
const KIND_LABEL: Record<string, string> = {
  line: "直線",
  arrow: "箭頭",
  ellipse: "橢圓",
  rect: "矩形",
  roundrect: "圓角矩形",
  polyline: "折線",
  polygon: "多邊形",
  arc: "弧線",
  star: "星形",
  trapezoid: "梯形",
  text: "文字",
  image: "圖片",
};

export interface CanvasApi {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  deleteSelection: () => void;
  undo: () => void;
  redo: () => void;
  editText: (id: string) => void;
}

interface Props {
  store: DocStore;
  tool: ToolId;
  style: { stroke: string; width: number; dash: string; fill: string; fontSize: number };
  apiRef: React.MutableRefObject<CanvasApi | null>;
  onHoverChange?: (id: string | null) => void;
  onPickColor?: (c: string) => void;
  /** 畫完圖形後回調（用於自動切回選取工具） */
  onToolChange?: (t: ToolId) => void;
  /** 是否顯示網格背景 */
  showGrid?: boolean;
  /** 是否顯示 XY 十字準星 */
  showCrosshair?: boolean;
}

type DragState =
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { kind: "move"; ids: string[]; startW: [number, number]; lastW: [number, number]; moved: boolean }
  | { kind: "vertex"; id: string; vi: number; lastW: [number, number]; beforePts: number[]; startW: [number, number] }
  | { kind: "stretch"; id: string; edge: number; beforePts: number[] }
  | { kind: "bend"; id: string; beforeKind: VecEntity["kind"]; beforePts: number[] }
  | { kind: "arrowBend"; id: string; beforeBend: number | undefined; startSigned: number; startBend: number }
  | { kind: "rotate"; id: string; startW: [number, number]; startAngle: number; startUserRot: number }
  | { kind: "marquee"; startW: [number, number]; curW: [number, number] }
  | { kind: "line"; startW: [number, number]; curW: [number, number] }
  | { kind: "arrow"; startW: [number, number]; curW: [number, number] }
  | { kind: "rect"; startW: [number, number]; curW: [number, number] }
  | { kind: "roundrect"; startW: [number, number]; curW: [number, number] }
  | { kind: "ellipse"; startW: [number, number]; curW: [number, number] }
  | { kind: "star"; startW: [number, number]; curW: [number, number] }
  | { kind: "polyline"; pts: number[]; curW: [number, number] }
  | { kind: "polygon"; pts: number[]; curW: [number, number] }
  | { kind: "arc"; stage: 0 | 1 | 2; pts: number[]; curW: [number, number] }
  | { kind: "measure"; startW: [number, number]; curW: [number, number] }
  | { kind: "lasso"; pts: number[]; curW: [number, number] }
  | { kind: "eraser" }
  | null;

type ShapeTool = "line" | "arrow" | "rect" | "roundrect" | "ellipse" | "star";

/** SHIFT 約束：直線/箭頭吸附到 0/45/90°…，矩形/橢圓/星型/梯形約束為正方形外框 */
function applyConstraint(start: [number, number], cur: [number, number], tool: ShapeTool, shift: boolean): [number, number] {
  if (!shift) return cur;
  const dx = cur[0] - start[0];
  const dy = cur[1] - start[1];
  if (tool === "line" || tool === "arrow") {
    const ang = Math.atan2(dy, dx);
    const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return [start[0] + Math.cos(snapped) * len, start[1] + Math.sin(snapped) * len];
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = dx >= 0 ? side : -side;
  const sy = dy >= 0 ? side : -side;
  return [start[0] + sx, start[1] + sy];
}

export default function CanvasView({ store, tool, style, apiRef, onHoverChange, onPickColor, onToolChange, showGrid = true, showCrosshair = true }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const viewRef = useRef<Viewport>({ scale: 1, ox: 0, oy: 0 });
  const sizeRef = useRef({ w: 800, h: 600, ratio: 1 });
  const dragRef = useRef<DragState>(null);
  const snapRef = useRef<[number, number] | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageInsertRef = useRef<[number, number] | null>(null);
  const baseState = useRef<RenderState>({ list: null, i: 0, viewKey: "" });
  const hoverRef = useRef<string | null>(null);
  const styleRef = useRef(style);
  const toolRef = useRef(tool);
  const crosshairRef = useRef<[number, number] | null>(null);
  const showGridRef = useRef(showGrid);
  const showCrosshairRef = useRef(showCrosshair);
  styleRef.current = style;
  toolRef.current = tool;
  showGridRef.current = showGrid;
  showCrosshairRef.current = showCrosshair;

  // 文字輸入框狀態
  const [textInput, setTextInput] = useState<{
    x: number;
    y: number;
    editId?: string;
    value: string;
    sx: number;
    sy: number;
    fontSize?: number;
    fontFamily?: string;
    bgColor?: string;
    stroke?: string;
    borderColor?: string;
    borderWidth?: number;
    vertical?: boolean;
  } | null>(null);

  // ---------- 渲染標誌 ----------
  const baseDirty = useRef(true);
  const overlayDirty = useRef(true);

  const markBaseDirty = useCallback(() => {
    baseDirty.current = true;
  }, []);
  const markOverlayDirty = useCallback(() => {
    overlayDirty.current = true;
  }, []);

  // 訂閱 store 變更
  useEffect(() => {
    return store.subscribe(() => {
      markBaseDirty();
      markOverlayDirty();
    });
  }, [store, markBaseDirty, markOverlayDirty]);

  // 網格/準星開關變化時重繪
  useEffect(() => {
    markBaseDirty();
    markOverlayDirty();
  }, [showGrid, showCrosshair, markBaseDirty, markOverlayDirty]);

  // ---------- 尺寸 ----------
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      sizeRef.current = { w: rect.width, h: rect.height, ratio };
      for (const c of [baseRef.current, overlayRef.current]) {
        if (!c) continue;
        c.width = Math.round(rect.width * ratio);
        c.height = Math.round(rect.height * ratio);
        c.style.width = rect.width + "px";
        c.style.height = rect.height + "px";
      }
      markBaseDirty();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [markBaseDirty]);

  // ---------- 渲染循環 ----------
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const base = baseRef.current;
      const overlay = overlayRef.current;
      if (!base || !overlay) return;
      const { w, h, ratio } = sizeRef.current;
      const view = viewRef.current;
      // 圖層不透明度映射（每幀重建，成本可忽略）
      const layerOpacity = new Map<string, number>();
      if (store.doc) for (const l of store.doc.layers) layerOpacity.set(l.id, l.opacity ?? 1);
      const opts: RenderOpts = {
        deviceRatio: ratio,
        cssW: w,
        cssH: h,
        view,
        selection: store.selection,
        hoverId: hoverRef.current,
        minStrokeW: 0.4,
        showGrid: showGridRef.current,
        crosshair: showCrosshairRef.current ? crosshairRef.current : null,
        midHandleStretch: toolRef.current === "select",
        layerOpacity,
      };

      if (baseDirty.current) {
        const ctx = base.getContext("2d")!;
        const done = renderChunk(ctx, store, opts, baseState.current, 12);
        if (done) {
          baseDirty.current = false;
        }
      }

      if (overlayDirty.current) {
        const ctx = overlay.getContext("2d")!;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const extras = ghostForOverlay();
        renderOverlay(ctx, store, { ...opts, ...extras });
        overlayDirty.current = false;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  // ---------- 座標 ----------
  function toWorld(ev: { clientX: number; clientY: number }): [number, number] {
    const rect = baseRef.current!.getBoundingClientRect();
    return screenToWorld(viewRef.current, ev.clientX - rect.left, ev.clientY - rect.top);
  }

  // ---------- 預覽圖元 ----------
  function ghostForOverlay(): Partial<RenderOpts> {
    const d = dragRef.current;
    const snapPt = snapRef.current;
    if (!d) return { ghost: null, marquee: undefined, snapPt };
    const mk = (pts: number[], kind: VecEntity["kind"], closed = false): VecEntity => ({
      id: "__ghost__",
      kind,
      pts,
      closed,
      stroke: styleRef.current.stroke,
      width: styleRef.current.width,
      dash: styleRef.current.dash || undefined,
      fill: styleRef.current.fill || undefined,
      origin: "user",
      layerId: "user",
    });
    let out: Partial<RenderOpts>;
    switch (d.kind) {
      case "marquee":
        out = { marquee: [d.startW[0], d.startW[1], d.curW[0], d.curW[1]] as BBox };
        break;
      case "line":
        out = { ghost: mk([...d.startW, ...d.curW], "line") };
        break;
      case "arrow":
        out = { ghost: mk([...d.startW, ...d.curW], "arrow") };
        break;
      case "rect": {
        const x0 = Math.min(d.startW[0], d.curW[0]);
        const y0 = Math.min(d.startW[1], d.curW[1]);
        const x1 = Math.max(d.startW[0], d.curW[0]);
        const y1 = Math.max(d.startW[1], d.curW[1]);
        out = { ghost: mk([x0, y0, x1, y0, x1, y1, x0, y1], "rect", true) };
        break;
      }
      case "roundrect": {
        const x0 = Math.min(d.startW[0], d.curW[0]);
        const y0 = Math.min(d.startW[1], d.curW[1]);
        const x1 = Math.max(d.startW[0], d.curW[0]);
        const y1 = Math.max(d.startW[1], d.curW[1]);
        const gh = mk([x0, y0, x1, y0, x1, y1, x0, y1], "rect", true);
        gh.radius = 12;
        out = { ghost: gh };
        break;
      }
      case "lasso": {
        const pts = [...d.pts, ...d.curW];
        out = { ghost: mk(pts, "polyline") };
        break;
      }
      case "ellipse":
        out = { ghost: mk([...d.startW, ...d.curW], "ellipse") };
        break;
      case "star":
        out = { ghost: mk([...d.startW, ...d.curW], "star") };
        break;
      case "polyline": {
        const pts = [...d.pts, ...d.curW];
        out = { ghost: mk(pts, "polyline") };
        break;
      }
      case "polygon": {
        const pts = [...d.pts, ...d.curW];
        out = { ghost: mk(pts, "polyline", true) };
        break;
      }
      case "arc": {
        if (d.stage === 0) out = { ghost: mk([...d.pts.slice(0, 2), ...d.curW], "line") };
        else {
          const p0 = d.pts.slice(0, 2);
          const p1 = d.pts.slice(2, 4);
          out = { ghost: mk([...p0, ...d.curW, ...p1], "arc") };
        }
        break;
      }
      case "measure":
        out = { ghost: mk([...d.startW, ...d.curW], "line") };
        break;
      default:
        out = { ghost: null };
    }
    return { ...out, snapPt };
  }

  // ---------- 命中測試 ----------
  /** 找最近的既有圖元端點（供畫線時錨點銜接吸附） */
  function findSnap(w: [number, number]): [number, number] | null {
    const tol = 8 / viewRef.current.scale;
    const idx = store.getIndex();
    const cand = idx.queryBBox([w[0] - tol, w[1] - tol, w[0] + tol, w[1] + tol]);
    let best: [number, number] | null = null;
    let bestD = tol;
    for (const e of cand) {
      const layer = store.doc?.layers.find((l) => l.id === e.layerId);
      if (layer && (!layer.visible || layer.locked)) continue;
      if (e.kind === "text" || e.kind === "ellipse" || e.kind === "star" || e.kind === "trapezoid") continue;
      const n = e.pts.length / 2;
      for (let i = 0; i < n; i++) {
        if (e.kind === "arc" && i !== 0 && i !== n - 1) continue; // 弧線只吸起/終點
        const d = Math.hypot(e.pts[i * 2] - w[0], e.pts[i * 2 + 1] - w[1]);
        if (d < bestD) {
          bestD = d;
          best = [e.pts[i * 2], e.pts[i * 2 + 1]];
        }
      }
    }
    return best;
  }

  function hitTest(w: [number, number]): string | null {
    const tol = 6 / viewRef.current.scale;
    const idx = store.getIndex();
    const hits = idx.queryPoint(w[0], w[1], tol);
    // 依圖層堆疊取最上層（doc.layers index 小 = 上層）；同層取距離最近者（queryPoint 已按距離排序）
    let bestId: string | null = null;
    let bestZ = Number.MAX_SAFE_INTEGER;
    for (const e of hits) {
      const layer = store.doc?.layers.find((l) => l.id === e.layerId);
      if (layer && !layer.visible) continue;
      if (layer && layer.locked) continue;
      const z = store.entityZ(e);
      if (z < bestZ) {
        bestZ = z;
        bestId = e.id;
      }
    }
    return bestId;
  }

  function hitVertex(w: [number, number]): { id: string; vi: number } | null {
    if (store.selection.size !== 1) return null;
    const id = [...store.selection][0];
    const e = store.doc?.entities.find((x) => x.id === id);
    if (!e || e.kind === "text") return null;
    const tol = 8 / viewRef.current.scale;
    const n = e.pts.length / 2;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(e.pts[i * 2] - w[0], e.pts[i * 2 + 1] - w[1]);
      if (d < tol) return { id, vi: i };
    }
    return null;
  }

  /** 全域頂點命中（錨點工具用）：不需預先選取，直接找最近的可見未鎖圖元頂點 */
  function hitAnyVertex(w: [number, number]): { id: string; vi: number } | null {
    const tol = 9 / viewRef.current.scale;
    const idx = store.getIndex();
    const cand = idx.queryBBox([w[0] - tol, w[1] - tol, w[0] + tol, w[1] + tol]);
    let best: { id: string; vi: number } | null = null;
    let bestD = tol;
    for (const e of cand) {
      const layer = store.doc?.layers.find((l) => l.id === e.layerId);
      if (layer && (!layer.visible || layer.locked)) continue;
      if (e.kind === "text") continue;
      const n = e.pts.length / 2;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(e.pts[i * 2] - w[0], e.pts[i * 2 + 1] - w[1]);
        if (d < bestD) {
          bestD = d;
          best = { id: e.id, vi: i };
        }
      }
    }
    return best;
  }

  /** 全域中點命中（錨點工具用）：點擊線段中點即可插入新錨點 */
  function hitAnyMidpoint(w: [number, number]): { id: string; seg: number; mx: number; my: number } | null {
    const tol = 8 / viewRef.current.scale;
    const idx = store.getIndex();
    const cand = idx.queryBBox([w[0] - tol, w[1] - tol, w[0] + tol, w[1] + tol]);
    let best: { id: string; seg: number; mx: number; my: number } | null = null;
    let bestD = tol;
    for (const e of cand) {
      const layer = store.doc?.layers.find((l) => l.id === e.layerId);
      if (layer && (!layer.visible || layer.locked)) continue;
      if (e.kind === "text" || e.kind === "arc" || e.kind === "ellipse" || e.kind === "star" || e.kind === "trapezoid") continue;
      const n = e.pts.length / 2;
      const segs = e.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const mx = (e.pts[i * 2] + e.pts[j * 2]) / 2;
        const my = (e.pts[i * 2 + 1] + e.pts[j * 2 + 1]) / 2;
        const d = Math.hypot(mx - w[0], my - w[1]);
        if (d < bestD) {
          bestD = d;
          best = { id: e.id, seg: i, mx, my };
        }
      }
    }
    return best;
  }

  /** 偵測點擊弧度把手（單選 2 點直線，拖動把直線彎成弧線） */
  function hitBend(w: [number, number]): string | null {
    if (store.selection.size !== 1) return null;
    const id = [...store.selection][0];
    const e = store.doc?.entities.find((x) => x.id === id);
    if (!e) return null;
    const hp = bendHandlePos(e, viewRef.current.scale);
    if (!hp) return null;
    const tol = 9 / viewRef.current.scale;
    return Math.hypot(hp[0] - w[0], hp[1] - w[1]) < tol ? id : null;
  }

  /** 偵測點擊彎曲箭頭的弧度把手（單選 curved 箭頭，拖動調整弧度） */
  function hitArrowBend(w: [number, number]): string | null {
    if (store.selection.size !== 1) return null;
    const id = [...store.selection][0];
    const e = store.doc?.entities.find((x) => x.id === id);
    if (!e) return null;
    const hp = arrowBendHandlePos(e, viewRef.current.scale);
    if (!hp) return null;
    const tol = 9 / viewRef.current.scale;
    return Math.hypot(hp[0] - w[0], hp[1] - w[1]) < tol ? id : null;
  }

  /** 偵測點擊旋轉把手（單選文字/圖片，拖動繞中心旋轉） */
  function hitRotate(w: [number, number]): string | null {
    if (store.selection.size !== 1) return null;
    const id = [...store.selection][0];
    const e = store.doc?.entities.find((x) => x.id === id);
    if (!e || (e.kind !== "text" && e.kind !== "image")) return null;
    const hp = rotateHandlePos(e, viewRef.current.scale);
    if (!hp) return null;
    const tol = 10 / viewRef.current.scale;
    return Math.hypot(hp[0] - w[0], hp[1] - w[1]) < tol ? id : null;
  }

  /** 偵測點擊中點把手（用於插入錨點） */
  function hitMidpoint(w: [number, number]): { id: string; seg: number; mx: number; my: number } | null {
    if (store.selection.size !== 1) return null;
    const id = [...store.selection][0];
    const e = store.doc?.entities.find((x) => x.id === id);
    if (!e) return null;
    if (e.kind === "text" || e.kind === "arc" || e.kind === "ellipse" || e.kind === "star" || e.kind === "trapezoid") return null;
    const tol = 8 / viewRef.current.scale;
    const n = e.pts.length / 2;
    const segs = e.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const mx = (e.pts[i * 2] + e.pts[j * 2]) / 2;
      const my = (e.pts[i * 2 + 1] + e.pts[j * 2 + 1]) / 2;
      const d = Math.hypot(mx - w[0], my - w[1]);
      if (d < tol) return { id, seg: i, mx, my };
    }
    return null;
  }

  // ---------- 縮放 ----------
  function zoomAt(sx: number, sy: number, factor: number) {
    const v = viewRef.current;
    const wx = (sx - v.ox) / v.scale;
    const wy = (sy - v.oy) / v.scale;
    const ns = Math.min(50, Math.max(0.02, v.scale * factor));
    v.scale = ns;
    v.ox = sx - wx * ns;
    v.oy = sy - wy * ns;
    markBaseDirty();
    markOverlayDirty();
  }

  // ---------- Fit ----------
  const fit = useCallback(() => {
    const doc = store.doc;
    if (!doc) return;
    const { w, h } = sizeRef.current;
    const scale = Math.min(w / doc.pageW, h / doc.pageH) * 0.96;
    viewRef.current = {
      scale,
      ox: (w - doc.pageW * scale) / 2,
      oy: (h - doc.pageH * scale) / 2,
    };
    markBaseDirty();
    markOverlayDirty();
  }, [store, markBaseDirty, markOverlayDirty]);

  // 編輯既有文字（供屬性面板「內容」按鈕呼叫）
  const editTextEntity = useCallback(
    (id: string) => {
      const e = store.doc?.entities.find((x) => x.id === id);
      if (!e || e.kind !== "text") return;
      const [sx, sy] = worldToScreen(viewRef.current, e.pts[0], e.pts[1]);
      setTextInput({ x: e.pts[0], y: e.pts[1], editId: id, value: e.text ?? "", sx, sy, fontSize: e.fontSize, fontFamily: e.fontFamily, bgColor: e.bgColor, stroke: e.stroke, borderColor: e.borderColor, borderWidth: e.borderWidth, vertical: e.vertical });
    },
    [store]
  );

  // 載入後自動 fit
  useEffect(() => {
    return store.subscribe(() => {
      if (store.doc && !fitRef.current.done) {
        fitRef.current.done = true;
        fit();
      }
    });
  }, [store, fit]);
  const fitRef = useRef({ done: false });

  // ---------- 暴露 API ----------
  useEffect(() => {
    apiRef.current = {
      fit,
      zoomIn: () => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, 1.25),
      zoomOut: () => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, 0.8),
      deleteSelection: () => store.removeEntities([...store.selection]),
      undo: () => store.undo(),
      redo: () => store.redo(),
      editText: editTextEntity,
    };
    // 供測試換算座標
    (window as any).__planpad_w2s = (wx: number, wy: number) => worldToScreen(viewRef.current, wx, wy);
    (window as any).__planpad_scale = () => viewRef.current.scale;
    (window as any).__planpad_drag = () => dragRef.current?.kind ?? null;
  }, [fit, store, apiRef, editTextEntity]);

  // ---------- 指標事件 ----------
  function onPointerDown(ev: React.PointerEvent) {
    // capture 設在接收事件的 overlay 上，確保後續 move/up 事件能觸發（設到 base 會導致拖拽失效）
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    const rect = baseRef.current!.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const w = screenToWorld(viewRef.current, sx, sy);
    const t = toolRef.current;

    // 中鍵 / 空白鍵平移
    if (ev.button === 1 || (ev.button === 0 && ev.shiftKey && t === "select")) {
      dragRef.current = { kind: "pan", sx, sy, ox: viewRef.current.ox, oy: viewRef.current.oy };
      return;
    }

    if (t === "select") {
      // 頂點編輯
      const vhit = hitVertex(w);
      if (vhit) {
        const ve = store.doc?.entities.find((x) => x.id === vhit.id);
        dragRef.current = { kind: "vertex", id: vhit.id, vi: vhit.vi, lastW: w, beforePts: ve ? ve.pts.slice() : [], startW: w };
        return;
      }
      // 邊中點：矩形＝拉伸該邊（調整寬/高，保持矩形）；其餘圖形不在此插錨點（錨點由錨點工具自行增加）
      const mhit = hitMidpoint(w);
      if (mhit) {
        const me = store.doc?.entities.find((x) => x.id === mhit.id);
        if (me && me.kind === "rect" && me.pts.length === 8) {
          dragRef.current = { kind: "stretch", id: mhit.id, edge: mhit.seg, beforePts: me.pts.slice() };
          return;
        }
      }
      // 弧度把手：直線→弧線並進入控制點拖動
      const bhit = hitBend(w);
      if (bhit) {
        const be = store.doc?.entities.find((x) => x.id === bhit);
        if (be) {
          const beforeKind = be.kind;
          const beforePts = be.pts.slice();
          // 就地轉為弧線：起點、控制點（=目前把手位置）、終點
          be.kind = "arc";
          be.pts = [be.pts[0], be.pts[1], w[0], w[1], be.pts[2], be.pts[3]];
          be.bbox = entityBbox(be);
          store.emit();
          dragRef.current = { kind: "bend", id: bhit, beforeKind, beforePts };
          return;
        }
      }
      // 彎曲箭頭弧度把手：拖動調整 bend（弧度倍率）
      const abhit = hitArrowBend(w);
      if (abhit) {
        const ae = store.doc?.entities.find((x) => x.id === abhit);
        if (ae && ae.kind === "arrow" && ae.pts.length === 4) {
          const x0 = ae.pts[0], y0 = ae.pts[1];
          const x1 = ae.pts[2], y1 = ae.pts[3];
          const L = Math.hypot(x1 - x0, y1 - y0) || 1;
          const nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
          const startSigned = (w[0] - (x0 + x1) / 2) * nx + (w[1] - (y0 + y1) / 2) * ny;
          dragRef.current = { kind: "arrowBend", id: abhit, beforeBend: ae.bend, startSigned, startBend: ae.bend ?? 0.25 };
          return;
        }
      }
      // 旋轉把手：文字/圖片繞中心旋轉
      const rhit = hitRotate(w);
      if (rhit) {
        const re = store.doc?.entities.find((x) => x.id === rhit);
        if (re) {
          const b = entityBbox(re);
          const cx = (b[0] + b[2]) / 2;
          const cy = (b[1] + b[3]) / 2;
          const startAngle = Math.atan2(w[1] - cy, w[0] - cx);
          dragRef.current = { kind: "rotate", id: rhit, startW: w, startAngle, startUserRot: re.userRot ?? 0 };
          return;
        }
      }
      const hit = hitTest(w);
      if (hit) {
        if (store.selection.has(hit)) {
          // 拖動既有選取
          dragRef.current = { kind: "move", ids: [...store.selection], startW: w, lastW: w, moved: false };
        } else {
          // 點選群組成員 → 整組選取
          const ids = store.expandGroups(ev.shiftKey ? [...store.selection, hit] : [hit]);
          store.setSelection(ids);
          dragRef.current = { kind: "move", ids, startW: w, lastW: w, moved: false };
        }
        markOverlayDirty();
      } else {
        // 空白處：框選
        if (!ev.shiftKey) store.clearSelection();
        dragRef.current = { kind: "marquee", startW: w, curW: w };
        markOverlayDirty();
      }
      return;
    }

    if (t === "line" || t === "arrow") {
      const s = findSnap(w) ?? w;
      snapRef.current = s === w ? null : s;
      dragRef.current = { kind: t, startW: s, curW: s };
      return;
    }
    if (t === "rect" || t === "roundrect" || t === "ellipse" || t === "star") {
      dragRef.current = { kind: t, startW: w, curW: w };
      return;
    }
    if (t === "fill") {
      const c = styleRef.current.fill || styleRef.current.stroke;
      // 優先找包含點擊點的封閉圖形（上色語義），其次命中邊線
      const vb = viewBBox({
        deviceRatio: 1,
        cssW: sizeRef.current.w,
        cssH: sizeRef.current.h,
        view: viewRef.current,
        selection: store.selection,
      });
      const candidates = store.getIndex().queryBBox(vb);
      const fillable = new Set(["rect", "polyline", "line", "ellipse", "star", "trapezoid"]);
      let filled = false;
      for (const e of candidates) {
        const layer = store.doc?.layers.find((l) => l.id === e.layerId);
        if (layer && (!layer.visible || layer.locked)) continue;
        if (!fillable.has(e.kind)) continue;
        if ((e.kind === "rect" || e.kind === "polyline" || e.kind === "line") && !e.closed) continue;
        if (pointInShape(e, w[0], w[1])) {
          store.updateStyle(e.id, { fill: c });
          filled = true;
          break;
        }
      }
      if (!filled) {
        const hit = hitTest(w);
        if (hit) store.updateStyle(hit, { fill: c });
      }
      return;
    }
    if (t === "measure") {
      dragRef.current = { kind: "measure", startW: w, curW: w };
      return;
    }
    if (t === "hand") {
      dragRef.current = { kind: "pan", sx, sy, ox: viewRef.current.ox, oy: viewRef.current.oy };
      return;
    }
    if (t === "zoom") {
      zoomAt(sx, sy, ev.altKey ? 0.8 : 1.25);
      return;
    }
    if (t === "eyedropper") {
      const hit = hitTest(w);
      if (hit) {
        const e = store.doc?.entities.find((x) => x.id === hit);
        if (e) onPickColor?.(ev.altKey && e.fill ? e.fill : e.stroke);
      }
      return;
    }
    if (t === "eraser") {
      const hit = hitTest(w);
      if (hit) store.removeEntities([hit]);
      dragRef.current = { kind: "eraser" };
      return;
    }
    if (t === "lasso") {
      if (!ev.shiftKey) store.clearSelection();
      dragRef.current = { kind: "lasso", pts: [...w], curW: w };
      return;
    }
    if (t === "magic") {
      const hit = hitTest(w);
      if (hit) {
        const seed = store.doc?.entities.find((x) => x.id === hit);
        if (seed) {
          // 魔棒：選取同描邊顏色 + 同圖層的可見未鎖圖元
          const ids: string[] = [];
          for (const e of store.doc!.entities) {
            const layer = store.doc!.layers.find((l) => l.id === e.layerId);
            if (layer && (!layer.visible || layer.locked)) continue;
            if (e.stroke === seed.stroke && e.layerId === seed.layerId) ids.push(e.id);
          }
          store.setSelection(ids);
        }
      }
      return;
    }
    if (t === "text") {
      // 阻止 pointerdown 預設行為（focus 轉移），否則後續 mousedown 會把 autoFocus 搶走觸發 onBlur
      ev.preventDefault();
      setTextInput({ x: w[0], y: w[1], value: "", sx, sy, fontSize: styleRef.current.fontSize });
      return;
    }
    if (t === "image") {
      ev.preventDefault();
      imageInsertRef.current = w;
      imageInputRef.current?.click();
      return;
    }
    if (t === "anchor") {
      // 直接抓取最近頂點（免預先選取），選中後進入頂點拖動
      const ahit = hitAnyVertex(w);
      if (ahit) {
        const ae = store.doc?.entities.find((x) => x.id === ahit.id);
        store.setSelection([ahit.id]);
        dragRef.current = { kind: "vertex", id: ahit.id, vi: ahit.vi, lastW: w, beforePts: ae ? ae.pts.slice() : [], startW: w };
        return;
      }
      // 點擊線段中點 → 插入新錨點並直接拖動
      const amid = hitAnyMidpoint(w);
      if (amid) {
        store.insertVertex(amid.id, amid.mx, amid.my, amid.seg);
        const e2 = store.doc?.entities.find((x) => x.id === amid.id);
        store.setSelection([amid.id]);
        dragRef.current = { kind: "vertex", id: amid.id, vi: amid.seg + 1, lastW: w, beforePts: e2 ? e2.pts.slice() : [], startW: w };
        return;
      }
      // 沒抓到錨點：退到一般選取行為（點線選取/框選）
      const hit = hitTest(w);
      if (hit) {
        const ids = store.expandGroups([hit]);
        store.setSelection(ids);
        dragRef.current = { kind: "move", ids, startW: w, lastW: w, moved: false };
      } else {
        if (!ev.shiftKey) store.clearSelection();
        dragRef.current = { kind: "marquee", startW: w, curW: w };
      }
      markOverlayDirty();
      return;
    }

    if (t === "polygon") {
      const d = dragRef.current;
      if (d && d.kind === "polygon") {
        // 點擊接近起點 → 閉合完成
        if (d.pts.length >= 6 && Math.hypot(w[0] - d.pts[0], w[1] - d.pts[1]) < 10 / viewRef.current.scale) {
          finishPolygon(d.pts);
          return;
        }
        d.pts.push(...w);
        d.curW = w;
      } else {
        dragRef.current = { kind: "polygon", pts: [...w], curW: w };
      }
      return;
    }
    if (t === "polyline") {
      const d = dragRef.current;
      if (d && d.kind === "polyline") {
        d.pts.push(...w);
        d.curW = w;
      } else {
        dragRef.current = { kind: "polyline", pts: [...w], curW: w };
      }
      return;
    }
    if (t === "arc") {
      const d = dragRef.current;
      if (!d || d.kind !== "arc") {
        dragRef.current = { kind: "arc", stage: 0, pts: [...w], curW: w };
      } else if (d.stage === 0) {
        d.pts.push(...w);
        d.stage = 1;
        d.curW = w;
      } else if (d.stage === 1) {
        // 第三點：控制點 → 完成
        const e: VecEntity = {
          id: genId(),
          kind: "arc",
          pts: [...d.pts.slice(0, 2), ...w, ...d.pts.slice(2, 4)],
          stroke: styleRef.current.stroke,
          width: styleRef.current.width,
          dash: styleRef.current.dash || undefined,
          origin: "user",
          layerId: store.ensureDrawLayer(styleRef.current.stroke, KIND_LABEL.arc),
        };
        store.addEntity(e);
        store.setSelection([e.id]);
        onToolChange?.("select");
        dragRef.current = null;
      }
      return;
    }
  }

  function onPointerMove(ev: React.PointerEvent) {
    const rect = baseRef.current!.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const w = screenToWorld(viewRef.current, sx, sy);
    const d = dragRef.current;

    // 更新十字準星位置（開啟時）
    if (showCrosshairRef.current) {
      crosshairRef.current = [sx, sy];
      markOverlayDirty();
    }

    if (!d) {
      // hover
      const hit = toolRef.current === "select" ? hitTest(w) : null;
      if (hit !== hoverRef.current) {
        hoverRef.current = hit;
        onHoverChange?.(hit);
        markOverlayDirty();
      }
      return;
    }

    switch (d.kind) {
      case "pan": {
        viewRef.current.ox = d.ox + (sx - d.sx);
        viewRef.current.oy = d.oy + (sy - d.sy);
        markBaseDirty();
        markOverlayDirty();
        break;
      }
      case "move": {
        let dx = w[0] - d.lastW[0];
        let dy = w[1] - d.lastW[1];
        // SHIFT：鎖定水平/垂直移動
        if (ev.shiftKey && (dx !== 0 || dy !== 0)) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (dx !== 0 || dy !== 0) {
          store.moveLive(d.ids, dx, dy);
          d.lastW = [d.lastW[0] + dx, d.lastW[1] + dy];
          d.moved = true;
        }
        markOverlayDirty();
        break;
      }
      case "vertex": {
        const e = store.doc?.entities.find((x) => x.id === d.id);
        if (e) {
          if (ev.shiftKey && e.kind === "rect" && e.pts.length === 8) {
            // SHIFT：保持矩形不歪斜——拖動角移動，相鄰兩角沿邊跟隨，對角不動
            const vi = d.vi;
            const nx = w[0];
            const ny = w[1];
            const j = (vi + 1) % 4;
            const k = (vi + 3) % 4;
            e.pts[vi * 2] = nx;
            e.pts[vi * 2 + 1] = ny;
            if (vi % 2 === 0) {
              e.pts[j * 2 + 1] = ny; // 相鄰角沿用新 y
              e.pts[k * 2] = nx; // 相鄰角沿用新 x
            } else {
              e.pts[j * 2] = nx;
              e.pts[k * 2 + 1] = ny;
            }
          } else if (ev.shiftKey) {
            // SHIFT：鎖定水平/垂直——位移大的軸向跟隨游標，另一軸固定在起點
            const dx = Math.abs(w[0] - d.startW[0]);
            const dy = Math.abs(w[1] - d.startW[1]);
            if (dx >= dy) {
              e.pts[d.vi * 2] = w[0];
              e.pts[d.vi * 2 + 1] = d.startW[1];
            } else {
              e.pts[d.vi * 2] = d.startW[0];
              e.pts[d.vi * 2 + 1] = w[1];
            }
          } else {
            e.pts[d.vi * 2] = w[0];
            e.pts[d.vi * 2 + 1] = w[1];
          }
          e.bbox = entityBbox(e);
          store.emit();
        }
        markOverlayDirty();
        break;
      }
      case "stretch": {
        const e = store.doc?.entities.find((x) => x.id === d.id);
        if (e && e.kind === "rect" && e.pts.length === 8) {
          // 矩形 4 點 [左上,右上,右下,左下]；拖上/下邊改 y、左/右邊改 x，對邊固定保持矩形
          switch (d.edge) {
            case 0: e.pts[1] = w[1]; e.pts[3] = w[1]; break; // 上邊
            case 1: e.pts[2] = w[0]; e.pts[4] = w[0]; break; // 右邊
            case 2: e.pts[5] = w[1]; e.pts[7] = w[1]; break; // 下邊
            case 3: e.pts[6] = w[0]; e.pts[0] = w[0]; break; // 左邊
          }
          e.bbox = entityBbox(e);
          store.emit();
        }
        markOverlayDirty();
        break;
      }
      case "bend": {
        // 拖動弧線控制點（已轉為 arc，pts=[起,控,終]）
        const e = store.doc?.entities.find((x) => x.id === d.id);
        if (e && e.kind === "arc") {
          e.pts[2] = w[0];
          e.pts[3] = w[1];
          e.bbox = entityBbox(e);
          store.emit();
        }
        markOverlayDirty();
        break;
      }
      case "arrowBend": {
        // 拖動彎曲箭頭弧度：以起訖弦中點為基準，滑鼠沿法線的位移換算為 bend（±1）
        const e = store.doc?.entities.find((x) => x.id === d.id);
        if (e && e.kind === "arrow" && e.pts.length === 4) {
          const x0 = e.pts[0], y0 = e.pts[1];
          const x1 = e.pts[2], y1 = e.pts[3];
          const L = Math.hypot(x1 - x0, y1 - y0) || 1;
          const nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
          const signed = (w[0] - (x0 + x1) / 2) * nx + (w[1] - (y0 + y1) / 2) * ny;
          const raw = d.startBend + ((signed - d.startSigned) * 2) / L;
          e.bend = Math.max(-1, Math.min(1, raw));
          e.bbox = entityBbox(e);
          store.emit();
        }
        markOverlayDirty();
        break;
      }
      case "rotate": {
        const e = store.doc?.entities.find((x) => x.id === d.id);
        if (e) {
          const b = entityBbox(e);
          const cx = (b[0] + b[2]) / 2;
          const cy = (b[1] + b[3]) / 2;
          const curAngle = Math.atan2(w[1] - cy, w[0] - cx);
          let rad = d.startUserRot + (curAngle - d.startAngle);
          // SHIFT：吸附到 15° 增量
          if (ev.shiftKey) {
            const deg = (rad * 180) / Math.PI;
            rad = ((Math.round(deg / 15) * 15) * Math.PI) / 180;
          }
          store.rotateLive(d.id, rad);
        }
        markOverlayDirty();
        break;
      }
      case "marquee":
        d.curW = w;
        markOverlayDirty();
        break;
      case "line":
      case "arrow": {
        const snap = findSnap(w);
        if (snap) {
          d.curW = snap;
          snapRef.current = snap;
        } else {
          d.curW = applyConstraint(d.startW, w, d.kind, ev.shiftKey);
          snapRef.current = null;
        }
        markOverlayDirty();
        break;
      }
      case "measure":
        d.curW = applyConstraint(d.startW, w, "line", ev.shiftKey);
        markOverlayDirty();
        break;
      case "rect":
      case "roundrect":
      case "ellipse":
      case "star":
        d.curW = applyConstraint(d.startW, w, d.kind, ev.shiftKey);
        markOverlayDirty();
        break;
      case "lasso":
        d.pts.push(...w);
        d.curW = w;
        markOverlayDirty();
        break;
      case "eraser": {
        const hit = hitTest(w);
        if (hit) store.removeEntities([hit]);
        break;
      }
      case "polyline":
        d.curW = w;
        markOverlayDirty();
        break;
      case "polygon":
        d.curW = w;
        markOverlayDirty();
        break;
      case "arc":
        d.curW = w;
        markOverlayDirty();
        break;
    }
  }

  function onPointerUp(ev: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    // 立即清空拖動狀態：即使下方 switch 任何一步（ensureDrawLayer/addEntity/…）拋例外，
    // ghost 也不會殘留而「黏在滑鼠上」。各 case 末尾的 dragRef.current=null 因此成為冗餘（保留無害）。
    dragRef.current = null;
    const rect = baseRef.current!.getBoundingClientRect();
    const w = screenToWorld(viewRef.current, ev.clientX - rect.left, ev.clientY - rect.top);

    switch (d.kind) {
      case "move": {
        if (d.moved) {
          const dx = w[0] - d.startW[0];
          const dy = w[1] - d.startW[1];
          store.commitMove(d.ids, dx, dy);
        } else if (d.ids.length === 1) {
          // 點擊未拖動 → 維持選取（若 shift 則取消）
        }
        dragRef.current = null;
        break;
      }
      case "vertex": {
        const e = store.doc?.entities.find((x) => x.id === d.id);
        if (e) {
          // 頂點位置已在 pointermove 放好（含 SHIFT 約束），此處只記錄 undo，
          // 不用 pointerup 座標覆寫——否則「先鬆 Shift 再鬆滑鼠」會跳回未約束位置
          e.bbox = entityBbox(e);
          store.commitGeometry(d.id, d.beforePts, e.pts.slice());
        }
        dragRef.current = null;
        break;
      }
      case "stretch": {
        const e = store.doc?.entities.find((x) => x.id === d.id);
        if (e) {
          e.bbox = entityBbox(e);
          store.commitGeometry(d.id, d.beforePts, e.pts.slice());
        }
        dragRef.current = null;
        break;
      }
      case "bend": {
        // 控制點已在 pointermove 放好，此處只記錄 undo（kind+pts 完整快照）
        const e = store.doc?.entities.find((x) => x.id === d.id);
        if (e) store.commitBend(d.id, d.beforeKind, d.beforePts, e.pts.slice());
        dragRef.current = null;
        break;
      }
      case "arrowBend": {
        // bend 已在 pointermove 設好，此處記錄 undo
        store.commitArrowBend(d.id, d.beforeBend);
        dragRef.current = null;
        break;
      }
      case "rotate": {
        // 角度已在 pointermove 設好，此處記錄 undo
        store.commitRotate(d.id, d.startUserRot);
        dragRef.current = null;
        break;
      }
      case "marquee": {
        const x0 = Math.min(d.startW[0], w[0]);
        const x1 = Math.max(d.startW[0], w[0]);
        const y0 = Math.min(d.startW[1], w[1]);
        const y1 = Math.max(d.startW[1], w[1]);
        const hits = store.getIndex().queryBBox([x0, y0, x1, y1]);
        const ids = hits
          .filter((e) => {
            const l = store.doc?.layers.find((x) => x.id === e.layerId);
            return l && l.visible && !l.locked;
          })
          .map((e) => e.id);
        // 框選到的群組成員 → 擴展為整組
        store.setSelection(store.expandGroups(ids));
        dragRef.current = null;
        break;
      }
      case "line":
      case "arrow":
      case "measure": {
        // 使用拖動過程中的 curW（已含 SHIFT 約束/端點吸附），避免「先鬆 Shift 再鬆滑鼠」時跳變
        const ex = d.curW[0];
        const ey = d.curW[1];
        if (Math.hypot(ex - d.startW[0], ey - d.startW[1]) > 1) {
          const e: VecEntity = {
            id: genId(),
            kind: d.kind === "measure" ? "line" : d.kind,
            pts: [...d.startW, ex, ey],
            stroke: styleRef.current.stroke,
            width: styleRef.current.width,
            dash: styleRef.current.dash || undefined,
            origin: "user",
            layerId: store.ensureDrawLayer(styleRef.current.stroke, d.kind === "measure" ? KIND_LABEL.line : KIND_LABEL[d.kind] ?? "標註"),
          };
          store.addEntity(e);
          store.setSelection([e.id]);
          // 直線錨點銜接：端點與既有線段/折線端點重合時自動合併為一條折線
          if (d.kind === "line") store.mergeLineIntoExisting(e.id);
          onToolChange?.("select");
        }
        snapRef.current = null;
        dragRef.current = null;
        break;
      }
      case "rect":
      case "roundrect": {
        const bx = d.curW[0];
        const by = d.curW[1];
        const w0 = Math.min(d.startW[0], bx);
        const h0 = Math.min(d.startW[1], by);
        const w1 = Math.max(d.startW[0], bx);
        const h1 = Math.max(d.startW[1], by);
        if (w1 - w0 > 1 && h1 - h0 > 1) {
          const e: VecEntity = {
            id: genId(),
            kind: "rect",
            pts: [w0, h0, w1, h0, w1, h1, w0, h1],
            closed: true,
            radius: d.kind === "roundrect" ? 12 : undefined,
            stroke: styleRef.current.stroke,
            width: styleRef.current.width,
            dash: styleRef.current.dash || undefined,
            fill: styleRef.current.fill || undefined,
            origin: "user",
            layerId: store.ensureDrawLayer(styleRef.current.stroke, d.kind === "roundrect" ? KIND_LABEL.roundrect : KIND_LABEL.rect),
          };
          store.addEntity(e);
          store.setSelection([e.id]);
          onToolChange?.("select");
        }
        dragRef.current = null;
        break;
      }
      case "ellipse":
      case "star": {
        const bx = d.curW[0];
        const by = d.curW[1];
        if (Math.hypot(bx - d.startW[0], by - d.startW[1]) > 1) {
          const e: VecEntity = {
            id: genId(),
            kind: d.kind,
            pts: [...d.startW, bx, by],
            stroke: styleRef.current.stroke,
            width: styleRef.current.width,
            dash: styleRef.current.dash || undefined,
            fill: styleRef.current.fill || undefined,
            origin: "user",
            layerId: store.ensureDrawLayer(styleRef.current.stroke, KIND_LABEL[d.kind] ?? "標註"),
          };
          store.addEntity(e);
          store.setSelection([e.id]);
          onToolChange?.("select");
        }
        dragRef.current = null;
        break;
      }
      case "lasso": {
        const pts = d.pts;
        if (pts.length >= 6) {
          // 計算套索軌跡的 bbox
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (let i = 0; i < pts.length; i += 2) {
            minX = Math.min(minX, pts[i]);
            minY = Math.min(minY, pts[i + 1]);
            maxX = Math.max(maxX, pts[i]);
            maxY = Math.max(maxY, pts[i + 1]);
          }
          const hits = store.getIndex().queryBBox([minX, minY, maxX, maxY]);
          const ids = hits
            .filter((e) => {
              const l = store.doc?.layers.find((x) => x.id === e.layerId);
              if (!l || !l.visible || l.locked) return false;
              const bb = e.bbox || entityBbox(e);
              return pointInPolygon((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, pts);
            })
            .map((e) => e.id);
          store.setSelection(store.expandGroups(ids));
        }
        dragRef.current = null;
        break;
      }
      case "eraser":
        dragRef.current = null;
        break;
      case "polyline":
      case "polygon":
      case "arc":
        // 由 pointerdown 或 dblclick 處理完成
        break;
    }
    markOverlayDirty();
  }

  /** 完成多邊形：至少 3 個頂點才建立封閉折線 */
  function finishPolygon(pts: number[]) {
    if (pts.length >= 6) {
      const e: VecEntity = {
        id: genId(),
        kind: "polyline",
        pts,
        closed: true,
        stroke: styleRef.current.stroke,
        width: styleRef.current.width,
        dash: styleRef.current.dash || undefined,
        fill: styleRef.current.fill || undefined,
        origin: "user",
        layerId: store.ensureDrawLayer(styleRef.current.stroke, KIND_LABEL.polygon),
      };
      store.addEntity(e);
      store.setSelection([e.id]);
      onToolChange?.("select");
    }
    dragRef.current = null;
    markOverlayDirty();
  }

  /** 完成折線：至少 2 個頂點建立開放折線 */
  function finishPolyline(pts: number[]) {
    if (pts.length >= 4) {
      const e: VecEntity = {
        id: genId(),
        kind: "polyline",
        pts,
        stroke: styleRef.current.stroke,
        width: styleRef.current.width,
        dash: styleRef.current.dash || undefined,
        origin: "user",
        layerId: store.ensureDrawLayer(styleRef.current.stroke, KIND_LABEL.polyline),
      };
      store.addEntity(e);
      store.setSelection([e.id]);
      onToolChange?.("select");
    }
    dragRef.current = null;
    markOverlayDirty();
  }

  function onDoubleClick(ev: React.MouseEvent) {
    const d = dragRef.current;
    // 錨點工具：雙擊已有錨點 → 刪除該錨點
    if (toolRef.current === "anchor") {
      const w = toWorld(ev);
      const hit = hitAnyVertex(w);
      if (hit) {
        store.removeVertex(hit.id, hit.vi);
        dragRef.current = null;
        markOverlayDirty();
        markBaseDirty();
      }
      return;
    }
    if (d && d.kind === "polyline" && d.pts.length >= 4) {
      // 雙擊的第二擊已在 pointerdown 多加一個重複點，先移除
      d.pts.splice(d.pts.length - 2, 2);
      finishPolyline(d.pts);
      return;
    }
    if (d && d.kind === "polygon") {
      // 雙擊的第二擊已在 pointerdown 多加一個重複點，先移除
      if (d.pts.length >= 2) d.pts.splice(d.pts.length - 2, 2);
      finishPolygon(d.pts);
      return;
    }
    if (toolRef.current === "select") {
      const w = toWorld(ev);
      const hit = hitTest(w);
      if (hit) {
        const e = store.doc?.entities.find((x) => x.id === hit);
        if (e?.kind === "text") {
          const rect = baseRef.current!.getBoundingClientRect();
          const [sx, sy] = [ev.clientX - rect.left, ev.clientY - rect.top];
          setTextInput({ x: e.pts[0], y: e.pts[1], editId: e.id, value: e.text ?? "", sx, sy, fontSize: e.fontSize, fontFamily: e.fontFamily, bgColor: e.bgColor, stroke: e.stroke, borderColor: e.borderColor, borderWidth: e.borderWidth, vertical: e.vertical });
        }
      }
    }
  }

  // 鍵盤快捷鍵（window 級）
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      // 方向鍵：移動選取物件（Shift 加速為 10 倍），每步 1 螢幕像素以維持各縮放層級下視覺一致
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "ArrowUp" || ev.key === "ArrowDown") {
        if (store.selection.size === 0) return;
        const ids = [...store.selection];
        const step = (ev.shiftKey ? 10 : 1) / viewRef.current.scale;
        let dx = 0;
        let dy = 0;
        if (ev.key === "ArrowLeft") dx = -step;
        else if (ev.key === "ArrowRight") dx = step;
        else if (ev.key === "ArrowUp") dy = -step;
        else if (ev.key === "ArrowDown") dy = step;
        store.moveLive(ids, dx, dy);
        store.commitMove(ids, dx, dy);
        ev.preventDefault();
        return;
      }
      if (ev.key === "Delete" || ev.key === "Backspace") {
        store.removeEntities([...store.selection]);
        ev.preventDefault();
      } else if (ev.key === "Escape") {
        if (dragRef.current?.kind === "polyline") dragRef.current = null;
        if (dragRef.current?.kind === "polygon") dragRef.current = null;
        if (dragRef.current?.kind === "arc") dragRef.current = null;
        store.clearSelection();
        markOverlayDirty();
      } else if (ev.key === "Enter") {
        // Enter 完成正在繪製的多邊形/折線
        const d = dragRef.current;
        if (d && d.kind === "polygon" && d.pts.length >= 6) {
          finishPolygon(d.pts);
          ev.preventDefault();
        } else if (d && d.kind === "polyline" && d.pts.length >= 4) {
          finishPolyline(d.pts);
          ev.preventDefault();
        }
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        store.selectAll();
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "d") {
        ev.preventDefault();
        store.clearSelection();
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key === "z") {
        ev.preventDefault();
        if (ev.shiftKey) store.redo();
        else store.undo();
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "g") {
        ev.preventDefault();
        const ids = [...store.selection];
        if (ev.shiftKey) store.ungroup(ids);
        else store.makeGroup(ids);
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key === "y") {
        ev.preventDefault();
        store.redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, markOverlayDirty]);

  function onWheel(ev: React.WheelEvent) {
    const rect = baseRef.current!.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(sx, sy, factor);
  }

  function commitText() {
    if (!textInput) return;
    const text = textInput.value;
    if (text.trim() && textInput.editId) {
      store.editText(textInput.editId, text);
    } else if (text.trim()) {
      const e: VecEntity = {
        id: genId(),
        kind: "text",
        pts: [textInput.x, textInput.y],
        stroke: styleRef.current.stroke,
        width: 1,
        origin: "user",
        layerId: store.ensureDrawLayer(styleRef.current.stroke, KIND_LABEL.text),
        text,
        fontSize: styleRef.current.fontSize,
      };
      store.addEntity(e);
    }
    setTextInput(null);
  }

  /** 圖片選擇完成後：讀取 dataURL，依點擊位置中心插入圖片實體 */
  function handleImagePicked(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    const pos = imageInsertRef.current;
    if (!pos) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => {
        const targetW = 200; // 預設寬度（pt），高依比例
        const ratio = img.naturalHeight / img.naturalWidth || 1;
        const w = targetW;
        const h = targetW * ratio;
        const e: VecEntity = {
          id: genId(),
          kind: "image",
          pts: [pos[0] - w / 2, pos[1] - h / 2],
          stroke: "#000000",
          width: 1,
          origin: "user",
          layerId: store.ensureDrawLayer("#000000", KIND_LABEL.image),
          imageData: dataUrl,
          w,
          h,
        };
        store.addEntity(e);
        store.setSelection([e.id]);
        onToolChange?.("select");
        imageInsertRef.current = null;
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full overflow-hidden bg-white"
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={baseRef} className="absolute inset-0" />
      <canvas
        ref={overlayRef}
        className="absolute inset-0"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          crosshairRef.current = null;
          markOverlayDirty();
        }}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        style={{ touchAction: "none", cursor: cursorFor(tool) }}
      />
      {textInput &&
        (() => {
          const fspt = textInput.fontSize ?? style.fontSize;
          const fs = Math.max(12, fspt * viewRef.current.scale);
          const editing = !!textInput.editId;
          const vertical = !!textInput.vertical;
          // 寬度自適應內容（量測最長行），避免固定大框遮蓋畫面；直書時改量高度
          const lines = (textInput.value || "國").split("\n");
          const chars = [...(textInput.value || "國")];
          const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
          const w = vertical
            ? fs + 14
            : Math.max(56, Math.ceil(measureTextWidth(longest, fs, textInput.fontFamily)) + 18);
          const h = vertical
            ? Math.max(fs * 1.4, chars.length * fs * TEXT_LINE_HEIGHT + 6)
            : Math.max(fs * TEXT_LINE_HEIGHT + 8, lines.length * fs * TEXT_LINE_HEIGHT + 8);
          return (
            <textarea
              autoFocus
              value={textInput.value}
              onChange={(e) => setTextInput({ ...textInput, value: e.target.value })}
              onKeyDown={(e) => {
                // Enter = 確認提交；Shift+Enter = 換行（不攔截，textarea 預設插入換行）
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitText();
                }
                if (e.key === "Escape") setTextInput(null);
                e.stopPropagation();
              }}
              onBlur={commitText}
              onPointerDown={(e) => e.stopPropagation()}
              spellCheck={false}
              rows={vertical ? Math.max(1, chars.length) : Math.max(1, lines.length)}
              style={{
                position: "absolute",
                left: textInput.sx,
                // 水平書 baseline 在 sy；直書基準點在頂端
                top: vertical ? textInput.sy - 2 : textInput.sy - fs * 0.8 - 2,
                width: w,
                height: h,
                padding: "1px 4px",
                border: editing && textInput.borderColor ? `${Math.max(1, textInput.borderWidth ?? 1)}px solid ${textInput.borderColor}` : "1px dashed #623bfc",
                borderRadius: 3,
                fontSize: fs,
                fontFamily: fontStack(textInput.fontFamily),
                lineHeight: TEXT_LINE_HEIGHT,
                whiteSpace: "pre",
                writingMode: vertical ? "vertical-rl" : "horizontal-tb",
                resize: "none",
                overflow: "hidden",
                background: editing && textInput.bgColor ? textInput.bgColor : "rgba(255,255,255,0.92)",
                outline: "none",
                boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
                color: editing && textInput.stroke ? textInput.stroke : "#111",
                zIndex: 20,
              }}
            />
          );
        })()}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImagePicked}
      />
    </div>
  );
}

function cursorFor(tool: ToolId): string {
  switch (tool) {
    case "select":
    case "anchor":
      return "default";
    case "hand":
      return "grab";
    case "zoom":
      return "zoom-in";
    case "line":
    case "polyline":
    case "polygon":
    case "arc":
    case "arrow":
    case "measure":
    case "rect":
    case "roundrect":
    case "ellipse":
    case "star":
    case "eyedropper":
    case "eraser":
    case "lasso":
    case "magic":
      return "crosshair";
    case "fill":
      return "pointer";
    case "text":
      return "text";
    case "image":
      return "crosshair";
    default:
      return "default";
  }
}
