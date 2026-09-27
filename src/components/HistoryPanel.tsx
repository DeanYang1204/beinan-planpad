import { useEffect, useState } from "react";
import type { DocStore } from "../engine/document";

interface Props {
  store: DocStore;
}

/** 步驟記錄器：顯示可撤銷 / 可重做的操作歷史，點擊可跳轉到任一狀態 */
export default function HistoryPanel({ store }: Props) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((v) => v + 1)), [store]);

  const { past, future } = store.getHistory();
  const empty = past.length === 0 && future.length === 0;

  return (
    <div className="w-56 bg-white border-l border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 flex flex-col">
      <div className="px-3 py-2 text-sm font-semibold border-b border-neutral-200 dark:border-neutral-800">
        步驟
        <span className="text-neutral-400 font-normal text-xs ml-1">({past.length + future.length})</span>
      </div>
      <div className="flex-1 overflow-y-auto text-sm">
        {empty && (
          <div className="px-3 py-6 text-center text-xs text-neutral-400">尚無操作記錄</div>
        )}

        {/* 可重做（已撤銷，可回復） */}
        {future.length > 0 && (
          <div className="py-1">
            <div className="px-3 py-1 text-[10px] text-neutral-400">可重做</div>
            {future.map((label, j) => (
              <button
                key={"f" + j}
                onClick={() => store.redoSteps(j + 1)}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-neutral-400"
                title="回復到此步驟"
              >
                <span className="text-neutral-400 shrink-0">↪</span>
                <span className="flex-1 truncate">{label}</span>
              </button>
            ))}
          </div>
        )}

        {/* 當前狀態分隔 */}
        {past.length > 0 && (
          <div className="px-3 py-1 text-[10px] text-primary-500 border-y border-neutral-100 dark:border-neutral-800 bg-primary-50/50 dark:bg-primary-900/20">
            — 目前 —
          </div>
        )}

        {/* 可撤銷 */}
        {past.map((label, i) => (
          <button
            key={"p" + i}
            onClick={() => store.undoSteps(i + 1)}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            title="撤回到此步驟之前"
          >
            <span className="text-neutral-400 shrink-0">↩</span>
            <span className="flex-1 truncate">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
