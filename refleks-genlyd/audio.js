                                      
  
                                                                                
                                                                                 
                                                                             
  
                                                                                
                                                                                 
                                                                                
                                                                              
   
(function (root) {
  'use strict';
  var Core = root.RGCore;

  var LOOKAHEAD = 4.0;                                          
  var TICK_MS = 900;                                                            
  var STEP = 0.2;                                           
  var MASTER_HEADROOM = 0.78;
  var CONTEXT_CLOSE_DELAY_MS = 1200;
  var GESTURE_INTERVAL = 1 / 30;                                                                        
  var DRONE_PARTS = [
    { detuneScale: 0, gain: 0.82 },
    { detuneScale: 1, gain: 0.18 }
  ];                                                                                      

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
    this.closeTimer = null;
  }

                                                                               
                                                                               
                                                                        
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
    if (!this.ctx || this.ctx.state === 'closed') {
      var AC = root.AudioContext || root.webkitAudioContext;
                                                                             
                                                                            
                                                                             
      try { this.ctx = new AC({ latencyHint: 'playback' }); }
      catch (e) { this.ctx = new AC(); }
    }
    if (this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  };

                                                                              
                                                                            
                                                                            
                                                                        
  RGAudio.prototype._destroyContext = function () {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
    var old = this.ctx;
    this.ctx = null;
    this.graphConnected = false;
    this.masterInput = null;
    this.peakGuard = null;
    this.droneGain = null;
    this.droneOscs = [];
    this.droneEmphGains = [];
    this.voiceGain = null;
    this.voiceFilter = null;
    this.voiceOscs = [];
    this.voiceNotes = [];
    this.dronePanner = null;
    this.voicePanner = null;
    this.orbitLfo = null;
    this.reverbSend = null;
    if (!old || old.state === 'closed' || typeof old.close !== 'function') return Promise.resolve();
    return old.close().catch(function (e) {
      if (root.console && root.console.warn) root.console.warn('GENLYD could not close its audio context', e);
    });
  };

                                                                              

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
                                                                               
                                                                         
                                                                              
                                                                            
                                                                            
    this.droneEmphGains = [];
    freqs.forEach(function (f, i) {
      var emph = ctx.createGain();
      emph.gain.value = 1;
      emph.connect(filt);
      self.droneEmphGains.push(emph);

                                                                                
                                                                              
                                                                           
                                                                    
      DRONE_PARTS.forEach(function (part) {
        var o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        o.detune.value = detune * part.detuneScale;
        var g = ctx.createGain();
                                                                              
                                                                        
        g.gain.value = Core.droneToneWeight(i) * part.gain;
        o.connect(g); g.connect(emph);
        o.start();
        self.droneOscs.push(o);
      });
    });

                                                                        
    var sum = 0;
    for (var i = 0; i < freqs.length; i++) sum += Core.droneToneWeight(i);
    filt.Q.value = 0.4;
    var norm = ctx.createGain();
    norm.gain.value = 1 / sum;
    filt.disconnect();
    filt.connect(norm);
    norm.connect(out);

    this.droneGain = out;
    return out;
  };

                                                                           
                                                                            
                                                                             
                                                                              
                                                                             
     
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

                                                                                 
                                                                
    var fade = this.session ? Core.fadeOutFactor(this.session, this.elapsed()) : 1;
    var g = Core.voiceGainFor(this.profile, magnitude, fade);
    var attack = Core.voiceAttack(this.profile);
    retarget(this.voiceGain.gain, g, now, attack / 3);

                                                                            
                                                                            
                                                                              
                                                                        
                                                                            
                                                                             
                                                                              
    var cut = 880 - Core.clamp01(magnitude) * 430;
    retarget(this.voiceFilter.frequency, cut, now, 0.3);

                                                                          
                                                                             
                                                                            
                                                                            
                                                                          
                                                                            
                                               
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

                                                                            
                                                  
    if (this.voicePanner) {
      filt.connect(this.voicePanner);
    } else {
      filt.connect(this.masterInput || ctx.destination);
    }
  };

                                                                           
                                                                           
                                                                             
                                                                        
     
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

                                                                              
                                                                           
                                                                            
                                                                         
                                                                              
                                                                         
                                                 
    
                                                                             
                                                                     
     
  RGAudio.prototype._buildOrbit = function () {
    var ctx = this.ctx;
    if (!ctx.createStereoPanner) { this.dronePanner = null; this.voicePanner = null; return; }

    this.dronePanner = ctx.createStereoPanner();
    this.voicePanner = ctx.createStereoPanner();

    var o = this.profile.drone.orbit;
    if (!o || !o.width) return;                                            

    var period = Math.max(Core.SHELL.ORBIT_PERIOD_MIN, o.period || 40);
    var width = Math.min(Core.SHELL.ORBIT_WIDTH_MAX, Math.max(0, o.width));

    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1 / period;

    var droneDepth = ctx.createGain();
    droneDepth.gain.value = width;
    var voiceDepth = ctx.createGain();
    voiceDepth.gain.value = width * Core.SHELL.ORBIT_VOICE_RATIO;                           

    lfo.connect(droneDepth); droneDepth.connect(this.dronePanner.pan);
    lfo.connect(voiceDepth); voiceDepth.connect(this.voicePanner.pan);
    lfo.start();

    this.orbitLfo = lfo;
  };

                                                                              

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

                                                                                 
                                                                              
    var endAt = this.startTime + this.session.duration;
    if (ctx.currentTime >= endAt) this.stop();
  };

  RGAudio.prototype.startSession = function (session) {
    var self = this;
    return this._destroyContext().then(function () { return self.resume(); }).then(function () {
      self.session = session;
      self._buildMaster();
      self._buildDrone();
      self._buildVoice();
      self._buildOrbit();

      if (!self.graphConnected) {
        if (self.dronePanner) self.droneGain.connect(self.dronePanner);
        if (self.voicePanner) self.voiceGain.connect(self.voicePanner);
        var droneOut = self.dronePanner || self.droneGain;
        var voiceOut = self.voicePanner || self.voiceGain;
        droneOut.connect(self.masterInput);
        voiceOut.connect(self.masterInput);
        self.graphConnected = true;
      }

      self.startTime = self.ctx.currentTime + 0.15;
      self.scheduledTo = self.startTime;
      self.lastGestureAt = -Infinity;
      self.droneGain.gain.cancelScheduledValues(0);
      self.droneGain.gain.setValueAtTime(0, self.ctx.currentTime);

      if (session.silent) {
                                                                                 
                                                       
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
      this.droneGain.gain.setTargetAtTime(0, t, 0.18);
      if (this.voiceGain) this.voiceGain.gain.setTargetAtTime(0, t, 0.18);
    }
    this.voiceOn = false;
    var cb = this.onended;
    this.session = null;
    var self = this;
    this.closeTimer = setTimeout(function () {
      if (!self.session) self._destroyContext();
    }, CONTEXT_CLOSE_DELAY_MS);
    if (cb) cb();
  };

  root.RGAudio = RGAudio;
})(typeof self !== 'undefined' ? self : this);
