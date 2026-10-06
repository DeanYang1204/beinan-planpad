import type { DocStore } from "../engine/document";
import type { VecEntity } from "../types";
import { FONTS, formatMeters } from "../types";
import { useState } from "react";

interface Props {
  store: DocStore;
  style: { stroke: string; width: number; dash: string; fill: string; fontSize: number };
  onStyleChange: (patch: Partial<{ stroke: string; width: number; dash: string; fill: string; fontSize: number }>) => void;
  onEditText: (e: VecEntity) => void;
}

const COLORS = ["#000000", "#e53935", "#1e88e5", "#43a047", "#ffb300", "#8e24aa", "#00acc1", "#6d4c41", "#f06292", "#78909c"];
const WIDTHS = [1, 2, 3, 4, 6, 8];

export default function PropertyPanel({ store, style, onStyleChange, onEditText }: Props) {
  const selected = store.getSelected();

  if (selected.length === 0) {
    return (
      <div className="w-60 bg-white border-l border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 p-3 text-sm">
        <div className="font-semibold mb-3">繪圖樣式</div>
        <div className="text-xs text-neutral-500 mb-1">線條顏色</div>
        <ColorPicker value={style.stroke} onChange={(c) => onStyleChange({ stroke: c })} />
        <div className="mt-3 mb-1 text-xs text-neutral-500">填色（矩形 / 上色工具）</div>
        <FillPicker value={style.fill} onChange={(c) => onStyleChange({ fill: c })} />
        <div className="mt-3 mb-1 text-xs text-neutral-500">線寬</div>
        <div className="flex flex-wrap gap-1">
          {WIDTHS.map((w) => (
            <button
              key={w}
              onClick={() => onStyleChange({ width: w })}
              className={`w-8 h-8 rounded border text-xs ${
                style.width === w
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
        <div className="mt-3 mb-1 text-xs text-neutral-500">虛線</div>
        <div className="flex flex-wrap gap-1">
          {[
            { label: "實線", v: "" },
            { label: "虛線", v: "6,4" },
            { label: "點線", v: "2,3" },
            { label: "點劃", v: "8,3,2,3" },
          ].map((d) => (
            <button
              key={d.label}
              onClick={() => onStyleChange({ dash: d.v })}
              className={`px-2 py-1 rounded border text-xs ${
                style.dash === d.v
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="mt-3 mb-1 text-xs text-neutral-500">文字字號</div>
        <input
          type="range"
          min={0.5}
          max={72}
          step={0.5}
          value={style.fontSize}
          onChange={(e) => onStyleChange({ fontSize: parseFloat(e.target.value) })}
          className="w-full"
        />
        <div className="text-xs text-neutral-400 mt-1">{style.fontSize} pt</div>
      </div>
    );
  }

  const first = selected[0];
  const single = selected.length === 1;
  const isGrouped = selected.some((e) => e.groupId);

  return (
    <div className="w-60 bg-white border-l border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 p-3 text-sm">
      <div className="font-semibold mb-1">
        {single ? (first.groupId ? "屬性 · 組件" : "屬性") : `已選取 ${selected.length} 項`}
      </div>
      {/* 群組（組件）操作 */}
      <div className="flex gap-1 mb-3">
        {selected.length >= 2 && (
          <button
            onClick={() => store.makeGroup(selected.map((e) => e.id))}
            className="flex-1 px-2 py-1.5 rounded border border-primary-600 bg-primary-50 text-primary-700 text-xs hover:bg-primary-100 dark:bg-primary-900 dark:text-primary-200"
            title="把選取的多個圖元合為一個組件（Ctrl+G）"
          >
            群組 Ctrl+G
          </button>
        )}
        {isGrouped && (
          <button
            onClick={() => store.ungroup(selected.map((e) => e.id))}
            className="flex-1 px-2 py-1.5 rounded border border-neutral-300 text-xs hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            title="解散組件（Ctrl+Shift+G）"
          >
            解散群組
          </button>
        )}
      </div>
      {single && (
        <div className="text-xs text-neutral-500 mb-3 capitalize">
          {first.kind}
          {first.origin === "pdf" ? " · 原始圖元" : " · 標註"}
        </div>
      )}

      {single && first.kind === "dimension" ? (
        <div>
          <div className="text-xs text-neutral-500 mb-1">距離</div>
          <div className="text-2xl font-bold tabular-nums">
            {store.doc?.metersPerPt
              ? formatMeters(
                  Math.hypot(first.pts[2] - first.pts[0], first.pts[3] - first.pts[1]) * store.doc.metersPerPt
                )
              : "未校準"}
          </div>
          <Recalibrate
            store={store}
            ptLength={Math.hypot(first.pts[2] - first.pts[0], first.pts[3] - first.pts[1])}
          />
          <SetLength store={store} id={first.id} />
          <div className="mt-3 mb-1 text-xs text-neutral-500">線條顏色</div>
          <ColorPicker value={first.stroke} onChange={(c) => store.updateStyle(first.id, { stroke: c })} />
          <div className="mt-3 mb-1 text-xs text-neutral-500 flex items-center justify-between">
            <span>文字顏色</span>
            <button
              onClick={() => store.updateStyle(first.id, { labelColor: undefined })}
              className={`px-1.5 py-0.5 rounded border text-[10px] leading-none ${
                !first.labelColor
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-400 dark:hover:bg-neutral-800"
              }`}
              title="文字顏色跟隨線條顏色"
            >
              ↺ 跟隨線色
            </button>
          </div>
          <ColorPicker value={first.labelColor ?? first.stroke} onChange={(c) => store.updateStyle(first.id, { labelColor: c })} />
          <div className="mt-3 mb-1 text-xs text-neutral-500">線寬</div>
          <div className="flex flex-wrap gap-1">
            {WIDTHS.map((w) => (
              <button
                key={w}
                onClick={() => store.updateStyle(first.id, { width: w })}
                className={`w-8 h-8 rounded border text-xs ${
                  first.width === w
                    ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                    : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
          <div className="mt-3 mb-1 text-xs text-neutral-500">箭頭樣式</div>
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["arrow", "實心箭頭"],
                ["open", "空心箭頭"],
                ["tick", "斜線"],
                ["ibeam", "工字型"],
                ["dot", "圓點"],
                ["box", "方塊"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => store.updateStyle(first.id, { dimArrowStyle: v })}
                className={`px-2 py-1 rounded border text-xs ${
                  (first.dimArrowStyle ?? "arrow") === v
                    ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                    : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-3 mb-1 text-xs text-neutral-500 flex justify-between">
            <span>箭頭大小</span>
            <span className="text-neutral-400">×{(first.dimArrowScale ?? 1).toFixed(1)}</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.1}
              value={first.dimArrowScale ?? 1}
              onChange={(e) => store.updateStyle(first.id, { dimArrowScale: parseFloat(e.target.value) })}
              className="flex-1"
            />
            <button
              onClick={() => store.updateStyle(first.id, { dimArrowScale: undefined })}
              className={`px-1.5 py-0.5 rounded border text-[10px] leading-none ${
                first.dimArrowScale === undefined
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-400 dark:hover:bg-neutral-800"
              }`}
              title="回復預設大小（隨字號比例）"
            >
              預設
            </button>
          </div>
          <div className="mt-3 mb-1 text-xs text-neutral-500">字號 {first.fontSize ?? 12}pt</div>
          <input
            type="range"
            min={0.5}
            max={72}
            step={0.5}
            value={first.fontSize ?? 12}
            onChange={(e) => store.resizeText(first.id, parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="mt-3 mb-1 text-xs text-neutral-500">文字位置</div>
          <div className="flex gap-1">
            <button
              onClick={() => store.updateStyle(first.id, { labelSide: "above" })}
              className={`flex-1 px-2 py-1.5 rounded border text-xs ${
                (first.labelSide ?? "below") === "above"
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
              }`}
            >
              ↑ 線條上方
            </button>
            <button
              onClick={() => store.updateStyle(first.id, { labelSide: "below" })}
              className={`flex-1 px-2 py-1.5 rounded border text-xs ${
                (first.labelSide ?? "below") === "below"
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
              }`}
            >
              ↓ 線條下方
            </button>
          </div>
          <div className="mt-3 mb-1 text-xs text-neutral-500">文字前綴</div>
          <div className="flex gap-1">
            {["", "高", "寬", "長"].map((p) => (
              <button
                key={p || "none"}
                onClick={() => store.updateStyle(first.id, { labelPrefix: p || undefined })}
                className={`flex-1 px-2 py-1.5 rounded border text-xs ${
                  (first.labelPrefix ?? "") === p
                    ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                    : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
                }`}
              >
                {p || "無"}
              </button>
            ))}
            <input
              value={first.labelPrefix ?? ""}
              onChange={(ev) => store.updateStyle(first.id, { labelPrefix: ev.target.value || undefined })}
              placeholder="自訂"
              className="w-14 px-1.5 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-xs"
            />
          </div>
          <div className="mt-3 mb-1 text-xs text-neutral-500">字型</div>
          <select
            value={first.fontFamily ?? ""}
            onChange={(ev) => store.updateStyle(first.id, { fontFamily: ev.target.value || undefined })}
            className="w-full px-2 py-1.5 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-xs"
          >
            {FONTS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <div className="mt-3 mb-1 text-xs text-neutral-500">文字底色</div>
          <BgPicker
            value={first.bgColor ?? ""}
            onChange={(c) => store.updateStyle(first.id, { bgColor: c || undefined })}
          />
          {first.bgColor && (
            <>
              <div className="mt-2 mb-1 text-xs text-neutral-500 flex justify-between">
                <span>底色不透明度</span>
                <span className="text-neutral-400">{Math.round((first.bgOpacity ?? 1) * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round((first.bgOpacity ?? 1) * 100)}
                onChange={(e) =>
                  store.updateStyle(first.id, { bgOpacity: parseInt(e.target.value, 10) / 100 })
                }
                className="w-full"
              />
            </>
          )}
          <div className="mt-3 mb-1 text-xs text-neutral-500">文字塊邊框</div>
          <BgPicker
            value={first.borderColor ?? ""}
            border
            onChange={(c) =>
              store.updateStyle(first.id, {
                borderColor: c || undefined,
                borderWidth: c ? first.borderWidth || 1 : undefined,
              })
            }
          />
          <div className="flex flex-wrap gap-1 mt-1.5">
            {[1, 2, 3, 4].map((w) => (
              <button
                key={w}
                disabled={!first.borderColor}
                onClick={() => store.updateStyle(first.id, { borderWidth: w })}
                className={`w-8 h-7 rounded border text-xs disabled:opacity-40 ${
                  (first.borderWidth ?? 1) === w && first.borderColor
                    ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                    : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      ) : single && first.kind === "text" ? (
        <div>
          <div className="text-xs text-neutral-500 mb-1">內容</div>
          <button
            onClick={() => onEditText(first)}
            className="w-full text-left px-2 py-2 rounded border border-neutral-300 dark:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {first.text}
          </button>
          <div className="mt-3 mb-1 text-xs text-neutral-500">字號 {first.fontSize}pt</div>
          <input
            type="range"
            min={0.5}
            max={72}
            step={0.5}
            value={first.fontSize ?? 16}
            onChange={(e) => store.resizeText(first.id, parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="mt-3 mb-1 text-xs text-neutral-500">書寫方向</div>
          <div className="flex gap-1">
            <button
              onClick={() => store.updateStyle(first.id, { vertical: false })}
              className={`flex-1 px-2 py-1.5 rounded border text-xs ${
                !first.vertical
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
              }`}
            >
              ⇄ 橫書
            </button>
            <button
              onClick={() => store.updateStyle(first.id, { vertical: true })}
              className={`flex-1 px-2 py-1.5 rounded border text-xs ${
                first.vertical
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
              }`}
            >
              ⇅ 直書
            </button>
          </div>
          <div className="mt-3 mb-1 text-xs text-neutral-500">旋轉角度</div>
          <RotateControl
            value={(first.userRot ?? 0) * (180 / Math.PI)}
            onChange={(deg) => store.setRotation(first.id, (deg * Math.PI) / 180)}
          />
          <div className="mt-3 mb-1 text-xs text-neutral-500">字色</div>
          <ColorPicker value={first.stroke} onChange={(c) => store.updateStyle(first.id, { stroke: c })} />

          <div className="mt-3 mb-1 text-xs text-neutral-500">文字底色</div>
          <BgPicker
            value={first.bgColor ?? ""}
            onChange={(c) => store.updateStyle(first.id, { bgColor: c || undefined })}
          />
          {first.bgColor && (
            <>
              <div className="mt-2 mb-1 text-xs text-neutral-500 flex justify-between">
                <span>底色不透明度</span>
                <span className="text-neutral-400">{Math.round((first.bgOpacity ?? 1) * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round((first.bgOpacity ?? 1) * 100)}
                onChange={(e) =>
                  store.updateStyle(first.id, { bgOpacity: parseInt(e.target.value, 10) / 100 })
                }
                className="w-full"
              />
            </>
          )}

          <div className="mt-3 mb-1 text-xs text-neutral-500">字型</div>
          <select
            value={first.fontFamily ?? ""}
            onChange={(ev) => store.updateStyle(first.id, { fontFamily: ev.target.value || undefined })}
            className="w-full px-2 py-1.5 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-xs"
          >
            {FONTS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>

          <div className="mt-3 mb-1 text-xs text-neutral-500">文字塊邊框</div>
          <BgPicker
            value={first.borderColor ?? ""}
            border
            onChange={(c) =>
              store.updateStyle(first.id, {
                borderColor: c || undefined,
                borderWidth: c ? first.borderWidth || 1 : undefined,
              })
            }
          />
          <div className="flex flex-wrap gap-1 mt-1.5">
            {[1, 2, 3, 4].map((w) => (
              <button
                key={w}
                disabled={!first.borderColor}
                onClick={() => store.updateStyle(first.id, { borderWidth: w })}
                className={`w-8 h-7 rounded border text-xs disabled:opacity-40 ${
                  (first.borderWidth ?? 1) === w && first.borderColor
                    ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                    : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      ) : single && first.kind === "image" ? (
        <div>
          <div className="mt-3 mb-1 text-xs text-neutral-500">旋轉角度</div>
          <RotateControl
            value={(first.userRot ?? 0) * (180 / Math.PI)}
            onChange={(deg) => store.setRotation(first.id, (deg * Math.PI) / 180)}
          />
          <div className="mt-3 mb-1 text-xs text-neutral-500">寬度（等比縮放）</div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={1}
              value={Math.round(first.w ?? 100)}
              onChange={(e) => store.resizeImage(first.id, parseFloat(e.target.value || "100"))}
              className="w-20 px-1 py-0.5 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-xs"
            />
            <span className="text-xs text-neutral-400">pt</span>
          </div>
          <div className="text-xs text-neutral-400 mt-1">
            尺寸 {Math.round(first.w ?? 100)} × {Math.round(first.h ?? 100)} pt
          </div>
        </div>
      ) : (
        <div>
          {single && first.kind === "line" && first.pts.length === 4 && (
            <button
              onClick={() => store.lineToArc(first.id)}
              className="w-full mb-3 px-2 py-1.5 rounded border border-violet-600 bg-violet-50 text-violet-700 text-xs hover:bg-violet-100 dark:bg-violet-900 dark:text-violet-200"
              title="把直線轉為弧線，出現控制點可拖動調整弧度（也可直接拖動線中點外的紫色把手）"
            >
              ⌒ 調整弧度（轉為弧線）
            </button>
          )}
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs text-neutral-500">顏色</div>
            <button
              onClick={() => selected.forEach((e) => store.updateStyle(e.id, { noStroke: !first.noStroke }))}
              className={`px-1.5 py-0.5 rounded border text-[10px] leading-none ${
                first.noStroke
                  ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                  : "border-neutral-300 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-400 dark:hover:bg-neutral-800"
              }`}
              title="無外邊框：只顯示填充（斜線/網格/斜網格/實色），不描外輪廓"
            >
              ⊘ 無邊框
            </button>
          </div>
          <ColorPicker
            value={first.stroke}
            onChange={(c) => selected.forEach((e) => store.updateStyle(e.id, { stroke: c }))}
          />
          <div className="mt-3 mb-1 text-xs text-neutral-500">填色</div>
          <FillPicker
            value={first.fill ?? ""}
            onChange={(c) => selected.forEach((e) => store.updateStyle(e.id, { fill: c || undefined }))}
          />
          {single && first.kind === "arrow" && (
            <>
              <div className="mt-3 mb-1 text-xs text-neutral-500">箭頭樣式</div>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ["straight", "直線"],
                    ["curved", "彎曲"],
                    ["elbow", "直角"],
                    ["both", "雙向"],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => store.updateStyle(first.id, { arrowStyle: v })}
                    className={`px-2 py-1 rounded border text-xs ${
                      (first.arrowStyle ?? "straight") === v
                        ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                        : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {(first.arrowStyle ?? "straight") === "curved" && (
                <>
                  <div className="mt-3 mb-1 text-xs text-neutral-500 flex justify-between">
                    <span>弧度</span>
                    <span className="text-neutral-400">{Math.round((first.bend ?? 0.25) * 100)}%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={-100}
                      max={100}
                      step={5}
                      value={Math.round((first.bend ?? 0.25) * 100)}
                      onChange={(e) => store.updateStyle(first.id, { bend: parseFloat(e.target.value) / 100 })}
                      className="flex-1"
                    />
                    <button
                      onClick={() => store.updateStyle(first.id, { bend: undefined })}
                      className={`px-1.5 py-0.5 rounded border text-[10px] leading-none ${
                        first.bend === undefined
                          ? "border-primary-600 text-primary-700 dark:text-primary-300"
                          : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
                      }`}
                    >
                      預設
                    </button>
                  </div>
                </>
              )}
              <div className="mt-3 mb-1 text-xs text-neutral-500 flex justify-between">
                <span>箭頭頭部大小</span>
                <span className="text-neutral-400">×{(first.headScale ?? 1).toFixed(1)}</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.1}
                  value={first.headScale ?? 1}
                  onChange={(e) => store.updateStyle(first.id, { headScale: parseFloat(e.target.value) })}
                  className="flex-1"
                />
                <button
                  onClick={() => store.updateStyle(first.id, { headScale: undefined })}
                  className={`px-1.5 py-0.5 rounded border text-[10px] leading-none ${
                    first.headScale === undefined
                      ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                      : "border-neutral-300 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-400 dark:hover:bg-neutral-800"
                  }`}
                  title="回復預設大小（隨線寬比例）"
                >
                  預設
                </button>
              </div>
            </>
          )}
          <div className="mt-3 mb-1 text-xs text-neutral-500">線寬</div>
          <div className="flex flex-wrap gap-1">
            {WIDTHS.map((w) => (
              <button
                key={w}
                onClick={() => selected.forEach((e) => store.updateStyle(e.id, { width: w }))}
                className={`w-8 h-8 rounded border text-xs ${
                  single && first.width === w
                    ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                    : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
          <div className="mt-3 mb-1 text-xs text-neutral-500">線型</div>
          <div className="flex flex-wrap gap-1">
            {[
              { label: "實線", v: "" },
              { label: "虛線", v: "6,4" },
              { label: "點線", v: "2,3" },
              { label: "點劃", v: "8,3,2,3" },
            ].map((d) => (
              <button
                key={d.label}
                onClick={() => selected.forEach((e) => store.updateStyle(e.id, { dash: d.v || undefined }))}
                className={`px-2 py-1 rounded border text-xs ${
                  single && (first.dash ?? "") === d.v
                    ? "border-primary-600 bg-primary-50 text-primary-700 dark:bg-primary-900 dark:text-primary-200"
                    : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 重新校準比例：以此段距離為基準輸入實際公尺數，更新全域比例 */
function Recalibrate({ store, ptLength }: { store: DocStore; ptLength: number }) {
  const [value, setValue] = useState("");
  const apply = () => {
    const m = parseFloat(value);
    if (isFinite(m) && m > 0) store.setScale(m / ptLength);
    setValue("");
  };
  return (
    <div className="mt-3">
      <div className="text-xs text-neutral-500 mb-1">以此段重新校準比例</div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          step={0.01}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
          placeholder="實際公尺"
          className="flex-1 min-w-0 px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-xs"
        />
        <span className="text-xs text-neutral-400 shrink-0">米</span>
        <button
          onClick={apply}
          disabled={!(parseFloat(value) > 0)}
          className="px-2 py-1 rounded border border-primary-600 bg-primary-50 text-primary-700 text-xs hover:bg-primary-100 disabled:opacity-40 dark:bg-primary-900 dark:text-primary-200"
        >
          套用
        </button>
      </div>
    </div>
  );
}

/** 設定長度：校正比例後，輸入目標公尺數自動把標註線拉長/縮短到對應寬度 */
function SetLength({ store, id }: { store: DocStore; id: string }) {
  const [value, setValue] = useState("");
  const calibrated = !!(store.doc?.metersPerPt && store.doc.metersPerPt > 0);
  const apply = () => {
    const m = parseFloat(value);
    if (isFinite(m) && m > 0) {
      store.setDimensionMeters(id, m);
      setValue("");
    }
  };
  return (
    <div className="mt-3">
      <div className="text-xs text-neutral-500 mb-1">設定長度（自動調整）</div>
      {!calibrated && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400 mb-1">
          請先校正比例（上方「以此段重新校準」）
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          step={0.01}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
          placeholder={calibrated ? "目標公尺" : "未校準"}
          disabled={!calibrated}
          className="flex-1 min-w-0 px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-xs disabled:opacity-40"
        />
        <span className="text-xs text-neutral-400 shrink-0">米</span>
        <button
          onClick={apply}
          disabled={!calibrated || !(parseFloat(value) > 0)}
          className="px-2 py-1 rounded border border-primary-600 bg-primary-50 text-primary-700 text-xs hover:bg-primary-100 disabled:opacity-40 dark:bg-primary-900 dark:text-primary-200"
        >
          套用
        </button>
      </div>
    </div>
  );
}

/** 旋轉角度控制：滑桿 + 數值輸入 + 快速按鈕（度） */
function RotateControl({ value, onChange }: { value: number; onChange: (deg: number) => void }) {
  const deg = Math.round(value);
  const quick = (d: number) =>
    `flex-1 px-1 py-1 rounded border border-neutral-300 text-xs hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800`;
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={deg}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="flex-1"
        />
        <input
          type="number"
          min={-180}
          max={180}
          step={1}
          value={deg}
          onChange={(e) => onChange(parseFloat(e.target.value || "0"))}
          className="w-16 px-1 py-0.5 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-xs text-right"
        />
        <span className="text-xs text-neutral-400">°</span>
      </div>
      <div className="flex gap-1 mt-1.5">
        <button onClick={() => onChange(0)} className={quick(0)}>
          重置
        </button>
        <button onClick={() => onChange(-90)} className={quick(0)}>
          -90°
        </button>
        <button onClick={() => onChange(90)} className={quick(0)}>
          +90°
        </button>
      </div>
    </div>
  );
}

/** 底色/邊框選擇器：無 + 常用色 + 自訂（value="" 代表無） */
function BgPicker({
  value,
  onChange,
  border = false,
}: {
  value: string;
  onChange: (c: string) => void;
  border?: boolean;
}) {
  const colors = border
    ? ["#000000", "#e53935", "#1e88e5", "#43a047"]
    : ["#ffffff", "#000000", "#fff3b0", "#cfe8ff", "#d6f5d6"];
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        onClick={() => onChange("")}
        title={border ? "無邊框" : "無底色"}
        className={`w-6 h-6 rounded border flex items-center justify-center text-[10px] ${
          value === ""
            ? "ring-2 ring-primary-500 ring-offset-1"
            : "border-neutral-300 dark:border-neutral-600"
        }`}
        style={{ background: "repeating-linear-gradient(45deg,#e5e5e5,#e5e5e5 2px,transparent 2px,transparent 5px)" }}
      >
        ⊘
      </button>
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`w-6 h-6 rounded-full border ${
            value.toLowerCase() === c.toLowerCase()
              ? "ring-2 ring-primary-500 ring-offset-1"
              : "border-neutral-300 dark:border-neutral-600"
          }`}
          style={{ backgroundColor: c }}
        />
      ))}
      <label
        className="w-6 h-6 rounded-full border border-neutral-300 dark:border-neutral-600 cursor-pointer overflow-hidden relative"
        title="自訂顏色"
      >
        <input
          type="color"
          value={value || "#ffffff"}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
        <span
          className="absolute inset-0"
          style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" }}
        />
      </label>
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {  return (
    <div className="flex items-center gap-2 flex-wrap">
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`w-6 h-6 rounded-full border ${
            value.toLowerCase() === c.toLowerCase()
              ? "ring-2 ring-primary-500 ring-offset-1"
              : "border-neutral-300 dark:border-neutral-600"
          }`}
          style={{ backgroundColor: c }}
        />
      ))}
      <label className="w-7 h-7 rounded-full border border-neutral-300 dark:border-neutral-600 cursor-pointer overflow-hidden relative">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
        <span
          className="absolute inset-0"
          style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" }}
        />
      </label>
    </div>
  );
}

/** 填色選擇：含「無填充」選項 */
function FillPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={() => onChange("")}
        title="無填充"
        className={`w-6 h-6 rounded border ${
          value === "" ? "ring-2 ring-primary-500 ring-offset-1" : "border-neutral-300 dark:border-neutral-600"
        }`}
        style={{
          background:
            "repeating-linear-gradient(45deg,#e5e5e5,#e5e5e5 2px,transparent 2px,transparent 5px)",
        }}
      />
      <button
        onClick={() => onChange("hatch")}
        title="虛線填充"
        className={`w-6 h-6 rounded border flex items-center justify-center text-xs font-bold ${
          value === "hatch"
            ? "ring-2 ring-primary-500 ring-offset-1 bg-white dark:bg-neutral-800"
            : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
        }`}
        style={{ background: "repeating-linear-gradient(45deg,#888,#888 1px,#fff 1px,#fff 4px)" }}
      >
        <span className="text-neutral-700 dark:text-neutral-200" style={{ textShadow: "0 0 2px #fff" }}>▨</span>
      </button>
      <button
        onClick={() => onChange("grid")}
        title="網格填充"
        className={`w-6 h-6 rounded border flex items-center justify-center text-xs font-bold ${
          value === "grid"
            ? "ring-2 ring-primary-500 ring-offset-1 bg-white dark:bg-neutral-800"
            : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
        }`}
        style={{
          background:
            "linear-gradient(#888,#888) 0 0/100% 1px,linear-gradient(#888,#888) 0 0/1px 100%,#fff",
          backgroundRepeat: "repeat",
          backgroundSize: "4px 4px",
        }}
      >
        <span className="text-neutral-700 dark:text-neutral-200" style={{ textShadow: "0 0 2px #fff" }}>▦</span>
      </button>
      <button
        onClick={() => onChange("xgrid")}
        title="斜網格填充"
        className={`w-6 h-6 rounded border flex items-center justify-center text-xs font-bold ${
          value === "xgrid"
            ? "ring-2 ring-primary-500 ring-offset-1 bg-white dark:bg-neutral-800"
            : "border-neutral-300 text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
        }`}
        style={{
          background:
            "repeating-linear-gradient(45deg,#888,#888 1px,#fff 1px,#fff 4px),repeating-linear-gradient(-45deg,#888,#888 1px,#fff 1px,#fff 4px)",
        }}
      >
        <span className="text-neutral-700 dark:text-neutral-200" style={{ textShadow: "0 0 2px #fff" }}>▩</span>
      </button>
      {COLORS.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`w-6 h-6 rounded-full border ${
            value.toLowerCase() === c.toLowerCase()
              ? "ring-2 ring-primary-500 ring-offset-1"
              : "border-neutral-300 dark:border-neutral-600"
          }`}
          style={{ backgroundColor: c }}
        />
      ))}
      <label className="w-7 h-7 rounded-full border border-neutral-300 dark:border-neutral-600 cursor-pointer overflow-hidden relative">
        <input
          type="color"
          value={value || "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
        <span
          className="absolute inset-0"
          style={{ background: "conic-gradient(red,yellow,lime,cyan,blue,magenta,red)" }}
        />
      </label>
    </div>
  );
}
