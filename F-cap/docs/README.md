# F-cap

リトライ・再Binding方式を再現するFアプリのCAP Javaバックエンドです。

全体の処理、起動方法、既知の課題は
`../../docs/15-F-リトライ再Binding一括編集.md`を参照してください。

主要実装は`WorkItemsHandler.java`です。本文TableではHeaderを優先し、Headerがない場合だけ
受信したOData Filterを維持します。
