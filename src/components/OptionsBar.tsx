import type { ToolId } from "../types";
import type { DrawStyle } from "./Toolbar";

interface Props {
  tool: ToolId;
  style: DrawStyle;
  onStyleChange: (patch: Partial<DrawStyle>) => void;
  metersPerPt?: number;
  onClearScale?: () => void;
}

const COLORS = ["#000000", "#e53935", "#1e88e5", "#43a047", "#ffb300", "#8e24aa", "#00acc1", "#6d4c41", "#f06292", "#78909c"];
const WIDTHS = [1, 2, 3, 4, 6, 8];
const DASHES = [
  { label: "實線", v: "" },
  { label: "虛線", v: "6,4" },
  { label: "點線", v: "2,3" },
  { label: "點劃", v: "8,3,2,3" },
];

/** 繪圖工具（會畫出新圖元的工具） */
const DRAW_TOOLS: ToolId[] = ["rect", "roundrect", "ellipse", "line", "polygon", "star", "arrow", "polyline", "arc"];

export default function OptionsBar({ tool, style, onStyleChange, metersPerPt, onClearScale }: Props) {
  // 選取類工具：顯示群組提示
  if (tool === "select" || tool === "anchor") {
    return (
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-xs text-neutral-500">
        <span className="text-neutral-400">選取</span>
        <span>點選圖元 · 拖曳移動 · 框選多選</span>
        <span className="text-neutral-300 dark:text-neutral-700">|</span>
        <span>Ctrl+G 群組 · Ctrl+Shift+G 解散</span>
        {tool === "select" && <span className="text-emerald-500">（矩形：拖邊中點調整寬高）</span>}
        {tool === "anchor" && <span className="text-primary-500">（錨點：點中點插錨點 · 雙擊錨點刪除）</span>}
      </div>
    );
  }

  // 文字工具：字號
  if (tool === "text") {
    return (
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-xs overflow-x-auto whitespace-nowrap">
        <span className="text-neutral-400">文字</span>
        <ColorField label="顏色" value={style.stroke} onChange={(c) => onStyleChange({ stroke: c })} />
        <div className="flex items-center gap-2">
          <span className="text-neutral-400">字號</span>
          <input
            type="range"
            min={0.5}
            max={72}
            step={0.5}
            value={style.fontSize}
            onChange={(e) => onStyleChange({ fontSize: parseFloat(e.target.value) })}
            className="w-28"
          />
          <span className="text-neutral-600 dark:text-neutral-300 w-8">{style.fontSize}pt</span>
        </div>
      </div>
    );
  }

  // 填色工具：填充色
  if (tool === "fill") {
    return (
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-xs overflow-x-auto whitespace-nowrap">
        <span className="text-neutral-400">上色</span>
        <FillField label="填色" value={style.fill} onChange={(c) => onStyleChange({ fill: c })} />
        <span className="text-neutral-400">點擊封閉圖形內部填色</span>
      </div>
    );
  }

  // 測量工具（距離標註）
  if (tool === "measure") {
    return (
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-xs text-neutral-500 overflow-x-auto whitespace-nowrap">
        <span className="text-neutral-400 shrink-0">距離標註</span>
        <span>拖曳畫出距離線（Shift 吸附 45°），標註公尺數</span>
        <div className="flex items-center gap-1.5">
          <span className="text-neutral-400">字號</span>
          <input
            type="range"
            min={8}
            max={48}
            step={1}
            value={style.fontSize}
            onChange={(e) => onStyleChange({ fontSize: parseFloat(e.target.value) })}
            className="w-24"
          />
          <span className="text-neutral-600 dark:text-neutral-300 w-8">{style.fontSize}pt</span>
        </div>
        {metersPerPt ? (
          <>
            <span className="text-emerald-600 dark:text-emerald-400 shrink-0">✓ 已校準比例</span>
            <button
              onClick={onClearScale}
              className="px-2 py-0.5 rounded border border-neutral-300 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
              title="清除比例，下次畫線重新校準"
            >
              清除
            </button>
          </>
        ) : (
          <span className="text-amber-600 dark:text-amber-400 shrink-0">未校準：畫線後輸入實際公尺數</span>
        )}
      </div>
    );
  }

  // 套索 / 魔棒（選區工具）
  if (tool === "lasso" || tool === "magic") {
    return (
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-xs text-neutral-500 overflow-x-auto whitespace-nowrap">
        <span className="text-neutral-400 shrink-0">{tool === "lasso" ? "套索" : "魔棒"}</span>
        {tool === "lasso" ? (
          <span>按住拖曳畫出不規則選區，鬆手選取包圍的圖元（Shift 加選）</span>
        ) : (
          <span>點擊圖元，選取同顏色同圖層的所有圖元</span>
        )}
      </div>
    );
  }

  // 吸管
  if (tool === "eyedropper") {
    return (
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-xs text-neutral-500 overflow-x-auto whitespace-nowrap">
        <span className="text-neutral-400 shrink-0">吸管</span>
        <span>點擊圖元吸取顏色為前景色（Alt 吸取填充色）</span>
      </div>
    );
  }

  // 橡皮擦
  if (tool === "eraser") {
    return (
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-xs text-neutral-500 overflow-x-auto whitespace-nowrap">
        <span className="text-neutral-400 shrink-0">橡皮擦</span>
        <span>點擊或拖過圖元即擦除（可 Ctrl+Z 復原）</span>
      </div>
    );
  }

  // 抓手
  if (tool === "hand") {
    return (
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-xs text-neutral-500 overflow-x-auto whitespace-nowrap">
        <span className="text-neutral-400 shrink-0">抓手</span>
        <span>按住拖曳平移畫布（亦可按住空白鍵平移）</span>
      </div>
    );
  }

  // 縮放
  if (tool === "zoom") {
    return (
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-xs text-neutral-500 overflow-x-auto whitespace-nowrap">
        <span className="text-neutral-400 shrink-0">縮放</span>
        <span>點擊放大（Alt 點擊縮小）</span>
      </div>
    );
  }

  // 繪圖工具（矩形/橢圓/直線/多邊形/星形/箭頭/折線/弧線）
  if (DRAW_TOOLS.includes(tool)) {
    const shapeName: Record<string, string> = {
      rect: "矩形", roundrect: "圓角矩形", ellipse: "橢圓", line: "直線", polygon: "多邊形", star: "星形", arrow: "箭頭", polyline: "折線", arc: "弧線",
    };
    return (
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 bg-white border-b border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-xs overflow-x-auto whitespace-nowrap">
        <span className="text-neutral-400">{shapeName[tool]}</span>
        <ColorField label="描邊" value={style.stroke} onChange={(c) => onStyleChange({ stroke: c })} />
        <FillField label="填充" value={style.fill} onChange={(c) => onStyleChange({ fill: c })} />
        <div className="flex items-center gap-1">
          <span className="text-neutral-400">線寬</span>
          {WIDTHS.map((w) => (
            <button
              key={w}
              onClick={() => onStyleChange({ width: w })}
              className={`w-7 h-6 rounded border text-[11px] leading-none ${
                style.width === w
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-neutral-400">線型</span>
          {DASHES.map((d) => (
            <button
              key={d.label}
              onClick={() => onStyleChange({ dash: d.v })}
              className={`px-2 h-6 rounded border text-[11px] leading-none ${
                style.dash === d.v
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-neutral-400">
          {tool === "polygon" || tool === "polyline"
            ? "點擊加頂點 · 雙擊或 Enter 完成 · Esc 取消"
            : tool === "arc"
            ? "點第一點→第二點→第三點定弧度"
            : "Shift 拖曳：約束正方形/45°"}
        </span>
      </div>
    );
  }

  return null;
}

/** 描邊色選項（含色板 + 自訂） */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-neutral-400">{label}</span>
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`w-[18px] h-[18px] rounded-full border ${
            value.toLowerCase() === c.toLowerCase() ? "ring-2 ring-primary-500 ring-offset-1" : "border-neutral-300 dark:border-neutral-600"
          }`}
          style={{ backgroundColor: c }}
        />
      ))}
      <label className="w-[18px] h-[18px] rounded-full border border-neutral-300 dark:border-neutral-600 cursor-pointer overflow-hidden relative">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
        <span className="absolute inset-0" style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" }} />
      </label>
    </div>
  );
}

/** 填充色選項（含無填充 + 斜線填充） */
function FillField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-neutral-400">{label}</span>
      <button
        onClick={() => onChange("")}
        title="無填充"
        className={`w-[18px] h-[18px] rounded border ${
          value === "" ? "ring-2 ring-primary-500 ring-offset-1" : "border-neutral-300 dark:border-neutral-600"
        }`}
        style={{ background: "repeating-linear-gradient(45deg,#e5e5e5,#e5e5e5 2px,transparent 2px,transparent 5px)" }}
      />
      <button
        onClick={() => onChange("hatch")}
        title="斜線填充（剖面線）"
        className={`w-[18px] h-[18px] rounded border ${
          value === "hatch" ? "ring-2 ring-primary-500 ring-offset-1" : "border-neutral-300 dark:border-neutral-600"
        }`}
        style={{ background: "repeating-linear-gradient(45deg,#888,#888 1px,#fff 1px,#fff 4px)" }}
      />
      <button
        onClick={() => onChange("grid")}
        title="網格填充（方格）"
        className={`w-[18px] h-[18px] rounded border ${
          value === "grid" ? "ring-2 ring-primary-500 ring-offset-1" : "border-neutral-300 dark:border-neutral-600"
        }`}
        style={{
          background:
            "linear-gradient(#888,#888) 0 0/100% 1px,linear-gradient(#888,#888) 0 0/1px 100%,#fff",
          backgroundRepeat: "repeat",
          backgroundSize: "4px 4px",
        }}
      />
      <button
        onClick={() => onChange("xgrid")}
        title="斜網格填充（菱形格）"
        className={`w-[18px] h-[18px] rounded border ${
          value === "xgrid" ? "ring-2 ring-primary-500 ring-offset-1" : "border-neutral-300 dark:border-neutral-600"
        }`}
        style={{
          background:
            "repeating-linear-gradient(45deg,#888,#888 1px,#fff 1px,#fff 4px),repeating-linear-gradient(-45deg,#888,#888 1px,#fff 1px,#fff 4px)",
        }}
      />
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`w-[18px] h-[18px] rounded-full border ${
            value.toLowerCase() === c.toLowerCase() ? "ring-2 ring-primary-500 ring-offset-1" : "border-neutral-300 dark:border-neutral-600"
          }`}
          style={{ backgroundColor: c }}
        />
      ))}
      <label className="w-[18px] h-[18px] rounded-full border border-neutral-300 dark:border-neutral-600 cursor-pointer overflow-hidden relative">
        <input
          type="color"
          value={value || "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
        <span className="absolute inset-0" style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" }} />
      </label>
    </div>
  );
}
