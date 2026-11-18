# Project context

The AugPrint foam slicer: a web app (and an Electron desktop app) that slices foam prints, augmentations and regular prints into G-code for a Prusa XL.

## Keep the documentation current

Whenever you change the project, update the documentation as part of the same piece of work, before you call it done or commit it. A change is not finished while the documentation says something else.

The documentation is:

- **`README.md`**: what the app does and how to use it. It lists every control with its description, explains how a Foam Print is printed, covers the desktop app and how to run the project, and has a **Tests** section with one row per test file.
- **`ISSUES.md`**: the issue tracker. It holds the findings and their status, and "Behaviour changes to check before printing" lists.

For every change:

1. **Add what is new.** A new control, feature, behaviour, command or file that someone using or developing the app needs to know about goes in the README, in the section it belongs to.
2. **Change what changed.** If the change makes a sentence in the documentation wrong, rewrite that sentence. Do not leave it and add a correction somewhere else.
3. **Remove what is gone.** Delete the description of anything that was removed or no longer behaves that way. Nothing out of date stays, and that includes defaults, numbers, file names and commands.
4. **Controls match the app.** The label and description of every control in the README match `src/visualizer/gui/paramSpecs.ts`, which the tooltips are made from.
5. **Tests.** When a test file is added, removed, or changes what it covers, change its row in the README's Tests tables: what the file supports in the app, and what it checks. Do not write test counts or timings there; they go stale.
6. **Issues.** Tick or reword the `ISSUES.md` entries the change settles, add the ones it opens, and add anything that changes what the printer does to a "Behaviour changes to check before printing" list. Say plainly when something was not run on a printer.

Before finishing, read the parts of the documentation the change touches and search the rest for the names you changed (a setting, a button, a file, a number), so that no stale mention is left. In your final message, say which parts of the documentation you updated, or that none needed it and why.

If another change in the working folder is not yours, leave its part of the documentation alone.

## Checks

Run what CI runs before committing: `npm run typecheck` (it covers the test files, which a plain `tsc --noEmit` does not), `npm test` and `npm run build`.
