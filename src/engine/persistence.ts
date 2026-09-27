// ============ 專案持久化（IndexedDB 自動保存） ============
import type { PlanDoc } from "../types";
import { repairLayerIds } from "./document";

const DB_NAME = "planpad-db";
const DB_VERSION = 1;
const STORE = "projects";
const KEY = "current";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB 不可用"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 自動保存目前文件到瀏覽器（IndexedDB，結構化克隆，不經 JSON 序列化） */
export async function saveProject(doc: PlanDoc): Promise<boolean> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(doc, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch (e) {
    console.warn("[PlanPad] 自動儲存失敗", e);
    return false;
  }
}

/** 讀取上次自動保存的專案；無則回傳 null */
export async function loadProject(): Promise<PlanDoc | null> {
  try {
    const db = await openDB();
    const doc = await new Promise<PlanDoc | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as PlanDoc) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return doc;
  } catch (e) {
    console.warn("[PlanPad] 讀取上次進度失敗", e);
    return null;
  }
}

/** 清除自動保存的專案（「新建」時使用） */
export async function clearProject(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn("[PlanPad] 清除專案失敗", e);
  }
}

/** 驗證並正規化從檔案讀入的專案 JSON（防呆） */
export function normalizeProject(raw: any): PlanDoc | null {
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.entities) || !Array.isArray(raw.layers)) return null;
  if (typeof raw.pageW !== "number" || typeof raw.pageH !== "number") return null;
  const doc = raw as PlanDoc;
  // 清除舊檔快取的 bbox（舊版文字寬度為估算值），確保選取框依實際字寬重算
  for (const e of doc.entities) delete (e as { bbox?: unknown }).bbox;
  // 修復重複圖層 id（舊版流水號跨重載撞號）
  repairLayerIds(doc);
  // 補齊圖層組欄位（舊檔無此欄位）
  if (!Array.isArray(doc.layerGroups)) doc.layerGroups = [];
  // 補齊「標註」圖層（與 loadDoc 相同保證）
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
  return doc;
}
