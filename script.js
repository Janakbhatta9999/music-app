/* ---------- Data model ---------- */
// song = { id, kind: "audio" | "yt", src | videoId, title, artist, year, date, art, order }
let songs = [];          // the queue
let currentId = null;    // track the current song by id, not index
let orderCounter = 0;    // tie-break for songs with the same date
let repeatAll = false;
let lastResults = [];
let recs = [];
let shuffle = false;     // random order instead of old -> new
let endless = true;      // keep finding new songs so playback never stops
let fetching = false;
const playedIds = new Set();   // songs already played in this round
const history = [];            // for the Prev button in shuffle mode
let goingBack = false;

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
const YT_REGION = "NP";
const YT_PROXY = "/.netlify/functions/youtube";   // hosted site: the server adds the key, so nobody is asked for it
const USE_PROXY = !["localhost", "127.0.0.1", ""].includes(location.hostname);       // region used for YouTube trending (NP = Nepal)
const GENRES = ["All", "Electronic", "Hip-Hop/Rap", "Pop", "Rock", "Acoustic", "Jazz", "World"];

const auth = () => "app_name=" + APP_NAME + (AUDIUS_KEY ? "&api_key=" + AUDIUS_KEY : "");

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
  return res.json();
}

/* Every song gets a "group" (the search or genre it came from). Next/Endless stay inside that group,
   so a song from "old nepali songs" is followed by more old Nepali songs. */
const pageState = {};   // remembers which page of results each group reached, so Endless finds NEW songs
const tag = (list, group) => list.map((t) => ({ ...t, group }));
const streamable = (t) => t.is_streamable !== false;

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
async function searchAudius(term, usePage = false) {
  const g = "audius:" + term.toLowerCase();
  const off = usePage ? pageState[g] || 0 : 0;
  const d = await getJson(AUDIUS + "/tracks/search?limit=25&offset=" + off + "&query=" + encodeURIComponent(term) + "&" + auth());
  pageState[g] = off + 25;
  return tag(d.data.filter(streamable).map(mapAudius), g);
}
async function trendingAudius(genre, usePage = false) {
  const name = genre && genre !== "All" ? genre : "All";
  const g = "audius:genre:" + name;
  const off = usePage ? pageState[g] || 0 : 0;
  const gp = name !== "All" ? "&genre=" + encodeURIComponent(name) : "";
  const d = await getJson(AUDIUS + "/tracks/trending?limit=20&time=week&offset=" + off + gp + "&" + auth());
  pageState[g] = off + 20;
  return tag(d.data.filter(streamable).map(mapAudius), g);
}

/* iTunes: 30-second previews */
async function searchItunes(term, limit = 25) {
  const g = "itunes:" + term.toLowerCase();
  const d = await getJson("https://itunes.apple.com/search?media=music&entity=song&limit=" + limit + "&term=" + encodeURIComponent(term));
  return tag(d.results.filter((r) => r.previewUrl && r.releaseDate).map((r) => ({
    id: "i" + r.trackId, kind: "audio",
    title: r.trackName, artist: r.artistName,
    date: r.releaseDate.slice(0, 10), year: Number(r.releaseDate.slice(0, 4)),
    src: r.previewUrl, art: (r.artworkUrl100 || "").replace("100x100", "200x200"),
  })), g);
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

const ytAvailable = () => USE_PROXY || !!getYtKey(false);

function ytFailure(err) {
  if (USE_PROXY) {
    return err.status === 403 || err.status === 429
      ? "Today's YouTube limit is used up. Audius songs still work. Try YouTube again tomorrow."
      : "Could not reach YouTube right now. Try again in a moment.";
  }
  if (err.status === 400 || err.status === 403) {
    localStorage.removeItem("ytKey");
    return "YouTube rejected the key or the daily limit is used up. Search again to enter a new key.";
  }
  return "Could not reach YouTube. Check your internet connection.";
}

async function searchYoutube(term, ask = true, usePage = false) {
  const key = USE_PROXY ? "" : getYtKey(ask);
  if (!USE_PROXY && !key) throw Object.assign(new Error("no key"), { noKey: true });
  const g = "yt:" + term.toLowerCase();
  if (usePage && pageState[g] === null) return [];          // no more pages for this search
  const pageToken = usePage && pageState[g] ? "&pageToken=" + pageState[g] : "";
  const url = USE_PROXY
    ? YT_PROXY + "?kind=search&q=" + encodeURIComponent(term) + pageToken
    : "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&videoEmbeddable=true&maxResults=20"
      + "&q=" + encodeURIComponent(term) + pageToken + "&key=" + encodeURIComponent(key);
  const d = await getJson(url);
  pageState[g] = d.nextPageToken || null;
  return tag(d.items.map((it) => mapYt(it.id.videoId, it.snippet)), g);
}

async function trendingYoutube(usePage = false) {
  const key = USE_PROXY ? "" : getYtKey(false);
  if (!USE_PROXY && !key) return null;
  const g = "yt:trending";
  if (usePage && pageState[g] === null) return [];
  const pageToken = usePage && pageState[g] ? "&pageToken=" + pageState[g] : "";
  const url = USE_PROXY
    ? YT_PROXY + "?kind=trending&region=" + YT_REGION + pageToken
    : "https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&videoCategoryId=10&maxResults=20"
      + "&regionCode=" + YT_REGION + pageToken + "&key=" + encodeURIComponent(key);
  const d = await getJson(url);
  pageState[g] = d.nextPageToken || null;
  return tag(d.items.map((it) => mapYt(it.id, it.snippet)), g);
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
  if (autoplay && currentId !== null && currentId !== id && !goingBack) {
    history.push(currentId);
    if (history.length > 50) history.shift();
  }
  currentId = id;
  if (autoplay) markPlayed(id);

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
  loadLyrics(song);
}

function playSong(id) {
  if (id !== currentId) loadSong(id, true);
  else resume();
}

function resume() {
  if (currentId !== null) markPlayed(currentId);
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

function markPlayed(id) {
  playedIds.add(id);
  ensureStock();
}

const unplayedSongs = () => songs.filter((x) => !playedIds.has(x.id) && x.id !== currentId);

// Next song: related (same group) first. Random in shuffle mode, otherwise the next newer one.
function pickNext(relatedOnly) {
  const cur = currentSong();
  let pool = unplayedSongs();
  if (relatedOnly && cur) pool = pool.filter((x) => x.group === cur.group);
  if (!pool.length) return null;
  if (shuffle) return pool[Math.floor(Math.random() * pool.length)].id;
  const i = currentIndex();
  const after = pool.find((x) => songs.indexOf(x) > i);
  return (after || pool[0]).id;
}

async function next() {
  if (!songs.length) return;
  let id = pickNext(true);                                   // 1. related song already in the queue
  if (!id && endless) { await fetchMore(); id = pickNext(true); }   // 2. find more related songs
  if (!id) id = pickNext(false);                             // 3. anything left in the queue
  if (!id && repeatAll) { playedIds.clear(); playedIds.add(currentId); id = pickNext(false); }
  if (id) playSong(id);
  else { pause(); setStatus("End of the queue. Turn on Endless to keep going."); }
}

function prev() {
  if (!songs.length) return;
  if (nowTime() > 3) { seekTo(0); return; }
  if (shuffle) {
    while (history.length) {
      const id = history.pop();
      if (songs.some((x) => x.id === id)) { goingBack = true; playSong(id); goingBack = false; return; }
    }
    return;
  }
  const i = currentIndex();
  if (i > 0) playSong(songs[i - 1].id);
}

const nowTime = () => (backend() === "yt" && yt.ready ? yt.player.getCurrentTime() || 0 : audio.currentTime);

/* ---------- Endless mode: keep finding related songs ---------- */
let fetchPromise = null;

function ensureStock() {
  const cur = currentSong();
  if (!endless || fetchPromise || !cur) return;
  const related = unplayedSongs().filter((x) => x.group === cur.group);
  if (related.length <= 2) fetchMore(cur.group);
}

function addMany(tracks) {
  let n = 0;
  tracks.forEach((t) => {
    if (!inQueue(t.id)) { songs.push({ ...t, order: orderCounter++ }); n++; }
  });
  if (!n) return 0;
  sortSongs();
  if (songs.length > 80) {   // keep the queue small: drop old played songs
    let excess = songs.length - 60;
    songs = songs.filter((x) => {
      if (excess > 0 && playedIds.has(x.id) && x.id !== currentId) { excess--; return false; }
      return true;
    });
  }
  save();
  renderQueue();
  refreshLists();
  if (currentId === null) loadSong(songs[0].id);
  return n;
}

// More songs of the same kind: the next page of the same search or genre, then the same artist.
async function findMoreTracks(group) {
  const cur = currentSong();
  const sep = (group || "").indexOf(":");
  const src = sep > 0 ? group.slice(0, sep) : "";
  const rest = sep > 0 ? group.slice(sep + 1) : "";
  const attempts = [];

  if (src === "yt" && ytAvailable()) {
    if (rest === "trending") attempts.push(() => trendingYoutube(true));
    else attempts.push(() => searchYoutube(rest, false, true));
    if (cur) {
      attempts.push(() => searchYoutube(cur.artist + " " + (rest === "trending" ? "songs" : rest), false));
      attempts.push(() => searchYoutube(cur.artist + " songs", false));
    }
  } else if (src === "audius") {
    if (rest.startsWith("genre:")) attempts.push(() => trendingAudius(rest.slice(6), true));
    else attempts.push(() => searchAudius(rest, true));
  } else if (src === "itunes") {
    attempts.push(() => searchItunes(rest, 100));
  } else if (cur && kindOf(cur) === "yt" && ytAvailable()) {   // songs saved by an older version
    attempts.push(() => searchYoutube(cur.artist + " songs", false));
  } else {
    attempts.push(() => trendingAudius(GENRES[1 + Math.floor(Math.random() * (GENRES.length - 1))]));
  }

  for (const run of attempts) {
    try {
      const list = ((await run()) || []).filter((t) => !inQueue(t.id));
      if (list.length) return list.map((t) => ({ ...t, group: group || t.group }));
    } catch (e) { /* try the next idea */ }
  }
  return [];
}

function fetchMore(group = (currentSong() || {}).group) {
  if (fetchPromise) return fetchPromise;
  fetchPromise = (async () => {
    try {
      const found = await findMoreTracks(group);
      if (!addMany(found)) setStatus("Could not find new related songs right now.");
    } catch (e) {
      setStatus("Could not find more songs. Check your internet connection.");
    }
  })().finally(() => { fetchPromise = null; });
  return fetchPromise;
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

/* ---------- Floating lyrics (loaded from LRCLIB, a free lyrics database) ---------- */
const lyricsCache = new Map();
let lyricsOpen = false, lyricLines = [], lyricSynced = false, lyricOffset = 0, activeLine = -1, lyricsFor = null;

function cleanTitle(t) {
  return (t || "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/official|lyrical|lyrics?|video|audio|full song|music|\bhd\b|\b4k\b/gi, " ")
    .replace(/\s+/g, " ").trim();
}

function guessNames(song) {
  let title = song.title, artist = song.artist;
  if (kindOf(song) === "yt") {
    artist = artist.replace(/\s*-\s*topic$/i, "").replace(/vevo$/i, "");
    const parts = title.split(/\s[-–|]\s/);
    if (parts.length >= 2) { artist = parts[0]; title = parts[1]; }
  }
  return { title: cleanTitle(title), artist: cleanTitle(artist) };
}

function parseLrc(text) {
  const out = [];
  (text || "").split("\n").forEach((line) => {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (m && m[3].trim()) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() });
  });
  return out;
}

async function fetchLyrics(song) {
  if (lyricsCache.has(song.id)) return lyricsCache.get(song.id);
  const { title, artist } = guessNames(song);
  const enc = encodeURIComponent;
  let hit = null;
  try {
    const r = await fetch("https://lrclib.net/api/get?track_name=" + enc(title) + "&artist_name=" + enc(artist));
    if (r.ok) hit = await r.json();
    if (!hit) {
      for (const q of [title + " " + artist, title]) {
        const r2 = await fetch("https://lrclib.net/api/search?q=" + enc(q));
        if (!r2.ok) continue;
        const list = await r2.json();
        hit = list.find((x) => x.syncedLyrics) || list.find((x) => x.plainLyrics) || null;
        if (hit) break;
      }
    }
  } catch (e) { return { error: true }; }   // errors are not cached, so it can retry later
  const result = hit ? { synced: parseLrc(hit.syncedLyrics), plain: hit.plainLyrics || "" } : { none: true };
  lyricsCache.set(song.id, result);
  return result;
}

function lyricsMessage(text) {
  const body = $("lyricsBody");
  body.innerHTML = "";
  const p = document.createElement("p");
  p.textContent = text;
  body.appendChild(p);
  lyricLines = []; lyricSynced = false;
}

async function showLyrics(song) {
  if (!song) return lyricsMessage("Play a song to see its lyrics.");
  lyricsFor = song.id;
  lyricOffset = 0;
  $("lyOffset").textContent = "0s";
  lyricsMessage("Loading lyrics...");
  const res = await fetchLyrics(song);
  if (lyricsFor !== song.id) return;               // the song changed while loading
  if (res.error) return lyricsMessage("Could not load lyrics. Check your internet connection.");
  if (res.none || (!res.synced.length && !res.plain)) return lyricsMessage("Lyrics not found for this song. Many regional songs are not in this free database yet.");

  const body = $("lyricsBody");
  body.innerHTML = "";
  body.scrollTop = 0;
  if (res.synced.length) {
    lyricLines = res.synced; lyricSynced = true; activeLine = -1;
    lyricLines.forEach((l) => { const p = document.createElement("p"); p.textContent = l.text; body.appendChild(p); });
  } else {
    lyricSynced = false;
    res.plain.split("\n").forEach((line) => { const p = document.createElement("p"); p.textContent = line || "\u00A0"; p.className = "plain"; body.appendChild(p); });
  }
}

function loadLyrics(song) { if (lyricsOpen) showLyrics(song); }

setInterval(() => {   // highlight the line being sung
  if (!lyricsOpen || !lyricSynced) return;
  const t = nowTime() + lyricOffset;
  let idx = -1;
  for (let i = 0; i < lyricLines.length; i++) { if (lyricLines[i].t <= t) idx = i; else break; }
  if (idx === activeLine) return;
  const lines = $("lyricsBody").children;
  if (lines[activeLine]) lines[activeLine].classList.remove("on");
  activeLine = idx;
  if (lines[idx]) {
    lines[idx].classList.add("on");
    const body = $("lyricsBody");
    body.scrollTo({ top: lines[idx].offsetTop - body.clientHeight / 2 + lines[idx].clientHeight / 2, behavior: "smooth" });
  }
}, 250);

function setLyricsOpen(open) {
  lyricsOpen = open;
  $("lyricsPanel").hidden = !open;
  $("lyricsBtn").setAttribute("aria-pressed", open);
  if (open) showLyrics(currentSong());
}
$("lyricsBtn").addEventListener("click", () => setLyricsOpen(!lyricsOpen));
$("lyClose").addEventListener("click", () => setLyricsOpen(false));
$("lyEarlier").addEventListener("click", () => { lyricOffset -= 0.5; $("lyOffset").textContent = lyricOffset + "s"; });
$("lyLater").addEventListener("click", () => { lyricOffset += 0.5; $("lyOffset").textContent = lyricOffset + "s"; });

// Drag the lyrics window anywhere on the screen
(function makeDraggable() {
  const panel = $("lyricsPanel"), bar = $("lyricsBar");
  let dx = 0, dy = 0, dragging = false;
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const r = panel.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top; dragging = true;
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const x = Math.min(Math.max(0, e.clientX - dx), window.innerWidth - panel.offsetWidth);
    const y = Math.min(Math.max(0, e.clientY - dy), window.innerHeight - 60);
    panel.style.left = x + "px"; panel.style.top = y + "px";
    panel.style.right = "auto"; panel.style.bottom = "auto";
  });
  bar.addEventListener("pointerup", () => { dragging = false; });
})();

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
function saveSettings() {
  try { localStorage.setItem("oldToNewSettings", JSON.stringify({ shuffle, endless, repeatAll })); } catch (e) {}
}
function loadSettings() {
  try {
    const st = JSON.parse(localStorage.getItem("oldToNewSettings") || "null");
    if (st) { shuffle = !!st.shuffle; endless = st.endless !== false; repeatAll = !!st.repeatAll; }
  } catch (e) {}
  $("shuffleBtn").setAttribute("aria-pressed", shuffle);
  $("endlessBtn").setAttribute("aria-pressed", endless);
  $("repeatBtn").setAttribute("aria-pressed", repeatAll);
}

$("repeatBtn").addEventListener("click", (e) => {
  repeatAll = !repeatAll;
  e.currentTarget.setAttribute("aria-pressed", repeatAll);
  saveSettings();
});
$("shuffleBtn").addEventListener("click", (e) => {
  shuffle = !shuffle;
  e.currentTarget.setAttribute("aria-pressed", shuffle);
  setStatus(shuffle ? "Shuffle on: songs play in random order." : "Shuffle off: songs play from old to new.");
  saveSettings();
});
$("endlessBtn").addEventListener("click", (e) => {
  endless = !endless;
  e.currentTarget.setAttribute("aria-pressed", endless);
  setStatus(endless ? "Endless on: new songs are added automatically." : "Endless off: playback stops at the end of the queue.");
  saveSettings();
  if (endless) ensureStock();
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
loadSettings();
renderQueue();
if (songs.length) loadSong(songs[0].id);
loadRecs("All");