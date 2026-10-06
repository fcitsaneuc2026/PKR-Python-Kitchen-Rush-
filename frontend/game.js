const $ = (id) => document.getElementById(id);
const LANG_STORAGE = "pkr-lang";
let uiLang = localStorage.getItem(LANG_STORAGE) === "zh" ? "zh" : "en";
function t(key, vars) {
  const table = (window.PKR_I18N && (PKR_I18N[uiLang] || PKR_I18N.en)) || {};
  const fallback = (window.PKR_I18N && PKR_I18N.en) || {};
  let s = table[key] ?? fallback[key] ?? key;
  if (vars) Object.keys(vars).forEach(k => { s = String(s).split("{" + k + "}").join(String(vars[k])); });
  return s;
}
function itemPhrase(type, status) {
  const stateLabel = t("st_" + status);
  const name = t("ing_" + type);
  return uiLang === "zh" ? `${stateLabel}${name}` : `${stateLabel} ${name}`;
}
function stationDisplayName(id, station) {
  const s = station || stations[id];
  if (!s) return id;
  if (s.kind === "chest") return t("chest_" + id);
  if (s.role === "pan") return t("cookingPan");
  if (s.role === "cuttingBoard") return t("cuttingBoard");
  if (s.kind === "wash") return t("washingStation");
  if (s.kind === "plate") return t("plateStation");
  if (s.kind === "serve") return t("serveCounter");
  return s.label;
}

function usesRichHover(station) {
  return !!station && (station.kind === "plate" || station.role === "pan" || station.role === "cuttingBoard");
}

let hoveredStationId = null;

function fillStationHoverCard(id, station) {
  const title = $("stationHoverTitle");
  const note = $("stationHoverNote");
  const mats = $("stationHoverMaterials");
  if (!title || !note || !mats) return;
  title.textContent = stationDisplayName(id, station);
  mats.innerHTML = "";
  mats.hidden = true;
  if (station.kind === "plate") {
    const items = station.work?.items || [];
    if (!items.length) {
      note.textContent = t("plateWaiting");
    } else {
      note.textContent = station.work?.phase === "complete" ? t("plateComplete") : t("plateHasItems");
      mats.hidden = false;
      items.forEach(item => {
        const visual = ingredientInfo[item.type]?.states?.[item.status];
        if (!visual?.image) return;
        const img = document.createElement("img");
        img.src = visual.image;
        img.alt = itemPhrase(item.type, item.status);
        mats.appendChild(img);
      });
    }
    return;
  }
  if (station.role === "pan") {
    note.textContent = t("panCookTime");
    return;
  }
  note.textContent = t("boardCutTime");
}

function positionStationHoverCard(station) {
  const card = $("stationHoverCard");
  const stage = document.querySelector("#gameScreen .pkr-game-stage");
  const canvas = state.phaser?.canvas;
  if (!card || !stage || !canvas) return;
  const stageRect = stage.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const cx = (canvasRect.left - stageRect.left) + station.x * (canvasRect.width / 480);
  const cy = (canvasRect.top - stageRect.top) + station.y * (canvasRect.height / 480);
  card.style.left = `${cx}px`;
  card.style.top = `${cy}px`;
  card.classList.toggle("is-left", Number(station.column) >= 7);
}

function showStationHoverCard(id, station) {
  hoveredStationId = id;
  const card = $("stationHoverCard");
  if (!card) return;
  fillStationHoverCard(id, station);
  positionStationHoverCard(station);
  card.hidden = false;
}

function hideStationHoverCard() {
  hoveredStationId = null;
  const card = $("stationHoverCard");
  if (card) card.hidden = true;
}

function refreshHoveredStationCard() {
  if (!hoveredStationId) return;
  const station = stations[hoveredStationId];
  if (!station) { hideStationHoverCard(); return; }
  fillStationHoverCard(hoveredStationId, station);
  positionStationHoverCard(station);
}

function getLesson(tab) {
  const en = GUIDE_LESSONS[tab] || GUIDE_LESSONS.movement;
  const zh = window.PKR_GUIDE_ZH && (PKR_GUIDE_ZH[tab] || PKR_GUIDE_ZH.movement);
  if (uiLang === "zh" && zh) return [zh[0], zh[1], en[2]];
  return en;
}

const state = {
  playerName: "", score: 0, ordersCompleted: 0,
  timeLimit: 600, timeLeft: 600, startedAt: null, finishedAt: null,
  running: false, pyodide: null, scene: null, player: null,
  backpack: [null, null, null, null], collectSeq: 1, floorItems: [],
  currentOrder: null, orderNumber: 1,
  items: {}, gameEnded: false, actionQueue: Promise.resolve(), pythonRunning: false, scriptStopped: false,
  dirtyPlates: 0, leaderboardReturn: "mainMenu", scoreSaved: false, quitPromptOpen: false, practice: false,
  lastEndScreen: null, leaderboardRows: null
};

// ============================================================
// 10 x 10 TOP-DOWN GRID
// User-facing coordinates: bottom-left = (1,1), top-right = (10,10).
// x increases left -> right; y increases bottom -> top.
// ============================================================
const GRID_SIZE = 10;
const TILE_SIZE = 48;
const GRID_ORIGIN = { x: 24, y: 24 };

function gridToPixel(column, row) {
  const c = Number(column), r = Number(row);
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || c > 10 || r < 1 || r > 10) {
    throw new Error(t("gridRange"));
  }
  return { x: GRID_ORIGIN.x + (c - 1) * TILE_SIZE, y: GRID_ORIGIN.y + (10 - r) * TILE_SIZE };
}
function pixelToGrid(x, y) {
  return {
    column: Math.round((x - GRID_ORIGIN.x) / TILE_SIZE) + 1,
    row: 10 - Math.round((y - GRID_ORIGIN.y) / TILE_SIZE)
  };
}

const stations = {
  // Ingredient chests sit on the top table row.
  lettuce: { column: 1, row: 10, ...gridToPixel(1, 10), label: "Lettuce Chest", kind: "chest", closedTexture: "lettuceChestClosed", openTexture: "lettuceChestOpened" },
  tomato: { column: 2, row: 10, ...gridToPixel(2, 10), label: "Tomato Chest", kind: "chest", closedTexture: "tomatoChestClosed", openTexture: "tomatoChestOpened" },
  bun: { column: 3, row: 10, ...gridToPixel(3, 10), label: "Bun Chest", kind: "chest", closedTexture: "bunChestClosed", openTexture: "bunChestOpened" },
  patty: { column: 4, row: 10, ...gridToPixel(4, 10), label: "Patty Chest", kind: "chest", closedTexture: "pattyChestClosed", openTexture: "pattyChestOpened" },

  // Three cooking pans.
  pan1: { column: 4, row: 4, ...gridToPixel(4, 4), label: "Cooking Pan", kind: "tool", role: "pan", frameTextures: ["panEmpty", "pan25", "pan50", "pan75", "panComplete"] },
  pan2: { column: 4, row: 5, ...gridToPixel(4, 5), label: "Cooking Pan", kind: "tool", role: "pan", frameTextures: ["panEmpty", "pan25", "pan50", "pan75", "panComplete"] },
  pan3: { column: 4, row: 6, ...gridToPixel(4, 6), label: "Cooking Pan", kind: "tool", role: "pan", frameTextures: ["panEmpty", "pan25", "pan50", "pan75", "panComplete"] },

  // Three cutting boards.
  cuttingBoard1: { column: 7, row: 4, ...gridToPixel(7, 4), label: "Cutting Board", kind: "tool", role: "cuttingBoard", frameTextures: ["boardEmpty", "board25", "board50", "board75", "boardComplete"] },
  cuttingBoard2: { column: 7, row: 5, ...gridToPixel(7, 5), label: "Cutting Board", kind: "tool", role: "cuttingBoard", frameTextures: ["boardEmpty", "board25", "board50", "board75", "boardComplete"] },
  cuttingBoard3: { column: 7, row: 6, ...gridToPixel(7, 6), label: "Cutting Board", kind: "tool", role: "cuttingBoard", frameTextures: ["boardEmpty", "board25", "board50", "board75", "boardComplete"] },

  wash: { column: 6, row: 10, ...gridToPixel(6, 10), label: "Washing Station", kind: "wash", role: "wash" },
  plate1: { column: 7, row: 10, ...gridToPixel(7, 10), label: "Plate", kind: "plate", role: "plate" },
  plate2: { column: 8, row: 10, ...gridToPixel(8, 10), label: "Plate", kind: "plate", role: "plate" },
  plate3: { column: 9, row: 10, ...gridToPixel(9, 10), label: "Plate", kind: "plate", role: "plate" },
  plate4: { column: 10, row: 10, ...gridToPixel(10, 10), label: "Plate", kind: "plate", role: "plate" },
  serve1: { column: 10, row: 1, ...gridToPixel(10, 1), label: "Serve Counter", kind: "serve", role: "serve" },
  serve2: { column: 10, row: 2, ...gridToPixel(10, 2), label: "Serve Counter", kind: "serve", role: "serve" }
};

const PLATE_FRAMES = ["burgerEmpty", "burger25", "burger50", "burger75", "burgerComplete"];
const WASH_USED_FRAMES = [null, "washUsedOne", "washUsedTwo", "washUsedThree", "washUsedFour"];
const WASH_COUNTDOWN_FRAMES = ["washCountdown3", "washCountdown2", "washCountdown1"];

function stationIdleTexture(station) {
  if (station.kind === "chest") return station.closedTexture;
  if (station.kind === "plate") {
    if (station.work?.phase === "vacant") return "burgerEmpty";
    return PLATE_FRAMES[Math.min(4, station.work?.items?.length || 0)];
  }
  if (station.kind === "wash") return washIdleTexture();
  if (station.kind === "serve") return "serveCounterSmall";
  return station.frameTextures[0];
}

function washIdleTexture() {
  const count = Math.max(0, Math.min(4, state.dirtyPlates || 0));
  return count ? WASH_USED_FRAMES[count] : "washEmpty";
}

function setStationSpriteTexture(id, textureKey, visible = true) {
  const sprite = state.scene?.stationSprites?.[id];
  if (!sprite || !textureKey) return;
  sprite.setVisible(visible);
  if (visible) {
    sprite.setTexture(textureKey);
    const rest = sprite.getData("restSize") || 44;
    sprite.setDisplaySize(rest, rest);
  }
}

function updatePlateVisual(id) {
  const station = stations[id];
  if (!station || station.kind !== "plate") return;
  if (station.work?.phase === "vacant") {
    setStationSpriteTexture(id, "burgerEmpty", false);
    return;
  }
  setStationSpriteTexture(id, stationIdleTexture(station), true);
  if (hoveredStationId === id) refreshHoveredStationCard();
}

function updateWashVisual() {
  if (stations.wash?.work?.phase === "busy") return;
  setStationSpriteTexture("wash", washIdleTexture(), true);
}

function resetStationWork() {
  state.dirtyPlates = 0;
  Object.values(stations).forEach(station => {
    if (station.kind === "tool") station.work = { phase: "empty", item: null };
    if (station.kind === "plate") station.work = { phase: "empty", items: [] };
    if (station.kind === "wash") station.work = { phase: "empty" };
  });
}
resetStationWork();

// Every table/station coordinate is a blocked player tile.
// The player must stand on an adjacent tile to use a station.
const tableCoordinates = [
  { column: 5, row: 10 },
  { column: 7, row: 10 }, { column: 8, row: 10 }, { column: 9, row: 10 }, { column: 10, row: 10 },
  { column: 4, row: 4 }, { column: 4, row: 5 }, { column: 4, row: 6 },
  { column: 7, row: 4 }, { column: 7, row: 5 }, { column: 7, row: 6 },
  { column: 4, row: 7 }, { column: 5, row: 7 }, { column: 6, row: 7 }, { column: 7, row: 7 }
];

function isBlockedCoordinate(column, row) {
  const c = Number(column), r = Number(row);
  if (tableCoordinates.some(cell => cell.column === c && cell.row === r)) return true;
  return Object.values(stations).some(station => station.column === c && station.row === r);
}

function isWalkable(column, row) {
  const c = Number(column), r = Number(row);
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || c > 10 || r < 1 || r > 10) return false;
  return !isBlockedCoordinate(c, r);
}

// Lettuce, tomato, bun, and patty can spill out of a full backpack.
// Burgers still need a free slot.
const MATERIAL_TYPES = ["bun", "patty", "lettuce", "tomato"];

function isEmptyDropTile(column, row) {
  const c = Number(column), r = Number(row);
  if (!isWalkable(c, r)) return false;
  const here = playerGrid();
  if (here.column === c && here.row === r) return false;
  return !state.floorItems.some(item => item.column === c && item.row === r);
}

// Left, right, above, or below the player. If those four tiles are blocked,
// look one tile farther along the same four directions.
function findDropTile() {
  const here = playerGrid();
  for (let radius = 1; radius < GRID_SIZE * 2; radius++) {
    const open = [
      { column: here.column - radius, row: here.row },
      { column: here.column + radius, row: here.row },
      { column: here.column, row: here.row + radius },
      { column: here.column, row: here.row - radius }
    ].filter(tile => isEmptyDropTile(tile.column, tile.row));
    if (open.length) return open[Math.floor(Math.random() * open.length)];
  }
  return null;
}

function oldestBackpackIndex(type) {
  let best = -1;
  let bestSeq = Infinity;
  state.backpack.forEach((item, index) => {
    if (!item) return;
    if (type && item.type !== type) return;
    const seq = Number.isFinite(item.seq) ? item.seq : index;
    if (seq < bestSeq) {
      bestSeq = seq;
      best = index;
    }
  });
  return best;
}

function clearFloorItems() {
  (state.floorItems || []).forEach(item => state.scene?.releaseFloorItem(item));
  state.floorItems = [];
}

function dropOnFloor(item, tile) {
  const entry = { type: item.type, status: item.status, column: tile.column, row: tile.row };
  state.floorItems.push(entry);
  state.scene?.attachFloorItem(entry);
  log(t("logDropped", { item: itemPhrase(item.type, item.status), c: tile.column, r: tile.row }));
  return entry;
}

function floorStatusText() {
  if (!state.floorItems.length) return "";
  return state.floorItems
    .map(item => `(${item.column}, ${item.row}) ${itemPhrase(item.type, item.status)}`)
    .join(", ");
}

function syncFloorItemDepth() {
  const here = playerGrid();
  state.floorItems.forEach(item => {
    const front = item.column === here.column && item.row === here.row;
    const depth = front ? 7 : 4;
    if (item.sprite?.setDepth) item.sprite.setDepth(depth);
    if (item.label?.setDepth) item.label.setDepth(depth + 1);
  });
}

function floorItemHere() {
  const here = playerGrid();
  return state.floorItems.findIndex(item => item.column === here.column && item.row === here.row);
}

function shortestPath(from, to) {
  if (from.column === to.column && from.row === to.row) return [{ column: from.column, row: from.row }];
  if (!isWalkable(to.column, to.row)) return null;
  const startKey = `${from.column},${from.row}`;
  const goalKey = `${to.column},${to.row}`;
  const parent = new Map([[startKey, null]]);
  const queue = [{ column: from.column, row: from.row }];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    const neighbors = [
      { column: current.column + 1, row: current.row },
      { column: current.column - 1, row: current.row },
      { column: current.column, row: current.row + 1 },
      { column: current.column, row: current.row - 1 }
    ];
    for (const next of neighbors) {
      const key = `${next.column},${next.row}`;
      if (parent.has(key) || !isWalkable(next.column, next.row)) continue;
      parent.set(key, current);
      if (key === goalKey) {
        const path = [next];
        let step = current;
        while (step) {
          path.push(step);
          step = parent.get(`${step.column},${step.row}`);
        }
        path.reverse();
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

function stationForRole(role) {
  const candidates = Object.values(stations).filter(station => station.role === role);
  if (!candidates.length) return null;
  return candidates.reduce((nearest, station) => {
    if (!state.player) return station;
    return distance(state.player, station) < distance(state.player, nearest) ? station : nearest;
  });
}

const assetPaths = {
  bunChestClosed: "/static/assets/bun/bun_chest_closed.png", bunChestOpened: "/static/assets/bun/bun_chest_opened.png",
  pattyChestClosed: "/static/assets/patty/patty_chest_closed.png", pattyChestOpened: "/static/assets/patty/patty_chest_opened.png",
  lettuceChestClosed: "/static/assets/lettuce/lettuce_chest_closed.png", lettuceChestOpened: "/static/assets/lettuce/lettuce_chest_opened.png",
  tomatoChestClosed: "/static/assets/tomato/tomato_chest_closed.png", tomatoChestOpened: "/static/assets/tomato/tomato_chest_opened.png",
  bunUncooked: "/static/assets/bun/bun_uncooked.png", bunCooked: "/static/assets/bun/bun_cooked.png",
  pattyUncooked: "/static/assets/patty/patty_uncooked.png", pattyCooked: "/static/assets/patty/patty_cooked.png",
  lettuceUncut: "/static/assets/lettuce/lettuce_uncut.png", lettuceChopped: "/static/assets/lettuce/lettuce_chopped.png",
  tomatoUncut: "/static/assets/tomato/tomato_uncut.png", tomatoSliced: "/static/assets/tomato/tomato_sliced.png",
  panEmpty: "/static/assets/cooking_pan/pan_empty.png", pan25: "/static/assets/cooking_pan/pan_25%25.png", pan50: "/static/assets/cooking_pan/pan_50%25.png", pan75: "/static/assets/cooking_pan/pan_75%25.png", panComplete: "/static/assets/cooking_pan/pan_complete.png",
  table: "/static/assets/table/table.png",
  boardEmpty: "/static/assets/cutting_board/cutting_board_empty.png", board25: "/static/assets/cutting_board/cutting_board_25%25.png", board50: "/static/assets/cutting_board/cutting_board_50%25.png", board75: "/static/assets/cutting_board/cutting_board_75%25.png", boardComplete: "/static/assets/cutting_board/cutting_board_complete.png",
  playerUp: "/static/assets/player/player_up.png",
  playerDown: "/static/assets/player/player_down.png",
  playerLeft: "/static/assets/player/player_left.png",
  playerRight: "/static/assets/player/player_right.png",
  burgerEmpty: "/static/assets/burger/burger_empty.png",
  burger25: "/static/assets/burger/burger_25.png",
  burger50: "/static/assets/burger/burger_50.png",
  burger75: "/static/assets/burger/burger_75.png",
  burgerComplete: "/static/assets/burger/burger_complete.png",
  washEmpty: "/static/assets/washingstation/wash_empty.png",
  washCountdown1: "/static/assets/washingstation/wash_countdown_1.png",
  washCountdown2: "/static/assets/washingstation/wash_countdown_2.png",
  washCountdown3: "/static/assets/washingstation/wash_countdown_3.png",
  washUsedOne: "/static/assets/washingstation/wash_usedplate_one.png",
  washUsedTwo: "/static/assets/washingstation/wash_usedplate_two.png",
  washUsedThree: "/static/assets/washingstation/wash_usedplate_three.png",
  washUsedFour: "/static/assets/washingstation/wash_usedplate_four.png",
  serveCounterSmall: "/static/assets/servecounter/serve_counter_small.png",
  serveCounterLarge: "/static/assets/servecounter/serve_counter_large.png"
};

const PLAYER_DISPLAY_SIZE = 52;

function playerFacingTexture(from, to) {
  const dc = Number(to.column) - Number(from.column);
  const dr = Number(to.row) - Number(from.row);
  if (dc === 0 && dr === 0) return null;
  if (Math.abs(dc) > Math.abs(dr)) return dc > 0 ? "playerRight" : "playerLeft";
  return dr > 0 ? "playerUp" : "playerDown";
}

const SCORE_PER_ORDER = 20;
const ORDER_MATERIALS = [
  { type: "bun", status: "cooked" },
  { type: "patty", status: "cooked" },
  { type: "lettuce", status: "chopped" },
  { type: "tomato", status: "sliced" }
];
const recipes = { burger: { name: "Classic Burger", ingredients: ["bun", "patty", "lettuce", "tomato"], emoji: "🍔" } };
const itemInfo = {
  bun: { label: "Bun", emoji: "🍞", raw: "🍞", cooked: "🥯" },
  patty: { label: "Patty", emoji: "🥩", raw: "🥩", cooked: "🍖" },
  lettuce: { label: "Lettuce", emoji: "🥬", raw: "🥬", cooked: "🥗" }
};

function log(message) {
  const out = $("consoleOutput");
  if (!out) return;
  out.textContent += `${message}\n`;
  out.scrollTop = out.scrollHeight;
}
function clearLog() { $("consoleOutput").textContent = ""; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function playerGrid() {
  return state.player ? pixelToGrid(state.player.x, state.player.y) : { column: 1, row: 1 };
}
function isAdjacentTo(station) {
  const g = playerGrid();
  const dc = Math.abs(g.column - Number(station.column));
  const dr = Math.abs(g.row - Number(station.row));
  return (dc === 1 && dr === 0) || (dc === 0 && dr === 1);
}
function nearStation(name) {
  if (!state.player) return false;
  const station = stations[name] || stationForRole(name);
  return !!station && isAdjacentTo(station);
}
function updateHUD() {
  $("scoreValue").textContent = state.score;
  $("ordersValue").textContent = state.ordersCompleted;
  const m = Math.floor(state.timeLeft / 60);
  const s = Math.floor(state.timeLeft % 60).toString().padStart(2, "0");
  $("timeValue").textContent = `${m}:${s}`;
  const g = state.player ? pixelToGrid(state.player.x, state.player.y) : {column:1,row:1};
  $("playerCoordinate").textContent = `(${g.column}, ${g.row})`;
  renderIngredientBackpack();
}
function renderBackpack() {
  $("backpack").innerHTML = state.backpack.map((item, i) => {
    if (!item) return `<div class="slot"><span>Slot ${i}</span>—</div>`;
    return `<div class="slot">${item.emoji}<span>${item.type}${item.status === "prepared" ? " ✓" : ""}</span></div>`;
  }).join("");
}

const ingredientInfo = {
  bun: { label: "Bun", rawStatus: "uncooked", preparedStatus: "cooked", states: { uncooked: { label: "Uncooked", image: assetPaths.bunUncooked }, cooked: { label: "Cooked", image: assetPaths.bunCooked } } },
  patty: { label: "Patty", rawStatus: "uncooked", preparedStatus: "cooked", states: { uncooked: { label: "Uncooked", image: assetPaths.pattyUncooked }, cooked: { label: "Cooked", image: assetPaths.pattyCooked } } },
  lettuce: { label: "Lettuce", rawStatus: "uncut", preparedStatus: "chopped", states: { uncut: { label: "Uncut", image: assetPaths.lettuceUncut }, chopped: { label: "Chopped", image: assetPaths.lettuceChopped } } },
  tomato: { label: "Tomato", rawStatus: "uncut", preparedStatus: "sliced", states: { uncut: { label: "Uncut", image: assetPaths.tomatoUncut }, sliced: { label: "Sliced", image: assetPaths.tomatoSliced } } },
  burger: { label: "Burger", rawStatus: "plated", preparedStatus: "plated", states: { plated: { label: "Plated", image: assetPaths.burgerComplete } } }
};

function renderIngredientBackpack() {
  $("backpack").innerHTML = state.backpack.map((item, index) => {
    if (!item) return `<div class="slot"><span>${t("slot", { n: index + 1 })}</span>-</div>`;
    const info = ingredientInfo[item.type];
    const visual = info.states[item.status];
    const phrase = itemPhrase(item.type, item.status);
    return `<div class="slot"><img src="${visual.image}" alt="${phrase}"><span>${t("ing_" + item.type)}<small>${t("st_" + item.status)}</small></span></div>`;
  }).join("");
}
function newOrder() {
  state.currentOrder = { ...recipes.burger, id: state.orderNumber++ };
}
const GUIDE_LESSONS = {
  movement: [
    "Walk on the 10 × 10 grid",
    "Bottom-left is (1, 1). Top-right is (10, 10). You can only walk on empty floor tiles. Tables and stations block the way; move_to finds the shortest path around them. You cannot stand on a table or station.",
    "move_to(3, 9)"
  ],
  take: [
    "Take from a chest",
    "Stand on an empty tile next to a chest. Lettuce is (1, 10), Tomato is (2, 10), Bun is (3, 10), and Patty is (4, 10). take() fills the next empty backpack slot and remembers pickup order. When all 4 slots are full, the new ingredient replaces the oldest one. After 1st, 2nd, 3rd, and 4th, the 5th replaces the 1st, so the backpack becomes 5th, 2nd, 3rd, 4th. The 6th replaces the 2nd: 5th, 6th, 3rd, 4th. The replaced ingredient drops on an empty tile to your left, right, above, or below. It floats for 3 seconds, fading once each second, then disappears.",
    'move_to(3, 9)\ntake("bun")'
  ],
  drop: [
    "Drop one backpack slot",
    "The backpack slots are numbered 1, 2, 3, and 4, left to right. drop_inventory(1) drops whatever is in slot 1 onto an empty tile to your left, right, above, or below. The other slots stay where they are. The item floats for 3 seconds, fading once each second. Stand on that exact tile and collect() to pick it up. Walking onto it does not pick it up.",
    "drop_inventory(1)"
  ],
  cook: [
    "Start cooking",
    "Stand on any empty tile next to a free Cooking Pan at (4, 4), (4, 5), or (4, 6): left, right, above, or below. Example for the pan at (4, 4): (5, 4), (3, 4), (4, 3), or (4, 5) if that tile is empty. You can walk away while it cooks.",
    'move_to(5, 4)\ncook("bun")'
  ],
  cut: [
    "Start cutting",
    "Stand on any empty tile next to a free Cutting Board at (7, 4), (7, 5), or (7, 6): left, right, above, or below. Example for the board at (7, 4): (8, 4), (6, 4), (7, 3), or (7, 5) if that tile is empty.",
    'move_to(8, 4)\ncut("lettuce")'
  ],
  collect: [
    "Pick up finished food",
    "Stand next to a finished pan, cutting board, or a complete burger, then collect(). To pick up a dropped ingredient, stand on its exact tile and collect(). Walking onto it does not pick it up. You stand behind it so the ingredient stays in front. If the backpack is full, that pickup replaces the oldest ingredient. A plated burger still needs an empty slot. A drop disappears after 3 seconds.",
    "move_to(7, 9)\ncollect()"
  ],
  plate: [
    "Build a burger on a plate",
    "Stand next to a plate at (7, 10), (8, 10), (9, 10), or (10, 10). plate() needs a prepared item: cooked bun, cooked patty, chopped lettuce, or sliced tomato. Four items make a complete burger.",
    'move_to(7, 9)\nplate("bun")'
  ],
  wash: [
    "Wash used plates",
    "After you serve, used plates wait at the Washing Station (6, 10). Stand next to it and wash_plate(). The sink counts down, then a clean empty plate appears on a free plate tile.",
    "move_to(6, 9)\nwash_plate()"
  ],
  serve: [
    "Serve a plated burger",
    "Stand next to the Serve Counter at (10, 1) or (10, 2) with a plated burger in the backpack, then serve(). The used plate goes to the washing station.",
    "move_to(9, 1)\nserve()"
  ],
  wait: [
    "Pause the script",
    "wait() with no number waits 1 second (the default). wait(1) is the same. wait(2) waits 2 seconds. wait(0) does not add extra time: the next line runs right away (0 seconds, like a tiny yield). Use wait while a pan or board finishes, then collect().",
    "wait()\nwait(0)\nwait(1)\nwait(2)"
  ],
  loop: [
    "Repeat commands",
    "Use repeat with a number, then indent the commands underneath, like VS Code. while True or forever keeps repeating until you click Stop Python.",
    "repeat 3:\n    move_to(3, 9)\n    move_to(2, 2)\n\nwhile True:\n    wait(1)\n\nforever:\n    status()"
  ],
  status: [
    "Check your state",
    "Shows your position, backpack contents in pickup order, ingredients still on the floor, the current order, and the materials you still need.",
    "status()"
  ]
};
const TUTORIAL_STEPS = ["movement", "take", "drop", "cook", "cut", "collect", "plate", "wash", "serve", "wait", "loop", "status"];
let tutorialIndex = 0;

function setGuide(tab) {
  const [action, text, code] = getLesson(tab);
  const activeTab = GUIDE_LESSONS[tab] ? tab : "movement";
  const content = document.querySelector("#gameScreen .guidance-content");
  const applyCopy = () => {
    $("guideAction").textContent = action;
    $("guideText").textContent = text;
    $("guideCode").textContent = code;
    document.querySelectorAll(".guide-tabs .tab").forEach(button => {
      button.classList.toggle("active", button.dataset.tab === activeTab);
    });
  };
  if (!content || content.dataset.guideTab === activeTab) {
    applyCopy();
    if (content) content.dataset.guideTab = activeTab;
    syncGuideDemo(activeTab);
    return;
  }
  content.classList.add("guide-switching");
  content.classList.remove("guide-in");
  window.setTimeout(() => {
    applyCopy();
    content.dataset.guideTab = activeTab;
    content.classList.remove("guide-switching");
    content.classList.add("guide-in");
    syncGuideDemo(activeTab);
  }, 180);
}
document.querySelectorAll(".guide-tabs .tab").forEach(button => {
  button.addEventListener("click", () => setGuide(button.dataset.tab));
});

function syncGuideDemo(tab) {
  const demo = $("guideDemo");
  const character = $("guideCharacter");
  const playable = ["movement", "take", "drop", "cook", "cut", "collect", "plate", "wash", "serve", "wait", "loop", "status"];
  if (playable.includes(tab)) {
    if (demo) demo.hidden = false;
    if (character) character.hidden = true;
    startGuideDemo(tab);
  } else {
    stopGuideDemo();
    if (demo) demo.hidden = true;
    if (character) character.hidden = false;
  }
}

const GUIDE_HOSTS = {
  game: {
    demo: "guideDemo", board: "guideMiniBoard", wrap: "guideMiniWrap", miniX: "guideMiniX",
    waitStage: "guideWaitStage", clockHand: "guideClockHand", clockLabel: "guideClockLabel",
    statusBox: "guideStatusBox", code: "guideCode"
  },
  tutorial: {
    demo: "tutorialDemo", board: "tutorialMiniBoard", wrap: "tutorialMiniWrap", miniX: "tutorialMiniX",
    waitStage: "tutorialWaitStage", clockHand: "tutorialClockHand", clockLabel: "tutorialClockLabel",
    statusBox: "tutorialStatusBox", code: "tutorialCode"
  }
};
const guideDemoPool = {
  game: { timers: [], generation: 0, player: null, item: null, cells: {}, stationImgs: {} },
  tutorial: { timers: [], generation: 0, player: null, item: null, cells: {}, stationImgs: {} }
};
let activeGuideHost = "game";
let guideDemo = guideDemoPool.game;
function ge(name) {
  return $(GUIDE_HOSTS[activeGuideHost][name]);
}
function useGuideHost(name) {
  stopGuideDemo();
  activeGuideHost = GUIDE_HOSTS[name] ? name : "game";
  guideDemo = guideDemoPool[activeGuideHost];
}

const GUIDE_HIGHLIGHTS = {
  movement: [{ column: 3, row: 9 }],
  take: [{ column: 3, row: 10 }, { column: 3, row: 9 }],
  drop: [{ column: 3, row: 9 }, { column: 3, row: 8 }],
  cook: [{ column: 4, row: 4 }, { column: 5, row: 4 }],
  cut: [{ column: 7, row: 4 }, { column: 8, row: 4 }],
  collect: [{ column: 4, row: 4 }, { column: 5, row: 4 }],
  plate: [{ column: 7, row: 10 }, { column: 7, row: 9 }],
  wash: [{ column: 6, row: 10 }, { column: 6, row: 9 }],
  serve: [{ column: 10, row: 1 }, { column: 9, row: 1 }],
  wait: [],
  loop: [{ column: 3, row: 9 }],
  status: [{ column: 2, row: 2 }]
};

function buildGuideDemo() {
  const board = ge("board");
  if (!board || board.dataset.ready) return;
  board.dataset.ready = "1";
  guideDemo.cells = {};
  guideDemo.stationImgs = {};
  for (let row = 10; row >= 1; row--) {
    for (let col = 1; col <= 10; col++) {
      const cell = document.createElement("div");
      cell.className = "guide-mini-cell";
      const key = `${col},${row}`;
      cell.dataset.key = key;
      const stationEntry = Object.entries(stations).find(([, station]) => station.column === col && station.row === row);
      if (isBlockedCoordinate(col, row)) {
        cell.classList.add("is-blocked");
        const img = document.createElement("img");
        if (stationEntry) {
          const [id, station] = stationEntry;
          img.src = assetPaths[stationIdleTexture(station)];
          img.alt = station.label;
          img.dataset.stationId = id;
          guideDemo.stationImgs[id] = img;
        } else {
          img.src = assetPaths.table;
          img.alt = "Table";
        }
        cell.appendChild(img);
      }
      board.appendChild(cell);
      guideDemo.cells[key] = cell;
    }
  }
  const player = document.createElement("img");
  player.className = "guide-mini-player";
  player.alt = "Player";
  player.src = assetPaths.playerDown;
  board.appendChild(player);
  const item = document.createElement("img");
  item.className = "guide-mini-item is-hidden";
  item.alt = "";
  board.appendChild(item);
  guideDemo.player = player;
  guideDemo.item = item;
}

function placeGuideOverlay(el, column, row) {
  if (!el) return;
  el.style.left = `${(column - 0.5) * 10}%`;
  el.style.top = `${(10.5 - row) * 10}%`;
}

function setGuidePlayer(column, row, texture) {
  placeGuideOverlay(guideDemo.player, column, row);
  if (texture && assetPaths[texture]) guideDemo.player.src = assetPaths[texture];
}

function setGuideItem(column, row, src, visible) {
  const item = guideDemo.item;
  if (!item) return;
  if (src) item.src = src;
  placeGuideOverlay(item, column, row);
  item.classList.toggle("is-hidden", !visible);
}

function setGuideStation(id, textureKey) {
  const img = guideDemo.stationImgs[id];
  if (img && assetPaths[textureKey]) {
    img.src = assetPaths[textureKey];
    img.style.visibility = "visible";
  }
}

function setGuideStationVisible(id, visible) {
  const img = guideDemo.stationImgs[id];
  if (img) img.style.visibility = visible ? "visible" : "hidden";
}

function resetGuideStations() {
  Object.entries(stations).forEach(([id, station]) => {
    if (station.kind === "chest") setGuideStation(id, station.closedTexture);
    else if (station.kind === "plate") setGuideStation(id, "burgerEmpty");
    else if (station.kind === "wash") setGuideStation(id, "washEmpty");
    else if (station.kind === "serve") setGuideStation(id, "serveCounterSmall");
    else if (station.frameTextures) setGuideStation(id, station.frameTextures[0]);
  });
}

function setGuideLayout(tab) {
  const demo = ge("demo");
  const waitStage = ge("waitStage");
  const statusBox = ge("statusBox");
  const miniWrap = ge("wrap");
  const miniX = ge("miniX");
  if (demo) {
    demo.classList.toggle("is-wait", tab === "wait");
    demo.classList.toggle("is-status", tab === "status");
  }
  if (waitStage) waitStage.hidden = tab !== "wait";
  if (statusBox) statusBox.hidden = tab !== "status";
  if (miniWrap) miniWrap.hidden = tab === "wait";
  if (miniX) miniX.hidden = tab === "wait";
}

function guideWaitSeconds() {
  const code = ge("code")?.textContent || "wait(1)";
  const ones = [...code.matchAll(/wait\(\s*([1-9]\d*(?:\.\d+)?)\s*\)/g)].map(m => Number(m[1]));
  const seconds = ones.length ? ones[0] : 1;
  return Math.max(1, Math.min(10, Math.round(seconds) || 1));
}

function setGuideClockHand(degrees, animate) {
  const hand = ge("clockHand");
  if (!hand) return;
  hand.style.transition = animate ? "transform 1s linear" : "none";
  hand.style.transform = `rotate(${degrees}deg)`;
}

async function playGuideWaitClock(alive) {
  const seconds = guideWaitSeconds();
  const label = ge("clockLabel");
  setGuideClockHand(0, false);
  if (label) label.textContent = "1";
  await waitGuide(40);
  for (let beat = 1; beat <= seconds; beat++) {
    if (!alive()) return;
    if (label) label.textContent = String(beat);
    setGuideClockHand(0, false);
    void ge("clockHand")?.offsetWidth;
    setGuideClockHand(360, true);
    await waitGuide(1000);
  }
  if (!alive()) return;
  if (label) label.textContent = t("clockDone");
  await waitGuide(700);
}

function formatGuideStatusText() {
  const g = state.player ? playerGrid() : { column: 2, row: 2 };
  const backpack = {};
  const pack = state.player ? state.backpack : [null, null, null, null];
  pack.forEach((item, index) => {
    if (!item) {
      backpack[index + 1] = t("empty");
      return;
    }
    const info = ingredientInfo[item.type];
    backpack[index + 1] = info ? itemPhrase(item.type, item.status) : item.type;
  });
  const backpackText = Object.entries(backpack).map(([slot, value]) => `${slot}: ${value}`).join(", ");
  const order = state.currentOrder || recipes.burger;
  const orderName = state.currentOrder
    ? t("orderN", { name: t("classicBurger"), id: order.id })
    : t("orderN", { name: t("classicBurger"), id: 1 });
  const needed = order?.ingredients?.length
    ? order.ingredients.join(", ")
    : "bun, patty, lettuce, tomato";
  const floor = floorStatusText();
  const floorLine = floor ? `\n${t("statusFloor", { items: floor })}` : "";
  return `${t("statusPos", { c: g.column, r: g.row })}\n${t("statusPack", { pack: backpackText })}${floorLine}\n${t("statusOrder", { order: orderName })}\n${t("statusNeed", { need: needed })}`;
}

function updateGuideStatusBox(position) {
  const box = ge("statusBox");
  if (box) box.textContent = formatGuideStatusText();
  if (position) {
    GUIDE_HIGHLIGHTS.status = [position];
    setGuideHighlights("status");
  }
}

function setGuideHighlights(tab) {
  Object.values(guideDemo.cells).forEach(cell => cell.classList.remove("is-goal"));
  (GUIDE_HIGHLIGHTS[tab] || []).forEach(({ column, row }) => {
    const cell = guideDemo.cells[`${column},${row}`];
    if (cell) cell.classList.add("is-goal");
  });
}

function stopGuideDemo() {
  guideDemo.generation += 1;
  (guideDemo.timers || []).forEach(id => clearTimeout(id));
  guideDemo.timers = [];
}

function waitGuide(ms) {
  return new Promise(resolve => {
    const id = setTimeout(resolve, ms);
    guideDemo.timers.push(id);
  });
}

async function walkGuidePath(from, to, alive) {
  const path = shortestPath(from, to);
  if (!path) return from;
  setGuidePlayer(from.column, from.row, "playerDown");
  for (let i = 0; i < path.length - 1; i++) {
    if (!alive()) return path[i];
    const next = path[i + 1];
    setGuidePlayer(next.column, next.row, playerFacingTexture(path[i], next) || "playerUp");
    await waitGuide(240);
  }
  return path[path.length - 1];
}

async function playToolFrames(id, frames, alive, stepMs) {
  for (const frame of frames) {
    if (!alive()) return;
    setGuideStation(id, frame);
    await waitGuide(stepMs);
  }
}

async function playGuideScene(tab, alive) {
  const start = { column: 2, row: 2 };
  resetGuideStations();
  setGuideHighlights(tab);
  setGuideItem(2, 2, assetPaths.bunUncooked, false);

  if (tab === "movement" || tab === "loop") {
    await walkGuidePath(start, { column: 3, row: 9 }, alive);
    return;
  }

  if (tab === "take") {
    const stand = await walkGuidePath(start, { column: 3, row: 9 }, alive);
    if (!alive()) return;
    setGuidePlayer(stand.column, stand.row, "playerUp");
    await waitGuide(220);
    setGuideStation("bun", "bunChestOpened");
    setGuideItem(3, 10, assetPaths.bunUncooked, true);
    await waitGuide(280);
    if (!alive()) return;
    setGuideItem(3, 9, assetPaths.bunUncooked, true);
    await waitGuide(380);
    setGuideStation("bun", "bunChestClosed");
    await waitGuide(500);
    return;
  }

  if (tab === "drop") {
    const stand = await walkGuidePath(start, { column: 3, row: 9 }, alive);
    if (!alive()) return;
    setGuidePlayer(stand.column, stand.row, "playerDown");
    setGuideItem(3, 9, assetPaths.bunUncooked, true);
    await waitGuide(280);
    if (!alive()) return;
    setGuideItem(3, 8, assetPaths.bunUncooked, true);
    await waitGuide(700);
    return;
  }

  if (tab === "cook") {
    const stand = await walkGuidePath(start, { column: 5, row: 4 }, alive);
    if (!alive()) return;
    setGuidePlayer(stand.column, stand.row, "playerLeft");
    setGuideItem(5, 4, assetPaths.bunUncooked, true);
    await waitGuide(280);
    setGuideItem(5, 4, assetPaths.bunUncooked, false);
    const cookPromise = playToolFrames("pan1", ["panEmpty", "pan25", "pan50", "pan75", "panComplete"], alive, 320);
    await waitGuide(280);
    if (!alive()) return;
    await walkGuidePath({ column: 5, row: 4 }, { column: 6, row: 3 }, alive);
    await cookPromise;
    return;
  }

  if (tab === "cut") {
    const stand = await walkGuidePath(start, { column: 8, row: 4 }, alive);
    if (!alive()) return;
    setGuidePlayer(stand.column, stand.row, "playerLeft");
    setGuideItem(8, 4, assetPaths.lettuceUncut, true);
    await waitGuide(280);
    setGuideItem(8, 4, assetPaths.lettuceUncut, false);
    await playToolFrames("cuttingBoard1", ["boardEmpty", "board25", "board50", "board75", "boardComplete"], alive, 320);
    return;
  }

  if (tab === "collect") {
    setGuideStation("pan1", "panComplete");
    const stand = await walkGuidePath(start, { column: 5, row: 4 }, alive);
    if (!alive()) return;
    setGuidePlayer(stand.column, stand.row, "playerLeft");
    await waitGuide(250);
    setGuideItem(4, 4, assetPaths.bunCooked, true);
    await waitGuide(280);
    if (!alive()) return;
    setGuideItem(5, 4, assetPaths.bunCooked, true);
    setGuideStation("pan1", "panEmpty");
    await waitGuide(550);
    return;
  }

  if (tab === "plate") {
    const stand = await walkGuidePath(start, { column: 7, row: 9 }, alive);
    if (!alive()) return;
    setGuidePlayer(stand.column, stand.row, "playerUp");
    const layers = [
      [assetPaths.bunCooked, "burger25"],
      [assetPaths.pattyCooked, "burger50"],
      [assetPaths.lettuceChopped, "burger75"],
      [assetPaths.tomatoSliced, "burgerComplete"]
    ];
    for (const [src, frame] of layers) {
      if (!alive()) return;
      setGuideItem(7, 9, src, true);
      await waitGuide(280);
      if (!alive()) return;
      setGuideItem(7, 9, src, false);
      setGuideStation("plate1", frame);
      await waitGuide(340);
    }
    await waitGuide(280);
    if (!alive()) return;
    setGuideItem(7, 10, assetPaths.burgerComplete, true);
    await waitGuide(260);
    setGuideItem(7, 9, assetPaths.burgerComplete, true);
    setGuideStationVisible("plate1", false);
    await waitGuide(550);
    return;
  }

  if (tab === "wash") {
    setGuideStation("wash", "washUsedOne");
    setGuideStationVisible("plate1", false);
    const stand = await walkGuidePath(start, { column: 6, row: 9 }, alive);
    if (!alive()) return;
    setGuidePlayer(stand.column, stand.row, "playerUp");
    await waitGuide(280);
    await playToolFrames("wash", ["washCountdown3", "washCountdown2", "washCountdown1"], alive, 420);
    if (!alive()) return;
    setGuideStation("wash", "washEmpty");
    setGuideStation("plate1", "burgerEmpty");
    await waitGuide(700);
    return;
  }

  if (tab === "serve") {
    setGuideStation("wash", "washEmpty");
    const stand = await walkGuidePath(start, { column: 9, row: 1 }, alive);
    if (!alive()) return;
    setGuidePlayer(stand.column, stand.row, "playerRight");
    setGuideItem(9, 1, assetPaths.burgerComplete, true);
    await waitGuide(320);
    if (!alive()) return;
    setGuideItem(10, 1, assetPaths.burgerComplete, true);
    setGuideStation("serve1", "serveCounterLarge");
    await waitGuide(320);
    if (!alive()) return;
    setGuideItem(10, 1, assetPaths.burgerComplete, false);
    setGuideStation("serve1", "serveCounterSmall");
    setGuideStation("wash", "washUsedOne");
    await waitGuide(650);
    return;
  }

  if (tab === "wait") {
    await playGuideWaitClock(alive);
    return;
  }

  if (tab === "status") {
    const g = state.player ? playerGrid() : { column: 2, row: 2 };
    const tile = isWalkable(g.column, g.row) ? g : start;
    setGuidePlayer(tile.column, tile.row, "playerDown");
    updateGuideStatusBox(tile);
    await waitGuide(1200);
  }
}

function startGuideDemo(tab) {
  buildGuideDemo();
  stopGuideDemo();
  setGuideLayout(tab);
  const gen = ++guideDemo.generation;
  if (!guideDemo.player) return;
  (async () => {
    const alive = () => guideDemo.generation === gen;
    while (alive()) {
      await playGuideScene(tab, alive);
      if (!alive()) return;
      await waitGuide(750);
    }
  })();
}

function showTutorialStep() {
  const tab = TUTORIAL_STEPS[tutorialIndex] || "movement";
  const [action, text, code] = getLesson(tab);
  if ($("tutorialStepLabel")) $("tutorialStepLabel").textContent = t("tutorialStep", { n: tutorialIndex + 1, total: TUTORIAL_STEPS.length });
  if ($("tutorialTitle")) $("tutorialTitle").textContent = action;
  if ($("tutorialText")) $("tutorialText").textContent = text;
  if ($("tutorialCode")) $("tutorialCode").textContent = code;
  const last = tutorialIndex >= TUTORIAL_STEPS.length - 1;
  if ($("tutorialNextBtn")) $("tutorialNextBtn").textContent = last ? t("done") : "→";
  startGuideDemo(tab);
}

function openTutorial() {
  tutorialIndex = 0;
  useGuideHost("tutorial");
  showScreen("tutorialScreen");
  showTutorialStep();
}

function tutorialNext() {
  if (tutorialIndex >= TUTORIAL_STEPS.length - 1) {
    leaveTutorial();
    return;
  }
  playOptionalSound("button_click");
  tutorialIndex += 1;
  showTutorialStep();
}

let currentScreenId = "mainMenu";
function leaveTutorial() {
  playOptionalSound("button_click");
  stopGuideDemo();
  useGuideHost("game");
  showScreen("mainMenu");
}

function showScreen(id) {
  ["mainMenu", "nameScreen", "gameScreen", "resultScreen", "leaderboardScreen", "tutorialScreen"].forEach(screenId => {
    const el = $(screenId); if (el) el.classList.toggle("hidden", screenId !== id);
  });
  document.body.classList.toggle("in-game", id === "gameScreen");
  if (id !== "gameScreen") hideStationHoverCard();
  window.scrollTo(0, 0);
  if (id !== currentScreenId) {
    currentScreenId = id;
    if (id === "gameScreen") stopMenuMusic();
    else startMenuMusic(true);
  }
}
function stopAudioEl(audio) {
  if (!audio) return;
  try { audio.pause(); audio.currentTime = 0; } catch (_) {}
}

const soundCache = {};
let typingClip = null;
let activeSfx = null;

function stopSfx() {
  stopAudioEl(activeSfx);
  Object.values(soundCache).forEach(stopAudioEl);
  stopAudioEl(typingClip);
  activeSfx = null;
}

function startMenuMusic(fromStart = false) {
  const music = $("menuMusic");
  if (!music) return;
  music.volume = .35;
  if (fromStart || music.paused) {
    stopAudioEl(music);
    music.play().catch(() => {});
  }
}
function stopMenuMusic() { stopAudioEl($("menuMusic")); }
function unlockMenuAudio(){ startMenuMusic(true); }

function playOptionalSound(name) {
  stopSfx();
  let audio = soundCache[name];
  if (!audio) {
    audio = new Audio(`/static/sounds/${name}.mp3`);
    audio.preload = "auto";
    audio.volume = .65;
    soundCache[name] = audio;
  }
  stopAudioEl(audio);
  activeSfx = audio;
  audio.play().catch(() => {});
}

$("playMenuBtn").addEventListener("click",()=>{playOptionalSound("button_click");showScreen("nameScreen");$("playerName").focus();});
$("menuLeaderboardBtn")?.addEventListener("click",()=>{playOptionalSound("button_click");showLeaderboard("mainMenu");});
$("menuTutorialBtn")?.addEventListener("click",()=>{playOptionalSound("button_click");openTutorial();});
$("nameBackBtn").addEventListener("click",()=>{playOptionalSound("button_click");showScreen("mainMenu");});

let typingAudioContext=null,lastTypingSoundAt=0;
function playTypingSound(){
  const now=performance.now(); if(now-lastTypingSoundAt<28)return; lastTypingSoundAt=now;
  if (!typingClip) {
    typingClip = new Audio("/static/sounds/typing.wav");
    typingClip.volume = .18;
  }
  stopAudioEl(typingClip);
  activeSfx = typingClip;
  typingClip.play().catch(() => {
    try {
      typingAudioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = typingAudioContext.createOscillator();
      const g = typingAudioContext.createGain();
      o.type = "square";
      o.frequency.value = 620;
      g.gain.setValueAtTime(.035, typingAudioContext.currentTime);
      g.gain.exponentialRampToValueAtTime(.001, typingAudioContext.currentTime + .035);
      o.connect(g);
      g.connect(typingAudioContext.destination);
      o.start();
      o.stop(typingAudioContext.currentTime + .035);
    } catch (_) {}
  });
}
$("codeEditor")?.addEventListener("keydown",e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;const k=["Backspace","Delete","Enter","Tab","Space"];if(e.key.length===1||k.includes(e.key))playTypingSound();});

function setupCodeEditor(){
  const editor=$("codeEditor");
  const nums=$("codeLineNumbers");
  if(!editor)return;
  const TAB="    ";
  const syncLineNumbers=()=>{
    if(!nums)return;
    const n=Math.max(1,editor.value.split("\n").length);
    nums.textContent=Array.from({length:n},(_,i)=>String(i+1)).join("\n");
    nums.scrollTop=editor.scrollTop;
  };
  const indentBlock=(outdent)=>{
    const start=editor.selectionStart;
    const end=editor.selectionEnd;
    const v=editor.value;
    const from=v.lastIndexOf("\n",start-1)+1;
    let to=end;
    if(to>from && v[to-1]==="\n") to-=1;
    const block=v.slice(from,to);
    const next=block.split("\n").map(line=>{
      if(outdent) return line.replace(/^(\t| {1,4})/,"");
      return TAB+line;
    }).join("\n");
    editor.value=v.slice(0,from)+next+v.slice(to);
    editor.selectionStart=from;
    editor.selectionEnd=from+next.length;
  };
  editor.addEventListener("keydown",e=>{
    if(e.key==="Tab"){
      e.preventDefault();
      playTypingSound();
      if(e.shiftKey) indentBlock(true);
      else if(editor.selectionStart!==editor.selectionEnd) indentBlock(false);
      else {
        const start=editor.selectionStart;
        const v=editor.value;
        editor.value=v.slice(0,start)+TAB+v.slice(editor.selectionEnd);
        editor.selectionStart=editor.selectionEnd=start+TAB.length;
      }
      syncLineNumbers();
      return;
    }
    if(e.key==="Enter"){
      const start=editor.selectionStart;
      const v=editor.value;
      const lineStart=v.lastIndexOf("\n",start-1)+1;
      const line=v.slice(lineStart,start);
      const indent=(line.match(/^[ \t]*/) || [""])[0];
      const extra=/:\s*$/.test(line)?TAB:"";
      e.preventDefault();
      playTypingSound();
      editor.value=v.slice(0,start)+"\n"+indent+extra+v.slice(editor.selectionEnd);
      const caret=start+1+indent.length+extra.length;
      editor.selectionStart=editor.selectionEnd=caret;
      syncLineNumbers();
      return;
    }
    if(e.ctrlKey||e.metaKey||e.altKey)return;
    const keys=["Backspace","Delete","Space"];
    if(e.key.length===1||keys.includes(e.key))playTypingSound();
  });
  editor.addEventListener("input",syncLineNumbers);
  editor.addEventListener("scroll",()=>{ if(nums) nums.scrollTop=editor.scrollTop; });
  syncLineNumbers();
}
setupCodeEditor();

class KitchenScene extends Phaser.Scene {
  constructor(){super("KitchenScene");}
  preload(){
    Object.entries(assetPaths).forEach(([key,path])=>this.load.image(key,path));
  }
  create(){
    state.scene=this; this.cameras.main.setBackgroundColor("#F4D6A0");
    this.servePulseGen={};
    this.drawKitchen();
    const start=gridToPixel(2,2); state.player={x:start.x,y:start.y};
    this.playerSprite=this.add.image(start.x,start.y,"playerDown").setDepth(5).setInteractive({ useHandCursor:true });
    this.playerSprite.setData("restSize", PLAYER_DISPLAY_SIZE);
    this.playerSprite.setData("hoverSize", Math.round(PLAYER_DISPLAY_SIZE * 1.22));
    this.applyPlayerSize();
    this.playerLabel=this.add.text(start.x,start.y-36,t("player"),{
      fontFamily:"Arial",
      fontSize:"11px",
      fontStyle:"bold",
      color:"#3A2A2A",
      backgroundColor:"#F9E6BD",
      padding:{x:4,y:2}
    }).setOrigin(.5).setDepth(6).setVisible(false);
    this.playerSprite.on("pointerover",()=>{
      this.playerLabel.setVisible(true).setAlpha(1);
      this.playerSprite.setData("hovering", true);
      this.applyPlayerSize();
    });
    this.carrySprite=this.add.image(start.x,start.y-26,"bunUncooked").setDepth(8).setVisible(false).setDisplaySize(30,30);
    this.carryFollowPlayer=false;
    this.playerSprite.on("pointerout",()=>{
      this.playerSprite.setData("hovering", false);
      this.applyPlayerSize();
      this.tweens.add({
        targets:this.playerLabel,
        alpha:0,
        duration:100,
        onComplete:()=>this.playerLabel.setVisible(false)
      });
    });
    updateHUD();
  }
  waitMs(ms){
    return new Promise(resolve=>this.time.delayedCall(ms,resolve));
  }
  syncCarryToPlayer(){
    if(!this.carrySprite?.visible||!this.carryFollowPlayer||!this.playerSprite)return;
    this.carrySprite.setPosition(this.playerSprite.x,this.playerSprite.y-26);
  }
  hideCarry(){
    this.carryFollowPlayer=false;
    this.carrySprite?.setVisible(false);
  }
  async showCarry(textureKey,where,ms){
    if(!this.carrySprite)return;
    if(textureKey)this.carrySprite.setTexture(textureKey);
    this.carrySprite.setDisplaySize(30,30);
    this.carrySprite.setVisible(true);
    if(where==="player"){
      this.carryFollowPlayer=true;
      this.syncCarryToPlayer();
    }else{
      this.carryFollowPlayer=false;
      this.carrySprite.setPosition(where.x,where.y);
    }
    await this.waitMs(ms);
  }
  applyPlayerSize(){
    if(!this.playerSprite)return;
    const size=this.playerSprite.getData("hovering")
      ? (this.playerSprite.getData("hoverSize")||PLAYER_DISPLAY_SIZE)
      : (this.playerSprite.getData("restSize")||PLAYER_DISPLAY_SIZE);
    this.playerSprite.setOrigin(0.5,0.72).setDisplaySize(size,size);
  }
  faceToward(target){
    if(!this.playerSprite||!target)return;
    const from=pixelToGrid(this.playerSprite.x,this.playerSprite.y);
    const to=target.column!=null
      ? {column:target.column,row:target.row}
      : pixelToGrid(target.x,target.y);
    const texture=playerFacingTexture(from,to);
    if(!texture)return;
    this.playerSprite.setTexture(texture);
    this.applyPlayerSize();
  }
  drawKitchen(){
    this.add.rectangle(240,240,480,480,0xF9E6BD).setStrokeStyle(4,0x8B5A3C);
    const g=this.add.graphics().setDepth(1.5);
    g.lineStyle(2,0xA07848,0.95);
    for(let i=0;i<=10;i++){
      const p=i*TILE_SIZE+0.5;
      g.lineBetween(0.5,p,479.5,p);
      g.lineBetween(p,0.5,p,479.5);
    }

    // Tables under leftover top counters and every tool. Chests and the sink stay without extra table tiles.
    this.tableSprites=[];
    tableCoordinates.forEach(({column,row})=>{
      const p=gridToPixel(column,row);
      this.tableSprites.push(
        this.add.image(p.x,p.y,"table").setDisplaySize(TILE_SIZE,TILE_SIZE).setDepth(1)
      );
    });

    this.stationSprites={};
    this.stationLabels={};
    Object.entries(stations).forEach(([id,station])=>{
      const texture=stationIdleTexture(station);
      const size=44;

      const hoverSize=Math.round(size * 1.22);
      const sprite=this.add.image(station.x,station.y,texture)
        .setOrigin(0.5)
        .setDisplaySize(size,size)
        .setDepth(2)
        .setInteractive({ useHandCursor:true });
      sprite.setData("restSize", size);
      sprite.setData("hoverSize", hoverSize);
      if(station.kind==="plate"&&station.work?.phase==="vacant") sprite.setVisible(false);

      // Labels are hidden until the player hovers the station.
      const label=this.add.text(station.x,station.y,stationDisplayName(id,station),{
        fontFamily:"Arial",
        fontSize:"11px",
        fontStyle:"bold",
        color:"#3A2A2A",
        backgroundColor:"#F9E6BD",
        padding:{x:4,y:2}
      }).setOrigin(.5).setDepth(4).setVisible(false);

      sprite.on("pointerover",()=>{
        if(usesRichHover(station)) showStationHoverCard(id,station);
        else {
          label.setVisible(true);
          label.setAlpha(1);
        }
        if(station.kind==="serve") return;
        this.tweens.killTweensOf(sprite);
        this.tweens.add({
          targets:sprite,
          displayWidth:sprite.getData("hoverSize"),
          displayHeight:sprite.getData("hoverSize"),
          duration:140,
          ease:"Back.Out"
        });
      });

      sprite.on("pointerout",()=>{
        if(station.kind!=="serve"){
          this.tweens.killTweensOf(sprite);
          this.tweens.add({
            targets:sprite,
            displayWidth:sprite.getData("restSize"),
            displayHeight:sprite.getData("restSize"),
            duration:140,
            ease:"Sine.easeOut"
          });
        }
        hideStationHoverCard();
        this.tweens.add({
          targets:label,
          alpha:0,
          duration:100,
          onComplete:()=>label.setVisible(false)
        });
      });

      this.stationSprites[id]=sprite;
      this.stationLabels[id]=label;
    });
    this.startServePulses();
  }
  movePlayerTo(x,y){
    const from=pixelToGrid(this.playerSprite.x,this.playerSprite.y);
    const target=pixelToGrid(x,y);
    if(!isWalkable(target.column,target.row))fail(t("failStandStation"));
    const path=shortestPath(from,target);
    if(!path)fail(t("failNoPath"));
    const steps=path.slice(1);
    if(!steps.length){
      state.player.x=this.playerSprite.x;
      state.player.y=this.playerSprite.y;
      syncFloorItemDepth();
      updateHUD();
      return Promise.resolve();
    }
    return steps.reduce((chain,step)=>chain.then(()=>{
      if(state.scriptStopped||state.gameEnded)return;
      return this.walkOneTile(step);
    }),Promise.resolve());
  }
  walkOneTile(step){
    const point=gridToPixel(step.column,step.row);
    this.faceToward(point);
    return new Promise(resolve=>{
      const from={x:this.playerSprite.x,y:this.playerSprite.y};
      const duration=Math.max(140,distance(from,point)*5);
      let settled=false;
      const finish=()=>{
        if(settled)return;
        settled=true;
        this.playerSprite.setPosition(point.x,point.y);
        state.player.x=point.x;
        state.player.y=point.y;
        if(this.playerLabel)this.playerLabel.setPosition(point.x,point.y-36);
        this.syncCarryToPlayer();
        syncFloorItemDepth();
        updateHUD();
        resolve();
      };
      this.tweens.add({
        targets:this.playerSprite,x:point.x,y:point.y,duration,ease:"Sine.easeInOut",
        onUpdate:()=>{
          state.player.x=this.playerSprite.x;
          state.player.y=this.playerSprite.y;
          if(this.playerLabel)this.playerLabel.setPosition(this.playerSprite.x,this.playerSprite.y-36);
          this.syncCarryToPlayer();
          updateHUD();
        },
        onComplete:finish,
        onStop:finish
      });
    });
  }
  showItemEffect(text,emoji){const t=this.add.text(state.player.x,state.player.y-34,`${emoji} ${text}`,{fontFamily:"Arial",fontSize:"14px",color:"#3A2A2A",backgroundColor:"#fff"}).setOrigin(.5);this.tweens.add({targets:t,y:t.y-22,alpha:0,duration:700,onComplete:()=>t.destroy()});}
  attachFloorItem(entry){
    const dest=gridToPixel(entry.column,entry.row);
    const key=itemTexture(entry.type,entry.status)||"bunUncooked";
    const from=state.player?{x:state.player.x,y:state.player.y-20}:dest;
    const shadow=this.add.ellipse(dest.x,dest.y+8,20,8,0x3A2A2A,0.3).setDepth(3);
    const sprite=this.add.image(from.x,from.y,key).setOrigin(0.5).setDisplaySize(32,32).setDepth(4);
    entry.shadow=shadow;
    entry.sprite=sprite;
    this.bindFloorHover(entry,dest);
    this.tweens.add({
      targets:sprite,
      x:dest.x,
      y:dest.y-16,
      duration:260,
      ease:"Quad.easeOut",
      onComplete:()=>{
        if(!state.floorItems.includes(entry)||!entry.sprite?.active)return;
        this.bobFloorItem(entry,dest);
      }
    });
    this.startFloorFade(entry);
  }
  bindFloorHover(entry,dest){
    const sprite=entry.sprite;
    if(!sprite)return;
    const rest=32;
    const hover=Math.round(rest*1.22);
    const label=this.add.text(dest.x,dest.y-46,itemPhrase(entry.type,entry.status),{
      fontFamily:"Arial",
      fontSize:"11px",
      fontStyle:"bold",
      color:"#3A2A2A",
      backgroundColor:"#F9E6BD",
      padding:{x:4,y:2}
    }).setOrigin(0.5).setDepth(8).setVisible(false);
    entry.label=label;
    sprite.setInteractive({useHandCursor:true});
    sprite.on("pointerover",()=>{
      label.setText(itemPhrase(entry.type,entry.status));
      label.setPosition(sprite.x,sprite.y-34);
      label.setVisible(true).setAlpha(1);
      entry.sizeTween?.stop();
      entry.sizeTween=this.tweens.add({
        targets:sprite,
        displayWidth:hover,
        displayHeight:hover,
        duration:140,
        ease:"Back.Out"
      });
    });
    sprite.on("pointerout",()=>{
      entry.sizeTween?.stop();
      entry.sizeTween=this.tweens.add({
        targets:sprite,
        displayWidth:rest,
        displayHeight:rest,
        duration:140,
        ease:"Sine.easeOut"
      });
      this.tweens.add({
        targets:label,
        alpha:0,
        duration:100,
        onComplete:()=>label.setVisible(false)
      });
    });
  }
  startFloorFade(entry){
    const fadeTo=(alpha)=>{
      const targets=[entry.sprite,entry.shadow].filter(node=>node?.active);
      if(!targets.length)return;
      this.tweens.add({targets,alpha,duration:450,ease:"Sine.easeOut"});
    };
    entry.fadeCalls=[1,2,3].map(second=>this.time.delayedCall(second*1000,()=>{
      if(!state.floorItems.includes(entry))return;
      if(second<3){
        fadeTo(1-second/3);
        return;
      }
      const index=state.floorItems.indexOf(entry);
      if(index!==-1)state.floorItems.splice(index,1);
      log(t("logFaded",{item:itemPhrase(entry.type,entry.status)}));
      this.releaseFloorItem(entry);
    }));
  }
  bobFloorItem(entry,dest){
    const sprite=entry.sprite;
    if(!sprite?.active)return;
    sprite.setPosition(dest.x,dest.y-16);
    this.tweens.add({
      targets:sprite,
      y:dest.y-28,
      duration:680,
      yoyo:true,
      repeat:-1,
      ease:"Sine.easeInOut"
    });
    this.tweens.add({
      targets:sprite,
      angle:360,
      duration:2400,
      repeat:-1,
      ease:"Linear"
    });
  }
  releaseFloorItem(entry){
    if(!entry)return;
    entry.fadeCalls?.forEach(call=>call.remove(false));
    entry.fadeCalls=null;
    entry.sizeTween?.stop();
    entry.sizeTween=null;
    if(entry.sprite){
      this.tweens.killTweensOf(entry.sprite);
      entry.sprite.destroy();
      entry.sprite=null;
    }
    if(entry.shadow){
      this.tweens.killTweensOf(entry.shadow);
      entry.shadow.destroy();
      entry.shadow=null;
    }
    if(entry.label){
      this.tweens.killTweensOf(entry.label);
      entry.label.destroy();
      entry.label=null;
    }
  }
  showBunChestAnimation(){
    if(!this.bunChestSprite)return;
    this.bunChestSprite.setTexture("bunChestOpen");
    this.time.delayedCall(650,()=>this.bunChestSprite?.setTexture("bunChestClosed"));
  }
  showChestAnimation(name){
    const station=stations[name],sprite=this.stationSprites?.[name];
    if(!station||!sprite)return;
    const rest=sprite.getData("restSize")||44;
    sprite.setTexture(station.openTexture);
    sprite.setDisplaySize(rest,rest);
    this.time.delayedCall(450,()=>{
      if(!sprite)return;
      sprite.setTexture(station.closedTexture);
      sprite.setDisplaySize(rest,rest);
    });
  }
  showToolAnimation(name){
    const station=stations[name] || stationForRole(name);
    if(!station)return Promise.resolve();
    const id=Object.keys(stations).find(key=>stations[key]===station);
    const sprite=this.stationSprites?.[id];
    if(!sprite)return Promise.resolve();
    const rest=sprite.getData("restSize")||44;
    sprite.setTexture(station.frameTextures[0]);
    sprite.setDisplaySize(rest,rest);
    return new Promise(resolve=>{
      station.frameTextures.slice(1).forEach((texture,index)=>{
        this.time.delayedCall((index+1)*250,()=>{
          sprite.setTexture(texture);
          sprite.setDisplaySize(rest,rest);
          if(index===station.frameTextures.length-2)resolve();
        });
      });
    });
  }
  runToolJob(id,preparedStatus){
    const station=stations[id];
    if(!station)return;
    this.showToolAnimation(id).then(()=>{
      if(!station.work||station.work.phase!=="busy")return;
      station.work.phase="ready";
      if(station.work.item)station.work.item.status=preparedStatus;
    });
  }
  resetToolVisual(id){
    const station=stations[id],sprite=this.stationSprites?.[id];
    if(!station||!sprite)return;
    const rest=sprite.getData("restSize")||44;
    sprite.setTexture(station.frameTextures[0]);
    sprite.setDisplaySize(rest,rest);
  }
  startServePulses(){
    ["serve1","serve2"].forEach(id=>this.pulseServeCounter(id));
  }
  pulseServeCounter(id){
    const sprite=this.stationSprites?.[id];
    if(!sprite)return;
    const rest=sprite.getData("restSize")||44;
    const large=Math.round(rest*1.18);
    this.servePulseGen[id]=(this.servePulseGen[id]||0)+1;
    const gen=this.servePulseGen[id];
    const beat=()=>{
      if(!sprite.active||this.servePulseGen[id]!==gen)return;
      sprite.setTexture("serveCounterSmall");
      sprite.setDisplaySize(rest,rest);
      this.tweens.add({
        targets:sprite,
        displayWidth:large,
        displayHeight:large,
        duration:420,
        yoyo:true,
        ease:"Sine.easeInOut",
        onYoyo:()=>{ if(this.servePulseGen[id]===gen) sprite.setTexture("serveCounterLarge"); },
        onComplete:()=>beat()
      });
    };
    beat();
  }
  runWashJob(){
    const station=stations.wash;
    const sprite=this.stationSprites?.wash;
    if(!station||!sprite)return;
    const rest=sprite.getData("restSize")||44;
    sprite.setVisible(true);
    WASH_COUNTDOWN_FRAMES.forEach((texture,index)=>{
      this.time.delayedCall(index*450,()=>{
        if(!sprite.active||station.work?.phase!=="busy")return;
        sprite.setTexture(texture);
        sprite.setDisplaySize(rest,rest);
      });
    });
    this.time.delayedCall(WASH_COUNTDOWN_FRAMES.length*450,()=>{
      if(!station.work||station.work.phase!=="busy")return;
      const vacant=Object.entries(stations).find(([,item])=>item.kind==="plate"&&item.work?.phase==="vacant");
      if(vacant){
        const [id,plate]=vacant;
        plate.work={phase:"empty",items:[]};
        updatePlateVisual(id);
      }
      station.work={phase:"empty"};
      updateWashVisual();
      log(t("logWashed"));
    });
  }
}

function fail(message) {
  const error = new Error(message || t("failNotAllowed"));
  error.ruleFail = true;
  throw error;
}
function stopScript(error) {
  if (state.scriptStopped) return;
  state.scriptStopped = true;
  state.scene?.hideCarry();
  const message = (error && (error.message || error.studentMessage)) || t("failNotAllowed");
  log(t("stoppedPrefix", { message }));
  log(t("fixAgain"));
  flashError();
}
function flashError() {
  const el = $("errorFlash");
  const stage = document.querySelector("#gameScreen .pkr-game-stage");
  if (el) {
    el.classList.remove("is-on");
    void el.offsetWidth;
    el.classList.add("is-on");
  }
  if (stage) {
    stage.classList.remove("is-shaking");
    void stage.offsetWidth;
    stage.classList.add("is-shaking");
  }
}
elErrorFlashCleanup();
function elErrorFlashCleanup() {
  document.addEventListener("animationend", event => {
    if (event.target && event.target.id === "errorFlash") event.target.classList.remove("is-on");
    if (event.target && event.target.classList && event.target.classList.contains("pkr-game-stage")) {
      event.target.classList.remove("is-shaking");
    }
  });
}
function backpackHasSpace() {
  return state.backpack.some(item => !item);
}
function hasPreparedMaterial(type, status) {
  return state.backpack.some(item => item && item.type === type && item.status === status);
}
function completeOrder() {
  state.ordersCompleted += 1;
  state.score += SCORE_PER_ORDER;
  updateHUD();
  window.dispatchEvent(new CustomEvent("pkr:order-complete"));
  newOrder();
}
function nearbyStations(role) {
  if (!state.player) return [];
  return Object.values(stations).filter(station => {
    if (role && station.role !== role) return false;
    return isAdjacentTo(station);
  });
}
function nearestStation(list) {
  return list.reduce((nearest, station) => distance(state.player, station) < distance(state.player, nearest) ? station : nearest);
}
function stationId(station) {
  return Object.keys(stations).find(key => stations[key] === station);
}

function addItem(type,status="raw"){
  const index=state.backpack.findIndex(x=>!x); if(index===-1)fail(t("failPackFull"));
  const info=itemInfo[type]; state.backpack[index]={type,status,emoji:status==="prepared"?info.cooked:info.raw};renderBackpack();
}
function findItem(type){return state.backpack.find(x=>x&&x.type===type);}
function removeItem(type){const i=state.backpack.findIndex(x=>x&&x.type===type);if(i===-1)fail(t("failNoItem",{type}));const item=state.backpack[i];state.backpack[i]=null;renderBackpack();return item;}
function requireNear(name, commandText){
  const station=stations[name] || stationForRole(name);
  if(!station) fail(t("failNoStation",{name}));
  if(!nearStation(name)) fail(t("failStandNext",{station:stationDisplayName(stationId(station),station),command:commandText || t("usingIt")}));
  state.scene?.faceToward(station);
  return station;
}
function requireItem(type){const item=findItem(type);if(!item)fail(t("failNoItem",{type}));return item;}

function itemTexture(type,status){
  const image=ingredientInfo[type]?.states[status]?.image;
  if(!image)return null;
  return Object.keys(assetPaths).find(key=>assetPaths[key]===image)||null;
}

function addIngredient(type,status){
  if(!ingredientInfo[type]?.states[status])fail(t("failBadItem"));
  const made={type,status,seq:state.collectSeq++};
  const index=state.backpack.findIndex(item=>!item);
  if(index!==-1){
    state.backpack[index]=made;
    renderIngredientBackpack();
    return null;
  }
  if(!MATERIAL_TYPES.includes(type))fail(t("failPackFull"));
  const oldest=oldestBackpackIndex();
  const tile=findDropTile();
  if(oldest<0||!tile)fail(t("failNoDropSpace"));
  const dropped=state.backpack[oldest];
  state.backpack[oldest]=made;
  renderIngredientBackpack();
  dropOnFloor(dropped,tile);
  return dropped;
}
function removeIngredient(type,status){
  const index=state.backpack.findIndex(item=>item&&item.type===type&&(!status||item.status===status));
  if(index===-1)fail(t("failNoThatItem",{type}));
  const item=state.backpack[index];
  state.backpack[index]=null;
  renderIngredientBackpack();
  return item;
}
function startToolWork(type,role){
  return action(async()=>{
    const info=ingredientInfo[type];
    const allowed=role==="pan"?["bun","patty"]:["lettuce","tomato"];
    const command=role==="pan"?`cook("${type}")`:`cut("${type}")`;
    if(!info||!allowed.includes(type))fail(role==="pan"?t("failCookArgs"):t("failCutArgs"));
    const nearby=nearbyStations(role);
    if(!nearby.length)fail(role==="pan"?t("failStandPan",{command}):t("failStandBoard",{command}));
    const empty=nearby.filter(station=>station.work?.phase==="empty");
    if(!empty.length)fail(role==="pan"?t("failPansBusy"):t("failBoardsBusy"));
    const rawItem=state.backpack.find(item=>item&&item.type===type&&item.status===info.rawStatus);
    if(!rawItem)fail(t("failNeedItemCmd",{item:itemPhrase(type,info.rawStatus),command}));
    const station=nearestStation(empty);
    state.scene.faceToward(station);
    removeIngredient(type,info.rawStatus);
    const tex=itemTexture(type,info.rawStatus);
    await state.scene.showCarry(tex,"player",280);
    state.scene.hideCarry();
    station.work={phase:"busy",item:{type,status:info.rawStatus}};
    const id=stationId(station);
    log(role==="pan"?t("logStartCook",{item:t("ing_"+type)}):t("logStartCut",{item:t("ing_"+type)}));
    state.scene.runToolJob(id,info.preparedStatus);
  });
}

// Every game action is queued. Cook/cut start the station and return,
// so the next Python line can run while the animation continues.
function action(fn){
  const run=state.actionQueue.then(async()=>{
    if(state.scriptStopped||state.gameEnded){
      const stopped=new Error("stopped");
      stopped.scriptStopped=true;
      throw stopped;
    }
    await fn();
  });
  state.actionQueue=run.catch(error=>{
    if(error&&error.ruleFail){
      stopScript(error);
      const stopped=new Error("stopped");
      stopped.scriptStopped=true;
      throw stopped;
    }
    if(error&&error.scriptStopped) throw error;
    throw error;
  });
  return run;
}

function executeGameCommand(name,args){
  if(state.scriptStopped){
    const stopped=new Error("stopped");
    stopped.scriptStopped=true;
    throw stopped;
  }
  if(state.gameEnded)fail(t("failRoundOver"));
  if(name==="take"){
    const type=String(args[0]);
    return action(async()=>{
      if(!MATERIAL_TYPES.includes(type))fail(t("failTakeArgs"));
      if(!backpackHasSpace()&&!findDropTile())fail(t("failNoDropSpace"));
      const station=requireNear(type, `take("${type}")`);
      const sprite=state.scene.stationSprites?.[type];
      const rest=sprite?.getData("restSize")||44;
      if(sprite){
        sprite.setTexture(station.openTexture);
        sprite.setDisplaySize(rest,rest);
      }
      const raw=ingredientInfo[type].rawStatus;
      const tex=itemTexture(type,raw);
      await state.scene.showCarry(tex,station,280);
      addIngredient(type,raw);
      await state.scene.showCarry(tex,"player",380);
      if(sprite){
        sprite.setTexture(station.closedTexture);
        sprite.setDisplaySize(rest,rest);
      }
      await state.scene.waitMs(500);
      state.scene.hideCarry();
      state.scene.showItemEffect(t("logTook",{item:itemPhrase(type,raw)}),"");
      log(t("logTook",{item:itemPhrase(type,raw)}));
    });
  }
  if(name==="drop_inventory"){
    const slot=Number(args[0]);
    return action(async()=>{
      if(!Number.isInteger(slot)||slot<1||slot>4)fail(t("failDropArgs"));
      const item=state.backpack[slot-1];
      if(!item)fail(t("failDropEmpty",{n:slot}));
      const tile=findDropTile();
      if(!tile)fail(t("failNoDropSpace"));
      state.backpack[slot-1]=null;
      renderIngredientBackpack();
      const tex=itemTexture(item.type,item.status);
      await state.scene.showCarry(tex,"player",220);
      const spot=gridToPixel(tile.column,tile.row);
      await state.scene.showCarry(tex,spot,280);
      state.scene.hideCarry();
      dropOnFloor(item,tile);
    });
  }
  if(name==="cook")return startToolWork(String(args[0]),"pan");
  if(name==="cut")return startToolWork(String(args[0]),"cuttingBoard");
  if(name==="collect"){
    return action(async()=>{
      const floorIndex=floorItemHere();
      if(floorIndex!==-1){
        const lying=state.floorItems[floorIndex];
        if(!backpackHasSpace()){
          if(!MATERIAL_TYPES.includes(lying.type))fail(t("failPackCollect"));
          if(!findDropTile())fail(t("failNoDropSpace"));
        }
        state.floorItems.splice(floorIndex,1);
        state.scene.releaseFloorItem(lying);
        const phrase=itemPhrase(lying.type,lying.status);
        const tex=itemTexture(lying.type,lying.status);
        const spot=gridToPixel(lying.column,lying.row);
        await state.scene.showCarry(tex,spot,220);
        log(t("logPickedFloor",{item:phrase,c:lying.column,r:lying.row}));
        addIngredient(lying.type,lying.status);
        await state.scene.showCarry(tex,"player",380);
        state.scene.hideCarry();
        state.scene.showItemEffect(phrase,"");
        syncFloorItemDepth();
        return;
      }
      const nearbyTools=nearbyStations("pan").concat(nearbyStations("cuttingBoard"));
      const readyTools=nearbyTools.filter(station=>station.work?.phase==="ready"&&station.work.item);
      const readyPlates=nearbyStations("plate").filter(station=>station.work?.phase==="complete");
      const ready=readyTools.concat(readyPlates);
      if(!nearbyTools.length&&!nearbyStations("plate").length)fail(t("failStandCollect"));
      if(!ready.length)fail(t("failNothingCollect"));
      const station=nearestStation(ready);
      state.scene.faceToward(station);
      if(station.kind==="plate"){
        if(!backpackHasSpace())fail(t("failPackCollect"));
        const burgerTex=itemTexture("burger","plated");
        await state.scene.showCarry(burgerTex,station,260);
        station.work={phase:"vacant",items:[]};
        updatePlateVisual(stationId(station));
        addIngredient("burger","plated");
        await state.scene.showCarry(burgerTex,"player",550);
        state.scene.hideCarry();
        state.scene.showItemEffect(t("logBurger"),"");
        log(t("logBurger"));
        return;
      }
      if(!backpackHasSpace()&&!findDropTile())fail(t("failNoDropSpace"));
      const item=station.work.item;
      const tex=itemTexture(item.type,item.status);
      await state.scene.showCarry(tex,station,280);
      addIngredient(item.type,item.status);
      station.work={phase:"empty",item:null};
      state.scene.resetToolVisual(stationId(station));
      await state.scene.showCarry(tex,"player",550);
      state.scene.hideCarry();
      const phrase=itemPhrase(item.type,item.status);
      state.scene.showItemEffect(t("logCollected",{item:phrase}),"");
      log(t("logCollected",{item:phrase}));
    });
  }
  if(name==="plate"){
    const type=String(args[0]);
    return action(async()=>{
      const info=ingredientInfo[type];
      const need=ORDER_MATERIALS.find(item=>item.type===type);
      if(!info||!need)fail(t("failPlateArgs"));
      const nearby=nearbyStations("plate").filter(station=>station.work?.phase==="empty"||station.work?.phase==="holding");
      if(!nearbyStations("plate").length)fail(t("failStandPlate",{type}));
      if(!nearby.length)fail(t("failPlateFull"));
      const prepared=state.backpack.find(item=>item&&item.type===type&&item.status===need.status);
      if(!prepared)fail(t("failNeedItemCmd",{item:itemPhrase(type,need.status),command:`plate("${type}")`}));
      const open=nearby.filter(station=>!(station.work.items||[]).some(item=>item.type===type));
      if(!open.length)fail(t("failPlateHas",{item:t("ing_"+type)}));
      const station=nearestStation(open);
      state.scene.faceToward(station);
      removeIngredient(type,need.status);
      const tex=itemTexture(type,need.status);
      await state.scene.showCarry(tex,"player",280);
      state.scene.hideCarry();
      const items=(station.work.items||[]).concat([{type,status:need.status}]);
      station.work={phase:items.length>=4?"complete":"holding",items};
      updatePlateVisual(stationId(station));
      await state.scene.waitMs(340);
      log(items.length>=4?t("logPlatedDone",{item:t("ing_"+type)}):t("logPlated",{item:t("ing_"+type)}));
    });
  }
  if(name==="wash_plate"){
    return action(async()=>{
      if(!nearbyStations("wash").length)fail(t("failStandWash"));
      if(stations.wash.work?.phase==="busy")fail(t("failWashBusy"));
      if((state.dirtyPlates||0)<1)fail(t("failNoDirty"));
      const vacant=Object.values(stations).some(station=>station.kind==="plate"&&station.work?.phase==="vacant");
      if(!vacant)fail(t("failNoVacantPlate"));
      const station=stations.wash;
      state.scene.faceToward(station);
      state.dirtyPlates-=1;
      station.work={phase:"busy"};
      log(t("logWashStart"));
      state.scene.runWashJob();
    });
  }
  if(name==="serve"){
    return action(async()=>{
      if(!nearbyStations("serve").length)fail(t("failStandServe"));
      const burger=state.backpack.find(item=>item&&item.type==="burger"&&item.status==="plated");
      if(!burger)fail(t("failNeedBurger"));
      if((state.dirtyPlates||0)>=4)fail(t("failWashFull"));
      const counter=nearestStation(nearbyStations("serve"));
      state.scene.faceToward(counter);
      removeIngredient("burger","plated");
      const burgerTex=itemTexture("burger","plated");
      await state.scene.showCarry(burgerTex,"player",320);
      const counterId=stationId(counter);
      const counterSprite=state.scene.stationSprites?.[counterId];
      const rest=counterSprite?.getData("restSize")||44;
      if(counterSprite){
        state.scene.servePulseGen[counterId]=(state.scene.servePulseGen[counterId]||0)+1;
        state.scene.tweens.killTweensOf(counterSprite);
        counterSprite.setTexture("serveCounterLarge");
        counterSprite.setDisplaySize(rest,rest);
      }
      await state.scene.showCarry(burgerTex,counter,320);
      state.scene.hideCarry();
      if(counterSprite){
        counterSprite.setTexture("serveCounterSmall");
        counterSprite.setDisplaySize(rest,rest);
        state.scene.pulseServeCounter(counterId);
      }
      state.dirtyPlates+=1;
      updateWashVisual();
      completeOrder();
      state.scene.showItemEffect(t("fxServed"),"");
      log(t("logServed",{score:SCORE_PER_ORDER}));
      log(t("logOrders",{orders:state.ordersCompleted,score:state.score}));
    });
  }
  if(name==="move_to"){
    const c=Number(args[0]),r=Number(args[1]);
    return action(async()=>{
      if(!Number.isInteger(c)||!Number.isInteger(r)||c<1||c>10||r<1||r>10)fail(t("failMoveArgs"));
      const p=gridToPixel(c,r);
      await state.scene.movePlayerTo(p.x,p.y);
      log(t("logMoved",{c,r}));
    });
  }
  if(name==="wait")return action(async()=>{
    const list=args&&typeof args.toJs==="function"?args.toJs():(args||[]);
    const raw=list[0];
    const seconds=raw===undefined||raw===null||raw===""
      ?1
      :Math.max(0,Math.min(10,Number(raw)));
    if(!Number.isFinite(seconds))fail(t("failWaitArgs"));
    if(seconds===0){
      await new Promise(r=>setTimeout(r,0));
      log(t("logWaited",{n:0}));
      return;
    }
    const end=Date.now()+seconds*1000;
    while(Date.now()<end){
      if(state.scriptStopped)return;
      await new Promise(r=>setTimeout(r,Math.min(80,end-Date.now())));
    }
    log(t("logWaited",{n:seconds}));
  });
  if(name==="status")return action(async()=>{
    const g=playerGrid();
    const backpack={};
    state.backpack.forEach((item,index)=>{
      if(!item){backpack[index+1]=t("empty");return;}
      backpack[index+1]=itemPhrase(item.type,item.status);
    });
    const backpackText=Object.entries(backpack).map(([slot,value])=>`${slot}: ${value}`).join(", ");
    const order=state.currentOrder;
    const needed=order?.ingredients?.length
      ? order.ingredients.join(", ")
      : "bun, patty, lettuce, tomato";
    const orderText=order?t("orderN",{name:t("classicBurger"),id:order.id}):t("none");
    log(t("statusPos",{c:g.column,r:g.row}));
    log(t("statusPack",{pack:backpackText}));
    const floor=floorStatusText();
    if(floor)log(t("statusFloor",{items:floor}));
    log(t("statusOrder",{order:orderText}));
    log(t("statusNeed",{need:needed}));
  });
  fail(t("failUnknown"));
}

window.execute_game_command=async(name,args)=>{
  try{return await executeGameCommand(name,args);}
  catch(error){
    if(error&&error.ruleFail){
      stopScript(error);
      throw error;
    }
    throw error;
  }
};
window.pkr_should_stop=()=>!!(state.scriptStopped||state.gameEnded);
window.pkr_yield=()=>new Promise(resolve=>setTimeout(resolve,0));

async function loadPython(){
  try{
    state.pyodide=await loadPyodide();
    await state.pyodide.runPythonAsync(`
import ast, js, re

_PKR_COMMANDS = {"move_to", "take", "drop_inventory", "cook", "cut", "collect", "plate", "wash_plate", "serve", "wait", "status"}

def __pkr_rewrite_loops(source):
    out = []
    for line in source.splitlines(True):
        match = re.match(r'^([ \\t]*)(.*?)(\\r?\\n)?$', line)
        if not match:
            out.append(line)
            continue
        indent, rest, nl = match.group(1), match.group(2).rstrip(), match.group(3) or ""
        rewritten = None
        count = re.match(r'(?i)^repeat\\s*\\(\\s*(\\d+|[A-Za-z_][A-Za-z0-9_]*)\\s*\\)\\s*(?:times)?\\s*:?$', rest)
        if not count:
            count = re.match(r'(?i)^repeat\\s+(\\d+)\\s*(?:times)?\\s*:?$', rest)
        if count:
            raw = count.group(1)
            times = raw if re.match(r'^[A-Za-z_]', raw) else str(max(0, min(int(raw), 9999)))
            rewritten = f"{indent}for _pkr_repeat in range({times}):"
        elif re.match(r'(?i)^forever(?:\\s+do)?\\s*:?$', rest):
            rewritten = f"{indent}while True:"
        elif re.match(r'(?i)^while\\s+true(?:\\s+do)?\\s*:?$', rest):
            rewritten = f"{indent}while True:"
        out.append((rewritten if rewritten is not None else match.group(1) + match.group(2)) + nl)
    return "".join(out)

class _PkrAwaitCommands(ast.NodeTransformer):
    def visit_Call(self, node):
        node = self.generic_visit(node)
        if isinstance(node.func, ast.Name) and node.func.id in _PKR_COMMANDS:
            return ast.Await(value=node)
        return node
    def visit_Await(self, node):
        node.value = self.generic_visit(node.value)
        if isinstance(node.value, ast.Await):
            return node.value
        return node

class _PkrStopLoops(ast.NodeTransformer):
    def visit_While(self, node):
        node = self.generic_visit(node)
        test = node.test
        forever = isinstance(test, ast.Constant) and test.value is True
        if forever:
            stop_if = ast.If(
                test=ast.Call(func=ast.Name(id="__pkr_should_stop", ctx=ast.Load()), args=[], keywords=[]),
                body=[ast.Break()],
                orelse=[],
            )
            yield_call = ast.Expr(value=ast.Await(value=ast.Call(func=ast.Name(id="__pkr_yield", ctx=ast.Load()), args=[], keywords=[])))
            node.body = [stop_if, yield_call] + list(node.body)
        return node

def __pkr_prepare(source):
    tree = ast.parse(__pkr_rewrite_loops(source))
    tree = _PkrAwaitCommands().visit(tree)
    tree = _PkrStopLoops().visit(tree)
    ast.fix_missing_locations(tree)
    body = tree.body if tree.body else [ast.Pass()]
    fn = ast.AsyncFunctionDef(
        name="__pkr_main",
        args=ast.arguments(posonlyargs=[], args=[], vararg=None, kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]),
        body=body,
        decorator_list=[],
        returns=None,
        type_comment=None,
        type_params=[],
    )
    module = ast.Module(body=[fn], type_ignores=[])
    ast.fix_missing_locations(module)
    return ast.unparse(module)

def __pkr_should_stop():
    return bool(js.pkr_should_stop())

async def __pkr_yield():
    return await js.pkr_yield()
async def move_to(column, row):
    return await js.execute_game_command("move_to", [column, row])
async def take(item):
    return await js.execute_game_command("take", [item])
async def drop_inventory(slot):
    return await js.execute_game_command("drop_inventory", [slot])
async def cook(item):
    return await js.execute_game_command("cook", [item])
async def cut(item):
    return await js.execute_game_command("cut", [item])
async def collect():
    return await js.execute_game_command("collect", [])
async def plate(item):
    return await js.execute_game_command("plate", [item])
async def wash_plate():
    return await js.execute_game_command("wash_plate", [])
async def serve():
    return await js.execute_game_command("serve", [])
async def wait(seconds=1):
    return await js.execute_game_command("wait", [seconds])
async def status():
    return await js.execute_game_command("status", [])
`);
    $("runBtn").disabled=false;
    if($("stopBtn"))$("stopBtn").disabled=true;
    $("consoleOutput").textContent=t("pythonLoaded");
  }catch(e){log(t("pythonLoadFail",{error:e}));}
}
async function runPython(){
  if(!state.pyodide||state.gameEnded||state.pythonRunning)return;
  state.pythonRunning=true;
  state.scriptStopped=false;
  state.actionQueue=Promise.resolve();
  if($("runBtn"))$("runBtn").disabled=true;
  if($("stopBtn"))$("stopBtn").disabled=false;
  clearLog();
  try{
    const source=$("codeEditor").value;
    state.pyodide.globals.set("__pkr_user_source", source);
    await state.pyodide.runPythonAsync(`
__pkr_prepared = __pkr_prepare(__pkr_user_source)
exec(__pkr_prepared, globals())
await __pkr_main()
`);
    await state.actionQueue;
    if(!state.scriptStopped) log(t("pythonFinished"));
  }catch(e){
    if(!state.scriptStopped) log(t("pythonError",{error:e.message||e}));
  }finally{
    state.pythonRunning=false;
    if($("runBtn"))$("runBtn").disabled=false;
    if($("stopBtn"))$("stopBtn").disabled=true;
  }
}
function stopPython(){
  if(!state.pythonRunning||state.scriptStopped)return;
  state.scriptStopped=true;
  state.scene?.hideCarry();
  if(state.scene?.playerSprite)state.scene.tweens.killTweensOf(state.scene.playerSprite);
  log(t("pythonStopped"));
  if($("stopBtn"))$("stopBtn").disabled=true;
}
function startTimer(){const timer=setInterval(()=>{if(!state.running||state.gameEnded||state.quitPromptOpen){if(state.gameEnded)clearInterval(timer);return;}state.timeLeft--;updateHUD();if(state.timeLeft<=0)endRound(true);},1000);}
function scorePayload(finished){
  return {
    player_name:state.playerName,
    score:state.score,
    game_mode:finished?"Solo Burger Rush":"Unfinished Burger Rush",
    time_completed:new Date().toISOString(),
    orders_completed:state.ordersCompleted,
    finished
  };
}
function formatDuration(seconds){
  const total=Math.max(0,Math.round(Number(seconds)||0));
  const m=Math.floor(total/60);
  const s=String(total%60).padStart(2,"0");
  return `${m}:${s}`;
}
function setQuitConfirmOpen(open){
  state.quitPromptOpen=!!open;
  const el=$("quitConfirm");
  if(!el)return;
  el.hidden=!open;
  el.classList.toggle("hidden",!open);
}
function askQuitGame(){
  if(!state.running||state.gameEnded)return;
  playOptionalSound("button_click");
  setQuitConfirmOpen(true);
}
function cancelQuitGame(){
  playOptionalSound("button_click");
  setQuitConfirmOpen(false);
}
function saveUnfinishedRound(){
  if(state.practice||state.scoreSaved||state.gameEnded||!state.running||!String(state.playerName||"").trim())return;
  state.scoreSaved=true;
  const body=JSON.stringify(scorePayload(false));
  try{
    const blob=new Blob([body],{type:"application/json"});
    if(navigator.sendBeacon("/api/scores",blob))return;
  }catch(_){}
  fetch("/api/scores",{method:"POST",headers:{"Content-Type":"application/json"},body,keepalive:true}).catch(()=>null);
}
function showEndScreen({finished,name,served,score,timeTaken,saved}){
  state.lastEndScreen={finished,name,served,score,timeTaken,saved};
  if($("resultBadge"))$("resultBadge").textContent=finished?t("timesUp"):t("leftEarly");
  if($("resultHeadline"))$("resultHeadline").textContent=finished?t("kitchenClosed"):t("shiftPaused");
  if($("resultPlayerName"))$("resultPlayerName").textContent=name||t("chef");
  if($("resultServed"))$("resultServed").textContent=String(served??0);
  if($("resultTime"))$("resultTime").textContent=timeTaken||"0:00";
  if($("resultScore"))$("resultScore").textContent=String(score??0);
  if($("resultNote")){
    $("resultNote").textContent=saved==="practice"?t("practiceNote"):saved===false?t("saveFail"):t("savedBoard");
  }
  showScreen("resultScreen");
}
async function endRound(finished){
  if(state.gameEnded)return;
  setQuitConfirmOpen(false);
  state.gameEnded=true;
  state.running=false;
  state.scriptStopped=true;
  state.pythonRunning=false;
  state.scene?.hideCarry();
  state.finishedAt=new Date();
  const elapsed=Math.max(0,(state.timeLimit||0)-(state.timeLeft||0));
  showEndScreen({
    finished:!!finished,
    name:state.playerName,
    served:state.ordersCompleted,
    score:state.score,
    timeTaken:formatDuration(elapsed),
    saved:true
  });
  if(state.practice){
    state.scoreSaved=true;
    if($("resultNote"))$("resultNote").textContent=t("practiceNote");
    if(state.lastEndScreen)state.lastEndScreen.saved="practice";
    return;
  }
  if(state.scoreSaved)return;
  state.scoreSaved=true;
  try{
    const r=await fetch("/api/scores",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(scorePayload(!!finished))});
    if($("resultNote"))$("resultNote").textContent=r.ok?t("savedBoard"):t("saveFail");
    if(state.lastEndScreen) state.lastEndScreen.saved=r.ok;
  }catch(_){
    if($("resultNote"))$("resultNote").textContent=t("saveFail");
    if(state.lastEndScreen) state.lastEndScreen.saved=false;
  }
}
function bestScoresByPlayer(rows){
  const byName={};
  rows.forEach(row=>{
    const key=String(row.player_name||"").trim();
    if(!key)return;
    const current=byName[key];
    const nextFinished=Number(row.finished)!==0;
    const currentFinished=current?Number(current.finished)!==0:false;
    const better=!current
      || row.score>current.score
      || (row.score===current.score && nextFinished && !currentFinished)
      || (row.score===current.score && nextFinished===currentFinished && row.orders_completed>current.orders_completed);
    if(better) byName[key]=row;
  });
  return Object.values(byName).sort((a,b)=>b.score-a.score||b.orders_completed-a.orders_completed);
}
function renderLeaderboardDashboard(rows){
  state.leaderboardRows=rows;
  const stats=$("leaderboardStats");
  const content=$("leaderboardContent");
  if(!rows.length){
    if(stats)stats.innerHTML="";
    if(content)content.innerHTML=`<p class="lb-empty">${t("lbEmpty")}</p>`;
    return;
  }
  const players=bestScoresByPlayer(rows);
  const top=players[0];
  const totalOrders=players.reduce((sum,row)=>sum+(Number(row.orders_completed)||0),0);
  if(stats){
    stats.innerHTML=`
      <div class="lb-stat"><span>${t("lbPlayers")}</span><strong>${players.length}</strong></div>
      <div class="lb-stat"><span>${t("lbTop")}</span><strong>${top.score}</strong></div>
      <div class="lb-stat"><span>${t("lbOrders")}</span><strong>${totalOrders}</strong></div>
    `;
  }
  if(content){
    content.innerHTML=`<table><thead><tr><th>${t("lbRank")}</th><th>${t("lbPlayer")}</th><th>${t("lbScore")}</th><th>${t("lbOrdersCol")}</th><th>${t("lbStatus")}</th><th>${t("lbLast")}</th></tr></thead><tbody>`+
      players.map((row,index)=>{
        const finished=Number(row.finished)!==0;
        return `<tr><td>${index+1}</td><td>${escapeHtml(row.player_name)}</td><td>${row.score}</td><td>${row.orders_completed}</td><td>${finished?t("finished"):t("leftEarlyStatus")}</td><td>${row.time_completed?new Date(row.time_completed).toLocaleString():"—"}</td></tr>`;
      }).join("")+
      `</tbody></table>`;
  }
}
async function showLeaderboard(returnTo){
  state.leaderboardReturn=returnTo||"resultScreen";
  showScreen("leaderboardScreen");
  const stats=$("leaderboardStats");
  const content=$("leaderboardContent");
  if(stats)stats.innerHTML="";
  if(content)content.textContent=t("lbLoading");
  try{
    const r=await fetch("/api/leaderboard");
    const rows=await r.json();
    renderLeaderboardDashboard(Array.isArray(rows)?rows:[]);
  }catch(_){
    if(content)content.innerHTML=`<p class="lb-empty">${t("lbFail")}</p>`;
  }
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

function applyStaticI18n() {
  document.documentElement.lang = uiLang === "zh" ? "zh-Hans" : "en";
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-aria]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
  document.querySelectorAll("[data-i18n-title]").forEach(el => { el.title = t(el.dataset.i18nTitle); });
}
function applyI18n() {
  applyStaticI18n();
  const labels = state.scene?.stationLabels;
  if (labels) Object.entries(labels).forEach(([id, label]) => { if (label?.setText) label.setText(stationDisplayName(id)); });
  if (typeof refreshHoveredStationCard === "function") refreshHoveredStationCard();
  if (state.scene?.playerLabel?.setText) state.scene.playerLabel.setText(t("player"));
  state.floorItems.forEach(item => { if (item.label?.setText) item.label.setText(itemPhrase(item.type, item.status)); });
  const expandBtn = $("consoleExpandBtn");
  if (expandBtn) {
    const open = $("gameScreen")?.classList.contains("is-output-expanded");
    expandBtn.textContent = t(open ? "collapseOutput" : "expandOutput");
    expandBtn.setAttribute("aria-label", t(open ? "collapseOutputAria" : "expandOutputAria"));
  }
  const tab = document.querySelector("#gameScreen .guide-tabs .tab.active")?.dataset.tab || "movement";
  if ($("guideAction")) {
    const [action, text, code] = getLesson(tab);
    $("guideAction").textContent = action;
    $("guideText").textContent = text;
    $("guideCode").textContent = code;
  }
  if ($("tutorialScreen") && !$("tutorialScreen").classList.contains("hidden")) showTutorialStep();
  if ($("backpack")) renderIngredientBackpack();
  if (typeof updateGuideStatusBox === "function") updateGuideStatusBox();
  if (state.lastEndScreen && $("resultScreen") && !$("resultScreen").classList.contains("hidden")) {
    const keep = state.lastEndScreen;
    if ($("resultBadge")) $("resultBadge").textContent = keep.finished ? t("timesUp") : t("leftEarly");
    if ($("resultHeadline")) $("resultHeadline").textContent = keep.finished ? t("kitchenClosed") : t("shiftPaused");
    if ($("resultPlayerName")) $("resultPlayerName").textContent = keep.name || t("chef");
    if ($("resultNote")) $("resultNote").textContent = keep.saved === "practice" ? t("practiceNote") : keep.saved === false ? t("saveFail") : t("savedBoard");
  }
  if (Array.isArray(state.leaderboardRows) && $("leaderboardScreen") && !$("leaderboardScreen").classList.contains("hidden")) {
    renderLeaderboardDashboard(state.leaderboardRows);
  }
  const out = $("consoleOutput");
  if (out && !state.pyodide) out.textContent = t("pythonLoading");
  else if (out && state.pyodide && !state.pythonRunning) {
    const idle = ["Python loaded. Write commands and click Run Python.", "Python 已就绪。编写命令，再点击 Run Python。", "Python is loading…", "正在加载 Python…"];
    if (idle.includes(out.textContent)) out.textContent = t("pythonLoaded");
  }
}
function toggleLang() {
  uiLang = uiLang === "zh" ? "en" : "zh";
  try { localStorage.setItem(LANG_STORAGE, uiLang); } catch (_) {}
  applyI18n();
}

function beginRound(name, practice){
  state.practice=!!practice;
  state.playerName=name;
  state.score=0;
  state.ordersCompleted=0;
  state.timeLeft=state.timeLimit;
  state.startedAt=null;
  state.finishedAt=null;
  state.backpack=[null,null,null,null];
  state.collectSeq=1;
  clearFloorItems();
  state.items={};
  state.orderNumber=1;
  state.currentOrder=null;
  state.gameEnded=false;
  state.running=true;
  state.pythonRunning=false;
  state.scriptStopped=false;
  state.scoreSaved=false;
  state.quitPromptOpen=false;
  state.dirtyPlates=0;
  state.actionQueue=Promise.resolve();
  if($("codeEditor")){
    $("codeEditor").value="";
    $("codeEditor").dispatchEvent(new Event("input"));
  }
  const out=$("consoleOutput");
  if(out)out.textContent=state.pyodide?t("pythonLoaded"):t("pythonLoading");
  const expandPanel=document.querySelector("#gameScreen .command-panel");
  $("gameScreen")?.classList.remove("is-output-expanded");
  if(expandPanel)clearConsoleExpandStyles(expandPanel);
  syncConsoleExpandBtn(false);
  resetStationWork();
  useGuideHost("game");
  showScreen("gameScreen");
  startGuideDemo("movement");
  if(!state.scene){state.phaser=new Phaser.Game({type:Phaser.AUTO,width:480,height:480,parent:"gameContainer",backgroundColor:"#F4D6A0",scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH},scene:KitchenScene});}
  newOrder();
  updateHUD();
  startTimer();
}
$("startBtn").addEventListener("click",()=>{
  const name=$("playerName").value.trim();if(!name){alert(t("needName"));return;}
  playOptionalSound("button_click");
  beginRound(name,false);
});
$("practiceMenuBtn")?.addEventListener("click",()=>{
  playOptionalSound("button_click");
  try{sessionStorage.setItem("pkr-practice","1");}catch(_){}
  location.reload();
});
try{
  if(sessionStorage.getItem("pkr-practice")==="1"){
    sessionStorage.removeItem("pkr-practice");
    beginRound(t("practiceName"),true);
  }
}catch(_){}
let consoleExpandLock = false;
function clearConsoleExpandStyles(panel) {
  ["transition", "position", "z-index", "left", "width", "top", "height"].forEach(prop => panel.style.removeProperty(prop));
}
function syncConsoleExpandBtn(open) {
  const btn = $("consoleExpandBtn");
  if (!btn) return;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.textContent = t(open ? "collapseOutput" : "expandOutput");
  btn.setAttribute("aria-label", t(open ? "collapseOutputAria" : "expandOutputAria"));
}
function toggleConsoleExpand() {
  if (consoleExpandLock) return;
  const panel = document.querySelector("#gameScreen .command-panel");
  const body = document.querySelector("#gameScreen .pkr-side-column") || document.querySelector("#gameScreen .pkr-game-body");
  const screen = $("gameScreen");
  if (!panel || !body || !screen) return;
  consoleExpandLock = true;
  const opening = !screen.classList.contains("is-output-expanded");
  const bodyRect = body.getBoundingClientRect();
  if (opening) {
    const rect = panel.getBoundingClientRect();
    panel.dataset.collapsedTop = String(rect.top - bodyRect.top);
    panel.dataset.collapsedHeight = String(rect.height);
    panel.dataset.collapsedLeft = String(rect.left - bodyRect.left);
    panel.dataset.collapsedWidth = String(rect.width);
    const pin = (prop, value) => panel.style.setProperty(prop, value, "important");
    pin("transition", "none");
    pin("position", "absolute");
    pin("z-index", "50");
    pin("left", panel.dataset.collapsedLeft + "px");
    pin("width", panel.dataset.collapsedWidth + "px");
    pin("top", panel.dataset.collapsedTop + "px");
    pin("height", panel.dataset.collapsedHeight + "px");
    screen.classList.add("is-output-expanded");
    syncConsoleExpandBtn(true);
    panel.getBoundingClientRect();
    requestAnimationFrame(() => {
      pin("transition", "top .45s cubic-bezier(.22,1,.36,1), height .45s cubic-bezier(.22,1,.36,1)");
      pin("top", "8px");
      pin("height", Math.max(rect.height, bodyRect.height - 16) + "px");
    });
  } else {
    const pin = (prop, value) => panel.style.setProperty(prop, value, "important");
    pin("transition", "top .45s cubic-bezier(.22,1,.36,1), height .45s cubic-bezier(.22,1,.36,1)");
    pin("top", (panel.dataset.collapsedTop || "0") + "px");
    pin("height", (panel.dataset.collapsedHeight || String(panel.offsetHeight)) + "px");
    syncConsoleExpandBtn(false);
    window.setTimeout(() => {
      screen.classList.remove("is-output-expanded");
      clearConsoleExpandStyles(panel);
    }, 460);
  }
  window.setTimeout(() => { consoleExpandLock = false; }, 480);
}
$("consoleExpandBtn")?.addEventListener("click", toggleConsoleExpand);
$("runBtn").addEventListener("click",runPython);
if($("stopBtn"))$("stopBtn").addEventListener("click",stopPython);
$("leaderboardBtn").addEventListener("click",()=>showLeaderboard("resultScreen"));
$("backBtn").addEventListener("click",()=>showScreen(state.leaderboardReturn||"mainMenu"));
$("restartBtn").addEventListener("click",()=>location.reload());
$("tutorialNextBtn")?.addEventListener("click",tutorialNext);
$("tutorialBackBtn")?.addEventListener("click",leaveTutorial);
$("gameBackBtn")?.addEventListener("click",askQuitGame);
$("quitConfirmYes")?.addEventListener("click",()=>{playOptionalSound("button_click");endRound(false);});
$("quitConfirmNo")?.addEventListener("click",cancelQuitGame);
function onLangToggle(){playOptionalSound("button_click");toggleLang();}
$("langToggle")?.addEventListener("click",onLangToggle);
$("gameLangToggle")?.addEventListener("click",onLangToggle);

function noCopyTarget(node){
  const el = node && node.nodeType === 3 ? node.parentElement : node;
  return el && el.closest ? el.closest(".no-copy") : null;
}
document.addEventListener("copy",e=>{ if(noCopyTarget(e.target) || noCopyTarget(window.getSelection()?.anchorNode)) e.preventDefault(); },true);
document.addEventListener("cut",e=>{ if(noCopyTarget(e.target) || noCopyTarget(window.getSelection()?.anchorNode)) e.preventDefault(); },true);
document.addEventListener("contextmenu",e=>{ if(noCopyTarget(e.target)) e.preventDefault(); },true);
document.addEventListener("selectstart",e=>{ if(noCopyTarget(e.target)) e.preventDefault(); },true);
document.addEventListener("dragstart",e=>{ if(noCopyTarget(e.target)) e.preventDefault(); },true);
document.addEventListener("keydown",e=>{
  if(!(e.ctrlKey||e.metaKey)) return;
  if(!["c","C","x","X","a","A"].includes(e.key)) return;
  if(noCopyTarget(e.target) || noCopyTarget(window.getSelection()?.anchorNode)) e.preventDefault();
},true);
window.addEventListener("pagehide",e=>{ if(!e.persisted) saveUnfinishedRound(); });
window.addEventListener("beforeunload",saveUnfinishedRound);
window.addEventListener("resize",()=>{
  if(state.phaser&&state.phaser.scale)state.phaser.scale.refresh();
  if(typeof refreshHoveredStationCard==="function")refreshHoveredStationCard();
});

startMenuMusic();window.addEventListener("pointerdown",unlockMenuAudio,{once:true});window.addEventListener("keydown",unlockMenuAudio,{once:true});
fetch("/api/health").catch(()=>null);loadPython();
applyI18n();
startGuideDemo("movement");

/* =========================================================
   Delivery queue: cars walk the lane like the chef — one
   step at a time, one car after another.
   Slot 0 = back of queue (top), slot 2 = serving (bottom).
   ========================================================= */
(() => {
  const carsRoot = document.querySelector("#gameScreen .delivery-cars");
  if (!carsRoot) return;

  const SLOT_TOP = { spawn: -38, 0: 6, 1: 39, 2: 72, leave: 165 };
  const STEP = 11;
  let chain = Promise.resolve();

  function cars() {
    return [...carsRoot.querySelectorAll(".delivery-car")];
  }

  function bySlot() {
    return cars()
      .filter(car => ["0", "1", "2"].includes(String(car.dataset.slot)))
      .sort((a, b) => Number(a.dataset.slot) - Number(b.dataset.slot));
  }

  function sineEase(t) {
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  }

  function readTop(car) {
    const inline = car.style.top;
    if (inline) return parseFloat(inline);
    const slot = car.dataset.slot;
    return SLOT_TOP[slot] ?? (parseFloat(getComputedStyle(car).top) || 0);
  }

  function writeTop(car, pct) {
    car.style.setProperty("top", `${pct}%`, "important");
  }

  function stepDuration(fromPct, toPct) {
    const height = carsRoot.clientHeight || 400;
    const px = Math.abs(toPct - fromPct) / 100 * height;
    return Math.max(140, px * 5);
  }

  function driveStep(car, from, to) {
    const duration = stepDuration(from, to);
    return new Promise(resolve => {
      const start = performance.now();
      const tick = now => {
        const t = Math.min(1, (now - start) / duration);
        writeTop(car, from + (to - from) * sineEase(t));
        if (t < 1) requestAnimationFrame(tick);
        else {
          writeTop(car, to);
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  async function driveCar(car, targetSlot) {
    car.classList.add("is-driving");
    let from = readTop(car);
    const to = SLOT_TOP[targetSlot];
    const dir = Math.sign(to - from) || 1;
    while (Math.abs(to - from) > 0.35) {
      const next = from + dir * Math.min(STEP, Math.abs(to - from));
      await driveStep(car, from, next);
      from = next;
    }
    writeTop(car, to);
    car.dataset.slot = String(targetSlot);
    car.classList.remove("is-driving");
  }

  async function advanceQueue() {
    const ordered = bySlot();
    if (ordered.length < 3) return;
    const leaving = ordered[2];
    const middle = ordered[1];
    const back = ordered[0];

    await driveCar(leaving, "leave");
    await driveCar(middle, "2");
    await driveCar(back, "1");

    leaving.classList.add("is-spawning");
    leaving.dataset.slot = "spawn";
    writeTop(leaving, SLOT_TOP.spawn);
    void leaving.offsetWidth;
    leaving.classList.remove("is-spawning");
    await driveCar(leaving, "0");
  }

  function enqueueAdvance() {
    chain = chain.then(advanceQueue).catch(() => null);
  }

  cars().forEach(car => writeTop(car, SLOT_TOP[car.dataset.slot] ?? 6));

  window.addEventListener("pkr:order-complete", enqueueAdvance);

  window.PKRDeliveryCar = {
    showOrder() { cars().forEach(car => car.classList.remove("is-leaving", "is-spawning", "is-driving")); },
    driveAway() { enqueueAdvance(); },
    reset() {
      cars().forEach((car, index) => {
        car.classList.remove("is-leaving", "is-spawning", "is-driving");
        car.dataset.slot = String(index);
        writeTop(car, SLOT_TOP[index]);
      });
    }
  };

  const testBtn = $("deliveryTest");
  if (testBtn) testBtn.addEventListener("click", enqueueAdvance);
})();
