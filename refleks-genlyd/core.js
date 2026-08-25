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
    SWELL_DEPTH_MAX: 0.85     // never fully silent mid-session, that reads as a fault
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
  // wrong note. Guarantee 2, first constraint.
  function voicePitches(profile) {
    var min = (profile.interaction && profile.interaction.voice && profile.interaction.voice.minRatio) || 1;
    var floor = profile.drone.root * min;
    return dronePitches(profile.drone).filter(function (f) { return f >= floor - 1e-9; });
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
    swellAt: swellAt,
    droneGainAt: droneGainAt,
    fadeOutFactor: fadeOutFactor,
    voiceGainFor: voiceGainFor,
    voiceAttack: voiceAttack,
    makeSession: makeSession,
    validateProfile: validateProfile,
    resolveSession: resolveSession,
    clamp01: clamp01
  };
});
