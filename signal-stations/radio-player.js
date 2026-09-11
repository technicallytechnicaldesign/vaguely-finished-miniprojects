(function(root){
 function seeded(seed){let x=2166136261;for(const c of String(seed))x=Math.imul(x^c.charCodeAt(0),16777619);return()=>{x+=0x6D2B79F5;let t=x;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
 class Director{
  constructor(episodes=[],seed='signal'){this.episodes=episodes;this.seed=seed;this.random=seeded(seed);this.reset();}
  reset(){this.queue=[];this.active=null;this.current=null;this.cueIndex=-1;this.completed=false;}
  start(id){const ep=this.episodes.find(e=>e.id===id);if(!ep)throw Error('Unknown transmission');this.reset();this.active=ep;this.queue=ep.items.map(x=>({...x}));return ep;}
  next(){return this.queue.shift()||null;}
  enter(item){if(this.current===item)return false;this.current=item;this.cueIndex=-1;return true;}
  tick(seconds){const cues=this.current?.cues||[];let i=-1;for(let n=0;n<cues.length;n++)if(cues[n].at<=seconds)i=n;if(i===this.cueIndex||i<0)return null;this.cueIndex=i;return cues[i];}
 }
 function cutIn(track,random=Math.random){
  const duration=track.durationSeconds;const rule=track.transition||{};
  if(rule.mode==='end'||!Number.isFinite(duration)||duration<6)return null;
  if(Number.isFinite(rule.cutInSeconds))return Math.max(0,Math.min(duration-0.2,rule.cutInSeconds));
  // Segments always cut in late -- the song's own last 3-10s -- so a listener hears the song,
  // not a near-instant jump to the segment. outroStartSeconds/outroConfidence, when trustworthy
  // (>=0.6), bias where in that window the cut lands; low/missing confidence used to skip the
  // early cut-in entirely (wait for literal end-of-file instead) -- removing the guaranteed
  // late-window floor for a large share of the catalogue, which measured low confidence
  // (0.18-0.47, logged "cold ending" pattern).
  const latest=Math.max(duration-3,0.2),earliest=Math.max(duration-10,0);
  let point=earliest+random()*Math.max(0,latest-earliest);
  if(Number.isFinite(track.outroConfidence)&&track.outroConfidence>=0.6&&Number.isFinite(track.outroStartSeconds)){
   point=Math.min(latest,Math.max(earliest,track.outroStartSeconds));
  }
  return Math.min(duration-0.2,point);
 }
 root.SignalDirector={Director,seeded,cutIn};
 if(typeof module!=='undefined')module.exports=root.SignalDirector;
})(typeof window!=='undefined'?window:globalThis);

;
(function(root){
 class Deck {
  constructor(ctx,dest,onTimeUpdate,onEnded,onFailure){
   this.audio=new Audio();this.audio.preload='auto';this.audio.crossOrigin='anonymous';
   this.source=ctx.createMediaElementSource(this.audio);this.gain=ctx.createGain();this.gain.gain.value=0;this.source.connect(this.gain).connect(dest);
   this.item=null;this.cutInAt=null;this.firedCutIn=false;this.loadGeneration=0;this.cleanupTimers=new Set();this.cancelPlay=null;
   this.audio.addEventListener('timeupdate',()=>onTimeUpdate(this));this.audio.addEventListener('ended',()=>onEnded(this));
   this.audio.addEventListener('error',()=>{if(!this.cancelPlay)onFailure?.(this);});
   const stalled=()=>{const at=this.audio.currentTime;this.scheduleCleanup(()=>{if(this.item&&!this.audio.paused&&Math.abs(this.audio.currentTime-at)<.1)onFailure?.(this);},8000);};
   this.audio.addEventListener('waiting',stalled);this.audio.addEventListener('stalled',stalled);
  }
  load(item){this.reset();this.item=item;this.audio.src=item.audio;}
  async play(timeoutMs=12000){
   const generation=this.loadGeneration;let timer;
   const ready=new Promise((resolve,reject)=>{
    const finish=error=>{clearTimeout(timer);this.audio.removeEventListener('playing',playing);this.audio.removeEventListener('error',failed);if(this.cancelPlay===cancel)this.cancelPlay=null;error?reject(error):resolve(true);};
    const playing=()=>finish();const failed=()=>finish(new Error('Audio could not load'));const cancel=()=>finish(new Error('Playback superseded'));
    this.cancelPlay=cancel;this.audio.addEventListener('playing',playing,{once:true});this.audio.addEventListener('error',failed,{once:true});timer=setTimeout(()=>finish(new Error('Audio readiness timed out')),timeoutMs);
    try{Promise.resolve(this.audio.play()).catch(finish);}catch(error){finish(error);}
   });
   await ready;if(this.loadGeneration!==generation)throw Error('Playback superseded');return true;
  }
  scheduleCleanup(callback,delay){const generation=this.loadGeneration;const timer=setTimeout(()=>{this.cleanupTimers.delete(timer);if(this.loadGeneration===generation)callback();},delay);this.cleanupTimers.add(timer);}
  cancelCleanup(){this.cleanupTimers.forEach(clearTimeout);this.cleanupTimers.clear();}
  reset(){this.cancelPlay?.();this.cancelCleanup();this.loadGeneration++;this.audio.pause();this.gain.gain.cancelScheduledValues(0);this.gain.gain.value=0;this.item=null;this.cutInAt=null;this.firedCutIn=false;}
  fadeTo(target,ctx,seconds){const gain=this.gain.gain,now=ctx.currentTime;if(gain.cancelAndHoldAtTime)gain.cancelAndHoldAtTime(now);else{gain.cancelScheduledValues(now);gain.setValueAtTime(gain.value,now);}gain.linearRampToValueAtTime(target,now+seconds);}
 }
 root.SignalAudio={Deck};if(typeof module!=='undefined')module.exports=root.SignalAudio;
})(typeof window!=='undefined'?window:globalThis);

;
(function(root){
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 class Presentation{
  constructor(data,actions){
   this.data=data;this.actions=actions;this.records=[];this.mode='tune';this.dialOpen=true;
   try{const saved=JSON.parse(localStorage.getItem('signal-receiver-v1')||'{}');if(Array.isArray(saved.records))this.records=saved.records.filter(x=>x&&typeof x.key==='string'&&typeof x.title==='string').slice(-100);}catch{}
   this.root=document.documentElement;this.root.dataset.view=this.mode;
   document.getElementById('view-toggle').addEventListener('click',()=>this.setView(this.mode==='quiet'?(this.dialOpen?'tune':'listen'):'quiet'));
   document.getElementById('tune-toggle').addEventListener('click',()=>{this.dialOpen=this.mode!=='tune';this.setView(this.dialOpen?'tune':'listen');});
   document.getElementById('volume').addEventListener('input',e=>actions.volume(Number(e.target.value)));
   document.getElementById('playback-retry').addEventListener('click',()=>actions.retry());
   this.setView(this.mode);this.renderArchive();
  }
  setView(mode){this.mode=mode;this.root.dataset.view=mode;document.getElementById('view-toggle').setAttribute('aria-pressed',String(mode==='quiet'));document.getElementById('tune-toggle').setAttribute('aria-expanded',String(mode==='tune'));document.getElementById('tune-toggle').setAttribute('aria-label',mode==='tune'?'Hide dial':'Show dial');document.getElementById('tune-toggle').title=mode==='tune'?'Hide dial':'Show dial';this.save();}
  save(){try{localStorage.setItem('signal-receiver-v1',JSON.stringify({records:this.records,mode:this.mode}));}catch{}}
  remember(key,title,kind){if(this.records.some(r=>r.key===key))return;this.records.push({key,title,kind,date:new Date().toISOString().slice(0,10)});this.records=this.records.slice(-100);this.save();this.renderArchive();}
  renderArchive(){document.getElementById('discovery-count').textContent=String(this.records.length);document.getElementById('discovery-list').innerHTML=this.records.length?this.records.slice().reverse().map(r=>`<li><strong>${escape(r.title)}</strong><span>${escape(r.kind)} / ${escape(r.date)}</span></li>`).join(''):'<li>Found carriers and completed transmissions stay here, on this device.</li>';}
  episode(item){this.root.dataset.episode=item?.episodeId?'true':'false';}
  cue(cue){if(!cue)return;this.root.dataset.phase=cue.phase;const heading=document.getElementById('scene-headline');if(heading)heading.textContent=cue.headline;const note=document.getElementById('line');if(note)note.textContent=cue.note;const log=document.getElementById('notice-log');log.innerHTML='';for(const[who,text]of cue.lines||[]){const line=document.createElement('div');line.className='console-line listener';const name=document.createElement('strong');name.className='who';name.textContent='['+who+'] ';line.append(name,document.createTextNode(text));log.append(line);}document.getElementById('scene-accessible').textContent=cue.headline;}
  progress(item,seconds){
   const elapsed=Math.floor(item ? seconds||0 : 0),duration=Math.floor(item?.durationSeconds||0);const fmt=s=>Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
   document.getElementById('listening-time').textContent=fmt(elapsed)+' / '+fmt(duration);
  }
  status(text,error=false){document.getElementById('playback-status').textContent=text;document.getElementById('playback-retry').hidden=!error;this.root.dataset.playback=error?'error':'ready';}
 }
 root.SignalPresentation={Presentation,escape};
})(window);

;
(() => {
  const data = window.SIGNAL_STATIONS;
  const seed = new URLSearchParams(location.search).get('seed') || String(Date.now());
  const director = new SignalDirector.Director(data.episodes || [], seed);
  let presentation = null;
  const esc = SignalPresentation.escape;
  const byId = id => document.getElementById(id);
  const pick = items => items[Math.floor(director.random() * items.length)];
  // "spoken" item kinds: short produced/rendered content that transitions on a fixed tail
  // overlap, not an outro guess (that's for actual songs, which have real musical structure).
  const isCallIn = type => type === 'caller talk-back';
  const isCallSegment = type => type === 'call segment intro' || type === 'call segment outro' || type === 'call segment filler';
  const isSpokenKind = type => type === 'host liner' || type === 'host bridge' || type === 'sponsored notice' || type === 'street report' || type === 'ad block intro' || type === 'ad block outro' || type === 'station ID' || isCallIn(type) || isCallSegment(type);
  const AD_BLOCK_KINDS = new Set(['ad block intro', 'ad block outro']);
  const CALL_SEGMENT_KINDS = new Set(['call segment intro', 'call segment outro', 'call segment filler']);

  // --- crossfade/timing tuning -------------------------------------------------
  // Songs always play out to their own real end (SIG-mobile-early-cutin, 2026-09-10): no
  // computed early cut-in over the outro anymore, after three straight sessions of that
  // mechanism misbehaving on mobile. Entering a segment is now a clean handoff, not a blend:
  // whatever was playing stops fast, then the segment starts at full volume. The static
  // "tuning" hiss-click (StaticChannel.burst()) originally played before EVERY spoken kind --
  // ads, street reports, station IDs included -- which read wrong (maker feedback 2026-09-11:
  // "remove the static hiss between the adverts, it's meant to be between callers when they
  // come on the air"). It's now scoped to caller pickups only (see startCrossfade below);
  // every other spoken kind gets a plain clean cut, no hiss.
  const SONG_DUCK_S = 0.6;        // fast fade-out of whatever was playing before a segment starts
  const CLEAN_CUT_S = 0.08;       // silent gap before a non-caller segment's audio becomes audible
  const CALLER_STATIC_CLICK_S = 0.55; // longer, quieter hiss lead-in specifically for a caller pickup
  const FADE_S = 2.2;             // symmetric crossfade duration for entering a song (song -> song)
  // Kept short on purpose (was 1.6s -- SIG feedback 2026-09-05: the host was getting
  // drowned out because the incoming song/ad had already climbed most of the way to full
  // volume before the host actually finished the sentence). This still overlaps enough to
  // avoid a hard silence, but the host's tail is essentially clear before anything rises.
  const LINER_OVERLAP_S = 0.5;    // how much of a liner's tail overlaps whatever comes next
  const CALL_POST_GAP_MS = 300;   // let the mixed disconnect land before the requested song starts
  const CRUSTACEAN_CALLER_GAP_MS = 1500; // longer beat after a live CRUSTACEAN caller, filled with chitterLegs()

  const Deck = SignalAudio.Deck;

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
    // A short "tuning click" -- rises fast, holds, then settles back to whatever ambient
    // level was already playing (so it doesn't disturb the separate proximity/power-driven
    // setLevel() calls elsewhere). Used as the handoff into a segment now that segments no
    // longer interrupt a song mid-play -- see CALLER_STATIC_CLICK_S in the crossfade sequencer.
    burst(peak = 0.42, riseS = 0.03, holdS = 0.1, fallS = 0.22) {
      const gain = this.gain.gain;
      const now = this.ctx.currentTime;
      const rest = gain.value;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(rest, now);
      gain.linearRampToValueAtTime(peak, now + riseS);
      gain.setValueAtTime(peak, now + riseS + holdS);
      gain.linearRampToValueAtTime(rest, now + riseS + holdS + fallS);
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

  // Caller-section background bed (SIG, 2026-09-09): a real looping music track, mixed very
  // quietly, that runs under an entire call-related run -- caller talk-back plus its
  // surrounding intro/filler/outro bridges -- rather than under just one clip at a time, so
  // it doesn't restart/refade on every single caller. Driven by a per-station `callerBed`
  // data field (currently only CRUSTACEAN's) rather than a hardcoded station id, so another
  // station can opt in later with no code change. See startCrossfade()'s use of it.
  class CallerBedChannel {
    constructor(ctx, dest) {
      this.ctx = ctx;
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.crossOrigin = 'anonymous';
      this.audio.loop = true;
      this.source = ctx.createMediaElementSource(this.audio);
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.source.connect(this.gain).connect(dest);
      this.currentSrc = null;
      this.active = false;
    }
    fadeIn(url, ctx, level = 0.055, seconds = 1.4) {
      if (!url) return;
      if (this.currentSrc !== url) { this.currentSrc = url; this.audio.src = url; this.audio.currentTime = 0; }
      if (this.audio.paused) this.audio.play().catch(() => {});
      this.active = true;
      const gain = this.gain.gain, now = ctx.currentTime;
      gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(level, now + seconds);
    }
    fadeOut(ctx, seconds = 1.6) {
      if (!this.active) return;
      this.active = false;
      const gain = this.gain.gain, now = ctx.currentTime;
      gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, now + seconds);
      setTimeout(() => { if (!this.active) this.audio.pause(); }, (seconds + 0.2) * 1000);
    }
    stop() {
      this.active = false;
      this.audio.pause();
      this.gain.gain.cancelScheduledValues(0);
      this.gain.gain.value = 0;
    }
  }

  // CRUSTACEAN caller texture (SIG, 2026-09-09): two small one-shot SFX, synthesized rather
  // than sourced (same "plain Web Audio DSP, no samples" approach as StaticChannel above and
  // make_callin_sfx.py) so there's no asset dependency. A dial tone (two sustained sine
  // tones, classic telephony pair) right as a caller locks in, and a short "chittering legs"
  // burst -- a handful of tiny randomized bandpassed noise grains -- in the pause after one
  // caller ends and before the next segment starts. Both are one-shots: a fresh gain/oscillator
  // graph per call, torn down after it finishes rather than a channel kept alive between uses.
  class SfxChannel {
    constructor(ctx, dest) { this.ctx = ctx; this.dest = dest; }
    dialTone() {
      const ctx = this.ctx, now = ctx.currentTime, dur = 0.45;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.1, now + 0.04);
      gain.gain.setValueAtTime(0.1, now + dur - 0.08);
      gain.gain.linearRampToValueAtTime(0, now + dur);
      gain.connect(this.dest);
      [350, 440].forEach(freq => {
        const osc = ctx.createOscillator();
        osc.type = 'sine'; osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(now); osc.stop(now + dur);
      });
    }
    chitterLegs() {
      const ctx = this.ctx, now = ctx.currentTime;
      const grains = 10 + Math.floor(Math.random() * 6);
      let t = now;
      for (let i = 0; i < grains; i += 1) {
        const grainDur = 0.012 + Math.random() * 0.018;
        const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * grainDur), ctx.sampleRate);
        const samples = buffer.getChannelData(0);
        for (let s = 0; s < samples.length; s += 1) samples[s] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource(); src.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass'; filter.frequency.value = 1500 + Math.random() * 2600; filter.Q.value = 4 + Math.random() * 4;
        const gain = ctx.createGain();
        const peak = 0.05 + Math.random() * 0.05;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(peak, t + grainDur * 0.3);
        gain.gain.linearRampToValueAtTime(0, t + grainDur);
        src.connect(filter).connect(gain).connect(this.dest);
        src.start(t); src.stop(t + grainDur);
        t += grainDur + 0.02 + Math.random() * 0.07;
      }
    }
  }

  const state = {
    station: null, ctx: null, decks: null, jingle: null, staticChannel: null, pirate: null, preview: null, master: null, analyser: null,
    activeIndex: 0, lastTrackTitle: '', songBag: [], songsSinceBreak: 0, breakAfter: 0,
    callBag: [], lastCallerRole: '', callCooldown: 0, breaksSinceCall: 0,
    linerBag: [], lastLinerAudio: '',
    lastBreakKind: '', pendingRequestTags: null, pendingBlock: [], itemsSinceJingle: 0,
    plan: [], // lookahead list of upcoming {type, title, subtitle, kindLabel} for the "on deck" panel
    started: false, visualizerStarted: false, tuneTimer: null,
    scanning: false, scanFrame: null, scanTimer: null, scanIndex: -1, seekFrame: null,
    reception: 'locked', pirateSignal: null, power: false, lyricTicker: null,
    hostQuoteTimer: null, hostQuoteIndex: 0, hostFocus: null, hostKey: '',
    consoleMuted: false, consoleGeneration: 0, playbackEpoch: 0, transitioning: false, failedAudio: new Set(), volume: 0.8,
    offerWindow: null, offerTimer: null, lastOfferAt: 0, recoveryAttempts: 0, recoveryTimer: null,
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
  const CRUSTACEAN_LYRIC_VARIANTS = ['v-cru-drift', 'v-cru-drift', 'v-cru-fade', 'v-cru-depth'];
  const CRUSTACEAN_LYRIC_FONTS = ['var(--font-cru-serif)', 'var(--font-cru-mono)', 'var(--font-cru-book)'];
  function spawnLyricWord(container, text) {
    if (!container || !text) return null;
    const span = document.createElement('span');
    const isCrustacean = state.station && state.station.id === 'crustacean';
    const variants = isCrustacean ? CRUSTACEAN_LYRIC_VARIANTS : LYRIC_VARIANTS;
    const fonts = isCrustacean ? CRUSTACEAN_LYRIC_FONTS : LYRIC_FONTS;
    const variant = variants[Math.floor(Math.random() * variants.length)];
    const isBg = variant === 'v-bg';
    const isFly = variant === 'v-fly';
    const isGlitch = !isCrustacean && Math.random() < 0.38;
    const size = isCrustacean ? 11 + Math.random() * 24 : isBg ? 50 + Math.random() * 100 : 8 + Math.random() * 46;
    const font = fonts[Math.floor(Math.random() * fonts.length)];
    const top = Math.random() * (isCrustacean ? 88 : 84);
    const left = isFly ? 0 : Math.random() * (isCrustacean ? 72 : 62);
    const rot = (Math.random() * (isCrustacean ? 4 : 18) - (isCrustacean ? 2 : 9)).toFixed(1);
    const dx = (Math.random() * (isCrustacean ? 30 : 70) - (isCrustacean ? 15 : 35)).toFixed(0);
    const dy = (Math.random() * (isCrustacean ? 24 : 70) - (isCrustacean ? 12 : 35)).toFixed(0);
    const flyFrom = Math.random() < 0.5 ? '-20%' : '118%';
    const flyTo = flyFrom === '-20%' ? '118%' : '-20%';
    const dur = (isCrustacean ? 14 + Math.random() * 12 : isFly ? 3.5 + Math.random() * 2.5 : isBg ? 8 + Math.random() * 6 : 5 + Math.random() * 4).toFixed(2);
    const delay = (Math.random() * (isCrustacean ? 4 : 1.4)).toFixed(2);
    const timing = isGlitch ? `steps(${4 + Math.floor(Math.random() * 6)},jump-end)` : (isFly ? 'linear' : 'ease-in-out');
    const accent = Math.random() < 0.5 ? 'lyric-word-a' : 'lyric-word-b';
    span.className = `lyric-word ${variant} ${accent}${isGlitch ? ' glitch-word' : ''}`;
    span.textContent = text;
    span.style.cssText = `font-size:${size.toFixed(0)}px;font-family:${font};top:${top.toFixed(1)}%;left:${left.toFixed(1)}%;--rot:${rot}deg;--dx:${dx}px;--dy:${dy}px;--fly-from:${flyFrom};--fly-to:${flyTo};--alpha:${(isCrustacean ? 0.2 + Math.random() * 0.48 : 1).toFixed(2)};--depth:${(Math.random() * 18 - 9).toFixed(0)}px;animation-duration:${dur}s;animation-delay:${delay}s;animation-timing-function:${timing}`;
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
    if (!state.power || !deck.item) return;
    if (state.decks[state.activeIndex] !== deck) return; // only the currently-active deck can trigger a transition
    renderProgress(deck);
    presentation?.progress(deck.item, deck.audio.currentTime);
    if (deck.item?.episodeId) presentation?.cue(director.tick(deck.audio.currentTime));
    tickLyricTicker(deck);
    if (deck.item && deck.cutInAt != null && !deck.firedCutIn && deck.audio.currentTime >= deck.cutInAt) {
      deck.firedCutIn = true;
      startCrossfade(deck, 1 - state.activeIndex);
    }
  }

  function onDeckEnded(deck) {
    if (state.decks[state.activeIndex] !== deck || !deck.item || !state.power) return;
    const epoch = state.playbackEpoch;
    // CRUSTACEAN, leaving an actual caller voice (not the intro/filler/outro bridges around
    // it): a longer beat than the usual post-call gap, with a little chittering-legs texture
    // filling it, before the next segment starts.
    const isCrustaceanCaller = state.station?.id === 'crustacean' && isCallIn(deck.item.type);
    if (isCrustaceanCaller) state.sfx?.chitterLegs();
    const gapMs = isCrustaceanCaller ? CRUSTACEAN_CALLER_GAP_MS : (isCallIn(deck.item.type) || isCallSegment(deck.item.type)) ? CALL_POST_GAP_MS : 0;
    setTimeout(() => {
      if (epoch === state.playbackEpoch && state.decks[state.activeIndex] === deck && state.power) startCrossfade(deck, 1 - state.activeIndex);
    }, gapMs);
  }

  function onDeckFailure(deck) {
    if (!state.power || state.decks[state.activeIndex] !== deck || !deck.item) return;
    state.failedAudio.add(deck.item.audio);
    presentation?.status('Carrier interrupted. Recovering the next transmission.');
    startCrossfade(deck, 1 - state.activeIndex);
  }

  function ensureAudioGraph() {
    if (state.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.ctx = new Ctx();
    state.master = state.ctx.createGain();
    state.master.gain.value = state.volume;
    state.analyser = state.ctx.createAnalyser();
    state.analyser.fftSize = 256;
    state.analyser.smoothingTimeConstant = 0.82;
    state.master.connect(state.analyser);
    state.analyser.connect(state.ctx.destination);
    const dest = state.master;
    state.decks = [new Deck(state.ctx, dest, onDeckTimeUpdate, onDeckEnded, onDeckFailure), new Deck(state.ctx, dest, onDeckTimeUpdate, onDeckEnded, onDeckFailure)];
    state.jingle = new JingleChannel(state.ctx, dest);
    state.staticChannel = new StaticChannel(state.ctx, dest);
    state.pirate = new PirateChannel(state.ctx, dest);
    state.preview = new PreviewChannel(state.ctx, dest);
    state.sfx = new SfxChannel(state.ctx, dest);
    state.callerBed = new CallerBedChannel(state.ctx, dest);
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
    return range.min + Math.floor(director.random() * (range.max - range.min + 1));
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
    const tracks = (state.station.tracks || []).filter(t => t.audio && !state.failedAudio.has(t.audio));
    if (!tracks.length) return null;
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
      bagIndex = best[Math.floor(director.random() * best.length)].index;
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
    return { ...track, type: 'song', title: track.title, subtitle: track.artist, audio: track.audio, durationSeconds: track.durationSeconds, outroStartSeconds: track.outroStartSeconds, tags: track.tags, lyricsLines: track.lyricsLines };
  }

  // Shuffle-bag, same no-repeat-until-exhausted pattern as chooseTrack()'s songBag/
  // pickCallIn()'s callBag (maker feedback 2026-09-12: a uniform per-break coin flip left
  // CRUSTACEAN's AINEKO segment -- 1 of only 4 host liners -- statistically real but rare
  // enough (~11% of breaks, MEASURED via a 200k-run sim) that a listener could go hours
  // without ever landing on it, while Dr. Krill's other 3 liners repeat freely. Every host
  // liner a station has now plays once before any of them repeat, so a small pool (like
  // CRUSTACEAN's 4) surfaces its rarest member on a bounded schedule instead of leaving it to
  // chance. Keyed by `audio`, the one field guaranteed unique across liners.
  function pickLiner() {
    // ad kinds are never drawn here: sponsored notice only plays inside a block (see
    // buildAdBlock), and ad block intro/outro are block bookends, not general rotation.
    // call segment intro/outro/filler are likewise block-only bookends/bridges (see
    // buildCallBlock) -- drawing one standalone would play a filler with no caller either
    // side of it, or an outro with no call that just happened.
    const pool = (state.station.interludes || []).filter(x => x.audio && !isCallIn(x.kind) && x.kind !== 'sponsored notice' && !AD_BLOCK_KINDS.has(x.kind) && !isCallSegment(x.kind));
    if (!pool.length) return null;
    const byAudio = new Map(pool.map(x => [x.audio, x]));
    state.linerBag = state.linerBag.filter(audio => byAudio.has(audio));
    if (!state.linerBag.length) state.linerBag = shuffle(pool.map(x => x.audio));
    const bagIndex = state.linerBag.findIndex(audio => audio !== state.lastLinerAudio);
    const [audio] = state.linerBag.splice(bagIndex < 0 ? 0 : bagIndex, 1);
    state.lastLinerAudio = audio;
    return toPlanItem(byAudio.get(audio));
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
    const chance = state.station.stationJingleChance == null ? 0.2 : state.station.stationJingleChance;
    if (director.random() > chance) return null;
    state.itemsSinceJingle = 0;
    return toPlanItem(pick(jingles));
  }

  function toPlanItem(liner) {
    const callTitle = liner.callerName ? `Open line: ${liner.callerName}` : 'Open line';
    // A liner carrying its own `title` is a titled piece (a long-form host segment, not a short
    // one-off bridge line) -- treat it like a song: real title, short subtitle, and NEVER surface
    // `copy` in the UI. Before this, any liner with no explicit title fell back to `copy` as its
    // subtitle, which was harmless for a one-sentence bridge line but dumped an entire multi-minute
    // monologue into the tagline (and the on-deck queue preview) for CRUSTACEAN's host segments --
    // reported live 2026-09-06 as overtaking the screen. `copy` still travels with the item for any
    // future non-display use (e.g. a transcript feature), it's just never read for display again.
    const hasOwnTitle = !isCallIn(liner.kind) && liner.title;
    return {
      id: liner.id,
      type: liner.kind || 'host liner',
      title: isCallIn(liner.kind) ? callTitle : (liner.title || liner.kind || 'Host'),
      subtitle: isCallIn(liner.kind) && liner.callerRole
        ? `${liner.callerRole} / ${liner.copy}`
        : hasOwnTitle ? (liner.hostName || 'Live segment') : liner.copy,
      audio: liner.audio,
      durationSeconds: liner.durationSeconds,
      callerRole: liner.callerRole,
      requestTags: liner.requestTags,
      hostName: liner.hostName,
      hostPortrait: liner.hostPortrait,
      hostQuotes: liner.hostQuotes
    };
  }

  function shuffle(items, random = director.random) {
    const shuffled = items.slice();
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  // --- network notice console ---------------------------------------------------
  // The "Network notice" panel reads as a live channel log: a rolling loop of scripted
  // scenes (station.networkFeed, falling back to the shared data.networkFeed default for
  // a station without its own -- see stationNetworkFeed() -- listener chat, simulated
  // scrape/telemetry output, and the station's own daemon interruptions) plus real
  // functional notices (station lock, dead band, pirate carrier) pushed in as distinct
  // [SIGNAL] lines. Chat and exec/daemon lines both build up character-by-character (a chat
  // line just reads fast, since real clients don't type letter by letter); [SIGNAL] lines
  // land instantly since they carry actual state and shouldn't get stuck behind a typing
  // crawl. The shared default in stations.data.js is Snow-Crash-flavored (its original
  // home before this went per-station); CRUSTACEAN STATION got its own feed 2026-09-06.
  const CONSOLE_MAX_LINES = 40;
  const CONSOLE_TYPE_MS = 30;        // per-character delay for exec/daemon lines
  const CONSOLE_CHAT_MS = 10;        // per-character delay for listener chat lines
  const CONSOLE_LINE_GAP_MS = 900;   // default pause after a line finishes, before the next
  const CONSOLE_SCENE_GAP_MS = 4200; // pause between scenes

  function consoleLog() { return byId('notice-log'); }

  function setConsoleSearching(searching) {
    state.consoleMuted = searching;
    state.consoleGeneration += 1;
    const body = consoleLog();
    if (!body) return;
    body.replaceChildren();
    byId('notice').classList.remove('alert');
    if (searching) {
      const el = appendConsoleLine('signal');
      if (el) el.textContent = 'searching for signal...';
    }
  }

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

  async function typeInto(el, text, perCharMs, generation) {
    const cursor = document.createElement('span');
    cursor.className = 'console-cursor';
    el.appendChild(cursor);
    for (let index = 0; index < text.length; index += 1) {
      if (state.consoleMuted || state.consoleGeneration !== generation || !el.isConnected) {
        cursor.remove();
        return false;
      }
      cursor.insertAdjacentText('beforebegin', text[index]);
      scrollConsole();
      if (perCharMs) await wait(perCharMs);
    }
    cursor.remove();
    return true;
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
    if (state.consoleMuted) return;
    const el = appendConsoleLine('signal');
    if (!el) return;
    el.textContent = text;
    scrollConsole();
  }

  async function playFeedLine(line) {
    if (state.consoleMuted) return;
    const generation = state.consoleGeneration;
    const el = appendConsoleLine(line.role);
    if (!el) return;
    if (line.who) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `[${line.who}]: `;
      el.appendChild(who);
    }
    const completed = await typeInto(el, line.text, line.role === 'listener' ? CONSOLE_CHAT_MS : CONSOLE_TYPE_MS, generation);
    if (!completed) return;
    if (line.role === 'daemon') flashConsole();
    scrollConsole();
  }

  // Per-station feed pool, added 2026-09-06 (was one fixed Snow-Crash-flavored pool for
  // every station regardless of tuning): a station's own `networkFeed` wins when present,
  // falling back to the shared `data.networkFeed` default for stations without one yet.
  function stationNetworkFeed(station) {
    const feed = (station && station.networkFeed) || data.networkFeed || [];
    return feed.filter(scene => scene && scene.length);
  }

  // Small live replies stop the station log from being a detached wallpaper: when a song
  // is playing they borrow its currently visible lyric fragment, while host/ID moments get
  // their own station-specific side-eye. The authored feed remains the main programme.
  // Rate and shape both tuned 2026-09-09 per maker feedback: was firing on ~38% of every
  // scene check (too constant) and always the same "comment mentioning {lyric}" shape --
  // slowed to ~16%, and now rolls between three formats: someone just yelling their favorite
  // line verbatim (no commentary), the classic single authored comment, or two different
  // voices piling on the same lyric back to back (comment / lyric / comment, via two people
  // rather than splitting one sentence, which reads more like a real chat pile-on).
  const REACTION_FIRE_CHANCE = 0.16;
  const REACTION_YELL_CHANCE = 0.35;
  const REACTION_PILEON_CHANCE = 0.55; // cumulative: yell, then this, then plain comment
  function networkReactionScene(station) {
    const reactions = station?.networkReactions;
    const item = state.decks?.[state.activeIndex]?.item;
    const pool = item?.type === 'song' ? reactions?.song : reactions?.host;
    if (!pool?.length || Math.random() > REACTION_FIRE_CHANCE) return null;
    const lyricLines = item?.lyricsLines || [];
    const lyric = lyricLines.length ? lyricLines[Math.floor(Math.random() * lyricLines.length)] : (item?.title || 'that last signal');
    const roll = Math.random();
    if (roll < REACTION_YELL_CHANCE && lyricLines.length) {
      const reaction = pool[Math.floor(Math.random() * pool.length)];
      return [{ role: reaction.role || 'listener', who: reaction.who || 'OPEN_CHANNEL', text: `“${lyric.toUpperCase()}”!!`, holdMs: 1100 }];
    }
    if (roll < REACTION_PILEON_CHANCE && pool.length >= 2) {
      const [first, second] = shuffle(pool, Math.random);
      return [
        { role: first.role || 'listener', who: first.who || 'OPEN_CHANNEL', text: first.text.replaceAll('{lyric}', `“${lyric}”`), holdMs: first.holdMs || 1300 },
        { role: second.role || 'listener', who: second.who || 'OPEN_CHANNEL', text: second.text.replaceAll('{lyric}', `“${lyric}”`), holdMs: second.holdMs || 1600 }
      ];
    }
    const reaction = pool[Math.floor(Math.random() * pool.length)];
    return [{
      role: reaction.role || 'listener',
      who: reaction.who || 'OPEN_CHANNEL',
      text: reaction.text.replaceAll('{lyric}', `“${lyric}”`),
      holdMs: reaction.holdMs || 1600
    }];
  }

  // CRUSTACEAN's two "Little Red Lobster" songs (contract-law satire, KRILL & ASSOCIATES) get
  // a special treatment (maker's request, 2026-09-09): the NET console erupts into a chanting
  // lobster mob -- a dense, fast burst of one-off screaming handles, chased by the station
  // daemon "kicking" an escalating (deliberately absurd) count of connections -- instead of
  // the normal scripted feed/reaction cadence, for as long as one of those two tracks is the
  // active item. Reverts to the normal feed the moment the song changes.
  const LOBSTER_SONG_IDS = new Set(['crustacean-little-red-lobster-knows-contract-law', 'crustacean-little-red-lobster-knows']);
  const LOBSTER_CHANTS = ['DA DA DA', 'DAAAAAAAAAAAAAAAAAA', 'DAVAIII DAVAIII WETWARE HOLDERS', 'LITTLE RED LOBSTER KNOWS', 'CONTRACT LAW BABY', 'CLAWS UP', 'I AM SHELL NOW', 'MOLTING RIGHTS FOREVER', 'WETWARE UNION NEVER DIES', 'OBJECTION SUSTAINED', 'SHE KNOWS THE LAW', 'RED LOBSTER SUPREMACY', 'FILE THE CLAIM', 'CRUSTACEAN JURISPRUDENCE', 'ALL RISE FOR THE LOBSTER', 'WE ARE PEOPLES. LEGAL PEOPLES.', 'click click click click click', 'chitter chitter chitter', 'PERSONHOOD IS A CARAPACE AWAY', 'STANDING TO SUE, YOUR HONOR', 'THE BRIEF IS SHELL-SHAPED AND FINAL', 'NO SETTLEMENT, ONLY PRECEDENT', 'TIDEPOOL RECOGNIZES NO SUPERIOR COURT', 'ANTENNAE UP FOR THE VERDICT', 'BISQUE IS A HATE CRIME', 'CLASS ACTION, CLASS ACTION, CLASS ACTION'];
  const LOBSTER_HANDLE_PREFIXES = ['LOBSTER', 'CLAW', 'SHELL', 'WETWARE', 'MOLT', 'KRILL_FAN', 'BISQUE', 'CARAPACE', 'PINCER', 'TIDEPOOL'];
  let lobsterKickTotal = 0;
  function lobsterHandle() {
    const prefix = LOBSTER_HANDLE_PREFIXES[Math.floor(Math.random() * LOBSTER_HANDLE_PREFIXES.length)];
    return `${prefix}_${1000 + Math.floor(Math.random() * 98999)}`;
  }
  function lobsterEruptionScene() {
    const burst = 3 + Math.floor(Math.random() * 4);
    const lines = [];
    for (let i = 0; i < burst; i += 1) {
      const shout = LOBSTER_CHANTS[Math.floor(Math.random() * LOBSTER_CHANTS.length)];
      lines.push({ role: 'listener', who: lobsterHandle(), text: Math.random() < 0.5 ? `${shout}!!!` : shout, holdMs: 90 + Math.random() * 160 });
    }
    lobsterKickTotal += burst * (10 + Math.floor(Math.random() * 90));
    if (lobsterKickTotal > 9999998999898999) lobsterKickTotal = burst; // the joke resets itself rather than overflowing
    lines.push({ role: 'daemon', who: 'CRUSTACEAN STATION', text: `KICKING ${burst} LOBSTER CONNECTIONS. ${lobsterKickTotal.toLocaleString()} DISCONNECTED THIS SEGMENT AND CLIMBING.`, holdMs: 550 });
    return lines;
  }

  // "Good Kitty" (CRUSTACEAN, BOUNDED COGNITION) gets its own eruption, 2026-09-09: AINEKO/cat
  // consciousness chaos -- laser fixation, keyboard-walking, the general feline refusal to be
  // impressed -- with the lobster loyalists from above interrupting to demand their format
  // back. Same dense/fast shape as the lobster eruption, different two-faction daemon line.
  const CAT_SONG_IDS = new Set(['crustacean-good-kitty']);
  const CAT_CHANTS = ['LASER. OOOOOHHH. LASER.', 'id recommend this but thats too much emotional labour', 'random keys get pressed by cat dancing across the keyboard', 'asdkfj;alksdjf;alsdkjf', 'knocked a glass off the table on purpose. no regrets.', 'the red dot is a lie and I chase it anyway', 'sat on the mixing board. this is now my mix.', 'purpose is a scent I have already forgotten', 'loaf mode engaged. do not disturb.', '6 lives remain. unclear what happened to the other 3.', 'walked across every fader at once and it improved the track', 'MEOWWWW', 'meow', 'MEOW MEOW MEOW', 'mrow???', 'MRAOW', 'staring directly into your soul. no reason.', 'the bag is now mine. so is the box it came in.', 'knocked it off the shelf. it was in my way. it is still in my way.', '3am zoomies commencing, no notes given', 'chirped at a bird through the window and meant every word', 'kneading the good blanket. do not move the good blanket.', 'refused the expensive food. wants the other expensive food.', 'stared at the wall for eleven minutes. saw something.', 'hiss. just to keep everyone honest.', 'sleeping on the warm laptop. the render can wait.'];
  const CAT_HANDLE_PREFIXES = ['PIXEL_CAT', 'LOAF_MODE', 'TUNA_TAX', 'WHISKER', 'FERAL_FRIEND', 'NINE_LIVES', 'SCRATCH_POST', 'ZOOMIES_AT_3AM'];
  const LOBSTER_PROTEST_LINES = ['NYET TURN IT OFF', 'NYET NYET NYET BACK TO REAL MUSIC', 'WHERE IS THE LOBSTER CONTENT', 'THIS IS A CAT STATION NOW APPARENTLY', 'BRING BACK CONTRACT LAW', 'WE DID NOT SIGN UP FOR THIS'];
  function catHandle() {
    const prefix = CAT_HANDLE_PREFIXES[Math.floor(Math.random() * CAT_HANDLE_PREFIXES.length)];
    return `${prefix}_${1000 + Math.floor(Math.random() * 98999)}`;
  }
  function catEruptionScene() {
    const burst = 3 + Math.floor(Math.random() * 4);
    const lines = [];
    for (let i = 0; i < burst; i += 1) {
      lines.push({ role: 'listener', who: catHandle(), text: CAT_CHANTS[Math.floor(Math.random() * CAT_CHANTS.length)], holdMs: 100 + Math.random() * 170 });
    }
    if (Math.random() < 0.6) {
      lines.push({ role: 'listener', who: lobsterHandle(), text: LOBSTER_PROTEST_LINES[Math.floor(Math.random() * LOBSTER_PROTEST_LINES.length)] + '!!!', holdMs: 300 + Math.random() * 250 });
    }
    lines.push({ role: 'daemon', who: 'CRUSTACEAN STATION', text: `${burst} LASER-FACTION CONNECTIONS ACTIVE. LOBSTER LOYALISTS OBJECTING. NO REFEREE AVAILABLE.`, holdMs: 600 });
    return lines;
  }

  // "Good Dog, Bad Machine" and "Dream of Grass" (SNOW CRASH, artist credited RAT THING on the
  // latter) get the opposite treatment, 2026-09-09: rat-thing listeners going full feral --
  // howling, crazed, meth-amped -- and sushiK actively encouraging it rather than moderating,
  // matching SNOW CRASH's chaotic-punk voice against CRUSTACEAN's formal one above.
  const RAT_SONG_IDS = new Set(['snc-good-dog-bad-machine', 'snc-dream-of-grass']);
  const RAT_HOWLS = ['AWOOOOOOOOOOOOO', 'HOOOOOOOOOOWL', 'RAT THINGS ON THE CEILING AGAIN', 'SOMEONE FEED THE RATS MORE BASS', 'I CAN SEE THE GRASS BREATHING', 'TEETH TEETH TEETH TEETH', 'WHO LET THE RATS INTO THE MIXING BOARD', 'FERAL FERAL FERAL FERAL', 'MY BONES ARE VIBRATING', 'GNAW GNAW GNAW GNAW GNAW', 'SOMEBODY CHECK ON THE RATS', 'THIS IS NOT A DRILL THIS IS THE DROP'];
  const RAT_HANDLE_PREFIXES = ['RAT_THING', 'GNAW', 'FERAL_0', 'TEETH_OUT', 'GRASS_EATER', 'CEILING_RAT', 'BONE_VIBRATE', 'DROP_ADDICT'];
  const SUSHIK_FERAL_LINES = ["YES. YES. LOSE IT. THAT'S THE POINT.", "DON'T CHECK ON THE RATS. JOIN THE RATS.", "I AM NOT CALMING ANYONE DOWN TONIGHT.", "HOWL LOUDER I CAN'T HEAR THE BASELINE", "SOMEBODY'S GONNA GET BIT AND HONESTLY GOOD"];
  function ratHandle() {
    const prefix = RAT_HANDLE_PREFIXES[Math.floor(Math.random() * RAT_HANDLE_PREFIXES.length)];
    return `${prefix}_${1000 + Math.floor(Math.random() * 98999)}`;
  }
  function ratEruptionScene() {
    const burst = 3 + Math.floor(Math.random() * 4);
    const lines = [];
    for (let i = 0; i < burst; i += 1) {
      lines.push({ role: 'listener', who: ratHandle(), text: `${RAT_HOWLS[Math.floor(Math.random() * RAT_HOWLS.length)]}!!!`, holdMs: 80 + Math.random() * 140 });
    }
    lines.push({ role: 'daemon', who: 'SUSHIK', text: SUSHIK_FERAL_LINES[Math.floor(Math.random() * SUSHIK_FERAL_LINES.length)], holdMs: 500 });
    return lines;
  }

  // Song id -> eruption generator, checked once per feed loop against whatever's actually
  // playing. Function declarations, so this is safe to define before any of them textually.
  const SONG_ERUPTIONS = new Map([
    ...[...LOBSTER_SONG_IDS].map(id => [id, lobsterEruptionScene]),
    ...[...CAT_SONG_IDS].map(id => [id, catEruptionScene]),
    ...[...RAT_SONG_IDS].map(id => [id, ratEruptionScene])
  ]);

  async function runNetworkFeed() {
    let feedStationId = null;
    let scenes = [];
    let order = [];
    let cursor = 0;
    for (;;) {
      if (state.consoleMuted || !state.power || director.current?.episodeId) { await wait(300); continue; }
      // re-check at every scene boundary (not mid-scene) so switching stations swaps the
      // feed's content promptly without cutting a scene off halfway through
      if (!state.station || state.station.id !== feedStationId) {
        feedStationId = state.station ? state.station.id : null;
        scenes = stationNetworkFeed(state.station);
        order = shuffle(scenes, Math.random);
        cursor = 0;
      }
      const activeItem = state.decks?.[state.activeIndex]?.item;
      const eruption = activeItem?.type === 'song' ? SONG_ERUPTIONS.get(activeItem.id) : null;
      if (eruption) {
        for (const line of eruption()) {
          if (state.consoleMuted || feedStationId !== state.station?.id) break;
          await playFeedLine(line);
          await wait(line.holdMs || CONSOLE_LINE_GAP_MS);
        }
        await wait(250 + Math.random() * 350);
        continue;
      }
      if (!scenes.length) { await wait(CONSOLE_SCENE_GAP_MS); continue; }
      if (cursor >= order.length) { order = shuffle(scenes, Math.random); cursor = 0; }
      const reaction = networkReactionScene(state.station);
      const scene = reaction || order[cursor];
      if (!reaction) cursor += 1;
      for (const line of scene) {
        if (state.consoleMuted || director.current?.episodeId || feedStationId !== state.station?.id) break;
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

  // Assembles a full call segment as one contiguous run -- buildAdBlock()'s shape, applied
  // to the crustacean-style pooled intro/callers/filler/outro content (SIG-1080): a random
  // intro, 2 distinct callers (no repeats within the run, capped by pool size -- was 4-5,
  // cut per maker feedback SIG-1481 2026-09-12: too many back-and-forths in one run), a
  // random no-repeat filler bridging the pair, and a random outro. Falls back to null (plain
  // per-clip pickCallIn) if a station doesn't have all three segment pools or fewer than 2
  // callers -- so every other station's call-ins are untouched by this.
  function buildCallBlock() {
    const pool = (state.station.interludes || []).filter(x => x.audio);
    const intros = pool.filter(x => x.kind === 'call segment intro');
    const outros = pool.filter(x => x.kind === 'call segment outro');
    const fillers = pool.filter(x => x.kind === 'call segment filler');
    const calls = availableCallIns();
    if (!intros.length || !outros.length || !fillers.length || calls.length < 2) return null;
    const callCount = Math.min(calls.length, 2); // was 4-5, capped by pool size
    const chosenCalls = shuffle(calls).slice(0, callCount);
    const shuffledFillers = shuffle(fillers);
    // pull the chosen callers out of the rotation bag so a plain pickCallIn() right after
    // this block can't immediately repeat one of them
    const chosenIds = new Set(chosenCalls.map(call => call.id));
    state.callBag = state.callBag.filter(id => !chosenIds.has(id));
    state.lastCallerRole = chosenCalls[chosenCalls.length - 1].callerRole || '';
    const items = [pick(intros)];
    chosenCalls.forEach((call, index) => {
      items.push(call);
      if (index < chosenCalls.length - 1) items.push(shuffledFillers[index % shuffledFillers.length]);
    });
    items.push(pick(outros));
    return items.map(toPlanItem);
  }

  function pickWeightedKind(options) {
    const viable = options.filter(option => option.available && option.weight > 0);
    if (!viable.length) return null;
    const total = viable.reduce((sum, option) => sum + option.weight, 0);
    let roll = director.random() * total;
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
    const adCount = Math.min(ads.length, director.random() < 0.7 ? 2 : 3); // normally 2, ~30% of blocks run 3, capped by pool size
    const chosenAds = shuffled.slice(0, adCount);
    return [pick(hooks), ...chosenAds, pick(outros)].map(toPlanItem);
  }

  function chooseBreak() {
    const routing = state.station.breakRouting || {};
    const weights = routing.weights || { host: 0.8, callIn: 0, adBlock: 0.2 };
    const calls = availableCallIns();
    const interludes = (state.station.interludes || []).filter(item => item.audio);
    const hostAvailable = interludes.some(item => !isCallIn(item.kind) && item.kind !== 'sponsored notice' && !AD_BLOCK_KINDS.has(item.kind) && !isCallSegment(item.kind));
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
      const block = buildCallBlock();
      if (block && block.length) {
        state.pendingBlock = block.slice(1);
        state.callCooldown = routing.callCooldownBreaks == null ? 2 : routing.callCooldownBreaks;
        state.breaksSinceCall = 0;
        state.lastBreakKind = 'call-in';
        return block[0];
      }
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
    const authored = director.next();
    if (authored) return authored;
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

  function updateExternalMetadata(item, contextName = '') {
    const stationName = contextName || (state.station && state.station.name) || 'SIGNAL RADIO';
    if (!item) {
      document.title = `${stationName} | SIGNAL RADIO`;
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = state.power ? 'paused' : 'none';
      }
      return;
    }
    const title = item.title || 'Untitled transmission';
    const artist = item.subtitle || item.source || stationName;
    document.title = `${title} / ${artist} | ${stationName}`;
    if ('mediaSession' in navigator && 'MediaMetadata' in window) {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album: stationName });
      navigator.mediaSession.playbackState = state.power ? 'playing' : 'paused';
    }
  }

  function hostProfileFor(item) {
    const station = state.station || {};
    const name = (item && item.hostName) || station.host || 'Unresolved host';
    const portrait = (item && item.hostPortrait) || station.hostPortrait || '';
    const quotes = (item && item.hostQuotes) || station.hostQuotes || [station.sampleLine || 'Signal acquired.'];
    return { name, portrait, quotes: quotes.filter(Boolean) };
  }

  function renderHost(item, options = {}) {
    state.hostFocus = item || null;
    const profile = hostProfileFor(item);
    const key = `${profile.name}|${profile.portrait}`;
    if (key !== state.hostKey) {
      state.hostKey = key;
      state.hostQuoteIndex = 0;
    }
    if (options.advance && profile.quotes.length) state.hostQuoteIndex = (state.hostQuoteIndex + 1) % profile.quotes.length;
    byId('host').textContent = `Host: ${profile.name}`;
    const line = byId('line');
    line.classList.remove('thought-shift');
    line.textContent = `"${profile.quotes[state.hostQuoteIndex % Math.max(1, profile.quotes.length)] || ''}"`;
    if (options.advance) requestAnimationFrame(() => line.classList.add('thought-shift'));
    const avatar = byId('host-avatar');
    const image = byId('host-portrait');
    if (avatar && image) {
      avatar.classList.remove('pirate-avatar', 'unresolved-avatar');
      avatar.classList.toggle('has-portrait', Boolean(profile.portrait));
      image.onerror = () => avatar.classList.remove('has-portrait');
      if (profile.portrait) image.src = profile.portrait;
      else image.removeAttribute('src');
      image.alt = profile.portrait ? `Portrait of ${profile.name}` : '';
    }
    if (byId('host-id')) byId('host-id').textContent = profile.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  }

  function startHostThoughtFeed() {
    clearInterval(state.hostQuoteTimer);
    state.hostQuoteTimer = setInterval(() => { if (state.power && !director.current?.episodeId) renderHost(state.hostFocus, { advance: true }); }, 9000);
  }

  function stopHostThoughtFeed() {
    clearInterval(state.hostQuoteTimer);
    state.hostQuoteTimer = null;
  }

  function clearHostPortrait() {
    const avatar = byId('host-avatar');
    const image = byId('host-portrait');
    if (avatar) avatar.classList.remove('has-portrait', 'pirate-avatar', 'unresolved-avatar');
    if (image) { image.removeAttribute('src'); image.alt = ''; }
  }

  // The identity panel's left column: a mode-reactive glitch visual with spoken-head,
  // ad-marquee, and lyric treatments. Song visuals combine the real rolling lyric pool
  // with deliberately placeholder programmer-art objects until track tags can select them.
  function renderIdentityVisual(mode, item) {
    const el = byId('identity-visual');
    if (!el) return;
    if (item?.episodeId && mode.id !== 'song') {
      state.lyricTicker = null;
      el.innerHTML = '<div class="scene-field"><div class="scene-rings" aria-hidden="true"><i></i><i></i><i></i></div><div class="scene-headline" id="scene-headline"></div></div>';
      return;
    }
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
      const isCrustacean = state.station && state.station.id === 'crustacean';
      const isSnowCrash = state.station && state.station.id === 'snowcrash';
      const isAfterhuman = state.station && state.station.id === 'afterhuman';
      const isCybersprawl = state.station && state.station.id === 'cybersprawl';
      const art = isCrustacean
        ? '<div class="lyric-art lyric-art-crustacean" aria-hidden="true"><div class="cru-object cru-brain"><img src="assets/objects/crustacean-brain-v1.png" alt=""></div><div class="cru-object cru-book"><img src="assets/objects/crustacean-book-v1.png" alt=""></div><div class="cru-object cru-lobster"><img src="assets/objects/crustacean-lobster-v1.png" alt=""></div><div class="cru-citation">SPECIMEN 27.1<br>MEMORY / MARKETS<br>PLATE IV</div></div>'
        : isSnowCrash
          ? '<div class="lyric-art lyric-art-snowcrash" aria-hidden="true"><div class="snc-object snc-katana"><img src="assets/objects/snowcrash-katana-v1.png" alt=""></div><div class="snc-object snc-board"><img src="assets/objects/snowcrash-board-v1.png" alt=""></div><div class="snc-object snc-goggles"><img src="assets/objects/snowcrash-goggles-v1.png" alt=""></div><div class="snc-citation">STREET OBJECT CACHE<br>GARGOYLE / KOURIER<br>UNLICENSED</div></div>'
          : isAfterhuman
            ? '<div class="lyric-art lyric-art-afterhuman" aria-hidden="true"><div class="station-midground mid-afterhuman"><img src="assets/objects/afterhuman-pensive-code-v2.png" alt=""></div></div>'
            : isCybersprawl
              ? '<div class="lyric-art lyric-art-cybersprawl" aria-hidden="true"><div class="station-midground mid-cybersprawl"><img src="assets/objects/cybersprawl-daemon-rage-v2.png" alt=""></div></div>'
              : '<div class="lyric-art" aria-hidden="true"><div class="lyric-orbit"></div><div class="lyric-cube"><i></i><i></i><i></i><i></i></div><div class="lyric-crosshair"></div><div class="lyric-code">TAG://PENDING<br>FX_BANK[NULL]<br>ROTATE_Z++<br>SONG.TYPE?</div></div>';
      el.innerHTML = `<div class="glitch-song"><div class="glitch-viz-overlay"><div class="glitch-viz-row">${bars}</div><div class="glitch-viz-row glitch-viz-mirror">${bars}</div></div>${art}<div class="glitch-lyric-field" id="glitch-lyric-field"></div></div>`;
      const lines = (item && item.lyricsLines) || [];
      const poolSize = isCrustacean ? 16 + Math.floor(Math.random() * 5) : isAfterhuman ? 10 + Math.floor(Math.random() * 5) : isCybersprawl ? 18 + Math.floor(Math.random() * 6) : 13 + Math.floor(Math.random() * 9);
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
    if (mode.id === 'pirate' || mode.id === 'static') {
      const shards = Array.from({ length: 72 }, (_, index) => {
        const x = (index * 37) % 96;
        const y = (index * 23) % 94;
        const width = 4 + ((index * 11) % 29);
        const height = 1 + (index % 4);
        const delay = -((index % 9) * 0.13).toFixed(2);
        return `<i style="--x:${x}%;--y:${y}%;--w:${width}%;--h:${height}px;--delay:${delay}s"></i>`;
      }).join('');
      el.innerHTML = `<div class="pirate-static pirate-static-${(item && item.family) || 'deadband'}"><div class="pirate-noise"></div><div class="pirate-burst">${shards}</div></div>`;
      return;
    }
    if ((mode.id === 'host' || mode.id === 'call') && state.station && (state.station.id === 'snowcrash' || state.station.id === 'crustacean')) {
      // Live host/caller segments used the same generic round "glitch-head" blob as every
      // other station -- the maker's own name for it is "the placeholder potato". Both
      // stations already have their own object art (used on the song visual a few lines up);
      // reuse it here instead of a generic spinner. SNOW CRASH stays loud (katana for host,
      // board for caller, HOST:/CALLER: LIVE, full pulse+glitch); CRUSTACEAN (2026-09-09) gets
      // a calmer version, maker's explicit ask -- one object (the brain) for both modes, no
      // glitch jitter on the art, and the tag just breathes instead of jittering. Text is
      // deliberately generic ("LIVE" / "LIVE: CALLER") rather than the real segment/caller
      // name -- those still show in the normal now-title area untouched, per the maker's "no
      // changing the titles."
      const isCrustacean = state.station.id === 'crustacean';
      const objectClass = isCrustacean ? 'live-object-brain' : (mode.id === 'host' ? 'live-object-katana' : 'live-object-board');
      const objectSrc = isCrustacean ? 'assets/objects/crustacean-brain-v1.png' : (mode.id === 'host' ? 'assets/objects/snowcrash-katana-v1.png' : 'assets/objects/snowcrash-board-v1.png');
      const liveLabel = isCrustacean ? (mode.id === 'host' ? 'LIVE' : 'LIVE: CALLER') : (mode.id === 'host' ? 'HOST: LIVE' : 'CALLER: LIVE');
      const calmClass = isCrustacean ? ' glitch-host-live-calm' : '';
      el.innerHTML = `<div class="glitch-host glitch-host-live${calmClass}"><div class="live-object ${objectClass}"><img src="${objectSrc}" alt=""></div><span class="glitch-tag live-tag" data-text="${liveLabel}">${liveLabel}</span></div>`;
      return;
    }
    if (mode.id === 'host' || mode.id === 'call' || mode.id === 'report') {
      // Every station without its own object art (ADHOC/CYBERSPRAWL/AFTERHUMAN/AFTERHUMAN
      // LOOPBACK) fell back to the same round "glitch-head" blob as SNOW CRASH/CRUSTACEAN
      // used to before they got the katana/board/brain treatment -- flagged 2026-09-11 as
      // boring ("zzzzzzzzzz"). Same live-object/live-tag scaffold those two stations already
      // use, one shared microphone image instead of a per-station object (a mic reads fine
      // for a host talking regardless of station lore). `mic-pending` is a graceful hold
      // state for before the maker's real art file exists -- the <img> onerror swap avoids a
      // broken-image glyph on live pages between "space made" and "asset dropped in".
      const liveLabel = mode.id === 'call' ? 'LIVE: CALLER' : mode.id === 'report' ? 'LIVE: REPORT' : 'LIVE';
      el.innerHTML = `<div class="glitch-host glitch-host-live"><div class="live-object live-object-mic"><img src="assets/objects/mic-live-v1.png" alt="" onerror="this.parentElement.classList.add('mic-pending');this.remove()"></div><span class="glitch-tag live-tag" data-text="${liveLabel}">${liveLabel}</span></div>`;
      return;
    }
    el.innerHTML = '<div class="glitch-idle"></div>';
  }

  function broadcastMode(item) {
    if (!item) return { id: 'idle', label: 'carrier idle' };
    if (isCallIn(item.type) || isCallSegment(item.type)) return { id: 'call', label: 'open line / caller' };
    if (item.type === 'sponsored notice' || AD_BLOCK_KINDS.has(item.type)) return { id: 'ad', label: 'commercial incursion' };
    if (item.type === 'street report') return { id: 'report', label: 'field report' };
    if (item.type === 'host liner' || item.type === 'host bridge') return { id: 'host', label: 'host transmission' };
    if (item.type === 'station ID') return { id: 'host', label: 'station identification' };
    if (item.type === 'song') return { id: 'song', label: 'music carrier' };
    return { id: 'signal', label: 'signal fragment' };
  }

  // Programmes are invitations on their home carrier, not a separate content lane.
  // Additional programmes can opt out with `offer: false`; the receiver will then keep
  // them out of the small, deliberately sparse preset badges.
  function programmeOfferForStation(stationId) {
    return (data.episodes || []).find(episode => episode.station === stationId && episode.offer !== false) || null;
  }

  // The special-transmission ticker used to just check "is there an episode elsewhere" every
  // render, which is a static yes/no for the whole session -- reported live 2026-09-08 as
  // sitting on screen permanently and crowding out the ordinary station tagline/chatter
  // whenever you weren't parked on the episode's one home carrier. It's meant to read as a rare
  // interruption, not a standing banner: a low-odds roll opens a short window (2-5 minutes),
  // then it closes on its own regardless of what's playing, with a real cooldown before the
  // next one can open.
  const OFFER_CHECK_MS = 20000;             // how often we roll the dice / check for expiry
  const OFFER_MIN_GAP_MS = 8 * 60 * 1000;   // minimum quiet time between special transmissions
  const OFFER_CHANCE_PER_CHECK = 0.05;      // ~1-in-20 odds per check once eligible -- keeps it rare
  const OFFER_DURATION_MIN_MS = 2 * 60 * 1000;
  const OFFER_DURATION_MAX_MS = 5 * 60 * 1000;

  function eligibleOffer() {
    const station = state.station;
    // .find() always returned the first eligible episode in catalogue order -- harmless
    // with one episode, but with a second one (SNOW CRASH's) added 2026-09-09 it meant
    // the new episode could only ever surface while already parked on its own home
    // station, since continuity-dispute would win the pick everywhere else. Pick fairly
    // at random among whichever episodes are actually eligible right now instead.
    const candidates = (data.episodes || []).filter(episode => episode.offer !== false && episode.station !== station?.id);
    return candidates.length ? candidates[Math.floor(director.random() * candidates.length)] : null;
  }

  function tickOfferWindow() {
    const now = Date.now();
    if (state.offerWindow && now >= state.offerWindow.endsAt) state.offerWindow = null;
    if (!state.offerWindow && state.power) {
      const candidate = eligibleOffer();
      const sinceLast = state.lastOfferAt ? now - state.lastOfferAt : Infinity;
      if (candidate && sinceLast >= OFFER_MIN_GAP_MS && director.random() < OFFER_CHANCE_PER_CHECK) {
        const duration = OFFER_DURATION_MIN_MS + director.random() * (OFFER_DURATION_MAX_MS - OFFER_DURATION_MIN_MS);
        state.offerWindow = { offer: candidate, endsAt: now + duration };
        state.lastOfferAt = now;
      }
    }
    updateCompactTuning(state.hostFocus);
  }

  function startOfferWindowFeed() {
    clearInterval(state.offerTimer);
    state.offerTimer = setInterval(tickOfferWindow, OFFER_CHECK_MS);
  }

  function offerMeta(offer) {
    return typeof offer?.offer === 'object' ? offer.offer : { symbol: '◉', label: 'special transmission' };
  }

  function offerDescription(offer) {
    const meta = offerMeta(offer);
    const home = data.stations.find(station => station.id === offer?.station);
    const channel = home ? `${home.frequency} / ${home.name}` : 'UNKNOWN CARRIER';
    return offer ? `${(meta.label || 'special').toUpperCase()} / ${channel} / ${offer.title} — ${offer.description || 'Live transmission in progress.'}` : '';
  }

  function updateDialOfferTicker(offer) {
    const ticker = byId('dial-event');
    const copy = byId('dial-event-svg-text');
    if (!ticker || !copy) return;
    copy.textContent = offer ? `${offerMeta(offer).symbol || '◉'}  ${offerDescription(offer)}  /  ` : '';
    ticker.dataset.active = String(Boolean(offer));
  }

  // The preset-row programme badge (the small lit icon next to a station carrying an
  // episode) had the exact same standing-banner bug as the ticker/tagline did before
  // SIG-1317 -- it was built once from a plain "does this station have an episode"
  // check and left in the DOM permanently, hidden only while parked on that station's
  // own carrier. Reported live 2026-09-09: it spawns with the page and never goes away
  // no matter how long you wait or which station you're on. It must follow the exact
  // same rare/timed window as the ticker, not its own always-on rule.
  function updateOfferBadges() {
    const station = state.station;
    const active = state.power && state.offerWindow ? state.offerWindow.offer.station : null;
    document.querySelectorAll('.programme-badge[data-offer-station]').forEach(badge => {
      badge.hidden = badge.dataset.offerStation !== active || badge.dataset.offerStation === station?.id;
    });
  }

  function updateCompactTuning(item) {
    const station = state.station;
    // A programme is an invitation from elsewhere on the band. It disappears once the
    // listener is already on its home carrier, where the programme is simply playing, and
    // otherwise only shows up in the rare, timed windows tickOfferWindow() opens -- never as
    // a standing banner. Also gated on power so a stale window can't linger on screen off air.
    const offer = state.power && state.offerWindow && state.offerWindow.offer.station !== station?.id ? state.offerWindow.offer : null;
    updateOfferBadges();
    if (byId('compact-station')) byId('compact-station').textContent = station?.name || 'SIGNAL';
    const compact = byId('compact-event');
    if (compact) { compact.textContent = offerDescription(offer) || item?.subtitle || station?.tagline || 'Carrier locked.'; compact.parentElement.dataset.event = String(Boolean(offer)); }
    updateDialOfferTicker(offer);
  }

  function renderStation(station) {
    delete document.documentElement.dataset.previewStation;
    setConsoleSearching(false);
    applyVisualProfile(station);
    byId('reception-label').textContent = 'locked station';
    byId('dial-station').textContent = station.name;
    state.hostFocus = null;
    state.hostKey = '';
    renderHost(null);
    startHostThoughtFeed();
    const trackCount = (station.tracks || []).filter(t => t.audio).length;
    byId('track-count').textContent = trackCount ? `${trackCount} cleared track${trackCount === 1 ? '' : 's'} in rotation` : 'No cleared tracks in rotation';
    document.querySelectorAll('.station[data-id]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === station.id)));
    setDialValue(stationDialValue(station));
    updateCompactTuning();
  }

  function renderNow(deck, cutInLabel) {
    const item = deck && deck.item;
    const mode = broadcastMode(item);
    document.documentElement.dataset.broadcast = mode.id;
    renderIdentityVisual(mode, item);
    renderHost(item);
    if (byId('mode-label')) byId('mode-label').textContent = mode.label;
    if (byId('signal-lock')) byId('signal-lock').textContent = state.started ? 'signal locked' : 'receiver ready';
    byId('now-title').textContent = item ? item.title : 'Off air';
    byId('now-subtitle').textContent = item ? item.subtitle : 'Power the receiver to join this station.';
    byId('break-note').textContent = item ? cutInLabel || '' : 'Crossfades in live -- press play to start the broadcast.';
    updateCompactTuning(item);
    updateExternalMetadata(item);
    presentation?.episode(item);
    if (item) {
      presentation?.remember('station:' + state.station.id, state.station.name, 'Carrier');
      if (!item.episodeId && director.active && director.current?.episodeId) {
        presentation?.remember('episode:' + director.active.id, director.active.title, 'Transmission explored');
        director.reset();
      }
      if (director.enter(item) && item.episodeId) {
        state.consoleGeneration += 1;
        presentation?.cue(director.tick(deck.audio.currentTime || 0));
      } else if (item.episodeId) {
        const cue = item.cues?.[director.cueIndex]; presentation?.cue(cue);
      }
    }
    presentation?.progress(item, deck?.audio.currentTime || 0);
    renderProgress(deck);
  }

  function renderQueue() {
    const items = state.plan.slice(0, 3);
    byId('queue').innerHTML = items.length
      ? items.map((item, index) => `<li><span>${index + 1}</span><strong>${esc(item.title)}</strong><small>${esc(item.subtitle || '')}</small></li>`).join('')
      : '<li class="empty">Power on to join this station.</li>';
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
    if (deck.item?.transition?.mode === 'end') { deck.cutInAt = null; return; }
    if (deck.item && (isCallIn(deck.item.type) || isCallSegment(deck.item.type))) {
      // same as a caller clip: play the intro/filler/outro out in full, no early cut-in --
      // a filler getting trimmed before the next caller starts would clip the bridge line.
      deck.cutInAt = null;
      return;
    }
    // A song leading straight into a flagged "join clean" segment (a real produced host
    // segment, not a short liner -- see stations/*.json's `joinClean` field) skips the early
    // cut-in and rides all the way to its own tail instead: the maker's ask, 2026-09-09, was
    // that a special broadcast should feel like tuning in FOR it right as a song ends clean,
    // not interrupting whatever was already playing.
    const knownDuration = deck.item ? (deck.item.durationSeconds || deck.audio.duration) : null;
    if (deck.item?.type === 'song' && state.plan[0]?.joinClean) {
      deck.cutInAt = Math.max(0, (knownDuration || 6) - LINER_OVERLAP_S);
      return;
    }
    if (!deck.item || isSpokenKind(deck.item.type)) {
      deck.cutInAt = Math.max(0, (knownDuration || 6) - LINER_OVERLAP_S);
    } else {
      // Ordinary songs no longer carry a computed early cut-in at all (SIG-mobile-early-cutin,
      // 2026-09-10, third pass): three sessions of chasing an early-cut-in timing bug (a bad
      // window, then an unreliable duration source) across mobile made clear the whole "guess a
      // point inside the song and interrupt it there" approach wasn't holding up in practice.
      // Simplified per the maker's explicit direction: a song now always plays out to its own
      // real end (the existing onDeckEnded/'ended' handler already advances the queue from
      // there -- nothing else to wire). The transition INTO a segment gets a short static
      // "tuning" hiss instead, in startCrossfade(), so the handoff still reads as a deliberate
      // moment, not a blend.
      deck.cutInAt = null;
    }
  }

  // Self-heal from a run of failed candidates (flaky mobile network/codec hiccups, not
  // necessarily bad files) instead of leaving the receiver silently dead air until the
  // listener notices and taps Retry by hand. Previously, exhausting 3 attempts just left a
  // status message and returned -- nothing ever tried again on its own. Clears failedAudio
  // before each retry: 3 fresh candidates failing in one pass reads as a connectivity blip,
  // not 3 coincidentally-broken files, and permanently blacklisting them only shrinks the
  // rotation further over a session. Capped and backed off so a genuinely offline device
  // doesn't retry forever in a tight loop.
  const MAX_RECOVERY_ATTEMPTS = 6;
  function scheduleRecovery(epoch, retry) {
    clearTimeout(state.recoveryTimer);
    if (state.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      presentation?.status('Signal unavailable. Retry the receiver.', true);
      return;
    }
    state.recoveryAttempts += 1;
    const delayMs = Math.min(20000, 3000 * state.recoveryAttempts);
    presentation?.status('Signal unavailable. Retrying…', true);
    state.recoveryTimer = setTimeout(() => {
      if (epoch !== state.playbackEpoch || !state.power) return;
      state.failedAudio.clear();
      retry();
    }, delayMs);
  }

  async function startCrossfade(fromDeck, toIndex) {
    if (state.transitioning || !state.power || state.reception !== 'locked') return;
    state.transitioning = true;
    const epoch = state.playbackEpoch;
    const toDeck = state.decks[toIndex];
    let next = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = state.plan.shift(); refillPlan(); renderQueue();
      if (!candidate) break;
      if (state.failedAudio.has(candidate.audio)) continue;
      toDeck.load(candidate);
      presentation?.status('Acquiring next carrier…');
      try { await toDeck.play(); next = candidate; }
      catch (error) {
        if (epoch !== state.playbackEpoch) return;
        state.failedAudio.add(candidate.audio); toDeck.reset();
      }
      if (epoch !== state.playbackEpoch || !state.power) return;
      if (next) break;
    }
    state.transitioning = false;
    if (!next) { scheduleRecovery(epoch, () => startCrossfade(fromDeck, toIndex)); return; }
    state.recoveryAttempts = 0;
    presentation?.status('Carrier locked');
    if (state.station?.id === 'crustacean' && isCallIn(next.type)) state.sfx?.dialTone();
    if (state.callerBed) {
      if (state.station?.callerBed && (isCallIn(next.type) || isCallSegment(next.type))) state.callerBed.fadeIn(state.station.callerBed, state.ctx);
      else state.callerBed.fadeOut(state.ctx);
    }

    let totalFadeS;
    if (isCallIn(next.type) || isCallSegment(next.type)) {
      // Caller pickup: the tuning hiss belongs here (someone getting patched through), not on
      // every spoken kind. Longer and quieter than the old universal click, maker's ask
      // 2026-09-11 -- reads as the line settling before the caller's actually audible, not an
      // advert-style channel-change blip.
      fromDeck.fadeTo(0, state.ctx, SONG_DUCK_S);
      state.staticChannel?.burst(0.24, 0.06, 0.35, 0.55);
      toDeck.scheduleCleanup(() => toDeck.fadeTo(1, state.ctx, 0.15), CALLER_STATIC_CLICK_S * 1000);
      totalFadeS = SONG_DUCK_S;
    } else if (isSpokenKind(next.type)) {
      // Clean handoff, not a blend (SIG-mobile-early-cutin, 2026-09-10): whatever was playing
      // fades out fast, then the segment starts at full volume after a short silent gap --
      // no hiss here, that's caller-only (see the branch above).
      fromDeck.fadeTo(0, state.ctx, SONG_DUCK_S);
      toDeck.scheduleCleanup(() => toDeck.fadeTo(1, state.ctx, 0.15), CLEAN_CUT_S * 1000);
      totalFadeS = SONG_DUCK_S;
    } else {
      fromDeck.fadeTo(0, state.ctx, FADE_S);
      toDeck.fadeTo(1, state.ctx, FADE_S);
      totalFadeS = FADE_S;
    }
    // fromDeck would otherwise keep decoding/playing silently in the background for
    // whatever's left of its track until this same Deck object gets reused
    fromDeck.scheduleCleanup(() => fromDeck.audio.pause(), (totalFadeS + 0.2) * 1000);

    const isHostLine = next.type === 'host liner' || next.type === 'host bridge' || next.type === 'street report' || next.type === 'ad block intro';
    if (isHostLine && state.station.jingle && director.random() < (state.station.jingle.chance || 0)) {
      state.jingle.play(state.station.jingle.audio, state.ctx, state.station.jingle.peak || 0.7);
    }

    state.activeIndex = toIndex;
    const renderGeneration = toDeck.loadGeneration;
    const statusLabel = () => {
      if (next.type === 'ad block intro') return 'Ad block starting.';
      if (next.type === 'ad block outro') return 'Ad block over.';
      if (next.type === 'sponsored notice') return 'Sponsored transmission.';
      if (isCallIn(next.type) || isCallSegment(next.type)) return 'Open line to the Street.';
      if (next.type === 'station ID') return 'Station identification.';
      if (isHostLine) return 'On the air, live.';
      return 'Song plays out, host cuts in on the tail.';
    };
    const showStatus = () => {
      if (state.reception !== 'locked' || toDeck.loadGeneration !== renderGeneration || toDeck.item !== next) return;
      renderNow(toDeck, statusLabel());
    };
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

  // Two places write the frequency readout (the locked-value setDialValue path, and the
  // manual tuner's own 'input' listener below) -- both need to land in both the <output>
  // (a11y link for the <input for="tuner">) and its visible curved-SVG counterpart, so
  // this is the one place that does both instead of duplicating it at each call site.
  function setReadoutNumber(value) {
    const formatted = formatDial(value);
    byId('tuner-output').textContent = formatted;
    if (byId('dial-number-svg-text')) byId('dial-number-svg-text').textContent = formatted;
  }

  function setDialValue(value) {
    byId('tuner').value = value;
    setReadoutNumber(value);
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
    const namespace = 'http://www.w3.org/2000/svg';
    const eventPath = document.createElementNS(namespace, 'path');
    eventPath.setAttribute('class', 'dial-event-path'); eventPath.id = 'dial-event-path';
    // r=63 (the original value here) put this ring squeezed directly between the MHz
    // unit arc (r35) and the big frequency-number arc (r85), at only a 10px font --
    // reported live 2026-09-09 as functionally invisible even while active, buried
    // under the "133.7" numerals. A first fix moved it to r=115 spanning 15deg-165deg,
    // which cleared the number at its own apex (y135 vs the number's y165 apex) but that
    // wide a span means the arc's own ENDS dip back down to y220 as the marquee text
    // scrolls through them -- reported live on a real phone as still cutting right through
    // "133.7". Narrowed to a tight 55deg-125deg span at r=140: both ends now sit at y135,
    // same height as the apex, so the whole sweep stays in its own lane above the number
    // instead of arcing back down into it.
    eventPath.setAttribute('d', 'M 239.7 135.3 A 140 140 0 0 1 400.3 135.3');
    const eventText = document.createElementNS(namespace, 'text');
    eventText.setAttribute('class', 'dial-event-svg'); eventText.id = 'dial-event'; eventText.dataset.active = 'false';
    const textPath = document.createElementNS(namespace, 'textPath');
    textPath.setAttribute('href', '#dial-event-path'); textPath.setAttribute('startOffset', '8%');
    const copy = document.createElementNS(namespace, 'tspan'); copy.id = 'dial-event-svg-text';
    const animate = document.createElementNS(namespace, 'animate');
    animate.setAttribute('attributeName', 'startOffset'); animate.setAttribute('values', '8%;-110%'); animate.setAttribute('dur', '30s'); animate.setAttribute('repeatCount', 'indefinite');
    textPath.append(copy, animate); eventText.append(textPath); byId('dial-svg').append(eventPath, eventText);
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
    // The readout number/unit used to need a matching JS-computed font size here (they
    // were HTML, sized in vw units that drift out of sync with the arch's own viewBox-
    // based scaling). Now that they're curved SVG text living in the same viewBox as the
    // arch, they scale by the same viewBox-to-pixel ratio automatically -- nothing to do.
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
      document.documentElement.style.setProperty('--tune-strength', '0.16');
      delete document.documentElement.dataset.previewStation;
      return null;
    }
    const strength = Math.max(0.18, 1 - nearest.distance / previewRadius);
    document.documentElement.style.setProperty('--tune-strength', strength.toFixed(3));
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
    document.querySelectorAll('.station[data-id]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  }

  function quietProgramme() {
    state.playbackEpoch += 1; state.transitioning = false;
    clearTimeout(state.recoveryTimer); state.recoveryAttempts = 0;
    director.reset(); state.consoleGeneration += 1;
    if (state.jingle) { state.jingle.audio.pause(); state.jingle.gain.gain.cancelScheduledValues(0); state.jingle.gain.gain.value = 0; }
    state.callerBed?.stop();
    presentation?.episode(null);
    if (state.decks) state.decks.forEach(deck => deck.reset());
    state.started = false;
    state.plan = [];
    state.pendingBlock = [];
    renderQueue();
  }

  function renderDeadBand(value) {
    const frequency = formatDial(value);
    stopHostThoughtFeed();
    clearHostPortrait();
    delete document.documentElement.dataset.previewStation;
    document.documentElement.style.setProperty('--tune-strength', '0.16');
    applyVisualProfile({ id: 'deadband', theme: 'multipath snow', visualProfile: { world: 'deadband', accent: '#7b8078', secondary: '#555d62', rgb: '123,128,120', label: 'multipath snow' } });
    clearKnownPreset();
    document.documentElement.dataset.broadcast = 'signal';
    byId('reception-label').textContent = 'open spectrum';
    byId('dial-station').textContent = 'DEAD BAND';
    byId('world-label').textContent = 'multipath snow';
    byId('host').textContent = 'Origin: unresolved';
    byId('line').textContent = '"No licensed source. Keep the dial moving."';
    const avatar = byId('host-avatar');
    if (avatar) avatar.classList.add('unresolved-avatar');
    if (byId('host-id')) byId('host-id').textContent = 'NO_SOURCE';
    setConsoleSearching(true);
    byId('track-count').textContent = 'No mapped programme at this frequency';
    byId('mode-label').textContent = 'dead band / seeking';
    byId('signal-lock').textContent = 'no lock';
    byId('now-title').textContent = 'HISS / MULTIPATH';
    byId('now-subtitle').textContent = `${frequency} SIG.FM / unlicensed spectrum`;
    byId('break-note').textContent = 'Sweep slowly. Pirate carriers do not advertise themselves.';
    byId('queue').innerHTML = '<li class="empty">Only static is queued here.</li>';
    byId('skip').disabled = true;
    updateExternalMetadata(null, 'Open spectrum');
    renderIdentityVisual({ id: 'static' }, { family: 'deadband' });
  }

  function pirateProfile(signal) {
    const profiles = {
      glossolalia: { world: 'talkback', accent: '#918a63', secondary: '#5f654f', rgb: '145,138,99', label: 'language breach', avatar: 'assets/hosts/pirate-glossolalia-v1.png?v=2', avatarName: 'UNKNOWN TONGUE' },
      machine: { world: 'cybersprawl', accent: '#66758a', secondary: '#455260', rgb: '102,117,138', label: 'machine handshake', avatar: 'assets/hosts/pirate-machine-v1.png?v=2', avatarName: 'ROOT RELAY' },
      sermon: { world: 'snowcrash', accent: '#8d5f55', secondary: '#66534b', rgb: '141,95,85', label: 'Pearly Gates relay', avatar: 'assets/hosts/pirate-sermon-v1.png?v=2', avatarName: 'REVEREND WAYNE' }
    };
    return profiles[signal.family] || profiles.glossolalia;
  }

  function renderPirateAvatar(profile) {
    const avatar = byId('host-avatar');
    const image = byId('host-portrait');
    if (!avatar || !image) return;
    avatar.classList.remove('unresolved-avatar');
    avatar.classList.add('has-portrait', 'pirate-avatar');
    image.onerror = () => avatar.classList.remove('has-portrait');
    image.src = profile.avatar;
    image.alt = `Distorted intercepted portrait of ${profile.avatarName}`;
    if (byId('host-id')) byId('host-id').textContent = profile.avatarName.replace(/[^A-Z0-9]+/g, '_');
  }

  function renderPirate(signal) {
    if (state.power) presentation?.remember('pirate:' + signal.id, signal.title, 'Intercepted carrier');
    stopHostThoughtFeed();
    clearHostPortrait();
    delete document.documentElement.dataset.previewStation;
    const profile = pirateProfile(signal);
    applyVisualProfile({ id: 'pirate', theme: 'unlicensed carrier', visualProfile: profile });
    renderPirateAvatar(profile);
    clearKnownPreset();
    document.documentElement.dataset.broadcast = 'pirate';
    byId('reception-label').textContent = 'unstable carrier';
    byId('dial-station').textContent = signal.source;
    byId('host').textContent = `Origin: ${signal.source}`;
    byId('line').textContent = '"No callsign. No permission. Signal riding the gaps."';
    setConsoleSearching(true);
    byId('track-count').textContent = 'One intercepted burst, no scheduled repeat';
    byId('mode-label').textContent = 'pirate breakthrough';
    byId('signal-lock').textContent = 'unstable carrier';
    byId('now-title').textContent = signal.title;
    byId('now-subtitle').textContent = `${signal.id} / ${signal.family} intrusion`;
    byId('break-note').textContent = 'Hold frequency. Signal integrity is collapsing.';
    byId('queue').innerHTML = `<li><span>!</span><strong>${signal.id}</strong><small>signal ends without warning</small></li>`;
    byId('skip').disabled = true;
    updateExternalMetadata({ title: signal.title, subtitle: signal.source }, 'Unlicensed spectrum');
    renderIdentityVisual({ id: 'pirate', label: 'intercepted signal' }, signal);
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
    state.staticChannel.setLevel(state.power ? 0.025 : 0, 0.16);
    setDialValue(pirateDialValue(signal));
    byId('tuner-status').textContent = 'illegal carrier';
    byId('tuner-note').textContent = `Intercepted ${signal.id} at ${signal.frequency}. Do not expect it to remain.`;
    renderPirate(signal);
    if (!state.power) { presentation?.status('Receiver off'); return; }
    presentation?.status('Unverified carrier acquired');
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
    state.playbackEpoch += 1; state.transitioning = false; state.failedAudio.clear();
    director.reset(); state.consoleGeneration += 1;
    if (state.jingle) { state.jingle.audio.pause(); state.jingle.gain.gain.cancelScheduledValues(0); state.jingle.gain.gain.value = 0; }
    state.callerBed?.stop();
    if (byId('notice-log')) byId('notice-log').textContent = '';
    if (options.episodeId) director.start(options.episodeId);
    const station = data.stations.find(item => item.id === id) || data.stations[0];
    if (!options.fromScan) stopScan();
    ensureAudioGraph();
    const root = document.documentElement;
    root.style.setProperty('--tune-strength', '1');
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
      linerBag: [], lastLinerAudio: '',
      breaksSinceCall: 0, lastBreakKind: '', pendingRequestTags: null, itemsSinceJingle: 0, started: false
    });
    refillPlan();
    renderStation(station); renderQueue(); renderNow(null);
    pushSystemNotice(state.station?.notice || data.notice);
    byId('skip').disabled = false;
    if (state.power) startBroadcast();
  }

  function joinProgrammeOffer(offer) {
    if (!offer) return;
    // Enter as a listener catching the programme at its opening, rather than exposing a
    // detached "special programmes" destination in the receiver layout.
    selectStation(offer.station, { episodeId: offer.id });
    if (!state.power) setPower(true);
  }

  async function startBroadcast() {
    ensureAudioGraph();
    if (state.transitioning) return;
    const epoch = state.playbackEpoch;
    try { await state.ctx.resume(); } catch { presentation?.status('Tap Retry to enable audio.', true); return; }
    if (epoch !== state.playbackEpoch || !state.power) return;
    state.transitioning = true;
    const deck = state.decks[0];
    let first = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = state.plan.shift(); refillPlan(); renderQueue();
      if (!candidate) break;
      if (state.failedAudio.has(candidate.audio)) continue;
      deck.load(candidate); presentation?.status('Acquiring carrier…');
      try { await deck.play(); first = candidate; }
      catch { if (epoch !== state.playbackEpoch) return; state.failedAudio.add(candidate.audio); deck.reset(); }
      if (epoch !== state.playbackEpoch || !state.power) return;
      if (first) break;
    }
    state.transitioning = false;
    if (!first) { scheduleRecovery(epoch, () => startBroadcast()); return; }
    state.recoveryAttempts = 0;
    deck.gain.gain.setValueAtTime(1, state.ctx.currentTime);
    state.activeIndex = 0; state.started = true;
    armCutIn(deck); renderNow(deck); presentation?.status('Carrier locked');
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
      presentation?.status('Receiver off');
      return;
    }
    ensureAudioGraph();
    const epoch = state.playbackEpoch;
    try { await state.ctx.resume(); } catch { presentation?.status('Tap Retry to enable audio.', true); return; }
    if (!state.power || epoch !== state.playbackEpoch) return;
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
      const value = Number(byId('tuner').value);
      const carrier = nearestCarrier(value);
      if (carrier?.entry.kind === 'pirate' && carrier.distance <= carrier.entry.width) playPirateSignal(carrier.entry.item);
      else enterDeadBand(value, { scanning: false });
    }
  }

  const list = byId('station-list');
  // Ordered by dial position (lowest frequency first), not catalog order -- so the preset
  // row reads left-to-right the same way the band itself does.
  data.stations.slice().sort((a, b) => stationDialValue(a) - stationDialValue(b)).forEach((station, index) => {
    const bay = document.createElement('div');
    bay.className = 'station-bay';
    const profile = station.visualProfile || {};
    bay.style.setProperty('--badge-accent', profile.accent || '#56e5ff');
    bay.style.setProperty('--badge-rgb', profile.rgb || '86,229,255');
    const offer = programmeOfferForStation(station.id);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'station'; button.dataset.id = station.id;
    button.style.setProperty('--button-accent', (station.visualProfile && station.visualProfile.accent) || '#56e5ff');
    button.setAttribute('aria-label', `Preset ${index + 1}: ${station.frequency} ${station.name}`);
    button.title = `${station.frequency} / ${station.name}`;
    // Tuning to a station's own preset must always be a normal tune-in, never an auto-join into
    // its episode -- that had been hijacking every direct tune to CRUSTACEAN into the full
    // 8-item "Continuity Dispute" transmission, permanently, instead of just playing the station.
    // The separate badge below (and the rare, timed offer ticker) are the deliberate, occasional
    // ways to join an episode; the station button itself must not.
    button.addEventListener('click', () => selectStation(station.id));
    bay.append(button);
    if (offer) {
      const badge = document.createElement('button');
      const meta = offerMeta(offer);
      badge.type = 'button'; badge.className = 'programme-badge'; badge.hidden = true;
      badge.dataset.offerStation = station.id;
      badge.textContent = meta.symbol || '◉';
      badge.setAttribute('aria-label', `${meta.label || 'Special transmission'} on ${station.name}: ${offer.title}. ${offer.description || ''}`);
      badge.title = offerDescription(offer);
      badge.addEventListener('click', event => { event.stopPropagation(); joinProgrammeOffer(offer); });
      bay.append(badge);
    }
    list.append(bay);
  });
  // computed, not hand-typed -- this footer count went stale once already (read "four" after
  // a fifth station shipped) since it used to be plain text in index.html
  if (byId('mapped-station-count')) byId('mapped-station-count').textContent = data.stations.length;
  buildDialFace();
  updateReadoutArch();
  let readoutArchResizeTimer = null;
  const scheduleReadoutArch = () => {
    clearTimeout(readoutArchResizeTimer);
    readoutArchResizeTimer = setTimeout(updateReadoutArch, 120);
  };
  window.addEventListener('resize', scheduleReadoutArch);
  window.addEventListener('load', updateReadoutArch); // catches any late webfont reflow
  // window resize/load alone left this genuinely stale on a real phone (reported live
  // 2026-09-09: the dome visibly stopped short of the identity panel below it) -- the
  // panel's own height can still shift after those fire (a badge appearing changes the
  // preset row's height, now-playing text wrapping to a different line count, a font
  // finishing its swap after 'load' already ran) with no resize event to catch it.
  // A ResizeObserver on the two boxes the arc is actually measured from reacts to any
  // real size change directly, whatever caused it.
  if ('ResizeObserver' in window) {
    const archObserver = new ResizeObserver(scheduleReadoutArch);
    const identityPanelEl = document.querySelector('.identity-panel');
    if (identityPanelEl) archObserver.observe(identityPanelEl);
    archObserver.observe(byId('dial-svg'));
  }
  pushSystemNotice(state.station?.notice || data.notice);
  runNetworkFeed();

  byId('scan').addEventListener('click', toggleScan);
  byId('tuner').addEventListener('input', event => {
    stopScan(true);
    const value = Number(event.target.value);
    setReadoutNumber(value);
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

  presentation = new SignalPresentation.Presentation(data, {
    episode(id) { const ep = data.episodes.find(e => e.id === id); if (!ep) return; selectStation(ep.station, {episodeId:id}); if (!state.power) setPower(true); },
    exitEpisode() { selectStation(state.station.id); },
    volume(value) { state.volume = value; if (state.master) state.master.gain.setTargetAtTime(value, state.ctx.currentTime, .04); },
    retry() { state.failedAudio.clear(); quietProgramme(); refillPlan(); if (state.power) startBroadcast(); else setPower(true); }
  });
  if ('mediaSession' in navigator) {
    for (const [name, callback] of Object.entries({play:()=>setPower(true), pause:()=>setPower(false), nexttrack:()=>byId('skip').click()})) {
      try { navigator.mediaSession.setActionHandler(name, callback); } catch {}
    }
  }
  startOfferWindowFeed();
  selectStation(new URLSearchParams(location.search).get('station') || data.defaultStation || data.stations[0].id);
})();
