                                            
  
                                                                                
                                                                                  
                                                                                 
                                                     
  
                                                                                
             
   
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RGCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

                                                                           
                                                                              
                                                                                
                         
     
  var SHELL = {
    DRONE_PEAK: 0.18,                                               
    VOICE_CEILING_RATIO: 0.6,                                                
    VOICE_ATTACK_FLOOR: 0.8,                                                        
    SWELL_PERIOD_MIN: 8,                                                        
    SWELL_DEPTH_MAX: 0.85,                                                            
    ORBIT_PERIOD_MIN: 20,                                                                                 
    ORBIT_WIDTH_MAX: 0.85,                                                                          
    ORBIT_VOICE_RATIO: -0.6,                                                                                           
    DRONE_EMPHASIS_STRENGTH: 1.8,                                                                           
    DRONE_EMPHASIS_FLOOR: 0.25,                                                                                
    TILT_ROLL_RANGE: 35,                                                                                
    TILT_BOW_RANGE: 26,                                                                             
    TILT_REST_LEVEL: 0.28,                                                                
    STRIKE_SPEED_MIN: 170,                                                          
    STRIKE_SPEED_MAX: 520,                                                                 
    STRIKE_COOLDOWN_MS: 650,                                                          
    STRIKE_CEILING_RATIO: 0.66                                                             
  };

                                                                           
                                                                             
                                                                               
                                                                             
                                              
  function droneTrough(drone) {
    var depth = Math.min(SHELL.SWELL_DEPTH_MAX, Math.max(0, (drone && drone.swellDepth) || 0));
    return SHELL.DRONE_PEAK * (1 - depth);
  }

  function voicePeak(profile) {
    var drone = profile && profile.drone ? profile.drone : profile;
    return droneTrough(drone) * SHELL.VOICE_CEILING_RATIO;
  }

                                                                               

                                                    
  function dronePitches(drone) {
    return drone.ratios
      .map(function (r) { return drone.root * r; })
      .sort(function (a, b) { return a - b; });
  }

                                                                           
                                                                              
                                                                       
  function droneToneWeight(index) {
    return 1 / (index + 1);
  }

                                                                              
                                                                          
                                                                            
                                                                             
                                            
  function voicePitches(profile) {
    var voice = (profile.interaction && profile.interaction.voice) || {};
    var min = voice.minRatio || 1;
    var max = voice.maxRatio || Infinity;
    var floor = profile.drone.root * min;
    var ceiling = profile.drone.root * max;
    return dronePitches(profile.drone).filter(function (f) {
      return f >= floor - 1e-9 && f <= ceiling + 1e-9;
    });
  }

                                                                                 
                                                                             
                                                                         
  function pitchForGesture(profile, x) {
    var set = voicePitches(profile);
    if (!set.length) return null;
    var t = clamp01(x);
    var i = Math.min(set.length - 1, Math.floor(t * set.length));
    return set[i];
  }

                                                                        
                                                                           
                                                                               
                                                                                
  function voiceBlendWeights(profile, x) {
    var set = voicePitches(profile);
    if (!set.length) return [];
    if (set.length === 1) return [1];
    var pos = clamp01(x) * (set.length - 1);
    var lo = Math.floor(pos);
    var hi = Math.min(set.length - 1, lo + 1);
    var mix = pos - lo;
                                                                              
    mix = mix * mix * (3 - 2 * mix);
    var out = set.map(function () { return 0; });
    out[lo] = 1 - mix;
    out[hi] += mix;
    return out;
  }

                                                                           
                                                                            
                                                                              
  function tiltGesture(gamma, beta, neutralGamma, neutralBeta) {
    var g = (typeof gamma === 'number' && !isNaN(gamma)) ? gamma : neutralGamma;
    var b = (typeof beta === 'number' && !isNaN(beta)) ? beta : neutralBeta;
    var ng = (typeof neutralGamma === 'number' && !isNaN(neutralGamma)) ? neutralGamma : 0;
    var nb = (typeof neutralBeta === 'number' && !isNaN(neutralBeta)) ? neutralBeta : 0;
    var roll = Math.max(-1, Math.min(1, (g - ng) / SHELL.TILT_ROLL_RANGE));
    var shapedRoll = roll * (0.72 + 0.28 * Math.abs(roll));
    return {
      pitchAxis: clamp01(0.5 + shapedRoll * 0.5),
      magnitude: clamp01(SHELL.TILT_REST_LEVEL + (b - nb) / SHELL.TILT_BOW_RANGE)
    };
  }

                                                                             
                                                                           
                                                                          
                                                                           
  function strikeStrength(deltaGamma, deltaBeta, dtMs) {
    if (typeof deltaGamma !== 'number' || isNaN(deltaGamma) ||
        typeof deltaBeta !== 'number' || isNaN(deltaBeta) ||
        typeof dtMs !== 'number' || isNaN(dtMs) || dtMs <= 0) return 0;
    var dt = Math.max(16, dtMs) / 1000;
    var speed = Math.sqrt(deltaGamma * deltaGamma + deltaBeta * deltaBeta) / dt;
    if (speed <= SHELL.STRIKE_SPEED_MIN) return 0;
    var span = SHELL.STRIKE_SPEED_MAX - SHELL.STRIKE_SPEED_MIN;
    return Math.pow(clamp01((speed - SHELL.STRIKE_SPEED_MIN) / span), 0.7);
  }

                                                                             
                                                                                
  function strikeGainFor(profile, strength, fade) {
    var f = (fade === undefined) ? 1 : clamp01(fade);
    return voicePeak(profile) * SHELL.STRIKE_CEILING_RATIO * clamp01(strength) * f;
  }

                                                                               

                                                                               
                                                                 
  function swellAt(drone, t) {
    var period = Math.max(SHELL.SWELL_PERIOD_MIN, drone.swellPeriod || 28);
    var depth = Math.min(SHELL.SWELL_DEPTH_MAX, Math.max(0, drone.swellDepth || 0.5));
    var phase = (t % period) / period;
    var wave = (1 - Math.cos(phase * 2 * Math.PI)) / 2;                            
    return 1 - depth + depth * wave;
  }

  function droneGainAt(drone, t, session) {
    var g = SHELL.DRONE_PEAK * swellAt(drone, t);
    var f = fadeOutFactor(session, t);
    return g * f;
  }

                                                                              
                                                                               
                                                                               
                                                                             
                                                                         
                                       
     
  function orbitPanAt(drone, t) {
    var o = drone && drone.orbit;
    if (!o || !o.width) return 0;
    var period = Math.max(SHELL.ORBIT_PERIOD_MIN, o.period || 40);
    var width = Math.min(SHELL.ORBIT_WIDTH_MAX, Math.max(0, o.width));
    var phase = (t % period) / period;
    return Math.sin(phase * 2 * Math.PI) * width;
  }

                                                                          
                                                                             
                                                                         
                                                              
  function voiceOrbitPanAt(drone, t) {
    return orbitPanAt(drone, t) * SHELL.ORBIT_VOICE_RATIO;
  }

                                                                             
                                                                            
                                                                         
                                                                             
                                                                    
                                                                     
                                                                      
    
                                                                            
                                                                         
                                                                            
                                                                             
                                                                             
                                                                         
                                                                            
                                                                          
                                                                              
                                                                               
                                                                             
     
  function droneEmphasisWeights(drone, pitchAxis, magnitude) {
    var n = dronePitches(drone).length;
    if (n <= 1) return [1];
    var focus = clamp01(pitchAxis) * (n - 1);
    var tents = [], sumTent = 0, i;
    for (i = 0; i < n; i++) {
      var t = Math.max(0, 1 - Math.abs(i - focus));
      tents.push(t);
      sumTent += t;
    }
    var avg = sumTent / n;
    var pull = clamp01(magnitude) * SHELL.DRONE_EMPHASIS_STRENGTH;
    var moved = tents.map(function (t) {
      return Math.max(SHELL.DRONE_EMPHASIS_FLOOR, 1 + pull * (t - avg));
    });
    if (pull === 0) return moved;

                                                                          
                                                                            
                                                                               
                                                                               
    var baseline = 0, focused = 0;
    moved.forEach(function (w, i) {
      var coefficient = droneToneWeight(i);
      baseline += coefficient;
      focused += coefficient * w;
    });
    var scale = focused > 0 ? baseline / focused : 1;
    return moved.map(function (w) { return w * scale; });
  }

                                                                              
                                                                  
  function fadeOutFactor(session, t) {
    if (!session || !session.fadeOut) return 1;
    var dur = session.duration;
    var start = dur * (1 - session.fadeOut);
    if (t <= start) return 1;
    if (t >= dur) return 0;
    return 1 - (t - start) / (dur - start);
  }

                                                                           
                                                                               
                                                                                
                                                                              
                               
  function voiceGainFor(profile, magnitude, fade) {
    var f = (fade === undefined) ? 1 : clamp01(fade);
    return voicePeak(profile) * clamp01(magnitude) * f;
  }

                                                                          
  function voiceAttack(profile) {
    var asked = (profile.interaction && profile.interaction.voice && profile.interaction.voice.attack) || 0;
    return Math.max(SHELL.VOICE_ATTACK_FLOOR, asked);
  }

                                                                            
                                                                              
                                                                         
                                                                         
     
  function makeSession(session, clock) {
    var startedAt = null;
    var endedAt = null;
    return {
      start: function () { startedAt = clock(); return this; },
      elapsed: function () {
        if (startedAt === null) return 0;
        var now = endedAt === null ? clock() : endedAt;
        return Math.min(session.duration, (now - startedAt) / 1000);
      },
      remaining: function () { return session.duration - this.elapsed(); },
                                                                          
                                                  
      isOver: function () { return startedAt !== null && this.elapsed() >= session.duration; },
      end: function () { if (endedAt === null) endedAt = clock(); return this; },
      started: function () { return startedAt !== null; }
    };
  }

                                                                               

  var INTERACTION_KINDS = ['tilt', 'none'];

  function validateProfile(profile) {
    var errs = [];
    if (!profile.slug) errs.push('profile has no slug');
    if (!profile.sessions || !profile.sessions.length) errs.push('profile declares no sessions');
    if (!profile.drone || !profile.drone.root || !profile.drone.ratios) errs.push('profile has no drone');

    var kind = profile.interaction && profile.interaction.kind;
    if (INTERACTION_KINDS.indexOf(kind) === -1) {
      errs.push('unknown interaction kind "' + kind + '"; the shell knows ' + INTERACTION_KINDS.join(', '));
    }

    var seen = {};
    (profile.sessions || []).forEach(function (s) {
      if (!s.id) errs.push('a session has no id');
      else if (seen[s.id]) errs.push('duplicate session id ' + s.id);
      seen[s.id] = true;
      if (!s.instruction) errs.push(s.id + ' has no instruction');
      if (!s.credit) errs.push(s.id + ' has no credit line');
      var d = s.duration || (profile.defaults && profile.defaults.duration);
      if (!d || d <= 0) errs.push(s.id + ' has no duration and the profile sets no default');
      if (s.tilt && kind === 'none') errs.push(s.id + ' asks for tilt but the profile\'s interaction kind is none');
    });

    if (profile.drone) {
      var period = profile.drone.swellPeriod;
      if (period && period < SHELL.SWELL_PERIOD_MIN) {
        errs.push('swellPeriod ' + period + 's is below the shell floor of ' + SHELL.SWELL_PERIOD_MIN + 's, that is a tremolo not a wash');
      }
      var orbit = profile.drone.orbit;
      if (orbit && orbit.width && orbit.period && orbit.period < SHELL.ORBIT_PERIOD_MIN) {
        errs.push('orbit period ' + orbit.period + 's is below the shell floor of ' + SHELL.ORBIT_PERIOD_MIN + 's, that reads as a wobble not a drift');
      }
    }
    return errs;
  }

                                                                               
                                          
  function resolveSession(profile, session) {
    var out = {};
    for (var k in session) if (Object.prototype.hasOwnProperty.call(session, k)) out[k] = session[k];
    if (!out.duration) out.duration = profile.defaults.duration;
    if (out.tilt === undefined) out.tilt = false;
    if (out.silent === undefined) out.silent = false;
    return out;
  }

  function clamp01(x) {
    if (typeof x !== 'number' || isNaN(x)) return 0;
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  return {
    SHELL: SHELL,
    INTERACTION_KINDS: INTERACTION_KINDS,
    droneTrough: droneTrough,
    voicePeak: voicePeak,
    dronePitches: dronePitches,
    droneToneWeight: droneToneWeight,
    voicePitches: voicePitches,
    pitchForGesture: pitchForGesture,
    voiceBlendWeights: voiceBlendWeights,
    tiltGesture: tiltGesture,
    strikeStrength: strikeStrength,
    strikeGainFor: strikeGainFor,
    swellAt: swellAt,
    droneGainAt: droneGainAt,
    orbitPanAt: orbitPanAt,
    voiceOrbitPanAt: voiceOrbitPanAt,
    droneEmphasisWeights: droneEmphasisWeights,
    fadeOutFactor: fadeOutFactor,
    voiceGainFor: voiceGainFor,
    voiceAttack: voiceAttack,
    makeSession: makeSession,
    validateProfile: validateProfile,
    resolveSession: resolveSession,
    clamp01: clamp01
  };
});
