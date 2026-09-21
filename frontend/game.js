const $ = (id) => document.getElementById(id);

const state = {
  playerName: "", score: 0, ordersCompleted: 0,
  timeLimit: 600, timeLeft: 600, startedAt: null, finishedAt: null,
  running: false, pyodide: null, scene: null, player: null,
  backpack: [null, null, null], currentOrder: null, orderNumber: 1,
  items: {}, gameEnded: false, actionQueue: Promise.resolve()
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
  bun: { column: 10, row: 1, ...gridToPixel(10, 1), label: "Bun Chest" }
};
const bunChestSprite = {
  open: "/static/assets/bun/bun_chest_open.png",
  closed: "/static/assets/bun/bun_chest_closed.png"
};

const recipes = { burger: { name: "Classic Burger", ingredients: ["bun", "patty", "lettuce"], emoji: "🍔" } };
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
function nearStation(name) { return state.player && distance(state.player, stations[name]) <= 48; }
function updateHUD() {
  $("scoreValue").textContent = state.score;
  $("ordersValue").textContent = state.ordersCompleted;
  const m = Math.floor(state.timeLeft / 60);
  const s = Math.floor(state.timeLeft % 60).toString().padStart(2, "0");
  $("timeValue").textContent = `${m}:${s}`;
  const g = state.player ? pixelToGrid(state.player.x, state.player.y) : {column:1,row:1};
  $("playerStatus").innerHTML =
    `Position: <b>(${g.column}, ${g.row})</b><br>` +
    `Backpack: <b>${state.backpack.filter(Boolean).length}/3</b><br>` +
    `Order: <b>${state.currentOrder?.name || "None"}</b>`;
  renderBackpack();
}
function renderBackpack() {
  $("backpack").innerHTML = state.backpack.map((item, i) => {
    if (!item) return `<div class="slot"><span>Slot ${i}</span>—</div>`;
    return `<div class="slot">${item.emoji}<span>${item.type}${item.status === "prepared" ? " ✓" : ""}</span></div>`;
  }).join("");
}
function newOrder() {
  state.currentOrder = { ...recipes.burger, id: state.orderNumber++ };
  $("orderCard").innerHTML = `<strong>Order #${state.currentOrder.id}: ${state.currentOrder.emoji} ${state.currentOrder.name}</strong><div>Required: bun + patty + lettuce</div><div>Reward: 100 points</div>`;
}
function setGuide(tab) {
  const guides = {
    movement: ["Move on the 10 × 10 grid", "Bottom-left is (1,1). Top-right is (10,10).", "move_to(10, 1)"],
    fridge: ["Patty / lettuce", "The full kitchen will be added after the map and table coordinates are provided.", 'take("patty")\ntake("lettuce")'],
    cutting: ["Cut lettuce", "Command kept for the burger level; the cutting station will be placed after the map is provided.", 'cut("lettuce")'],
    fry: ["Cook bun or patty", "Command kept for the burger level; the cooking station will be placed after the map is provided.", 'fry("bun")'],
    plate: ["Plate ingredients", "Command kept for the burger level; the plate station will be placed after the map is provided.", 'plate("bun")'],
    wash: ["Wash a plate", "Command kept for the burger level; the sink will be placed after the map is provided.", "wash_plate()"],
    serve: ["Serve the burger", "Command kept for the burger level; the serving counter will be placed after the map is provided.", "serve()"]
  };
  const [action, text, code] = guides[tab];
  $("guideAction").textContent = action; $("guideText").textContent = text; $("guideCode").textContent = code;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
}
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setGuide(b.dataset.tab)));

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

function setOrderDrawer(open){$("orderDrawer").classList.toggle("hidden",!open);$("orderDrawer").setAttribute("aria-hidden",String(!open));$("orderToggle").setAttribute("aria-expanded",String(open));}
$("orderToggle").addEventListener("click",()=>setOrderDrawer($("orderDrawer").classList.contains("hidden")));
$("orderClose").addEventListener("click",()=>setOrderDrawer(false));

class KitchenScene extends Phaser.Scene {
  constructor(){super("KitchenScene");}
  preload(){
    this.load.image("bunChestClosed",bunChestSprite.closed);
    this.load.image("bunChestOpen",bunChestSprite.open);
    this.load.image("uncookedBun","/static/assets/bun/uncooked_bun.png");
    this.load.image("cookedBun","/static/assets/bun/cooked_bun.png");
  }
  create(){
    state.scene=this; this.cameras.main.setBackgroundColor("#F4D6A0"); this.drawKitchen();
    const start=gridToPixel(1,1); state.player={x:start.x,y:start.y};
    this.playerSprite=this.add.rectangle(start.x,start.y,28,28,0x26364A).setStrokeStyle(3,0xF6C945).setDepth(5);
    updateHUD();
  }
  drawKitchen(){
    this.add.rectangle(240,240,480,480,0xF9E6BD).setStrokeStyle(4,0x8B5A3C);
    const g=this.add.graphics(); g.lineStyle(1,0xD7B77F,1);
    for(let i=0;i<=10;i++){const p=i*TILE_SIZE;g.lineBetween(p,0,p,480);g.lineBetween(0,p,480,p);}
    const s=stations.bun;
    this.bunChestSprite=this.add.image(s.x,s.y,"bunChestClosed").setDisplaySize(64,64).setDepth(2);
    this.add.text(s.x,s.y+36,"Bun Chest",{fontFamily:"Arial",fontSize:"11px",fontStyle:"bold",color:"#3A2A2A"}).setOrigin(.5);
    this.add.text(456,465,"(10, 1)",{fontFamily:"Arial",fontSize:"10px",color:"#6F4B32"}).setOrigin(.5);
  }
  movePlayerTo(x,y){
    return new Promise(resolve=>{
      const from={x:this.playerSprite.x,y:this.playerSprite.y};
      const duration=Math.max(180,distance(from,{x,y})*4);
      this.tweens.add({targets:this.playerSprite,x,y,duration,ease:"Sine.easeInOut",
        onUpdate:()=>{state.player.x=this.playerSprite.x;state.player.y=this.playerSprite.y;updateHUD();},
        onComplete:()=>{state.player.x=x;state.player.y=y;updateHUD();resolve();}});
    });
  }
  showItemEffect(text,emoji){const t=this.add.text(state.player.x,state.player.y-34,`${emoji} ${text}`,{fontFamily:"Arial",fontSize:"14px",color:"#3A2A2A",backgroundColor:"#fff"}).setOrigin(.5);this.tweens.add({targets:t,y:t.y-22,alpha:0,duration:700,onComplete:()=>t.destroy()});}
  showBunChestAnimation(){
    if(!this.bunChestSprite)return;
    this.bunChestSprite.setTexture("bunChestOpen");
    this.time.delayedCall(650,()=>this.bunChestSprite?.setTexture("bunChestClosed"));
  }
}

function addItem(type,status="raw"){
  const index=state.backpack.findIndex(x=>!x); if(index===-1)throw new Error("Backpack is full. Maximum 3 items.");
  const info=itemInfo[type]; state.backpack[index]={type,status,emoji:status==="prepared"?info.cooked:info.raw};renderBackpack();
}
function findItem(type){return state.backpack.find(x=>x&&x.type===type);}
function removeItem(type){const i=state.backpack.findIndex(x=>x&&x.type===type);if(i===-1)throw new Error(`You do not have ${type}.`);const item=state.backpack[i];state.backpack[i]=null;renderBackpack();return item;}
function requireNear(name){if(!nearStation(name))throw new Error(`Move close to ${stations[name].label} at (${stations[name].column}, ${stations[name].row}) first.`);}
function requireItem(type){const item=findItem(type);if(!item)throw new Error(`You do not have ${type}.`);return item;}

// Every game action is queued. A new command cannot start until the previous
// movement/animation/action has finished. This prevents command/game desync.
function action(fn){const run=state.actionQueue.then(fn);state.actionQueue=run.catch(()=>{});return run;}

function executeGameCommand(name,args){
  if(state.gameEnded)throw new Error("The game has ended.");
  if(name==="move_to"){
    const c=Number(args[0]),r=Number(args[1]);
    if(!Number.isInteger(c)||!Number.isInteger(r)||c<1||c>10||r<1||r>10)throw new Error("move_to(column, row) uses grid values from 1 to 10. Bottom-left is (1,1), top-right is (10,10).");
    return action(async()=>{const p=gridToPixel(c,r);await state.scene.movePlayerTo(p.x,p.y);log(`Moved to (${c}, ${r}).`);});
  }
  if(name==="take"){
    const type=String(args[0]);
    if(type!=="bun")throw new Error("For the current test level, only take(\"bun\") is available. Patty and lettuce will be added with the map.");
    return action(async()=>{requireNear("bun");state.scene.showBunChestAnimation();await new Promise(r=>setTimeout(r,650));addItem("bun");state.scene.showItemEffect("Took bun","🍞");log("Collected bun.");});
  }
  if(name==="cut"||name==="fry"||name==="plate"||name==="wash_plate"||name==="serve"){
    return action(async()=>{throw new Error(`${name}() is kept for the burger level, but its station has not been placed yet. The table/map coordinates will determine its location.`);});
  }
  if(name==="wait")return action(async()=>{const seconds=Math.max(0,Math.min(10,Number(args[0]||1)));await new Promise(r=>setTimeout(r,seconds*1000));log(`Waited ${seconds} second(s).`);});
  if(name==="status")return action(async()=>{const g=pixelToGrid(state.player.x,state.player.y);log(JSON.stringify({position:[g.column,g.row],backpack:state.backpack,order:state.currentOrder},null,2));});
  throw new Error(`Unknown game command: ${name}`);
}

window.execute_game_command=async(name,args)=>executeGameCommand(name,args);

async function loadPython(){
  try{
    state.pyodide=await loadPyodide();
    await state.pyodide.runPythonAsync(`
import js
def move_to(column, row):
    return js.execute_game_command("move_to", [column, row])
def take(item):
    return js.execute_game_command("take", [item])
def cut(item):
    return js.execute_game_command("cut", [item])
def fry(item):
    return js.execute_game_command("fry", [item])
def plate(item):
    return js.execute_game_command("plate", [item])
def wash_plate():
    return js.execute_game_command("wash_plate", [])
def serve():
    return js.execute_game_command("serve", [])
def wait(seconds=1):
    return js.execute_game_command("wait", [seconds])
def status():
    return js.execute_game_command("status", [])
`);
    $("runBtn").disabled=false;$("consoleOutput").textContent="Python loaded. Write commands and click Run Python.";
  }catch(e){log("Could not load Pyodide: "+e);}
}
async function runPython(){
  if(!state.pyodide||state.gameEnded)return;clearLog();
  try{await state.pyodide.runPythonAsync($("codeEditor").value);log("Python execution finished.");}
  catch(e){log("Python error: "+e.message);}
}
function startTimer(){const timer=setInterval(()=>{if(!state.running||state.gameEnded){clearInterval(timer);return;}state.timeLeft--;updateHUD();if(state.timeLeft<=0)finishGame();},1000);}
async function finishGame(){if(state.gameEnded)return;state.gameEnded=true;state.running=false;state.finishedAt=new Date();showScreen("resultScreen");$("resultSummary").innerHTML=`<p><b>${escapeHtml(state.playerName)}</b>, your time is up.</p><p>Score: <b>${state.score}</b></p><p>Orders completed: <b>${state.ordersCompleted}</b></p>`;try{const r=await fetch("/api/scores",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({player_name:state.playerName,score:state.score,game_mode:"Solo Burger Rush",time_completed:new Date().toISOString(),orders_completed:state.ordersCompleted})});if(!r.ok)throw new Error();$("resultSummary").innerHTML+=`<p class="small-note">Score saved to the shared leaderboard.</p>`;}catch(_){$("resultSummary").innerHTML+=`<p class="small-note">Could not save score. Check the server connection.</p>`;}}
async function showLeaderboard(){showScreen("leaderboardScreen");try{const r=await fetch("/api/leaderboard"),rows=await r.json();if(!rows.length){$("leaderboardContent").textContent="No scores yet.";return;}$("leaderboardContent").innerHTML=`<table><thead><tr><th>Rank</th><th>Name</th><th>Score</th><th>Mode</th><th>Completed</th><th>Orders</th></tr></thead><tbody>`+rows.map((x,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(x.player_name)}</td><td>${x.score}</td><td>${escapeHtml(x.game_mode)}</td><td>${new Date(x.time_completed).toLocaleString()}</td><td>${x.orders_completed}</td></tr>`).join("")+`</tbody></table>`;}catch(_){$("leaderboardContent").textContent="Could not load leaderboard.";}}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

$("startBtn").addEventListener("click",()=>{
  const name=$("playerName").value.trim();if(!name){alert("Please enter a player name.");return;}
  playOptionalSound("button_click");state.playerName=name;state.score=0;state.ordersCompleted=0;state.timeLeft=state.timeLimit;state.backpack=[null,null,null];state.items={};state.orderNumber=1;state.gameEnded=false;state.running=true;state.actionQueue=Promise.resolve();showScreen("gameScreen");
  if(!state.scene){new Phaser.Game({type:Phaser.AUTO,width:480,height:480,parent:"gameContainer",backgroundColor:"#F4D6A0",scene:KitchenScene});}
  newOrder();updateHUD();startTimer();
});
$("runBtn").addEventListener("click",runPython);
$("clearBtn").addEventListener("click",()=>{$("codeEditor").value="";clearLog();});
$("hintBtn").addEventListener("click",()=>log('Hint: move_to(10, 1) then take("bun")'));
$("leaderboardBtn").addEventListener("click",showLeaderboard);
$("backBtn").addEventListener("click",()=>showScreen("resultScreen"));
$("restartBtn").addEventListener("click",()=>location.reload());

startMenuMusic();window.addEventListener("pointerdown",unlockMenuAudio,{once:true});window.addEventListener("keydown",unlockMenuAudio,{once:true});
fetch("/api/health").catch(()=>null);loadPython();
