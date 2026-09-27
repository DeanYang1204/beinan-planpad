import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ToolId } from "../types";

export interface DrawStyle {
  stroke: string;
  width: number;
  dash: string;
  fill: string;
  fontSize: number;
}

interface Props {
  tool: ToolId;
  onTool: (t: ToolId) => void;
  style: DrawStyle;
  onStyleChange: (patch: Partial<DrawStyle>) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

interface ToolDef {
  id: ToolId;
  label: string;
  icon: string; // ICONS key
  key: string;
}

interface SlotDef {
  id: string;
  tools: ToolDef[]; // [0] 為主工具
}

// ============ PS 風格工具槽（點右下角小三角或長按展開子工具） ============
const SLOTS: SlotDef[] = [
  {
    id: "move",
    tools: [
      { id: "select", label: "選取 / 移動", icon: "move", key: "V" },
      { id: "anchor", label: "直接選取（錨點）", icon: "direct", key: "N" },
    ],
  },
  {
    id: "lasso",
    tools: [
      { id: "lasso", label: "套索工具", icon: "lasso", key: "L" },
      { id: "magic", label: "魔棒工具", icon: "magic", key: "W" },
    ],
  },
  {
    id: "shape",
    tools: [
      { id: "rect", label: "矩形工具", icon: "rect", key: "R" },
      { id: "roundrect", label: "圓角矩形工具", icon: "roundrect", key: "" },
      { id: "ellipse", label: "橢圓工具", icon: "ellipse", key: "U" },
      { id: "line", label: "直線工具", icon: "line", key: "" },
      { id: "polygon", label: "多邊形工具", icon: "polygon", key: "" },
      { id: "star", label: "星形工具", icon: "star", key: "S" },
      { id: "arrow", label: "箭頭工具", icon: "arrow", key: "" },
    ],
  },
  {
    id: "pen",
    tools: [
      { id: "polyline", label: "折線工具", icon: "pen", key: "P" },
      { id: "arc", label: "弧線工具", icon: "arc", key: "A" },
    ],
  },
  {
    id: "text",
    tools: [{ id: "text", label: "文字工具", icon: "text", key: "T" }],
  },
  {
    id: "image",
    tools: [{ id: "image", label: "圖片工具（插入圖片）", icon: "image", key: "O" }],
  },
  {
    id: "fill",
    tools: [{ id: "fill", label: "上色 / 油漆桶", icon: "fill", key: "G" }],
  },
  {
    id: "eyedropper",
    tools: [{ id: "eyedropper", label: "吸管工具（吸取顏色）", icon: "eyedropper", key: "I" }],
  },
  {
    id: "eraser",
    tools: [{ id: "eraser", label: "橡皮擦工具（擦除圖元）", icon: "eraser", key: "E" }],
  },
  {
    id: "hand",
    tools: [
      { id: "hand", label: "抓手工具", icon: "hand", key: "H" },
      { id: "zoom", label: "縮放工具", icon: "zoom", key: "Z" },
    ],
  },
  {
    id: "measure",
    tools: [{ id: "measure", label: "測量工具", icon: "measure", key: "M" }],
  },
];

// ============ SVG 圖標（stroke 風格，近似 PS 乾淨感） ============
function Icon({ name }: { name: string }) {
  const p = (d: string, extra?: object) => (
    <path d={d} strokeLinecap="round" strokeLinejoin="round" {...extra} />
  );
  const shapes: Record<string, ReactNode> = {
    move: (
      <>
        {p("M8 2v12M2 8h12")}
        {p("M4.5 6L8 2l3.5 4M4.5 10L8 14l3.5-4", { fill: "none" })}
      </>
    ),
    direct: (
      <>
        {p("M8 14l3.2-8.2L3 9l2.6 1.3L8 14z", { fill: "currentColor", stroke: "none" })}
        {p("M14 2l-4 4")}
      </>
    ),
    rect: <rect x="3" y="4" width="10" height="8" rx="0.5" />,
    ellipse: <ellipse cx="8" cy="8" rx="5" ry="4" />,
    line: p("M3 13L13 3"),
    polygon: p("M8 2l5 3v6l-5 3-5-3V5z"),
    star: p("M8 2l1.7 3.5 3.9.6-2.8 2.7.7 3.9L8 10.9l-3.5 1.8.7-3.9-2.8-2.7 3.9-.6z"),
    arrow: (
      <>
        {p("M3 13L13 3")}
        {p("M13 3H7M13 3v6")}
      </>
    ),
    pen: p("M3 13.5l1.8-5.3 4 4-5.3 1.8zM5.5 9.5l2-2"),
    arc: p("M3 12a5 5 0 0 1 10 0"),
    fill: (
      <>
        {p("M4 3l7 7-1.5 1.5-7-7z")}
        {p("M11.5 10.5l1.5 1.5a1.06 1.06 0 1 1-1.5-1.5z", { fill: "currentColor", stroke: "none" })}
      </>
    ),
    text: (
      <>
        {p("M4 4h8")}
        {p("M8 4v8")}
      </>
    ),
    image: (
      <>
        <rect x="2.5" y="3" width="11" height="10" rx="1" />
        <circle cx="6" cy="6.5" r="1.2" />
        {p("M3.5 12l3-3 2 2 2-2 2.5 2.5")}
      </>
    ),
    measure: (
      <>
        {p("M2 14L14 2")}
        {p("M5 11l3-3M9 7l3-3")}
      </>
    ),
    roundrect: <rect x="3" y="4.5" width="10" height="7" rx="2.5" />,
    lasso: (
      <>
        {p("M5 3c3-2 7 0 8 3s-2 7 1 9 5-1 5-4")}
        {p("M3 6v3M3 12v2")}
      </>
    ),
    magic: (
      <>
        {p("M4.5 13L13 4.5l3 3-8.5 8.5z")}
        {p("M4 2.5v2.5M2.75 3.75h2.5")}
      </>
    ),
    eyedropper: (
      <>
        {p("M13.5 2.5l3 3L6.5 15.5 2 16l.5-4.5z")}
        {p("M14 4.5l1 1")}
      </>
    ),
    eraser: (
      <>
        {p("M8.5 19l-4-4a1.4 1.4 0 0 1 0-2L12 5.5a1.4 1.4 0 0 1 2 0l4.5 4.5a1.4 1.4 0 0 1 0 2L11 19.5")}
        {p("M4.5 19H18")}
        {p("M7 12.5l4 4")}
      </>
    ),
    hand: (
      <>
        {p("M7 4v7")}
        {p("M7 5a1.5 1.5 0 0 1 3 0v5")}
        {p("M10 5a1.5 1.5 0 0 1 3 0v4")}
        {p("M13 5a1.5 1.5 0 0 1 3 0v4.5A3.5 3.5 0 0 1 12.5 13H10a4 4 0 0 1-4-4V7")}
      </>
    ),
    zoom: (
      <>
        <circle cx="7" cy="7" r="4" />
        {p("M10.5 10.5L14 14")}
        {p("M7 5.5v3M5.5 7h3")}
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 16 16"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      style={{ display: "block" }}
    >
      {shapes[name] ?? shapes.rect}
    </svg>
  );
}

export default function Toolbar({
  tool,
  onTool,
  style,
  onStyleChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: Props) {
  const [openSlot, setOpenSlot] = useState<string | null>(null);
  const fgInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);
  const fillOpen = openSlot === "__fill";

  // 點擊外部關閉 flyout
  useEffect(() => {
    if (!openSlot) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-toolbar]")) setOpenSlot(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [openSlot]);

  // 該槽位目前啟用的工具（若 tool 屬於此槽位，顯示該工具圖標）
  function activeOf(slot: SlotDef): ToolDef {
    return slot.tools.find((t) => t.id === tool) ?? slot.tools[0];
  }

  function handleMainClick(slot: SlotDef) {
    const active = activeOf(slot);
    onTool(active.id);
    if (slot.tools.length > 1) {
      setOpenSlot((cur) => (cur === slot.id ? null : slot.id));
    }
  }

  const swapColors = () => {
    onStyleChange({ stroke: style.fill || "#000000", fill: style.stroke });
  };

  return (
    <div
      data-toolbar
      className="relative flex flex-col items-center gap-1 py-2 w-11 bg-white border-r border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 shrink-0"
    >
      {SLOTS.map((slot, i) => {
        const active = activeOf(slot);
        const isOpen = openSlot === slot.id;
        const hasChildren = slot.tools.length > 1;
        return (
          <div key={slot.id} className="relative">
            {i > 0 && <div className="w-7 h-px bg-neutral-200 dark:bg-neutral-700 mx-auto my-1" />}
            <button
              onClick={() => handleMainClick(slot)}
              title={`${active.label} (${active.key})`}
              className={`relative w-9 h-9 rounded flex items-center justify-center transition-colors ${
                slot.tools.some((t) => t.id === tool)
                  ? "bg-primary-600 text-white"
                  : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              }`}
            >
              <Icon name={active.icon} />
              {/* 右下角小三角：表示可展開子工具 */}
              {hasChildren && (
                <span className="absolute bottom-0 right-0 w-0 h-0 border-[4px] border-transparent border-r-black/60 dark:border-r-white/70 border-b-black/60 dark:border-b-white/70" style={{ transform: "translate(0,0)" }} />
              )}
            </button>

            {/* flyout 子工具 */}
            {isOpen && hasChildren && (
              <div className="absolute left-full top-0 ml-0.5 z-40 bg-white border border-neutral-200 rounded-md shadow-lg py-1 dark:bg-neutral-900 dark:border-neutral-700 min-w-[168px]">
                <div className="px-2.5 py-1 text-[10px] text-neutral-400 uppercase tracking-wide">{slot.id}</div>
                {slot.tools.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      onTool(t.id);
                      setOpenSlot(null);
                    }}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-left hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                      t.id === tool ? "text-primary-600 dark:text-primary-300" : "text-neutral-700 dark:text-neutral-200"
                    }`}
                  >
                    <span className="w-5 flex justify-center text-neutral-500 dark:text-neutral-400">
                      <Icon name={t.icon} />
                    </span>
                    <span className="flex-1">{t.label}</span>
                    <span className="text-[10px] text-neutral-400">{t.key}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* 復原 / 重做 */}
      <div className="w-7 h-px bg-neutral-200 dark:bg-neutral-700 my-1" />
      <button
        title="復原 (Ctrl+Z)"
        onClick={onUndo}
        disabled={!canUndo}
        className="w-9 h-8 rounded flex items-center justify-center text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5v4h4" />
          <path d="M3.5 9a5 5 0 1 1 1.5 3.5" />
        </svg>
      </button>
      <button
        title="重做 (Ctrl+Y)"
        onClick={onRedo}
        disabled={!canRedo}
        className="w-9 h-8 rounded flex items-center justify-center text-neutral-600 hover:bg-neutral-100 disabled:opacity-30 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 5v4H9" />
          <path d="M12.5 9a5 5 0 1 0-1.5 3.5" />
        </svg>
      </button>

      {/* 前景 / 背景雙色塊（PS 底部特徵） */}
      <div className="mt-auto flex flex-col items-center gap-1 pt-2">
        <div className="relative w-9 h-12">
          {/* 背景色（右下）：點擊彈出填充選項（無填充/斜線/網格/色板/自訂） */}
          <button
            onClick={() => setOpenSlot((cur) => (cur === "__fill" ? null : "__fill"))}
            title={`背景色（填充）${style.fill === "hatch" ? "：斜線填充" : style.fill === "grid" ? "：網格填充" : style.fill === "xgrid" ? "：斜網格填充" : style.fill ? "" : "（無填充）"} — 點擊更換`}
            className={`absolute right-0 bottom-0 w-6 h-6 rounded-sm border shadow-sm ${
              fillOpen ? "ring-2 ring-primary-500" : "border-neutral-400 dark:border-neutral-600"
            }`}
            style={{
              background:
                style.fill && style.fill !== "hatch" && style.fill !== "grid" && style.fill !== "xgrid" ? style.fill : undefined,
              backgroundImage:
                style.fill === "hatch"
                  ? "repeating-linear-gradient(45deg,#555,#555 1.5px,#fff 1.5px,#fff 4px)"
                  : style.fill === "grid"
                  ? "linear-gradient(#555,#555) 0 0/100% 1.5px,linear-gradient(#555,#555) 0 0/1.5px 100%,#fff"
                  : style.fill === "xgrid"
                  ? "repeating-linear-gradient(45deg,#555,#555 1px,#fff 1px,#fff 4px),repeating-linear-gradient(-45deg,#555,#555 1px,#fff 1px,#fff 4px)"
                  : style.fill
                  ? undefined
                  : "repeating-linear-gradient(45deg,#ddd,#ddd 2px,transparent 2px,transparent 5px)",
              backgroundRepeat: style.fill === "grid" ? "repeat" : undefined,
              backgroundSize: style.fill === "grid" ? "6px 6px" : undefined,
            }}
          />
          {/* 填充選項彈窗 */}
          {fillOpen && (
            <div className="absolute left-full bottom-0 ml-2 z-40 bg-white border border-neutral-200 rounded-md shadow-lg p-2.5 dark:bg-neutral-900 dark:border-neutral-700 w-[168px]">
              <div className="px-0.5 pb-1.5 text-[10px] text-neutral-400 uppercase tracking-wide">填充</div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => {
                    onStyleChange({ fill: "" });
                    setOpenSlot(null);
                  }}
                  title="無填充"
                  className={`w-6 h-6 rounded border ${
                    style.fill === "" ? "ring-2 ring-primary-500" : "border-neutral-300 dark:border-neutral-600"
                  }`}
                  style={{ background: "repeating-linear-gradient(45deg,#e5e5e5,#e5e5e5 2px,transparent 2px,transparent 5px)" }}
                />
                <button
                  onClick={() => {
                    onStyleChange({ fill: "hatch" });
                    setOpenSlot(null);
                  }}
                  title="斜線填充（剖面線）"
                  className={`w-6 h-6 rounded border ${
                    style.fill === "hatch" ? "ring-2 ring-primary-500" : "border-neutral-300 dark:border-neutral-600"
                  }`}
                  style={{ background: "repeating-linear-gradient(45deg,#888,#888 1px,#fff 1px,#fff 4px)" }}
                />
                <button
                  onClick={() => {
                    onStyleChange({ fill: "grid" });
                    setOpenSlot(null);
                  }}
                  title="網格填充（方格）"
                  className={`w-6 h-6 rounded border ${
                    style.fill === "grid" ? "ring-2 ring-primary-500" : "border-neutral-300 dark:border-neutral-600"
                  }`}
                  style={{
                    background:
                      "linear-gradient(#888,#888) 0 0/100% 1px,linear-gradient(#888,#888) 0 0/1px 100%,#fff",
                    backgroundRepeat: "repeat",
                    backgroundSize: "4px 4px",
                  }}
                />
                <button
                  onClick={() => {
                    onStyleChange({ fill: "xgrid" });
                    setOpenSlot(null);
                  }}
                  title="斜網格填充（菱形格）"
                  className={`w-6 h-6 rounded border ${
                    style.fill === "xgrid" ? "ring-2 ring-primary-500" : "border-neutral-300 dark:border-neutral-600"
                  }`}
                  style={{
                    background:
                      "repeating-linear-gradient(45deg,#888,#888 1px,#fff 1px,#fff 4px),repeating-linear-gradient(-45deg,#888,#888 1px,#fff 1px,#fff 4px)",
                  }}
                />
                {["#e53935", "#1e88e5", "#43a047", "#ffb300", "#8e24aa", "#00acc1", "#f06292", "#000000"].map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      onStyleChange({ fill: c });
                      setOpenSlot(null);
                    }}
                    title={c}
                    className={`w-6 h-6 rounded-full border ${
                      style.fill.toLowerCase() === c.toLowerCase()
                        ? "ring-2 ring-primary-500"
                        : "border-neutral-300 dark:border-neutral-600"
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <label
                  className="w-6 h-6 rounded-full border border-neutral-300 dark:border-neutral-600 cursor-pointer overflow-hidden relative"
                  title="自訂填充色"
                >
                  <input
                    ref={bgInputRef}
                    type="color"
                    value={style.fill && style.fill !== "hatch" && style.fill !== "grid" && style.fill !== "xgrid" ? style.fill : "#000000"}
                    onChange={(e) => onStyleChange({ fill: e.target.value })}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                  <span className="absolute inset-0" style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" }} />
                </label>
              </div>
            </div>
          )}
          {/* 前景色（左上） */}
          <button
            onClick={() => fgInputRef.current?.click()}
            title="前景色（描邊）— 點擊更換"
            className="absolute left-0 top-0 w-6 h-6 rounded-sm border border-neutral-400 dark:border-neutral-600 shadow-sm z-10"
            style={{ backgroundColor: style.stroke }}
          />
          {/* 交換 */}
          <button
            onClick={swapColors}
            title="交換前景/背景色 (X)"
            className="absolute right-0 top-0 w-4 h-4 rounded-full border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 flex items-center justify-center text-[9px] leading-none text-neutral-500"
          >
            ⇄
          </button>
        </div>
        <button
          onClick={() => onStyleChange({ stroke: "#000000", fill: "" })}
          title="重設預設色（前景黑 / 背景無填充）(D)"
          className="w-6 h-6 flex items-center justify-center text-[10px] text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          <span className="w-3.5 h-3.5 rounded-sm border border-neutral-400 dark:border-neutral-600 bg-black inline-block" />
          <span className="w-3.5 h-3.5 rounded-sm border border-neutral-400 dark:border-neutral-600 bg-white inline-block -ml-1" />
        </button>

        {/* 隱藏 color input（前景色） */}
        <input
          ref={fgInputRef}
          type="color"
          className="hidden"
          value={style.stroke}
          onChange={(e) => onStyleChange({ stroke: e.target.value })}
        />
      </div>
    </div>
  );
}
