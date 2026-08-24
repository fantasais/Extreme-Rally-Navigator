# Extreme Rally Navigator v0.4

Portrait-first Android PWA for extreme-rally GPX navigation. Its layout follows the compact, card-led structure of the TSD Rally Computer while keeping the moving display focused on the next meaningful turn.

## v0.4 workflow

1. Upload one or more GPX files from the single **Upload GPX** control.
2. Select the stage to configure.
3. Enter its official start time, turn-assist level and optional DZ/FZ speed zone.
4. Tap **Arm Start**. GPS acquisition and the countdown run automatically.
5. At zero, Rally mode starts and shows the upcoming turn, distance, following turn and roadbook reference. The full route map remains in Setup only.

**Start Now** begins immediately. **Test Selected GPX** replays the chosen route without driving.

## Per-GPX setup isolation

Every imported GPX has its own saved configuration:

- Official start time
- Turn-assist sensitivity
- DZ instruction
- FZ instruction
- Speed limit and optional official zone distance

Changing the selected GPX switches all these values together. DZ/FZ instructions are validated against the selected route, and FZ must occur after DZ. Arming a stage freezes a snapshot of that GPX and its setup so later selection changes cannot alter an active stage. Imported routes and their setups are stored locally on the device.

## Deploy through GitHub and Vercel

1. Extract the package and upload every file and folder to the root of the GitHub repository.
2. Commit the changes. Vercel will redeploy the connected repository automatically.
3. No environment variables or custom Vercel build settings are required.
4. Open the HTTPS Vercel URL in Chrome on Android and install the PWA.
5. After an update, close and reopen the installed app once so the new offline cache activates.

## Competition-use boundaries

- GPX parsing, configuration and navigation data remain on the device.
- Turn calls are geometry-based previews, not pace notes or a substitute for the organiser's roadbook.
- GPS snapping, automatic instruction advancement and DZ/FZ triggering require field validation before competition use.
- Elevation guidance requires elevation values in the GPX.
