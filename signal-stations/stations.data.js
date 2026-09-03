const hostTestTracks = ["001", "003", "004", "005", "006", "007", "008", "009", "010", "011", "012"].map(id => ({
  title: `Accelerando signal ${id}`,
  artist: "GENLYD / BOGLYD",
  audio: `audio/test-tracks/ACC-${id}_neon-syllabus.mp3`
}));
const hostTestLiners = Array.from({length: 50}, (_, index) => {
  const id = `AFH-${String(index + 1).padStart(3, "0")}`;
  return {kind: "Kite host liner", copy: `Test liner ${id}`, audio: `audio/host/${id}.wav`};
});

window.SIGNAL_STATIONS = {
  "notice": "HOST LOOPBACK is in test rotation: one short song, then a Kite liner.",
  "defaultStation": "afterhuman-loopback",
  "stations": [
    {
      "id": "cybersprawl",
      "name": "CYBERSPRAWL FM",
      "frequency": "94.9",
      "tagline": "Night transit for the wired city.",
      "host": "Mara Voss",
      "theme": "Cyberpunk / city futures",
      "sampleLine": "The elevated rail has cleared the storm wall. Keep your eyes on the skyline.",
      "tracks": [],
      "interludes": [
        {"kind": "station ID", "copy": "You are listening to CYBERSPRAWL FM.", "audio": null},
        {"kind": "caller update", "copy": "The night desk has no caller clip installed yet.", "audio": null},
        {"kind": "local notice", "copy": "Transit advisory awaiting a recorded voice.", "audio": null}
      ]
    },
    {
      "id": "afterhuman",
      "name": "AFTERHUMAN RADIO",
      "frequency": "101.3",
      "tagline": "Signals for bodies still becoming.",
      "host": "Kite",
      "theme": "Transhumanism / distributed selves",
      "sampleLine": "Your backup is not a replacement. It is a second window with the same weather.",
      "tracks": [
        {"title": "Accelerando: Neon Syllabus", "artist": "GENLYD / BOGLYD", "audio": "audio/accelerando-neon-syllabus-track.mp3"}
      ],
      "interludes": [
        {"kind": "station ID", "copy": "AFTERHUMAN RADIO. Signals for bodies still becoming.", "audio": null},
        {"kind": "host bridge", "copy": "Kite is preparing a bridge for this transmission.", "audio": null},
        {"kind": "caller update", "copy": "An incoming caller has not been rendered yet.", "audio": null},
        {"kind": "sponsored notice", "copy": "No sponsor clip is installed yet.", "audio": null}
      ]
    },
    {
      "id": "afterhuman-loopback",
      "name": "AFTERHUMAN LOOPBACK",
      "frequency": "00.1",
      "tagline": "A fast test transmission for Kite's new liners.",
      "host": "Kite / host test",
      "theme": "Transhumanism / host audio check",
      "sampleLine": "One short Accelerando signal, then a different host liner.",
      "runLength": {"min": 1, "max": 1},
      "tracks": hostTestTracks,
      "interludes": hostTestLiners
    }
  ]
};
