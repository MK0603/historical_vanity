# Historical Vanity

Three.js で構築されたインタラクティブ WebGL サイトのベースプロジェクトです。

## 構成

```
historical_vanity/
├── index.html          # エントリーポイント
├── css/
│   └── style.css       # デザインシステム / スタイル
├── js/
│   ├── main.js         # エントリースクリプト (renderer, loop, events)
│   ├── scene.js        # Three.js シーン管理 (particles, lights, mesh)
│   └── utils.js        # ユーティリティ関数
└── README.md
```

## 使用技術

- [Three.js](https://threejs.org/) v0.169 (CDN / importmap)
- Vanilla HTML / CSS / ES Modules
- GitHub Pages でそのまま公開可能

## ローカル確認

ファイルをそのまま開くと CORS 制限で ES Modules が読み込めないため、ローカルサーバーを使用します。

```bash
# Python
python -m http.server 8080

# Node.js
npx serve .

# VS Code
# Live Server 拡張をインストールして右クリック → "Open with Live Server"
```

## GitHub Pages へのデプロイ

1. リポジトリを GitHub に push
2. Settings → Pages → Source: `main` ブランチ / `/ (root)`
3. 数分後に `https://<username>.github.io/<repo-name>/` で公開

## カスタマイズポイント

| ファイル                              | 変更内容                               |
| ------------------------------------- | -------------------------------------- |
| `js/scene.js` の `_buildParticles()`  | パーティクル数・色・配置               |
| `js/scene.js` の `_buildCenterMesh()` | 中心ジオメトリを差し替え               |
| `css/style.css` の `:root`            | カラーパレット変更                     |
| `js/main.js` の `enterBtn` ハンドラ   | 「体験を始める」ボタン後の遷移ロジック |
