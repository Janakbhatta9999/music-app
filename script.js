/* ---------- Data model ---------- */
// song = { id, kind: "audio" | "yt", src | videoId, title, artist, year, date, art, order }
let songs = [];          // the queue
let currentId = null;    // track the current song by id, not index
let orderCounter = 0;    // tie-break for songs with the same date
let repeatAll = false;
let lastResults = [];
let recs = [];

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const playBtn = $("playBtn");
const STORE_KEY = "oldToNewQueue";
const kindOf = (song) => song.kind || "audio";

/* ---------- Sources ---------- */
const APP_NAME = "OldToNew";
const AUDIUS = "https://api.audius.co/v1";
const AUDIUS_KEY = "";        // optional Audius API key
const YT_KEY = "";            // optional: paste your YouTube API key here instead of typing it in the page
const YT_REGION = "NP";       // region used for YouTube trending (NP = Nepal)
const GENRES = ["All", "Electronic", "Hip-Hop/Rap", "Pop", "Rock", "Acoustic", "Jazz", "World"];

const auth = () => "app_name=" + APP_NAME + (AUDIUS_KEY ? "&api_key=" + AUDIUS_KEY : "");

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
  return res.json();
}

/* Audius: full-length independent music, free */
function mapAudius(t) {
  const date = (t.release_date || t.created_at || "").slice(0, 10);
  const art = t.artwork ? (t.artwork["480x480"] || t.artwork["150x150"] || "") : "";
  return {
    id: "a" + t.id, kind: "audio",
    title: t.title, artist: (t.user && t.user.name) || "Unknown artist",
    date, year: Number(date.slice(0, 4)) || 0,
    src: AUDIUS + "/tracks/" + t.id + "/stream?" + auth(), art,
  };
}
async function searchAudius(term) {
  const d = await getJson(AUDIUS + "/tracks/search?limit=25&query=" + encodeURIComponent(term) + "&" + auth());
  return d.data.filter((t) => t.is_streamable !== false).map(mapAudius);
}
async function trendingAudius(genre) {
  const g = genre && genre !== "All" ? "&genre=" + encodeURIComponent(genre) : "";
  const d = await getJson(AUDIUS + "/tracks/trending?limit=20&time=week" + g + "&" + auth());
  return d.data.filter((t) => t.is_streamable !== false).map(mapAudius);
}

/* iTunes: 30-second previews */
async function searchItunes(term) {
  const d = await getJson("https://itunes.apple.com/search?media=music&entity=song&limit=25&term=" + encodeURIComponent(term));
  return d.results.filter((r) => r.previewUrl && r.releaseDate).map((r) => ({
    id: "i" + r.trackId, kind: "audio",
    title: r.trackName, artist: r.artistName,
    date: r.releaseDate.slice(0, 10), year: Number(r.releaseDate.slice(0, 4)),
    src: r.previewUrl, art: (r.artworkUrl100 || "").replace("100x100", "200x200"),
  }));
}

/* YouTube: famous songs, full length (needs a free API key) */
const decodeText = (s) => { const t = document.createElement("textarea"); t.innerHTML = s || ""; return t.value; };

function mapYt(videoId, sn) {
  const date = (sn.publishedAt || "").slice(0, 10);
  const th = sn.thumbnails || {};
  return {
    id: "y" + videoId, kind: "yt", videoId,
    title: decodeText(sn.title), artist: decodeText(sn.channelTitle),
    date, year: Number(date.slice(0, 4)) || 0,
    art: (th.medium || th.default || {}).url || "",
  };
}

function getYtKey(askIfMissing) {
  let key = YT_KEY || localStorage.getItem("ytKey") || "";
  if (!key && askIfMissing) {
    key = (prompt("Paste your YouTube Data API key (free from Google Cloud Console):") || "").trim();
    if (key) localStorage.setItem("ytKey", key);
  }
  return key;
}

function ytFailure(err) {
  if (err.status === 400 || err.status === 403) {
    localStorage.removeItem("ytKey");
    return "YouTube rejected the key or the daily limit is used up. Search again to enter a new key.";
  }
  return "Could not reach YouTube. Check your internet connection.";
}

async function searchYoutube(term) {
  const key = getYtKey(true);
  if (!key) throw Object.assign(new Error("no key"), { noKey: true });
  const url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&videoEmbeddable=true&maxResults=20"
    + "&q=" + encodeURIComponent(term) + "&key=" + encodeURIComponent(key);
  const d = await getJson(url);
  return d.items.map((it) => mapYt(it.id.videoId, it.snippet));
}

async function trendingYoutube() {
  const key = getYtKey(false);
  if (!key) return null;
  const url = "https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&videoCategoryId=10&maxResults=20"
    + "&regionCode=" + YT_REGION + "&key=" + encodeURIComponent(key);
  const d = await getJson(url);
  return d.items.map((it) => mapYt(it.id, it.snippet));
}

/* ---------- Search ---------- */
$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const term = $("q").value.trim();
  if (!term) return;
  const source = $("source").value;
  $("searchMsg").textContent = "Searching...";
  $("results").innerHTML = "";
  try {
    lastResults = source === "audius" ? await searchAudius(term)
                : source === "youtube" ? await searchYoutube(term)
                : await searchItunes(term);
    $("searchMsg").textContent = lastResults.length ? "" : "No songs found. Try another name or switch the source.";
    renderTracks($("results"), lastResults);
    if (source === "youtube") loadRecs(); // key is saved now, so trending can load
  } catch (err) {
    $("searchMsg").textContent = err.noKey ? "A YouTube key is needed for this source."
      : source === "youtube" ? ytFailure(err)
      : "Could not search. Check your internet connection and try again.";
  }
});

$("source").addEventListener("change", () => loadRecs());

/* ---------- Recommendations ---------- */
function renderGenres(active) {
  const box = $("genres");
  box.innerHTML = "";
  if ($("source").value === "youtube") return;   // genres only apply to Audius
  GENRES.forEach((g) => {
    const b = document.createElement("button");
    b.textContent = g;
    b.setAttribute("aria-pressed", g === active);
    b.addEventListener("click", () => loadRecs(g));
    box.appendChild(b);
  });
}

async function loadRecs(genre = "All") {
  const useYt = $("source").value === "youtube";
  renderGenres(genre);
  $("recs").innerHTML = "";
  recs = [];
  $("recMsg").textContent = "Loading trending songs...";
  try {
    if (useYt) {
      const list = await trendingYoutube();
      if (list === null) { $("recMsg").textContent = "Search once on YouTube to enter your key, then trending songs appear here."; return; }
      recs = list;
    } else {
      recs = await trendingAudius(genre);
    }
    $("recMsg").textContent = recs.length ? "" : "Nothing found.";
    renderTracks($("recs"), recs);
  } catch (err) {
    $("recMsg").textContent = useYt ? ytFailure(err) : "Could not load recommendations. Check your internet connection.";
  }
}

$("surpriseBtn").addEventListener("click", () => {
  if (!recs.length) return ($("recMsg").textContent = "No recommendations loaded yet.");
  const pick = recs[Math.floor(Math.random() * recs.length)];
  addToQueue(pick);
  playSong(pick.id);
});

/* ---------- Queue (sorted old -> new) ---------- */
const sortKey = (s) => s.date || String(s.year || 0);
const sortSongs = () => songs.sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.order - b.order);
const inQueue = (id) => songs.some((s) => s.id === id);

function addToQueue(track) {
  if (inQueue(track.id)) return false;
  songs.push({ ...track, order: orderCounter++ });
  sortSongs();
  save();
  renderQueue();
  refreshLists();
  if (currentId === null) loadSong(track.id);
  return true;
}

function removeFromQueue(id) {
  const wasCurrent = id === currentId;
  songs = songs.filter((s) => s.id !== id);
  if (wasCurrent) {
    stopAll();
    currentId = null;
    if (songs.length) loadSong(songs[0].id); else resetPlayer();
  }
  save();
  renderQueue();
  refreshLists();
}

// YouTube gives the upload date, not the song's release year, so the year can be corrected.
function editYear(id) {
  const s = songs.find((x) => x.id === id);
  if (!s) return;
  const input = prompt('Release year for "' + s.title + '":', s.year || "");
  const y = Number(input);
  if (!input || !Number.isInteger(y) || y < 1900 || y > 2100) return;
  s.year = y;
  s.date = String(y);
  sortSongs();
  save();
  renderQueue();
  if (id === currentId) $("recordYear").textContent = y;
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ songs, orderCounter })); } catch (e) {}
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && Array.isArray(saved.songs)) {
      songs = saved.songs;
      orderCounter = saved.orderCounter || songs.length;
      sortSongs();
    }
  } catch (e) {}
}

/* ---------- YouTube player ---------- */
const yt = { player: null, ready: false, pending: null }; // pending = { videoId, autoplay }

const ytTag = document.createElement("script");
ytTag.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(ytTag);

window.onYouTubeIframeAPIReady = () => {
  yt.player = new YT.Player("ytBox", {
    width: "100%", height: "100%",
    playerVars: { playsinline: 1, rel: 0 },
    events: {
      onReady: () => {
        yt.ready = true;
        yt.player.setVolume(Number($("volume").value) * 100);
        if (yt.pending) { ytLoad(yt.pending.videoId, yt.pending.autoplay); yt.pending = null; }
      },
      onStateChange: (e) => {
        if (backend() !== "yt") return;
        if (e.data === YT.PlayerState.PLAYING) setPlayingUI(true);
        else if (e.data === YT.PlayerState.PAUSED) setPlayingUI(false);
        else if (e.data === YT.PlayerState.ENDED) { setPlayingUI(false); next(); }
      },
      onError: () => {
        if (backend() !== "yt") return;
        setStatus("This video cannot be played here. Skipping to the next one.");
        setTimeout(next, 1200);
      },
    },
  });
};

function ytLoad(videoId, autoplay) {
  if (autoplay) yt.player.loadVideoById(videoId);
  else yt.player.cueVideoById(videoId);
}

setInterval(() => {   // progress bar for YouTube songs
  if (backend() !== "yt" || !yt.ready) return;
  const cur = yt.player.getCurrentTime() || 0;
  const dur = yt.player.getDuration() || 0;
  $("timeNow").textContent = fmt(cur);
  $("timeTotal").textContent = fmt(dur);
  if (dur) $("progress").value = (cur / dur) * 100;
}, 500);

/* ---------- Playback engine (works for both audio files and YouTube) ---------- */
const currentSong = () => songs.find((s) => s.id === currentId);
const backend = () => (currentSong() ? kindOf(currentSong()) : "audio");
const currentIndex = () => songs.findIndex((s) => s.id === currentId);

function setPlayingUI(playing) {
  playBtn.textContent = playing ? "Pause" : "Play";
  $("record").classList.toggle("spin", playing);
}

function stopAll() {
  audio.pause();
  if (yt.ready) yt.player.stopVideo();
}

function loadSong(id, autoplay = false) {
  const song = songs.find((s) => s.id === id);
  if (!song) return;
  stopAll();
  currentId = id;

  if (kindOf(song) === "yt") {
    audio.removeAttribute("src");
    $("ytWrap").hidden = false;
    if (yt.ready) ytLoad(song.videoId, autoplay);
    else { yt.pending = { videoId: song.videoId, autoplay }; setStatus("YouTube player is loading..."); }
  } else {
    $("ytWrap").hidden = true;
    audio.src = song.src;
    if (autoplay) audio.play().catch(() => setStatus("Could not play this song."));
  }

  $("songTitle").textContent = song.title;
  $("songArtist").textContent = song.artist + (song.year ? " (" + song.year + ")" : "");
  $("recordYear").textContent = song.year || "----";
  $("progress").value = 0;
  $("timeNow").textContent = "0:00";
  if (kindOf(song) === "audio") setStatus("");
  renderQueue();
}

function playSong(id) {
  if (id !== currentId) loadSong(id, true);
  else resume();
}

function resume() {
  if (backend() === "yt") { if (yt.ready) yt.player.playVideo(); else setStatus("YouTube player is loading..."); }
  else audio.play().catch(() => setStatus("Could not play this song."));
}

function pause() {
  if (backend() === "yt") { if (yt.ready) yt.player.pauseVideo(); }
  else audio.pause();
}

function isPlaying() {
  if (backend() === "yt") return yt.ready && yt.player.getPlayerState() === YT.PlayerState.PLAYING;
  return !audio.paused;
}

function togglePlay() {
  if (!songs.length) return setStatus("Add a song or press Surprise me.");
  if (currentId === null) loadSong(songs[0].id);
  if (isPlaying()) pause(); else resume();
}

function next() {
  if (!songs.length) return;
  const i = currentIndex();
  if (i < songs.length - 1) playSong(songs[i + 1].id);
  else if (repeatAll) playSong(songs[0].id);
  else pause();
}

function prev() {
  if (!songs.length) return;
  const time = backend() === "yt" && yt.ready ? yt.player.getCurrentTime() : audio.currentTime;
  if (time > 3) { seekTo(0); return; }
  const i = currentIndex();
  if (i > 0) playSong(songs[i - 1].id);
}

function seekTo(seconds) {
  if (backend() === "yt") { if (yt.ready) yt.player.seekTo(seconds, true); }
  else audio.currentTime = seconds;
}

/* Audio-element events (only used for non-YouTube songs) */
audio.addEventListener("ended", () => { if (backend() === "audio") next(); });
audio.addEventListener("play", () => { if (backend() === "audio") setPlayingUI(true); });
audio.addEventListener("pause", () => { if (backend() === "audio") setPlayingUI(false); });
audio.addEventListener("error", () => {
  if (currentId === null || backend() !== "audio" || !audio.getAttribute("src")) return;
  setStatus("This song could not be loaded. Skipping to the next one.");
  setTimeout(next, 1200);
});
audio.addEventListener("loadedmetadata", () => { $("timeTotal").textContent = fmt(audio.duration); });
audio.addEventListener("timeupdate", () => {
  if (backend() !== "audio") return;
  $("timeNow").textContent = fmt(audio.currentTime);
  if (audio.duration) $("progress").value = (audio.currentTime / audio.duration) * 100;
});

/* ---------- Controls ---------- */
function fmt(s) {
  if (!isFinite(s)) return "0:00";
  return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
}

$("progress").addEventListener("input", (e) => {
  const dur = backend() === "yt" && yt.ready ? yt.player.getDuration() : audio.duration;
  if (dur) seekTo((e.target.value / 100) * dur);
});
$("volume").addEventListener("input", (e) => {
  audio.volume = e.target.value;
  if (yt.ready) yt.player.setVolume(e.target.value * 100);
});
audio.volume = 0.8;

playBtn.addEventListener("click", togglePlay);
$("nextBtn").addEventListener("click", next);
$("prevBtn").addEventListener("click", prev);
$("repeatBtn").addEventListener("click", (e) => {
  repeatAll = !repeatAll;
  e.currentTarget.setAttribute("aria-pressed", repeatAll);
});

/* ---------- Rendering ---------- */
function button(label, onClick, extraClass = "") {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = "del " + extraClass;
  b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
  return b;
}

function makeRow(track, buttons) {
  const li = document.createElement("li");
  li.className = "item";

  const img = document.createElement("img");
  img.alt = "";
  if (track.art) img.src = track.art;

  const meta = document.createElement("div");
  const t = document.createElement("div");
  t.className = "t"; t.textContent = track.title;
  const a = document.createElement("div");
  a.className = "a"; a.textContent = track.artist;
  meta.append(t, a);

  const btns = document.createElement("div");
  btns.className = "btns";
  const yr = document.createElement("span");
  yr.className = "yr"; yr.textContent = track.year || "";
  btns.append(yr, ...buttons);

  li.append(img, meta, btns);
  return li;
}

function renderTracks(ul, tracks) {   // search results and recommendations
  ul.innerHTML = "";
  tracks.forEach((track) => {
    const added = inQueue(track.id);
    const addBtn = button(added ? "Added" : "Add", () => addToQueue(track), "add");
    addBtn.disabled = added;
    const playNow = button("Play", () => { addToQueue(track); playSong(track.id); });
    ul.appendChild(makeRow(track, [playNow, addBtn]));
  });
}

function refreshLists() {
  renderTracks($("results"), lastResults);
  renderTracks($("recs"), recs);
}

function renderQueue() {
  const ol = $("list");
  ol.innerHTML = "";
  songs.forEach((s) => {
    const row = makeRow(s, [
      button("Year", () => editYear(s.id), "yearBtn"),
      button("Remove", () => removeFromQueue(s.id)),
    ]);
    if (s.id === currentId) row.classList.add("active");
    row.tabIndex = 0;
    row.addEventListener("click", () => playSong(s.id));
    row.addEventListener("keydown", (ev) => { if (ev.key === "Enter") playSong(s.id); });
    ol.appendChild(row);
  });
  $("count").textContent = "(" + songs.length + (songs.length === 1 ? " song)" : " songs)");
  $("empty").style.display = songs.length ? "none" : "block";
}

function resetPlayer() {
  audio.removeAttribute("src");
  $("ytWrap").hidden = true;
  setPlayingUI(false);
  $("songTitle").textContent = "Nothing playing";
  $("songArtist").textContent = "Search a song to begin";
  $("recordYear").textContent = "----";
  $("progress").value = 0;
  $("timeNow").textContent = "0:00";
  $("timeTotal").textContent = "0:00";
}

function setStatus(msg) { $("status").textContent = msg; }

/* ---------- Start ---------- */
restore();
renderQueue();
if (songs.length) loadSong(songs[0].id);
loadRecs("All");