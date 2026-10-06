import { useCallback, useEffect, useRef, useState } from "react";
import { DocStore } from "./engine/document";
import CanvasView, { type CanvasApi } from "./components/CanvasView";
import Toolbar from "./components/Toolbar";
import OptionsBar from "./components/OptionsBar";
import LayerPanel from "./components/LayerPanel";
import PropertyPanel from "./components/PropertyPanel";
import HistoryPanel from "./components/HistoryPanel";
import { exportSVG, exportPNG, exportPDF, exportJSON, printDoc, downloadBlob, downloadText, contentBbox, renderDocToCanvas } from "./export/io";
import { saveProject, loadProject, normalizeProject } from "./engine/persistence";
import { arrowHeadGeom, arrowBendHandlePos, arrowRenderPoints, entityBbox } from "./engine/geometry";
import type { ToolId } from "./types";

interface WorkerMsg {
  type: "done" | "error";
  result?: { doc: any; stats: any };
  message?: string;
}

export default function App() {
  const storeRef = useRef<DocStore>(null as any);
  if (!storeRef.current) storeRef.current = new DocStore();
  const store = storeRef.current;
  // 暴露到 window 供測試/診斷
  (window as any).__planpad = store;
  (window as any).__planpad_geom = { arrowHeadGeom, arrowBendHandlePos, arrowRenderPoints, entityBbox };
  (window as any).__planpad_io = { exportSVG, contentBbox, exportPDF, exportPNG, renderDocToCanvas };

  const workerRef = useRef<Worker | null>(null);
  const apiRef = useRef<CanvasApi | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const [tick, setTick] = useState(0);
  const [tool, setTool] = useState<ToolId>("select");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [stats, setStats] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [style, setStyle] = useState({ stroke: "#e53935", width: 2, dash: "", fill: "", fontSize: 16 });
  const [panelTab, setPanelTab] = useState<"props" | "layers" | "history">("props");
  const [saveState, setSaveState] = useState<"idle" | "saved" | "error">("idle");
  const [showGrid, setShowGrid] = useState(true);
  const [showCrosshair, setShowCrosshair] = useState(true);
  const saveFlashRef = useRef<number | null>(null);

  // 訂閱 store 觸發重渲染
  useEffect(() => {
    return store.subscribe(() => setTick((v) => v + 1));
  }, [store]);

  // 選中物件（選取從空 → 非空）時，自動從「圖層」切回「屬性」頁，方便直接調整物件
  const lastSelRef = useRef(0);
  useEffect(() => {
    return store.subscribe(() => {
      const n = store.selection.size;
      if (n > 0 && lastSelRef.current === 0) {
        setPanelTab((t) => (t === "layers" ? "props" : t));
      }
      lastSelRef.current = n;
    });
  }, [store]);

  // 啟動時嘗試恢復上次自動保存的進度
  useEffect(() => {
    let cancelled = false;
    loadProject().then((doc) => {
      if (cancelled || !doc) return;
      store.loadDoc(doc);
      setLoaded(true);
      setStats("已回復上次自動儲存的進度");
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  // 自動保存（防抖 1.5s）：文件有異動（tick 變化）即排程儲存到瀏覽器
  useEffect(() => {
    if (!loaded || !store.doc) return;
    const timer = setTimeout(() => {
      saveProject(store.doc!).then((ok) => {
        if (ok) {
          setSaveState("saved");
        } else {
          setSaveState("error");
        }
        if (saveFlashRef.current) clearTimeout(saveFlashRef.current);
        saveFlashRef.current = window.setTimeout(() => setSaveState("idle"), 2000);
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [tick, loaded, store]);

  // 建立 worker
  useEffect(() => {
    const w = new Worker(new URL("./worker/pdfExtract.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent<WorkerMsg>) => {
      if (e.data.type === "done" && e.data.result) {
        store.loadDoc(e.data.result.doc);
        setLoading(false);
        setLoaded(true);
        setError("");
        const s = e.data.result.stats;
        setStats(`向量 ${s.kept.toLocaleString()} 筆（原始 ${s.rawEntities.toLocaleString()}），自動隱藏 ${s.fillLayers} 個填充圖層`);
      } else if (e.data.type === "error") {
        setLoading(false);
        setError("解析失敗：" + e.data.message);
      }
    };
    return () => w.terminate();
  }, [store]);

  // 工具快捷鍵（V/L/P/A/W/T）
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const map: Record<string, ToolId> = {
        v: "select",
        n: "anchor",
        l: "lasso",
        w: "magic",
        r: "rect",
        u: "ellipse",
        s: "star",
        p: "polyline",
        a: "arc",
        t: "text",
        o: "image",
        g: "fill",
        i: "eyedropper",
        e: "eraser",
        h: "hand",
        z: "zoom",
        m: "measure",
      };
      const k = ev.key.toLowerCase();
      if (map[k]) setTool(map[k]);
      else if (k === "x") setStyle((s) => ({ ...s, stroke: s.fill || "#000000", fill: s.stroke }));
      else if (k === "d") setStyle((s) => ({ ...s, stroke: "#000000", fill: "" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 供測試讀取目前工具
  useEffect(() => {
    (window as unknown as { __planpadTool: ToolId }).__planpadTool = tool;
  }, [tool]);

  async function handleFile(file: File) {
    const name = file.name.toLowerCase();
    // 專案檔（.planpad / .json）→ 直接匯入；其餘 → PDF 解析
    if (name.endsWith(".planpad") || name.endsWith(".json")) {
      try {
        const text = await file.text();
        const doc = normalizeProject(JSON.parse(text));
        if (!doc) {
          setError("無效的專案檔");
          return;
        }
        store.loadDoc(doc);
        setLoaded(true);
        setError("");
        setStats(`已載入專案（${doc.entities.length.toLocaleString()} 個圖元）`);
      } catch (err) {
        setError("專案檔讀取失敗：" + (err as Error).message);
      }
      return;
    }
    setLoading(true);
    setError("");
    const buf = await file.arrayBuffer();
    workerRef.current?.postMessage({ data: buf });
  }

  function doSaveProject() {
    if (!store.doc) return;
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    downloadText(exportJSON(store), `beinan-plan-${stamp}.planpad`, "application/json");
  }

  async function doPrint() {
    if (!store.doc) return;
    try {
      await printDoc(store);
    } catch (err) {
      setError("列印失敗");
    }
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }, []);

  async function doExport(type: "svg" | "png" | "pdf" | "json") {
    if (!store.doc) return;
    if (type === "svg") {
      downloadText(exportSVG(store), "beinan-plan.svg", "image/svg+xml");
    } else if (type === "json") {
      downloadText(exportJSON(store), "beinan-plan.json", "application/json");
    } else if (type === "pdf") {
      try {
        const blob = await exportPDF(store);
        downloadBlob(blob, "beinan-plan.pdf");
      } catch (err) {
        setError("PDF 匯出失敗");
      }
    } else {
      try {
        const blob = await exportPNG(store);
        downloadBlob(blob, "beinan-plan.png");
      } catch (err) {
        setError("PNG 匯出失敗");
      }
    }
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-neutral-100 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      {/* 頂部列 */}
      <header className="relative h-12 shrink-0 flex items-center gap-2.5 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800">
        {/* 品牌識別：LOGO + 標題 */}
        <div className="flex items-center gap-2 pr-2.5 border-r border-neutral-200 dark:border-neutral-700 shrink-0">
          <span className="inline-flex items-center rounded-md bg-white px-1.5 py-1 shadow-sm ring-1 ring-neutral-200/60 dark:ring-white/10">
            <img src={import.meta.env.BASE_URL + "logo.png"} alt="北農" className="h-6 w-auto" />
          </span>
          <div className="leading-none hidden sm:block">
            <div className="font-bold text-[15px] tracking-tight text-brand-ink dark:text-neutral-100">
              北農平面圖編輯器
            </div>
            <div className="text-[9px] tracking-[0.18em] text-neutral-400 mt-0.5">BEINONG MARKET</div>
          </div>
        </div>

        <div className="flex-1" />

        {stats && <span className="text-xs text-neutral-500 hidden xl:block whitespace-nowrap max-w-[300px] truncate" title={stats}>{stats}</span>}

        {saveState === "saved" && <span className="text-xs text-emerald-600 dark:text-emerald-400">已自動儲存 ✓</span>}
        {saveState === "error" && <span className="text-xs text-red-500">儲存失敗</span>}

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => projectInputRef.current?.click()}
            className="px-2.5 py-1.5 rounded-md border border-neutral-300 text-sm whitespace-nowrap hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            title="匯入 .planpad 專案檔"
          >
            開啟專案
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-2.5 py-1.5 rounded-md bg-primary-600 text-white text-sm whitespace-nowrap shadow-sm hover:bg-primary-700 active:bg-primary-800"
            title="上傳 PDF 平面圖開始編輯"
          >
            上傳 PDF
          </button>
        </div>

        <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />

        <div className="flex items-center gap-1">
          <button onClick={() => apiRef.current?.zoomOut()} className="px-2 py-1 rounded border text-sm" title="縮小">
            −
          </button>
          <button onClick={() => apiRef.current?.fit()} className="px-2 py-1 rounded border text-sm" title="縮放至適合">
            適應
          </button>
          <button onClick={() => apiRef.current?.zoomIn()} className="px-2 py-1 rounded border text-sm" title="放大">
            +
          </button>
          <button
            onClick={() => setShowGrid((v) => !v)}
            className={`px-2 py-1 rounded border text-sm ${
              showGrid
                ? "border-primary-500 text-primary-600 bg-primary-50 dark:bg-primary-900/30"
                : "border-neutral-300 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            }`}
            title="切換網格背景"
          >
            ▦ 網格
          </button>
          <button
            onClick={() => setShowCrosshair((v) => !v)}
            className={`px-2 py-1 rounded border text-sm ${
              showCrosshair
                ? "border-primary-500 text-primary-600 bg-primary-50 dark:bg-primary-900/30"
                : "border-neutral-300 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            }`}
            title="切換 XY 十字準星"
          >
            ✛ 準星
          </button>
        </div>

        <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => store.selectAll()}
            className="px-2.5 py-1.5 rounded-md border border-neutral-300 text-sm whitespace-nowrap hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            title="全選所有可見圖元（Ctrl+A）"
          >
            全選
          </button>

          <button
            onClick={doSaveProject}
            className="px-2.5 py-1.5 rounded-md border border-neutral-300 text-sm whitespace-nowrap hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            title="下載 .planpad 專案檔（自動保存已同步至瀏覽器）"
          >
            儲存
          </button>

          <button
            onClick={doPrint}
            className="px-2.5 py-1.5 rounded-md border border-neutral-300 text-sm whitespace-nowrap hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            title="列印目前平面圖"
          >
            列印
          </button>

          <div className="relative group">
            <button className="px-2.5 py-1.5 rounded-md border border-neutral-300 text-sm whitespace-nowrap hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800">
              匯出 ▾
            </button>
            <div className="hidden group-hover:block absolute right-0 top-full mt-1 w-28 bg-white border border-neutral-200 rounded-md shadow-lg z-30 dark:bg-neutral-900 dark:border-neutral-700">
              {(["svg", "png", "pdf", "json"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => doExport(t)}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 品牌漸層飾條（LOGO 三色：橘→洋紅→藍紫） */}
        <div className="absolute inset-x-0 bottom-0 h-[2.5px] bg-gradient-to-r from-brand-orange via-brand-pink to-brand-blue" />

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf,image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />
        <input
          ref={projectInputRef}
          type="file"
          accept=".planpad,.json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />
      </header>

      {/* 主體 */}
      <div className="flex-1 flex overflow-hidden">
        <Toolbar
          tool={tool}
          onTool={setTool}
          style={style}
          onStyleChange={(p) => setStyle((s) => ({ ...s, ...p }))}
          canUndo={store.canUndo}
          canRedo={store.canRedo}
          onUndo={() => store.undo()}
          onRedo={() => store.redo()}
        />

        <div className="flex-1 flex flex-col min-w-0">
          <OptionsBar tool={tool} style={style} onStyleChange={(p) => setStyle((s) => ({ ...s, ...p }))} />
          <div className="flex-1 relative" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
            <CanvasView store={store} tool={tool} style={style} apiRef={apiRef} onPickColor={(c) => setStyle((s) => ({ ...s, stroke: c }))} onToolChange={setTool} showGrid={showGrid} showCrosshair={showCrosshair} />

          {/* 空白/載入狀態 */}
          {!loaded && !loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-neutral-400 pointer-events-none">
              <span className="inline-flex items-center rounded-2xl bg-white px-6 py-4 shadow-xl ring-1 ring-neutral-200/60 dark:ring-white/10 mb-6">
                <img src={import.meta.env.BASE_URL + "logo.png"} alt="" className="h-16 w-auto" />
              </span>
              <div className="text-lg font-medium text-neutral-500">上傳 PDF 平面圖開始編輯</div>
              <div className="text-sm mt-1.5">支援拖放檔案至此，或點擊「上傳 PDF」</div>
              <div className="mt-5 flex items-center gap-2 text-[11px]">
                {["選取/移動", "繪圖標註", "圖層管理", "填充樣式", "測量列印"].map((f, i) => (
                  <span key={f} className="flex items-center gap-2">
                    {i > 0 && <span className="text-neutral-300">·</span>}
                    <span className="text-neutral-400">{f}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-neutral-950/70 z-10">
              <div className="flex flex-col items-center gap-2">
                <div className="w-8 h-8 border-2 border-primary-600 border-t-transparent rounded-full animate-spin" />
                <div className="text-sm text-neutral-500">解析向量中…</div>
              </div>
            </div>
          )}
          {error && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-red-600 text-white text-sm px-4 py-2 rounded-md shadow z-20">
              {error}
            </div>
          )}
          </div>
        </div>

        {/* 右側面板 */}
        <div className="flex flex-col bg-white border-l border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800">
          <div className="flex border-b border-neutral-200 dark:border-neutral-800">
            {(["props", "layers", "history"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setPanelTab(t)}
                className={`px-4 py-2 text-sm ${
                  panelTab === t
                    ? "text-primary-600 border-b-2 border-primary-600"
                    : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                }`}
              >
                {t === "props" ? "屬性" : t === "layers" ? "圖層" : "步驟"}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            {panelTab === "props" ? (
              <PropertyPanel store={store} style={style} onStyleChange={(p) => setStyle((s) => ({ ...s, ...p }))} onEditText={(e) => apiRef.current?.editText(e.id)} />
            ) : panelTab === "layers" ? (
              <LayerPanel store={store} />
            ) : (
              <HistoryPanel store={store} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
