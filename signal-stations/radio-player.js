(() => {
  const data = window.SIGNAL_STATIONS;
  const byId = id => document.getElementById(id);
  const pick = items => items[Math.floor(Math.random() * items.length)];

  // --- crossfade/timing tuning -------------------------------------------------
  const FADE_S = 2.2;          // song<->liner crossfade duration
  const EARLY_CUT_CHANCE = 0.18; // "sometimes" cuts in before the detected outro, over the last section
  const TAIL_BUFFER_S = 1.5;   // never schedule a cut-in closer than this to a track's hard end
  const LINER_OVERLAP_S = 1.6; // how much of a liner's tail overlaps the next song's intro

  function pickCutInSeconds(track) {
    const dur = track.durationSeconds;
    if (!dur || dur < 6) return Math.max(0, (dur || 6) - TAIL_BUFFER_S);
    const outro = track.outroStartSeconds != null ? track.outroStartSeconds : dur * 0.85;
    const lateEnd = Math.max(outro + 0.5, dur - TAIL_BUFFER_S);
    if (Math.random() < EARLY_CUT_CHANCE) {
      const earlyStart = Math.max(dur * 0.55, outro - 40);
      const earlyEnd = Math.max(earlyStart + 1, outro - 2);
      return earlyStart + Math.random() * (earlyEnd - earlyStart);
    }
    const lateStart = Math.min(outro, lateEnd - 0.5);
    return lateStart + Math.random() * Math.max(0.5, lateEnd - lateStart);
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

  function pickLiner() {
    const pool = (state.station.interludes || []).filter(x => x.audio);
    if (!pool.length) return null;
    const bridges = pool.filter(x => x.kind === 'host bridge');
    const candidates = bridges.length ? bridges : pool;
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
    if (!deck.item || deck.item.type === 'host liner' || deck.item.type === 'host bridge') {
      // liners transition on a fixed tail overlap, not an outro guess
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
    fromDeck.fadeTo(0, state.ctx, FADE_S);
    toDeck.fadeTo(1, state.ctx, FADE_S);
    // fromDeck would otherwise keep decoding/playing silently in the background for
    // whatever's left of its track until this same Deck object gets reused
    setTimeout(() => fromDeck.audio.pause(), (FADE_S + 0.2) * 1000);

    const isLinerNext = next.type === 'host liner' || next.type === 'host bridge';
    if (isLinerNext && state.station.jingle && Math.random() < (state.station.jingle.chance || 0)) {
      state.jingle.play(state.station.jingle.audio, state.ctx, state.station.jingle.peak || 0.7);
    }

    state.activeIndex = toIndex;
    const showStatus = () => renderNow(toDeck, isLinerNext ? 'On the air, live.' : describeCutIn(toDeck));
    toDeck.audio.onloadedmetadata = () => { armCutIn(toDeck); showStatus(); };
    if (toDeck.audio.readyState >= 1) armCutIn(toDeck);
    showStatus(); // cheap immediate label; onloadedmetadata upgrades it once duration/outro are known
  }

  function describeCutIn(deck) {
    if (deck.cutInAt == null || !deck.item || deck.item.type !== 'song') return '';
    const dur = deck.audio.duration || deck.item.durationSeconds || 0;
    const outro = deck.item.outroStartSeconds != null ? deck.item.outroStartSeconds : dur * 0.85;
    const early = deck.cutInAt < outro - 2;
    return early ? 'Host is cutting in early, over the last section.' : 'Host waits for the outro before cutting in.';
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
    const showStatus = () => renderNow(deck, describeCutIn(deck));
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
