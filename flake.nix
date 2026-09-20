{
  description = "Solomon's Judgment — Claude, ChatGPT and Grok in one window, under your own logins";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # NixOS cannot run a stock AppImage (no /lib64 loader, no FHS), so the released one is
        # unwrapped and re-wrapped against nixpkgs' libraries. This is the supported way to consume
        # an Electron AppImage on NixOS and needs no Electron rebuild.
        #
        # Point it at a local build with:
        #   nix build .#solomons-judgment --override-input self path:. \
        #     --impure --argstr appimage ./build/dist/solomons-judgment-0.1.0-x86_64.AppImage
        # or simply run the AppImage through `appimage-run`, which does the same thing ad hoc.
        version = "0.1.0";
        appimage = ./build/dist/solomons-judgment-${version}-x86_64.AppImage;

        solomons-judgment = pkgs.appimageTools.wrapType2 {
          pname = "solomons-judgment";
          inherit version;
          src = appimage;
          extraPkgs = p: with p; [ libsecret ];
          extraInstallCommands = ''
            install -m 444 -D ${./desktop/assets/icon.png} \
              $out/share/icons/hicolor/512x512/apps/solomons-judgment.png
            install -Dm 644 ${./desktop/solomons-judgment.desktop} \
              $out/share/applications/solomons-judgment.desktop
            substituteInPlace $out/share/applications/solomons-judgment.desktop \
              --replace-quiet "Exec=/home/pretam/dev/ai-fusion/scripts/desktop.sh" "Exec=solomons-judgment" \
              --replace-quiet "Icon=/home/pretam/dev/ai-fusion/desktop/assets/icon.png" "Icon=solomons-judgment"
          '';
        };
      in
      {
        packages = {
          inherit solomons-judgment;
          default = solomons-judgment;
        };

        apps.default = flake-utils.lib.mkApp { drv = solomons-judgment; };

        # Everything needed to BUILD it from source on NixOS: node for the shell and the renderer,
        # uv + python for the frozen backend, and the libraries Electron links against at runtime.
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            python312
            uv
            electron
            libarchive # bsdtar, which the pacman target shells out to
            fakeroot
            dpkg
            rpm
          ];
          # PyInstaller and Electron both want a usable loader for the interpreters they bundle.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (with pkgs; [ stdenv.cc.cc.lib zlib ]);
          shellHook = ''
            echo "Solomon's Judgment dev shell — see BUILD.md"
            echo "  uv sync --frozen && (cd frontend && npm ci) && (cd desktop && npm ci)"
            echo "  scripts/package.sh --linux"
          '';
        };
      });
}
