# Remove long-press oval movement

## Objective and expected behavior

Remove the long-press/drag system for moving ovals. Ovals continue to move only through the existing tap behavior: tapping a running oval in the lower row requests a move to the empty cell directly above it on the same plate. Upper-row ovals remain immovable. Blank-cell taps still create an oval, blank oval taps still start the fixed timer, completed ovals still enter the completion box, and temperature arrows still adjust temperature.

Pressing and holding an oval must not start a drag, display a drag preview, or cause a move on release. Use the existing 450 ms gesture threshold to distinguish a held oval from a tap and suppress the oval-body action on release after that threshold. A normal short tap continues to use the existing 12 px movement tolerance. Temperature-arrow behavior remains a single adjustment per normal activation; this change adds no repeat behavior.

## Current execution path and findings

- `cooking-app/app/kitchen.tsx` owns pointer handling for the plate SVG. `down` records a `Contact`, captures the pointer, and schedules a 450 ms timer for eligible ovals. The timer marks the contact as dragging and creates a preview.
- `move` tracks the maximum pointer displacement. It also calculates cross-cell/cross-plate drop targets for active drags. `up` commits the drag command, or otherwise treats a movement under 12 px as a tap/create. `cancelActiveContact`, `cancel`, and the unmount cleanup clear the timer and preview.
- Tap-driven running-oval moves call the shared `move` command in `perform`; that path must remain intact because it is the intended way to move an oval. The WebMCP/API `move` command must also remain available.
- The drag-only rendering consists of `dragPreview`, cross-plate `draggedItem` rendering, preview position/validity attributes and classes, and preview-dependent stroke styling. `plateSurfaces`, grab offsets, drop target calculation, and `gridMoveSourceBlockReason` are only used by the drag path. `plateSvgs` remains necessary for pointer capture.
- `cooking-app/README.md` and the in-app help list describe long-press movement and releasing outside/between plates; README also mentions holding an arrow. These instructions should be removed. Keep the current tap-to-move instructions and the tap-only keyboard guidance.
- `cooking-app/app/globals.css` has no drag-preview-specific rules, so no styling edit is expected.

## Affected files and ownership

- Implementation worker owns `cooking-app/app/kitchen.tsx` and `cooking-app/README.md` for this change. No other worker should edit these files concurrently. Preserve unrelated changes already present in the shared worktree.
- A separate reviewer inspects the final diff and confirms drag-only paths are gone while tap movement and other pointer actions remain.
- `cooking-app/lib/kitchen-model.ts` and API/WebMCP move handling are explicitly out of scope; their move behavior supports the retained tap-based operation.

## Implementation steps

1. Simplify the `Contact` type and lifecycle by removing drag-only fields/state, long-press timer setup/cleanup, `DropTarget`, `dropTargetAt`, preview state, and drag-only plate references. Retain pointer capture, contact cancellation on generation changes, pressed-state feedback, and pointer displacement tracking.
2. Keep `onPointerMove` as a distance tracker. Its maximum displacement is required to prevent a pointer swipe that returns near its starting point from being interpreted as a tap/create. On `up`, preserve the current `< 12 px` tap/create rule and suppress oval-body activation when the recorded contact duration meets the 450 ms long-hold threshold. Keep the existing pointer-generation check and action routing.
3. Remove only drag-preview rendering: cross-plate duplicate rendering, preview coordinates and validity state, drag-only data attributes/classes, and preview-specific style selection. Leave normal oval rendering and its pressed feedback in place.
4. Remove long-press/drag instructions from README and in-app help, including releasing outside/between plates and arrow-hold notes. Retain concise instructions for lower-row taps, upper-row immovability, temperature taps, creation, and keyboard operation.
5. Review the diff for accidental changes to the shared move command, API tools, temperature controls, create-cell logic, timer/completion actions, and generation conflict cancellation.

## Acceptance criteria

- Holding an oval for at least 450 ms and releasing it causes no move and no oval-body tap action; no dragging/preview feedback is shown at any time.
- A short tap on a running lower-row oval still moves it to the same-column empty upper cell. A short tap on an upper-row running oval still reports that it cannot move.
- A short tap on a blank oval still starts its timer; a short tap on a done oval still moves it to the completion box; normal temperature-arrow activation still adjusts by 1 degree.
- A short tap on an empty lower-row cell still creates one oval; upper-row create taps remain rejected.
- Pointer movement of 12 px or more still suppresses tap/create, including a gesture that moves away and returns close to its origin. Pointer cancel, lost capture, generation changes, and unmount continue to clear active contact state safely.
- README and in-app help no longer instruct users to long-press or drag an oval, release outside a plate, or hold arrows.
- Shared model and WebMCP/API `move` operations remain available and unchanged.

## Validation and risks

- Do not add or run tests for this task. Run `npm run typecheck`, `npm run build:pc`, `npm run build:pages`, and `git diff --check`; report exact outcomes.
- Independently review the final diff against the acceptance criteria.
- Main risk: if the duration cutoff is removed along with the drag timer, a held pointer released while still can be interpreted as a regular tap and perform the normal tap action. Keep a contact start time and apply the 450 ms cutoff only to oval-body activation. Keep arrow action behavior unchanged.
- Preserve maximum pointer displacement tracking in `onPointerMove`; checking only the final displacement in `up` would allow a swipe that returns near its starting point to trigger a tap.
- Do not alter model-level movement constraints or any other changes in the shared worktree.
