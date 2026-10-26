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
    "sector_best": [
        "{name} is purple in sector {sector}!",
        "Fastest sector {sector} of the race so far: {name}!",
        "{name} sets the best time in sector {sector}!",
        "Nobody has been quicker through sector {sector} than {name}!",
        "Purple sector {sector} for {name}!",
    ],
    "sector_personal": [
        "{name} improves in sector {sector}.",
        "A personal best for {name} in sector {sector}.",
        "{name} is quicker through sector {sector}.",
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
    "driver_assigned": [
        "{name} takes car {car}.",
        "{name} is at the wheel of car {car}.",
        "Car {car} goes to {name}.",
    ],
    "car_paired": [
        "{name} is ready on controller {controller}.",
        "Controller {controller} is paired with {name}.",
        "{name} answers on controller {controller}.",
    ],
    "idle": [
        "The track is quiet, ready for the next challenge?",
        "All quiet on the track, engines are waiting.",
        "Nobody on track, who wants a race?",
    ],
    # ---- event mode: false start (by action; with / without the car) and session end
    "false_start_warn": [
        "False start! {name} jumped the lights!",
        "{name} moved too early, that is a false start!",
        "Too eager, {name}! False start!",
    ],
    "false_start_anon": [
        "False start! Somebody jumped the lights!",
        "Too early! The start is aborted!",
        "A false start, everybody back on the line!",
    ],
    "false_start_penalty": [
        "False start by {name}: a {penalty} penalty!",
        "{name} jumped the lights and gets {penalty} added!",
        "Costly mistake for {name}: false start, {penalty} penalty!",
    ],
    "false_start_restart": [
        "False start by {name}! We go again!",
        "{name} jumped the lights, the start will be repeated!",
        "Too early, {name}! Back to the line, new start!",
    ],
    "false_start_restart_anon": [
        "False start! The start will be repeated!",
        "Too early! Back to the line, we go again!",
        "Start aborted, the lights come on again!",
    ],
    "session_finished": [
        "{session} is over: {winner} wins it!",
        "Chequered flag! {winner} wins, {second} is second!",
        "Session complete, the win goes to {winner}!",
        "That's it! {winner} takes the victory!",
    ],
    "practice_finished": [
        "{session} is over, {winner} tops the timesheet!",
        "End of practice: {winner} is on top!",
        "Practice complete, {winner} leads the way!",
    ],
    "qualifying_finished": [
        "Qualifying is over: pole position for {winner}!",
        "{winner} takes pole! {second} will start alongside!",
        "Pole position goes to {winner}!",
        "{session} is over, {winner} is on pole!",
    ],
    # ---- incidents: a car is off the track (a variant with {sector} needs the Check Lanes)
    "incident_started": [
        "{name} is off! A marshal is needed!",
        "Trouble for {name}, the car is stopped on the track!",
        "{name} has gone off, yellow flag!",
        "Careful! {name} is off in sector {sector}!",
        "Yellow flag in sector {sector}, {name} is off!",
    ],
    "incident_again": [
        "{name} is off again, that is incident number {count}!",
        "Again {name}! Incident number {count}!",
        "{name} goes off once more, that makes {count} incidents!",
        "Incident number {count} in sector {sector}: {name} is off again!",
    ],
    "incident_cleared": [
        "{name} is back on track!",
        "And {name} is racing again!",
        "{name} rejoins the race.",
        "Green light, {name} is back in action!",
    ],
    "pit_missed": [
        "{name} skipped the mandatory pit stop, a {penalty} penalty!",
        "No stop for {name}, that costs {penalty}!",
        "{name} did not make the required stops, {penalty} added.",
    ],
    "fuel_strategy": [
        "{name} will have to pit by lap {lap}, the fuel will not last.",
        "Strategy call for {name}: a stop is needed by lap {lap}.",
        "{name} cannot make it to the end without refuelling, box by lap {lap}.",
    ],
}

STATIC_FIELDS = frozenset(
    {"name", "winner", "second", "passed", "holder", "sector", "car", "session"}
)
