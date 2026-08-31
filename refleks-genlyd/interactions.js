/* REFLEKS x GENLYD - the interaction vocabulary.
 *
 * The kinds a profile may select from. Adding one is a shell change, documented
 * in PROFILE-CONTRACT.md, and then available to every profile. A profile never
 * ships its own interaction code: that is what keeps "author two is a profile,
 * not a rewrite" true.
 *
 * Every kind exposes the same two calls, attach(audio, ui) and detach(), and
 * feeds the audio layer through audio.gesture(pitchAxis, magnitude) with two
 * continuous 0..1 axes. Nothing here decides how loud anything is.
 */
(function (root) {
  'use strict';

  var KINDS = {};

  /* ---- none -------------------------------------------------------------
   * No played layer. Exists because for some authors silence with a frame is
   * the honest answer, and because a profile must be able to say so rather than
   * setting the voice to zero and calling it design.
   */
  KINDS.none = {
    label: 'no played layer',
    needsPermission: false,
    attach: function () { return Promise.resolve({ active: false, note: null }); },
    detach: function () {}
  };

  /* ---- tilt -------------------------------------------------------------
   * Device motion shapes the voice. Chosen for Oliveros because it is playable
   * with your eyes closed: no screen to look at, no camera, no permission
   * prompt on Android, and no measurable battery cost across a long session.
   *
   * gamma (left/right roll) flows through the drone's chord in both directions.
   * beta (front/back pitch) opens presence relative to the player's starting hold.
   */
  var tiltState = null;

  KINDS.tilt = {
    label: 'tilt to play',
    needsPermission: true,

    attach: function (audio, ui) {
      var got = false;

      // A held phone is never still: an unfiltered reading turns ordinary hand
      // tremor into a constantly re-targeted pitch glide, which is a warble on
      // top of the tone rather than a played gesture. Smoothing here, at the
      // source, is the fix - smoothing only the audio side would just re-chase
      // a new noisy target every call. 0.18 settles a deliberate tilt quickly
      // enough to phrase with while still damping ordinary hand tremor.
      var SMOOTH = 0.18;
      var smoothGamma = null, smoothBeta = null;
      var neutralGamma = null, neutralBeta = null;

      function onOrient(e) {
        if (e.gamma === null && e.beta === null) return;
        got = true;
        var rawGamma = e.gamma || 0, rawBeta = e.beta || 0;
        if (neutralGamma === null) {
          neutralGamma = rawGamma;
          neutralBeta = rawBeta;
        }
        smoothGamma = smoothGamma === null ? rawGamma : smoothGamma + (rawGamma - smoothGamma) * SMOOTH;
        smoothBeta = smoothBeta === null ? rawBeta : smoothBeta + (rawBeta - smoothBeta) * SMOOTH;
        var gesture = root.RGCore.tiltGesture(smoothGamma, smoothBeta, neutralGamma, neutralBeta);
        audio.gesture(gesture.pitchAxis, gesture.magnitude);
      }

      // Desktop has no orientation sensor. Rather than silently doing nothing
      // during a build check, fall back to the pointer and SAY SO on screen.
      // This is a development affordance, not a second interaction kind.
      var smoothPX = null, smoothPY = null;
      function onPointer(e) {
        if (got) return;
        var w = root.innerWidth || 1, h = root.innerHeight || 1;
        var rawX = e.clientX / w, rawY = 1 - (e.clientY / h);
        smoothPX = smoothPX === null ? rawX : smoothPX + (rawX - smoothPX) * SMOOTH;
        smoothPY = smoothPY === null ? rawY : smoothPY + (rawY - smoothPY) * SMOOTH;
        audio.gesture(smoothPX, smoothPY);
      }

      root.addEventListener('deviceorientation', onOrient, true);
      root.addEventListener('pointermove', onPointer, true);
      tiltState = { onOrient: onOrient, onPointer: onPointer };

      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({
            active: true,
            note: got
              ? 'Your starting hold is the centre. Roll left and right through the chord; tip forward and back for presence.'
              : 'No motion sensor here, so left/right pointer position plays the chord and height shapes presence.'
          });
        }, 1200);
      });
    },

    detach: function () {
      if (!tiltState) return;
      root.removeEventListener('deviceorientation', tiltState.onOrient, true);
      root.removeEventListener('pointermove', tiltState.onPointer, true);
      tiltState = null;
    },

    // iOS 13+ gates motion behind an explicit gesture-triggered request. Called
    // from a tap, never on load, because a permission prompt that arrives
    // unasked in the middle of a meditation is exactly what the camera kind was
    // rejected for.
    requestPermission: function () {
      var DOE = root.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function') {
        return DOE.requestPermission().then(function (r) { return r === 'granted'; })
          .catch(function () { return false; });
      }
      return Promise.resolve(true);
    }
  };

  root.RGInteractions = KINDS;
})(typeof self !== 'undefined' ? self : this);
