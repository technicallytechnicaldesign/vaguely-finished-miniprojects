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
  var REVERB_SECONDS = 3.2; // decay tail length: a room, not a canyon
  var REVERB_DECAY = 2.4;   // exponential falloff shape of the generated impulse
  var REVERB_WET = 0.3;     // send level; the dry signal (and its ceiling) is untouched

  function RGAudio(profile) {
    this.profile = profile;
    this.ctx = null;
    this.session = null;
    this.startTime = 0;
    this.scheduledTo = 0;
    this.timer = null;
    this.voiceOn = false;
    this.onended = null;
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
    freqs.forEach(function (f, i) {
      // Two oscillators a few cents apart per pitch, so the wash has movement
      // in it without anything modulating on a timer.
      [-detune, detune].forEach(function (cents) {
        var o = ctx.createOscillator();
        o.type = i === 0 ? 'sine' : 'triangle';
        o.frequency.value = f;
        o.detune.value = cents;
        var g = ctx.createGain();
        // Higher partials quieter, and normalised across the stack so the sum
        // cannot run past the intended peak when they drift into phase.
        g.gain.value = 1 / (i + 1);
        o.connect(g); g.connect(filt);
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
   * A bowl: a few slightly inharmonic sine partials, slow in, long out. Its
   * pitch always comes from Core.pitchForGesture, so it is drawn from the
   * drone's own set and cannot be a wrong note.
   *
   * The detune on each partial has to stay small. A partial beats against its
   * true harmonic at (fundamental * multiplier * fractional-detune) Hz, and
   * anywhere in roughly 15-40Hz that beat stops reading as a slow shimmer and
   * starts reading as buzz. The original set's 4th partial (4.07, i.e. 1.75%
   * sharp) beat at ~31Hz against the highest playable fundamental (440Hz) -
   * an actual insect-wing rate, which is what "IS THAT A BEE" was hearing.
   * This set keeps every partial's worst-case beat under ~4Hz.
   */
  var BOWL_PARTIALS = [1, 2.004, 3.002, 3.997];

  RGAudio.prototype._buildVoice = function () {
    var ctx = this.ctx;
    var out = ctx.createGain();
    out.gain.value = 0;

    var filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 700;
    filt.Q.value = 0.7;
    filt.connect(out);

    var coeffSum = BOWL_PARTIALS.reduce(function (a, _, i) { return a + 1 / (i + 1); }, 0);
    var self = this;
    this.voiceOscs = [];
    BOWL_PARTIALS.forEach(function (mult, i) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = self.profile.drone.root * mult;
      var g = ctx.createGain();
      g.gain.value = (1 / (i + 1)) / coeffSum; // normalised, see the drone note
      o.connect(g); g.connect(filt);
      o.start();
      self.voiceOscs.push({ osc: o, mult: mult });
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
    var v = this.profile.interaction.voice || {};

    var target = Core.pitchForGesture(this.profile, pitchAxis);
    if (target) {
      var tc = Math.max(0.15, (v.glide || 1.2) / 3);
      this.voiceOscs.forEach(function (p) {
        p.osc.frequency.setTargetAtTime(target * p.mult, now, tc);
      });
    }

    // Level is ceilinged in core, not here. The session's own fade goes with it,
    // so a voice never outlives the wash it was sitting inside.
    var fade = this.session ? Core.fadeOutFactor(this.session, this.elapsed()) : 1;
    var g = Core.voiceGainFor(this.profile, magnitude, fade);
    var attack = Core.voiceAttack(this.profile);
    this.voiceGain.gain.setTargetAtTime(g, now, attack / 3);

    // Timbre follows the same gesture: this is the "how you play shapes the
    // sound" half of GEN-0060, brightness rather than more notes. Ceiling
    // lowered from 1820Hz: the old top end let the (now-fixed) upper partials
    // ring bright enough to read as shrill on top of the beating.
    var cut = 380 + Core.clamp01(magnitude) * 900;
    this.voiceFilter.frequency.setTargetAtTime(cut, now, 0.3);
  };

  RGAudio.prototype.enableVoice = function (on) {
    this.voiceOn = !!on;
    if (!on && this.voiceGain && this.ctx) {
      var rel = (this.profile.interaction.voice || {}).release || 4;
      this.voiceGain.gain.setTargetAtTime(0, this.ctx.currentTime, rel / 3);
    }
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
    wet.connect(ctx.destination);

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
      if (!self.droneGain) self._buildDrone();
      if (!self.voiceGain) self._buildVoice();
      if (!self.reverbSend) self._buildReverb();
      if (!self.dronePanner) self._buildOrbit();

      if (self.dronePanner) self.droneGain.connect(self.dronePanner);
      if (self.voicePanner) self.voiceGain.connect(self.voicePanner);
      var droneOut = self.dronePanner || self.droneGain;
      var voiceOut = self.voicePanner || self.voiceGain;
      droneOut.connect(self.ctx.destination);
      voiceOut.connect(self.ctx.destination);
      droneOut.connect(self.reverbSend);
      voiceOut.connect(self.reverbSend);

      self.startTime = self.ctx.currentTime + 0.15;
      self.scheduledTo = self.startTime;
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
