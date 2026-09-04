(() => {
  const data = window.SIGNAL_STATIONS;
  const byId = id => document.getElementById(id);
  const pick = items => items[Math.floor(Math.random() * items.length)];
  // "spoken" item kinds: short produced/rendered content that transitions on a fixed tail
  // overlap, not an outro guess (that's for actual songs, which have real musical structure).
  const isCallIn = type => type === 'caller talk-back';
  const isSpokenKind = type => type === 'host liner' || type === 'host bridge' || type === 'sponsored notice' || type === 'street report' || type === 'ad block intro' || type === 'ad block outro' || isCallIn(type);
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
  const LINER_OVERLAP_S = 1.6;    // how much of a liner's tail overlaps whatever comes next
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

  const state = {
    station: null, ctx: null, decks: null, jingle: null, master: null, analyser: null,
    activeIndex: 0, lastTrackTitle: '', songsSinceBreak: 0, breakAfter: 0,
    callBag: [], lastCallerRole: '', callCooldown: 0, breaksSinceCall: 0,
    lastBreakKind: '', pendingRequestTags: null, pendingBlock: [],
    plan: [], // lookahead list of upcoming {type, title, subtitle, kindLabel} for the "on deck" panel
    started: false, visualizerStarted: false, tuneTimer: null,
    scanning: false, scanFrame: null, scanTimer: null, scanIndex: -1,
  };

  function onDeckTimeUpdate(deck) {
    if (state.decks[state.activeIndex] !== deck) return; // only the currently-active deck can trigger a transition
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

  function chooseTrack() {
    const tracks = (state.station.tracks || []).filter(t => t.audio);
    const alternatives = tracks.filter(t => t.title !== state.lastTrackTitle);
    let pool = alternatives.length ? alternatives : tracks;
    if (state.pendingRequestTags) {
      const scored = pool.map(track => ({ track, score: trackRequestScore(track, state.pendingRequestTags) }));
      const bestScore = Math.max(...scored.map(item => item.score));
      if (bestScore > 0) pool = scored.filter(item => item.score === bestScore).map(item => item.track);
    }
    const track = pick(pool);
    state.pendingRequestTags = null;
    state.lastTrackTitle = track.title;
    return { type: 'song', title: track.title, subtitle: track.artist, audio: track.audio, durationSeconds: track.durationSeconds, outroStartSeconds: track.outroStartSeconds, tags: track.tags };
  }

  function pickLiner() {
    // ad kinds are never drawn here: sponsored notice only plays inside a block (see
    // buildAdBlock), and ad block intro/outro are block bookends, not general rotation.
    const pool = (state.station.interludes || []).filter(x => x.audio && !isCallIn(x.kind) && x.kind !== 'sponsored notice' && !AD_BLOCK_KINDS.has(x.kind));
    if (!pool.length) return null;
    return toPlanItem(pick(pool));
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
    if (byId('world-tag')) byId('world-tag').textContent = profile.label || 'visual layer';
  }

  function broadcastMode(item) {
    if (!item) return { id: 'idle', label: 'carrier idle' };
    if (isCallIn(item.type)) return { id: 'call', label: 'open line / caller' };
    if (item.type === 'sponsored notice' || AD_BLOCK_KINDS.has(item.type)) return { id: 'ad', label: 'commercial incursion' };
    if (item.type === 'street report') return { id: 'report', label: 'field report' };
    if (item.type === 'host liner' || item.type === 'host bridge') return { id: 'host', label: 'host transmission' };
    if (item.type === 'song') return { id: 'song', label: 'music carrier' };
    return { id: 'signal', label: 'signal fragment' };
  }

  function renderStation(station) {
    applyVisualProfile(station);
    byId('frequency').textContent = station.frequency;
    byId('name').textContent = station.name;
    byId('tagline').textContent = station.tagline;
    byId('host').textContent = `Host: ${station.host}`;
    byId('line').textContent = `"${station.sampleLine}"`;
    const trackCount = (station.tracks || []).filter(t => t.audio).length;
    byId('track-count').textContent = trackCount ? `${trackCount} cleared track${trackCount === 1 ? '' : 's'} in rotation` : 'No cleared tracks in rotation';
    document.querySelectorAll('.station').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === station.id)));
    const dialValue = stationDialValue(station);
    byId('tuner').value = dialValue;
    byId('tuner-output').textContent = formatDial(dialValue);
  }

  function renderNow(deck, cutInLabel) {
    const item = deck && deck.item;
    const mode = broadcastMode(item);
    document.documentElement.dataset.broadcast = mode.id;
    if (byId('mode-label')) byId('mode-label').textContent = mode.label;
    if (byId('signal-lock')) byId('signal-lock').textContent = state.started ? 'signal locked' : 'receiver ready';
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

  function formatDial(value) {
    return (Number(value) / 10).toFixed(1).padStart(5, '0');
  }

  function nearestStation(value) {
    return data.stations.reduce((nearest, station) => {
      const distance = Math.abs(stationDialValue(station) - value);
      return !nearest || distance < nearest.distance ? { station, distance } : nearest;
    }, null).station;
  }

  function setScannerUI(active, status) {
    state.scanning = active;
    document.documentElement.dataset.scanning = String(active);
    byId('scan').setAttribute('aria-pressed', String(active));
    byId('scan').textContent = active ? 'Stop scan' : 'Auto scan';
    byId('tuner-status').textContent = status || (active ? 'seeking carrier' : 'carrier locked');
  }

  function stopScan(preserveDial) {
    if (state.scanFrame) cancelAnimationFrame(state.scanFrame);
    if (state.scanTimer) clearTimeout(state.scanTimer);
    state.scanFrame = null;
    state.scanTimer = null;
    setScannerUI(false, preserveDial ? 'manual seeking' : 'carrier locked');
    if (!preserveDial && state.station) {
      const value = stationDialValue(state.station);
      byId('tuner').value = value;
      byId('tuner-output').textContent = formatDial(value);
    }
  }

  function scanToNextCarrier() {
    if (!state.scanning) return;
    const ordered = data.stations.slice().sort((a, b) => stationDialValue(a) - stationDialValue(b));
    state.scanIndex = (state.scanIndex + 1) % ordered.length;
    const targetStation = ordered[state.scanIndex];
    const from = Number(byId('tuner').value);
    const to = stationDialValue(targetStation);
    const start = performance.now();
    const duration = 1150;
    byId('tuner-status').textContent = 'seeking carrier';
    byId('tuner-note').textContent = 'Scanning the mapped band. Known carriers lock automatically.';
    const step = now => {
      if (!state.scanning) return;
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = Math.round(from + (to - from) * eased);
      byId('tuner').value = value;
      byId('tuner-output').textContent = formatDial(value);
      if (progress < 1) {
        state.scanFrame = requestAnimationFrame(step);
        return;
      }
      state.scanFrame = null;
      selectStation(targetStation.id, { fromScan: true });
      byId('tuner-status').textContent = 'carrier found';
      byId('tuner-note').textContent = `Locked ${targetStation.frequency} / ${targetStation.name}. Continuing scan.`;
      state.scanTimer = setTimeout(scanToNextCarrier, 2200);
    };
    state.scanFrame = requestAnimationFrame(step);
  }

  function toggleScan() {
    if (state.scanning) {
      stopScan();
      byId('tuner-note').textContent = 'Scan stopped on the current known carrier.';
      return;
    }
    const ordered = data.stations.slice().sort((a, b) => stationDialValue(a) - stationDialValue(b));
    state.scanIndex = ordered.findIndex(station => station.id === state.station.id);
    setScannerUI(true, 'seeking carrier');
    scanToNextCarrier();
  }

  function selectStation(id, options = {}) {
    const station = data.stations.find(item => item.id === id) || data.stations[0];
    if (!options.fromScan) stopScan();
    ensureAudioGraph();
    const root = document.documentElement;
    root.dataset.tuning = 'true';
    clearTimeout(state.tuneTimer);
    state.tuneTimer = setTimeout(() => { root.dataset.tuning = 'false'; }, 760);
    state.decks.forEach(deck => deck.reset());
    Object.assign(state, {
      station, activeIndex: 0, lastTrackTitle: '', songsSinceBreak: 0, breakAfter: 0,
      plan: [], pendingBlock: [], callBag: [], lastCallerRole: '', callCooldown: 0,
      breaksSinceCall: 0, lastBreakKind: '', pendingRequestTags: null, started: false
    });
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
    const showStatus = () => renderNow(deck, isCallIn(first.type) ? 'Open line to the Street.' : isSpokenKind(first.type) ? 'On the air, live.' : 'Song plays out, host cuts in on the tail.');
    deck.audio.onloadedmetadata = () => { armCutIn(deck); showStatus(); };
    if (deck.audio.readyState >= 1) armCutIn(deck);
    showStatus();
    byId('play').textContent = 'Pause broadcast';
  }

  const list = byId('station-list');
  data.stations.forEach((station, index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'station'; button.dataset.id = station.id;
    button.style.setProperty('--button-accent', (station.visualProfile && station.visualProfile.accent) || '#56e5ff');
    button.innerHTML = `<strong>Preset ${String(index + 1).padStart(2, '0')} / ${station.frequency}</strong><span>${station.name}</span>`;
    button.addEventListener('click', () => selectStation(station.id));
    list.append(button);
  });
  byId('notice').textContent = data.notice;

  byId('scan').addEventListener('click', toggleScan);
  byId('tuner').addEventListener('input', event => {
    stopScan(true);
    document.documentElement.dataset.tuning = 'true';
    byId('tuner-output').textContent = formatDial(event.target.value);
    byId('tuner-note').textContent = 'Manual sweep active. Release to lock the nearest known carrier.';
  });
  byId('tuner').addEventListener('change', event => {
    const station = nearestStation(Number(event.target.value));
    selectStation(station.id);
    byId('tuner-note').textContent = `Nearest mapped carrier: ${station.frequency} / ${station.name}.`;
  });

  byId('play').addEventListener('click', async () => {
    stopScan();
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
