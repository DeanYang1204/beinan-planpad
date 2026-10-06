// ============ 文件模型 + Undo/Redo ============
import type { PlanDoc, VecEntity, Layer, LayerGroup } from "../types";
import { genId } from "../types";
import { entityBbox, defaultArcCtrl, mergeLinePts, SpatialIndex } from "./geometry";

interface Command {
  label: string;
  undo(): void;
  redo(): void;
}

/** 修復圖層 id 重複（舊版 ensureDrawLayer 用記憶體流水號，重開專案會重建 user-1 與舊層撞 id）。
 *  把重複的後續圖層改名為新的 user-M，確保 id 唯一（消除「點一層連動另一層」）。 */
export function repairLayerIds(doc: PlanDoc): void {
  let maxN = 0;
  for (const l of doc.layers) {
    const m = /^user-(\d+)$/.exec(l.id);
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  const seen = new Set<string>();
  for (const l of doc.layers) {
    if (seen.has(l.id)) {
      const newId = `user-${++maxN}`;
      l.id = newId;
      const m = /^(.*?)\s*\d+$/.exec(l.name);
      l.name = `${m ? m[1].trim() : l.name} ${maxN}`;
    }
    seen.add(l.id);
  }
}

/** 依圖層堆疊順序回傳「可見實體」的繪製清單（由最下層畫到最上層）。
 *  順序定義：doc.layers[0] = 最上層（與圖層面板顯示順序一致）。
 *  同層內維持建立順序、文字排最後（避免被同層線條蓋住）。 */
export function orderedDrawList(doc: PlanDoc): VecEntity[] {
  const layerMap = new Map<string, Layer>();
  for (const l of doc.layers) layerMap.set(l.id, l);
  const vis = doc.entities.filter((e) => {
    const l = layerMap.get(e.layerId);
    return l ? l.visible : true;
  });
  const byLayer = new Map<string, VecEntity[]>();
  const orphans: VecEntity[] = [];
  for (const e of vis) {
    if (!layerMap.has(e.layerId)) { orphans.push(e); continue; }
    let arr = byLayer.get(e.layerId);
    if (!arr) byLayer.set(e.layerId, (arr = []));
    arr.push(e);
  }
  const out: VecEntity[] = [...orphans]; // 孤兒實體（圖層已不存在）畫在最底層，與舊行為一致
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const arr = byLayer.get(doc.layers[i].id);
    if (!arr) continue;
    for (const e of arr) if (e.kind !== "text") out.push(e);
    for (const e of arr) if (e.kind === "text") out.push(e);
  }
  return out;
}

export class DocStore {
  doc: PlanDoc | null = null;
  selection = new Set<string>();
  /** 目前操作（活動）圖層：畫布選中圖元或面板點選時更新 */
  activeLayerId: string | null = null;
  version = 0;

  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<() => void>();
  private index = new SpatialIndex();
  private indexDirty = true;

  // ---------- 訂閱 ----------
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.version++;
    this.indexDirty = true;
    for (const fn of this.listeners) fn();
  }

  // ---------- 索引 ----------
  getIndex(): SpatialIndex {
    if (this.indexDirty && this.doc) {
      this.index.build(this.doc.entities);
      this.indexDirty = false;
    }
    return this.index;
  }

  // ---------- 載入 ----------
  loadDoc(doc: PlanDoc) {
    // 補齊圖層組欄位（舊檔無此欄位）
    if (!doc.layerGroups) doc.layerGroups = [];
    // 清除舊檔快取的 bbox（舊版文字寬度為估算值），載入後依目前量測邏輯重算
    for (const e of doc.entities) delete (e as { bbox?: unknown }).bbox;
    // 修復重複圖層 id（舊版流水號跨重載撞號）
    repairLayerIds(doc);
    // 確保「標註」圖層存在（使用者繪製實體的預設圖層）
    if (!doc.layers.some((l) => l.id === "user")) {
      doc.layers.unshift({
        id: "user",
        name: "標註",
        color: "#e53935",
        width: 2,
        visible: true,
        locked: false,
        isFill: false,
        count: 0,
      });
    }
    this.doc = doc;
    this.selection.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.indexDirty = true;
    this.emit();
  }

  // ---------- Undo/Redo ----------
  push(cmd: Command, execute = true) {
    if (execute) cmd.redo();
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.emit();
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.emit();
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this.undoStack.push(cmd);
    this.emit();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  // ---------- 步驟記錄器 ----------
  /** 回傳操作歷史：past = 可撤銷（最近在前），future = 可重做（最近在前） */
  getHistory(): { past: string[]; future: string[] } {
    return {
      past: this.undoStack.map((c) => c.label).slice().reverse(),
      future: this.redoStack.map((c) => c.label).slice().reverse(),
    };
  }

  /** 連續撤銷 n 步（僅最後 emit 一次） */
  undoSteps(n: number) {
    if (n <= 0) return;
    for (let i = 0; i < n && this.undoStack.length; i++) {
      const cmd = this.undoStack.pop()!;
      cmd.undo();
      this.redoStack.push(cmd);
    }
    this.emit();
  }

  /** 連續重做 n 步（僅最後 emit 一次） */
  redoSteps(n: number) {
    if (n <= 0) return;
    for (let i = 0; i < n && this.redoStack.length; i++) {
      const cmd = this.redoStack.pop()!;
      cmd.redo();
      this.undoStack.push(cmd);
    }
    this.emit();
  }

  // ---------- 選取 ----------
  setSelection(ids: Iterable<string>) {
    this.selection = new Set(ids);
    // 同步活動圖層：選中圖元所屬圖層設為活動圖層（多選取第一個）
    if (this.doc && this.selection.size > 0) {
      const firstId = this.selection.values().next().value as string;
      const e = this.doc.entities.find((x) => x.id === firstId);
      if (e) this.activeLayerId = e.layerId;
    }
    this.emit();
  }
  clearSelection() {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.emit();
  }
  /** 全選：選取所有「可見且未鎖定」圖層的圖元（鎖定/隱藏圖層不納入，避免誤動底圖） */
  selectAll() {
    if (!this.doc) return;
    const layerMap = new Map<string, Layer>();
    for (const l of this.doc.layers) layerMap.set(l.id, l);
    const ids = this.doc.entities
      .filter((e) => {
        const l = layerMap.get(e.layerId);
        return l ? l.visible && !l.locked : true;
      })
      .map((e) => e.id);
    this.setSelection(ids);
  }
  setActiveLayer(id: string | null) {
    this.activeLayerId = id;
    this.emit();
  }
  getSelected(): VecEntity[] {
    if (!this.doc) return [];
    const set = this.selection;
    return this.doc.entities.filter((e) => set.has(e.id));
  }

  // ---------- 實體操作 ----------
  private byId(id: string): VecEntity | undefined {
    if (!this.doc) return undefined;
    return this.doc.entities.find((e) => e.id === id);
  }

  private translate(e: VecEntity, dx: number, dy: number) {
    for (let i = 0; i < e.pts.length; i += 2) {
      e.pts[i] += dx;
      e.pts[i + 1] += dy;
    }
    e.bbox = entityBbox(e);
  }

  /** 拖動中的即時移動（不入 undo，僅 emit 觸發重繪） */
  moveLive(ids: string[], dx: number, dy: number) {
    for (const id of ids) {
      const e = this.byId(id);
      if (e) this.translate(e, dx, dy);
    }
    this.emit();
  }

  /** 拖動結束，記錄為可 undo 的指令 */
  commitMove(ids: string[], totalDx: number, totalDy: number) {
    const self = this;
    this.push({
      label: "移動",
      undo: () => self.moveLive(ids, -totalDx, -totalDy),
      redo: () => self.moveLive(ids, totalDx, totalDy),
    }, false);
  }

  /** 旋轉中的即時設定（不入 undo，僅 emit 觸發重繪），繞物件中心（PS 風格） */
  rotateLive(id: string, rad: number) {
    const e = this.byId(id);
    if (!e) return;
    e.userRot = rad;
    e.bbox = entityBbox(e);
    this.emit();
  }

  /** 旋轉結束，記錄為可 undo 的指令（before 為旋轉前角度） */
  commitRotate(id: string, beforeRad: number) {
    const e = this.byId(id);
    if (!e) return;
    const after = e.userRot ?? 0;
    if (Math.abs(after - beforeRad) < 1e-6) return;
    const self = this;
    this.push({
      label: "旋轉",
      undo: () => {
        const t = self.byId(id);
        if (t) { t.userRot = beforeRad; t.bbox = entityBbox(t); }
      },
      redo: () => {
        const t = self.byId(id);
        if (t) { t.userRot = after; t.bbox = entityBbox(t); }
      },
    }, false);
  }

  /** 直接設定旋轉角度（供屬性面板精確輸入）。連續調整同一物件會合併為一步 undo（避免滑桿拖動產生大量步驟） */
  setRotation(id: string, rad: number) {
    const e = this.byId(id);
    if (!e) return;
    const before = e.userRot ?? 0;
    if (Math.abs(before - rad) < 1e-6) return;
    // 上一步是同一物件的「旋轉」→ 合併（更新角度），不新增 undo 步
    const top = this.undoStack[this.undoStack.length - 1] as (Command & { rotId?: string; rotAfter?: number }) | undefined;
    if (top && top.label === "旋轉" && top.rotId === id) {
      e.userRot = rad;
      e.bbox = entityBbox(e);
      top.rotAfter = rad;
      this.emit();
      return;
    }
    const beforeRad = before;
    e.userRot = rad;
    e.bbox = entityBbox(e);
    const self = this;
    const cmd = {
      label: "旋轉",
      rotId: id,
      rotAfter: rad,
      undo: () => {
        const t = self.byId(id);
        if (t) { t.userRot = beforeRad; t.bbox = entityBbox(t); }
      },
      redo: () => {
        const t = self.byId(id);
        if (t) { t.userRot = cmd.rotAfter; t.bbox = entityBbox(t); }
      },
    };
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.emit();
  }

  /** 調整圖片寬度（等比縮放高），undoable */
  resizeImage(id: string, w: number) {
    const e = this.byId(id);
    if (!e || e.kind !== "image") return;
    const beforeW = e.w ?? 100;
    const beforeH = e.h ?? 100;
    const ratio = beforeH / beforeW || 1;
    const newW = Math.max(1, w);
    const newH = newW * ratio;
    const self = this;
    this.push({
      label: "圖片大小",
      redo: () => {
        const t = self.byId(id);
        if (t) { t.w = newW; t.h = newH; t.bbox = entityBbox(t); }
      },
      undo: () => {
        const t = self.byId(id);
        if (t) { t.w = beforeW; t.h = beforeH; t.bbox = entityBbox(t); }
      },
    });
  }

  /** 頂點編輯：拖動線段端點改變形狀（before/after 為整條實體的 pts 快照） */
  commitGeometry(id: string, beforePts: number[], afterPts: number[]) {
    // 無變化則不記錄（避免單擊錨點未拖動也產生空歷史，讓雙擊刪錨點的 undo 乾淨）
    if (beforePts.length === afterPts.length) {
      let same = true;
      for (let i = 0; i < beforePts.length; i++) {
        if (beforePts[i] !== afterPts[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    const self = this;
    this.push(
      {
        label: "編輯頂點",
        undo: () => {
          const e = self.byId(id);
          if (e) {
            e.pts = beforePts.slice();
            e.bbox = entityBbox(e);
          }
        },
        redo: () => {
          const e = self.byId(id);
          if (e) {
            e.pts = afterPts.slice();
            e.bbox = entityBbox(e);
          }
        },
      },
      false // 已改到 afterPts，不再執行 redo
    );
  }

  /** 在線段/折線/矩形上插入錨點（undoable） */
  insertVertex(id: string, x: number, y: number, segIndex: number) {
    const e = this.byId(id);
    if (!e) return;
    if (e.kind === "text" || e.kind === "arc" || e.kind === "ellipse" || e.kind === "star" || e.kind === "trapezoid") return;
    const before = e.pts.slice();
    // 在 segIndex 段的末端插入新點（第 segIndex+1 個頂點位置）
    const insertAt = segIndex + 1;
    e.pts.splice(insertAt * 2, 0, x, y);
    e.bbox = entityBbox(e);
    const self = this;
    this.push(
      {
        label: "新增錨點",
        undo: () => {
          const t = self.byId(id);
          if (t) {
            t.pts = before.slice();
            t.bbox = entityBbox(t);
          }
        },
        redo: () => {
          const t = self.byId(id);
          if (t) {
            const p = before.slice();
            p.splice(insertAt * 2, 0, x, y);
            t.pts = p;
            t.bbox = entityBbox(t);
          }
        },
      },
      false // 已改到 after，不再執行 redo
    );
  }

  /** 刪除折線/矩形/多邊形上的錨點（undoable）。封閉至少保留 3 點、開放至少 2 點 */
  removeVertex(id: string, vi: number) {
    const e = this.byId(id);
    if (!e) return;
    if (e.kind === "text" || e.kind === "arc" || e.kind === "ellipse" || e.kind === "star" || e.kind === "trapezoid") return;
    const n = e.pts.length / 2;
    const min = e.closed ? 3 : 2;
    if (n <= min) return;
    const before = e.pts.slice();
    e.pts.splice(vi * 2, 2);
    e.bbox = entityBbox(e);
    const self = this;
    this.push(
      {
        label: "刪除錨點",
        undo: () => {
          const t = self.byId(id);
          if (t) {
            t.pts = before.slice();
            t.bbox = entityBbox(t);
          }
        },
        redo: () => {
          const t = self.byId(id);
          if (t) {
            const p = before.slice();
            p.splice(vi * 2, 2);
            t.pts = p;
            t.bbox = entityBbox(t);
          }
        },
      },
      false // 已就地刪除，不再執行 redo
    );
  }

  /** 直線轉為弧線（產生預設弧度控制點，之後可拖動控制點調整），undoable */
  lineToArc(id: string) {
    const e = this.byId(id);
    if (!e || e.kind !== "line" || e.pts.length !== 4) return;
    const beforeKind = e.kind;
    const beforePts = e.pts.slice();
    const ctrl = defaultArcCtrl([e.pts[0], e.pts[1]], [e.pts[2], e.pts[3]]);
    e.kind = "arc";
    e.pts = [e.pts[0], e.pts[1], ctrl[0], ctrl[1], e.pts[2], e.pts[3]];
    e.bbox = entityBbox(e);
    const self = this;
    this.push(
      {
        label: "調整弧度",
        undo: () => {
          const t = self.byId(id);
          if (t) {
            t.kind = beforeKind;
            t.pts = beforePts.slice();
            t.bbox = entityBbox(t);
          }
        },
        redo: () => {
          const t = self.byId(id);
          if (t) {
            t.kind = "arc";
            t.pts = [beforePts[0], beforePts[1], ctrl[0], ctrl[1], beforePts[2], beforePts[3]];
            t.bbox = entityBbox(t);
          }
        },
      },
      false // 已就地轉換，不再執行 redo
    );
  }

  /** 「調整弧度」拖動結束：直線→弧線（kind+pts 都變了），記錄完整快照供 undo */
  commitBend(id: string, beforeKind: VecEntity["kind"], beforePts: number[], afterPts: number[]) {
    const self = this;
    this.push(
      {
        label: "調整弧度",
        undo: () => {
          const e = self.byId(id);
          if (e) {
            e.kind = beforeKind;
            e.pts = beforePts.slice();
            e.bbox = entityBbox(e);
          }
        },
        redo: () => {
          const e = self.byId(id);
          if (e) {
            e.kind = "arc";
            e.pts = afterPts.slice();
            e.bbox = entityBbox(e);
          }
        },
      },
      false
    );
  }

  /** 彎曲箭頭弧度拖動結束，記錄為可 undo 的指令（拖動中已直接改 e.bend） */
  commitArrowBend(id: string, beforeBend: number | undefined) {
    const e = this.byId(id);
    if (!e) return;
    const after = e.bend;
    if (beforeBend === after) return;
    const self = this;
    this.push(
      {
        label: "箭頭弧度",
        undo: () => {
          const en = self.byId(id);
          if (en) {
            en.bend = beforeBend;
            en.bbox = entityBbox(en);
          }
        },
        redo: () => {
          const en = self.byId(id);
          if (en) {
            en.bend = after;
            en.bbox = entityBbox(en);
          }
        },
      },
      false
    );
  }

  /** 新增實體 */
  addEntity(e: VecEntity) {
    if (!this.doc) return;
    this.push({
      label: "新增",
      redo: () => {
        this.doc!.entities.push(e);
      },
      undo: () => {
        const i = this.doc!.entities.indexOf(e);
        if (i >= 0) this.doc!.entities.splice(i, 1);
      },
    });
  }

  /** 把新畫的直線與既有直線/折線在端點處合併為一條折線（undoable）。回傳是否合併成功 */
  mergeLineIntoExisting(id: string): boolean {
    const doc = this.doc;
    if (!doc) return false;
    const e = this.byId(id);
    if (!e || e.kind !== "line" || e.pts.length !== 4) return false;

    let target: VecEntity | null = null;
    let mergedPts: number[] | null = null;
    for (const other of doc.entities) {
      if (other.id === id) continue;
      if (other.kind !== "line" && other.kind !== "polyline") continue;
      if (other.origin !== e.origin || other.layerId !== e.layerId) continue;
      const pts = mergeLinePts(e, other);
      if (pts) {
        target = other;
        mergedPts = pts;
        break;
      }
    }
    if (!target || !mergedPts) return false;

    const other = target;
    const otherId = other.id;
    const mergedEntity: VecEntity = {
      id: otherId,
      kind: "polyline",
      pts: mergedPts,
      closed: false,
      stroke: other.stroke,
      width: other.width,
      dash: other.dash,
      fill: other.fill,
      origin: other.origin,
      layerId: other.layerId,
    };
    const self = this;
    this.push({
      label: "合併線段",
      redo: () => {
        const d = self.doc!;
        d.entities = d.entities.filter((x) => x.id !== id && x.id !== otherId);
        d.entities.push(mergedEntity);
        // 選取同步：新線/舊線若被選取，改為選取合併後實體
        if (self.selection.has(id) || self.selection.has(otherId)) {
          self.selection.delete(id);
          self.selection.delete(otherId);
          self.selection.add(otherId);
        }
      },
      undo: () => {
        const d = self.doc!;
        d.entities = d.entities.filter((x) => x.id !== otherId);
        d.entities.push(other, e);
      },
    });
    return true;
  }

  // ---------- 群組（組件） ----------
  /** 找出與 ids 相關聯的完整群組成員（ids 本身 + 同組全部圖元） */
  expandGroups(ids: string[]): string[] {
    if (!this.doc) return ids;
    const gidSet = new Set<string>();
    for (const id of ids) {
      const e = this.doc.entities.find((x) => x.id === id);
      if (e?.groupId) gidSet.add(e.groupId);
    }
    if (gidSet.size === 0) return ids;
    const out = new Set(ids);
    for (const e of this.doc.entities) {
      if (e.groupId && gidSet.has(e.groupId)) out.add(e.id);
    }
    return [...out];
  }

  /** 把多個圖元合為一個群組（組件），undoable */
  makeGroup(ids: string[]) {
    if (!this.doc || ids.length < 2) return;
    const members = this.expandGroups(ids)
      .map((id) => this.doc!.entities.find((x) => x.id === id))
      .filter((e): e is VecEntity => !!e);
    if (members.length < 2) return;
    const gid = "g-" + genId();
    const before = members.map((e) => ({ e, g: e.groupId }));
    this.push({
      label: "群組",
      redo: () => before.forEach(({ e }) => (e.groupId = gid)),
      undo: () => before.forEach(({ e, g }) => (e.groupId = g)),
    });
    this.selection = new Set(members.map((e) => e.id));
  }

  /** 解散選取所涉群組，undoable */
  ungroup(ids: string[]) {
    if (!this.doc) return;
    const touched = this.expandGroups(ids)
      .map((id) => this.doc!.entities.find((x) => x.id === id))
      .filter((e): e is VecEntity => !!e && !!e.groupId);
    if (touched.length === 0) return;
    const before = touched.map((e) => ({ e, g: e.groupId }));
    this.push({
      label: "解除群組",
      redo: () => before.forEach(({ e }) => (e.groupId = undefined)),
      undo: () => before.forEach(({ e, g }) => (e.groupId = g)),
    });
  }

  /** 刪除實體 */
  removeEntities(ids: string[]) {
    if (!this.doc || ids.length === 0) return;
    const removed: VecEntity[] = [];
    for (const id of ids) {
      const e = this.byId(id);
      if (e) removed.push(e);
    }
    if (removed.length === 0) return;
    const set = new Set(removed);
    // 本次刪除後會變空的「自動標註圖層」（user-N，由 ensureDrawLayer 建立）一併移除，undo 時還原
    const affected = new Set(removed.map((e) => e.layerId));
    const removedLayers: Layer[] = [];
    for (const l of this.doc.layers) {
      if (!l.id.startsWith("user-")) continue;
      if (!affected.has(l.id)) continue;
      const hasOther = this.doc!.entities.some((e) => e.layerId === l.id && !set.has(e));
      if (!hasOther) removedLayers.push(l);
    }
    const removedLayerIds = new Set(removedLayers.map((l) => l.id));
    this.push({
      label: "刪除",
      redo: () => {
        const d = this.doc!;
        d.entities = d.entities.filter((e) => !set.has(e));
        if (removedLayerIds.size) d.layers = d.layers.filter((l) => !removedLayerIds.has(l.id));
      },
      undo: () => {
        const d = this.doc!;
        d.entities.push(...removed);
        if (removedLayers.length) d.layers.push(...removedLayers);
      },
    });
    this.selection.clear();
  }

  /** 更新樣式（顏色/線寬/虛線/填充/無邊框/文字塊樣式）；改描邊色時同步所屬圖層色塊 */
  updateStyle(id: string, patch: Partial<Pick<VecEntity, "stroke" | "width" | "dash" | "fill" | "noStroke" | "headScale" | "arrowStyle" | "bend" | "bgColor" | "bgOpacity" | "fontFamily" | "borderColor" | "borderWidth" | "vertical">>) {
    const e = this.byId(id);
    if (!e) return;
    const before = { stroke: e.stroke, width: e.width, dash: e.dash, fill: e.fill, noStroke: e.noStroke, headScale: e.headScale, arrowStyle: e.arrowStyle, bend: e.bend, bgColor: e.bgColor, bgOpacity: e.bgOpacity, fontFamily: e.fontFamily, borderColor: e.borderColor, borderWidth: e.borderWidth, vertical: e.vertical };
    // 文字塊樣式變更需重算 bbox（底色/邊框塊與選取框對齊）；箭頭樣式變更同理（彎曲/直角路徑超出起訖連線）
    const textKeys = ["bgColor", "bgOpacity", "fontFamily", "borderColor", "borderWidth", "vertical"] as const;
    const isTextStyle =
      (textKeys.some((k) => k in patch) && e.kind === "text") ||
      (("arrowStyle" in patch || "headScale" in patch || "bend" in patch) && e.kind === "arrow");
    // 直書切換：橫書錨點=baseline（文字在錨點上方）、直書錨點=頂端（文字在錨點下方）。
    // 切換時平移錨點讓文字塊「原地轉向」不跳位；undo/redo 以增量回滾（與拖移命令相容）。
    let anchorDy = 0;
    if (e.kind === "text" && "vertical" in patch && !!patch.vertical !== !!e.vertical) {
      const fs = e.fontSize ?? 12;
      anchorDy = patch.vertical ? -fs : fs;
    }
    // 圖層色塊跟隨實體描邊色（與 ensureDrawLayer 的前景色跟隨行為一致）
    const layer = patch.stroke ? this.doc?.layers.find((l) => l.id === e.layerId) : undefined;
    const layerBefore = layer?.color;
    const layerAfter = patch.stroke;
    this.push({
      label: "樣式",
      redo: () => {
        Object.assign(e, patch);
        if (anchorDy) e.pts[1] += anchorDy;
        if (isTextStyle) e.bbox = entityBbox(e);
        if (layer && layerAfter) layer.color = layerAfter;
      },
      undo: () => {
        Object.assign(e, before);
        if (anchorDy) e.pts[1] -= anchorDy;
        if (isTextStyle) e.bbox = entityBbox(e);
        if (layer && layerBefore) layer.color = layerBefore;
      },
    });
  }

  /** 編輯文字內容 */
  editText(id: string, text: string) {
    const e = this.byId(id);
    if (!e || e.kind !== "text") return;
    const before = e.text;
    this.push({
      label: "文字",
      redo: () => { e.text = text; e.bbox = entityBbox(e); },
      undo: () => { e.text = before; e.bbox = entityBbox(e); },
    });
  }

  /** 修改文字字號 */
  resizeText(id: string, size: number) {
    const e = this.byId(id);
    if (!e || e.kind !== "text") return;
    const before = e.fontSize;
    this.push({
      label: "字號",
      redo: () => { e.fontSize = size; e.bbox = entityBbox(e); },
      undo: () => { e.fontSize = before; e.bbox = entityBbox(e); },
    });
  }

  // ---------- 圖層 ----------
  setLayerVisible(id: string, visible: boolean) {
    if (!this.doc) return;
    const layer = this.doc.layers.find((l) => l.id === id);
    if (layer) layer.visible = visible;
    this.emit();
  }
  setLayerLocked(id: string, locked: boolean) {
    if (!this.doc) return;
    const layer = this.doc.layers.find((l) => l.id === id);
    if (layer) layer.locked = locked;
    this.emit();
  }
  /** 設定距離標註比例（1 world pt = 多少公尺）；傳 undefined / 非正數 = 清除比例。非 undoable（同顯隱/鎖定） */
  setScale(metersPerPt: number | undefined) {
    if (!this.doc) return;
    const after = metersPerPt !== undefined && metersPerPt > 0 ? metersPerPt : undefined;
    if (this.doc.metersPerPt === after) return;
    this.doc.metersPerPt = after;
    this.emit();
  }
  /** 設定距離標註的實際長度（公尺）：依已校正比例換算成 pt，縮放終點（保持起點與方向不變），undoable。
   *  未校正比例（無 metersPerPt）或長度非正數時不動作並回傳 false。 */
  setDimensionMeters(id: string, meters: number): boolean {
    const e = this.byId(id);
    if (!e || e.kind !== "dimension" || e.pts.length < 4) return false;
    const mpp = this.doc?.metersPerPt;
    if (!mpp || mpp <= 0 || !(meters > 0)) return false;
    const x0 = e.pts[0], y0 = e.pts[1], x1 = e.pts[2], y1 = e.pts[3];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-9) return false;
    const target = meters / mpp;
    if (Math.abs(target - len) < 1e-9) return false;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    const beforePts = e.pts.slice();
    const afterPts = [x0, y0, x0 + ux * target, y0 + uy * target];
    const self = this;
    this.push({
      label: "設定長度",
      redo: () => {
        const t = self.byId(id);
        if (t) { t.pts = afterPts.slice(); t.bbox = entityBbox(t); }
      },
      undo: () => {
        const t = self.byId(id);
        if (t) { t.pts = beforePts.slice(); t.bbox = entityBbox(t); }
      },
    });
    return true;
  }
  /** 設定單一圖層不透明度（0–1），undoable；連續調整同一圖層會合併為一步（避免滑桿拖動產生大量步驟） */
  setLayerOpacity(id: string, opacity: number) {
    if (!this.doc) return;
    const layer = this.doc.layers.find((l) => l.id === id);
    if (!layer) return;
    const before = layer.opacity;
    const after = Math.max(0, Math.min(1, opacity));
    if (before === after) return;
    // 上一步是同一圖層的「圖層不透明度」→ 合併（更新目標值），不新增 undo 步
    const top = this.undoStack[this.undoStack.length - 1] as (Command & { opId?: string; opAfter?: number }) | undefined;
    if (top && top.label === "圖層不透明度" && top.opId === id) {
      layer.opacity = after;
      top.opAfter = after;
      this.emit();
      return;
    }
    layer.opacity = after;
    const self = this;
    const cmd = {
      label: "圖層不透明度",
      opId: id,
      opAfter: after,
      redo: () => {
        const l = self.doc?.layers.find((x) => x.id === id);
        if (l) l.opacity = cmd.opAfter;
      },
      undo: () => {
        const l = self.doc?.layers.find((x) => x.id === id);
        if (l) l.opacity = before;
      },
    };
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.emit();
  }
  /** 批量設定多個圖層不透明度（0–1），undoable（合併為一步） */
  setLayersOpacity(ids: string[], opacity: number) {
    if (!this.doc || ids.length === 0) return;
    const after = Math.max(0, Math.min(1, opacity));
    const changed: { id: string; before?: number }[] = [];
    for (const id of ids) {
      const l = this.doc.layers.find((x) => x.id === id);
      if (!l || l.opacity === after) continue;
      changed.push({ id, before: l.opacity });
    }
    if (changed.length === 0) return;
    const self = this;
    this.push({
      label: "圖層不透明度",
      redo: () => {
        for (const { id } of changed) {
          const l = self.doc?.layers.find((x) => x.id === id);
          if (l) l.opacity = after;
        }
      },
      undo: () => {
        for (const { id, before } of changed) {
          const l = self.doc?.layers.find((x) => x.id === id);
          if (l) l.opacity = before;
        }
      },
    });
  }
  /** 批量鎖定/解鎖多個圖層 */
  setLayersLocked(ids: string[], locked: boolean) {
    if (!this.doc || ids.length === 0) return;
    for (const id of ids) {
      const layer = this.doc.layers.find((l) => l.id === id);
      if (layer) layer.locked = locked;
    }
    this.emit();
  }
  /** 合併多個圖層：實體併入第一個圖層，其餘圖層刪除（undoable） */
  mergeLayers(ids: string[]): boolean {
    if (!this.doc || ids.length < 2) return false;
    const target = this.doc.layers.find((l) => l.id === ids[0]);
    if (!target) return false;
    const otherIds = new Set(ids.slice(1));
    const removedLayers = this.doc.layers.filter((l) => otherIds.has(l.id));
    // 記錄受影響實體（原 layerId），供 undo 還原
    const changed: { e: VecEntity; from: string }[] = [];
    for (const e of this.doc.entities) {
      if (otherIds.has(e.layerId)) changed.push({ e, from: e.layerId });
    }
    const prevActive = this.activeLayerId;
    const self = this;
    this.push({
      label: "合併圖層",
      redo: () => {
        for (const { e } of changed) e.layerId = target.id;
        self.doc!.layers = self.doc!.layers.filter((l) => !otherIds.has(l.id));
        if (self.activeLayerId && otherIds.has(self.activeLayerId)) self.activeLayerId = target.id;
      },
      undo: () => {
        for (const { e, from } of changed) e.layerId = from;
        self.doc!.layers.push(...removedLayers);
        self.activeLayerId = prevActive;
      },
    });
    return true;
  }

  /** 刪除一個或多個圖層（連同其下所有實體一併刪除），undoable */
  deleteLayers(ids: string[]): boolean {
    if (!this.doc || ids.length === 0) return false;
    const idSet = new Set(ids);
    // 記錄要刪除的圖層（含原始索引，供 undo 依序還原）
    const removedLayers: { layer: Layer; index: number }[] = [];
    this.doc.layers.forEach((l, i) => {
      if (idSet.has(l.id)) removedLayers.push({ layer: l, index: i });
    });
    if (removedLayers.length === 0) return false;
    // 這些圖層下的實體
    const removedEntities = this.doc.entities.filter((e) => idSet.has(e.layerId));
    const removedEntitySet = new Set(removedEntities);
    // 快照圖層組（刪除後可能出現空組，需一併清理並在 undo 還原）
    const beforeGroups = (this.doc.layerGroups ?? []).slice();
    const prevActive = this.activeLayerId;
    const self = this;
    this.push({
      label: "刪除圖層",
      redo: () => {
        const d = self.doc!;
        d.entities = d.entities.filter((e) => !removedEntitySet.has(e));
        d.layers = d.layers.filter((l) => !idSet.has(l.id));
        // 清理變成空的圖層組
        const remainGroupIds = new Set(
          d.layers.map((l) => l.groupId).filter((g): g is string => !!g)
        );
        d.layerGroups = (d.layerGroups ?? []).filter((g) => remainGroupIds.has(g.id));
        if (self.activeLayerId && idSet.has(self.activeLayerId)) self.activeLayerId = null;
        for (const e of removedEntities) self.selection.delete(e.id);
      },
      undo: () => {
        const d = self.doc!;
        for (const { layer, index } of removedLayers) {
          d.layers.splice(Math.min(index, d.layers.length), 0, layer);
        }
        d.entities.push(...removedEntities);
        d.layerGroups = beforeGroups;
        self.activeLayerId = prevActive;
      },
    });
    return true;
  }

  /** 複製一個或多個圖層（連同其下所有實體複製一份），undoable。
   *  新圖層插在來源圖層正下方（面板顯示於來源下一列、堆疊上在來源下方），
   *  沿用來源圖層的 color/width/visible/locked/isFill/opacity/groupId；名稱加「 複製」後綴。 */
  duplicateLayers(ids: string[]): boolean {
    if (!this.doc || ids.length === 0) return false;
    const idSet = new Set(ids);
    const srcLayers = this.doc.layers.filter((l) => idSet.has(l.id));
    if (srcLayers.length === 0) return false;

    // 新圖層 id 沿用 user-N 流水號（與 repairLayerIds / ensureDrawLayer 同規則，避免撞號）
    let maxN = 0;
    for (const l of this.doc.layers) {
      const m = /^user-(\d+)$/.exec(l.id);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }

    // 預先為每個來源圖層建立「新圖層 + 複製實體」快照
    const plan: { srcId: string; newLayer: Layer; newEntities: VecEntity[] }[] = [];
    for (const src of srcLayers) {
      const newId = `user-${++maxN}`;
      const newLayer: Layer = {
        id: newId,
        name: `${src.name} 複製`,
        color: src.color,
        width: src.width,
        visible: src.visible,
        locked: src.locked,
        isFill: src.isFill,
        count: src.count,
        groupId: src.groupId,
        opacity: src.opacity,
      };
      const srcEntities = this.doc.entities.filter((e) => e.layerId === src.id);
      const newEntities: VecEntity[] = srcEntities.map((e) => {
        const copy: VecEntity = { ...e, id: genId(), layerId: newId };
        if (e.pts) copy.pts = e.pts.slice();
        return copy;
      });
      plan.push({ srcId: src.id, newLayer, newEntities });
    }

    const self = this;
    this.push({
      label: "複製圖層",
      redo: () => {
        const d = self.doc!;
        for (const p of plan) {
          const idx = d.layers.findIndex((l) => l.id === p.srcId);
          d.layers.splice(idx + 1, 0, p.newLayer);
          d.entities.push(...p.newEntities);
        }
      },
      undo: () => {
        const d = self.doc!;
        const newLayerIds = new Set(plan.map((p) => p.newLayer.id));
        d.layers = d.layers.filter((l) => !newLayerIds.has(l.id));
        const newEntityIds = new Set(plan.flatMap((p) => p.newEntities.map((e) => e.id)));
        d.entities = d.entities.filter((e) => !newEntityIds.has(e.id));
      },
    });
    return true;
  }

  /** 把多個圖層收納為一個新圖層組（PS 群組資料夾），undoable */
  groupLayers(ids: string[]): boolean {
    if (!this.doc || ids.length < 2) return false;
    const targetIds = new Set(ids);
    const groupId = "lg-" + genId();
    const n = (this.doc.layerGroups?.length ?? 0) + 1;
    const group: LayerGroup = { id: groupId, name: `群組 ${n}` };
    // 記錄受影響圖層原 groupId，供 undo 還原
    const changed: { l: Layer; from?: string }[] = [];
    for (const l of this.doc.layers) {
      if (targetIds.has(l.id)) changed.push({ l, from: l.groupId });
    }
    const self = this;
    this.push({
      label: "群組圖層",
      redo: () => {
        const d = self.doc!;
        d.layerGroups = d.layerGroups ?? [];
        d.layerGroups.push(group);
        for (const { l } of changed) l.groupId = groupId;
      },
      undo: () => {
        const d = self.doc!;
        d.layerGroups = (d.layerGroups ?? []).filter((g) => g.id !== groupId);
        for (const { l, from } of changed) l.groupId = from;
      },
    });
    return true;
  }

  /** 解散圖層組（成員圖層 groupId 清除、組移除），undoable */
  ungroupLayer(groupId: string): boolean {
    if (!this.doc) return false;
    const group = (this.doc.layerGroups ?? []).find((g) => g.id === groupId);
    if (!group) return false;
    const changed: { l: Layer; from?: string }[] = [];
    for (const l of this.doc.layers) {
      if (l.groupId === groupId) changed.push({ l, from: l.groupId });
    }
    const self = this;
    this.push({
      label: "解散群組",
      redo: () => {
        const d = self.doc!;
        d.layerGroups = (d.layerGroups ?? []).filter((g) => g.id !== groupId);
        for (const { l } of changed) l.groupId = undefined;
      },
      undo: () => {
        const d = self.doc!;
        d.layerGroups = d.layerGroups ?? [];
        d.layerGroups.push(group);
        for (const { l, from } of changed) l.groupId = from;
      },
    });
    return true;
  }

  /** 圖層組整體顯隱（遍歷成員圖層，非 undoable，與單層顯隱一致） */
  setGroupVisible(groupId: string, visible: boolean) {
    if (!this.doc) return;
    for (const l of this.doc.layers) {
      if (l.groupId === groupId) l.visible = visible;
    }
    this.emit();
  }

  /** 圖層組整體鎖定/解鎖 */
  setGroupLocked(groupId: string, locked: boolean) {
    if (!this.doc) return;
    for (const l of this.doc.layers) {
      if (l.groupId === groupId) l.locked = locked;
    }
    this.emit();
  }

  /** 重新命名圖層（面板雙擊名稱），undoable */
  renameLayer(id: string, name: string) {
    const layer = this.doc?.layers.find((l) => l.id === id);
    if (!layer) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === layer.name) return;
    const before = layer.name;
    const self = this;
    this.push({
      label: "重新命名圖層",
      redo: () => {
        const l = self.doc?.layers.find((x) => x.id === id);
        if (l) l.name = trimmed;
      },
      undo: () => {
        const l = self.doc?.layers.find((x) => x.id === id);
        if (l) l.name = before;
      },
    });
  }

  /**
   * 拖曳排序圖層（= 調整上下層）：把 draggedId 移到 targetId 的 above/below。
   * 順序定義：doc.layers 陣列順序 = 圖層面板顯示順序，index 0 = 最上層。
   * 同時採用 target 的所屬群組：拖到群組成員旁 = 加入該群組；拖到未分組圖層旁 = 移出群組。
   * undoable（快照整個 layers 陣列 + 被拖圖層的 groupId）。
   */
  reorderLayer(draggedId: string, targetId: string, place: "above" | "below"): boolean {
    const doc = this.doc;
    if (!doc || draggedId === targetId) return false;
    const from = doc.layers.findIndex((l) => l.id === draggedId);
    if (from < 0) return false;
    const target = doc.layers.find((l) => l.id === targetId);
    if (!target) return false;
    const before = doc.layers.slice();
    const beforeGroup = doc.layers[from].groupId;
    const afterGroup = target.groupId;
    const layers = doc.layers.slice();
    const [moved] = layers.splice(from, 1);
    const idx = layers.findIndex((l) => l.id === targetId);
    layers.splice(place === "above" ? idx : idx + 1, 0, moved);
    // 無變化（位置與群組都沒動）就不產生歷史步
    if (
      before.length === layers.length &&
      before.every((l, i) => l.id === layers[i].id) &&
      beforeGroup === afterGroup
    ) {
      return false;
    }
    const self = this;
    this.push({
      label: "調整圖層順序",
      redo: () => {
        self.doc!.layers = layers;
        moved.groupId = afterGroup;
      },
      undo: () => {
        self.doc!.layers = before;
        moved.groupId = beforeGroup;
      },
    });
    return true;
  }

  /** 拖到群組標題：把圖層移入群組（插在群組最上方的成員之前＝群組內最上層）；groupId=null 則移出群組。undoable */
  moveLayerToGroup(draggedId: string, groupId: string | null): boolean {
    const doc = this.doc;
    if (!doc) return false;
    const from = doc.layers.findIndex((l) => l.id === draggedId);
    if (from < 0) return false;
    const moved = doc.layers[from];
    if (moved.groupId === groupId) return false; // 已在該群組（或已未分組）
    const before = doc.layers.slice();
    const beforeGroup = moved.groupId;
    const layers = doc.layers.slice();
    layers.splice(from, 1);
    if (groupId) {
      // 插到群組第一個成員（最上層成員）之前
      const firstIdx = layers.findIndex((l) => l.groupId === groupId);
      layers.splice(firstIdx < 0 ? layers.length : firstIdx, 0, moved);
    }
    moved.groupId = groupId ?? undefined;
    const self = this;
    this.push({
      label: groupId ? "移入群組" : "移出群組",
      redo: () => {
        self.doc!.layers = layers;
        moved.groupId = groupId ?? undefined;
      },
      undo: () => {
        self.doc!.layers = before;
        moved.groupId = beforeGroup;
      },
    });
    return true;
  }

  /** 取得目前可用的繪製圖層：標註圖層若可見且未鎖定則沿用；否則自動新建一個群組外、未鎖定的標註圖層。回傳圖層 id */
  /**
   * PS 邏輯：每畫一個圖形就建立一個新圖層（群組外、未鎖定、可見）。
   * 圖層名稱依工具命名（如「矩形 3」「文字 5」），色塊跟隨前景色。
   */
  ensureDrawLayer(color = "#e53935", kindName = "標註"): string {
    if (!this.doc) return "user";
    // 依「現有 user-N 圖層的最大編號 + 1」推算流水號，避免跨重新載入後 id 撞號
    // （舊版用記憶體計數器 drawSeq，重開專案會歸零、重建 user-1 與舊層相撞 → 點一層連動另一層）
    let maxN = 0;
    for (const l of this.doc.layers) {
      const m = /^user-(\d+)$/.exec(l.id);
      if (m) {
        const v = parseInt(m[1], 10);
        if (v > maxN) maxN = v;
      }
    }
    const n = maxN + 1;
    const id = `user-${n}`;
    const layer: Layer = {
      id,
      name: `${kindName} ${n}`,
      color,
      width: 2,
      visible: true,
      locked: false,
      isFill: false,
      count: 0,
    };
    this.push({
      label: "新增圖層",
      redo: () => {
        // 新圖層放最上層（doc.layers[0] = 面板最上 = 堆疊最上層）
        this.doc!.layers.unshift(layer);
      },
      undo: () => {
        this.doc!.layers = this.doc!.layers.filter((l) => l.id !== id);
      },
    });
    return id;

  }

  visibleEntities(): VecEntity[] {
    if (!this.doc) return [];
    return orderedDrawList(this.doc);
  }

  /** 查詢實體的堆疊深度（越小越上層）；圖層不存在回傳 Number.MAX_SAFE_INTEGER */
  entityZ(e: VecEntity): number {
    if (!this.doc) return Number.MAX_SAFE_INTEGER;
    const i = this.doc.layers.findIndex((l) => l.id === e.layerId);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  }
}
