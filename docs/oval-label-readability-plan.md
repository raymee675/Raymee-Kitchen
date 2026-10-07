# Oval ID and temperature readability plan

## Objective and expected behavior

Keep each oval's temperature and ID clearly readable at fixed CSS sizes on desktop and responsive layouts. Place both labels inside the 16:9 plate without clipping, keep them apart from the remaining-time display, and preserve pointer and keyboard controls.

## Verified findings and constraints

- `cooking-app/app/globals.css` sets `.plate` to `aspect-ratio:16/9`; its SVG uses the matching `viewBox="0 0 1600 900"`. The current overlay Y calculation still assumes a 16:9 SVG letterboxed inside a square plate, so its labels fall inside the oval near the timer text.
- The plate has `overflow:hidden`. With the current minimum 210px portrait width, a two-line 16px/13px label is about 29px tall, while the outer margin beyond an oval in either grid row is only about 15px. Simply correcting the coordinates to place labels outside the ovals would clip them.
- The item ellipse's accessible name already includes its ID and temperature. The overlay is `aria-hidden` and has `pointer-events:none`; keep that arrangement so the labels are not announced twice and cannot intercept arrows or oval taps.
- Keep the SVG's 16:9 rendering aligned with the overlay, accounting for the plate border and SVG `preserveAspectRatio`; do not reuse the old square-plate letterbox formula.

## Affected files and ownership

- Implementation: `cooking-app/app/kitchen.tsx` for overlay and timer placement; `cooking-app/app/globals.css` only if a practical minimum plate size or row-label styles are needed to prevent clipping in constrained layouts.
- One implementation worker owns both files. A separate reviewer checks the final diff and responsive placement. Do not change model, timer, temperature-adjustment, or data behavior.

## Implementation steps

1. Position each fixed-size two-line label within its own grid row at that row's outer edge: upper-row labels at the top edge and lower-row labels at the bottom edge. Keep the font sizes fixed at a clearly legible 16px for temperature and 13px for ID; keep text contrast and `white-space` behavior suitable for normal assigned IDs and cooking temperatures.
2. Align overlay X/Y positions with the actual SVG viewport in the 16:9 plate, including its border/preserve-aspect-ratio inset. Remove the square-letterbox center and radius calculations.
3. Move the remaining-time text toward the opposite half of each oval from its row label (lower half for the upper row, upper half for the lower row), so it stays visible and does not overlap labels. Do not change timer values or interactions.
4. Ensure the plate retains enough height for a 29px label block in each row at supported narrow/short layouts. If a viewport would shrink a row below that, preserve legible text and allow the page to scroll instead of clipping the overlay or reducing its font size.
5. Preserve the ellipse's accessible name, `aria-hidden` overlay semantics, `pointer-events:none`, keyboard focus, and temperature-arrow hit targets. Review blank, running, and completed ovals in both rows.

## Acceptance criteria

- ID and temperature are rendered at fixed CSS sizes (16px and 13px respectively) on wide and narrow layouts.
- Both labels remain entirely within the plate for upper- and lower-row cells, including the minimum supported plate size and short landscape layout.
- Labels never overlap remaining-time text. Remaining time stays readable in blank/running/completed behavior wherever currently displayed.
- Positioning follows the actual 16:9 SVG/grid coordinates; labels stay centered over the correct column and row.
- Labels do not intercept clicks/taps or keyboard focus. Temperature arrows, oval actions, and accessible names continue to work as before.
- No model, timer, temperature, or execution-record semantics change.

## Validation and risks

- Do not add or run tests. Run `npm run typecheck`, `npm run build:pc`, `npm run build:pages`, and `git diff --check`; report each result accurately.
- Review the final diff and inspect the UI at desktop width, minimum portrait width, and short landscape dimensions for clipping, overlap, and control reachability.
- Risk: temperatures are currently permitted to be any safe integer. Very long values can exceed a grid cell's horizontal space while keeping the requested fixed font size; choose a visible wrapping/overflow strategy or report the remaining product limit rather than silently shrinking or clipping the label.
