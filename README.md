# 萌樂大富翁 - 多人連線伺服器

## 這是什麼
房間建立/加入、玩家列表即時同步、斷線處理的連線地基。
內含 `/public/index.html` 測試頁面，部署後可以直接打開網址測試房間功能。

## 本機測試方式
```
npm install
npm start
```
打開瀏覽器 http://localhost:3000

---

## 部署到 Render（免費，不用信用卡）

### 步驟 1：把這個資料夾放到 GitHub
1. 到 https://github.com 註冊/登入帳號
2. 右上角 "+" → New repository，取個名字（例如 `monopoly-server`），設為 Public 或 Private 都可以，先不要勾選任何初始化選項
3. 把這整個資料夾（`monopoly-server`）上傳上去：
   - 最簡單的方式：在新建好的 repo 頁面點 "uploading an existing file"，把資料夾內所有檔案（包含 `public` 子資料夾）拖進去上傳、按 Commit
   - 或用 Git 指令（如果你電腦有裝 git）：
     ```
     cd monopoly-server
     git init
     git add .
     git commit -m "init"
     git branch -M main
     git remote add origin 你的repo網址.git
     git push -u origin main
     ```

### 步驟 2：到 Render 建立服務
1. 到 https://render.com 註冊帳號（可以用 GitHub 帳號直接登入，不用填信用卡）
2. 登入後點 "New +" → "Web Service"
3. 選擇 "Build and deploy from a Git repository"，授權連接你剛剛的 GitHub repo
4. 選到你的 `monopoly-server` repo
5. 設定畫面會自動抓到 Node.js 專案，確認以下欄位：
   - **Name**：自己取一個（會變成網址的一部分）
   - **Region**：選 Singapore 或離台灣最近的
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：選 **Free**
6. 點 "Create Web Service"，Render 會開始自動建置部署，大約 1-3 分鐘
7. 部署完成後，畫面上方會顯示一個網址，例如 `https://monopoly-server-xxxx.onrender.com`——這就是你的伺服器網址！

### 步驟 3：測試
打開剛剛那個網址（`https://xxxx.onrender.com`），應該會看到跟本機測試一樣的連線測試頁面。
自己開兩個分頁（或找朋友從別的地方打開同一個網址），試著建房/加入房，確認跨裝置也能連線成功。

### 之後要更新遊戲內容怎麼辦？
以後只要把改好的檔案重新上傳到同一個 GitHub repo（覆蓋原檔案、Commit），Render 會自動偵測到更新並重新部署，不用重新設定。

---

## 目前功能（第一階段：連線地基）
- ✅ 建立房間（產生4碼房間代碼）
- ✅ 加入房間（輸入代碼）
- ✅ 玩家列表即時同步
- ✅ 準備狀態切換
- ✅ 房主開始遊戲
- ✅ 斷線處理 + 房主自動轉移
- ✅ 即時訊息廣播（測試用，之後會換成真正遊戲事件：擲骰、走格、買地、建造進度等）

## 下一步（尚未開始）
- 把主棋盤（3D棋盤/骰子/走格/買地）改成透過這個伺服器同步，而不是本機模擬
- 建造系統的進度/倒數同步給所有玩家看
- 各個小遊戲逐一連線化
- 角色選擇整合 + 手機/電腦操作介面統一
