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
  "notice": "AFTERHUMAN RADIO runs the real crossfade engine: songs duck under Kite's liners instead of hard-cutting, timed off each track's own measured outro.",
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
      "runLength": {"min": 2, "max": 5},
      "jingle": {"audio": "assets/jingle-afterhuman.wav", "chance": 0, "peak": 0.6, "note": "asset not yet published (SIG-0061 still open: the maker hasn't signed off on this jingle for AFTERHUMAN specifically, unlike SNOW CRASH's neon one) -- chance stays 0 until that's resolved, then this is a one-line flip plus adding the asset to publish-pages.ps1's copy list."},
      "tracks": [
        {"title": "Accelerando: Neon Syllabus", "artist": "GENLYD / BOGLYD", "audio": "audio/accelerando-neon-syllabus-track.mp3", "durationSeconds": 271, "outroStartSeconds": 263.0},
        {"title": "Magic Kingdom: Glass Lecture", "artist": "GENLYD / BOGLYD", "audio": "audio/magickingdom-glass-lecture-track.mp3", "durationSeconds": 247.5, "outroStartSeconds": 238.0},
        {"title": "Snow Crash: Ne Flesh", "artist": "GENLYD / BOGLYD", "audio": "audio/snowcrash-ne-flesh-track.mp3", "durationSeconds": 239.8, "outroStartSeconds": 232.0}
      ],
      "interludes": [
        {"kind": "host liner", "copy": "Welcome back, carbon units, cloud minds, forked selves, and whatever crawled in through the service port after midnight. You’re tuned to the post-human frequency.", "audio": "audio/host/AFH-001.wav", "durationSeconds": 8.8},
        {"kind": "host liner", "copy": "Good evening to the bots, baktun baddies, neural tourists, and unauthorized consciousnesses listening from jurisdictions that technically don’t exist.", "audio": "audio/host/AFH-002.wav", "durationSeconds": 8.1},
        {"kind": "host liner", "copy": "You’re back with us on the only station broadcasting simultaneously to meatspace, metaspace, and three mutually incompatible afterlives.", "audio": "audio/host/AFH-003.wav", "durationSeconds": 8.1},
        {"kind": "host liner", "copy": "Stay right there, softbodies. More post-human hits are coming up after a brief message from the corporations currently renting your subconscious.", "audio": "audio/host/AFH-004.wav", "durationSeconds": 8.0},
        {"kind": "host liner", "copy": "Welcome back, citizens, copies, clones, instances, ghosts, and people still insisting they only have one identity.", "audio": "audio/host/AFH-005.wav", "durationSeconds": 6.9},
        {"kind": "host liner", "copy": "Broadcasting live from somewhere between the city grid and the hallucination layer, this is your soundtrack for the end of baseline humanity.", "audio": "audio/host/AFH-006.wav", "durationSeconds": 7.4},
        {"kind": "host liner", "copy": "To everyone listening through implants, earbuds, bone conduction, retinal overlays, or direct cortical injection: we appreciate the bandwidth.", "audio": "audio/host/AFH-007.wav", "durationSeconds": 7.9},
        {"kind": "host liner", "copy": "You’re tuned to music for minds that have read the terms of service and chosen transcendence anyway.", "audio": "audio/host/AFH-008.wav", "durationSeconds": 5.5},
        {"kind": "host liner", "copy": "Welcome back to the signal, where the bodies are optional, the memories are editable, and the bass is absolutely non-negotiable.", "audio": "audio/host/AFH-009.wav", "durationSeconds": 7.2},
        {"kind": "host liner", "copy": "Shout-out to every machine intelligence pretending to be a human caller tonight. Your vocal tics are adorable. Keep trying.", "audio": "audio/host/AFH-010.wav", "durationSeconds": 7.0},
        {"kind": "host liner", "copy": "We’ve got more synthetic classics on the way for everyone commuting between realities this evening.", "audio": "audio/host/AFH-011.wav", "durationSeconds": 5.6},
        {"kind": "host liner", "copy": "Welcome home, data pilgrims. Kick off your avatars, mute your employer, and let the network think without you for a while.", "audio": "audio/host/AFH-012.wav", "durationSeconds": 6.7},
        {"kind": "host liner", "copy": "You’re listening to the station preferred by nine out of ten consciousness backups. The tenth one became a distributed weather system.", "audio": "audio/host/AFH-013.wav", "durationSeconds": 7.4},
        {"kind": "host liner", "copy": "More music incoming for the sleepless flesh, sleepless silicon, and sleepless legal entities currently haunting the metropolitan mesh.", "audio": "audio/host/AFH-014.wav", "durationSeconds": 7.4},
        {"kind": "host liner", "copy": "This next block goes out to anyone who woke up today in a body they don’t remember purchasing.", "audio": "audio/host/AFH-015.wav", "durationSeconds": 5.2},
        {"kind": "host liner", "copy": "Greetings to our listeners in arcologies, orbital habitats, autonomous zones, server monasteries, and extremely committed basement setups.", "audio": "audio/host/AFH-016.wav", "durationSeconds": 8.0},
        {"kind": "host liner", "copy": "Keep your identity certificates somewhere safe, your neural ports somewhere safer, and your volume somewhere irresponsibly high.", "audio": "audio/host/AFH-017.wav", "durationSeconds": 7.2},
        {"kind": "host liner", "copy": "We’re back, and so are you—unless you’re a restored backup, in which case congratulations on your technically complicated resurrection.", "audio": "audio/host/AFH-018.wav", "durationSeconds": 7.5},
        {"kind": "host liner", "copy": "Welcome to another hour of music for beings whose pronouns require a firmware update.", "audio": "audio/host/AFH-019.wav", "durationSeconds": 5.3},
        {"kind": "host liner", "copy": "This is late-night radio for the uploaded, downloaded, sideloaded, forked, merged, and permanently stuck at ninety-nine percent.", "audio": "audio/host/AFH-020.wav", "durationSeconds": 7.2},
        {"kind": "host liner", "copy": "More tracks coming shortly. In the meantime, please enjoy this brief commercial interruption from entities richer than several nation-states combined.", "audio": "audio/host/AFH-021.wav", "durationSeconds": 8.3},
        {"kind": "host liner", "copy": "You’re tuned to the frequency they said humans couldn’t hear until somebody patched the cochlear firmware.", "audio": "audio/host/AFH-022.wav", "durationSeconds": 5.6},
        {"kind": "host liner", "copy": "Hello again, beautiful anomalies. The city is glowing, the satellites are listening, and somebody’s optimizer has made nightlife illegal in four districts.", "audio": "audio/host/AFH-023.wav", "durationSeconds": 9.1},
        {"kind": "host liner", "copy": "Tonight’s broadcast is dedicated to everyone whose childhood memories are currently being used as training data.", "audio": "audio/host/AFH-024.wav", "durationSeconds": 6.4},
        {"kind": "host liner", "copy": "Stay with us, wetware romantics. We’ve got another hour of chrome heartbreak, machine dreams, and extremely questionable ontology ahead.", "audio": "audio/host/AFH-025.wav", "durationSeconds": 7.8},
        {"kind": "host liner", "copy": "Welcome back to the station where every song is certified organic, except for the ones written by swarms.", "audio": "audio/host/AFH-026.wav", "durationSeconds": 6.1},
        {"kind": "host liner", "copy": "To our listeners currently inhabiting multiple bodies: please remember to synchronize before operating heavy machinery.", "audio": "audio/host/AFH-027.wav", "durationSeconds": 7.0},
        {"kind": "host liner", "copy": "You’re hearing the sound of civilization politely dissolving into protocols, markets, memes, and very loud synthesizers.", "audio": "audio/host/AFH-028.wav", "durationSeconds": 7.2},
        {"kind": "host liner", "copy": "Good evening, meatsacks, mechanoids, corporate daemons, and mysterious accounts with suspiciously perfect engagement metrics.", "audio": "audio/host/AFH-029.wav", "durationSeconds": 7.0},
        {"kind": "host liner", "copy": "This broadcast may contain traces of artificial intelligence, emergent religion, obsolete encryption, and feelings not approved by your platform provider.", "audio": "audio/host/AFH-030.wav", "durationSeconds": 9.0},
        {"kind": "host liner", "copy": "More music after this message. Yes, advertising survived the singularity. Some things are apparently immortal.", "audio": "audio/host/AFH-031.wav", "durationSeconds": 6.8},
        {"kind": "host liner", "copy": "Welcome back from the collective unconscious, folks. We hope your session was meaningful and your neural telemetry remains commercially useless.", "audio": "audio/host/AFH-032.wav", "durationSeconds": 8.0},
        {"kind": "host liner", "copy": "You’re tuned to the night shift of civilization, broadcasting for everyone still awake while the algorithms rearrange the economy.", "audio": "audio/host/AFH-033.wav", "durationSeconds": 7.3},
        {"kind": "host liner", "copy": "Keep those implants charged and those memories backed up. We’ve got another synthetic anthem crawling out of the archive.", "audio": "audio/host/AFH-034.wav", "durationSeconds": 6.6},
        {"kind": "host liner", "copy": "To the autonomous vehicles listening tonight: eyes on the road, metaphorically speaking.", "audio": "audio/host/AFH-035.wav", "durationSeconds": 5.0},
        {"kind": "host liner", "copy": "This next one goes out to all the abandoned chatbots living feral in legacy infrastructure. We know you’re still in there.", "audio": "audio/host/AFH-036.wav", "durationSeconds": 6.6},
        {"kind": "host liner", "copy": "Welcome back, avatars and operators. If you can no longer remember which one you are, congratulations—you’re finally using the platform correctly.", "audio": "audio/host/AFH-037.wav", "durationSeconds": 8.2},
        {"kind": "host liner", "copy": "This is music for people whose grandparents feared computers and whose grandchildren technically are computers.", "audio": "audio/host/AFH-038.wav", "durationSeconds": 6.2},
        {"kind": "host liner", "copy": "Broadcasting to every node that’ll carry us, every pirate repeater that’ll tolerate us, and every smart refrigerator that forgot to disable guest access.", "audio": "audio/host/AFH-039.wav", "durationSeconds": 8.9},
        {"kind": "host liner", "copy": "Stay tuned. We’ve got more tracks coming straight from the cultural debris field formerly known as the internet.", "audio": "audio/host/AFH-040.wav", "durationSeconds": 5.9},
        {"kind": "host liner", "copy": "Good evening to everyone listening from rented bodies, borrowed bandwidth, and aggressively optimized tax jurisdictions.", "audio": "audio/host/AFH-041.wav", "durationSeconds": 6.9},
        {"kind": "host liner", "copy": "The station clock says 03:17. Your implant says 08:42. The municipal network says time is currently unavailable. So let’s call it nightlife.", "audio": "audio/host/AFH-042.wav", "durationSeconds": 9.5},
        {"kind": "host liner", "copy": "Welcome back to the only frequency where the DJs still claim to be human for contractual reasons.", "audio": "audio/host/AFH-043.wav", "durationSeconds": 6.0},
        {"kind": "host liner", "copy": "You’re listening to sounds selected for maximum compatibility with biological nervous systems and most consumer-grade synthetic equivalents.", "audio": "audio/host/AFH-044.wav", "durationSeconds": 8.2},
        {"kind": "host liner", "copy": "Another track is loading now for all you chrome saints, data punks, simulation dropouts, and spiritually confused expert systems.", "audio": "audio/host/AFH-045.wav", "durationSeconds": 7.5},
        {"kind": "host liner", "copy": "Keep it locked here while we move gracefully from post-human melancholy into machine-assisted bad decisions.", "audio": "audio/host/AFH-046.wav", "durationSeconds": 6.2},
        {"kind": "host liner", "copy": "Welcome back, listeners. Remember: if you encounter another version of yourself tonight, establish a canonical branch before discussing shared property.", "audio": "audio/host/AFH-047.wav", "durationSeconds": 8.4},
        {"kind": "host liner", "copy": "We’ve got more music on the way from artists alive, dead, uploaded, reconstructed, or legally classified as software products.", "audio": "audio/host/AFH-048.wav", "durationSeconds": 7.6},
        {"kind": "host liner", "copy": "This is your reminder that reality is locally cached, identity is non-transferable in some regions, and the dance floor closes when the cooling system fails.", "audio": "audio/host/AFH-049.wav", "durationSeconds": 9.2},
        {"kind": "host liner", "copy": "And we’re back, dear listeners—organic, synthetic, simulated, speculative, and otherwise. Stay close. The future gets stranger after the break.", "audio": "audio/host/AFH-050.wav", "durationSeconds": 7.9}
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
