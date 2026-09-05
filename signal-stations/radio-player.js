(() => {
  const data = window.SIGNAL_STATIONS;
  const byId = id => document.getElementById(id);
  const pick = items => items[Math.floor(Math.random() * items.length)];
  // "spoken" item kinds: short produced/rendered content that transitions on a fixed tail
  // overlap, not an outro guess (that's for actual songs, which have real musical structure).
  const isCallIn = type => type === 'caller talk-back';
  const isSpokenKind = type => type === 'host liner' || type === 'host bridge' || type === 'sponsored notice' || type === 'street report' || type === 'ad block intro' || type === 'ad block outro' || type === 'station ID' || isCallIn(type);
  const AD_BLOCK_KINDS = new Set(['ad block intro', 'ad block outro']);

  // --- crossfade/timing tuning -------------------------------------------------
  // Songs always play out, essentially to their real end -- no more cutting in over the
  // last chorus. The host is always the dominant, intelligible voice on entry: a fast duck
  // (not a slow symmetric blend), the outgoing song drops to a low background level rather
  // than an even 50/50 mix, then finishes fading out shortly after while the host talks.
  const SONG_TAIL_WINDOW_S = 8;   // trigger the transition somewhere in the song's final N seconds
  const TAIL_BUFFER_S = 1.5;      // never schedule a cut-in closer than this to a track's hard end
  const HOST_RISE_S = 0.4;        // fast rise to full gain for the incoming host content
  const SONG_DUCK_S = 0.6;        // fast duck of the outgoing song down to background level
  const SONG_DUCK_LEVEL = 0.18;   // background level the song bleeds under the host at
  const SONG_FULL_FADE_S = 1.8;   // after the duck, how long until the song is fully silent
  const FADE_S = 2.2;             // symmetric crossfade duration for entering a song (liner/song -> song)
  // Kept short on purpose (was 1.6s -- SIG feedback 2026-09-05: the host was getting
  // drowned out because the incoming song/ad had already climbed most of the way to full
  // volume before the host actually finished the sentence). This still overlaps enough to
  // avoid a hard silence, but the host's tail is essentially clear before anything rises.
  const LINER_OVERLAP_S = 0.5;    // how much of a liner's tail overlaps whatever comes next
  const CALL_POST_GAP_MS = 300;   // let the mixed disconnect land before the requested song starts

  function pickCutInSeconds(track) {
    const dur = track.durationSeconds;
    if (!dur || dur < 6) return Math.max(0, (dur || 6) - TAIL_BUFFER_S);
    const outro = track.outroStartSeconds != null ? track.outroStartSeconds : dur * 0.9;
    const latest = dur - TAIL_BUFFER_S;
    const earliest = Math.min(Math.max(outro, dur - SONG_TAIL_WINDOW_S), latest);
    return earliest + Math.random() * Math.max(0.3, latest - earliest);
  }

  class Deck {
    constructor(ctx, dest, onTimeUpdate, onEnded) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.crossOrigin = 'anonymous';
      this.source = ctx.createMediaElementSource(this.audio);
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.source.connect(this.gain).connect(dest);
      this.item = null;     // {type:'song'|'liner', title, subtitle, audio, durationSeconds, ...}
      this.cutInAt = null;  // seconds into this deck's own playback to trigger the next transition
      this.firedCutIn = false;
      this.loadGeneration = 0;
      this.cleanupTimers = new Set();
      // bound to the audio element's own 'timeupdate', not requestAnimationFrame: rAF gets
      // throttled hard (sometimes fully paused) in a backgrounded/hidden browser tab, but
      // 'timeupdate' keeps firing off real playback progress regardless of tab visibility.
      this.audio.addEventListener('timeupdate', () => onTimeUpdate(this));
      this.audio.addEventListener('ended', () => onEnded(this));
    }
    load(item) {
      this.cancelCleanup();
      this.loadGeneration += 1;
      this.item = item;
      this.cutInAt = null;
      this.firedCutIn = false;
      this.audio.src = item.audio;
    }
    scheduleCleanup(callback, delayMs) {
      const generation = this.loadGeneration;
      const timer = setTimeout(() => {
        this.cleanupTimers.delete(timer);
        if (this.loadGeneration !== generation) return;
        callback();
      }, delayMs);
      this.cleanupTimers.add(timer);
    }
    cancelCleanup() {
      this.cleanupTimers.forEach(timer => clearTimeout(timer));
      this.cleanupTimers.clear();
    }
    reset() {
      this.cancelCleanup();
      this.loadGeneration += 1;
      this.audio.pause();
      this.gain.gain.value = 0;
      this.item = null;
      this.cutInAt = null;
      this.firedCutIn = false;
    }
    async play() { try { await this.audio.play(); } catch (e) { /* needs a user gesture; surfaced by the caller */ } }
    fadeTo(target, ctx, seconds) {
      const g = this.gain.gain;
      const now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(target, now + seconds);
    }
  }

  class JingleChannel {
    constructor(ctx, dest) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.source = ctx.createMediaElementSource(this.audio);
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.source.connect(this.gain).connect(dest);
    }
    play(url, ctx, peak) {
      if (!url) return;
      this.audio.src = url;
      this.audio.currentTime = 0;
      this.gain.gain.cancelScheduledValues(ctx.currentTime);
      this.gain.gain.setValueAtTime(0, ctx.currentTime);
      this.gain.gain.linearRampToValueAtTime(peak, ctx.currentTime + 0.05);
      this.audio.play().catch(() => {});
      // the jingle asset already tapers to near-silence by its own envelope (make_jingle.py),
      // so this doesn't change what's audible -- just leaves the gain node zeroed afterward
      // instead of pinned at `peak` indefinitely.
      this.audio.onended = () => this.gain.gain.setValueAtTime(0, ctx.currentTime);
    }
  }

  class StaticChannel {
    constructor(ctx, dest) {
      this.ctx = ctx;
      this.gain = ctx.createGain();
      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'bandpass';
      this.filter.frequency.value = 2300;
      this.filter.Q.value = 0.32;
      this.gain.gain.value = 0;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) {
        const crackle = Math.random() < 0.002 ? (Math.random() * 2 - 1) * 2.8 : 0;
        samples[index] = Math.max(-1, Math.min(1, Math.random() * 2 - 1 + crackle));
      }
      this.source = ctx.createBufferSource();
      this.source.buffer = buffer;
      this.source.loop = true;
      this.source.connect(this.filter).connect(this.gain).connect(dest);
      this.source.start();
    }
    setLevel(level, seconds = 0.08) {
      const gain = this.gain.gain;
      const now = this.ctx.currentTime;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(level, now + seconds);
    }
  }

  class PirateChannel {
    constructor(ctx, dest) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.crossOrigin = 'anonymous';
      this.source = ctx.createMediaElementSource(this.audio);
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.source.connect(this.gain).connect(dest);
      this.finish = null;
    }
    stop(ctx) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.finish = null;
      const now = ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(0, now);
    }
    async play(signal, ctx, onEnded) {
      this.stop(ctx);
      this.audio.src = signal.audio;
      this.audio.currentTime = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        this.gain.gain.setValueAtTime(0, ctx.currentTime);
        if (this.finish === finish) this.finish = null;
        onEnded();
      };
      this.finish = finish;
      this.audio.onended = finish;
      this.audio.onerror = finish;
      this.gain.gain.setValueAtTime(0, ctx.currentTime);
      this.gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.12);
      try {
        await this.audio.play();
      } catch (error) {
        finish();
      }
    }
  }

  // Live proximity preview while the dial is moving but not yet locked: a quiet, low-latency
  // taste of whatever carrier is nearest, rising as the dial approaches it and receding as it
  // moves away -- the "you can hear a station before you're on it" behavior real analog tuning
  // has and a hard digital lock does not. Not the real programme (that only starts on lock);
  // just a representative loop (a station's own first cleared track, or a pirate's own clip).
  class PreviewChannel {
    constructor(ctx, dest) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.crossOrigin = 'anonymous';
      this.audio.loop = true;
      this.source = ctx.createMediaElementSource(this.audio);
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.source.connect(this.gain).connect(dest);
      this.currentSrc = null;
    }
    setTarget(url) {
      if (!url || url === this.currentSrc) return;
      this.currentSrc = url;
      this.audio.src = url;
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
    }
    setLevel(level, ctx, seconds = 0.12) {
      const g = this.gain.gain;
      const now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(level, now + seconds);
    }
    clear(ctx) {
      this.setLevel(0, ctx, 0.15);
      this.currentSrc = null;
      setTimeout(() => this.audio.pause(), 200);
    }
  }

  const state = {
    station: null, ctx: null, decks: null, jingle: null, staticChannel: null, pirate: null, preview: null, master: null, analyser: null,
    activeIndex: 0, lastTrackTitle: '', songBag: [], songsSinceBreak: 0, breakAfter: 0,
    callBag: [], lastCallerRole: '', callCooldown: 0, breaksSinceCall: 0,
    lastBreakKind: '', pendingRequestTags: null, pendingBlock: [], itemsSinceJingle: 0,
    plan: [], // lookahead list of upcoming {type, title, subtitle, kindLabel} for the "on deck" panel
    started: false, visualizerStarted: false, tuneTimer: null,
    scanning: false, scanFrame: null, scanTimer: null, scanIndex: -1, seekFrame: null,
    reception: 'locked', pirateSignal: null, power: false, lyricTicker: null,
  };

  function formatClock(seconds) {
    const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
  }

  function renderProgress(deck) {
    const current = deck && Number.isFinite(deck.audio.currentTime) ? deck.audio.currentTime : 0;
    const duration = deck && Number.isFinite(deck.audio.duration) ? deck.audio.duration : 0;
    if (byId('elapsed')) byId('elapsed').textContent = formatClock(current);
    if (byId('duration')) byId('duration').textContent = formatClock(duration);
    if (byId('progress-fill')) byId('progress-fill').style.width = `${duration ? Math.min(100, current / duration * 100) : 0}%`;
  }

  // One floating lyric word. Picks one of four looping animation variants -- drift (fade,
  // gentle wander, loops), fly (crosses the whole panel edge to edge), bg (huge, low-opacity,
  // sits behind the others), pulse (holds position, breathes in and out) -- plus one of five
  // fonts and a wide size range, so a crowded screen of them reads as loud and chaotic rather
  // than one uniform effect repeated. "Glitch" words don't get a second animation layered on
  // (that would fight the variant's own opacity/transform, see the fourth-round log entry) --
  // instead they keep the same animation but play it in visible discrete jumps via
  // `animation-timing-function: steps(...)` instead of a smooth easing curve, which reads as a
  // stutter/flicker with zero property conflicts, on top of the RGB-split text-shadow. Loops
  // continuously once alive; it doesn't self-expire, it waits to be evicted by
  // evictLyricWord() when the rolling pool is full. Returns the element so the caller can
  // track it in the pool.
  const LYRIC_VARIANTS = ['v-drift', 'v-drift', 'v-fly', 'v-pulse', 'v-bg'];
  const LYRIC_FONTS = [
    'var(--font-head)', 'var(--font-lyric-a)', 'var(--font-lyric-b)', 'var(--font-lyric-c)', 'var(--font-lyric-d)',
    'var(--font-lyric-e)', 'var(--font-lyric-f)', 'var(--font-lyric-g)', 'var(--font-lyric-h)', 'var(--font-lyric-i)', 'var(--font-lyric-j)'
  ];
  function spawnLyricWord(container, text) {
    if (!container || !text) return null;
    const span = document.createElement('span');
    const variant = LYRIC_VARIANTS[Math.floor(Math.random() * LYRIC_VARIANTS.length)];
    const isBg = variant === 'v-bg';
    const isFly = variant === 'v-fly';
    const isGlitch = Math.random() < 0.38;
    const size = isBg ? 50 + Math.random() * 100 : 8 + Math.random() * 46;
    const font = LYRIC_FONTS[Math.floor(Math.random() * LYRIC_FONTS.length)];
    const top = Math.random() * 84;
    const left = isFly ? 0 : Math.random() * 62;
    const rot = (Math.random() * 18 - 9).toFixed(1);
    const dx = (Math.random() * 70 - 35).toFixed(0);
    const dy = (Math.random() * 70 - 35).toFixed(0);
    const flyFrom = Math.random() < 0.5 ? '-20%' : '118%';
    const flyTo = flyFrom === '-20%' ? '118%' : '-20%';
    const dur = (isFly ? 3.5 + Math.random() * 2.5 : isBg ? 8 + Math.random() * 6 : 5 + Math.random() * 4).toFixed(2);
    const delay = (Math.random() * 1.4).toFixed(2);
    const timing = isGlitch ? `steps(${4 + Math.floor(Math.random() * 6)},jump-end)` : (isFly ? 'linear' : 'ease-in-out');
    const accent = Math.random() < 0.5 ? 'lyric-word-a' : 'lyric-word-b';
    span.className = `lyric-word ${variant} ${accent}${isGlitch ? ' glitch-word' : ''}`;
    span.textContent = text;
    span.style.cssText = `font-size:${size.toFixed(0)}px;font-family:${font};top:${top.toFixed(1)}%;left:${left.toFixed(1)}%;--rot:${rot}deg;--dx:${dx}px;--dy:${dy}px;--fly-from:${flyFrom};--fly-to:${flyTo};animation-duration:${dur}s;animation-delay:${delay}s;animation-timing-function:${timing}`;
    container.appendChild(span);
    return span;
  }

  // Fades a word out on its way from the pool instead of yanking it, then removes it.
  function evictLyricWord(el) {
    if (!el || el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 800);
  }

  // Paces the ticker against real playback progress: every timeupdate, works out which lyric
  // index *should* be showing by now (progress * total lines) and spawns forward to it, in
  // order -- approximate placement in the song, never a jump backward, never out of sequence.
  // Keeps a rolling pool of ticker.poolSize words alive at once (crowding the screen, several
  // fighting for attention) -- each new line pushes the oldest still-alive one out rather than
  // just adding to a pile. Capped per tick so a seek/big time jump can't dump a flood at once.
  function tickLyricTicker(deck) {
    const item = deck.item;
    const ticker = state.lyricTicker;
    if (!item || item.type !== 'song' || !item.lyricsLines || !item.lyricsLines.length) return;
    if (!ticker || ticker.item !== item) return;
    const field = byId('glitch-lyric-field');
    if (!field) return;
    const duration = deck.audio.duration || item.durationSeconds || 1;
    const progress = duration ? Math.min(1, deck.audio.currentTime / duration) : 0;
    const targetIndex = Math.min(item.lyricsLines.length - 1, Math.floor(progress * item.lyricsLines.length));
    let spawned = 0;
    while (ticker.lastIndex < targetIndex && spawned < 3) {
      ticker.lastIndex += 1;
      ticker.pool.push(spawnLyricWord(field, item.lyricsLines[ticker.lastIndex]));
      if (ticker.pool.length > ticker.poolSize) evictLyricWord(ticker.pool.shift());
      spawned += 1;
    }
    ticker.lastIndex = Math.max(ticker.lastIndex, targetIndex);
  }

  function onDeckTimeUpdate(deck) {
    if (state.decks[state.activeIndex] !== deck) return; // only the currently-active deck can trigger a transition
    renderProgress(deck);
    tickLyricTicker(deck);
    if (deck.item && deck.cutInAt != null && !deck.firedCutIn && deck.audio.currentTime >= deck.cutInAt) {
      deck.firedCutIn = true;
      startCrossfade(deck, 1 - state.activeIndex);
    }
  }

  function onDeckEnded(deck) {
    if (state.decks[state.activeIndex] !== deck || !deck.item || !isCallIn(deck.item.type)) return;
    setTimeout(() => {
      if (state.decks[state.activeIndex] === deck && deck.item && isCallIn(deck.item.type)) {
        startCrossfade(deck, 1 - state.activeIndex);
      }
    }, CALL_POST_GAP_MS);
  }

  function ensureAudioGraph() {
    if (state.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.ctx = new Ctx();
    state.master = state.ctx.createGain();
    state.analyser = state.ctx.createAnalyser();
    state.analyser.fftSize = 256;
    state.analyser.smoothingTimeConstant = 0.82;
    state.master.connect(state.analyser);
    state.analyser.connect(state.ctx.destination);
    const dest = state.master;
    state.decks = [new Deck(state.ctx, dest, onDeckTimeUpdate, onDeckEnded), new Deck(state.ctx, dest, onDeckTimeUpdate, onDeckEnded)];
    state.jingle = new JingleChannel(state.ctx, dest);
    state.staticChannel = new StaticChannel(state.ctx, dest);
    state.pirate = new PirateChannel(state.ctx, dest);
    state.preview = new PreviewChannel(state.ctx, dest);
    startVisualizer();
  }

  function startVisualizer() {
    if (state.visualizerStarted || !state.analyser) return;
    state.visualizerStarted = true;
    const bins = new Uint8Array(state.analyser.frequencyBinCount);
    const root = document.documentElement;
    const average = (start, end) => {
      let total = 0;
      for (let index = start; index < end; index += 1) total += bins[index];
      return total / Math.max(1, end - start) / 255;
    };
    const frame = () => {
      state.analyser.getByteFrequencyData(bins);
      const low = average(1, 9);
      const mid = average(9, 34);
      const high = average(34, 92);
      root.style.setProperty('--audio-low', low.toFixed(3));
      root.style.setProperty('--audio-mid', mid.toFixed(3));
      root.style.setProperty('--audio-high', high.toFixed(3));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  const rollRunLength = () => {
    const range = state.station.runLength || { min: 2, max: 5 };
    return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
  };

  function tagValues(tags, key) {
    const value = tags && tags[key];
    if (!value) return [];
    return (Array.isArray(value) ? value : [value]).map(item => String(item).toLowerCase());
  }

  function trackRequestScore(track, requestTags) {
    if (!requestTags) return 0;
    const weights = { tempo: 3, style: 1 };
    return Object.entries(weights).reduce((score, [key, weight]) => {
      const requested = new Set(tagValues(requestTags, key));
      return score + tagValues(track.tags, key).filter(value => requested.has(value)).length * weight;
    }, 0);
  }

  // Shuffle-bag pick, same shape as pickCallIn() below: every track in the station's pool
  // plays exactly once before any repeat, rather than a flat random pick that can (and did,
  // SIG-0632) leave a freshly-added track unheard for a long time by pure bad luck. Keyed by
  // `audio` rather than `id` -- station.tracks in the public data has no id field, and audio
  // path is the one property guaranteed unique even between same-titled takes (e.g. "Snow
  // Crash" take1/take2).
  function chooseTrack() {
    const tracks = (state.station.tracks || []).filter(t => t.audio);
    const byAudio = new Map(tracks.map(t => [t.audio, t]));
    state.songBag = state.songBag.filter(audio => byAudio.has(audio));
    if (!state.songBag.length) state.songBag = shuffle(tracks.map(t => t.audio));

    let bagIndex;
    if (state.pendingRequestTags) {
      // request-matching stays scoped to what's still left in the bag this cycle, so a call-in
      // request can't replay something already heard since the last reshuffle -- ties broken
      // randomly among the best-scoring candidates still in the bag.
      const scored = state.songBag.map((audio, index) => ({ index, score: trackRequestScore(byAudio.get(audio), state.pendingRequestTags) }));
      const bestScore = Math.max(...scored.map(item => item.score));
      const best = bestScore > 0 ? scored.filter(item => item.score === bestScore) : scored;
      bagIndex = best[Math.floor(Math.random() * best.length)].index;
    } else {
      // avoid an immediate title repeat right at a bag-wrap boundary (the reshuffle can otherwise
      // land the same track that just finished as the very next pick)
      bagIndex = state.songBag.findIndex(audio => byAudio.get(audio).title !== state.lastTrackTitle);
      if (bagIndex < 0) bagIndex = 0;
    }
    const [audio] = state.songBag.splice(bagIndex, 1);
    const track = byAudio.get(audio);
    state.pendingRequestTags = null;
    state.lastTrackTitle = track.title;
    return { type: 'song', title: track.title, subtitle: track.artist, audio: track.audio, durationSeconds: track.durationSeconds, outroStartSeconds: track.outroStartSeconds, tags: track.tags, lyricsLines: track.lyricsLines };
  }

  function pickLiner() {
    // ad kinds are never drawn here: sponsored notice only plays inside a block (see
    // buildAdBlock), and ad block intro/outro are block bookends, not general rotation.
    const pool = (state.station.interludes || []).filter(x => x.audio && !isCallIn(x.kind) && x.kind !== 'sponsored notice' && !AD_BLOCK_KINDS.has(x.kind));
    if (!pool.length) return null;
    return toPlanItem(pick(pool));
  }

  // Standalone station-ID jingles (station.stationJingles) are deliberately outside
  // breakRouting entirely -- the maker's ask (2026-09-05) was for one to land between songs
  // "regardless of the other planned rotation settings," not compete for a break slot inside
  // the host/call-in/ad-block weighting. So this is its own independent per-item coin flip,
  // checked before any of that logic runs, with a minimum item gap so it can't fire twice in
  // quick succession. More variants are planned (SIG note); pick() already spreads across
  // however many stationJingles a station ends up with.
  function maybeStationJingle() {
    const jingles = (state.station.stationJingles || []).filter(x => x.audio);
    if (!jingles.length) return null;
    const minGap = state.station.stationJingleMinGap == null ? 3 : state.station.stationJingleMinGap;
    if (state.itemsSinceJingle < minGap) return null;
    const chance = state.station.stationJingleChance == null ? 0.12 : state.station.stationJingleChance;
    if (Math.random() > chance) return null;
    state.itemsSinceJingle = 0;
    return toPlanItem(pick(jingles));
  }

  function toPlanItem(liner) {
    const callTitle = liner.callerName ? `Open line: ${liner.callerName}` : 'Open line';
    return {
      id: liner.id,
      type: liner.kind || 'host liner',
      title: isCallIn(liner.kind) ? callTitle : liner.kind || 'Host',
      subtitle: isCallIn(liner.kind) && liner.callerRole ? `${liner.callerRole} / ${liner.copy}` : liner.copy,
      audio: liner.audio,
      durationSeconds: liner.durationSeconds,
      callerRole: liner.callerRole,
      requestTags: liner.requestTags
    };
  }

  function shuffle(items) {
    const shuffled = items.slice();
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  // --- network notice console ---------------------------------------------------
  // The "Network notice" panel reads as a live channel log: a rolling loop of scripted
  // scenes (data.networkFeed -- listener chat, simulated scrape/telemetry output, and the
  // station's own security-daemon interruptions) plus real functional notices (station
  // lock, dead band, pirate carrier) pushed in as distinct [SIGNAL] lines. Chat and exec/
  // daemon lines both build up character-by-character (a chat line just reads fast, since
  // real clients don't type letter by letter); [SIGNAL] lines land instantly since they
  // carry actual state and shouldn't get stuck behind a typing crawl. Placeholder content
  // in stations.data.js is intentionally Snow-Crash-heavy for now -- flagged to workshop
  // further once the shape of the thing is agreed on.
  const CONSOLE_MAX_LINES = 40;
  const CONSOLE_TYPE_MS = 30;        // per-character delay for exec/daemon lines
  const CONSOLE_CHAT_MS = 10;        // per-character delay for listener chat lines
  const CONSOLE_LINE_GAP_MS = 900;   // default pause after a line finishes, before the next
  const CONSOLE_SCENE_GAP_MS = 4200; // pause between scenes

  function consoleLog() { return byId('notice-log'); }

  function scrollConsole() {
    const body = consoleLog();
    if (body) body.scrollTop = body.scrollHeight;
  }

  function appendConsoleLine(role) {
    const body = consoleLog();
    if (!body) return null;
    const el = document.createElement('div');
    el.className = `console-line ${role}`;
    body.appendChild(el);
    while (body.children.length > CONSOLE_MAX_LINES) body.removeChild(body.firstChild);
    return el;
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function typeInto(el, text, perCharMs) {
    const cursor = document.createElement('span');
    cursor.className = 'console-cursor';
    el.appendChild(cursor);
    for (let index = 0; index < text.length; index += 1) {
      cursor.insertAdjacentText('beforebegin', text[index]);
      scrollConsole();
      if (perCharMs) await wait(perCharMs);
    }
    cursor.remove();
  }

  function flashConsole() {
    const el = byId('notice');
    if (!el) return;
    el.classList.remove('alert');
    void el.offsetWidth; // restart the CSS animation on repeated daemon lines
    el.classList.add('alert');
  }

  // Real station/tuning state -- always lands immediately, ahead of or alongside whatever
  // the scripted feed is mid-typing, so functional info is never stuck behind a crawl.
  function pushSystemNotice(text) {
    const el = appendConsoleLine('signal');
    if (!el) return;
    el.textContent = text;
    scrollConsole();
  }

  async function playFeedLine(line) {
    const el = appendConsoleLine(line.role);
    if (!el) return;
    if (line.who) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `[${line.who}]: `;
      el.appendChild(who);
    }
    await typeInto(el, line.text, line.role === 'listener' ? CONSOLE_CHAT_MS : CONSOLE_TYPE_MS);
    if (line.role === 'daemon') flashConsole();
    scrollConsole();
  }

  async function runNetworkFeed() {
    const scenes = (data.networkFeed || []).filter(scene => scene && scene.length);
    if (!scenes.length) return;
    let order = shuffle(scenes);
    let cursor = 0;
    for (;;) {
      if (cursor >= order.length) { order = shuffle(scenes); cursor = 0; }
      const scene = order[cursor];
      cursor += 1;
      for (const line of scene) {
        await playFeedLine(line);
        await wait(line.holdMs || CONSOLE_LINE_GAP_MS);
      }
      await wait(CONSOLE_SCENE_GAP_MS);
    }
  }

  function availableCallIns() {
    const configured = state.station.breakRouting && state.station.breakRouting.callRotations;
    const allowedRotations = new Set(configured || ['live', 'audition']);
    return (state.station.interludes || []).filter(item => item.audio && isCallIn(item.kind) && allowedRotations.has(item.rotation || 'live'));
  }

  function pickCallIn() {
    const calls = availableCallIns();
    if (!calls.length) return null;
    const byCallId = new Map(calls.map(item => [item.id, item]));
    state.callBag = state.callBag.filter(id => byCallId.has(id));
    if (!state.callBag.length) state.callBag = shuffle(calls.map(item => item.id));
    let bagIndex = state.callBag.findIndex(id => byCallId.get(id).callerRole !== state.lastCallerRole);
    if (bagIndex < 0) bagIndex = 0;
    const [callId] = state.callBag.splice(bagIndex, 1);
    const call = byCallId.get(callId);
    state.lastCallerRole = call.callerRole || '';
    state.pendingRequestTags = call.requestTags || null;
    return toPlanItem(call);
  }

  function pickWeightedKind(options) {
    const viable = options.filter(option => option.available && option.weight > 0);
    if (!viable.length) return null;
    const total = viable.reduce((sum, option) => sum + option.weight, 0);
    let roll = Math.random() * total;
    for (const option of viable) {
      roll -= option.weight;
      if (roll <= 0) return option.kind;
    }
    return viable[viable.length - 1].kind;
  }

  // one hook, 2-4 shuffled sponsored notices with no repeats within the block, one outro --
  // queued as a single contiguous run so normal song rotation can't land in the middle of it.
  // Returns null if a station doesn't have the content to build one (falls back to a normal
  // liner break).
  function buildAdBlock() {
    const pool = (state.station.interludes || []).filter(x => x.audio);
    const hooks = pool.filter(x => x.kind === 'ad block intro');
    const outros = pool.filter(x => x.kind === 'ad block outro');
    const ads = pool.filter(x => x.kind === 'sponsored notice');
    if (!hooks.length || !outros.length || ads.length < 2) return null;
    const shuffled = shuffle(ads);
    const adCount = Math.min(ads.length, 2 + Math.floor(Math.random() * 3)); // 2-4, capped by pool size
    const chosenAds = shuffled.slice(0, adCount);
    return [pick(hooks), ...chosenAds, pick(outros)].map(toPlanItem);
  }

  function chooseBreak() {
    const routing = state.station.breakRouting || {};
    const weights = routing.weights || { host: 0.8, callIn: 0, adBlock: 0.2 };
    const calls = availableCallIns();
    const interludes = (state.station.interludes || []).filter(item => item.audio);
    const hostAvailable = interludes.some(item => !isCallIn(item.kind) && item.kind !== 'sponsored notice' && !AD_BLOCK_KINDS.has(item.kind));
    const adAvailable = interludes.some(item => item.kind === 'ad block intro')
      && interludes.some(item => item.kind === 'ad block outro')
      && interludes.filter(item => item.kind === 'sponsored notice').length >= 2;
    const callAllowed = calls.length && state.callCooldown <= 0 && state.lastBreakKind !== 'ad-block';
    const maxGap = routing.maxBreaksWithoutCall == null ? Infinity : routing.maxBreaksWithoutCall;
    const adAllowed = adAvailable && state.lastBreakKind !== 'call-in' && state.breaksSinceCall < maxGap - 1;
    const forcedCall = callAllowed && state.breaksSinceCall >= maxGap;
    const kind = forcedCall ? 'call-in' : pickWeightedKind([
      { kind: 'host', weight: weights.host || 0, available: hostAvailable },
      { kind: 'call-in', weight: weights.callIn || 0, available: callAllowed },
      { kind: 'ad-block', weight: weights.adBlock || 0, available: adAllowed }
    ]);

    if (kind === 'call-in') {
      const call = pickCallIn();
      if (call) {
        state.callCooldown = routing.callCooldownBreaks == null ? 2 : routing.callCooldownBreaks;
        state.breaksSinceCall = 0;
        state.lastBreakKind = 'call-in';
        return call;
      }
    }

    if (kind === 'ad-block') {
      const block = buildAdBlock();
      if (block && block.length) {
        state.pendingBlock = block.slice(1);
        state.breaksSinceCall += 1;
        if (state.callCooldown > 0) state.callCooldown -= 1;
        state.lastBreakKind = 'ad-block';
        return block[0];
      }
    }

    const liner = pickLiner();
    if (liner) {
      state.breaksSinceCall += 1;
      if (state.callCooldown > 0) state.callCooldown -= 1;
      state.lastBreakKind = 'host';
      return liner;
    }

    const fallbackCall = pickCallIn();
    if (fallbackCall) {
      state.callCooldown = routing.callCooldownBreaks == null ? 2 : routing.callCooldownBreaks;
      state.breaksSinceCall = 0;
      state.lastBreakKind = 'call-in';
      return fallbackCall;
    }
    return null;
  }

  function decideNext() {
    if (!(state.station.tracks || []).some(t => t.audio)) return null;
    if (state.pendingBlock && state.pendingBlock.length) return state.pendingBlock.shift();
    state.itemsSinceJingle += 1;
    const jingle = maybeStationJingle();
    if (jingle) return jingle;
    if (!state.breakAfter) state.breakAfter = rollRunLength();
    state.songsSinceBreak += 1;
    if (state.songsSinceBreak > state.breakAfter) {
      // The break itself is not a song. Reset to zero so runLength: 1 produces
      // song, liner, song instead of repeating liners while the queue refills.
      state.songsSinceBreak = 0;
      state.breakAfter = rollRunLength();
      const breakItem = chooseBreak();
      if (breakItem) return breakItem;
    }
    return chooseTrack();
  }

  function applyVisualProfile(station) {
    const profile = station.visualProfile || {};
    const root = document.documentElement;
    root.dataset.station = profile.world || station.id;
    root.style.setProperty('--station-accent', profile.accent || '#56e5ff');
    root.style.setProperty('--station-secondary', profile.secondary || '#ff4eb8');
    root.style.setProperty('--station-rgb', profile.rgb || '86,229,255');
    if (byId('world-label')) byId('world-label').textContent = profile.label || station.theme;
  }

  // The identity panel's left column: a mode-reactive glitch visual with spoken-head,
  // ad-marquee, and lyric treatments. Song visuals combine the real rolling lyric pool
  // with deliberately placeholder programmer-art objects until track tags can select them.
  function renderIdentityVisual(mode, item) {
    const el = byId('identity-visual');
    if (!el) return;
    if (mode.id === 'ad') {
      el.innerHTML = '<div class="glitch-ad"><i>BUY MORE</i><i>CONSUME</i><i>UPGRADE YOUR SOUL</i><i>NO REFUNDS</i><i>OBEY THE BRAND</i></div>';
      return;
    }
    if (mode.id === 'song') {
      // No per-line timestamps exist for Suno's lyrics-eng tag, so a synced single line always
      // drifted out of time, a one-shot random sample never changed all track, and a slow
      // 1-in-1-out ticker paced to real lyric cadence read as one line at a time -- per the
      // maker's follow-up, this crowds the screen instead: a rolling pool of ~10-20 lines alive
      // at once (filled immediately so it's crowded from the first frame, not built up slowly),
      // each line still spawned in order and roughly where it falls in the song's own timeline
      // (tickLyricTicker/onDeckTimeUpdate), but the earliest alive line gets pushed out to make
      // room the moment a new one arrives, not left to expire on its own. Falls back to just the
      // title for tracks with no lyrics. A per-song-type effect vocabulary (tagging different
      // treatments to different kinds of songs) is a good next step, logged rather than built here.
      const bars = Array.from({ length: 40 }, () => `<i style="--h:${(0.15 + Math.random() * 0.85).toFixed(2)}"></i>`).join('');
      el.innerHTML = `<div class="glitch-song"><div class="glitch-viz-overlay"><div class="glitch-viz-row">${bars}</div><div class="glitch-viz-row glitch-viz-mirror">${bars}</div></div><div class="lyric-art" aria-hidden="true"><div class="lyric-orbit"></div><div class="lyric-cube"><i></i><i></i><i></i><i></i></div><div class="lyric-crosshair"></div><div class="lyric-code">TAG://PENDING<br>FX_BANK[NULL]<br>ROTATE_Z++<br>SONG.TYPE?</div></div><div class="glitch-lyric-field" id="glitch-lyric-field"></div></div>`;
      const lines = (item && item.lyricsLines) || [];
      const poolSize = 13 + Math.floor(Math.random() * 9); // 13-21, leaning toward the loud end
      const ticker = { item, lastIndex: -1, poolSize, pool: [] };
      state.lyricTicker = ticker;
      const field = byId('glitch-lyric-field');
      const initialCount = Math.min(poolSize, lines.length);
      for (let i = 0; i < initialCount; i += 1) {
        ticker.lastIndex = i;
        ticker.pool.push(spawnLyricWord(field, lines[i]));
      }
      return;
    }
    state.lyricTicker = null;
    if (mode.id === 'host' || mode.id === 'call' || mode.id === 'report') {
      el.innerHTML = `<div class="glitch-host"><div class="glitch-head"></div><span class="glitch-tag">${mode.label}</span></div>`;
      return;
    }
    el.innerHTML = '<div class="glitch-idle"></div>';
  }

  function broadcastMode(item) {
    if (!item) return { id: 'idle', label: 'carrier idle' };
    if (isCallIn(item.type)) return { id: 'call', label: 'open line / caller' };
    if (item.type === 'sponsored notice' || AD_BLOCK_KINDS.has(item.type)) return { id: 'ad', label: 'commercial incursion' };
    if (item.type === 'street report') return { id: 'report', label: 'field report' };
    if (item.type === 'host liner' || item.type === 'host bridge') return { id: 'host', label: 'host transmission' };
    if (item.type === 'station ID') return { id: 'host', label: 'station identification' };
    if (item.type === 'song') return { id: 'song', label: 'music carrier' };
    return { id: 'signal', label: 'signal fragment' };
  }

  function renderStation(station) {
    delete document.documentElement.dataset.previewStation;
    applyVisualProfile(station);
    byId('reception-label').textContent = 'locked station';
    byId('dial-station').textContent = station.name;
    byId('host').textContent = `Host: ${station.host}`;
    byId('line').textContent = `"${station.sampleLine}"`;
    const trackCount = (station.tracks || []).filter(t => t.audio).length;
    byId('track-count').textContent = trackCount ? `${trackCount} cleared track${trackCount === 1 ? '' : 's'} in rotation` : 'No cleared tracks in rotation';
    document.querySelectorAll('.station').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === station.id)));
    setDialValue(stationDialValue(station));
  }

  function renderNow(deck, cutInLabel) {
    const item = deck && deck.item;
    const mode = broadcastMode(item);
    document.documentElement.dataset.broadcast = mode.id;
    renderIdentityVisual(mode, item);
    if (byId('mode-label')) byId('mode-label').textContent = mode.label;
    if (byId('signal-lock')) byId('signal-lock').textContent = state.started ? 'signal locked' : 'receiver ready';
    byId('now-title').textContent = item ? item.title : 'Off air';
    byId('now-subtitle').textContent = item ? item.subtitle : 'Choose a station with cleared tracks.';
    byId('break-note').textContent = item ? cutInLabel || '' : 'Crossfades in live -- press play to start the broadcast.';
    renderProgress(deck);
  }

  function renderQueue() {
    const items = state.plan.slice(0, 3);
    byId('queue').innerHTML = items.length
      ? items.map((item, index) => `<li><span>${index + 1}</span><strong>${item.title}</strong><small>${item.subtitle || ''}</small></li>`).join('')
      : '<li class="empty">Add a cleared track to this station to begin.</li>';
  }

  function refillPlan() {
    while (state.plan.length < 3) {
      const next = decideNext();
      if (!next) break;
      state.plan.push(next);
    }
  }

  // --- the actual crossfade sequencer ------------------------------------------
  function armCutIn(deck) {
    if (deck.item && isCallIn(deck.item.type)) {
      deck.cutInAt = null;
      return;
    }
    if (!deck.item || isSpokenKind(deck.item.type)) {
      deck.cutInAt = Math.max(0, (deck.item ? deck.audio.duration || deck.item.durationSeconds || 6 : 6) - LINER_OVERLAP_S);
    } else {
      deck.cutInAt = pickCutInSeconds({ durationSeconds: deck.audio.duration || deck.item.durationSeconds, outroStartSeconds: deck.item.outroStartSeconds });
    }
  }

  function startCrossfade(fromDeck, toIndex) {
    const toDeck = state.decks[toIndex];
    const next = state.plan.shift();
    refillPlan();
    renderQueue();
    if (!next) return;
    toDeck.load(next);
    toDeck.play();

    let totalFadeS;
    if (isSpokenKind(next.type)) {
      // duck, don't blend: the host needs to be intelligible immediately, the outgoing song
      // bleeds under it at a low level for a moment (it's already near its own natural end,
      // see pickCutInSeconds) rather than competing at equal volume, then finishes fading out.
      toDeck.fadeTo(1, state.ctx, HOST_RISE_S);
      fromDeck.fadeTo(SONG_DUCK_LEVEL, state.ctx, SONG_DUCK_S);
      fromDeck.scheduleCleanup(() => fromDeck.fadeTo(0, state.ctx, SONG_FULL_FADE_S), SONG_DUCK_S * 1000);
      totalFadeS = SONG_DUCK_S + SONG_FULL_FADE_S;
    } else {
      fromDeck.fadeTo(0, state.ctx, FADE_S);
      toDeck.fadeTo(1, state.ctx, FADE_S);
      totalFadeS = FADE_S;
    }
    // fromDeck would otherwise keep decoding/playing silently in the background for
    // whatever's left of its track until this same Deck object gets reused
    fromDeck.scheduleCleanup(() => fromDeck.audio.pause(), (totalFadeS + 0.2) * 1000);

    const isHostLine = next.type === 'host liner' || next.type === 'host bridge' || next.type === 'street report' || next.type === 'ad block intro';
    if (isHostLine && state.station.jingle && Math.random() < (state.station.jingle.chance || 0)) {
      state.jingle.play(state.station.jingle.audio, state.ctx, state.station.jingle.peak || 0.7);
    }

    state.activeIndex = toIndex;
    const statusLabel = () => {
      if (next.type === 'ad block intro') return 'Ad block starting.';
      if (next.type === 'ad block outro') return 'Ad block over.';
      if (next.type === 'sponsored notice') return 'Sponsored transmission.';
      if (isCallIn(next.type)) return 'Open line to the Street.';
      if (next.type === 'station ID') return 'Station identification.';
      if (isHostLine) return 'On the air, live.';
      return 'Song plays out, host cuts in on the tail.';
    };
    const showStatus = () => renderNow(toDeck, statusLabel());
    toDeck.audio.onloadedmetadata = () => { armCutIn(toDeck); showStatus(); };
    if (toDeck.audio.readyState >= 1) armCutIn(toDeck);
    showStatus(); // cheap immediate label; onloadedmetadata upgrades it once duration/outro are known
  }

  function stationDialValue(station) {
    return Math.round(Number.parseFloat(station.frequency) * 10);
  }

  function pirateDialValue(signal) {
    return Math.round(Number.parseFloat(signal.frequency) * 10);
  }

  function formatDial(value) {
    return (Number(value) / 10).toFixed(1).padStart(5, '0');
  }

  // --- dial face geometry -------------------------------------------------------
  // A continuous semicircle (matches the reference: ticks sweep unbroken from left
  // horizon to right, a needle rides it, nothing gets clipped). Built once from the
  // catalog; only the needle transform changes as the dial moves.
  const DIAL_CX = 320, DIAL_CY = 250, DIAL_MAX = 1400;
  const arcPoint = (angleDeg, radius) => {
    const rad = angleDeg * Math.PI / 180;
    return { x: DIAL_CX + radius * Math.cos(rad), y: DIAL_CY - radius * Math.sin(rad) };
  };
  const angleForValue = value => 180 - (Number(value) / DIAL_MAX) * 180;

  function updateDialNeedle(value) {
    const needle = byId('dial-needle');
    if (!needle) return;
    needle.setAttribute('transform', `rotate(${(90 - angleForValue(value)).toFixed(2)} ${DIAL_CX} ${DIAL_CY})`);
  }

  function setDialValue(value) {
    byId('tuner').value = value;
    byId('tuner-output').textContent = formatDial(value);
    updateDialNeedle(value);
  }

  function buildDialFace() {
    const ticks = byId('dial-ticks');
    const carriers = byId('dial-carriers');
    if (!ticks || !carriers) return;
    let ticksMarkup = '';
    for (let value = 0; value <= DIAL_MAX; value += 50) {
      const angle = angleForValue(value);
      const major = value % 200 === 0;
      const inner = arcPoint(angle, major ? 178 : 195);
      const outer = arcPoint(angle, 210);
      ticksMarkup += `<line class="dial-tick${major ? ' major' : ''}" x1="${inner.x.toFixed(1)}" y1="${inner.y.toFixed(1)}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}"></line>`;
      if (major) {
        const label = arcPoint(angle, 163);
        ticksMarkup += `<text class="dial-tick-label" x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" text-anchor="middle">${String(value / 10).padStart(2, '0')}</text>`;
      }
    }
    ticks.innerHTML = ticksMarkup;
    // Known station presets get a lit position on the arc itself -- pirate carriers
    // deliberately do not, since seeing them would spoil hunting them by ear alone.
    carriers.innerHTML = data.stations.map(station => {
      const pos = arcPoint(angleForValue(stationDialValue(station)), 224);
      const color = (station.visualProfile && station.visualProfile.accent) || '#56e5ff';
      return `<circle class="dial-carrier" style="--dot:${color}" cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="4.5"></circle>`;
    }).join('');
  }

  // --- readout arch: a real semicircle concentric with the dial (same center 320,250,
  // radius scaled down to 150), running to its own natural spring point (baseline y=250,
  // same as the dial's own arc) and then straight down to wherever the identity panel's
  // top edge actually is. That target can't be a fixed viewBox constant: the preset
  // buttons sitting between the dial and the panel are fixed-px, not proportional to the
  // dial's own viewBox scaling, so the right bottom-Y shifts with viewport width. Measured
  // live off the real DOM instead, and recomputed on resize.
  const READOUT_ARCH_R = 150;
  function updateReadoutArch() {
    const svg = byId('dial-svg');
    const arch = byId('dial-readout-arch');
    const panel = document.querySelector('.identity-panel');
    if (!svg || !arch || !panel) return;
    const svgRect = svg.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    if (!svgRect.width) return;
    const scale = svgRect.width / 640; // SVG viewBox is 640 wide
    const left = DIAL_CX - READOUT_ARCH_R;
    const right = DIAL_CX + READOUT_ARCH_R;
    const bottomY = Math.max(DIAL_CY + 4, (panelRect.top - svgRect.top) / scale);
    arch.setAttribute('d', `M ${left} ${DIAL_CY} A ${READOUT_ARCH_R} ${READOUT_ARCH_R} 0 0 1 ${right} ${DIAL_CY} L ${right.toFixed(1)} ${bottomY.toFixed(1)} L ${left.toFixed(1)} ${bottomY.toFixed(1)} Z`);
  }

  // --- proximity tuning -----------------------------------------------------------
  // Real dial behavior: a carrier bleeds in gradually as you approach it and fades as
  // you leave, well before it's close enough to actually lock. BLEED_MULT sets how many
  // multiples of a carrier's own lock width count as "audible before it locks."
  const BLEED_MULT = 4.5;
  function proximityFor(value) {
    const nearest = nearestCarrier(value);
    if (!nearest) return { proximity: 0, entry: null };
    const bleedRadius = nearest.entry.width * BLEED_MULT;
    return { entry: nearest.entry, distance: nearest.distance, proximity: Math.max(0, 1 - nearest.distance / bleedRadius) };
  }

  function representativeAudio(entry) {
    if (entry.kind === 'pirate') return entry.item.audio;
    const station = entry.item;
    const track = (station.tracks || []).find(t => t.audio);
    if (track) return track.audio;
    const liner = (station.interludes || []).find(item => item.audio);
    return liner ? liner.audio : null;
  }

  function applyTuningAudio(value, options = {}) {
    if (!state.power || !state.staticChannel) return;
    const { proximity, entry } = proximityFor(value);
    const staticCeiling = options.scanning ? 0.13 : 0.17;
    state.staticChannel.setLevel(Math.max(0.015, staticCeiling * (1 - proximity * 0.88)), 0.1);
    if (!state.preview) return;
    // A registered carrier with nothing cleared to air yet (e.g. CYBERSPRAWL right now) must
    // stay silent on approach, not keep bleeding in whatever the previous carrier last loaded.
    const audio = proximity > 0.04 && entry ? representativeAudio(entry) : null;
    if (audio) {
      state.preview.setTarget(audio);
      state.preview.setLevel(proximity * 0.8, state.ctx, 0.12);
    } else {
      state.preview.setLevel(0, state.ctx, 0.15);
    }
  }

  function scannerEntries() {
    const known = data.stations.map(station => ({ kind: 'station', item: station, value: stationDialValue(station), width: 8 }));
    const pirate = (data.pirateSignals || []).map(signal => ({ kind: 'pirate', item: signal, value: pirateDialValue(signal), width: signal.width || 9 }));
    return known.concat(pirate).sort((a, b) => a.value - b.value);
  }

  function nearestCarrier(value) {
    return scannerEntries().reduce((nearest, entry) => {
      const distance = Math.abs(entry.value - value);
      return !nearest || distance < nearest.distance ? { entry, distance } : nearest;
    }, null);
  }

  function previewMappedStation(value) {
    const nearest = data.stations.reduce((best, station) => {
      const distance = Math.abs(stationDialValue(station) - value);
      return !best || distance < best.distance ? { station, distance } : best;
    }, null);
    const previewRadius = 8 * BLEED_MULT;
    if (!nearest || nearest.distance > previewRadius) {
      delete document.documentElement.dataset.previewStation;
      return null;
    }
    applyVisualProfile(nearest.station);
    document.documentElement.dataset.previewStation = nearest.station.id;
    byId('dial-station').textContent = nearest.station.name;
    return nearest.station;
  }

  function setReception(mode) {
    state.reception = mode;
    document.documentElement.dataset.reception = mode;
  }

  function clearKnownPreset() {
    document.querySelectorAll('.station').forEach(button => button.setAttribute('aria-pressed', 'false'));
  }

  function quietProgramme() {
    if (state.decks) state.decks.forEach(deck => deck.reset());
    state.started = false;
    state.plan = [];
    state.pendingBlock = [];
    renderQueue();
  }

  function renderDeadBand(value) {
    const frequency = formatDial(value);
    delete document.documentElement.dataset.previewStation;
    clearKnownPreset();
    document.documentElement.dataset.broadcast = 'signal';
    byId('reception-label').textContent = 'open spectrum';
    byId('dial-station').textContent = 'DEAD BAND';
    byId('world-label').textContent = 'multipath snow';
    byId('host').textContent = 'Origin: unresolved';
    byId('line').textContent = '"No licensed source. Keep the dial moving."';
    pushSystemNotice('Static is live. Hidden carriers only lock inside a narrow frequency window.');
    byId('track-count').textContent = 'No mapped programme at this frequency';
    byId('mode-label').textContent = 'dead band / seeking';
    byId('signal-lock').textContent = 'no lock';
    byId('now-title').textContent = 'HISS / MULTIPATH';
    byId('now-subtitle').textContent = `${frequency} SIG.FM / unlicensed spectrum`;
    byId('break-note').textContent = 'Sweep slowly. Pirate carriers do not advertise themselves.';
    byId('queue').innerHTML = '<li class="empty">Only static is queued here.</li>';
    byId('skip').disabled = true;
    renderIdentityVisual({ id: 'signal' }, null);
  }

  function pirateProfile(signal) {
    const profiles = {
      glossolalia: { world: 'talkback', accent: '#ff4eb8', secondary: '#ffea00', rgb: '255,78,184', label: 'language breach' },
      machine: { world: 'cybersprawl', accent: '#56e5ff', secondary: '#ff665e', rgb: '86,229,255', label: 'machine handshake' },
      sermon: { world: 'snowcrash', accent: '#ffd76b', secondary: '#ff4e50', rgb: '255,215,107', label: 'Pearly Gates relay' }
    };
    return profiles[signal.family] || profiles.glossolalia;
  }

  function renderPirate(signal) {
    delete document.documentElement.dataset.previewStation;
    applyVisualProfile({ id: 'pirate', theme: 'unlicensed carrier', visualProfile: pirateProfile(signal) });
    clearKnownPreset();
    document.documentElement.dataset.broadcast = 'signal';
    byId('reception-label').textContent = 'unstable carrier';
    byId('dial-station').textContent = signal.source;
    byId('host').textContent = `Origin: ${signal.source}`;
    byId('line').textContent = '"No callsign. No permission. Signal riding the gaps."';
    pushSystemNotice(`${signal.id} was not on the carrier map. It will vanish when the transmission ends.`);
    byId('track-count').textContent = 'One intercepted burst, no scheduled repeat';
    byId('mode-label').textContent = 'pirate breakthrough';
    byId('signal-lock').textContent = 'unstable carrier';
    byId('now-title').textContent = signal.title;
    byId('now-subtitle').textContent = `${signal.id} / ${signal.family} intrusion`;
    byId('break-note').textContent = 'Hold frequency. Signal integrity is collapsing.';
    byId('queue').innerHTML = `<li><span>!</span><strong>${signal.id}</strong><small>signal ends without warning</small></li>`;
    byId('skip').disabled = true;
    renderIdentityVisual({ id: 'host', label: 'intercepted signal' }, null);
  }

  function enterDeadBand(value, options = {}) {
    ensureAudioGraph();
    state.ctx.resume().catch(() => {});
    if (state.reception !== 'static') {
      quietProgramme();
      state.pirate.stop(state.ctx);
      state.pirateSignal = null;
    }
    setReception('static');
    updateDialNeedle(value);
    applyTuningAudio(value, options);
    document.documentElement.dataset.tuning = 'true';
    byId('tuner-status').textContent = options.scanning ? 'seeking carrier' : 'no carrier';
    renderDeadBand(value);
  }

  function playPirateSignal(signal, options = {}) {
    if (!options.fromScan) stopScan(true);
    ensureAudioGraph();
    state.ctx.resume().catch(() => {});
    quietProgramme();
    if (state.preview) state.preview.clear(state.ctx);
    state.pirateSignal = signal;
    setReception('pirate');
    state.staticChannel.setLevel(0.025, 0.16);
    setDialValue(pirateDialValue(signal));
    byId('tuner-status').textContent = 'illegal carrier';
    byId('tuner-note').textContent = `Intercepted ${signal.id} at ${signal.frequency}. Do not expect it to remain.`;
    renderPirate(signal);
    state.pirate.play(signal, state.ctx, () => {
      if (state.pirateSignal !== signal) return;
      state.pirateSignal = null;
      const value = Number(byId('tuner').value);
      enterDeadBand(value, { scanning: state.scanning });
      byId('tuner-note').textContent = `${signal.id} collapsed back into static.`;
      if (state.scanning) state.scanTimer = setTimeout(scanToNextCarrier, 700);
    });
  }

  function setScannerUI(active, status) {
    state.scanning = active;
    document.documentElement.dataset.scanning = String(active);
    byId('scan').setAttribute('aria-pressed', String(active));
    byId('scan-label').textContent = active ? 'Stop' : 'Scan';
    byId('tuner-status').textContent = status || (active ? 'seeking carrier' : 'carrier locked');
  }

  function stopScan(preserveDial) {
    if (state.scanFrame) cancelAnimationFrame(state.scanFrame);
    if (state.scanTimer) clearTimeout(state.scanTimer);
    state.scanFrame = null;
    state.scanTimer = null;
    const status = state.reception === 'pirate' ? 'illegal carrier' : state.reception === 'static' ? 'dead band held' : 'carrier locked';
    setScannerUI(false, preserveDial ? status : 'carrier locked');
    if (!preserveDial && state.station && state.reception === 'locked') {
      setDialValue(stationDialValue(state.station));
    }
  }

  function scanToNextCarrier() {
    if (!state.scanning) return;
    const entries = scannerEntries();
    const from = Number(byId('tuner').value);
    const target = entries.find(entry => entry.value > from + 1) || entries[0];
    const to = target.value;
    const start = performance.now();
    const duration = 800 + Math.min(700, Math.abs(to - from) * 0.9);
    byId('tuner-status').textContent = 'seeking carrier';
    byId('tuner-note').textContent = 'Scanning open spectrum. Static persists until any carrier catches.';
    enterDeadBand(from, { scanning: true });
    const step = now => {
      if (!state.scanning) return;
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(from + (to - from) * eased);
      setDialValue(value);
      applyTuningAudio(value, { scanning: true });
      if (progress < 1) {
        state.scanFrame = requestAnimationFrame(step);
        return;
      }
      state.scanFrame = null;
      if (target.kind === 'pirate') {
        playPirateSignal(target.item, { fromScan: true });
        return;
      }
      selectStation(target.item.id, { fromScan: true });
      byId('tuner-status').textContent = 'carrier found';
      byId('tuner-note').textContent = `Locked ${target.item.frequency} / ${target.item.name}. Continuing scan.`;
      state.scanTimer = setTimeout(scanToNextCarrier, 2200);
    };
    state.scanFrame = requestAnimationFrame(step);
  }

  // A single-step version of the scan sweep: jump straight to the next (or previous)
  // active carrier -- known station or pirate alike -- instead of continuously sweeping.
  // Reuses the same eased tween and landing logic as scanToNextCarrier, just once, in
  // either direction, and doesn't chain into another jump on arrival.
  function seekStep(direction) {
    stopScan(true);
    if (state.seekFrame) { cancelAnimationFrame(state.seekFrame); state.seekFrame = null; }
    ensureAudioGraph();
    state.ctx.resume().catch(() => {});
    const entries = scannerEntries();
    if (!entries.length) return;
    const from = Number(byId('tuner').value);
    const target = direction > 0
      ? entries.find(entry => entry.value > from + 1) || entries[0]
      : [...entries].reverse().find(entry => entry.value < from - 1) || entries[entries.length - 1];
    const to = target.value;
    const start = performance.now();
    const duration = 450 + Math.min(500, Math.abs(to - from) * 0.6);
    byId('tuner-status').textContent = 'seeking carrier';
    byId('tuner-note').textContent = direction > 0 ? 'Jumping to the next active carrier.' : 'Jumping to the previous active carrier.';
    enterDeadBand(from, { scanning: true });
    const step = now => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(from + (to - from) * eased);
      setDialValue(value);
      applyTuningAudio(value, { scanning: true });
      if (progress < 1) {
        state.seekFrame = requestAnimationFrame(step);
        return;
      }
      state.seekFrame = null;
      if (target.kind === 'pirate') {
        playPirateSignal(target.item, { fromScan: true });
        return;
      }
      selectStation(target.item.id, { fromScan: true });
      byId('tuner-status').textContent = 'carrier found';
      byId('tuner-note').textContent = `Locked ${target.item.frequency} / ${target.item.name}.`;
    };
    state.seekFrame = requestAnimationFrame(step);
  }

  function toggleScan() {
    if (state.scanning) {
      const holdOpenBand = state.reception !== 'locked';
      stopScan(holdOpenBand);
      byId('tuner-note').textContent = holdOpenBand ? 'Scan stopped. Manual control is holding this frequency.' : 'Scan stopped on the current known carrier.';
      return;
    }
    ensureAudioGraph();
    state.ctx.resume().catch(() => {});
    setScannerUI(true, 'seeking carrier');
    scanToNextCarrier();
  }

  function selectStation(id, options = {}) {
    const station = data.stations.find(item => item.id === id) || data.stations[0];
    if (!options.fromScan) stopScan();
    ensureAudioGraph();
    const root = document.documentElement;
    state.pirate.stop(state.ctx);
    state.staticChannel.setLevel(0, 0.12);
    if (state.preview) state.preview.clear(state.ctx);
    state.pirateSignal = null;
    setReception('locked');
    root.dataset.tuning = 'true';
    clearTimeout(state.tuneTimer);
    state.tuneTimer = setTimeout(() => { root.dataset.tuning = 'false'; }, 760);
    state.decks.forEach(deck => deck.reset());
    Object.assign(state, {
      station, activeIndex: 0, lastTrackTitle: '', songBag: [], songsSinceBreak: 0, breakAfter: 0,
      plan: [], pendingBlock: [], callBag: [], lastCallerRole: '', callCooldown: 0,
      breaksSinceCall: 0, lastBreakKind: '', pendingRequestTags: null, itemsSinceJingle: 0, started: false
    });
    refillPlan();
    renderStation(station); renderQueue(); renderNow(null);
    pushSystemNotice(data.notice);
    byId('skip').disabled = false;
    if (state.power) startBroadcast();
  }

  async function startBroadcast() {
    ensureAudioGraph();
    await state.ctx.resume();
    const first = state.plan.shift();
    refillPlan();
    renderQueue();
    if (!first) return;
    const deck = state.decks[0];
    deck.load(first);
    await deck.play();
    deck.gain.gain.setValueAtTime(1, state.ctx.currentTime);
    state.activeIndex = 0;
    state.started = true;
    const showStatus = () => renderNow(deck, isCallIn(first.type) ? 'Open line to the Street.' : isSpokenKind(first.type) ? 'On the air, live.' : 'Song plays out, host cuts in on the tail.');
    deck.audio.onloadedmetadata = () => { armCutIn(deck); showStatus(); };
    if (deck.audio.readyState >= 1) armCutIn(deck);
    showStatus();
  }

  // The power toggle IS the play control here -- a radio has an on/off switch, not a
  // separate play button. OFF means silent: no static, no preview bleed, no programme,
  // decks fully reset. ON resumes whatever the dial is already sitting on (a locked
  // station starts broadcasting; open spectrum gets static/bleed at the current position).
  async function setPower(on) {
    state.power = on;
    document.documentElement.dataset.power = on ? 'on' : 'off';
    byId('power').dataset.on = String(on);
    byId('power').setAttribute('aria-pressed', String(on));
    byId('power-label').textContent = on ? 'ON AIR' : 'OFF AIR';
    if (!on) {
      stopScan();
      if (state.staticChannel) state.staticChannel.setLevel(0, 0.1);
      if (state.preview) state.preview.clear(state.ctx);
      if (state.pirate) state.pirate.stop(state.ctx);
      state.pirateSignal = null;
      quietProgramme();
      renderNow(null);
      return;
    }
    ensureAudioGraph();
    await state.ctx.resume();
    if (state.reception === 'locked' && state.station) {
      if (!state.started) {
        // quietProgramme() (run on the last power-off) empties state.plan and never gets
        // refilled until a station is (re)selected -- without this, startBroadcast() shifts
        // an empty plan, gets nothing back, and returns having loaded silence. Real bug,
        // caught by testing an off/on cycle while already parked on a locked station.
        refillPlan();
        renderQueue();
        await startBroadcast();
      }
    } else {
      enterDeadBand(Number(byId('tuner').value), { scanning: false });
    }
  }

  const list = byId('station-list');
  // Ordered by dial position (lowest frequency first), not catalog order -- so the preset
  // row reads left-to-right the same way the band itself does.
  data.stations.slice().sort((a, b) => stationDialValue(a) - stationDialValue(b)).forEach((station, index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'station'; button.dataset.id = station.id;
    button.style.setProperty('--button-accent', (station.visualProfile && station.visualProfile.accent) || '#56e5ff');
    button.setAttribute('aria-label', `Preset ${index + 1}: ${station.frequency} ${station.name}`);
    button.title = `${station.frequency} / ${station.name}`;
    button.addEventListener('click', () => selectStation(station.id));
    list.append(button);
  });
  buildDialFace();
  pushSystemNotice(data.notice);
  runNetworkFeed();

  byId('scan').addEventListener('click', toggleScan);
  byId('tuner').addEventListener('input', event => {
    stopScan(true);
    const value = Number(event.target.value);
    byId('tuner-output').textContent = formatDial(value);
    updateDialNeedle(value);
    enterDeadBand(value);
    previewMappedStation(value);
    byId('tuner-note').textContent = 'Manual sweep active. The nearer a carrier, the more of it bleeds through.';
  });
  byId('tuner').addEventListener('change', event => {
    const value = Number(event.target.value);
    const result = nearestCarrier(value);
    if (result && result.distance <= result.entry.width) {
      if (result.entry.kind === 'pirate') {
        playPirateSignal(result.entry.item);
        return;
      }
      selectStation(result.entry.item.id);
      byId('tuner-note').textContent = `Mapped carrier locked: ${result.entry.item.frequency} / ${result.entry.item.name}.`;
      return;
    }
    enterDeadBand(value);
    const preview = previewMappedStation(value);
    byId('tuner-status').textContent = preview ? 'mapped carrier nearby' : 'no carrier';
    byId('tuner-note').textContent = preview
      ? `${preview.name} is bleeding through. Fine-tune the dial to lock it.`
      : `${formatDial(value)} is dead band. Scrub again or start auto scan.`;
  });

  byId('power').addEventListener('click', () => { setPower(!state.power); });
  byId('seek-back').addEventListener('click', () => seekStep(-1));
  byId('seek-forward').addEventListener('click', () => seekStep(1));
  byId('skip').addEventListener('click', () => {
    if (!state.power || !state.started) return;
    const active = state.decks[state.activeIndex];
    if (active.item) startCrossfade(active, 1 - state.activeIndex);
  });

  if (byId('waveform')) {
    byId('waveform').innerHTML = Array.from({ length: 48 }, (_, index) => `<i style="--h:${(.18 + ((index * 37) % 71) / 100).toFixed(2)}"></i>`).join('');
  }

  selectStation(data.defaultStation || data.stations[0].id);
})();
