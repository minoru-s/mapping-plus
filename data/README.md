# 自治体境界データ

`municipality-boundaries.js` は、国土交通省「国土数値情報（行政区域データ）」を加工したデータです。

- 基準年月日: 2026年1月1日
- 加工元: [ricewin/simplify-japan-geojson](https://github.com/ricewin/simplify-japan-geojson)
- 原典: [国土数値情報 行政区域データ](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2024.html)
- ライセンス: CC BY 4.0

都道府県・市区町村名のローカル判定に必要な47都道府県分のTopoJSONを、単一のJavaScriptデータへまとめています。`index.html` を直接開いた場合にも読み込めるよう、統計パネルを開いたときだけ遅延読み込みします。
