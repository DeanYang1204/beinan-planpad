import { useMemo, useState } from "react";
import type { DocStore } from "../engine/document";
import type { Layer, LayerGroup } from "../types";

interface Props {
  store: DocStore;
}

/** 拖放目標狀態：落在圖層列上（above/below 插入）或落在群組標題上（移入群組） */
type DropTarget =
  | { kind: "layer"; id: string; place: "above" | "below" }
  | { kind: "group"; id: string }
  | null;

export default function LayerPanel({ store }: Props) {
  const doc = store.doc;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);

  // 動態統計每層實體數
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    if (doc) for (const e of doc.entities) m.set(e.layerId, (m.get(e.layerId) ?? 0) + 1);
    return m;
  }, [doc, store.version]);

  if (!doc) return null;

  const groups = doc.layerGroups ?? [];

  // 顯示順序 = doc.layers 陣列順序（index 0 = 面板最上 = 堆疊最上層）。
  // 群組：在第一個成員的位置渲染整個 GroupBlock（成員依陣列順序排），其餘成員略過。
  const renderedGroups = new Set<string>();
  const rows: (
    | { type: "layer"; layer: Layer }
    | { type: "group"; group: LayerGroup; members: Layer[] }
  )[] = [];
  for (const l of doc.layers) {
    if (l.groupId) {
      if (renderedGroups.has(l.groupId)) continue;
      renderedGroups.add(l.groupId);
      const g = groups.find((x) => x.id === l.groupId);
      if (!g) continue; // 群組資料遺失（防禦）：當作未分組
      rows.push({
        type: "group",
        group: g,
        members: doc.layers.filter((x) => x.groupId === g.id),
      });
    } else {
      rows.push({ type: "layer", layer: l });
    }
  }

  const activeId = store.activeLayerId;
  const selCount = selectedIds.size;
  const allSelectable = doc.layers.map((l) => l.id);
  const allSelected =
    allSelectable.length > 0 && allSelectable.every((l) => selectedIds.has(l));

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectOnly(id: string) {
    setSelectedIds(new Set([id]));
  }

  /** 全選/取消全選所有圖層（切換） */
  function toggleSelectAll() {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(allSelectable));
  }

  function lockSelected(locked: boolean) {
    store.setLayersLocked([...selectedIds], locked);
  }

  function mergeSelected() {
    store.mergeLayers([...selectedIds]);
    setSelectedIds(new Set());
  }

  function groupSelected() {
    store.groupLayers([...selectedIds]);
    setSelectedIds(new Set());
  }

  function deleteSelected() {
    store.deleteLayers([...selectedIds]);
    setSelectedIds(new Set());
  }

  function duplicateSelected() {
    store.duplicateLayers([...selectedIds]);
  }

  function toggleCollapse(gid: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  }

  // ---------- 拖放 ----------
  function handleDropOnLayer(targetId: string) {
    if (dragId && dragId !== targetId && dropTarget?.kind === "layer") {
      store.reorderLayer(dragId, targetId, dropTarget.place);
    }
    setDragId(null);
    setDropTarget(null);
  }

  function handleDropOnGroup(groupId: string) {
    if (dragId) {
      store.moveLayerToGroup(dragId, groupId);
    }
    setDragId(null);
    setDropTarget(null);
  }

  function handleDragEnd() {
    setDragId(null);
    setDropTarget(null);
  }

  return (
    <div className="w-64 bg-white border-l border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 flex flex-col">
      <div className="px-3 py-2 text-sm font-semibold border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
        <span>
          圖層 <span className="text-neutral-400 font-normal text-xs">({doc.layers.length})</span>
        </span>
        <button
          onClick={toggleSelectAll}
          className={`px-2 py-0.5 rounded text-xs border ${
            allSelected
              ? "border-primary-500 text-primary-600 bg-primary-50 dark:bg-primary-900/30"
              : "border-neutral-300 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-700"
          }`}
          title={allSelected ? "取消全選" : "全選所有圖層"}
        >
          {allSelected ? "取消全選" : "全選"}
        </button>
      </div>

      {/* 多選工具列（有勾選時顯示） */}
      {selCount > 0 && (
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50">
          <span className="text-[11px] text-neutral-500 mr-1">已選 {selCount}</span>
          <button
            onClick={() => lockSelected(true)}
            className="px-2 py-1 rounded text-xs border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-700"
            title="鎖定所選圖層"
          >
            🔒 鎖定
          </button>
          <button
            onClick={() => lockSelected(false)}
            className="px-2 py-1 rounded text-xs border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-700"
            title="解鎖所選圖層"
          >
            🔓 解鎖
          </button>
          <button
            onClick={duplicateSelected}
            className="px-2 py-1 rounded text-xs border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-700"
            title="複製所選圖層（連同其內容，副本置於來源下方）"
          >
            📋 複製
          </button>
          {selCount >= 2 && (
            <button
              onClick={groupSelected}
              className="px-2 py-1 rounded text-xs bg-violet-600 text-white hover:bg-violet-700"
              title="將所選圖層收納為一個群組（資料夾）"
            >
              📁 群組
            </button>
          )}
          {selCount >= 2 && (
            <button
              onClick={mergeSelected}
              className="px-2 py-1 rounded text-xs bg-primary-600 text-white hover:bg-primary-700"
              title="合併所選圖層為一層"
            >
              ⧉ 合併
            </button>
          )}
          <button
            onClick={deleteSelected}
            className="px-2 py-1 rounded text-xs border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/30"
            title="刪除所選圖層（連同其內容，可 Ctrl+Z 復原）"
          >
            🗑 刪除
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto px-1.5 py-1 rounded text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            title="清除選擇"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {rows.map((r) =>
          r.type === "layer" ? (
            <LayerRow
              key={r.layer.id}
              layer={r.layer}
              count={counts.get(r.layer.id) ?? 0}
              store={store}
              isActive={r.layer.id === activeId}
              isChecked={selectedIds.has(r.layer.id)}
              onToggleSelect={() => toggleSelect(r.layer.id)}
              onSelectRow={() => {
                store.setActiveLayer(r.layer.id);
                selectOnly(r.layer.id);
              }}
              dragId={dragId}
              dropTarget={dropTarget}
              onDragStart={() => setDragId(r.layer.id)}
              onDragOverLayer={(place) =>
                setDropTarget({ kind: "layer", id: r.layer.id, place })
              }
              onDropOnLayer={() => handleDropOnLayer(r.layer.id)}
              onDragEnd={handleDragEnd}
            />
          ) : (
            <GroupBlock
              key={r.group.id}
              group={r.group}
              members={r.members}
              counts={counts}
              store={store}
              activeId={activeId}
              selectedIds={selectedIds}
              collapsed={collapsedGroups.has(r.group.id)}
              onToggleCollapse={() => toggleCollapse(r.group.id)}
              onToggleSelect={toggleSelect}
              onSelectRow={(id) => {
                store.setActiveLayer(id);
                selectOnly(id);
              }}
              dragId={dragId}
              dropTarget={dropTarget}
              onDragStart={(id) => setDragId(id)}
              onDragOverGroup={() => setDropTarget({ kind: "group", id: r.group.id })}
              onDragOverMember={(id, place) =>
                setDropTarget({ kind: "layer", id, place })
              }
              onDropOnGroup={() => handleDropOnGroup(r.group.id)}
              onDropOnMember={(id) => handleDropOnLayer(id)}
              onDragEnd={handleDragEnd}
            />
          )
        )}
      </div>

      <div className="px-3 py-1.5 text-[10px] text-neutral-400 border-t border-neutral-200 dark:border-neutral-800">
        拖曳調上下層 · 拖到群組收納 · 雙擊改名 · 📋 複製 · 🗑 刪除
      </div>

      {/* 操作中圖層的不透明度滑桿（點擊圖層列後出現） */}
      {activeId &&
        (() => {
          const activeLayer = doc.layers.find((l) => l.id === activeId);
          if (!activeLayer) return null;
          const op = Math.round((activeLayer.opacity ?? 1) * 100);
          return (
            <div className="px-3 py-2 border-t border-neutral-200 dark:border-neutral-800 flex items-center gap-2">
              <span className="text-[11px] text-neutral-500 shrink-0">不透明度</span>
              <input
                type="range"
                min={0}
                max={100}
                value={op}
                onChange={(e) => store.setLayerOpacity(activeId, parseInt(e.target.value, 10) / 100)}
                onPointerDown={(e) => e.stopPropagation()}
                className="flex-1 accent-primary-600 cursor-pointer"
                title="調整操作中圖層的不透明度"
              />
              <span className="text-[11px] text-neutral-500 w-9 text-right shrink-0 tabular-nums">{op}%</span>
            </div>
          );
        })()}
    </div>
  );
}

function GroupBlock({
  group,
  members,
  counts,
  store,
  activeId,
  selectedIds,
  collapsed,
  onToggleCollapse,
  onToggleSelect,
  onSelectRow,
  dragId,
  dropTarget,
  onDragStart,
  onDragOverGroup,
  onDragOverMember,
  onDropOnGroup,
  onDropOnMember,
  onDragEnd,
}: {
  group: LayerGroup;
  members: Layer[];
  counts: Map<string, number>;
  store: DocStore;
  activeId: string | null;
  selectedIds: Set<string>;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onToggleSelect: (id: string) => void;
  onSelectRow: (id: string) => void;
  dragId: string | null;
  dropTarget: DropTarget;
  onDragStart: (id: string) => void;
  onDragOverGroup: () => void;
  onDragOverMember: (id: string, place: "above" | "below") => void;
  onDropOnGroup: () => void;
  onDropOnMember: (id: string) => void;
  onDragEnd: () => void;
}) {
  const visibleCount = members.filter((l) => l.visible).length;
  const allVisible = members.length > 0 && visibleCount === members.length;
  const anyVisible = visibleCount > 0;
  const lockedCount = members.filter((l) => l.locked).length;
  const allLocked = members.length > 0 && lockedCount === members.length;
  const total = members.reduce((s, l) => s + (counts.get(l.id) ?? 0), 0);
  const isGroupDrop = dragId !== null && dropTarget?.kind === "group" && dropTarget.id === group.id;

  return (
    <div>
      <div
        className={`flex items-center gap-2 px-3 py-1.5 text-sm bg-neutral-50 dark:bg-neutral-800/60 border-b border-neutral-100 dark:border-neutral-800 cursor-pointer select-none ${
          isGroupDrop ? "ring-2 ring-inset ring-primary-400 bg-primary-50 dark:bg-primary-900/30" : ""
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onDragOverGroup();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDropOnGroup();
        }}
      >
        {/* 摺疊箭頭 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse();
          }}
          className="w-4 h-4 text-neutral-400 hover:text-neutral-600 shrink-0 text-center text-xs leading-none"
          title={collapsed ? "展開" : "摺疊"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        {/* 資料夾圖示 */}
        <span className="shrink-0 text-xs">{collapsed ? "📁" : "📂"}</span>
        <span className="flex-1 truncate font-medium">{group.name}</span>
        <span className="text-[10px] text-neutral-400 shrink-0">
          {members.length} 層
        </span>
        <span className="text-[10px] text-neutral-400 w-11 text-right shrink-0">{total}</span>
        {/* 整體顯隱 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            store.setGroupVisible(group.id, !allVisible);
          }}
          className={`w-6 h-6 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-center text-xs shrink-0 ${
            anyVisible ? "text-neutral-600 dark:text-neutral-300" : "text-neutral-300 dark:text-neutral-600"
          }`}
          title={allVisible ? "隱藏群組內所有圖層" : "顯示群組內所有圖層"}
        >
          {anyVisible ? (allVisible ? "👁" : "◐") : "—"}
        </button>
        {/* 整體鎖定 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            store.setGroupLocked(group.id, !allLocked);
          }}
          className={`w-6 h-6 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-center text-xs shrink-0 ${
            allLocked ? "text-amber-500" : "text-neutral-400"
          }`}
          title={allLocked ? "解鎖群組內所有圖層" : "鎖定群組內所有圖層"}
        >
          {allLocked ? "🔒" : "🔓"}
        </button>
        {/* 解散群組 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            store.ungroupLayer(group.id);
          }}
          className="w-6 h-6 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 text-center text-xs shrink-0 text-neutral-400 hover:text-red-500"
          title="解散群組（圖層移出，不刪除）"
        >
          ✕
        </button>
      </div>

      {/* 組內圖層（摺疊時隱藏） */}
      {!collapsed &&
        members.map((l) => (
          <LayerRow
            key={l.id}
            layer={l}
            count={counts.get(l.id) ?? 0}
            store={store}
            isActive={l.id === activeId}
            isChecked={selectedIds.has(l.id)}
            onToggleSelect={() => onToggleSelect(l.id)}
            onSelectRow={() => onSelectRow(l.id)}
            indent
            dragId={dragId}
            dropTarget={dropTarget}
            onDragStart={() => onDragStart(l.id)}
            onDragOverLayer={(place) => onDragOverMember(l.id, place)}
            onDropOnLayer={() => onDropOnMember(l.id)}
            onDragEnd={onDragEnd}
          />
        ))}
    </div>
  );
}

function LayerRow({
  layer,
  count,
  store,
  isActive,
  isChecked,
  onToggleSelect,
  onSelectRow,
  indent,
  dragId,
  dropTarget,
  onDragStart,
  onDragOverLayer,
  onDropOnLayer,
  onDragEnd,
}: {
  layer: Layer;
  count: number;
  store: DocStore;
  isActive: boolean;
  isChecked: boolean;
  onToggleSelect: () => void;
  onSelectRow: () => void;
  indent?: boolean;
  dragId: string | null;
  dropTarget: DropTarget;
  onDragStart: () => void;
  onDragOverLayer: (place: "above" | "below") => void;
  onDropOnLayer: () => void;
  onDragEnd: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(layer.name);

  const toggleVisible = () => store.setLayerVisible(layer.id, !layer.visible);
  const toggleLock = () => store.setLayerLocked(layer.id, !layer.locked);

  const isDragging = dragId === layer.id;
  const dropPlace =
    dragId && dragId !== layer.id && dropTarget?.kind === "layer" && dropTarget.id === layer.id
      ? dropTarget.place
      : null;

  function commitRename() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== layer.name) {
      store.renameLayer(layer.id, draft);
    } else {
      setDraft(layer.name);
    }
  }

  return (
    <div
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", layer.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => {
        if (!dragId || dragId === layer.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        onDragOverLayer(e.clientY < rect.top + rect.height / 2 ? "above" : "below");
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDropOnLayer();
      }}
      onDragEnd={onDragEnd}
      className={`relative flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer ${
        indent ? "pl-8" : ""
      } ${
        isActive
          ? "bg-primary-50 dark:bg-primary-900/30 ring-1 ring-inset ring-primary-400"
          : isChecked
          ? "bg-neutral-100 dark:bg-neutral-800"
          : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
      } ${layer.visible ? "" : "opacity-50"} ${isDragging ? "opacity-40" : ""}`}
      onClick={onSelectRow}
    >
      {/* 拖放插入位置指示線 */}
      {dropPlace === "above" && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary-500 z-10" />
      )}
      {dropPlace === "below" && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary-500 z-10" />
      )}
      {/* 多選複選框 */}
      <input
        type="checkbox"
        checked={isChecked}
        onChange={onToggleSelect}
        onClick={(e) => e.stopPropagation()}
        className="shrink-0 w-3.5 h-3.5 accent-primary-600 cursor-pointer"
        title="勾選此圖層（可多選）"
      />
      {/* 色塊：點擊切換顯隱 */}
      <span
        className="w-3.5 h-3.5 rounded-sm border border-neutral-300 dark:border-neutral-600 shrink-0 cursor-pointer"
        style={{ backgroundColor: layer.visible ? layer.color : "transparent" }}
        onClick={(e) => {
          e.stopPropagation();
          toggleVisible();
        }}
        title="點擊切換顯示/隱藏"
      />
      {/* 名稱：雙擊編輯 */}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") {
              setDraft(layer.name);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 px-1 py-0.5 text-sm border border-primary-400 rounded bg-white dark:bg-neutral-800 outline-none"
        />
      ) : (
        <span
          className="flex-1 truncate"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(layer.name);
            setEditing(true);
          }}
          title={`${layer.name}（雙擊重新命名）`}
        >
          {layer.name}
        </span>
      )}
      {isActive && (
        <span className="text-[9px] px-1 rounded bg-primary-100 text-primary-700 dark:bg-primary-900 dark:text-primary-300 shrink-0">
          操作中
        </span>
      )}
      {layer.isFill && (
        <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300 shrink-0">
          填充
        </span>
      )}
      {layer.locked && (
        <span className="text-[9px] px-1 rounded bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300 shrink-0">
          鎖定
        </span>
      )}
      {(layer.opacity ?? 1) < 1 && (
        <span className="text-[9px] px-1 rounded bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300 shrink-0 tabular-nums">
          {Math.round((layer.opacity ?? 1) * 100)}%
        </span>
      )}
      <span className="text-[10px] text-neutral-400 w-11 text-right shrink-0">{count}</span>

      {/* 顯隱按鈕 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleVisible();
        }}
        className="w-6 h-6 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-center text-xs shrink-0"
        title={layer.visible ? "隱藏" : "顯示"}
      >
        {layer.visible ? "👁" : "—"}
      </button>
      {/* 鎖定按鈕 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleLock();
        }}
        className={`w-6 h-6 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-center text-xs shrink-0 ${
          layer.locked ? "text-amber-500" : "text-neutral-400"
        }`}
        title={layer.locked ? "解除鎖定" : "鎖定此圖層（鎖定後不可選取/編輯）"}
      >
        {layer.locked ? "🔒" : "🔓"}
      </button>
      {/* 複製按鈕 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          store.duplicateLayers([layer.id]);
        }}
        className="w-6 h-6 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-center text-xs shrink-0 text-neutral-400 hover:text-primary-600"
        title="複製此圖層（連同其內容，副本置於下方）"
      >
        📋
      </button>
      {/* 刪除按鈕 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          store.deleteLayers([layer.id]);
        }}
        className="w-6 h-6 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-center text-xs shrink-0 text-neutral-400 hover:text-red-500"
        title="刪除此圖層（連同其內容，可 Ctrl+Z 復原）"
      >
        🗑
      </button>
    </div>
  );
}
