(() => {
  const data = window.SIGNAL_STATIONS;
  const byId = id => document.getElementById(id);
  const pick = items => items[Math.floor(Math.random() * items.length)];
  // "spoken" item kinds: short produced/rendered content that transitions on a fixed tail
  // overlap, not an outro guess (that's for actual songs, which have real musical structure).
  const isSpokenKind = type => type === 'host liner' || type === 'host bridge' || type === 'sponsored notice' || type === 'street report';

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
  const LINER_OVERLAP_S = 1.6;    // how much of a liner's tail overlaps whatever comes next

  function pickCutInSeconds(track) {
    const dur = track.durationSeconds;
    if (!dur || dur < 6) return Math.max(0, (dur || 6) - TAIL_BUFFER_S);
    const outro = track.outroStartSeconds != null ? track.outroStartSeconds : dur * 0.9;
    const latest = dur - TAIL_BUFFER_S;
    const earliest = Math.min(Math.max(outro, dur - SONG_TAIL_WINDOW_S), latest);
    return earliest + Math.random() * Math.max(0.3, latest - earliest);
  }

  class Deck {
    constructor(ctx, dest, onTimeUpdate) {
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
      // bound to the audio element's own 'timeupdate', not requestAnimationFrame: rAF gets
      // throttled hard (sometimes fully paused) in a backgrounded/hidden browser tab, but
      // 'timeupdate' keeps firing off real playback progress regardless of tab visibility.
      this.audio.addEventListener('timeupdate', () => onTimeUpdate(this));
    }
    load(item) {
      this.item = item;
      this.cutInAt = null;
      this.firedCutIn = false;
      this.audio.src = item.audio;
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

  const state = {
    station: null, ctx: null, decks: null, jingle: null,
    activeIndex: 0, lastTrackTitle: '', songsSinceBreak: 0, breakAfter: 0,
    plan: [], // lookahead list of upcoming {type, title, subtitle, kindLabel} for the "on deck" panel
    started: false,
  };

  function onDeckTimeUpdate(deck) {
    if (state.decks[state.activeIndex] !== deck) return; // only the currently-active deck can trigger a transition
    if (deck.item && deck.cutInAt != null && !deck.firedCutIn && deck.audio.currentTime >= deck.cutInAt) {
      deck.firedCutIn = true;
      startCrossfade(deck, 1 - state.activeIndex);
    }
  }

  function ensureAudioGraph() {
    if (state.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.ctx = new Ctx();
    const dest = state.ctx.destination;
    state.decks = [new Deck(state.ctx, dest, onDeckTimeUpdate), new Deck(state.ctx, dest, onDeckTimeUpdate)];
    state.jingle = new JingleChannel(state.ctx, dest);
  }

  const rollRunLength = () => {
    const range = state.station.runLength || { min: 2, max: 5 };
    return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
  };

  function chooseTrack() {
    const tracks = (state.station.tracks || []).filter(t => t.audio);
    const alternatives = tracks.filter(t => t.title !== state.lastTrackTitle);
    const track = pick(alternatives.length ? alternatives : tracks);
    state.lastTrackTitle = track.title;
    return { type: 'song', title: track.title, subtitle: track.artist, audio: track.audio, durationSeconds: track.durationSeconds, outroStartSeconds: track.outroStartSeconds };
  }

  const SPONSOR_CHANCE = 0.12; // "sometimes" a sponsored notice runs the song-to-song slot instead of a host line

  function pickLiner() {
    const pool = (state.station.interludes || []).filter(x => x.audio);
    if (!pool.length) return null;
    const ads = pool.filter(x => x.kind === 'sponsored notice');
    // every non-ad kind (host liner, host bridge, street report, ...) draws from one shared
    // pool with equal weight -- every transition here is already song-to-song by construction
    // (there's no separate ad-break/station-ID slot), so "host bridge" doesn't need to be
    // preferred over the rest; it just used to crowd everything else out of rotation entirely.
    const nonAds = pool.filter(x => x.kind !== 'sponsored notice');
    const candidates = (ads.length && Math.random() < SPONSOR_CHANCE) ? ads : (nonAds.length ? nonAds : pool);
    const liner = pick(candidates);
    return { type: liner.kind || 'host liner', title: liner.kind || 'Host', subtitle: liner.copy, audio: liner.audio, durationSeconds: liner.durationSeconds };
  }

  function decideNext() {
    if (!(state.station.tracks || []).some(t => t.audio)) return null;
    if (!state.breakAfter) state.breakAfter = rollRunLength();
    state.songsSinceBreak += 1;
    if (state.songsSinceBreak > state.breakAfter) {
      state.songsSinceBreak = 1;
      state.breakAfter = rollRunLength();
      const liner = pickLiner();
      if (liner) return liner; // song-to-song bridge only, by construction: this branch always sits between two chooseTrack() calls
    }
    return chooseTrack();
  }

  function renderStation(station) {
    byId('frequency').textContent = station.frequency;
    byId('name').textContent = station.name;
    byId('tagline').textContent = station.tagline;
    byId('host').textContent = `Host: ${station.host}`;
    byId('line').textContent = `"${station.sampleLine}"`;
    const trackCount = (station.tracks || []).filter(t => t.audio).length;
    byId('track-count').textContent = trackCount ? `${trackCount} cleared track${trackCount === 1 ? '' : 's'} in rotation` : 'No cleared tracks in rotation';
    document.querySelectorAll('.station').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === station.id)));
  }

  function renderNow(deck, cutInLabel) {
    const item = deck && deck.item;
    byId('now-title').textContent = item ? item.title : 'Off air';
    byId('now-subtitle').textContent = item ? item.subtitle : 'Choose a station with cleared tracks.';
    byId('break-note').textContent = item ? cutInLabel || '' : 'Crossfades in live -- press play to start the broadcast.';
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
      setTimeout(() => fromDeck.fadeTo(0, state.ctx, SONG_FULL_FADE_S), SONG_DUCK_S * 1000);
      totalFadeS = SONG_DUCK_S + SONG_FULL_FADE_S;
    } else {
      fromDeck.fadeTo(0, state.ctx, FADE_S);
      toDeck.fadeTo(1, state.ctx, FADE_S);
      totalFadeS = FADE_S;
    }
    // fromDeck would otherwise keep decoding/playing silently in the background for
    // whatever's left of its track until this same Deck object gets reused
    setTimeout(() => fromDeck.audio.pause(), (totalFadeS + 0.2) * 1000);

    const isHostLine = next.type === 'host liner' || next.type === 'host bridge' || next.type === 'street report';
    if (isHostLine && state.station.jingle && Math.random() < (state.station.jingle.chance || 0)) {
      state.jingle.play(state.station.jingle.audio, state.ctx, state.station.jingle.peak || 0.7);
    }

    state.activeIndex = toIndex;
    const statusLabel = () => {
      if (next.type === 'sponsored notice') return 'Sponsored transmission.';
      if (isHostLine) return 'On the air, live.';
      return 'Song plays out, host cuts in on the tail.';
    };
    const showStatus = () => renderNow(toDeck, statusLabel());
    toDeck.audio.onloadedmetadata = () => { armCutIn(toDeck); showStatus(); };
    if (toDeck.audio.readyState >= 1) armCutIn(toDeck);
    showStatus(); // cheap immediate label; onloadedmetadata upgrades it once duration/outro are known
  }

  function selectStation(id) {
    const station = data.stations.find(item => item.id === id) || data.stations[0];
    ensureAudioGraph();
    state.decks.forEach(d => { d.audio.pause(); d.gain.gain.value = 0; d.item = null; d.cutInAt = null; d.firedCutIn = false; });
    Object.assign(state, { station, activeIndex: 0, lastTrackTitle: '', songsSinceBreak: 0, breakAfter: 0, plan: [], started: false });
    refillPlan();
    renderStation(station); renderQueue(); renderNow(null);
    const trackCount = (station.tracks || []).filter(t => t.audio).length;
    byId('play').disabled = !trackCount;
    byId('play').textContent = trackCount ? 'Start broadcast' : 'No tracks loaded';
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
    const showStatus = () => renderNow(deck, isSpokenKind(first.type) ? 'On the air, live.' : 'Song plays out, host cuts in on the tail.');
    deck.audio.onloadedmetadata = () => { armCutIn(deck); showStatus(); };
    if (deck.audio.readyState >= 1) armCutIn(deck);
    showStatus();
    byId('play').textContent = 'Pause broadcast';
  }

  const list = byId('station-list');
  data.stations.forEach(station => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'station'; button.dataset.id = station.id;
    button.innerHTML = `<strong>${station.frequency} · ${station.name}</strong><span>${station.theme}</span>`;
    button.addEventListener('click', () => selectStation(station.id));
    list.append(button);
  });
  byId('notice').textContent = data.notice;

  byId('play').addEventListener('click', async () => {
    if (!state.started) { await startBroadcast(); return; }
    const active = state.decks[state.activeIndex];
    if (active.audio.paused) { await active.audio.play(); byId('play').textContent = 'Pause broadcast'; }
    else { state.decks.forEach(d => d.audio.pause()); byId('play').textContent = 'Resume broadcast'; }
  });
  byId('skip').addEventListener('click', () => {
    if (!state.started) return;
    const active = state.decks[state.activeIndex];
    if (active.item) startCrossfade(active, 1 - state.activeIndex);
  });
  byId('theme').addEventListener('click', () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
  });

  selectStation(data.defaultStation || data.stations[0].id);
})();
