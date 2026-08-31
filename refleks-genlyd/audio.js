/* REFLEKS x GENLYD - the audio layer.
 *
 * Two buses and nothing else: the drone (the wash you attend to) and the played
 * voice (optional, ignorable). All the numbers that matter come from core.js, so
 * this file decides how things sound, never how loud they are allowed to be.
 *
 * The wash is SCHEDULED AHEAD against the AudioContext clock rather than driven
 * from a timer callback. A backgrounded or hidden page throttles timers to about
 * one call a second, which would turn a breathing wash into a staircase. With a
 * four second lookahead the audio stays smooth even if the timer barely runs.
 */
(function (root) {
  'use strict';
  var Core = root.RGCore;

  var LOOKAHEAD = 4.0;   // seconds of wash scheduled in advance
  var TICK_MS = 900;     // scheduler wake-up; safe below the ~1s throttle floor
  var STEP = 0.2;        // resolution of the scheduled ramp
  var REVERB_SECONDS = 2.6; // shorter impulse keeps the phone path light without drying it out
  var REVERB_DECAY = 2.4;   // exponential falloff shape of the generated impulse
  var REVERB_WET = 0.26;    // send level; the dry signal (and its ceiling) is untouched
  var MASTER_HEADROOM = 0.78; // dry and wet share one guarded output instead of summing at the speaker
  var GESTURE_INTERVAL = 1 / 30; // sensor events may arrive at 60-120Hz; audio control does not need to

  function RGAudio(profile) {
    this.profile = profile;
    this.ctx = null;
    this.session = null;
    this.startTime = 0;
    this.scheduledTo = 0;
    this.timer = null;
    this.voiceOn = false;
    this.onended = null;
    this.lastGestureAt = -Infinity;
    this.graphConnected = false;
  }

  // Replace the previous automation target before adding the next one. Without
  // this, a phone can accumulate hundreds of setTarget events every second for
  // the whole session, even though only the latest orientation matters.
  function retarget(param, value, now, timeConstant) {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(now);
    } else if (typeof param.cancelScheduledValues === 'function') {
      param.cancelScheduledValues(now);
      if (typeof param.setValueAtTime === 'function') param.setValueAtTime(param.value, now);
    }
    param.setTargetAtTime(value, now, timeConstant);
  }

  RGAudio.prototype.resume = function () {
    if (!this.ctx) {
      var AC = root.AudioContext || root.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  };

  /* ---- the drone ------------------------------------------------------- */

  RGAudio.prototype._buildDrone = function () {
    var ctx = this.ctx, d = this.profile.drone;
    var out = ctx.createGain();
    out.gain.value = 0;

    var filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = (d.timbre && d.timbre.cutoff) || 620;
    filt.Q.value = 0.4;
    filt.connect(out);

    var detune = (d.timbre && d.timbre.detune) || 0;
    var freqs = Core.dronePitches(d);
    var self = this;
    this.droneOscs = [];
    // One emphasis gain per pitch, baseline 1 (transparent). GEN-0103: this is
    // the hook `gesture()` leans on to pull one of the drone's own tones
    // forward, so a tilt reaches into the chord instead of only ever adding a
    // separate voice over it. Sits between each pitch's own oscillator pair
    // and the shared filter, so it cannot touch the normalisation below it.
    this.droneEmphGains = [];
    freqs.forEach(function (f, i) {
      var emph = ctx.createGain();
      emph.gain.value = 1;
      emph.connect(filt);
      self.droneEmphGains.push(emph);

      // Two oscillators a few cents apart per pitch, so the wash has movement
      // in it without anything modulating on a timer.
      [-detune, detune].forEach(function (cents) {
        var o = ctx.createOscillator();
        // Sines keep the upper chord tones from bringing a nasal triangle
        // edge into the wash. The detuned pair still supplies slow movement.
        o.type = 'sine';
        o.frequency.value = f;
        o.detune.value = cents;
        var g = ctx.createGain();
        // Higher partials quieter, and normalised across the stack so the sum
        // cannot run past the intended peak when they drift into phase.
        g.gain.value = 1 / (i + 1);
        o.connect(g); g.connect(emph);
        o.start();
        self.droneOscs.push(o);
      });
    });

    // Normalise: divide the whole stack by the sum of its coefficients.
    var sum = 0;
    for (var i = 0; i < freqs.length; i++) sum += 1 / (i + 1);
    filt.Q.value = 0.4;
    var norm = ctx.createGain();
    norm.gain.value = 1 / (sum * 2);
    filt.disconnect();
    filt.connect(norm);
    norm.connect(out);

    this.droneGain = out;
    return out;
  };

  /* ---- the played voice ------------------------------------------------
   * A soft two-partial tone bank, one voice per allowed chord tone. Gesture
   * crossfades neighbouring notes instead of dragging one oscillator through
   * a long portamento. That keeps every intermediate state harmonic and makes
   * the player's direction and pauses audible without the old "woooo" whine.
   */
  var VOICE_PARTIALS = [
    { mult: 1, gain: 0.88 },
    { mult: 2, gain: 0.12 }
  ];

  RGAudio.prototype._buildVoice = function () {
    var ctx = this.ctx;
    var out = ctx.createGain();
    out.gain.value = 0;

    var filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 700;
    filt.Q.value = 0.7;
    filt.connect(out);

    var self = this;
    this.voiceOscs = [];
    this.voiceNotes = [];
    Core.voicePitches(this.profile).forEach(function (frequency) {
      var note = ctx.createGain();
      note.gain.value = 0;
      note.connect(filt);
      VOICE_PARTIALS.forEach(function (partial) {
        var o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = frequency * partial.mult;
        var g = ctx.createGain();
        g.gain.value = partial.gain;
        o.connect(g); g.connect(note);
        o.start();
        self.voiceOscs.push({ osc: o, frequency: frequency, mult: partial.mult });
      });
      self.voiceNotes.push(note);
    });

    this.voiceGain = out;
    this.voiceFilter = filt;
    return out;
  };

  // Called from the interaction layer with two 0..1 axes. Continuous: this
  // shapes an already-sounding voice, it never fires a note.
  RGAudio.prototype.gesture = function (pitchAxis, magnitude) {
    if (!this.ctx || !this.voiceGain || !this.voiceOn) return;
    var now = this.ctx.currentTime;
    if (now - this.lastGestureAt < GESTURE_INTERVAL) return;
    this.lastGestureAt = now;
    var v = this.profile.interaction.voice || {};

    var blend = Core.voiceBlendWeights(this.profile, pitchAxis);
    if (blend.length) {
      var flow = Math.max(0.12, (v.glide || 1.2) / 3);
      this.voiceNotes.forEach(function (note, i) {
        retarget(note.gain, blend[i], now, flow);
      });
    }

    // Level is ceilinged in core, not here. The session's own fade goes with it,
    // so a voice never outlives the wash it was sitting inside.
    var fade = this.session ? Core.fadeOutFactor(this.session, this.elapsed()) : 1;
    var g = Core.voiceGainFor(this.profile, magnitude, fade);
    var attack = Core.voiceAttack(this.profile);
    retarget(this.voiceGain.gain, g, now, attack / 3);

    // Timbre follows the same gesture: this is the "how you play shapes the
    // sound" half of GEN-0060, brightness rather than more notes. GEN-0102:
    // this used to run the other way, brighter as magnitude rose, which meant
    // the more present the voice got the harsher it got too - the exact
    // combination reported as "whiny" and doing nothing distinct on its own
    // axis. Inverted: more present now reads warmer and rounder, so presence
    // and brightness are no longer stacking toward shrill at the same moment.
    var cut = 880 - Core.clamp01(magnitude) * 430;
    retarget(this.voiceFilter.frequency, cut, now, 0.3);

    // GEN-0103: the gesture reaches into the drone's own mix too, pulling
    // whichever of its tones pitchAxis is nearest to forward and letting the
    // others recede - the same focus a listener hears the voice sitting on,
    // so the two read as one moving harmony rather than a voice laid over a
    // chord that never answers. Slower time constant than the voice's own
    // (0.6 vs ~0.3-0.7s attack): this is the whole wash's balance shifting,
    // weather rather than a note being struck.
    if (this.droneEmphGains) {
      var weights = Core.droneEmphasisWeights(this.profile.drone, pitchAxis, magnitude);
      this.droneEmphGains.forEach(function (g, i) {
        retarget(g.gain, weights[i], now, 0.6);
      });
    }
  };

  RGAudio.prototype.enableVoice = function (on) {
    this.voiceOn = !!on;
    if (!on && this.voiceGain && this.ctx) {
      var rel = (this.profile.interaction.voice || {}).release || 4;
      this.voiceGain.gain.setTargetAtTime(0, this.ctx.currentTime, rel / 3);
    }
  };

  /* ---- motion strike ---------------------------------------------------
   * A small temple-gong accent for a quick physical swing. The pitch comes
   * from the same playable chord as the continuous voice, lifted one octave so
   * its body survives a phone speaker; exact 1x, 1.5x and 2x sine partials keep
   * it consonant while shorter upper decays add metal without sustained whine.
   */
  RGAudio.prototype.strike = function (pitchAxis, strength) {
    if (!this.ctx || !this.session || !this.voiceOn) return;
    var ctx = this.ctx, now = ctx.currentTime;
    var fade = Core.fadeOutFactor(this.session, this.elapsed());
    var peak = Core.strikeGainFor(this.profile, strength, fade);
    var base = Core.pitchForGesture(this.profile, pitchAxis) * 2;
    if (!base || peak <= 0) return;

    var filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = Math.min(1800, base * 3.8);
    filt.Q.value = 0.55;

    [
      { mult: 1, gain: 0.60, decay: 3.2 },
      { mult: 1.5, gain: 0.28, decay: 1.5 },
      { mult: 2, gain: 0.12, decay: 0.65 }
    ].forEach(function (partial) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      var frequency = base * partial.mult;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency * 1.012, now);
      osc.frequency.exponentialRampToValueAtTime(frequency, now + 0.24);
      gain.gain.setValueAtTime(0.00001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.00002, peak * partial.gain), now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.00001, now + partial.decay);
      osc.connect(gain); gain.connect(filt);
      osc.start(now); osc.stop(now + partial.decay + 0.08);
    });

    // Share the played layer's counter-orbit and existing reverb send. With no
    // StereoPanner support, connect the same dry + wet pair explicitly.
    if (this.voicePanner) {
      filt.connect(this.voicePanner);
    } else {
      filt.connect(this.masterInput || ctx.destination);
      if (this.reverbSend) filt.connect(this.reverbSend);
    }
  };

  /* ---- guarded output --------------------------------------------------
   * Dry and reverberant signals used to meet independently at destination.
   * One headroom stage and a transparent peak guard now own their sum, which
   * protects a small phone speaker when several chord components align.
   */
  RGAudio.prototype._buildMaster = function () {
    var ctx = this.ctx;
    var input = ctx.createGain();
    input.gain.value = MASTER_HEADROOM;

    if (ctx.createDynamicsCompressor) {
      var guard = ctx.createDynamicsCompressor();
      guard.threshold.value = -8;
      guard.knee.value = 6;
      guard.ratio.value = 12;
      guard.attack.value = 0.003;
      guard.release.value = 0.18;
      input.connect(guard);
      guard.connect(ctx.destination);
      this.peakGuard = guard;
    } else {
      input.connect(ctx.destination);
    }
    this.masterInput = input;
    return input;
  };

  /* ---- orbit --------------------------------------------------------------
   * A StereoPannerNode per bus, both driven off one shared sine oscillator
   * (an audio-rate LFO, not a JS timer) so the drift is sample-accurate and
   * immune to the tab-throttling that motivated the wash's own lookahead
   * scheduling above. The oscillator's gain-scaled fan-out to two AudioParams
   * is the same trick Workspace Radio's headphone orbit uses (GEN-0087):
   * one LFO, two depths, no per-frame JS at all.
   *
   * Built once and left running; if a profile declares no `orbit` the depths
   * stay at their built-in zero and both panners simply sit centred.
   */
  RGAudio.prototype._buildOrbit = function () {
    var ctx = this.ctx;
    if (!ctx.createStereoPanner) { this.dronePanner = null; this.voicePanner = null; return; }

    this.dronePanner = ctx.createStereoPanner();
    this.voicePanner = ctx.createStereoPanner();

    var o = this.profile.drone.orbit;
    if (!o || !o.width) return; // panners stay wired, just never modulated

    var period = Math.max(Core.SHELL.ORBIT_PERIOD_MIN, o.period || 40);
    var width = Math.min(Core.SHELL.ORBIT_WIDTH_MAX, Math.max(0, o.width));

    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1 / period;

    var droneDepth = ctx.createGain();
    droneDepth.gain.value = width;
    var voiceDepth = ctx.createGain();
    voiceDepth.gain.value = width * Core.SHELL.ORBIT_VOICE_RATIO; // negative: opposite side

    lfo.connect(droneDepth); droneDepth.connect(this.dronePanner.pan);
    lfo.connect(voiceDepth); voiceDepth.connect(this.voicePanner.pan);
    lfo.start();

    this.orbitLfo = lfo;
  };

  /* ---- reverb -----------------------------------------------------------
   * A generated impulse response, not a loaded file: the app ships as five
   * static files and stays that way. This is a SEND, tapped from the same
   * post-fader gain nodes the dry signal already goes through, so it adds
   * space without touching either level ceiling guarantee2b asserts on.
   */
  RGAudio.prototype._buildReverb = function () {
    var ctx = this.ctx;
    var convolver = ctx.createConvolver();
    convolver.buffer = this._impulseResponse(REVERB_SECONDS, REVERB_DECAY);
    var wet = ctx.createGain();
    wet.gain.value = REVERB_WET;
    convolver.connect(wet);
    wet.connect(this.masterInput || ctx.destination);

    var send = ctx.createGain();
    send.gain.value = 1;
    send.connect(convolver);
    this.reverbSend = send;
    return send;
  };

  RGAudio.prototype._impulseResponse = function (duration, decay) {
    var ctx = this.ctx;
    var rate = ctx.sampleRate;
    var length = Math.max(1, Math.floor(rate * duration));
    var impulse = ctx.createBuffer(2, length, rate);
    for (var c = 0; c < impulse.numberOfChannels; c++) {
      var data = impulse.getChannelData(c);
      for (var i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  };

  /* ---- the wash scheduler ---------------------------------------------- */

  RGAudio.prototype._schedule = function () {
    if (!this.session || !this.droneGain) return;
    var ctx = this.ctx;
    var horizon = ctx.currentTime + LOOKAHEAD;
    var param = this.droneGain.gain;

    while (this.scheduledTo < horizon) {
      var at = this.scheduledTo;
      var elapsed = at - this.startTime;
      if (elapsed > this.session.duration) break;
      var g = Core.droneGainAt(this.profile.drone, elapsed, this.session);
      param.linearRampToValueAtTime(g, at);
      this.scheduledTo += STEP;
    }

    // It ends by itself. The end is scheduled on the audio clock, so a throttled
    // timer can delay noticing by a second but cannot make a session overrun.
    var endAt = this.startTime + this.session.duration;
    if (ctx.currentTime >= endAt) this.stop();
  };

  RGAudio.prototype.startSession = function (session) {
    var self = this;
    return this.resume().then(function () {
      self.session = session;
      if (!self.masterInput) self._buildMaster();
      if (!self.droneGain) self._buildDrone();
      if (!self.voiceGain) self._buildVoice();
      if (!self.reverbSend) self._buildReverb();
      if (!self.dronePanner) self._buildOrbit();

      if (!self.graphConnected) {
        if (self.dronePanner) self.droneGain.connect(self.dronePanner);
        if (self.voicePanner) self.voiceGain.connect(self.voicePanner);
        var droneOut = self.dronePanner || self.droneGain;
        var voiceOut = self.voicePanner || self.voiceGain;
        droneOut.connect(self.masterInput);
        voiceOut.connect(self.masterInput);
        droneOut.connect(self.reverbSend);
        voiceOut.connect(self.reverbSend);
        self.graphConnected = true;
      }

      self.startTime = self.ctx.currentTime + 0.15;
      self.scheduledTo = self.startTime;
      self.lastGestureAt = -Infinity;
      self.droneGain.gain.cancelScheduledValues(0);
      self.droneGain.gain.setValueAtTime(0, self.ctx.currentTime);

      if (session.silent) {
        // oliveros.08 asks for no sound at all. The session still runs and still
        // ends itself; the app is a timer in a pocket.
        self.droneGain.gain.setValueAtTime(0, self.startTime);
      } else {
        self._schedule();
      }
      self.timer = setInterval(function () {
        if (session.silent) {
          if (self.ctx.currentTime >= self.startTime + session.duration) self.stop();
        } else {
          self._schedule();
        }
      }, TICK_MS);
      return self;
    });
  };

  RGAudio.prototype.elapsed = function () {
    if (!this.ctx || !this.session) return 0;
    return Math.max(0, Math.min(this.session.duration, this.ctx.currentTime - this.startTime));
  };

  RGAudio.prototype.stop = function () {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.ctx && this.droneGain) {
      var t = this.ctx.currentTime;
      this.droneGain.gain.cancelScheduledValues(t);
      this.droneGain.gain.setTargetAtTime(0, t, 0.8);
      if (this.voiceGain) this.voiceGain.gain.setTargetAtTime(0, t, 0.8);
    }
    this.voiceOn = false;
    var cb = this.onended;
    this.session = null;
    if (cb) cb();
  };

  root.RGAudio = RGAudio;
})(typeof self !== 'undefined' ? self : this);
