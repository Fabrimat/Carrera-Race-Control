# Roadmap

Ideas requested by the user for after the current work (sectors, track map, 16:9
control panel). Each item notes what the hardware and libraries can actually do, so
the scope is realistic before we start.

## 1. Webcam tracking

Goal: a camera looking down at the track gives real-time car positions, filling the gap
between the Control Unit's few sensors (start/finish line and up to two Check Lanes).

- **Setup wizard.** Calibrate the camera against the drawn layout: click 4+ known
  points (start line, corners) to compute a homography from image to map coordinates.
  Then a "car photo" phase: each car is placed on the track (or held in front of the
  camera) and photographed from a few angles. We extract its colour signature and a
  small appearance model, and link it to the controller address.
- **Tracking.** Background subtraction plus colour/appearance matching on each frame,
  projected through the homography onto the layout path (nearest `s`). It is fused with
  the CU's crossings, which remain the source of truth for timing and laps. The camera
  only refines `TrackPosition` (`confidence: "measured"` while the car is seen).
- **Where it runs.** In the browser (getUserMedia + canvas/WebGL, no upload) or in the
  backend with OpenCV. OpenCV would be a new dependency to approve. Browser-side keeps
  video on the machine. A local model is needed for real-time rates; per-frame cloud
  vision calls are too slow and costly.
- **Risks.** Lighting, similar-coloured cars, occlusion by hands, and frame rate on the
  user's PC. Start with a prototype measuring detection rate on the real track.

## 2. Car brand logos

- Upload a PNG/SVG/WebP logo per car (or per brand, reused across cars), stored by the
  backend in DATA_DIR with size/type validation. Shown in the leaderboard, on the map
  dots, in TV mode and in race history.
- Contract change: `CarConfig.logo` (asset id), plus upload/delete endpoints. No new
  dependency.

## 3. Advanced fuel management

What the hardware offers (carreralib 2.0, to verify on the user's CU):
- Fuel mode on/off and "real" fuel mode are `Status.mode` bits, set on the CU itself.
- `ControlUnit.setfuel(address, value)` writes a per-controller fuel value (0..15).
  Check on hardware whether this is the tank level or consumption, and how the CU's own
  fuel rate setting interacts with it.
- `Status.fuel` reports levels 0..15 per controller and `Status.pit` the pit state.

Possible features:
- Per-car tank size and consumption profiles, with presets: "endurance",
  "sprint", "realistic".
- Strategy view: laps remaining per car, predicted pit window, and a warning when a car
  can't finish without stopping.
- A rule: mandatory pit stops per race, with a penalty if missed.
- Refuel speed while in the pit, if the CU allows it.
- Commentary on strategy ("Fulmine stretches his stint, can he make it to the end?").
- A fuel graph over the race.

## 4. Car ↔ controller pairing

Carrera Digital cars are coded to a controller on the CU: press CODE on the CU, place
the car on the track and press the controller's lane-change button. carreralib can
press the CU buttons remotely (`ControlUnit.press(CODE_BUTTON_ID)`), and per-controller
`setspeed(address, 0..15)` and `setbrake(address, 0..15)` exist.

Possible features:
- A guided pairing wizard in the app: it presses CODE through the CU, shows
  step-by-step instructions with pictures, and detects the new car on its first
  crossing (or on the pit/lane signal) to confirm which address it got. It then links
  that address to the car's name, colour, logo and photo, which also feeds the webcam
  recognition setup.
- Per-car speed and brake settings from the app (handicaps for kids or guests, or
  levelling different cars), saved in profiles and re-applied at connect.
- A garage view: the list of the user's cars with logo, photo, best laps and
  preferred controller.

## Also noted

- Check Lane hardware: sector support is being built now and is tested on the simulator
  until the user installs real Check Lanes.
