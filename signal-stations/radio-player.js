(() => {
  const data = window.SIGNAL_STATIONS;
  const byId = id => document.getElementById(id);
  const audio = byId('audio');
  const state = { station: null, queue: [], lastTrack: '', songsSinceBreak: 0, breakAfter: 0, current: null };
  const pick = items => items[Math.floor(Math.random() * items.length)];
  const rollRunLength = () => {
    const range = state.station.runLength || {min: 2, max: 5};
    return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
  };

  function renderStation(station) {
    byId('frequency').textContent = station.frequency;
    byId('name').textContent = station.name;
    byId('tagline').textContent = station.tagline;
    byId('host').textContent = `Host: ${station.host}`;
    byId('line').textContent = `“${station.sampleLine}”`;
    byId('track-count').textContent = station.tracks.length ? `${station.tracks.length} cleared track${station.tracks.length === 1 ? '' : 's'} in rotation` : 'No cleared tracks in rotation';
    document.querySelectorAll('.station').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.id === station.id)));
  }

  function chooseTrack() {
    const tracks = state.station.tracks;
    const alternatives = tracks.filter(track => track.title !== state.lastTrack);
    const track = pick(alternatives.length ? alternatives : tracks);
    state.lastTrack = track.title;
    return { type: 'song', title: track.title, subtitle: track.artist, audio: track.audio };
  }

  function makeSong(fallback) {
    state.songsSinceBreak += 1;
    const song = chooseTrack();
    song.songNumber = state.songsSinceBreak;
    song.breakAfter = state.breakAfter;
    if (fallback) song.fallback = fallback;
    return song;
  }

  function makeNext() {
    if (!state.station.tracks.length) return null;
    if (!state.breakAfter) state.breakAfter = rollRunLength();
    if (state.songsSinceBreak >= state.breakAfter) {
      state.songsSinceBreak = 0;
      state.breakAfter = rollRunLength();
      const interlude = pick(state.station.interludes || []);
      if (interlude && interlude.audio) return { type: interlude.kind, title: interlude.kind, subtitle: interlude.copy, audio: interlude.audio };
      return makeSong(interlude);
    }
    return makeSong();
  }

  function fillQueue() {
    while (state.queue.length < 3) {
      const item = makeNext();
      if (!item) break;
      state.queue.push(item);
    }
  }

  function renderQueue() {
    const items = state.queue.slice(0, 3);
    byId('queue').innerHTML = items.length ? items.map((item, index) => `<li><span>${index + 1}</span><strong>${item.title}</strong><small>${item.subtitle}</small></li>`).join('') : '<li class="empty">Add a cleared track to this station to begin.</li>';
  }

  function renderNow(item) {
    byId('now-title').textContent = item ? item.title : 'Off air';
    byId('now-subtitle').textContent = item ? item.subtitle : 'Choose a station with cleared tracks.';
    const fallback = item && item.fallback;
    byId('break-note').textContent = fallback ? `Skipped ${fallback.kind}: no audio installed, continuing with music.` : item ? `Song run: ${item.songNumber} of ${item.breakAfter} before the next radio break.` : 'The next radio break lands after a random run of two to five songs.';
  }

  async function playNext() {
    fillQueue();
    const item = state.queue.shift();
    if (!item) { renderNow(null); renderQueue(); return; }
    state.current = item;
    renderNow(item);
    fillQueue();
    renderQueue();
    audio.src = item.audio;
    try { await audio.play(); byId('play').textContent = 'Pause broadcast'; }
    catch { byId('break-note').textContent = 'Press play to start audio in this browser.'; }
  }

  function selectStation(id) {
    const station = data.stations.find(item => item.id === id) || data.stations[0];
    audio.pause(); audio.removeAttribute('src'); audio.load();
    Object.assign(state, { station, queue: [], lastTrack: '', songsSinceBreak: 0, breakAfter: 0, current: null });
    renderStation(station); fillQueue(); renderQueue(); renderNow(null);
    byId('play').disabled = !station.tracks.length;
    byId('play').textContent = station.tracks.length ? 'Start broadcast' : 'No tracks loaded';
  }

  const list = byId('station-list');
  data.stations.forEach(station => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'station'; button.dataset.id = station.id;
    button.innerHTML = `<strong>${station.frequency} · ${station.name}</strong><span>${station.theme}</span>`;
    button.addEventListener('click', () => selectStation(station.id));
    list.append(button);
  });
  byId('notice').textContent = data.notice;
  byId('play').addEventListener('click', () => {
    if (!audio.paused) { audio.pause(); byId('play').textContent = 'Resume broadcast'; return; }
    if (state.current && audio.currentTime > 0) { audio.play(); byId('play').textContent = 'Pause broadcast'; return; }
    playNext();
  });
  byId('skip').addEventListener('click', playNext);
  audio.addEventListener('ended', playNext);
  byId('theme').addEventListener('click', () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
  });
  selectStation(data.defaultStation || data.stations[0].id);
})();
