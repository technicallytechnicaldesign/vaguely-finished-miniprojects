window.SIGNAL_STATIONS = {
  "notice": "Broadcast queue ready. Host audio falls back to music-only play until clips are installed.",
  "defaultStation": "afterhuman",
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
    }
  ]
};
