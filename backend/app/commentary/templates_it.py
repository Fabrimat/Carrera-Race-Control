"""Italian commentary templates: event key -> variants.

Placeholders are filled by `events.py`; times and numbers arrive already spelled out.
A variant is only used when all of its placeholders are available.
"""

LANGUAGE_NAME = "Italian"

TEMPLATES: dict[str, list[str]] = {
    "race_started": [
        "Semaforo verde! La gara è partita!",
        "Si parte! Motori al massimo!",
        "Via! Si accende la battaglia in pista!",
        "Spenti i semafori, che spettacolo alla partenza!",
    ],
    "lap_completed": [
        "{name} chiude il giro in {lap_time}.",
        "Giro numero {lap} per {name}, tempo {lap_time}.",
        "{name} passa sul traguardo: {lap_time}.",
        "Ancora un giro per {name}, {lap_time}.",
    ],
    "leader_lap": [
        "{name} comanda la corsa, giro {lap} in {lap_time}.",
        "In testa c'è {name}, ha appena fatto {lap_time}.",
        "{name} guida il gruppo, {lap} giri completati.",
        "{name} non molla il comando, {lap_time} nell'ultimo giro.",
    ],
    "final_lap": [
        "Ultimo giro! {name} è in testa!",
        "Siamo all'ultimo giro, {name} davanti a tutti!",
        "Ultimo giro, tutto si decide adesso! {name} comanda.",
    ],
    "best_lap_overall": [
        "Giro più veloce della gara per {name}: {lap_time}!",
        "{name} firma il record: {lap_time}!",
        "Che giro di {name}! {lap_time}, miglior tempo assoluto!",
        "Nessuno è stato più veloce: {name} in {lap_time}!",
    ],
    "best_lap_personal": [
        "{name} migliora il suo record personale: {lap_time}.",
        "Il suo miglior giro per {name}, {lap_time}.",
        "Personale per {name}: {lap_time}.",
    ],
    "sector_best": [
        "{name} è viola nel settore {sector}!",
        "Miglior tempo nel settore {sector}: {name}!",
        "{name} firma il tempo migliore nel settore {sector}!",
        "Nessuno è stato più veloce di {name} nel settore {sector}!",
        "Settore {sector} viola per {name}!",
    ],
    "sector_personal": [
        "{name} migliora nel settore {sector}.",
        "Miglior parziale personale per {name} nel settore {sector}.",
        "{name} è più veloce nel settore {sector}.",
    ],
    "track_record": [
        "Nuovo record della pista! {name} in {lap_time}, battuto il {previous_time} di {holder}!",
        "Record della pista infranto! {name} segna {lap_time}, {holder} aveva {previous_time}.",
        "Storia su questa pista: {name} firma il nuovo record, {lap_time}!",
        "Nuovo record della pista per {name}: {lap_time}! Nessuno era mai stato così veloce qui.",
        "{name} scrive una nuova pagina nell'albo d'oro con {lap_time}!",
    ],
    "position_change": [
        "{name} supera {passed} e sale al {position} posto!",
        "Sorpasso! {name} passa {passed}!",
        "{name} si prende il {position} posto ai danni di {passed}!",
        "{name} guadagna una posizione, ora è {position}!",
        "Che manovra! {name} sale al {position} posto.",
    ],
    "pit_entry": [
        "{name} entra ai box.",
        "Sosta ai box per {name}.",
        "{name} imbocca la corsia dei box.",
    ],
    "pit_exit": [
        "{name} riparte dai box.",
        "{name} è fuori dai box, di nuovo in pista!",
        "Rifornimento completato, {name} riparte con carburante a {fuel}.",
        "{name} torna in gara.",
    ],
    "low_fuel": [
        "Attenzione, {name} è quasi a secco!",
        "{name} ha poco carburante, livello {fuel}.",
        "Serbatoio in riserva per {name}, forse è ora dei box.",
    ],
    "race_finished": [
        "Bandiera a scacchi! Vince {winner}!",
        "È finita! {winner} taglia il traguardo per primo!",
        "Grande vittoria di {winner}, secondo {second}!",
        "Gara conclusa, trionfa {winner}!",
    ],
    "driver_assigned": [
        "{name} prende la macchina {car}.",
        "{name} è al volante della macchina {car}.",
        "La macchina {car} va a {name}.",
    ],
    "idle": [
        "La pista è tranquilla, pronti per la prossima sfida?",
        "Tutto fermo in pista, i motori sono in attesa.",
        "Nessuno in pista, chi vuole sfidarsi?",
    ],
}

# Placeholders that never carry numbers: variants using only these may be cached as audio.
STATIC_FIELDS = frozenset({"name", "winner", "second", "passed", "holder", "sector", "car"})
