# Extreme Rally Navigator v0.1

Android-first installable PWA for loading rally GPX tracks, synchronising instruction waypoints, previewing bends/gradient and automatically timing configured DZ/FZ zones.

## Deploy through GitHub + Vercel

1. Create a new empty GitHub repository.
2. Upload every file and folder from this package to the repository root.
3. In Vercel, choose **Add New → Project**, import the repository and click **Deploy**. Vercel detects Next.js automatically; no environment variables are needed.
4. Open the HTTPS Vercel URL in Chrome on Android. Choose **Add to Home screen → Install**.
5. Open the installed app once with internet available so its application shell is cached.

## Test sequence

1. Start with the built-in demo stage and use **Replay**.
2. Import an actual extreme-rally `.gpx` file.
3. Verify route distance, instruction count, waypoint order and elevation availability.
4. Select DZ and FZ instructions and enter the speed limit.
5. Open Rally Mode outdoors, allow precise location and press **LIVE GPS**.

## v0.1 boundaries

- GPX parsing and route data remain on the device; nothing is uploaded.
- Live GPS snaps the phone position to the nearest point on the selected track.
- DZ/FZ triggering uses the snapped route position and needs field validation before competition.
- Elevation calls require `<ele>` values in the GPX.
- Bend calls are geometry-based previews, not pace notes or a substitute for the organiser's roadbook.
- Offline map tiles are not included; the route remains visible as an offline vector trace.
