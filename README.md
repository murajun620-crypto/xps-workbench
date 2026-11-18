# XPS Workbench

XPSスペクトルのエネルギー補正、背景減算、ピーク分離を行うブラウザアプリです。測定データは端末内で処理します。

## 起動

[GitHub Pagesで開く](https://murajun620-crypto.github.io/xps-workbench/)か、ビルド済みの `dist/XPS-Workbench.html` をブラウザで開きます。最初に合成 C 1s スペクトルが表示されます。

このディレクトリで `pnpm install --frozen-lockfile` に続けて `pnpm build` を実行すると、単体HTMLを再ビルドできます。GitHub Pagesに反映するには、`pnpm build:pages` を実行し、`docs/` の変更を `main` ブランチへプッシュします。

## 解析

1. CSV・TSV・テキスト・Excel（`.xlsx`）のエネルギーと強度の列、または ISO 14976 VAMAS を開きます。Excelでは測定データを含むシートを、VAMASでは測定領域をプルダウンで選べます。COMPROの `.npl` を含め、VAMASは NORM の XPS／ESCA、REGULAR／IRREGULAR に対応します。
2. 全点に加えるエネルギーシフト量を入力します。参照ピーク方式では「参照値 − 補正前の測定位置」がシフト量です。結合エネルギーは降順、運動エネルギーは昇順で表示します。
3. 解析範囲を指定して背景方式を選びます。Linear と反復 Shirley の端点には範囲の端にある測定強度を使います。Shirley で有効な積分が得られない場合や反復上限に達した場合は、画面に表示して Linear に切り替えます。
4. グラフでピークを追加し、位置、FWHM（半値全幅）、高さを編集します。調整ボタンでは固定、上下限、擬Voigtのローレンツ比を指定できます。フィットは非加重の制約付き最小二乗です。擬Voigtは共通の FWHM を持つ Gaussian と Lorentzian の高さの加重和です。面積は成分モデルの全域積分です。
5. 合成曲線、各成分、測定値から合成曲線を引いた残差を確認します。CSVには補正前・補正後のエネルギーと解析系列が入ります。`.plotproject` は [Plot Launcher](https://murajun620-crypto.github.io/plot_launcher_web/) で開くと、測定、背景、合成曲線、成分の描画設定を編集できます。

## 参考資料

- 参照ピークによる補正、選択範囲、擬Voigtの和モデルを参照しました。[CasaXPS Cookbook](https://casaxps.com/pdfs/CasaXPSCookbook2026.pdf)
- グラフと成分表の色分け、パラメータの上下限を参照しました。[KolXPD Au 4f フィットチュートリアル](https://www.kolibrik.net/en/solutions-products/kolxpd/manuals/fitting-independent-parameters)
- 複数ピークの制約設定と測定・合成曲線の重ね表示を参照しました。[KherveFitting マニュアル](https://khervetools.com/docs/) · [開発論文](https://orca.cardiff.ac.uk/id/eprint/182788/)
- エネルギーシフトと反復Shirleyの手順を参照しました。[COMPRO12の使用法（1）](https://www.sasj.jp/JSA/CONTENTS/vol.24_1/Vol.24%20No.1/Vol.24%20No.1_02_Yoshihara.pdf)
