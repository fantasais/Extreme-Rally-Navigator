# Extreme Rally Navigator v1.0

Clean replacement build created from the Rally of Himalayas field findings. This is a standalone Next.js PWA; it does not depend on any file from v0.11.

## What is fixed

- Continuous segment projection instead of nearest-GPX-point snapping.
- Guarded, monotonic route progress. A normal fix cannot jump more than the physical continuity envelope.
- Automatic rejoin after three coherent fixes when the forward movement is physically plausible.
- Explicit confirmation only for an implausible or ambiguous large rejoin.
- Calls crossed during an unobserved GNSS gap are recorded as missed; an old call is not left onscreen indefinitely.
- Faster speed response and 200 ms screen extrapolation between GNSS callbacks.
- Track-generated calls clear at bend entry instead of remaining after the turn.
- Sparse GPX vertices generate low-confidence calls instead of silently deleting the turn.
- Adaptive off-route threshold using GNSS accuracy and GPX segment spacing.
- Recovery bearing remains visible with ODO, speed, stage time, correction and end-stage controls.
- Optional stage start/finish positions, official ODO at start and first roadbook instruction.
- Live `SET ODO`, `SET ODO + ROUTE` and `SET INSTRUCTION` controls.
- Multiple stage profiles inside one leg GPX.
- Multiple DZ/FZ zones per stage, entered by stage ODO, full-route km or instruction.
- Automatic reverse-route creation.
- Route-specific setups frozen when a stage starts.
- Per-fix run logs written directly to IndexedDB. Interrupted runs remain exportable after reopening the app.
- One-second hold to end, followed by elapsed time, actual distance, average speed and filtered top speed.
- Portrait cockpit scales to short and tall phone screens without scrolling during a normal live stage.
- Wake lock is reacquired after Android releases it.
- Offline shell and compiled assets are pre-cached by the service worker.
- Legacy v0.4/v0.5 route data is migrated once when available.

## Important limitation

A PDF roadbook is not automatically converted into reliable instructions. Tulip drawings and printed ODO values cannot be safely inferred from arbitrary PDFs in the browser. The physical roadbook remains the master.

For app roadbook markers, import a prepared CSV. See `examples/roadbook-template.csv`. Required columns:

- `number`
- either `route_km` or `stage_km`

Optional columns: `label`, `note`, `kind`, `heading`. Valid kinds are `START`, `FINISH`, `STOP`, `DZ`, `FZ`, or `ROADBOOK`.

## Complete replacement deployment

1. Keep a ZIP backup of the current GitHub repository.
2. Delete the current repository contents on the deployment branch.
3. Extract this package.
4. Upload **the contents inside this folder** to the repository root. `package.json` must sit at the root—not inside another nested folder.
5. Commit once and let Vercel deploy.
6. Confirm the Vercel build ends with `Compiled successfully` and `Finished TypeScript`.
7. Open the deployed URL online once, close every older installed PWA/tab, then reopen it. This lets the new service worker cache the v1 shell.
8. The header must show `V1.0.0` before testing. Exported logs also record build `2026.10.05.1`.

Do not mix v0.11 files with this source tree. There is only one `navigator-app.tsx`, under `app/`.

## Local verification

```bash
npm install
npm run test:core
npm run build
```

## Rally setup logic

- `START · ROUTE KM`: position of the SS start within the full leg GPX.
- `FINISH · ROUTE KM`: optional SS finish within the full leg GPX.
- `ODO AT START`: official roadbook ODO at that start; usually `0.00` when the roadbook resets.
- `FIRST ROADBOOK INSTRUCTION`: optional instruction cursor at SS start.
- Add another stage profile when one GPX contains more than one SS.
- Add every DZ/FZ independently. `STAGE ODO KM` follows the official displayed ODO; `ROUTE KM` follows the complete GPX.

## Live correction logic

- `SET DISPLAY ODO`: changes only the displayed official ODO. Route matching continues untouched.
- `SET ODO + ROUTE`: use only at a known roadbook point. It realigns route progress and records intervening calls as missed.
- `SET INSTRUCTION ONLY`: changes the roadbook cursor without altering ODO or route matching.

This remains an assistant, not a replacement for the official roadbook, the navigator or safe judgement.
