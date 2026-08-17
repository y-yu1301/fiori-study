# SAP CAP (Java) + Fiori Elements 学習環境（devcontainer）

MacBook (Apple Silicon) 上に、Docker の devcontainer を使って
**SAP CAP (Java) + Fiori Elements + SAP UI5** の学習環境をまるごと用意したものです。
CAP Java（Spring Boot / Maven）を学ぶため、この環境もCAP Java構成にしてあります。
データベースは学習用に **H2（インメモリ）** を使い、
クラウド不要・完全ローカルで動きます。

> **この環境の目的は「学習・説明」**です。各ファイルには初心者が読んで分かるよう
> 日本語コメントを密に入れ、`docs/` に段階的な解説を用意しています。
> まずは [`docs/00-全体像.md`](docs/00-全体像.md) から。

> **公開範囲と安全性に関する注意**
> このリポジトリはローカル学習用のサンプルです。認証・認可、CSRF対策、監査ログ、レート制限、
> 本番向けの秘密情報管理は構成していません。A/B/C/E/Fのサービスは、学習目的で認証なしの構成です。
> インターネットへ公開したり、本番データを接続したりしないでください。SAP製品との関係を示す公式リポジトリではありません。

---

## 技術スタック（CAP Javaを学ぶための構成）

| 役割 | 使うもの |
|---|---|
| アプリ実行 | **Java 21 + Spring Boot** |
| ビルド・依存・起動 | **Maven**（`pom.xml`） |
| データモデル/サービス | **CDS(.cds)**（Node/Java 共通の中核） |
| 画面 | **Fiori Elements / SAP UI5**（アノテーション駆動） |
| DB（学習用） | **H2 インメモリ**（起動毎に CSV から再構築） |
| 開発補助ツール | Node.js 上の cds-dk / Fiori tools |

---

## クイックスタート

### 前提
- **Docker Desktop** が起動していること
- **VS Code Desktop** ＋ 拡張「**Dev Containers**」がインストール済みであること

### 手順
1. このフォルダを VS Code で開く
2. コマンドパレット → **「Reopen in Container」**
   （初回はイメージビルド＋Java/Maven導入で数分かかります）
3. アプリA（bookshop）を起動する（ターミナルを2つ使う）:
   ```bash
   # ターミナル1：バックエンド（OData を 4004 で提供）
   cd A-cap/srv && mvn spring-boot:run
   # ターミナル2：フロント（画面を A-ui5/ui5.yaml の server.settings.httpPort で提供、/odata は proxy で 4004 へ）
   cd A-ui5 && npm install && npm start
   ```
4. ブラウザで **http://localhost:8082** を開く（画面）。

動作確認用URL:
- 画面（A-ui5）: <http://localhost:8082>
- 本の一覧(JSON, A-cap 直): <http://localhost:4004/odata/v4/CatalogService/Books>

> ★このリポジトリは**フロントとバックを分離した独立プロジェクトの集合**です
> バックエンドはMaven、フロントエンドはui5 serveで起動します。
> 詳しくは [`docs/07-マルチプロジェクト構成.md`](docs/07-マルチプロジェクト構成.md)。

---

## この後の学習の流れ（docs 索引）

| ドキュメント | 内容 |
|---|---|
| [00-全体像.md](docs/00-全体像.md) | 全体像。CAP / Fiori Elements / UI5 / HANA の関係。Node版との違いも |
| [01-開発コンテナ.md](docs/01-開発コンテナ.md) | devcontainer の仕組み（Java+Maven+Node をどう同居させるか） |
| [02-CAP-Javaの基本.md](docs/02-CAP-Javaの基本.md) | CAP Java の基本：モデル→サービス→DB と、プロジェクト構成 |
| [03-Fiori画面.md](docs/03-Fiori画面.md) | Fiori Elements 画面を**GUIから新規作成**する手順 |
| [04-起動とデバッグ.md](docs/04-起動とデバッグ.md) | 起動・動作確認・デバッグ（Maven / Spring Boot） |
| [05-H2とHANAの違い.md](docs/05-H2とHANAの違い.md) | ★H2 と HANA の違い・実務での落とし穴 |
| [06-Javaカスタムロジック.md](docs/06-Javaカスタムロジック.md) | ★カスタムロジックを **Java(イベントハンドラ)** で書く |
| [07-マルチプロジェクト構成.md](docs/07-マルチプロジェクト構成.md) | フロントとバックを分離した独立プロジェクト構成 |
| [08-ソースコードの読み方.md](docs/08-ソースコードの読み方.md) | ★初心者向け：どこから読むか／gen と main／`Books` と `Books_`／触る所 |
| [09-サービス間連携サンプル.md](docs/09-サービス間連携サンプル.md) | ★A が B のデータを取り込み1画面に見せる（リモートサービス＋サブページ） |
| [10-ListReport検索条件をObjectPage明細READへ渡すサンプル.md](docs/10-ListReport検索条件をObjectPage明細READへ渡すサンプル.md) | List Report の検索条件を Object Page 明細の READ へ渡す（アプリA） |
| [11-検索条件引き継ぎ実装の追い方.md](docs/11-検索条件引き継ぎ実装の追い方.md) | 上記の実装をどう読むか |
| [12-Cプロジェクト一括編集サンプル.md](docs/12-Cプロジェクト一括編集サンプル.md) | 【アプリC】検索条件を持ち回って明細を編集する方式 |
| [13-Dプロジェクト編集セッション方式.md](docs/13-Dプロジェクト編集セッション方式.md) | ★【アプリD】条件を持ち回らない「編集セッション」方式でC の課題を解消 |
| [14-E-HTTPヘッダー検索条件一括編集.md](docs/14-E-HTTPヘッダー検索条件一括編集.md) | 【アプリE】HTTP Headerを検索条件の正とする最小一括編集サンプル |
| [15-F-リトライ再Binding一括編集.md](docs/15-F-リトライ再Binding一括編集.md) | 【アプリF】現場方式（sessionStorage＋Headerリトライ＋再Binding）の再現とデバッグ手順 |
| [16-F-処理フローとデータの流れ.md](docs/16-F-処理フローとデータの流れ.md) | ★【アプリF】フロント／バックを一貫して追う処理フローとデータの変遷・注意点 |

---

## フォルダ構成（独立プロジェクトの集合）

```
fiori-study/            … ワークスペース（入れ物。devcontainer と docs を共有）
├── .devcontainer/      … 開発コンテナ定義（Dockerfile / devcontainer.json）
├── docs/               … 学習用ドキュメント（このREADMEの索引先）
│
├── A-cap/              … 【アプリA】bookshop バックエンド（独立 CAP Java, OData:4004）
│   ├── db/             …   データモデル(schema.cds) と サンプルデータ(CSV)
│   ├── srv/            …   サービス定義(cat-service.cds) と Java 実装・pom.xml
│   ├── _i18n/          …   ★CAP側 i18n（項目名などデータ由来の文言）
│   ├── pom.xml         …   親 Maven 設定
│   └── package.json    …   cds-dk（開発ツール）用
├── A-ui5/              … 【アプリA】bookshop フロント（独立 UI5, 画面:8082）
│   ├── webapp/         …   manifest.json / Component.js / i18n（アプリ固有文言）
│   └── ui5.yaml        …   /odata を A-cap(4004) へ proxy
│
├── B-cap/              … 【アプリB】movies バックエンド（独立 CAP Java, OData:4005）
├── B-ui5/              … 【アプリB】movies フロント（独立 UI5, 画面:8083）
│
├── C-cap/ C-ui5/       … 【アプリC】一括編集（検索条件を持ち回る方式, 4006 / 8084）
├── D-cap/              … 【アプリD】一括編集（編集セッション方式）バックエンド（OData:4007）
├── D-ui5/              … 【アプリD】一括編集（編集セッション方式）フロント（画面:8085）
├── E-cap/              … 【アプリE】HTTP Header方式バックエンド（OData:4008）
├── E-ui5/              … 【アプリE】HTTP Header方式フロント（画面:8086）
├── F-cap/              … 【アプリF】リトライ・再Binding方式バックエンド（OData:4009）
└── F-ui5/              … 【アプリF】リトライ・再Binding方式フロント（画面:8087）
```

各プロジェクトは自己完結し、独立してビルド・デプロイできます。
詳細は [`docs/07-マルチプロジェクト構成.md`](docs/07-マルチプロジェクト構成.md)。
