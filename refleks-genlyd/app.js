/* REFLEKS x GENLYD - the shell.
 *
 * Author picker, session list, session runner, hand-off to paper. That is all
 * it does.
 *
 * GUARANTEE 1, structural: there is no localStorage, no sessionStorage, no
 * IndexedDB, no cookie and no network write anywhere in this file or its
 * siblings, and verify.js fails the build if any appear. The app therefore
 * cannot remember which sessions you have done. That is the point, and the cost
 * is accepted: no completion marks, no streaks, no history.
 */
(function (root, doc) {
  'use strict';
  var Core = root.RGCore, Kinds = root.RGInteractions;

  var state = { profile: null, audio: null, session: null, kind: null, tick: null };
  var el = function (id) { return doc.getElementById(id); };

  function screen(name) {
    ['pick', 'list', 'brief', 'run', 'done'].forEach(function (s) {
      el('s-' + s).hidden = (s !== name);
    });
  }

  function applySkin(skin) {
    if (!skin) return;
    var r = doc.documentElement.style;
    r.setProperty('--bg', skin.bg);
    r.setProperty('--ink', skin.ink);
    r.setProperty('--dim', skin.dim);
    r.setProperty('--accent', skin.accent);
    r.setProperty('--type', skin.type);
  }

  function mmss(sec) {
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ---- picker ---------------------------------------------------------- */

  function loadIndex() {
    return fetch('profiles/index.json').then(function (r) { return r.json(); });
  }

  function showPicker(index) {
    var wrap = el('authors');
    wrap.innerHTML = '';
    index.profiles.forEach(function (slug) {
      fetch('profiles/' + slug + '.json').then(function (r) { return r.json(); }).then(function (p) {
        var b = doc.createElement('button');
        b.className = 'author';
        b.innerHTML = '<span class="name"></span><span class="meta"></span><span class="blurb"></span>';
        b.querySelector('.name').textContent = p.author;
        b.querySelector('.meta').textContent = p.dates;
        b.querySelector('.blurb').textContent = p.blurb;
        b.onclick = function () { openProfile(p); };
        wrap.appendChild(b);
      });
    });
    screen('pick');
  }

  function openProfile(p) {
    var errs = Core.validateProfile(p);
    if (errs.length) {
      el('list-title').textContent = 'This profile does not load';
      el('sessions').innerHTML = '<p class="warn">' + errs.join('<br>') + '</p>';
      screen('list');
      return;
    }
    state.profile = p;
    applySkin(p.skin);
    el('list-title').textContent = p.reader.title;
    el('list-sub').textContent = p.author + ', ' + p.dates;
    el('adaptation').textContent = p.adaptationNote;

    var wrap = el('sessions');
    wrap.innerHTML = '';
    p.sessions.forEach(function (raw, i) {
      var s = Core.resolveSession(p, raw);
      var b = doc.createElement('button');
      b.className = 'session';
      b.innerHTML = '<span class="ord"></span><span class="stitle"></span><span class="len"></span>';
      b.querySelector('.ord').textContent = i + 1;
      b.querySelector('.stitle').textContent = s.title;
      b.querySelector('.len').textContent = Math.round(s.duration / 60) + ' min'
        + (s.silent ? ', no sound' : '') + (s.tilt ? ', playable' : '');
      b.onclick = function () { brief(s, i + 1); };
      wrap.appendChild(b);
    });
    screen('list');
  }

  /* ---- brief and run --------------------------------------------------- */

  function brief(s, ordinal) {
    state.session = s;
    el('b-ord').textContent = 'Session ' + ordinal;
    el('b-title').textContent = s.title;
    el('b-instruction').textContent = s.instruction;
    el('b-len').textContent = Math.round(s.duration / 60) + ' minutes. It ends by itself.';
    el('b-credit').textContent = s.credit;
    el('b-play').hidden = !s.tilt;
    el('b-play').classList.remove('on');
    state.wantsVoice = false;
    screen('brief');
  }

  el('b-play').onclick = function () {
    state.wantsVoice = !state.wantsVoice;
    this.classList.toggle('on', state.wantsVoice);
    this.textContent = state.wantsVoice ? 'playing is on, ignore it whenever' : 'let me play too';
  };

  el('b-start').onclick = function () {
    var p = state.profile, s = state.session;
    if (!state.audio) state.audio = new root.RGAudio(p);
    var audio = state.audio;

    var kindName = s.tilt && state.wantsVoice ? p.interaction.kind : 'none';
    state.kind = Kinds[kindName];

    var permission = (state.kind.needsPermission && state.kind.requestPermission)
      ? state.kind.requestPermission() : Promise.resolve(true);

    permission.then(function (ok) {
      return audio.startSession(s).then(function () {
        audio.enableVoice(ok && kindName !== 'none');
        if (ok && kindName !== 'none') {
          return state.kind.attach(audio, {}).then(function (r) {
            el('r-note').textContent = r && r.note ? r.note : '';
          });
        }
        el('r-note').textContent = ok ? '' : 'Motion was not permitted, so this one is just the sound.';
      });
    }).then(function () {
      el('r-title').textContent = s.title;
      el('r-instruction').textContent = s.instruction;
      screen('run');
      audio.onended = finish;
      state.tick = setInterval(paint, 500);
      paint();
    });
  };

  // The only thing on screen while a session runs is the instruction and a mark
  // that quietly fills. No numbers counting down: a clock is a thing to watch.
  function paint() {
    var a = state.audio, s = state.session;
    if (!a || !s) return;
    var t = a.elapsed();
    var frac = Math.min(1, t / s.duration);
    el('r-bar').style.transform = 'scaleX(' + frac.toFixed(4) + ')';
    if (frac >= 1) finish();
  }

  function finish() {
    if (state.tick) { clearInterval(state.tick); state.tick = null; }
    if (state.kind) state.kind.detach();
    if (state.audio && state.audio.session) state.audio.stop();
    var s = state.session, p = state.profile;
    el('d-title').textContent = s.title;
    el('d-after').textContent = s.after;
    el('d-page').textContent = p.reader.title;
    el('d-credit').textContent = s.credit;
    screen('done');
  }

  el('r-stop').onclick = finish;
  el('d-back').onclick = function () { openProfile(state.profile); };
  el('b-back').onclick = function () { openProfile(state.profile); };
  el('list-back').onclick = function () { loadIndex().then(showPicker); };

  loadIndex().then(showPicker).catch(function (e) {
    el('authors').innerHTML = '<p class="warn">Could not load profiles: ' + e.message + '</p>';
    screen('pick');
  });
})(window, document);
