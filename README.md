# XPS Workbench

Calibrate energy, subtract backgrounds, and fit peaks directly in your browser.

[Open XPS Workbench](https://murajun620-crypto.github.io/xps-workbench/)

The workspace opens empty, including after a refresh. Select Open file to load a spectrum or resume a saved project, Demo for the sample, or New project to clear the current analysis.

## Use the app

1. Open a CSV, TSV, TXT, Excel (.xlsx), or ISO 14976 VAMAS file. Excel measurements can be on separate sheets or share a sheet as one energy column with several intensity columns, or as separate energy and intensity column pairs. Use the Spectrum menu to select a measurement and All spectra to overlay the measured curves at their applied energies. Each keeps its own shift, background, analysis range, and fit while the file is open. Supported VAMAS data includes NORM XPS/ESCA with regular or irregular energies, including COMPRO .npl exports.
2. Apply a direct energy offset or align a measured peak to a reference energy. Shifted CSV exports the selected spectrum. Shifted XLSX exports all spectra, with one sheet per spectrum. Both include the energy values after the applied shift and the full measured intensities.
3. Select an analysis range and a background method. Linear and iterative Shirley use the range endpoints. If Shirley cannot converge, the app displays a Linear fallback.
4. Add peaks and set their initial centers, widths, and heights. Drag the circle at a peak's top to adjust center and height. Drag the half-height diamond sideways to adjust FWHM. Fixed values and bounds apply to both handles. The ▲/▼ controls and the Up/Down keys adjust the numeric fields.
5. Select Add doublet and click the primary line to add a spin-orbit pair, or enable Spin-orbit doublet in an existing peak's Constraints. Si 2p starts with a 0.606 eV separation and a 2:1 primary-to-secondary area ratio. Edit either value in Constraints. The primary line has the lower binding energy and the higher kinetic energy. Its drag handles adjust the pair while preserving separation, area ratio, and shared FWHM.
6. The residual is measured intensity minus the current total model, and updates during manual edits. Run fit optimizes from the current settings. Workbench CSV saves both manual and optimized models with their component curves, residuals, and doublet settings. Plot Launcher and XPS Fit CSV export the displayed model and residuals using the XPS Fit preset's axis defaults.
7. Select Save project to save an `.xpsproject` file with the original data, shifts, background settings, analysis ranges, peak settings, and fit results for every spectrum. Open the project file to resume analysis without reopening the source workbook.

The version is displayed beside Check for updates. A newer release opens in a new tab so the current analysis stays open.

When your browser provides a local file handle, export dialogs start in the source file's folder. Other browsers use their normal download location.

## Build and publish

Run `pnpm install --frozen-lockfile` and `pnpm build` to create a standalone `dist/XPS-Workbench.html`. Bump the version in `package.json` for a release. Run `pnpm build:pages` and push the `docs/` changes to `main` to publish through GitHub Pages.
