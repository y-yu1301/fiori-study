# =============================================================================
# 学習用 devcontainer のベースイメージ定義（CAP Java 版）
# -----------------------------------------------------------------------------
# ここで作るのは「CAP Java 開発に必要なツールが最初から全部入った Linux 環境」です。
# あなたの Mac 本体には Java も Node も入れず、すべてこのコンテナの中で完結させます。
# 「Mac を汚さない」「誰の環境でも全く同じ（再現性）」が devcontainer の利点です。
#
# ★重要：CAP Java でも Node.js は必要です。
#   CAP の開発ツール群（cds コマンド＝生成/ウォッチ/デプロイ、Fiori 画面ジェネレータ）は
#   Node 製だからです。つまり構成は「Java(実行) + Maven(ビルド) + Node(開発ツール)」。
#   - Java   … アプリ本体(Spring Boot)を動かすランタイム。現場と同じ。
#   - Maven  … 依存解決・ビルド・起動(mvn spring-boot:run)。現場と同じ。
#   - Node   … cds-dk / Fiori tools を動かすための開発補助。アプリ実行時には使わない。
#
# Java と Maven は devcontainer.json の "features" で足します（Dockerfile では入れない）。
# =============================================================================

# Microsoft 公式の Node.js 開発用イメージを土台にします。
# - "20" = Node.js 20 (LTS)。cds-dk / Fiori tools が安定動作する版。
# - "bookworm" = Debian 12。arm64(Apple Silicon) ネイティブで動くので速い・軽い。
# - git / curl / build-essential が最初から入っています。
FROM mcr.microsoft.com/devcontainers/javascript-node:20-bookworm

# -----------------------------------------------------------------------------
# CAP / Fiori の開発ツールをグローバル(-g)に導入します。
# これらは Java プロジェクトでも「開発時の道具」として使います。
# -----------------------------------------------------------------------------
RUN npm install -g \
    # cds コマンド本体。`cds init --add java`(Javaひな型生成), `cds watch`(開発サーバ),
    # `cds add`, デプロイ補助など、CAP 開発の中心ツール。Java 版でも使う。
    @sap/cds-dk@8.9.19 \
    # UI5 のローカルサーブ/ビルド CLI。Fiori アプリを単体で動かすときに使う。
    @ui5/cli@4.0.33 \
    # Fiori Elements アプリの雛形を生成するジェネレータ（GUI/CLI 両方の実体）。
    @sap/generator-fiori@^1 \
    # MTA(Multi-Target Application) ビルドツール。将来 BTP デプロイ時に使う。
    mbt@^1

# -----------------------------------------------------------------------------
# （任意）Cloud Foundry CLI … BTP / HANA Cloud 接続段階で必要。今は不要なので無効。
# 使う段階になったら下のコメントを外して再ビルドしてください。
# -----------------------------------------------------------------------------
# RUN curl -fsSL "https://packages.cloudfoundry.org/stable?release=linux64-binary&source=github" \
#       -o /tmp/cf.tgz \
#     && tar -xzf /tmp/cf.tgz -C /usr/local/bin cf8 \
#     && ln -sf /usr/local/bin/cf8 /usr/local/bin/cf \
#     && rm /tmp/cf.tgz

# デフォルトの作業ユーザーは、権限問題を避けるため非rootの "node" にします。
USER node
