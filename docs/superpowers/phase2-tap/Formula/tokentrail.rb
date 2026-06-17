class Tokentrail < Formula
  desc "Local ledger and trail-map for Claude Code spend"
  homepage "https://github.com/loschenbd/tokentrail"
  url "https://github.com/loschenbd/tokentrail/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "REPLACE_WITH_REAL_SHA256_AFTER_TAGGING_V020"
  license "MIT"

  depends_on "node"
  depends_on "python" => :build

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  livecheck do
    url :stable
    strategy :github_latest
  end

  test do
    assert_match "tokentrail", shell_output("#{bin}/tokentrail --version")
  end
end
