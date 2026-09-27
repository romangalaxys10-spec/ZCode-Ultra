# Homebrew formula — tap zai-org/tap
# Install:  brew install zai-org/tap/zcode-ultra
class ZcodeUltra < Formula
  desc "Lean, multi-provider, bot-native coding agent harness (CLI + Discord + WhatsApp)"
  homepage "https://github.com/romangalaxys10-spec/ZCode-Ultra"
  version "1.0.0"
  license "MIT"

  depends_on "node" => ">=20" if OS.mac?

  def install
    # Preferred path: install the npm package into the prefix (no compilation needed)
    system "npm", "install", "-g", "zcode-ultra@#{version}", "--prefix", "#{libexec}"
    bin.install_symlink libexec.glob("bin/*")
    # Alternatively, when release assets exist, the standalone binary ships as:
    #   zcode-ultra-darwin-arm64 / zcode-ultra-darwin-x64
  end

  test do
    assert_match "zcode-ultra", shell_output("#{bin}/zcode-ultra version")
  end
end
