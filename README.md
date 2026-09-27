# 北農平面圖編輯器（PlanPad）

網頁版的平面圖標註工具，專為農產品批發市場的平面圖作業設計：上傳 PDF 平面圖後，可直接在網頁上繪製標註、調整圖層上下順序、群組管理、測量與列印，最後匯出為 PNG / SVG / PDF，或存成可重開的 `.planpad` 專案檔。

線上使用：[https://deanyang1204.github.io/beinan-planpad/](https://deanyang1204.github.io/beinan-planpad/)

## 功能特色

- **PDF 匯入**：拖放或點擊「上傳 PDF」即可載入平面圖（PDF 解析全程在瀏覽器內完成，不上傳伺服器）
- **繪圖標註**：矩形、線條、箭頭（直 / 彎 / 直角 / 雙向）、文字（含直書、多行、底色）
- **圖層管理**：拖拉排序即調整上下層、拖拉加入群組、雙擊重新命名、批次刪除，皆可 undo/redo
- **旋轉與樣式**：物件任意角度旋轉（同 PS 手感）、填充樣式、底色不透明度
- **測量與列印**：標註線量測、A4 列印輸出
- **匯出**：PNG / SVG / PDF / JSON（`.planpad` 專案檔，可隨時重開繼續編輯）
- **自動儲存**：編輯內容即時存於瀏覽器 IndexedDB，關閉重開不遺失

## 技術棧

- **前端**：React 18 + TypeScript + Vite + Tailwind CSS
- **PDF 處理**：pdf.js（自訂 Web Worker，Big5 明體字型對照）與 pdf-lib
- **資料**：純前端，專案存於瀏覽器 IndexedDB，無後端

## 本機開發

```bash
npm install
npm run dev      # 啟動開發伺服器
npm run build    # 產出正式建置（dist/）
npm run preview  # 預覽正式建置
```

## 部署（GitHub Pages）

推送到 `main` 分支即自動部署（GitHub Actions）。首次使用需在倉庫 **Settings → Pages** 將來源設為 **GitHub Actions**。
