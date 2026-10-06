// ============ PlanPad 資料模型 ============

export type Pt = [number, number];

export type ToolId =
  | "select"
  | "anchor"
  | "rect"
  | "roundrect"
  | "line"
  | "polyline"
  | "polygon"
  | "arc"
  | "arrow"
  | "ellipse"
  | "star"
  | "fill"
  | "text"
  | "image"
  | "measure"
  | "hand"
  | "zoom"
  | "eyedropper"
  | "eraser"
  | "lasso"
  | "magic";

export type EntityKind =
  | "line"
  | "polyline"
  | "rect"
  | "arc"
  | "arrow"
  | "ellipse"
  | "star"
  | "trapezoid"
  | "text"
  | "image";

/** 箭頭樣式：直線 / 彎曲（弧線）/ 直角（Z 形）/ 雙向（兩端箭頭） */
export type ArrowStyle = "straight" | "curved" | "elbow" | "both";

/** 可編輯圖元：PDF 提取的線/文字，或使用者繪製的標註，統一處理 */
export interface VecEntity {
  id: string;
  kind: EntityKind;
  /** 扁平座標 [x0,y0,x1,y1,...]：線=2 點、矩形=4 點(閉環)、弧線=3 點(起/控/終)、文字=1 點、橢圓/星型/梯形=2 點(外框對角) */
  pts: number[];
  closed?: boolean;
  stroke: string; // "#rrggbb"
  width: number; // 線寬 (pt)
  fill?: string;
  dash?: string; // "4,4" 虛線
  /** 箭頭頭部大小倍率（kind=arrow，預設 1 = 隨線寬的標準比例） */
  headScale?: number;
  /** 箭頭樣式（kind=arrow，預設 straight 直線） */
  arrowStyle?: ArrowStyle;
  /** 彎曲箭頭弧度倍率（arrowStyle=curved：控制點外推 = 線長×bend，預設 0.25，負值反向彎） */
  bend?: number;
  /** 無外邊框：填充圖案仍以 stroke 為線色，但不描外輪廓 */
  noStroke?: boolean;
  // 文字塊樣式
  /** 文字底色（"" = 無底色），如 "#ffffff" 白底黑字 */
  bgColor?: string;
  /** 文字底色不透明度 0–1（預設 1 = 完全不透明） */
  bgOpacity?: number;
  /** 字型 key（undefined = 系統預設），見 FONTS 對照表 */
  fontFamily?: string;
  /** 文字塊邊框色（"" = 無邊框） */
  borderColor?: string;
  /** 文字塊邊框寬（pt） */
  borderWidth?: number;
  origin: "pdf" | "user";
  layerId: string;
  /** 群組（組件）id：同組圖元整體選取/移動/刪除 */
  groupId?: string;
  /** 圓角矩形圓角半徑（kind=rect 時生效） */
  radius?: number;
  // 文字專用
  text?: string;
  fontSize?: number;
  rot?: number; // 弧度（PDF 文字傾斜，繞基準點）
  /** 使用者手動旋轉（PS 風格，繞物件中心），弧度 */
  userRot?: number;
  /** 直書（直立文字）：字元由上而下堆疊 */
  vertical?: boolean;
  // 圖片專用
  /** 圖片資料（dataURL 或 blob URL） */
  imageData?: string;
  /** 圖片世界尺寸（pt），pts 為左上角 */
  w?: number;
  h?: number;
  bbox?: [number, number, number, number]; // [minX,minY,maxX,maxY] 快取
}

export interface Layer {
  id: string;
  name: string;
  color: string;
  width: number;
  visible: boolean;
  locked: boolean;
  /** 自動判定為填充層（超短線密集），預設隱藏 */
  isFill: boolean;
  count: number;
  /** 所屬圖層組 id（PS 圖層群組/資料夾），無則未分組 */
  groupId?: string;
  /** 圖層不透明度 0–1（1 = 完全不透明，預設）；未設定視為 1 */
  opacity?: number;
}

/** 圖層組（PS 群組資料夾）：把多個圖層收納為一個可摺疊、整體顯隱的組 */
export interface LayerGroup {
  id: string;
  name: string;
}

export interface PlanDoc {
  pageW: number; // world pt
  pageH: number;
  layers: Layer[];
  /** 圖層組列表（可選，舊檔無此欄位） */
  layerGroups?: LayerGroup[];
  entities: VecEntity[];
}

export interface Viewport {
  scale: number; // screen px per world pt
  ox: number; // world 原點在 screen 的 x
  oy: number;
}

// ============ 工具函式 ============

let idCounter = 0;
export function genId(): string {
  idCounter++;
  return (
    "e" +
    Date.now().toString(36) +
    "-" +
    idCounter.toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 6)
  );
}

/** 文字塊可選字型（key → CSS font stack） */
export const FONTS: { key: string; label: string; stack: string }[] = [
  { key: "", label: "系統預設", stack: 'system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif' },
  { key: "jhenghei", label: "微軟正黑體", stack: '"Microsoft JhengHei", "微軟正黑體", "PingFang TC", sans-serif' },
  { key: "kai", label: "標楷體", stack: '"DFKai-SB", "標楷體", "BiauKai", "Kaiti TC", serif' },
  { key: "ming", label: "新細明體", stack: '"PMingLiU", "新細明體", "Times New Roman", serif' },
  { key: "serif", label: "襯線 Serif", stack: 'Georgia, "Times New Roman", "PMingLiU", serif' },
  { key: "monospace", label: "等寬 Monospace", stack: '"Courier New", "Cascadia Mono", monospace' },
  { key: "rounded", label: "圓體 Round", stack: '"Yuanti TC", "YuanQuan", "PingFang TC", sans-serif' },
];

export function fontStack(key?: string): string {
  return (FONTS.find((f) => f.key === key) ?? FONTS[0]).stack;
}

/** 文字寬度量測（離屏 canvas，與 renderer 同 font stack） */
let measureCtx: CanvasRenderingContext2D | null = null;
export function measureTextWidth(text: string, fontSize: number, fontFamily?: string): number {
  if (!measureCtx) {
    const c = document.createElement("canvas");
    measureCtx = c.getContext("2d");
  }
  if (!measureCtx) return text.length * fontSize;
  measureCtx.font = `${fontSize}px ${fontStack(fontFamily)}`;
  return measureCtx.measureText(text).width;
}

/** 直書時的標點直式替代字（Unicode Vertical Forms）：括號、引號、頓號等改為直立字形 */
const VERTICAL_FORMS: Record<string, string> = {
  "（": "\uFE35",
  "）": "\uFE36",
  "(": "\uFE35",
  ")": "\uFE36",
  "【": "\uFE3B",
  "】": "\uFE3C",
  "〔": "\uFE39",
  "〕": "\uFE3A",
  "｛": "\uFE37",
  "｝": "\uFE38",
  "{": "\uFE37",
  "}": "\uFE38",
  "《": "\uFE3D",
  "》": "\uFE3E",
  "〈": "\uFE3F",
  "〉": "\uFE40",
  "「": "\uFE41",
  "」": "\uFE42",
  "『": "\uFE43",
  "』": "\uFE44",
  "、": "\uFE11",
  "。": "\uFE12",
  "，": "\uFE10",
  "：": "\uFE13",
  "；": "\uFE14",
  "！": "\uFE15",
  "？": "\uFE16",
  "—": "\uFE31",
  "–": "\uFE32",
  "―": "\uFE31",
};

/** 將字串中的標點換為直式呈現形式（僅直書渲染用） */
export function toVerticalForms(text: string): string {
  let out = "";
  for (const c of text) out += VERTICAL_FORMS[c] ?? c;
  return out;
}

/** 文字行高係數（多行文字的行距 = 字號×此值；與編輯框 lineHeight 一致） */
export const TEXT_LINE_HEIGHT = 1.2;

/** 文字塊尺寸（w=寬, h=高）。
 *  橫書：w=最寬行寬、h=(行數-1)×字號×行高 + 字號（第一行高=字號，baseline 上方延伸）；
 *  直書：w=最寬字元、h=字數×字號。 */
export function measureTextBlock(
  text: string,
  fontSize: number,
  fontFamily?: string,
  vertical?: boolean
): { w: number; h: number } {
  const chars = vertical ? [...toVerticalForms(text)] : [...text];
  if (!vertical) {
    const lines = (text ?? "").split("\n");
    let maxW = 0;
    for (const ln of lines) {
      const w = measureTextWidth(ln, fontSize, fontFamily);
      if (w > maxW) maxW = w;
    }
    const n = Math.max(1, lines.length);
    const h = (n - 1) * fontSize * TEXT_LINE_HEIGHT + fontSize;
    return { w: maxW, h };
  }
  if (!measureCtx) {
    const c = document.createElement("canvas");
    measureCtx = c.getContext("2d");
  }
  if (!measureCtx) {
    return { w: fontSize, h: chars.length * fontSize };
  }
  measureCtx.font = `${fontSize}px ${fontStack(fontFamily)}`;
  let maxW = fontSize;
  for (const ch of chars) {
    const w = measureCtx.measureText(ch).width;
    if (w > maxW) maxW = w;
  }
  return { w: maxW, h: chars.length * fontSize };
}

/** rgb 0-255 → #rrggbb */
export function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

/** hex → [r,g,b] 0-255 */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
