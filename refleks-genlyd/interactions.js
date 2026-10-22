                                                 
  
                                                                                
                                                                               
                                                                               
                       
  
                                                                             
                                                                             
                                                                   
   
(function (root) {
  'use strict';

  var KINDS = {};

                                                                            
                                                                             
                                                                                
                                                     
     
  KINDS.none = {
    label: 'no played layer',
    needsPermission: false,
    attach: function () { return Promise.resolve({ active: false, note: null }); },
    detach: function () {}
  };

                                                                            
                                                                               
                                                                          
                                                                             
    
                                                                                
                                                                                   
     
  var tiltState = null;

  KINDS.tilt = {
    label: 'tilt to play',
    needsPermission: true,

    attach: function (audio, ui) {
      var got = false;

                                                                               
                                                                               
                                                                             
                                                                               
                                                                              
                                                                        
      var SMOOTH = 0.18;
      var smoothGamma = null, smoothBeta = null;
      var neutralGamma = null, neutralBeta = null;
      var lastMotion = null, lastStrikeAt = -Infinity;

      function maybeStrike(gamma, beta, pitchAxis, at) {
        if (lastMotion) {
          var strength = root.RGCore.strikeStrength(
            gamma - lastMotion.gamma,
            beta - lastMotion.beta,
            at - lastMotion.at
          );
          if (strength > 0 && at - lastStrikeAt >= root.RGCore.SHELL.STRIKE_COOLDOWN_MS) {
            audio.strike(pitchAxis, strength);
            lastStrikeAt = at;
          }
        }
        lastMotion = { gamma: gamma, beta: beta, at: at };
      }

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
        maybeStrike(rawGamma, rawBeta, gesture.pitchAxis, e.timeStamp || Date.now());
        audio.gesture(gesture.pitchAxis, gesture.magnitude);
      }

                                                                              
                                                                             
                                                                         
      var smoothPX = null, smoothPY = null;
      function onPointer(e) {
        if (got) return;
        var w = root.innerWidth || 1, h = root.innerHeight || 1;
        var rawX = e.clientX / w, rawY = 1 - (e.clientY / h);
        smoothPX = smoothPX === null ? rawX : smoothPX + (rawX - smoothPX) * SMOOTH;
        smoothPY = smoothPY === null ? rawY : smoothPY + (rawY - smoothPY) * SMOOTH;
        maybeStrike(
          (rawX - 0.5) * root.RGCore.SHELL.TILT_ROLL_RANGE * 2,
          (rawY - 0.5) * root.RGCore.SHELL.TILT_BOW_RANGE * 2,
          smoothPX,
          e.timeStamp || Date.now()
        );
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
              ? 'Your starting hold is the centre. Roll through the chord, tip for presence, or make one quick striking motion for a quiet gong.'
              : 'No motion sensor here, so pointer position plays the chord; a quick pointer sweep tests the quiet gong.'
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
