const $ = (id) => document.getElementById(id);

const state = {
  playerName: "", score: 0, ordersCompleted: 0,
  timeLimit: 600, timeLeft: 600, startedAt: null, finishedAt: null,
  running: false, pyodide: null, scene: null, player: null,
  backpack: [null, null, null, null], currentOrder: null, orderNumber: 1,
  items: {}, gameEnded: false, actionQueue: Promise.resolve(), pythonRunning: false, scriptStopped: false,
  dirtyPlates: 0
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
    throw new Error("Grid coordinates must be from 1 to 10. Bottom-left is (1,1), top-right is (10,10).");
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
    if (!item) return `<div class="slot"><span>Slot ${index + 1}</span>-</div>`;
    const info = ingredientInfo[item.type];
    const visual = info.states[item.status];
    return `<div class="slot"><img src="${visual.image}" alt="${visual.label} ${info.label}"><span>${info.label}<small>${visual.label}</small></span></div>`;
  }).join("");
}
function newOrder() {
  state.currentOrder = { ...recipes.burger, id: state.orderNumber++ };
}
function setGuide(tab) {
  const guides = {
    movement: [
      "Walk on the 10 × 10 grid",
      "Bottom-left is (1, 1). Top-right is (10, 10). You can only walk on empty floor tiles. Tables and stations block the way; move_to finds the shortest path around them. You cannot stand on a table or station.",
      "move_to(3, 9)"
    ],
    take: [
      "Take from a chest",
      "Stand on any empty tile next to Lettuce (1, 10), Tomato (2, 10), Bun (3, 10), or Patty (4, 10). For the bun chest, (3, 9) is the tile below it. Needs a free backpack slot.",
      'move_to(3, 9)\ntake("bun")'
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
      "Stand next to a finished pan, cutting board, or a complete plated burger at (7, 10) to (10, 10), then collect(). You need a free backpack slot.",
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
      "Optional wait, for example while a station finishes, before collect().",
      "wait(1)"
    ],
    status: [
      "Check your state",
      "Shows your position, backpack contents, current order, and needed materials in plain text.",
      "status()"
    ]
  };
  const guide = guides[tab] || guides.movement;
  const [action, text, code] = guide;
  const activeTab = guides[tab] ? tab : "movement";
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
  const playable = ["movement", "take", "cook", "cut", "collect", "plate", "wash", "serve", "wait", "status"];
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

const guideDemo = { timers: [], generation: 0, player: null, item: null, cells: {}, stationImgs: {} };

const GUIDE_HIGHLIGHTS = {
  movement: [{ column: 3, row: 9 }],
  take: [{ column: 3, row: 10 }, { column: 3, row: 9 }],
  cook: [{ column: 4, row: 4 }, { column: 5, row: 4 }],
  cut: [{ column: 7, row: 4 }, { column: 8, row: 4 }],
  collect: [{ column: 4, row: 4 }, { column: 5, row: 4 }],
  plate: [{ column: 7, row: 10 }, { column: 7, row: 9 }],
  wash: [{ column: 6, row: 10 }, { column: 6, row: 9 }],
  serve: [{ column: 10, row: 1 }, { column: 9, row: 1 }],
  wait: [],
  status: [{ column: 2, row: 2 }]
};

function buildGuideDemo() {
  const board = $("guideMiniBoard");
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
  const demo = $("guideDemo");
  const waitStage = $("guideWaitStage");
  const statusBox = $("guideStatusBox");
  const miniWrap = $("guideMiniWrap");
  const miniX = $("guideMiniX");
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
  const code = $("guideCode")?.textContent || "wait(1)";
  const match = code.match(/wait\(\s*(\d+(?:\.\d+)?)\s*\)/);
  const seconds = match ? Number(match[1]) : 1;
  return Math.max(1, Math.min(10, Math.round(seconds) || 1));
}

function setGuideClockHand(degrees, animate) {
  const hand = $("guideClockHand");
  if (!hand) return;
  hand.style.transition = animate ? "transform 1s linear" : "none";
  hand.style.transform = `rotate(${degrees}deg)`;
}

async function playGuideWaitClock(alive) {
  const seconds = guideWaitSeconds();
  const label = $("guideClockLabel");
  setGuideClockHand(0, false);
  if (label) label.textContent = "1";
  await waitGuide(40);
  for (let beat = 1; beat <= seconds; beat++) {
    if (!alive()) return;
    if (label) label.textContent = String(beat);
    setGuideClockHand(0, false);
    void $("guideClockHand")?.offsetWidth;
    setGuideClockHand(360, true);
    await waitGuide(1000);
  }
  if (!alive()) return;
  if (label) label.textContent = "Done";
  await waitGuide(700);
}

function formatGuideStatusText() {
  const g = state.player ? playerGrid() : { column: 2, row: 2 };
  const backpack = {};
  const pack = state.player ? state.backpack : [null, null, null, null];
  pack.forEach((item, index) => {
    if (!item) {
      backpack[index + 1] = "empty";
      return;
    }
    const info = ingredientInfo[item.type];
    backpack[index + 1] = info ? `${info.states[item.status].label} ${info.label}` : item.type;
  });
  const backpackText = Object.entries(backpack).map(([slot, value]) => `${slot}: ${value}`).join(", ");
  const order = state.currentOrder || recipes.burger;
  const orderName = state.currentOrder
    ? `${order.name} (Order #${order.id})`
    : "Classic Burger (Order #1)";
  const needed = order?.ingredients?.length
    ? order.ingredients.join(", ")
    : "bun, patty, lettuce, tomato";
  return `Player position: (${g.column}, ${g.row})\nBackpack: {${backpackText}}\nCurrent order: ${orderName}\nNeeded: ${needed}`;
}

function updateGuideStatusBox(position) {
  const box = $("guideStatusBox");
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

  if (tab === "movement") {
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

function showScreen(id) {
  ["mainMenu", "nameScreen", "gameScreen", "resultScreen", "leaderboardScreen"].forEach(screenId => {
    const el = $(screenId); if (el) el.classList.toggle("hidden", screenId !== id);
  });
}
function startMenuMusic() { const music=$("menuMusic"); if (!music)return; music.volume=.35; music.play().catch(()=>{}); }
function unlockMenuAudio(){ startMenuMusic(); }

const soundCache = {};
function playOptionalSound(name) {
  let audio=soundCache[name];
  if(!audio){ audio=new Audio(`/static/sounds/${name}.mp3`); audio.preload="auto"; audio.volume=.65; soundCache[name]=audio; }
  audio.currentTime=0; audio.play().catch(()=>{});
}

$("playMenuBtn").addEventListener("click",()=>{playOptionalSound("button_click");showScreen("nameScreen");$("playerName").focus();});
$("nameBackBtn").addEventListener("click",()=>{playOptionalSound("button_click");showScreen("mainMenu");});
$("startBtn").addEventListener("click",()=>playOptionalSound("button_click"));

let typingAudioContext=null,lastTypingSoundAt=0;
function playTypingSound(){
  const now=performance.now(); if(now-lastTypingSoundAt<28)return; lastTypingSoundAt=now;
  const a=new Audio("/static/sounds/typing.wav"); a.volume=.18; a.play().catch(()=>{
    try{typingAudioContext ||= new (window.AudioContext||window.webkitAudioContext)();
      const o=typingAudioContext.createOscillator(),g=typingAudioContext.createGain();o.type="square";o.frequency.value=620;
      g.gain.setValueAtTime(.035,typingAudioContext.currentTime);g.gain.exponentialRampToValueAtTime(.001,typingAudioContext.currentTime+.035);
      o.connect(g);g.connect(typingAudioContext.destination);o.start();o.stop(typingAudioContext.currentTime+.035);}catch(_){}}
  );
}
$("codeEditor")?.addEventListener("keydown",e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;const k=["Backspace","Delete","Enter","Tab","Space"];if(e.key.length===1||k.includes(e.key))playTypingSound();});

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
    this.playerLabel=this.add.text(start.x,start.y-36,"Player",{
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
      this.tweens.killTweensOf(this.playerSprite, "displayWidth");
      this.tweens.killTweensOf(this.playerSprite, "displayHeight");
      this.tweens.add({
        targets:this.playerSprite,
        displayWidth:this.playerSprite.getData("hoverSize"),
        displayHeight:this.playerSprite.getData("hoverSize"),
        duration:140,
        ease:"Back.Out"
      });
    });
    this.carrySprite=this.add.image(start.x,start.y-26,"bunUncooked").setDepth(8).setVisible(false).setDisplaySize(30,30);
    this.carryFollowPlayer=false;
    this.playerSprite.on("pointerout",()=>{
      this.playerSprite.setData("hovering", false);
      this.tweens.killTweensOf(this.playerSprite, "displayWidth");
      this.tweens.killTweensOf(this.playerSprite, "displayHeight");
      this.tweens.add({
        targets:this.playerSprite,
        displayWidth:this.playerSprite.getData("restSize"),
        displayHeight:this.playerSprite.getData("restSize"),
        duration:140,
        ease:"Sine.easeOut"
      });
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
      const label=this.add.text(station.x,station.y,station.label,{
        fontFamily:"Arial",
        fontSize:"11px",
        fontStyle:"bold",
        color:"#3A2A2A",
        backgroundColor:"#F9E6BD",
        padding:{x:4,y:2}
      }).setOrigin(.5).setDepth(4).setVisible(false);

      sprite.on("pointerover",()=>{
        label.setVisible(true);
        label.setAlpha(1);
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
    if(!isWalkable(target.column,target.row))fail("you cannot stand on a table or station.");
    const path=shortestPath(from,target);
    if(!path)fail("there is no empty path to that tile.");
    const steps=path.slice(1);
    if(!steps.length){
      state.player.x=this.playerSprite.x;
      state.player.y=this.playerSprite.y;
      updateHUD();
      return Promise.resolve();
    }
    return steps.reduce((chain,step)=>chain.then(()=>this.walkOneTile(step)),Promise.resolve());
  }
  walkOneTile(step){
    const point=gridToPixel(step.column,step.row);
    this.faceToward(point);
    return new Promise(resolve=>{
      const from={x:this.playerSprite.x,y:this.playerSprite.y};
      const duration=Math.max(140,distance(from,point)*5);
      this.tweens.add({
        targets:this.playerSprite,x:point.x,y:point.y,duration,ease:"Sine.easeInOut",
        onUpdate:()=>{
          state.player.x=this.playerSprite.x;
          state.player.y=this.playerSprite.y;
          if(this.playerLabel)this.playerLabel.setPosition(this.playerSprite.x,this.playerSprite.y-36);
          this.syncCarryToPlayer();
          updateHUD();
        },
        onComplete:()=>{
          state.player.x=point.x;
          state.player.y=point.y;
          if(this.playerLabel)this.playerLabel.setPosition(point.x,point.y-36);
          updateHUD();
          resolve();
        }
      });
    });
  }
  showItemEffect(text,emoji){const t=this.add.text(state.player.x,state.player.y-34,`${emoji} ${text}`,{fontFamily:"Arial",fontSize:"14px",color:"#3A2A2A",backgroundColor:"#fff"}).setOrigin(.5);this.tweens.add({targets:t,y:t.y-22,alpha:0,duration:700,onComplete:()=>t.destroy()});}
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
      log("Washed a plate. A clean empty plate is ready.");
    });
  }
}

function fail(message) {
  const error = new Error(message || "that command is not allowed.");
  error.ruleFail = true;
  throw error;
}
function stopScript(error) {
  if (state.scriptStopped) return;
  state.scriptStopped = true;
  state.scene?.hideCarry();
  const message = (error && (error.message || error.studentMessage)) || "that command is not allowed.";
  log("Stopped: " + message);
  log("Fix the problem, then click Run Python again.");
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
  const index=state.backpack.findIndex(x=>!x); if(index===-1)fail("backpack is full.");
  const info=itemInfo[type]; state.backpack[index]={type,status,emoji:status==="prepared"?info.cooked:info.raw};renderBackpack();
}
function findItem(type){return state.backpack.find(x=>x&&x.type===type);}
function removeItem(type){const i=state.backpack.findIndex(x=>x&&x.type===type);if(i===-1)fail(`you do not have ${type} in the backpack.`);const item=state.backpack[i];state.backpack[i]=null;renderBackpack();return item;}
function requireNear(name, commandText){
  const station=stations[name] || stationForRole(name);
  if(!station) fail(`there is no ${name} station.`);
  if(!nearStation(name)) fail(`stand next to the ${station.label} before ${commandText || "using it"}.`);
  state.scene?.faceToward(station);
  return station;
}
function requireItem(type){const item=findItem(type);if(!item)fail(`you do not have ${type} in the backpack.`);return item;}

function itemTexture(type,status){
  const image=ingredientInfo[type]?.states[status]?.image;
  if(!image)return null;
  return Object.keys(assetPaths).find(key=>assetPaths[key]===image)||null;
}

function addIngredient(type,status){
  const index=state.backpack.findIndex(item=>!item);
  if(index===-1)fail("backpack is full.");
  if(!ingredientInfo[type]?.states[status])fail("that item cannot go in the backpack.");
  state.backpack[index]={type,status};
  renderIngredientBackpack();
}
function removeIngredient(type,status){
  const index=state.backpack.findIndex(item=>item&&item.type===type&&(!status||item.status===status));
  if(index===-1)fail(`you do not have that ${type} in the backpack.`);
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
    if(!info||!allowed.includes(type))fail(role==="pan"?`cook() only works with "bun" or "patty".`:`cut() only works with "lettuce" or "tomato".`);
    const nearby=nearbyStations(role);
    if(!nearby.length)fail(role==="pan"?`stand next to a cooking pan before ${command}.`:`stand next to a cutting board before ${command}.`);
    const empty=nearby.filter(station=>station.work?.phase==="empty");
    if(!empty.length)fail(role==="pan"?"all nearby pans are busy. Wait, or use another pan.":"all nearby cutting boards are busy. Wait, or use another board.");
    const rawItem=state.backpack.find(item=>item&&item.type===type&&item.status===info.rawStatus);
    if(!rawItem)fail(`you need ${info.states[info.rawStatus].label.toLowerCase()} ${info.label.toLowerCase()} in the backpack to ${command}.`);
    const station=nearestStation(empty);
    state.scene.faceToward(station);
    removeIngredient(type,info.rawStatus);
    const tex=itemTexture(type,info.rawStatus);
    await state.scene.showCarry(tex,"player",280);
    state.scene.hideCarry();
    station.work={phase:"busy",item:{type,status:info.rawStatus}};
    const id=stationId(station);
    log(role==="pan"?`Started cooking ${info.label.toLowerCase()}.`:`Started cutting ${info.label.toLowerCase()}.`);
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
  if(state.gameEnded)fail("the round is over.");
  if(name==="take"){
    const type=String(args[0]);
    return action(async()=>{
      if(!ingredientInfo[type])fail('take() needs "bun", "patty", "lettuce", or "tomato".');
      if(!backpackHasSpace())fail(`backpack is full, cannot take("${type}").`);
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
      state.scene.showItemEffect(`Took ${ingredientInfo[type].label.toLowerCase()}.`,"");
      log(`Took ${raw} ${ingredientInfo[type].label.toLowerCase()}.`);
    });
  }
  if(name==="cook")return startToolWork(String(args[0]),"pan");
  if(name==="cut")return startToolWork(String(args[0]),"cuttingBoard");
  if(name==="collect"){
    return action(async()=>{
      const nearbyTools=nearbyStations("pan").concat(nearbyStations("cuttingBoard"));
      const readyTools=nearbyTools.filter(station=>station.work?.phase==="ready"&&station.work.item);
      const readyPlates=nearbyStations("plate").filter(station=>station.work?.phase==="complete");
      const ready=readyTools.concat(readyPlates);
      if(!nearbyTools.length&&!nearbyStations("plate").length)fail("stand next to a finished pan, cutting board, or complete plate before collect().");
      if(!ready.length)fail("nothing is ready to collect() yet.");
      if(!backpackHasSpace())fail("backpack is full, cannot collect().");
      const station=nearestStation(ready);
      state.scene.faceToward(station);
      if(station.kind==="plate"){
        const burgerTex=itemTexture("burger","plated");
        await state.scene.showCarry(burgerTex,station,260);
        station.work={phase:"vacant",items:[]};
        updatePlateVisual(stationId(station));
        addIngredient("burger","plated");
        await state.scene.showCarry(burgerTex,"player",550);
        state.scene.hideCarry();
        state.scene.showItemEffect("Collected plated burger.","");
        log("Collected plated burger.");
        return;
      }
      const item=station.work.item;
      const tex=itemTexture(item.type,item.status);
      await state.scene.showCarry(tex,station,280);
      addIngredient(item.type,item.status);
      station.work={phase:"empty",item:null};
      state.scene.resetToolVisual(stationId(station));
      await state.scene.showCarry(tex,"player",550);
      state.scene.hideCarry();
      const info=ingredientInfo[item.type];
      state.scene.showItemEffect(`Collected ${info.states[item.status].label.toLowerCase()} ${info.label.toLowerCase()}.`,"");
      log(`Collected ${info.states[item.status].label.toLowerCase()} ${info.label.toLowerCase()}.`);
    });
  }
  if(name==="plate"){
    const type=String(args[0]);
    return action(async()=>{
      const info=ingredientInfo[type];
      const need=ORDER_MATERIALS.find(item=>item.type===type);
      if(!info||!need)fail('plate() needs "bun", "patty", "lettuce", or "tomato".');
      const nearby=nearbyStations("plate").filter(station=>station.work?.phase==="empty"||station.work?.phase==="holding");
      if(!nearbyStations("plate").length)fail(`stand next to a plate before plate("${type}").`);
      if(!nearby.length)fail("no plate here can take more food. Collect a finished burger, or use another plate.");
      const prepared=state.backpack.find(item=>item&&item.type===type&&item.status===need.status);
      if(!prepared)fail(`you need ${info.states[need.status].label.toLowerCase()} ${info.label.toLowerCase()} in the backpack to plate("${type}").`);
      const open=nearby.filter(station=>!(station.work.items||[]).some(item=>item.type===type));
      if(!open.length)fail(`that plate already has ${info.label.toLowerCase()}.`);
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
      log(items.length>=4?`Plated ${info.label.toLowerCase()}. Burger complete.`:`Plated ${info.label.toLowerCase()}.`);
    });
  }
  if(name==="wash_plate"){
    return action(async()=>{
      if(!nearbyStations("wash").length)fail("stand next to the washing station before wash_plate().");
      if(stations.wash.work?.phase==="busy")fail("the washing station is already busy.");
      if((state.dirtyPlates||0)<1)fail("there are no used plates to wash.");
      const vacant=Object.values(stations).some(station=>station.kind==="plate"&&station.work?.phase==="vacant");
      if(!vacant)fail("there is no free plate tile for a clean plate. Collect a finished burger first.");
      const station=stations.wash;
      state.scene.faceToward(station);
      state.dirtyPlates-=1;
      station.work={phase:"busy"};
      log("Started washing a plate.");
      state.scene.runWashJob();
    });
  }
  if(name==="serve"){
    return action(async()=>{
      if(!nearbyStations("serve").length)fail("stand next to the serve counter at (10, 1) or (10, 2) before serve().");
      const burger=state.backpack.find(item=>item&&item.type==="burger"&&item.status==="plated");
      if(!burger)fail("serve() needs a plated burger in the backpack. plate() four items, then collect().");
      if((state.dirtyPlates||0)>=4)fail("the washing station is full of used plates. wash_plate() first.");
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
      state.scene.showItemEffect("Served a burger!","");
      log(`Served a plated burger. +${SCORE_PER_ORDER} score.`);
      log(`Orders done: ${state.ordersCompleted}. Score: ${state.score}.`);
    });
  }
  if(name==="move_to"){
    const c=Number(args[0]),r=Number(args[1]);
    return action(async()=>{
      if(!Number.isInteger(c)||!Number.isInteger(r)||c<1||c>10||r<1||r>10)fail("move_to() needs coordinates from (1, 1) to (10, 10).");
      const p=gridToPixel(c,r);
      await state.scene.movePlayerTo(p.x,p.y);
      log(`Moved to (${c}, ${r}).`);
    });
  }
  if(name==="wait")return action(async()=>{
    const seconds=Math.max(0,Math.min(10,Number(args[0]||1)));
    const end=Date.now()+seconds*1000;
    while(Date.now()<end){
      if(state.scriptStopped)return;
      await new Promise(r=>setTimeout(r,Math.min(80,end-Date.now())));
    }
    log(`Waited ${seconds} second(s).`);
  });
  if(name==="status")return action(async()=>{
    const g=playerGrid();
    const backpack={};
    state.backpack.forEach((item,index)=>{
      if(!item){backpack[index+1]="empty";return;}
      const info=ingredientInfo[item.type];
      backpack[index+1]=`${info.states[item.status].label} ${info.label}`;
    });
    const backpackText=Object.entries(backpack).map(([slot,value])=>`${slot}: ${value}`).join(", ");
    const order=state.currentOrder;
    const needed=order?.ingredients?.length
      ? order.ingredients.join(", ")
      : "bun, patty, lettuce, tomato";
    log(`Player position: (${g.column}, ${g.row})`);
    log(`Backpack: {${backpackText}}`);
    log(`Current order: ${order?`${order.name} (Order #${order.id})`:"none"}`);
    log(`Needed: ${needed}`);
  });
  fail("unknown command.");
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

async function loadPython(){
  try{
    state.pyodide=await loadPyodide();
    await state.pyodide.runPythonAsync(`
import ast, js

_PKR_COMMANDS = {"move_to", "take", "cook", "cut", "collect", "plate", "wash_plate", "serve", "wait", "status"}

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

def __pkr_prepare(source):
    tree = ast.parse(source)
    tree = _PkrAwaitCommands().visit(tree)
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

async def move_to(column, row):
    return await js.execute_game_command("move_to", [column, row])
async def take(item):
    return await js.execute_game_command("take", [item])
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
    $("consoleOutput").textContent="Python loaded. Write commands and click Run Python.";
  }catch(e){log("Could not load Pyodide: "+e);}
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
    if(!state.scriptStopped) log("Python execution finished.");
  }catch(e){
    if(!state.scriptStopped) log("Python error: "+(e.message||e));
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
  log("Stopped: Python stopped.");
  if($("stopBtn"))$("stopBtn").disabled=true;
}
function startTimer(){const timer=setInterval(()=>{if(!state.running||state.gameEnded){clearInterval(timer);return;}state.timeLeft--;updateHUD();if(state.timeLeft<=0)finishGame();},1000);}
async function finishGame(){if(state.gameEnded)return;state.gameEnded=true;state.running=false;state.finishedAt=new Date();showScreen("resultScreen");$("resultSummary").innerHTML=`<p><b>${escapeHtml(state.playerName)}</b>, your time is up.</p><p>Score: <b>${state.score}</b></p><p>Orders completed: <b>${state.ordersCompleted}</b></p>`;try{const r=await fetch("/api/scores",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({player_name:state.playerName,score:state.score,game_mode:"Solo Burger Rush",time_completed:new Date().toISOString(),orders_completed:state.ordersCompleted})});if(!r.ok)throw new Error();$("resultSummary").innerHTML+=`<p class="small-note">Score saved to the shared leaderboard.</p>`;}catch(_){$("resultSummary").innerHTML+=`<p class="small-note">Could not save score. Check the server connection.</p>`;}}
async function showLeaderboard(){showScreen("leaderboardScreen");try{const r=await fetch("/api/leaderboard"),rows=await r.json();if(!rows.length){$("leaderboardContent").textContent="No scores yet.";return;}$("leaderboardContent").innerHTML=`<table><thead><tr><th>Rank</th><th>Name</th><th>Score</th><th>Mode</th><th>Completed</th><th>Orders</th></tr></thead><tbody>`+rows.map((x,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(x.player_name)}</td><td>${x.score}</td><td>${escapeHtml(x.game_mode)}</td><td>${new Date(x.time_completed).toLocaleString()}</td><td>${x.orders_completed}</td></tr>`).join("")+`</tbody></table>`;}catch(_){$("leaderboardContent").textContent="Could not load leaderboard.";}}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

$("startBtn").addEventListener("click",()=>{
  const name=$("playerName").value.trim();if(!name){alert("Please enter a player name.");return;}
  playOptionalSound("button_click");state.playerName=name;state.score=0;state.ordersCompleted=0;state.timeLeft=state.timeLimit;state.backpack=[null,null,null,null];state.items={};state.orderNumber=1;state.gameEnded=false;state.running=true;state.pythonRunning=false;state.scriptStopped=false;state.actionQueue=Promise.resolve();resetStationWork();showScreen("gameScreen");
  startGuideDemo("movement");
  if(!state.scene){state.phaser=new Phaser.Game({type:Phaser.AUTO,width:480,height:480,parent:"gameContainer",backgroundColor:"#F4D6A0",scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH},scene:KitchenScene});}
  newOrder();updateHUD();startTimer();
});
$("runBtn").addEventListener("click",runPython);
if($("stopBtn"))$("stopBtn").addEventListener("click",stopPython);
$("leaderboardBtn").addEventListener("click",showLeaderboard);
$("backBtn").addEventListener("click",()=>showScreen("resultScreen"));
$("restartBtn").addEventListener("click",()=>location.reload());
window.addEventListener("resize",()=>{if(state.phaser&&state.phaser.scale)state.phaser.scale.refresh();});

startMenuMusic();window.addEventListener("pointerdown",unlockMenuAudio,{once:true});window.addEventListener("keydown",unlockMenuAudio,{once:true});
fetch("/api/health").catch(()=>null);loadPython();
startGuideDemo("movement");

(() => {
  const bar = $("commandCurtainBar");
  const body = $("commandCurtainBody");
  const matrix = $("commandMatrix");
  const panel = document.querySelector("#gameScreen .command-panel");
  if (!bar || !body || !matrix || !panel) return;

  const cols = 14;
  const rows = 9;
  const glyphs = "01#*+ｱﾊﾐﾘ01";
  matrix.innerHTML = "";
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = document.createElement("span");
      cell.textContent = glyphs[(row * cols + col * 3) % glyphs.length];
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      matrix.appendChild(cell);
    }
  }

  const cells = [...matrix.children];
  let open = true;
  let timer = 0;

  function setDelays(closing) {
    cells.forEach(cell => {
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      const delay = closing
        ? row * 48 + col * 16
        : (rows - 1 - row) * 48 + col * 16;
      cell.style.animationDelay = `${delay}ms`;
    });
  }

  let busy = false;
  function toggleCurtain() {
    if (busy) return;
    busy = true;
    open = !open;
    bar.setAttribute("aria-expanded", String(open));
    bar.classList.toggle("is-collapsed", !open);
    panel.classList.toggle("is-collapsed", !open);
    clearTimeout(timer);
    const refreshKitchen = () => {
      if (state.phaser && state.phaser.scale) state.phaser.scale.refresh();
    };
    if (!open) {
      setDelays(true);
      matrix.classList.add("is-on", "is-closing");
      matrix.classList.remove("is-opening");
      timer = window.setTimeout(() => {
        body.classList.add("curtain-closed");
        matrix.classList.remove("is-on", "is-closing");
        busy = false;
        refreshKitchen();
      }, 620);
    } else {
      body.classList.remove("curtain-closed");
      setDelays(false);
      matrix.classList.add("is-on", "is-opening");
      matrix.classList.remove("is-closing");
      refreshKitchen();
      timer = window.setTimeout(() => {
        matrix.classList.remove("is-on", "is-opening");
        busy = false;
      }, 680);
    }
  }

  bar.addEventListener("click", toggleCurtain);
  bar.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleCurtain();
    }
  });
})();

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
