"""English commentary templates: event key -> variants (same coverage as templates_it)."""

LANGUAGE_NAME = "English"

TEMPLATES: dict[str, list[str]] = {
    "race_started": [
        "Green light! The race is on!",
        "And they are off! Engines screaming!",
        "Lights out, here we go!",
        "Go go go! The battle begins!",
    ],
    "lap_completed": [
        "{name} completes the lap in {lap_time}.",
        "Lap {lap} for {name}, {lap_time}.",
        "{name} crosses the line: {lap_time}.",
        "Another lap for {name}, {lap_time}.",
    ],
    "leader_lap": [
        "{name} leads the race, lap {lap} in {lap_time}.",
        "{name} is out front, just did {lap_time}.",
        "{name} heads the pack with {lap} laps done.",
        "{name} holds the lead, {lap_time} on that lap.",
    ],
    "final_lap": [
        "Final lap! {name} is in front!",
        "Last lap, {name} leads the field!",
        "One lap to go, everything is decided now! {name} is ahead.",
    ],
    "best_lap_overall": [
        "Fastest lap of the race for {name}: {lap_time}!",
        "{name} sets the benchmark: {lap_time}!",
        "What a lap from {name}! {lap_time}, the best of the race!",
        "Nobody has been faster: {name} in {lap_time}!",
    ],
    "best_lap_personal": [
        "{name} improves the personal best: {lap_time}.",
        "A best lap for {name}, {lap_time}.",
        "Personal best for {name}: {lap_time}.",
    ],
    "track_record": [
        "New track record! {name} laps in {lap_time}, beating {holder}'s {previous_time}!",
        "Track record broken! {name} stops the clock at {lap_time}, {holder} had {previous_time}.",
        "History on this track: {name} sets a new track record, {lap_time}!",
        "A new track record for {name}: {lap_time}! Nobody has ever been faster here.",
        "{name} writes a new page in the record book with {lap_time}!",
    ],
    "position_change": [
        "{name} passes {passed} and moves up to {position}!",
        "Overtake! {name} gets past {passed}!",
        "{name} takes {position} place from {passed}!",
        "{name} gains a place, now in {position}!",
        "What a move! {name} climbs to {position}.",
    ],
    "pit_entry": [
        "{name} dives into the pits.",
        "Pit stop for {name}.",
        "{name} takes the pit lane.",
    ],
    "pit_exit": [
        "{name} rejoins from the pits.",
        "{name} is out of the pits and back on track!",
        "Refuelled, {name} is back with fuel at {fuel}.",
        "{name} is back in the race.",
    ],
    "low_fuel": [
        "Careful, {name} is almost out of fuel!",
        "{name} is running low on fuel, level {fuel}.",
        "{name} is on fumes, maybe time for a stop.",
    ],
    "race_finished": [
        "Chequered flag! {winner} wins!",
        "It's over! {winner} takes the win!",
        "A great win for {winner}, {second} comes second!",
        "Race complete, {winner} is the champion!",
    ],
    "idle": [
        "The track is quiet, ready for the next challenge?",
        "All quiet on the track, engines are waiting.",
        "Nobody on track, who wants a race?",
    ],
}

STATIC_FIELDS = frozenset({"name", "winner", "second", "passed", "holder"})
