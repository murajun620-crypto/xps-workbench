# XPS Workbench

Calibrate energy, subtract backgrounds, and fit peaks directly in your browser.

[Open XPS Workbench](https://murajun620-crypto.github.io/xps-workbench/)

The workspace opens empty, including after a refresh. Select Open data to start from a spectrum, Demo for the sample, or New project to clear the current analysis.

## Use the app

1. Open a CSV, TSV, TXT, Excel (.xlsx), or ISO 14976 VAMAS spectrum. The Region menu selects a measurement region or Excel sheet when several are available. Supported VAMAS data includes NORM XPS/ESCA with regular or irregular energies, including COMPRO .npl exports.
2. Apply a direct energy offset or align a measured peak to a reference energy.
3. Select an analysis range and a background method. Linear and iterative Shirley use the range endpoints. If Shirley cannot converge, the app displays a Linear fallback.
4. Add peaks and set their initial centers, widths, and heights. Drag the circle at a peak's top to adjust center and height. Drag the half-height diamond sideways to adjust FWHM. Fixed values and bounds apply to both handles. The ▲/▼ controls and the Up/Down keys adjust the numeric fields.
5. Select Add doublet and click the primary line to add a spin-orbit pair, or enable Spin-orbit doublet in an existing peak's Constraints. Si 2p starts with a 0.606 eV separation and a 2:1 primary-to-secondary area ratio. Edit either value in Constraints. The primary line has the lower binding energy and the higher kinetic energy. Its drag handles adjust the pair while preserving separation, area ratio, and shared FWHM.
6. Run the fit and inspect the components and residuals. Export an English CSV or a .plotproject that opens with Plot Launcher's XPS Fit preset. Workbench CSVs restore the saved analysis, including doublet settings. Older CSVs with component columns restore those curves and estimate editable peak parameters from them.

The version is displayed beside Check for updates. A newer release opens in a new tab so the current analysis stays open.

When your browser provides a local file handle, CSV and Plot Launcher save dialogs start in the source file's folder. Other browsers use their normal download location.

## Build and publish

Run `pnpm install --frozen-lockfile` and `pnpm build` to create a standalone `dist/XPS-Workbench.html`. Bump the version in `package.json` for a release. Run `pnpm build:pages` and push the `docs/` changes to `main` to publish through GitHub Pages.
