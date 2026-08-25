# Extreme Rally Navigator v0.5.1

Portrait-first Android PWA for extreme-rally GPX navigation.

## v0.5 navigation correction

This release replaces the first live-tracking engine after real-road testing exposed unreliable distance and turn alignment.

- Holds an Android screen wake lock while a stage is armed or running, and reacquires it when the app returns to the foreground.
- Projects every GPS fix onto the nearest position along a GPX line segment instead of snapping to the nearest stored track point.
- Uses route continuity, vehicle heading and plausible travel distance to reduce jumps at crossings and nearby parallel sections.
- Shows a large two-decimal route odometer and large live vehicle speed.
- Smooths GPS speed while preserving useful response.
- Interpolates route geometry at fixed distance intervals for turn analysis.
- Places generated calls near the detected bend entry rather than an arbitrary stored GPX point.
- Projects instruction waypoints onto route segments for more accurate instruction and DZ/FZ distances.
- Records a private live-run diagnostic CSV that can be downloaded from Controls. Nothing is uploaded automatically.

## v0.5.1 live-screen packing

- Route odometer, speed, stage time and GPS accuracy share one compact readout.
- Screen wake lock remains active but no longer occupies a permanent live-screen tile.
- Upcoming Turn, Next and Roadbook fit into the normal portrait rally screen without scrolling.
- The active-stage header, tabs, gaps and cards are compressed without reducing the primary turn-call size.
- Testing and diagnostic export controls are inactive while a stage is live; correction, recovery and end-stage controls remain available.

## Stage workflow

1. Upload one or more GPX files.
2. Select the stage and enter its official start time.
3. Choose Turn Assist and optional DZ/FZ settings for that GPX.
4. Tap **Arm Start**. GPS acquisition, screen wake lock and countdown begin automatically.
5. At zero, Rally mode starts and displays route odometer, speed, upcoming turn and distance.

Every GPX retains its own start, turn and DZ/FZ configuration. Existing v0.4 route data is migrated automatically.

## Deploy through GitHub and Vercel

1. Extract the package and upload every file and folder to the repository root.
2. Commit the changes. Vercel redeploys the connected repository automatically.
3. No environment variables or custom build settings are required.
4. After deployment, close every open browser/PWA instance and reopen the installed app once so the v0.5 offline cache activates.

## Testing and safety

- Test with a passenger operating and observing the phone.
- If a call or distance is wrong, download the run log from **Controls → Diagnostics** and retain the exact GPX used for that run.
- Generated calls describe GPX geometry only. They cannot identify grip, road surface, traffic, hazards or an incorrect organiser track.
- Sparse or poorly converted GPX geometry cannot support trustworthy bend calls.
- The organiser roadbook and safety instructions remain authoritative.
