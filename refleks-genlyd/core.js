/* REFLEKS x GENLYD - the shell's pure core.
 *
 * Everything here is a plain function over plain data: no Web Audio, no DOM, no
 * clock of its own. That is deliberate. The two guarantees in PROFILE-CONTRACT.md
 * are enforced by these functions, so they have to be testable in Node without a
 * browser and without waiting for real time to pass.
 *
 * Loaded by index.html as a script tag and by verify.js / build-manifest.js via
 * require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RGCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- shell constants -------------------------------------------------
   * These belong to the shell, not to a profile. A profile chooses character;
   * it does not get to decide it may be louder than the drone or that its voice
   * may click. GEN-0060.
   */
  var SHELL = {
    DRONE_PEAK: 0.18,        // master-relative ceiling for the wash
    VOICE_CEILING_RATIO: 0.6, // the played voice's share of the drone's peak
    VOICE_ATTACK_FLOOR: 0.8,  // seconds; no bright transient is possible below this
    SWELL_PERIOD_MIN: 8,      // seconds; a "wash" faster than this is a tremolo
    SWELL_DEPTH_MAX: 0.85,    // never fully silent mid-session, that reads as a fault
    ORBIT_PERIOD_MIN: 20,     // seconds; a full pan sweep faster than this reads as a wobble, not a drift
    ORBIT_WIDTH_MAX: 0.85,    // never fully hard-panned - the wash stays present in a single earbud
    ORBIT_VOICE_RATIO: -0.6,  // the played voice answers from the opposite side, at this fraction of the drone's width
    DRONE_EMPHASIS_STRENGTH: 1.8, // how hard a gesture can lean the drone's own mix toward one of its tones
    DRONE_EMPHASIS_FLOOR: 0.25,   // a de-emphasised tone recedes, it never actually vanishes - still one chord
    TILT_ROLL_RANGE: 35,      // degrees either side of the held starting angle for the full pitch field
    TILT_BOW_RANGE: 26,       // degrees forward from the held starting angle to reach full presence
    TILT_REST_LEVEL: 0.28     // the voice is present but quiet at the held starting angle
  };

  // The voice ceiling is derived from the drone's QUIETEST moment, not its
  // loudest. A wash spends most of its time below its peak, so a ceiling set
  // against the peak lets the voice out-shout the drone at every trough, which
  // is "cannot compete" being true on paper and false in the ears. Caught by
  // the preflight before this was ever heard.
  function droneTrough(drone) {
    var depth = Math.min(SHELL.SWELL_DEPTH_MAX, Math.max(0, (drone && drone.swellDepth) || 0));
    return SHELL.DRONE_PEAK * (1 - depth);
  }

  function voicePeak(profile) {
    var drone = profile && profile.drone ? profile.drone : profile;
    return droneTrough(drone) * SHELL.VOICE_CEILING_RATIO;
  }

  /* ---- pitch ------------------------------------------------------------ */

  // Every frequency the drone may use, low to high.
  function dronePitches(drone) {
    return drone.ratios
      .map(function (r) { return drone.root * r; })
      .sort(function (a, b) { return a - b; });
  }

  // The played voice draws from the drone's own set, so no gesture can play a
  // wrong note. Guarantee 2, first constraint. `maxRatio` is optional and
  // symmetric with `minRatio`: a profile that finds its top note too bright
  // for how the voice is voiced can drop it without touching the drone's own
  // set, which the wash still uses in full.
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

  // Map a continuous 0..1 gesture axis onto the allowed set. Returns a frequency
  // that is always a member of voicePitches(). The glide between them is the
  // audio layer's job; the choice of target is here so it can be tested.
  function pitchForGesture(profile, x) {
    var set = voicePitches(profile);
    if (!set.length) return null;
    var t = clamp01(x);
    var i = Math.min(set.length - 1, Math.floor(t * set.length));
    return set[i];
  }

  // The played layer is a flow through the allowed chord tones, not one
  // oscillator gliding between them. At any position only two neighbouring
  // pitches can sound and their weights sum to one, so the output stays inside
  // the same level ceiling while a roll can linger between two consonant tones.
  function voiceBlendWeights(profile, x) {
    var set = voicePitches(profile);
    if (!set.length) return [];
    if (set.length === 1) return [1];
    var pos = clamp01(x) * (set.length - 1);
    var lo = Math.floor(pos);
    var hi = Math.min(set.length - 1, lo + 1);
    var mix = pos - lo;
    // Smoothstep softens the hand-off without creating a third sounding note.
    mix = mix * mix * (3 - 2 * mix);
    var out = set.map(function () { return 0; });
    out[lo] = 1 - mix;
    out[hi] += mix;
    return out;
  }

  // Device motion is interpreted relative to the angle in which the player
  // starts. Signed roll gives left and right different harmonic directions;
  // forward/back tilt opens and closes presence around a quiet resting level.
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

  /* ---- level ------------------------------------------------------------ */

  // The wash. Returns 0..1 of the drone's own peak at time t (seconds into the
  // session). A raised cosine so it breathes rather than throbs.
  function swellAt(drone, t) {
    var period = Math.max(SHELL.SWELL_PERIOD_MIN, drone.swellPeriod || 28);
    var depth = Math.min(SHELL.SWELL_DEPTH_MAX, Math.max(0, drone.swellDepth || 0.5));
    var phase = (t % period) / period;
    var wave = (1 - Math.cos(phase * 2 * Math.PI)) / 2; // 0..1, smooth at the seam
    return 1 - depth + depth * wave;
  }

  function droneGainAt(drone, t, session) {
    var g = SHELL.DRONE_PEAK * swellAt(drone, t);
    var f = fadeOutFactor(session, t);
    return g * f;
  }

  /* ---- orbit --------------------------------------------------------------
   * The wash's position in the stereo field, GEN-0100. A profile that declares
   * no `orbit` gets a wash that stays dead centre for the whole session, which
   * is still valid: motion is optional, not owed. Declared as a period and a
   * width for the same reason the swell is: "drifts slowly side to side"
   * reduces to a sine and two numbers.
   */
  function orbitPanAt(drone, t) {
    var o = drone && drone.orbit;
    if (!o || !o.width) return 0;
    var period = Math.max(SHELL.ORBIT_PERIOD_MIN, o.period || 40);
    var width = Math.min(SHELL.ORBIT_WIDTH_MAX, Math.max(0, o.width));
    var phase = (t % period) / period;
    return Math.sin(phase * 2 * Math.PI) * width;
  }

  // The played voice's position: it answers from the opposite side of the
  // drone at a shell-fixed fraction of its width (the spatial counterpart of
  // guarantee 2's level ceiling), so a moving wash and a held voice stay
  // apart in space instead of collapsing onto the same point.
  function voiceOrbitPanAt(drone, t) {
    return orbitPanAt(drone, t) * SHELL.ORBIT_VOICE_RATIO;
  }

  /* ---- drone emphasis (GEN-0103) -----------------------------------------
   * Until now a gesture only ever added a separate voice over an unchanging
   * chord - "a sound on top" rather than something that reaches into the
   * drone itself. This is the reach-in: a per-pitch gain multiplier for each
   * of the drone's own stacked tones, one array entry per member of
   * dronePitches() in the same order, so the audio layer can wire it
   * straight onto the oscillator gain it already built for that tone.
   *
   * `pitchAxis` places a continuous "focus" position across the drone's own
   * pitch set (not the voice's narrower one - the drone answers over its
   * full stack), and a triangular window around that position redistributes
   * energy toward whichever tone the focus currently sits nearest, while its
   * neighbours recede. `magnitude` is how far that redistribution is allowed
   * to lean: at rest (0) every multiplier is exactly 1, identical to the
   * chord's own untouched baseline mix, so a profile with no active gesture
   * (or the `none` interaction kind, which never calls this at all) hears
   * nothing different. The redistribution is a reallocation, not an
   * addition - weights average to 1 across the stack - so it happens
   * upstream of the drone bus's own normalised, ceilinged output and cannot
   * raise the wash past what droneGainAt already allows.
   */
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
    return tents.map(function (t) {
      return Math.max(SHELL.DRONE_EMPHASIS_FLOOR, 1 + pull * (t - avg));
    });
  }

  // Sessions may declare a fadeOut as a fraction of their length (oliveros.06
  // ends in silence on purpose). Returns 1 when there is no fade.
  function fadeOutFactor(session, t) {
    if (!session || !session.fadeOut) return 1;
    var dur = session.duration;
    var start = dur * (1 - session.fadeOut);
    if (t <= start) return 1;
    if (t >= dur) return 0;
    return 1 - (t - start) / (dur - start);
  }

  // The played voice's level for a gesture magnitude. Can never exceed the
  // voice ceiling, whatever a profile or a wild gesture asks for. Guarantee 2,
  // second constraint. `fade` carries the session's own fade-out, so a voice in
  // a session that ends in silence goes down with the drone rather than being
  // left playing over nothing.
  function voiceGainFor(profile, magnitude, fade) {
    var f = (fade === undefined) ? 1 : clamp01(fade);
    return voicePeak(profile) * clamp01(magnitude) * f;
  }

  // A profile's requested attack, floored. Guarantee 2, third constraint.
  function voiceAttack(profile) {
    var asked = (profile.interaction && profile.interaction.voice && profile.interaction.voice.attack) || 0;
    return Math.max(SHELL.VOICE_ATTACK_FLOOR, asked);
  }

  /* ---- session lifecycle ------------------------------------------------
   * The clock is injected. Nothing here calls Date.now(), so a test can run a
   * twenty minute session in a millisecond, and the hidden-preview timer
   * throttling that makes real-time testing useless never comes into it.
   */
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
      // It ends by itself. There is no path where a session runs past its
      // duration waiting for a person to stop it.
      isOver: function () { return startedAt !== null && this.elapsed() >= session.duration; },
      end: function () { if (endedAt === null) endedAt = clock(); return this; },
      started: function () { return startedAt !== null; }
    };
  }

  /* ---- profile validation ----------------------------------------------- */

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

  // Fill a session from the profile defaults so the rest of the code never has
  // to ask whether a field was inherited.
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
    voicePitches: voicePitches,
    pitchForGesture: pitchForGesture,
    voiceBlendWeights: voiceBlendWeights,
    tiltGesture: tiltGesture,
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
