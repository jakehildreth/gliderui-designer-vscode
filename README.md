# GliderUI Designer for VS Code

Visual designer for cross-platform PowerShell GUIs, inside VS Code. Wraps the
[GUI Creator](https://github.com/Mynster9361/guiCreatorPowerShell) designer by
[Mynster9361](https://github.com/Mynster9361) and generates scripts for
[GliderUI](https://github.com/mdgrs-mei/GliderUI) by mdgrs-mei (Avalonia UI for
PowerShell 7.4+).

All design, codegen, and UI credit goes to
[Mynster9361/guiCreatorPowerShell](https://github.com/Mynster9361/guiCreatorPowerShell) —
this extension only hosts that designer inside VS Code. Not affiliated with
GUI Creator or GliderUI.

## Installation

### From a .vsix file (no marketplace needed)

1. Download the latest `gliderui-designer-vscode-x.y.z.vsix` from [Releases](https://github.com/jakehildreth/gliderui-designer-vscode/releases).
2. Install it:
   ```
   code --install-extension gliderui-designer-vscode-x.y.z.vsix
   ```
   or in VS Code: Extensions view → `...` menu → **Install from VSIX...**

### From source

```
git clone --recurse-submodules https://github.com/jakehildreth/gliderui-designer-vscode
cd gliderui-designer-vscode
npm install
npm run package
code --install-extension gliderui-designer-vscode-0.1.0.vsix
```

## Quick start

1. Open the command palette and run **GliderUI Designer: Open GUI Designer**.
2. Drag controls onto the form, set properties, wire events.
3. **File → Save Project** stores a `.guiproj.json` through VS Code's save dialog;
   **Export .ps1** writes the runnable script.
4. Press **F5** to run the design with `pwsh`. Output streams into the designer's
   Output panel; error lines link back to the script line.

For detailed usage instructions — the toolbox, property grid, anchors, dialogs,
wizards, the guided tour, and more — see the
[GUI Creator README](https://github.com/Mynster9361/guiCreatorPowerShell#readme).
The designer inside VS Code is the same tool; only saving, opening, and running
go through VS Code instead of the browser.

## Requirements

- [PowerShell 7.4+](https://learn.microsoft.com/powershell/scripting/install/installing-powershell) (`pwsh` on PATH).
- The [GliderUI](https://github.com/mdgrs-mei/GliderUI) module and its server package to run designs.
  If either is missing, the extension offers to install it for you
  (`Install-PSResource -Name GliderUI; Install-GLIServer`, run in a visible terminal).

## Layout of this repository

- `designer/` — the upstream GUI Creator, included as a git submodule and used
  byte-identical. Upstream changes arrive with `git submodule update --remote designer`.
- `media/host-shim.js` — injected into the webview after upstream's scripts; reroutes
  the browser seams (runner HTTP API, localStorage, file downloads, `window.open`)
  to the extension host.
- `src/extension.ts` — webview host, pwsh process management, GliderUI install prompts.

## License

MIT License w/Commons Clause - see [LICENSE](LICENSE) file for details.

---

Made with 💜 by [Jake Hildreth](https://jakehildreth.com)
